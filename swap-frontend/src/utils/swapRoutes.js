/*
 * Swap Route shared utilities (Pancake V2-only optimal path selection)
 *
 * Design goals:
 *  1) A single logic shared by three places in swap/page.jsx (forward quote /
 *     reverse quote / trade execution), eliminating code drift so that the
 *     displayed price always matches the executed price.
 *  2) Query all candidate paths concurrently via Promise.allSettled. Any RPC
 *     failure does not affect other path results; pick the best among the
 *     successful paths (maximum output / minimum input).
 *  3) Automatically dedupe and reject self-loops when building candidates,
 *     preventing nonsensical paths like A→WBNB→A or [WBNB, WBNB, ...] which
 *     waste RPC calls and cause on-chain reverts.
 *  4) Provide a pre-trade recheck verifyPathOutputMatches() to guard against
 *     INSUFFICIENT_OUTPUT_AMOUNT caused by block drift or stale quotes.
 *
 * Reference: the same candidate ordering used by PancakeSwap V2-only Router
 *            (direct / WBNB hop / USDT hop / 3-hop WBNB+stable).
 */

import { getAddress as viemGetAddress, concat as viemConcat, keccak256 as viemKeccak256, encodePacked as viemEncodePacked, toBytes as viemToBytes, slice as viemSlice } from 'viem';
import { viemReadContract } from '@/utils/index.js';
import {
  PANCAKE_ROUTER_ABI,
  PANCAKE_SWAP_ROUTER_V2,
  PANCAKE_SWAP_FACTORY_V2,
  UNISWAP_V3_FACTORY,
  UNISWAP_V3_FEE_TIERS,
  V3_POOL_ABI,
  V3_FACTORY_ABI,
  WBNB_ADDRESS,
  USDT_ADDRESS,
  ETH_PLACEHOLDER,
  MODE_DIRECT,
} from '@/config/index.js';

/* ============================================================
 * 0. Address normalisation / dedupe / self-loop rejection
 * ============================================================ */
const _norm = (addr) => (addr && typeof addr === 'string') ? addr.toLowerCase() : '';

/**
 * Build the candidate path array (same order for exact-input and exact-output,
 * keeping behaviour consistent).
 * @param {string} fromAddr  Input token address (checksum / any case accepted)
 * @param {string} toAddr    Output token address
 * @param {{ wbnbAddr?:string, usdtAddr?:string, busdAddr?:string, includeTripleHops?:boolean }} opts
 * @returns {string[][]} Deduped address path arrays (each is [a,b] / [a,x,b] / [a,x,y,b])
 */
export function buildCandidatePaths(fromAddr, toAddr, opts = {}) {
  if (!fromAddr || !toAddr) return [];
  const wbnb = opts.wbnbAddr || WBNB_ADDRESS;
  const usdt = opts.usdtAddr || USDT_ADDRESS;
  const busd = opts.busdAddr || null;
  const includeTripleHops = opts.includeTripleHops !== false;

  const f = fromAddr;
  const t = toAddr;
  const w = wbnb;
  const u = usdt;

  const rawCandidates = [];

  // ① Direct pool A⇄B
  rawCandidates.push([f, t]);

  // ② A ⇄ WBNB ⇄ B (BSC core hub; optimal in ~95% of cases)
  if (_norm(f) !== _norm(w) && _norm(t) !== _norm(w)) {
    rawCandidates.push([f, w, t]);
  }
  // ③ A ⇄ USDT ⇄ B (stablecoin hop pools usually have excellent depth)
  if (u && _norm(u) !== _norm(w)) {
    if (_norm(f) !== _norm(u) && _norm(t) !== _norm(u) && _norm(f) !== _norm(t)) {
      rawCandidates.push([f, u, t]);
    }
  }
  // ④ A ⇄ BUSD ⇄ B (BUSD pools are deeper for some stablecoin pairs)
  if (busd && _norm(busd) !== _norm(w) && _norm(busd) !== _norm(u)) {
    if (_norm(f) !== _norm(busd) && _norm(t) !== _norm(busd) && _norm(f) !== _norm(t)) {
      rawCandidates.push([f, busd, t]);
    }
  }

  // ⑤ 3-hop paths: A→WBNB→USDT→B (covers long-tail tokens that only have deep
  //    WBNB / USDT pools and no direct cross-pair)
  if (includeTripleHops && u && _norm(u) !== _norm(w)) {
    if (
      _norm(f) !== _norm(w) && _norm(w) !== _norm(u) && _norm(u) !== _norm(t) &&
      _norm(f) !== _norm(u) && _norm(w) !== _norm(t) &&
      _norm(f) !== _norm(t)
    ) {
      rawCandidates.push([f, w, u, t]);
    }
    // A→USDT→WBNB→B
    if (
      _norm(f) !== _norm(u) && _norm(u) !== _norm(w) && _norm(w) !== _norm(t) &&
      _norm(f) !== _norm(w) && _norm(u) !== _norm(t) &&
      _norm(f) !== _norm(t)
    ) {
      rawCandidates.push([f, u, w, t]);
    }
  }

  // === Filter: dedupe identical paths + reject self-loops (duplicate addresses inside path) ===
  const seenKeys = new Set();
  const out = [];
  for (const path of rawCandidates) {
    if (!Array.isArray(path) || path.length < 2) continue;
    // Self-loop: drop any path where two addresses (adjacent or not) are equal
    // prevents [A,A] / [A,WBNB,A] / [WBNB,WBNB,B]
    const normAddrs = path.map(_norm);
    const uniq = new Set(normAddrs);
    if (uniq.size !== normAddrs.length) continue;
    // Head/tail must be fromAddr / toAddr
    if (_norm(path[0]) !== _norm(fromAddr)) continue;
    if (_norm(path[path.length - 1]) !== _norm(toAddr)) continue;
    // Whole-path dedupe
    const key = normAddrs.join('|');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(path);
  }
  return out;
}

/* ============================================================
 * 1. Forward best path: EXACT_INPUT → maximum output (with hop-gas penalty)
 * ============================================================ */

/**
 * Per-hop gas penalty expressed as wei normalised to 1e18.
 * Borrowed from Pancake Smart Router: although BSC gas is very cheap, a
 * 3-hop path costs ~80k–150k more gas than a 2-hop; when two paths produce
 * nearly identical output (< 0.1%) the shorter one is more reliable.
 * We set the penalty equal to 0.1 USDT worth of 1e18-scaled wei × hop delta,
 * ensuring we never pick a path that yields just 0.01 cent more but adds one hop.
 */
const HOP_GAS_PENALTY_WEI_BASE = 300000000000000n; // 0.0003 * 1e18 ≈ 0.1 USDT equivalent

