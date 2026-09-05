import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getAddress as viemGetAddress, formatUnits as viemFormatUnits, parseUnits as viemParseUnits } from 'viem';
import {
  TOKENS, PAIR_ABI,
  PANCAKE_SWAP_FACTORY_V2, FACTORY_ABI,
  WBNB_ADDRESS, USDT_ADDRESS,
  PANCAKE_SWAP_ROUTER_V2, PANCAKE_ROUTER_ABI,
} from '@/config/index.js';
import { resetReadProvider, viemReadContract } from '@/utils/index.js';
import { allTokenEntries } from '@/utils/tokens.js';
import { useWalletStore } from './walletStore.js';

const POSITIONS_CACHE_TTL = 30_000; // Positions cache 30s

const _isBnbAliases = (s) => s === 'BNB' || s === 'WBNB';

// Token decimals: prefer decimalsOverride read from chain, fall back to the ERC20 standard of 18
function getTokenDecimals(sym) {
  const s = _isBnbAliases(sym) ? 'WBNB' : sym;
  const tok = TOKENS[s];
  if (!tok?.address) return 18;
  const ov = useWalletStore.getState().decimalsOverride?.[tok.address.toLowerCase()];
  if (ov != null) return Number(ov);
  return 18;
}

// Generate pairs to scan: every pairwise combination of built-in tokens + user-imported custom tokens.
// Dedup by address also naturally removes BNB/WBNB duplicates (native is normalized to the WBNB address).
function generateScanPairs(customTokens) {
  const addrs = [];
  const seen = new Set();
  for (const { token } of allTokenEntries(customTokens)) {
    const addr = token?.isNative ? WBNB_ADDRESS : token?.address;
    if (!addr) continue;
    const lower = addr.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    addrs.push(lower);
  }
  const pairs = [];
  for (let i = 0; i < addrs.length; i++) {
    for (let j = i + 1; j < addrs.length; j++) {
      pairs.push([addrs[i], addrs[j]]);
    }
  }
  return pairs;
}

// USDT price cache (module level)
const _usdtPriceCache = new Map();
async function getTokenUsdtPrice(tokenSym) {
  const s = _isBnbAliases(tokenSym) ? 'WBNB' : tokenSym;
  if (_usdtPriceCache.has(s)) return _usdtPriceCache.get(s);
  if (s === 'USDT') { _usdtPriceCache.set('USDT', 1); return 1; }
  const tok = TOKENS[s];
  const addr = tok?.address;
  if (!addr) return null;
  try {
    const amountInWei = viemParseUnits('1', getTokenDecimals(s));
    const paths = [[addr, USDT_ADDRESS], [addr, WBNB_ADDRESS, USDT_ADDRESS]];
    let price = null;
    for (const p of paths) {
      try {
        const out = await viemReadContract({
          address: viemGetAddress(PANCAKE_SWAP_ROUTER_V2),
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountInWei, p.map(a => viemGetAddress(a))],
        });
        price = parseFloat(viemFormatUnits(out[out.length - 1], 18));
        break;
      } catch (e) { continue; }
    }
    _usdtPriceCache.set(s, price);
    return price;
  } catch (e) {
    return null;
  }
}