/**
 * Query getAmountsOut for every candidate path concurrently and return the
 * one with the largest net output.
 *
 * @param {bigint} amountInWei Input amount (smallest unit: wei)
 * @param {string[][]} paths   Path array returned by buildCandidatePaths
 * @param {string} [routerAddrOverride] Optional Router address override
 * @returns {Promise<{
 *   ok:boolean,
 *   bestPath?:string[],
 *   bestOutWei?:bigint,
 *   bestOutWeiRaw?:bigint,      // raw output before penalty subtraction
 *   results:Array<{ path:string[], status:'fulfilled'|'rejected', outWei?:bigint, errMsg?:string }>,
 *   firstErrMsg?:string,
 * }>}
 */
export async function getBestPathExactInput(amountInWei, paths, routerAddrOverride) {
  if (!amountInWei || amountInWei <= 0n || !paths || paths.length === 0) {
    return { ok: false, results: [] };
  }
  const routerAddr = viemGetAddress(routerAddrOverride || PANCAKE_SWAP_ROUTER_V2);
  const abi = PANCAKE_ROUTER_ABI;

  const settled = await Promise.allSettled(
    paths.map((p) =>
      viemReadContract({
        address: routerAddr,
        abi,
        functionName: 'getAmountsOut',
        args: [amountInWei, p.map((a) => viemGetAddress(a))],
      }).then((ret) => ({ path: p, outWei: ret?.[ret.length - 1] ?? 0n })),
    ),
  );

  const results = settled.map((s, i) => {
    const path = paths[i];
    if (s.status === 'fulfilled') {
      return { path, status: 'fulfilled', outWei: s.value.outWei };
    }
    const err = s.reason;
    return {
      path,
      status: 'rejected',
      errMsg: err?.message || String(err || 'unknown'),
    };
  });

  let bestIdx = -1;
  let bestNet = -1n;
  let bestRaw = 0n;
  let firstErrMsg = '';

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      if (!firstErrMsg) firstErrMsg = r.errMsg || '';
      continue;
    }
    if (r.outWei == null || r.outWei <= 0n) {
      if (!firstErrMsg) firstErrMsg = 'zero output';
      continue;
    }
    // One extra hop → 1x HOP_GAS_PENALTY_WEI_BASE; 1-hop path = 0x
    const hops = BigInt(Math.max(0, r.path.length - 2));
    const penalty = hops * HOP_GAS_PENALTY_WEI_BASE;
    const net = r.outWei - penalty;
    if (net > bestNet) {
      bestNet = net;
      bestRaw = r.outWei;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) {
    return { ok: false, results, firstErrMsg };
  }
  const bestPath = results[bestIdx].path;
  return {
    ok: true,
    bestPath,
    bestOutWeiRaw: bestRaw,
    bestOutWei: bestRaw, // externally we still return the real on-chain output; penalty is only for internal comparison
    results,
    firstErrMsg,
  };
}

/* ============================================================
 * 2. Reverse best path: EXACT_OUTPUT → minimum input (with hop-gas penalty)
 * ============================================================ */

/**
 * Query getAmountsIn for every candidate path concurrently and return the
 * one with the smallest net input.
 *
 * @param {bigint} amountOutWei Desired output amount (wei)
 * @param {string[][]} paths
 * @param {string} [routerAddrOverride]
 * @returns {Promise<{
 *   ok:boolean,
 *   bestPath?:string[],
 *   bestInWei?:bigint,
 *   results:Array<{ path:string[], status:'fulfilled'|'rejected', inWei?:bigint, errMsg?:string }>,
 *   firstErrMsg?:string,
 * }>}
 */
export async function getBestPathExactOutput(amountOutWei, paths, routerAddrOverride) {
  if (!amountOutWei || amountOutWei <= 0n || !paths || paths.length === 0) {
    return { ok: false, results: [] };
  }
  const routerAddr = viemGetAddress(routerAddrOverride || PANCAKE_SWAP_ROUTER_V2);
  const abi = PANCAKE_ROUTER_ABI;

  const settled = await Promise.allSettled(
    paths.map((p) =>
      viemReadContract({
        address: routerAddr,
        abi,
        functionName: 'getAmountsIn',
        args: [amountOutWei, p.map((a) => viemGetAddress(a))],
      }).then((ret) => ({ path: p, inWei: ret?.[0] ?? 0n })),
    ),
  );

  const results = settled.map((s, i) => {
    const path = paths[i];
    if (s.status === 'fulfilled') {
      return { path, status: 'fulfilled', inWei: s.value.inWei };
    }
    const err = s.reason;
    return {
      path,
      status: 'rejected',
      errMsg: err?.message || String(err || 'unknown'),
    };
  });

  let bestIdx = -1;
  let bestNet = 0n;
  let bestRaw = 0n;
  let firstErrMsg = '';
  let hasAnyFulfilled = false;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      if (!firstErrMsg) firstErrMsg = r.errMsg || '';
      continue;
    }
    if (r.inWei == null || r.inWei <= 0n) {
      if (!firstErrMsg) firstErrMsg = 'zero input';
      continue;
    }
    const hops = BigInt(Math.max(0, r.path.length - 2));
    const penalty = hops * HOP_GAS_PENALTY_WEI_BASE;
    const net = r.inWei + penalty; // lower input is better → add penalty
    if (!hasAnyFulfilled || net < bestNet) {
      hasAnyFulfilled = true;
      bestNet = net;
      bestRaw = r.inWei;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) {
    return { ok: false, results, firstErrMsg };
  }
  return {
    ok: true,
    bestPath: results[bestIdx].path,
    bestInWei: bestRaw,
    results,
    firstErrMsg,
  };
}

/* ============================================================
 * 3. Pre-trade final recheck: guard against INSUFFICIENT_OUTPUT
 *    caused by block drift / stale quotes
 * ============================================================ */

/**
 * Run getAmountsOut once more on the chosen path and verify that the actual
 * output >= amountOutMinExpected * (1 - slippageBps / 10000).
 * Primary use case: several seconds / a new block may have elapsed between
 * the quote and clicking swap; if the deviation exceeds the slippage bound we
 * reject early and avoid an on-chain revert.
 *
 * @param {bigint} amountInWei        Input amount (wei)
 * @param {string[]} path             Path address array
 * @param {bigint} expectedMinOutWei  Expected minimum output (usually minReceived in wei)
 * @param {number} [extraSafetyBps=0] Extra slippage tightening bps (e.g. 5 = 0.05%). Recommended to enable.
 * @param {string} [routerAddrOverride]
 * @returns {Promise<{
 *   ok:boolean,
 *   actualOutWei?:bigint,
 *   expectedMinOutWei?:bigint,
 *   deltaPct?:number,          // (actual-expected)/expected * 100; negative means below expectation
 *   errMsg?:string,
 * }>}
 */
export async function verifyPathOutputMatches(
  amountInWei,
  path,
  expectedMinOutWei,
  extraSafetyBps = 5,
  routerAddrOverride,
) {
  if (!amountInWei || amountInWei <= 0n || !Array.isArray(path) || path.length < 2) {
    return { ok: false, errMsg: 'invalid params' };
  }
  if (expectedMinOutWei == null) {
    return { ok: false, errMsg: 'no expected min' };
  }
  try {
    const routerAddr = viemGetAddress(routerAddrOverride || PANCAKE_SWAP_ROUTER_V2);
    const abi = PANCAKE_ROUTER_ABI;
    const ret = await viemReadContract({
      address: routerAddr,
      abi,
      functionName: 'getAmountsOut',
      args: [amountInWei, path.map((a) => viemGetAddress(a))],
    });
    const actual = ret?.[ret.length - 1] ?? 0n;
    // Extra tightening via extraSafetyBps: raise the acceptance threshold so that
    // even if the on-chain price drifts by `extraSafetyBps` between verify() and
    // block inclusion, the final output still stays above the user's signed floor.
    // Previously this was (10000 - extra) which *lowered* the threshold and
    // effectively widened slippage beyond the user's tolerance — WRONG direction.
    const extraBps = BigInt(Math.max(0, Math.floor(extraSafetyBps)));
    const safetyMul = 10000n + extraBps;
    // Ceiling division so rounding never hides a deficit
    const threshold = (expectedMinOutWei * safetyMul + 9999n) / 10000n;
    const ok = actual >= threshold;
    let deltaPct = 0;
    if (expectedMinOutWei > 0n) {
      const diff = actual - expectedMinOutWei;
      deltaPct = Number((diff * 1000000n) / expectedMinOutWei) / 10000; // 4 decimals
    }
    return {
      ok,
      actualOutWei: actual,
      expectedMinOutWei,
      deltaPct,
    };
  } catch (e) {
    return { ok: false, errMsg: e?.message || String(e || 'verify fail') };
  }
}

/* ============================================================
 * 4. Pure-frontend Uniswap V3 (official BSC factory) quote engine (option 1: no backend)
 *    Iterate the 4 V3 fee tiers to find pools, read slot0+liquidity, and compute the exact-in output from sqrtPriceX96
 * ============================================================ */

/**
 * Encode V3 pool key (uint256) — matches the UnxswapV3Router contract bit layout (Constants.sol):
 *   low 160 bits = pool address (_ADDRESS_MASK)
 *   bit 255 = _ONE_FOR_ZERO_MASK: 1=token1→token0, 0=token0→token1
 *             (i.e. the bit is 0 when zeroForOne=true)
 *   bit 253 = _WETH_UNWRAP_MASK: last hop WBNB→native BNB
 *   bits 251/249 = transfer mode (_MODE_DIRECT = 0b101);
 *             cleared by the caller for native-token input (the contract wraps WBNB itself via the internal payment path)
 */
export function encodeV3PoolKey(poolAddr, zeroForOne, unwrap = false) {
  const addr = BigInt(viemGetAddress(poolAddr)) & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn;
  // zeroForOne: token0→token1 → bit255 = 0; otherwise token1→token0 → bit255 = 1
  const oneForZero = zeroForOne ? 0n : (1n << 255n);
  const unwrapBit = unwrap ? (1n << 253n) : 0n;
  // MODE_DIRECT (imported) = 0b101 in bits[251,250,249]
  return addr | oneForZero | unwrapBit | MODE_DIRECT;
}

/**
 * Encode V2 pool key (bytes32) — matches UnxswapRouter._unxswapTo parsing:
 *
 *   pools[0] layout (see UnxswapRouter.sol / Constants.sol):
 *   - bits 0-159   : pair address (_ADDRESS_MASK)
 *   - bits 160-191 : numerator (_NUMERATOR_MASK, 32-bit) — fee numerator
 *                    Pancake V2 standard 0.25% fee → numerator = 997500000
 *                    (9975/10000 * _DENOMINATOR=1e9). If 0, the contract returns 0 → pair.swap
 *                    reverts with "INSUFFICIENT_OUTPUT_AMOUNT" / "swap call failed".
 *   - bit 252      : _IS_TOKEN0_TAX  — always on; input is derived from the balance delta, compatible with tax tokens
 *   - bit 253      : _IS_TOKEN1_TAX  — always on
 *   - bit 254      : _WETH_MASK (unwrap WBNB → native BNB on output)
 *   - bit 255      : _REVERSE_MASK (token1→token0 instead of token0→token1)
 *   - bits 251-249 : _MODE_DIRECT (0x0A00…) — the contract reads the transfer mode from pools[0]
 */
export function encodeV2PoolKey(pairAddr, flip, unwrap = false) {
  const addr = BigInt(viemGetAddress(pairAddr)) & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn;
  const REVERSE_BIT = 1n << 255n;  // _REVERSE_MASK
  const WETH_BIT = 1n << 254n;     // _WETH_MASK
  // UnxswapRouter._IS_TOKEN0_TAX (bit 252) + _IS_TOKEN1_TAX (bit 253).
  // Always on: the contract recomputes swapAmount from the actual balanceOf(pair) - reserve delta,
  // which is compatible with tax tokens (actual credit < amount after the transferFrom fee). For non-tax tokens the delta == amount, so the math is equivalent.
  const TAX_MASK = 0x3000000000000000000000000000000000000000000000000000000000000000n;
  const MODE_DIRECT = 0x0A00000000000000000000000000000000000000000000000000000000000000n; // bits 251+249 (0b101) — MODE_DIRECT: direct transferFrom(user→pair); works for non-tax tokens / whitelisted pairs (CAKE→BNB/USDT)
  // Pancake V2 standard 0.25% fee: 9975/10000 * 1e9 = 997500000
  const NUMERATOR = 997500000n << 160n; // _NUMERATOR_MASK bits 160-191
  const val = addr | (flip ? REVERSE_BIT : 0n) | (unwrap ? WETH_BIT : 0n) | TAX_MASK | MODE_DIRECT | NUMERATOR;
  return ('0x' + val.toString(16).padStart(64, '0'));
}