const ERC20_MIN_ABI = [
  { 'inputs': [], 'name': 'symbol', 'outputs': [{ 'internalType': 'string', 'name': '', 'type': 'string' }], 'stateMutability': 'view', 'type': 'function' },
  { 'inputs': [], 'name': 'decimals', 'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }], 'stateMutability': 'view', 'type': 'function' },
];

// Resolve token info from address (read directly from chain if not found in TOKENS)
async function resolveTokenInfo(addr) {
  if (!addr) return null;
  const checksumAddr = viemGetAddress(addr);
  const lower = addr.toLowerCase();
  // First look it up in TOKENS
  for (const [sym, t] of Object.entries(TOKENS)) {
    if (t?.address?.toLowerCase() === lower) {
      return { sym, dec: getTokenDecimals(sym), isKnown: true, address: t.address };
    }
  }
  // Check the WBNB alias
  if (TOKENS.WBNB?.address && lower === TOKENS.WBNB.address.toLowerCase()) {
    return { sym: 'BNB', dec: 18, isKnown: true, address: TOKENS.WBNB.address };
  }
  // Read directly from chain
  try {
    const [sym, dec] = await Promise.all([
      viemReadContract({ address: checksumAddr, abi: ERC20_MIN_ABI, functionName: 'symbol' }).catch(() => null),
      viemReadContract({ address: checksumAddr, abi: ERC20_MIN_ABI, functionName: 'decimals' }).catch(() => 18),
    ]);
    return { 
      sym: sym || addr.slice(0, 6) + '...' + addr.slice(-4), 
      dec: Number(dec) || 18, 
      isKnown: false,
      address: checksumAddr,
    };
  } catch (e) {
    return { sym: addr.slice(0, 6) + '...' + addr.slice(-4), dec: 18, isKnown: false, address: checksumAddr };
  }
}

// Read position info from a single LP address
async function fetchSingleLpPosition(pairAddr, userAddr) {
  if (!pairAddr || !userAddr) return null;
  try {
    const pairAddrChecksum = viemGetAddress(pairAddr);
    const [bal, totalSupply, token0Addr, token1Addr, reserves] = await Promise.all([
      viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'balanceOf', args: [viemGetAddress(userAddr)] }).catch(() => 0n),
      viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'totalSupply' }).catch(() => 0n),
      viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token0' }).catch(() => null),
      viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token1' }).catch(() => null),
      viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'getReserves' }).catch(() => null),
    ]);
    if (bal <= 0n || !token0Addr || !token1Addr || !reserves || totalSupply <= 0n) return null;
    
    // Resolve token0/token1 info (handles both known and unknown tokens)
    const [tok0, tok1] = await Promise.all([
      resolveTokenInfo(token0Addr),
      resolveTokenInfo(token1Addr),
    ]);
    if (!tok0?.sym || !tok1?.sym) return null;
    
    // Use reserves in the original token0/token1 order
    const sa = tok0.sym;
    const sb = tok1.sym;
    const decA = tok0.dec;
    const decB = tok1.dec;
    const reserveA = reserves[0];
    const reserveB = reserves[1];

    // To prevent same-name contracts (e.g. legacy CFO) from being confused with built-in tokens,
    // append a shortened address when an unknown token read from chain collides with a built-in symbol
    const shortAddr = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '');
    const disambigSuffix = (tok) => {
      if (tok.isKnown) return '';
      const staticTok = TOKENS[tok.sym];
      if (staticTok && staticTok.address?.toLowerCase() !== tok.address?.toLowerCase()) {
        return `·${shortAddr(tok.address)}`;
      }
      return '';
    };
    const suffixA = disambigSuffix(tok0);
    const suffixB = disambigSuffix(tok1);

    const share = Number(bal) / Number(totalSupply);
    const amountA = parseFloat(viemFormatUnits(reserveA, decA)) * share;
    const amountB = parseFloat(viemFormatUnits(reserveB, decB)) * share;
    // BNB alias handling
    const baseA = _isBnbAliases(sa) ? 'WBNB' : sa;
    const baseB = _isBnbAliases(sb) ? 'WBNB' : sb;
    const displayA = `${_isBnbAliases(sa) ? 'BNB' : sa}${suffixA}`;
    const displayB = `${_isBnbAliases(sb) ? 'BNB' : sb}${suffixB}`;
    const pairName = `${baseA}${suffixA}/${baseB}${suffixB}`;
    
    // For known tokens, attempt to show the price
    let totalValue = '—';
    if (tok0.isKnown) {
      try {
        const priceA = await getTokenUsdtPrice(sa);
        if (priceA != null && priceA > 0) {
          totalValue = `$${(amountA * priceA * 2).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
        }
      } catch (e) {}
    }
    
    return {
      pairAddr: pairAddrChecksum,
      pair: pairName,
      tokenA: displayA,
      tokenB: displayB,
      tokenAAddr: tok0.address,
      tokenBAddr: tok1.address,
      tokenADecimals: decA,
      tokenBDecimals: decB,
      isNativeA: _isBnbAliases(sa),
      isNativeB: _isBnbAliases(sb),
      lpAmount: viemFormatUnits(bal, 18),
      amountA: amountA.toFixed(6),
      amountB: amountB.toFixed(6),
      share: (share * 100).toFixed(4),
      totalValue,
      reserves: { reserveA: viemFormatUnits(reserveA, decA), reserveB: viemFormatUnits(reserveB, decB), totalSupply: viemFormatUnits(totalSupply, 18) },
    };
  } catch (e) {
    console.warn('[liquidityStore] failed to read single LP:', pairAddr, e?.message || String(e));
    return null;
  }
}

// Actually read the user's LP positions
async function fetchPositionsForUser(address, importedLps = []) {
  if (!address) return [];
  const out = [];
  const seenPairs = new Set();
  const pairAddrs = [];
  
  // 1. Get pair LP addresses from the Factory (built-in tokens + user-imported custom tokens)
  const customTokens = useWalletStore.getState().customTokens || {};
  const scanPairs = generateScanPairs(customTokens);
  for (const [aAddr, bAddr] of scanPairs) {
    if (!aAddr || !bAddr || aAddr === bAddr) continue;
    try {
      const pairAddr = await viemReadContract({
        address: viemGetAddress(PANCAKE_SWAP_FACTORY_V2),
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [viemGetAddress(aAddr), viemGetAddress(bAddr)],
      });
      if (!pairAddr || pairAddr === '0x0000000000000000000000000000000000000000') continue;
      const lower = pairAddr.toLowerCase();
      if (seenPairs.has(lower)) continue;
      seenPairs.add(lower);
      pairAddrs.push(pairAddr);
    } catch (e) {
      console.warn('[liquidityStore] factory getPair failed:', aAddr, bAddr, e?.message || String(e));
    }
  }
  
  // 2. Add already-imported LP addresses
  for (const lpAddr of importedLps) {
    if (!lpAddr) continue;
    try {
      const checksum = viemGetAddress(lpAddr);
      const lower = checksum.toLowerCase();
      if (seenPairs.has(lower)) continue;
      seenPairs.add(lower);
      pairAddrs.push(checksum);
    } catch (e) {}
  }
  
  // 3. Fetch each LP's balance and info in parallel
  const results = await Promise.all(
    pairAddrs.map(async (pairAddr) => {
      try {
        return await fetchSingleLpPosition(pairAddr, address);
      } catch (e) {
        return null;
      }
    })
  );
  
  for (const pos of results) {
    if (pos) out.push(pos);
  }
  
  return out;
}

export const useLiquidityStore = create(
  persist(
    (set, get) => ({
      positions: [],
      loadingPositions: false,
      lastPositionsUpdateAt: 0,
      currentUserAddr: null,
      positionsError: null,
      importedLps: [], // LP addresses manually imported by the user

  /**
   * Add an imported LP
   * @param {string} lpAddr
   */
  addImportedLp: (lpAddr) => {
    if (!lpAddr) return;
    const checksum = viemGetAddress(lpAddr);
    const { importedLps } = get();
    if (importedLps.some(a => a.toLowerCase() === checksum.toLowerCase())) return;
    set({ importedLps: [...importedLps, checksum] });
  },

  /**
   * Load user LP positions
   * @param {object} options
   * @param {boolean} [options.silent=false]
   * @param {string} options.userAddr
   */
  fetchPositions: async (options = {}) => {
    const { silent = false, userAddr } = options;
    if (!userAddr) {
      set({ positions: [], loadingPositions: false, currentUserAddr: null });
      return [];
    }
    if (!silent) set({ loadingPositions: true, positionsError: null });

    try {
      const { importedLps } = get();
      const out = await fetchPositionsForUser(userAddr, importedLps);
      set({
        positions: out,
        loadingPositions: false,
        lastPositionsUpdateAt: Date.now(),
        currentUserAddr: userAddr,
        positionsError: null,
      });
      return out;
    } catch (e) {
      console.error('[liquidityStore] fetchPositions failed', e);
      resetReadProvider(true);
      if (!silent) {
        set({ loadingPositions: false, positionsError: e });
      } else {
        set({ loadingPositions: false });
      }
      return null;
    }
  },

  // Called when opening liquidity page: skip reloading if cache not expired
  maybeRefreshPositions: (userAddr = null) => {
    const { loadingPositions, lastPositionsUpdateAt, currentUserAddr } = get();
    if (loadingPositions) return;
    if (!userAddr) {
      set({ positions: [], currentUserAddr: null });
      return;
    }
    const now = Date.now();
    const expired = now - lastPositionsUpdateAt > POSITIONS_CACHE_TTL;
    const addrChanged = currentUserAddr !== userAddr;
    if (lastPositionsUpdateAt === 0 || expired || addrChanged) {
      const silent = lastPositionsUpdateAt > 0 && !addrChanged;
      get().fetchPositions({ silent, userAddr });
    }
  },

  // Manual refresh
  refreshPositions: (userAddr = null) => {
    return get().fetchPositions({ silent: false, userAddr });
  },

  // Invalidate cache (called after adding/removing liquidity)
  invalidatePositions: () => {
    set({ lastPositionsUpdateAt: 0 });
  },

  // Clear (called when disconnecting wallet)
  clearPositions: () => {
    set({
      positions: [],
      loadingPositions: false,
      lastPositionsUpdateAt: 0,
      currentUserAddr: null,
      positionsError: null,
    });
  },
    }),
    {
      name: 'cfoswap-liquidity-store',
      // Only persist data and cache time, do not persist loading/error states
      partialize: (state) => ({
        positions: state.positions,
        lastPositionsUpdateAt: state.lastPositionsUpdateAt,
        currentUserAddr: state.currentUserAddr,
        importedLps: state.importedLps,
      }),
      version: 1,
    }
  )
);