/**
 * Compute the price → output amount from a Uniswap V3-style tick (exact-in single hop).
 * Simplified version: when liquidity is sufficient, swap linearly within the current tick only; otherwise return 0 (V2 is the fallback).
 * Formulas follow UniswapV3 swap math:
 *   amountIn > 0 (exact-in)
 *   L = liquidity
 *   sqrt(P) = sqrtPriceX96 / 2^96
 *   Price movement within one tick is approximately linear:
 *     Δ(sqrt(P)) = amountIn * (2^96) / (L * 2^96 + amountIn * sqrt(P_current)) ... simplified
 * Integer-arithmetic version (avoids floating point): Δ(1/sqrtPrice) = amountIn / L
 */
function _v3QuoteExactInInt(amountInWei, sqrtPriceX96, liquidity, zeroForOne) {
  if (!amountInWei || amountInWei <= 0n) return 0n;
  if (!liquidity || liquidity <= 0n) return 0n;
  if (!sqrtPriceX96 || sqrtPriceX96 <= 0n) return 0n;
  // amount0 = Δ(1/sqrtPrice) * L ; amount1 = Δ(sqrtPrice) * L
  // Exact-in: if zeroForOne (sell token0 → buy token1), in=0 out=1
  // exact amount0 → compute new (1/sqrtPrice) = 1/sqrtPrice_curr + amount0 / L
  // amount1 = (sqrtPrice_curr - sqrtPrice_new) * L
  // Simplified (no fee, no out-of-range check): amount1 = amount0 * (sqrtPriceX96^2) / 2^192
  //   (P = (sqrtPriceX96/2^96)^2, so amount1 ≈ amount0 * P when one-to-one deep pool)
  // The implementation below uses the "flat deep pool" approximation which is accurate
  // when liquidity >> amountIn (common case for top pools). Fee deducted externally.
  try {
    const Q96 = 1n << 96n;
    const Q192 = Q96 * Q96;
    if (zeroForOne) {
      // amountIn is token0, output token1 ≈ amountIn * (sqrtPriceX96^2) / Q192
      const priceP = (sqrtPriceX96 * sqrtPriceX96) / Q192; // token1 / token0
      return amountInWei * priceP;
    } else {
      // amountIn is token1, output token0 ≈ amountIn / (sqrtPriceX96^2/Q192)  = amountIn * Q192 / (sqrtPriceX96^2)
      const s2 = sqrtPriceX96 * sqrtPriceX96;
      if (s2 <= 0n) return 0n;
      return (amountInWei * Q192) / s2;
    }
  } catch {
    return 0n;
  }
}

/**
 * For an A→B single-hop V3 swap: iterate the 4 fee tiers, quote each one, and take the maximum output
 * @returns {Promise<{
 *   ok:boolean,
 *   feeTierBps?:number,
 *   poolAddr?:string,
 *   zeroForOne?:boolean,
 *   outWei?:bigint,
 *   poolKey?:bigint,
 *   feeBp?:number,
 *   results:Array<{feeBp:number, poolAddr:string|null, status:'fulfilled'|'rejected', outWei?:bigint, errMsg?:string}>
 * }>}
 */
export async function getBestV3SingleHopExactInput(amountInWei, tokenA, tokenB) {
  if (!amountInWei || amountInWei <= 0n) return { ok: false, results: [] };
  const a = viemGetAddress(tokenA);
  const b = viemGetAddress(tokenB);
  if (_norm(a) === _norm(b)) return { ok: false, results: [] };

  const factory = viemGetAddress(UNISWAP_V3_FACTORY);
  const tiers = UNISWAP_V3_FEE_TIERS;

  // Step 1: concurrently query the pool address for each of the 4 fee tiers
  const getPoolSettled = await Promise.allSettled(
    tiers.map((feeBp) =>
      viemReadContract({
        address: factory,
        abi: V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [a, b, Number(feeBp)],
      }).catch(() => null),
    ),
  );
  const poolAddrs = getPoolSettled.map((s) =>
    s.status === 'fulfilled' && s.value && typeof s.value === 'string' && s.value !== viemGetAddress('0x0000000000000000000000000000000000000000')
      ? s.value
      : null,
  );

  // Step 2: for existing pools, concurrently read slot0 + liquidity + token0/token1 + fee
  const quoteTasks = poolAddrs.map(async (poolAddr, i) => {
    const feeBp = tiers[i];
    if (!poolAddr) return { feeBp, poolAddr: null, status: 'rejected', errMsg: 'no pool' };
    try {
      const [slot, liq, t0, t1] = await Promise.all([
        viemReadContract({ address: viemGetAddress(poolAddr), abi: V3_POOL_ABI, functionName: 'slot0' }),
        viemReadContract({ address: viemGetAddress(poolAddr), abi: V3_POOL_ABI, functionName: 'liquidity' }),
        viemReadContract({ address: viemGetAddress(poolAddr), abi: V3_POOL_ABI, functionName: 'token0' }),
        viemReadContract({ address: viemGetAddress(poolAddr), abi: V3_POOL_ABI, functionName: 'token1' }),
      ]);
      if (!slot || typeof slot[0] !== 'bigint') throw new Error('bad slot0');
      const sqrtPriceX96 = slot[0];
      const liquidity = typeof liq === 'bigint' ? liq : 0n;
      const aNorm = _norm(a);
      const t0Norm = _norm(String(t0));
      const zeroForOne = aNorm === t0Norm; // 1 → 0?
      // Fee deduction: the Uniswap V3 fee is in 1e6 units (100 = 0.01%), amountInAfterFee = amountIn * (1e6 - fee) / 1e6
      const feeMul = 1000000n - BigInt(Math.max(0, feeBp));
      const inAfterFee = (amountInWei * feeMul) / 1000000n;
      const outBefore = _v3QuoteExactInInt(inAfterFee, sqrtPriceX96, liquidity, zeroForOne);
      if (outBefore <= 0n) return { feeBp, poolAddr, status: 'fulfilled', outWei: 0n };
      return { feeBp, poolAddr, status: 'fulfilled', outWei: outBefore, zeroForOne };
    } catch (e) {
      return { feeBp, poolAddr, status: 'rejected', errMsg: e?.message || String(e || 'v3 quote fail') };
    }
  });

  const results = await Promise.all(quoteTasks);
  let bestIdx = -1;
  let best = 0n;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && typeof r.outWei === 'bigint' && r.outWei > best) {
      best = r.outWei;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return { ok: false, results };
  const chosen = results[bestIdx];
  const poolAddr = poolAddrs[bestIdx];
  const zeroForOne = Boolean(chosen.zeroForOne);
  // V3 pool key uint256 for uniswapV3SwapTo
  const poolKey = encodeV3PoolKey(poolAddr, zeroForOne, false);
  return {
    ok: true,
    feeTierBps: tiers[bestIdx],
    feeBp: tiers[bestIdx],
    poolAddr,
    zeroForOne,
    outWei: best,
    poolKey,
    results,
  };
}

/* ============================================================
 * 5. Unified quote entry: V2 + V3 ranked together, returns the best path plus encoded pools
 *    - type: 'v2-single' → pools(bytes32[]) for unxswapTo
 *    - type: 'v3-single' → pools(uint256[]) for uniswapV3SwapTo
 *    - type: 'dag-multi' → paths(RouterPath[]) for dagSwapTo
 * ============================================================ */

export async function getBestQuoteExactInputMixed(amountInWei, fromAddr, toAddr, opts = {}) {
  if (!amountInWei || amountInWei <= 0n) return { ok: false };
  const wbnb = opts.wbnbAddr || WBNB_ADDRESS;
  const usdt = opts.usdtAddr || USDT_ADDRESS;
  // Quote diagnostic logs are emitted only in dev builds; production builds stay silent
  const _dbg = !!import.meta.env?.DEV;

  // 1) All V2 candidate paths (single-hop / multi-hop / triple-hop) — existing implementation
  const v2Candidates = buildCandidatePaths(fromAddr, toAddr, {
    wbnbAddr: wbnb,
    usdtAddr: usdt,
    busdAddr: opts.busdAddr || undefined,
    includeTripleHops: true,
  });
  if (_dbg) {
    console.log('[QuoteMix] ↓in', { amountInWei: amountInWei.toString(), from: fromAddr?.slice?.(0, 10), to: toAddr?.slice?.(0, 10), v2Candidates: v2Candidates.length });
    v2Candidates.forEach((p, i) => console.log(`[QuoteMix]   v2 cand[${i}]`, p.map(a => a?.slice?.(0, 8) + '..' + a?.slice?.(-4)).join(' → ')));
  }
  const v2Promise = getBestPathExactInput(amountInWei, v2Candidates, PANCAKE_SWAP_ROUTER_V2);

  // 2) V3 entries are disabled on the frontend: quotes/trades go PancakeSwap V2
  //    only. The router's V3 callback validates against the Uniswap V3 BSC
  //    factory whose direct pools are too shallow for reliable quotes.
  //    Re-enable by restoring the getBestV3SingleHopExactInput call here.
  const v3 = { ok: false, results: [] };

  const v2 = await v2Promise;

  if (_dbg) {
    console.log('[QuoteMix] V2 result:', { ok: v2.ok, bestOutWei: v2.bestOutWei?.toString?.() || null, bestPathLen: v2.bestPath?.length, firstErrMsg: v2.firstErrMsg });
    if (v2.results?.length) v2.results.forEach((r, i) => console.log(`[QuoteMix]   v2[${i}]: ${r.status} outWei=${r.outWei?.toString?.() || 'null'} err=${r.errMsg || ''}`));
    console.log('[QuoteMix] V3 result:', { ok: v3.ok, outWei: v3.outWei?.toString?.() || null, feeTierBps: v3.feeTierBps, poolAddr: v3.poolAddr });
    if (v3.results?.length) v3.results.forEach((r, i) => console.log(`[QuoteMix]   v3[${i}]: fee=${r.feeBp} pool=${r.poolAddr || '0x0'} ${r.status} out=${r.outWei?.toString?.() || '0'} err=${r.errMsg || ''}`));
  }

  const entries = [];
  if (v2.ok && v2.bestOutWei && typeof v2.bestOutWei === 'bigint' && v2.bestOutWei > 0n) {
    const path = v2.bestPath;
    if (path.length === 2) {
      const pairAB = await _lookupPairAddress(path[0], path[1]).catch((e) => { if (_dbg) console.warn('[QuoteMix] v2-single _lookupPairAddress failed:', e?.message || String(e)); return null; });
      if (pairAB) {
        const flipFlag = _norm(path[0]) > _norm(path[1]);
        const poolKey = encodeV2PoolKey(pairAB, flipFlag, false);
        entries.push({
          type: 'v2-single',
          outWei: v2.bestOutWei,
          poolKeys: [poolKey],
          hops: [{ from: path[0], to: path[1], dex: 'Pancake V2' }],
          hopPenalty: 0n,
        });
        if (_dbg) console.log('[QuoteMix] PUSH v2-single pair=', pairAB?.slice?.(0, 10), 'out=', v2.bestOutWei.toString());
      } else if (_dbg) {
        console.warn('[QuoteMix] SKIP v2-single: pair address returned null/zero');
      }
    } else {
      // Multi-hop V2: use unxswapTo (the pools array supports multiple hops), not DagRouter (which depends on adapter contracts)
      const poolKeys = [];
      let allPairsOk = true;
      for (let i = 0; i < path.length - 1; i++) {
        const pair = await _lookupPairAddress(path[i], path[i + 1]).catch(() => null);
        if (!pair) { allPairsOk = false; break; }
        const flipFlag = _norm(path[i]) > _norm(path[i + 1]);
        // If the last hop is WBNB→BNB (native token output), the unwrap bit must be set
        const isLastHop = (i === path.length - 2);
        const needUnwrap = isLastHop && _norm(path[i + 1]) === _norm(WBNB_ADDRESS);
        const poolKeyHex = encodeV2PoolKey(pair, flipFlag, needUnwrap);
        poolKeys.push(poolKeyHex);
      }
      if (allPairsOk && poolKeys.length === path.length - 1) {
        entries.push({
          type: 'v2-multi',
          outWei: v2.bestOutWei,
          poolKeys,
          bestPath: path,
          hops: path.slice(1).map((to, i) => ({ from: path[i], to, dex: 'Pancake V2' })),
          hopPenalty: BigInt(path.length - 2) * HOP_GAS_PENALTY_WEI_BASE,
        });
        if (_dbg) console.log('[QuoteMix] PUSH v2-multi hops=', path.length - 1, 'out=', v2.bestOutWei.toString());
      } else if (_dbg) {
        console.warn('[QuoteMix] SKIP v2-multi: only got', poolKeys.length, '/ need', path.length - 1, 'hops');
      }
    }
  }
  if (v3.ok && v3.outWei && typeof v3.outWei === 'bigint' && v3.outWei > 0n) {
    entries.push({
      type: 'v3-single',
      outWei: v3.outWei,
      poolKeys: [v3.poolKey],
      poolAddr: v3.poolAddr,
      feeBp: v3.feeBp,
      zeroForOne: v3.zeroForOne,
      hops: [{ from: fromAddr, to: toAddr, dex: `Uniswap V3 ${(v3.feeBp / 10000).toFixed(2)}%` }],
      hopPenalty: 0n,
    });
    if (_dbg) console.log('[QuoteMix] PUSH v3-single fee=', v3.feeBp, 'pool=', v3.poolAddr?.slice?.(0, 10), 'out=', v3.outWei.toString());
  }

  if (entries.length === 0) {
    const m = v2.firstErrMsg || (v3.results?.[0]?.errMsg) || 'no liquidity';
    if (_dbg) console.error('[QuoteMix] NO ENTRIES → fail, firstErrMsg=', m);
    return {
      ok: false,
      v2,
      v3,
      firstErrMsg: m,
    };
  }
  if (_dbg) console.log('[QuoteMix] Aggregate entries=', entries.length, 'types:', entries.map(e => e.type + '/' + (e.outWei?.toString?.() || '?')));
  // Pick the largest net value (outWei - hopPenalty)
  let best = entries[0];
  let bestNet = entries[0].outWei - (entries[0].hopPenalty || 0n);
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const net = e.outWei - (e.hopPenalty || 0n);
    if (net > bestNet) {
      best = e;
      bestNet = net;
    }
  }
  return {
    ok: true,
    best,
    bestOutWei: best.outWei,
    allEntries: entries,
    v2,
    v3,
  };
}

// PancakeSwap V2 (BSC mainnet, factory 0xcA143…) official INIT_CODE_HASH used by CREATE2 pair deploy
const PANCAKE_V2_INIT_CODE_HASH = '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const _pairCache = new Map();

function _hexToBytes(hexStr) {
  let s = String(hexStr || '0x');
  if (s.startsWith('0x')) s = s.slice(2);
  if (s.length % 2 === 1) s = '0' + s;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
function _bytesToHex(bytes) {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}
function _computePancakeV2PairAddress(tokenA, tokenB) {
  const a = viemGetAddress(tokenA);
  const b = viemGetAddress(tokenB);
  const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const saltHex = viemKeccak256(viemEncodePacked(['address', 'address'], [t0, t1]));
  const factory = viemGetAddress(PANCAKE_SWAP_FACTORY_V2);
  const PREFIX_0xFF = Uint8Array.of(255);
  const fBytes = _hexToBytes(factory);
  const sBytes = _hexToBytes(saltHex);
  const hBytes = _hexToBytes(PANCAKE_V2_INIT_CODE_HASH);
  const combined = new Uint8Array(1 + fBytes.length + sBytes.length + hBytes.length);
  combined.set(PREFIX_0xFF, 0);
  combined.set(fBytes, 1);
  combined.set(sBytes, 1 + fBytes.length);
  combined.set(hBytes, 1 + fBytes.length + sBytes.length);
  const offHex = viemKeccak256(_bytesToHex(combined));
  const addrBytes = _hexToBytes(offHex).slice(12);
  return viemGetAddress(_bytesToHex(addrBytes));
}
// Thin wrapper around viemReadContract that mirrors the exact ABI-shape used by
// getAmountsOut (which works 100% of the time). Ensures resolveAbi behaviour is
// identical between the two call paths.
async function _factoryGetPairRaw(tokenA, tokenB) {
  return viemReadContract({
    address: viemGetAddress(PANCAKE_SWAP_FACTORY_V2),
    abi: PANCAKE_ROUTER_ABI.concat([
      { name: 'getPair', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }] },
    ]),
    functionName: 'getPair',
    args: [viemGetAddress(tokenA), viemGetAddress(tokenB)],
  });
}
// Given a candidate pair address, verify it actually has getReserves on-chain.
// Cheap sanity check: prevents accepting a CREATE2 address whose INIT_CODE_HASH
// was wrong (would otherwise be cached & poison the encodeV2PoolKey → on-chain revert).
async function _verifyPairHasReserves(pairAddr) {
  try {
    const r = await viemReadContract({
      address: viemGetAddress(pairAddr),
      abi: [{ name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] }],
      functionName: 'getReserves',
    });
    const r0 = r?.[0];
    const r1 = r?.[1];
    if (typeof r0 === 'bigint' && typeof r1 === 'bigint' && (r0 > 0n || r1 > 0n)) return { ok: true, r0, r1 };
    return { ok: false, err: 'empty/zero reserves' };
  } catch (e) {
    return { ok: false, err: e?.message || String(e) };
  }
}
// Look up the V2 pair address: prefer off-chain CREATE2 (zero RPC), then fall back to on-chain queries — a three-tier fallback.
async function _lookupPairAddress(tokenA, tokenB) {
  const key = _norm(tokenA) + '|' + _norm(tokenB);
  if (_pairCache.has(key)) {
    return _pairCache.get(key);
  }

  // Tier 1: off-chain CREATE2 (correct only when INIT_CODE_HASH matches the factory deployment).
  // Reserves must be verified on-chain before trusting it; otherwise a mismatched INIT_CODE_HASH
  // returns a wrong address that gets cached and fed to encodeV2PoolKey, causing an on-chain revert.
  try {
    const off = _computePancakeV2PairAddress(tokenA, tokenB);
    if (off && viemGetAddress(off) !== viemGetAddress(ZERO_ADDR)) {
      const vfy = await _verifyPairHasReserves(off);
      if (vfy.ok) {
        _pairCache.set(key, off);
        return off;
      }
    }
  } catch (e) {
    // Fall through to the on-chain query
  }

  // Tier 2: Factory.getPair (minimal ABI)
  try {
    const v = await viemReadContract({
      address: viemGetAddress(PANCAKE_SWAP_FACTORY_V2),
      abi: ['function getPair(address,address) view returns (address)'],
      functionName: 'getPair',
      args: [viemGetAddress(tokenA), viemGetAddress(tokenB)],
    });
    if (v && viemGetAddress(v) !== viemGetAddress(ZERO_ADDR)) {
      _pairCache.set(key, v);
      return v;
    }
  } catch (e) {
    // Fall through to Tier 3
  }

  // Tier 3: re-read getPair through the exact same PANCAKE_ROUTER_ABI + resolveAbi pipeline
  // used by getAmountsOut, covering cases where Tier-2's string ABI normalisation fails.
  try {
    const v2 = await _factoryGetPairRaw(tokenA, tokenB);
    if (v2 && viemGetAddress(v2) !== viemGetAddress(ZERO_ADDR)) {
      _pairCache.set(key, v2);
      return v2;
    }
  } catch (e) {
    // All three tiers failed
  }

  return undefined;
}

/* ============================================================
 * 6. BaseRequest + ExtraData encoding (for the new DexRouter)
 * ============================================================ */

/**
 * Encode BaseRequest struct — matches the contract's decoding.
 *
 * Key encoding rules (from Constants.sol / CommonLib / UnxswapRouter.sol):
 *   - The MODE bits live in uint256 bits [253, 251, 249], NOT around bit 160!
 *   - _MODE_DIRECT = 0x0A00… (full 256-bit mask, not a small number + <<160)
 *   - _ADDRESS_MASK = the low 160 bits; bytes32ToAddress takes only these 160 bits as the address
 *   - The native token (ETH_PLACEHOLDER = 0xEeee…) must NOT have MODE OR-ed in, otherwise the
 *     high-bit pollution fails the `srcTokenAddr == fromToken` check (fromToken decoded inside
 *     the pool is pure _ETH with clean bits)
 *   - ERC20 tokens: `fromToken = MODE_DIRECT | uint160(addr)` (MODE set in the top 3 bits)
 *
 * @param {string} fromTokenAddr token address / pass ETH_PLACEHOLDER for the native token
 * @param {string} toTokenAddr   toToken is an address (the BaseRequest field is address, no MODE overlay)
 * @param {bigint} fromAmountWei
 * @param {bigint} minReturnWei
 * @param {number|bigint} deadline
 * @param {bigint} [mode=MODE_DIRECT] applies to ERC20 only; callers passing the native token must pass 0n
 */
export function encodeBaseRequest(fromTokenAddr, toTokenAddr, fromAmountWei, minReturnWei, deadline, mode = MODE_DIRECT) {
  const addrMask = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn;
  const fromAddrBig = BigInt(viemGetAddress(fromTokenAddr)) & addrMask;
  const isEth = fromAddrBig === (BigInt(viemGetAddress(ETH_PLACEHOLDER)) & addrMask);
  // Overlay MODE only for non-native tokens: mode is already a 256-bit mask (e.g. 0x0A00…), so OR it directly;
  // the native token keeps the low 160 bits clean, otherwise `_TRANSFER_MODE_MASK & fromToken` is
  // mistaken as carrying a mode while the _ETH decoded inside the pool is clean, failing the srcTokenAddr check.
  const fromToken = isEth ? fromAddrBig : (BigInt(mode) | fromAddrBig);
  return {
    fromToken,
    toToken: viemGetAddress(toTokenAddr),
    fromTokenAmount: BigInt(fromAmountWei),
    minReturnAmount: BigInt(minReturnWei),
    deadLine: BigInt(deadline),
  };
}

/* ============================================================
 * 6. BaseRequest + ExtraData encoding (for the new DexRouter)
 * ============================================================ */

/* ---- FLAG constants required for the contract's ExtraDataLib/Constants tight packing ----
 * ExtraDataLib.getDecodedExtraData scans flags from the tail of calldata **leftward in 32-byte alignment**:
 *  1) commissionInfo : 2 words (for single referrer)
 *     word[-32..-1] (tail): flag(48b top) | rate(16b @ 160..175) | referrerAddr(160b)
 *     word[-64..-33]: toB(1b top) | 0 | tokenWithModeAddr(160b)
 *  2) trimInfo     : 0 words (disabled by default)
 *  3) permit2Info  : 0 words (unused by default)
 *  4) refundTo     : 1 word if present else 0
 *     word: refundTo flag(48b top) | refundToAddr(160b)
 *
 * Layout order (from low bytes to high bytes / written first = placed left = enters calldata first):
 *   [refundToWord 32B] + [tokenWithModeWord 32B] + [flagRateRefWord 32B]
 * Scanning: align to endPoint first, read flagRateRefWord → detect referrerNum=1 → length=2
 *        → trim length=0 → permit2 length=0 → read further back for refundTo → length=1
 * Total: 3 words = 96 bytes.
 */
// Constants.sol: TO_TOKEN_COMMISSION = bytes5(0x3ca20afc2a) + "bb" marker
const TO_TOKEN_COMMISSION_FLAG   = 0x3ca20afc2bbbn << (256n - 48n);
// REFUND_TO_ADDRESS_FLAG = bytes6(keccak256("RefundTo")) = 0xac3a7da8b1c6 << (256-48)
const REFUND_TO_ADDRESS_FLAG = 0xac3a7da8b1c6n << (256n - 48n);
// _COMMISSION_RATE_MASK = 0x000000000000ffffffffffff0000… (bits 176..160)
//  → rate is placed after a 160-bit left shift; rate is an integer under commissionDenominator 1e9,
//    overridden by the contract's _overridePlatformFee via extraData; frontend default 15bp = 15e6 = 15_000_000
const COMMISSION_RATE_SHIFT = 160n;
// NO_TO_B_MODE = 1 → tokenWithModeWord top bit (bit255) set to 0, low 160 bits hold the token;
// for safety we set bit255=1 (TO_B_MODE = 2) so the contract takes the "skip toB" safe branch;
// but in _parseCommissionInfo NO_TO_B_MODE is the default (gt(_TO_B_COMMISSION_MASK,0)? TO_B : NO_TO_B)
// _TO_B_COMMISSION_MASK = bit255. Default 0 → NO_TO_B = 1, which is the "normal mode" and is correct.
const ADDR_MASK = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn;
// _TRANSFER_MODE_MASK & _MODE_BY_INVEST (consistent with Constants.sol): top 3 bits of tokenWithMode (bits 251..249)
// MODE_DIRECT = 0b101 (0x0A00…) → transferFrom(user→pair); non-tax tokens / whitelisted pairs are commission-compatible
const _TRANSFER_MODE_MASK = 0x0E00000000000000000000000000000000000000000000000000000000000000n;
const _MODE_DIRECT        = 0x0A00000000000000000000000000000000000000000000000000000000000000n;

/**
 * Decide the commission direction and the token address used for fee deduction.
 *
 * Note: DexRouter._overridePlatformFee (L218-285) is a private view that unconditionally
 * overrides the commissionInfo passed by the frontend at every swap entry point (the direction
 * is decided by the contract's isStablecoin map). So the commission flag/direction/amount written
 * here are effectively overwritten by the contract and take no effect.
 *
 * To keep handling identical for all tokens, this always returns TO_TOKEN_COMMISSION + toToken.
 * The actual commission direction is decided by the contract's _overridePlatformFee; the frontend
 * does not special-case any particular token.
 *
 * @param {string} fromAddr
 * @param {string} toAddr
 * @returns {{ tokenAddr:string, flag:bigint }}
 */
export function _resolveCommissionSide(fromAddr, toAddr) {
  // Uniform handling: identical for all tokens, no special-casing for any particular token
  // The commission direction is decided by the contract's _overridePlatformFee; the frontend only fills defaults
  return { tokenAddr: toAddr, flag: TO_TOKEN_COMMISSION_FLAG };
}

function _addr(a) { return BigInt(viemGetAddress(a)) & ADDR_MASK; }
function _u256Hex(v) { return '0x' + v.toString(16).padStart(64, '0'); }

/**
 * Convert a uint256 (BigInt) → 0x-prefixed 66-char hex (a single bytes32).
 * Final ExtraData = bytes = concat([32B refundTo] + [32B tokenWord] + [32B flagWord])
 *
 * @param {string} refundTo     refund address
 * @param {string} referrer     referrer address (0 means disabled)
 * @param {bigint|number} commissionRateBp  platform fee (15bp = 0.15%)
 * @param {{ fromAddr?:string, toAddr?:string }} opts
 *        fromAddr/toAddr: inputs for commission-direction resolution (currently uniformly the to side; the contract overrides it)
 */
export function buildExtraData(
  refundTo,
  referrer = '0x0000000000000000000000000000000000000000',
  commissionRateBp = 15n,
  opts = {},
) {
  const { fromAddr, toAddr } = opts;
  // rate: 1 bp = 0.01%, COMMISSION_DENOMINATOR_1E9 = 1e9
  //   platformFeeBp (15) → 15 * 1e9 / 10000 = 15_000_000
  const bp = BigInt(Math.max(0, Number(commissionRateBp) || 0));
  const rate = (bp * 1_000_000_000n) / 10000n;

  // ① Choose the commission direction: always call _resolveCommissionSide (uniform handling for all tokens)
  //    Note: the contract's _overridePlatformFee unconditionally overrides the commission here; the frontend value is only a placeholder
  let commissionFlag = 0n;
  let tokenForCommissionAddr = '0x0000000000000000000000000000000000000000';
  if (fromAddr && toAddr) {
    const r = _resolveCommissionSide(fromAddr, toAddr);
    commissionFlag = r.flag;
    tokenForCommissionAddr = r.tokenAddr;
  }

  // ② commission tail word (rightmost word): flag (top 48 bits) | rate<<160 | referrerAddr (low 160 bits)
  const flagRateRefWord = commissionFlag | ((rate & 0xFFFFFFFFFFFFFFFFn) << COMMISSION_RATE_SHIFT) | _addr(referrer);

  // ③ commission second word (tokenWithMode):
  //    - low 160 bits: explicitly write the fee-deduction token address (matching the chosen side), avoiding a validateCommissionInfo failure when token=0
  //    - bits 251..249: set _MODE_DIRECT, consistent with pools[0]; TransferLib calls safeTransferFrom according to this mode
  const cleanTokenAddr = (tokenForCommissionAddr && typeof tokenForCommissionAddr === 'string')
    ? tokenForCommissionAddr
    : '0x0000000000000000000000000000000000000000';
  const tokenWithModeWord = ((_MODE_DIRECT) & _TRANSFER_MODE_MASK) | (_addr(cleanTokenAddr) & ADDR_MASK);

  // ④ refundToWord (leftmost word): REFUND_TO_ADDRESS_FLAG | refundTo
  const refundWord = REFUND_TO_ADDRESS_FLAG | _addr(refundTo);

  // Concatenation order = refund (LEFT, written first) | tokenWithMode | flagRateRef (RIGHT, tail-scan anchor)
  return viemConcat([
    _u256Hex(refundWord),
    _u256Hex(tokenWithModeWord),
    _u256Hex(flagRateRefWord),
  ]);
}

/**
 * Append ExtraData to a function's calldata (direct hex concatenation)
 * @param {`0x${string}`} baseCalldata
 * @param {`0x${string}`} extraData
 */
export function appendExtraData(baseCalldata, extraData) {
  return viemConcat([baseCalldata, extraData]);
}

/**
 * Compute the display output amount after the platform fee is deducted
 * @param {bigint} rawOutWei  quoted output (before the platform fee)
 * @param {number|bigint} platformFeeBp value read on-chain (default 15)
 */
export function deductPlatformFee(rawOutWei, platformFeeBp) {
  if (!rawOutWei || rawOutWei <= 0n) return 0n;
  const bp = BigInt(Math.max(0, Number(platformFeeBp) || 0));
  if (bp <= 0n) return rawOutWei;
  // Integer truncation: the user receives bp / 10000 less
  return (rawOutWei * (10000n - bp)) / 10000n;
}

/* ============================================================
 * 7. Input-side allowance (mirrors DexRouter stablecoin fee pull)
 * ============================================================ */

// DexRouter.DEFAULT_PLATFORM_FEE_BP = 15 (bp), BP_TO_COMMISSION_RATE = 100_000
// → totalRate = 15 * 100_000 = 1_500_000 over COMMISSION_DENOMINATOR_1E9
const PLATFORM_FEE_RATE_1E9 = 1_500_000n; // 0.15%
const COMMISSION_DENOMINATOR_1E9 = 1_000_000_000n;

// DexRouter constructor seeds isStablecoin with these six BSC addresses
// (HOOK_USDT/USDC/BUSD/USDD/TUSD/DAI). Fee on these input tokens is pulled
// from the fromToken side via transferFrom against the router allowance.
const FROM_FEE_STABLE_ADDRS = new Set([
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0xd17479997f34dd9156deef8f9ba5045cd2e3f1c5', // USDD
  '0x14016e85a25aeb13065688cafb43044c2ef86784', // TUSD
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
]);

/**
 * Required router allowance for the input leg of a swap.
 *
 * When fromToken is a router-built-in stablecoin, DexRouter charges the
 * platform fee on the INPUT side (TransferLib):
 *   commission = input * totalRate / (1e9 - totalRate)
 * and pulls it with a separate transferFrom(user → router) in addition to
 * the swap transferFrom(user → pair). The router allowance must therefore
 * cover input + commission. For all other input tokens the fee is taken on
 * the output side and the input allowance equals the swap amount.
 *
 * @param {bigint|number|string} amountInWei swap input amount in token wei
 * @param {string} fromTokenAddr ERC20 input token address
 * @returns {bigint} required allowance in token wei
 */
export function getRequiredInputAllowanceWei(amountInWei, fromTokenAddr) {
  const amt = BigInt(amountInWei || 0);
  if (amt <= 0n) return 0n;
  let key;
  try {
    key = viemGetAddress(fromTokenAddr).toLowerCase();
  } catch {
    return amt;
  }
  if (!FROM_FEE_STABLE_ADDRS.has(key)) return amt;
  const commission = (amt * PLATFORM_FEE_RATE_1E9)
    / (COMMISSION_DENOMINATOR_1E9 - PLATFORM_FEE_RATE_1E9);
  return amt + commission;
}
