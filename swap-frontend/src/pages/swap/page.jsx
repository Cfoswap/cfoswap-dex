import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownUp, ChevronDown, AlertTriangle, Info, Loader2, Wallet, Zap } from 'lucide-react';
import { getAddress as viemGetAddress, formatUnits as viemFormatUnits, parseUnits as viemParseUnits, zeroAddress as viemZeroAddress, encodeFunctionData as viemEncodeFunctionData, parseAbi as viemParseAbi } from 'viem';
import { TOKENS, ROUTER_ABI, ROUTER_ADDRESS, WBNB_ADDRESS, USDT_ADDRESS, USDC_ADDRESS, DAI_ADDRESS, ERC20_ABI, PANCAKE_SWAP_ROUTER_V2, PANCAKE_SWAP_FACTORY_V2, PANCAKE_ROUTER_ABI, FACTORY_ABI, PAIR_ABI, MINING_POOL_FACTORY_ADDRESS, MINING_POOL_FACTORY_ABI, TX_DEADLINE_MINUTES, ETH_PLACEHOLDER, MODE_DIRECT } from '@/config/index.js';
import { formatBalance, calculatePriceImpact, calculateMinimumReceived, parseTokenAmount, fetchDecimals, sanitizeAmountInput, sanitizeSlippageInput, blockInvalidNumericKeys, resetReadProvider, viemReadContract, viemWriteContract, viemWaitForTransaction, VIEM_MAX_UINT256, buildCandidatePaths, getBestPathExactOutput, getBestQuoteExactInputMixed, encodeBaseRequest, buildExtraData, appendExtraData, deductPlatformFee, getRequiredInputAllowanceWei } from '@/utils/index.js';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import { usePrefsStore } from '@/store/prefsStore.js';
import { useMiningStore } from '@/store/miningStore.js';
import { getStoredReferrer, isValidReferrer } from '@/utils/referral.js';
import { computeSwapGas, countActivePools, FALLBACK_BASE_GAS, ASSUMED_POOL_COUNT_ON_ERROR } from '@/utils/swapGas.js';
import { tokenAddrById, decimalsById, addrToSymbol, resolveTokenById, tokenIconSrc } from '@/utils/tokens.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';

/* ====== Mining reward estimate (frontend constants mirroring contract INIT_STAGE1_RATE / INIT_STAGE2_RATE / INIT_STAGE1_CAP) ====== */
// rate = "USDT x 1e6 required per 1 CFO mined" (identical to the on-chain rate; the frontend estimate uses constants directly to avoid RPC failures)
const MINING_STAGE1_RATE_E6 = 150_000_000;   // 150 USDT / CFO
const MINING_STAGE2_RATE_E6 = 1_500_000_000; // 1500 USDT / CFO
const MINING_STAGE1_CAP_CFO = 10_000_000;    // phase1 total 10M CFO (aligned with miningStore defaults)
const MINING_MIN_VOLUME_USDT = 1;            // Contract MIN_VOLUME threshold
const E6 = 1_000_000;

/* ====== Four preset slippage values (percent; inside the store bps = percent * 100) ====== */
const PRESET_SLIP_PCT = [0.1, 0.5, 1, 3];
const PCT_TO_BPS = 100;

/* ====== Read provider is centralized in the shared utils ====== */
// Token id (built-in symbol / custom lowercase address) -> on-chain address conversion (BNB automatically maps to the WBNB address)
// extTokens receives walletStore.customTokens (a dictionary keyed by address)
function symToAddr(sym, extTokens = null) {
  return tokenAddrById(sym, extTokens);
}
// WBNB/BNB alias check
const _isBnbAliases = (s) => s === 'BNB' || s === 'WBNB';
// Address normalization (lowercase; null/undefined becomes an empty string)
const _norm = (a) => (a && typeof a === 'string') ? a.toLowerCase() : '';

/**
 * Pre-flight Simulation before signing: parse Pancake Router / ERC20 / Viem revert reasons
 * (original English text is long, includes Custom Error names / Chinese or garbled text) into exact-matching i18n keys,
 * ensuring that calling t(key) in showToast correctly displays translations for 6 languages.
 *
 * Returns: { i18nKey: string, detail?: string }
 */
function parsePancakeRevertReason(rawErr) {
  const errMsg = [
    rawErr?.message || '',
    rawErr?.cause?.message || '',
    rawErr?.details || '',
    typeof rawErr === 'string' ? rawErr : '',
  ].join(' | ');

  if (/INSUFFICIENT_OUTPUT_AMOUNT|insufficient[_\s-]*output|amount.*out.*min|insufficient.*output|output.*insufficient/i.test(errMsg)) {
    return { i18nKey: 'preflight_insufficient_output', detail: 'INSUFFICIENT_OUTPUT_AMOUNT' };
  }
  if (/EXPIRED|expired|deadline|expired.*deadline|deadline.*passed/i.test(errMsg)) {
    return { i18nKey: 'preflight_expired', detail: 'EXPIRED' };
  }
  if (/TRANSFER_FAILED|Pancake:\s*TRANSFER|transfer\s*failed|BEP20.*transfer|ERC20.*transfer|transfer.*fail|fail.*transfer/i.test(errMsg)) {
    return { i18nKey: 'preflight_transfer_failed', detail: 'TRANSFER_FAILED' };
  }
  if (/allowance|exceeds allowance|allow.*exceeded|approve.*required|insufficient.*allowance/i.test(errMsg)) {
    return { i18nKey: 'preflight_allowance', detail: 'ALLOWANCE_INSUFFICIENT' };
  }
  if (/balance|exceeds balance|insufficient.*balance|balance.*insufficient/i.test(errMsg)) {
    return { i18nKey: 'preflight_balance', detail: 'BALANCE_INSUFFICIENT' };
  }
  // User 4001 manual rejection → this simulate won't throw (since simulate bypasses wallet), but handled here to prevent confusion
  if (/rejected|user rejected|denied|reject|deny/i.test(errMsg)) {
    return { i18nKey: 'user_rejected_sig', detail: 'USER_REJECTED' };
  }
  return { i18nKey: 'preflight_unknown_fail', detail: errMsg.slice(0, 200) };
}

// ====== Runtime decimals: prefer decimalsOverride read from chain (persisted); fallback to the ERC20 standard of 18 ======
// Trust only on-chain values; never read hardcoded values from config (the decimals field has been removed from config).
function getTokenDecimals(sym, extTokens = null) {
  return decimalsById(sym, extTokens, useWalletStore.getState().decimalsOverride);
}
// Read Pair.getReserves on-chain - viem version (automatic multi-RPC fallback)
const _reservesCache = new Map();
const _runningReservePromises = new Map();
async function readPairReserves(aSym, bSym, force = false, extTokens = null) {
  const a = _isBnbAliases(aSym) ? 'WBNB' : aSym;
  const b = _isBnbAliases(bSym) ? 'WBNB' : bSym;
  if (a === b) return null;
  const aAddr = symToAddr(a, extTokens);
  const bAddr = symToAddr(b, extTokens);
  if (!aAddr || !bAddr) return null;
  const [ka, kb] = aAddr.toLowerCase() < bAddr.toLowerCase() ? [aAddr, bAddr] : [bAddr, aAddr];
  const key = `${ka}|${kb}`;
  if (!force && _reservesCache.has(key)) return _reservesCache.get(key);
  if (!force && _runningReservePromises.has(key)) return _runningReservePromises.get(key);
  const factoryAddr = viemGetAddress(PANCAKE_SWAP_FACTORY_V2);
  const p = (async () => {
    try {
      // Read getPair via viem
      let pairAddr;
      try {
        pairAddr = await viemReadContract({
          address: factoryAddr,
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [viemGetAddress(aAddr), viemGetAddress(bAddr)],
        });
      } catch (e) {
        console.warn('[readPairReserves][viem] getPair failed:', e);
        return null;
      }
      if (!pairAddr || pairAddr === viemZeroAddress) return null;

      // Read token0, token1 and reserves in parallel
      const pairAddrChecksum = viemGetAddress(pairAddr);
      let token0Addr, token1Addr, reserves;
      try {
        [token0Addr, token1Addr, reserves] = await Promise.all([
          viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token0' }).catch(() => null),
          viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token1' }).catch(() => null),
          viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'getReserves' }).catch(() => null),
        ]);
      } catch (e) {
        console.warn('[readPairReserves][viem] read pair data failed:', e);
        return null;
      }
      if (!token0Addr || !token1Addr || !reserves) return null;

      // Map the reserve order to aSym/bSym
      const aNorm = _isBnbAliases(aSym) ? 'WBNB' : aSym;
      const bNorm = _isBnbAliases(bSym) ? 'WBNB' : bSym;
      const a2 = symToAddr(aNorm, extTokens);
      const b2 = symToAddr(bNorm, extTokens);
      const t0Low = token0Addr?.toLowerCase?.();
      const t1Low = token1Addr?.toLowerCase?.();
      let reserveA_raw, reserveB_raw;
      if (a2.toLowerCase() === t0Low && b2.toLowerCase() === t1Low) {
        reserveA_raw = reserves[0];
        reserveB_raw = reserves[1];
      } else if (a2.toLowerCase() === t1Low && b2.toLowerCase() === t0Low) {
        reserveA_raw = reserves[1];
        reserveB_raw = reserves[0];
      } else {
        return null;
      }
      const decA = getTokenDecimals(aNorm, extTokens);
      const decB = getTokenDecimals(bNorm, extTokens);
      const out = {
        pair: pairAddr,
        aSym: aNorm,
        bSym: bNorm,
        reserveA: viemFormatUnits(reserveA_raw, decA),
        reserveB: viemFormatUnits(reserveB_raw, decB),
      };
      _reservesCache.set(key, out);
      return out;
    } finally {
      _runningReservePromises.delete(key);
    }
  })();
  _runningReservePromises.set(key, p);
  try {
    return await p;
  } catch (e) {
    console.error('[readPairReserves][viem] error:', e?.message || String(e));
    return null;
  }
}
// Dynamically fetch all other token symbols (built-in TOKENS + custom tokens), no hardcoded pairs, auto-query all pools with liquidity
function getAllOtherTokenSymbols(fromSym, extTokens = null) {
  const f = _isBnbAliases(fromSym) ? 'WBNB' : fromSym;
  const merged = { ...TOKENS, ...(extTokens || {}) };
  const result = [];
  for (const sym of Object.keys(merged)) {
    if (sym === 'WBNB') continue;
    const sNorm = _isBnbAliases(sym) ? 'WBNB' : sym;
    if (sNorm === f) continue;
    result.push(sym);
  }
  return result;
}


/* ====== Compact-number formatter: 1,000 -> 1.0K / 1,000,000 -> 1.0M / 1e9 -> 1.0B / 1e12 -> 1.0T ====== */
function formatCompact(numStr) {
  const n = typeof numStr === 'number' ? numStr : parseFloat(String(numStr || '0'));
  if (!isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
  if (abs >= 1e9)  return sign + (abs / 1e9 ).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6)  return sign + (abs / 1e6 ).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3)  return sign + (abs / 1e3 ).toFixed(1).replace(/\.0$/, '') + 'K';
  return sign + abs.toFixed(2).replace(/\.00$/, '');
}

/* Dynamically check all tokens and show only pairs that actually have liquidity (LPs whose Pair cannot be found are hidden) */
// id (built-in symbol / custom lowercase address) -> display symbol (WBNB is displayed as BNB; unknown ids show a truncated address)
function idToDisplay(id, extTokens = null) {
  if (_isBnbAliases(id)) return 'BNB';
  const tok = resolveTokenById(id, extTokens);
  if (tok?.symbol) return tok.symbol;
  if (typeof id === 'string' && id.startsWith('0x')) return `${id.slice(0, 6)}...${id.slice(-4)}`;
  return id;
}
function getOtherLpsList(fromSym, realPairs = {}, extTokens = null) {
  const f = _isBnbAliases(fromSym) ? 'WBNB' : fromSym;
  const order = ['WBNB', 'BNB', 'USDT', 'CFO', 'ETH', 'BTCB', 'CAKE', 'USDC', 'DAI', 'ARK', 'PRO'];
  const candidates = getAllOtherTokenSymbols(fromSym, extTokens);
  const res = [];
  for (const otherSym of candidates) {
    const otherNorm = _isBnbAliases(otherSym) ? 'WBNB' : otherSym;
    // Key generation exactly matching the dict: f and otherNorm concatenated in alphabetical order, no flip logic
    const realKey = f < otherNorm ? `${f}|${otherNorm}` : `${otherNorm}|${f}`;
    const pair = realPairs[realKey] || null;
    if (!pair) continue;
    // Determine reserve order: pair.aSym/pair.bSym match the order passed to readPairReserves (f, otherNorm)
    const myAmt = (pair.aSym === f) ? pair.reserveA : pair.reserveB;
    const otherAmt = (pair.aSym === f) ? pair.reserveB : pair.reserveA;
    const displayFrom = idToDisplay(f, extTokens);
    const displayOther = idToDisplay(otherNorm, extTokens);
    res.push({
      name: `${displayFrom}/${displayOther}`,
      aCompact: formatCompact(myAmt || '0'),
      bCompact: formatCompact(otherAmt || '0'),
      sortKey: otherNorm,
    });
  }
  // Sort by preset order
  res.sort((x, y) => {
    const xi = order.indexOf(x.sortKey === 'BNB' ? 'WBNB' : x.sortKey);
    const yi = order.indexOf(y.sortKey === 'BNB' ? 'WBNB' : y.sortKey);
    return (xi >= 0 ? xi : 999) - (yi >= 0 ? yi : 999);
  });
  return res;
}

// Pre-parse router ABI from human-readable strings into JSON-Abi form.
// Viem's encodeFunctionData / readContract accept string arrays, but when any
// entry carries external/view/payable qualifiers + nested tuples, some internal
// branches fall through to `'name' in entry` against a raw string, which throws
// "Cannot use 'in' operator to search for 'name' in function ... external ...".
// Pre-parsing via viem.parseAbi guarantees an Abi-compatible array of objects.
const _ROUTER_ABI_JSON = (() => {
  try {
    if (typeof viemParseAbi === 'function') {
      // parseAbi expects string[] of human-readable abi items (same as ROUTER_ABI)
      return viemParseAbi(ROUTER_ABI);
    }
  } catch (_) {}
  // fallback: return original (if parseAbi unavailable in env, will fallback to string path)
  return ROUTER_ABI;
})();

export default function SwapPage() {
  const { t } = useTranslation();
  const { address, connected, bnbBalance, cfoBalance, customTokens, tokenBalances, refreshBalances, decimalsOverride, setTokenDecimals } = useWalletStore();
  const { showWalletModal, showSlippageDrawer, slippageBps, setSlippageBps, txDeadlineMinutes, setTxDeadlineMinutes, showToast, openTokenSelectModal, closeTokenSelectModal } = useUiStore();

  /* ====== Custom slippage input box (shows the numeric value when it is not a preset; empty string when a preset is selected) ====== */
  const currentSlippagePct = (slippageBps / PCT_TO_BPS).toFixed(2).replace(/\.?0+$/, '');
  const isPresetSlippage = PRESET_SLIP_PCT.some(p => Math.abs(p * PCT_TO_BPS - slippageBps) < 0.0001);
  const [customSlipInput, setCustomSlipInput] = useState(isPresetSlippage ? '' : currentSlippagePct);

  /* ====== Preset slippage click / custom change (logic originally in SlippageInlinePanel, moved into the main component) ====== */
  function handlePresetSlippage(pct) {
    setSlippageBps(Math.round(pct * PCT_TO_BPS));
    setCustomSlipInput('');
  }
  function handleCustomSlippageChange(e) {
    const raw = sanitizeSlippageInput(e.target.value);
    setCustomSlipInput(raw);
    const num = parseFloat(raw);
    if (!isNaN(num) && num > 0 && num <= 50) {
      setSlippageBps(Math.round(num * PCT_TO_BPS));
    }
  }
  const slipPctForWarn = slippageBps / PCT_TO_BPS;
  const slippageShowWarn = (slipPctForWarn > 5 || slipPctForWarn < 0.1) && slipPctForWarn > 0;

  const { swapPair, setSwapPair } = usePrefsStore();
  // ⭐ Mining reward estimate: prefer the phase data already cached in miningStore (avoids repeated RPC queries)
  const { phase1Produced, phase1Cap, fetchGlobal: fetchMiningGlobal } = useMiningStore();
  const [fromToken, setFromToken] = useState(swapPair?.from || 'BNB');
  const [toToken, setToToken] = useState(swapPair?.to || 'USDT');
  const [fromAmount, setFromAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [loadingApprove, setLoadingApprove] = useState(false);
  const [loadingSwap, setLoadingSwap] = useState(false);
  const [fromApproved, setFromApproved] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  // ====== New DexRouter specifics: platformFeeBp (private in the contract with no getter; use the contract default of 15bp) / bestRoute (quote engine result) ======
  const platformFeeBp = 15n;
  const [bestRoute, setBestRoute] = useState(null); // Mixed V2/V3/DAG quote result
  const [routerPaused, setRouterPaused] = useState(false);

  // ====== Real pair data (displayed inside the From/To cards + real data for Other Pools) ======
  // currentPairReserves: { aSym: original reserveAString, bSym: ..., pair: '0x...' }
  const [currentPairReserves, setCurrentPairReserves] = useState(null);
  // otherPairsReal: { "BNB|CFO": { ...readPairReserves out } }
  const [otherPairsReal, setOtherPairsReal] = useState({});
  // quoteSource: indicates that the quote used the real getAmountsOut (so the user can tell even after a mock fallback)
  const [quoteSource, setQuoteSource] = useState(''); // 'pancake' / 'mock-fallback' / ''
  // usedRoute: the actual execution path; the address array is converted to token symbols and shown to the user
  const [usedRoute, setUsedRoute] = useState([]);
  // ====== C. Prevent circular two-way sync: direction='from' (from changed -> compute to) or 'to' (to changed -> compute from); null = initialized ======
  const [direction, setDirection] = useState(null);
  // loadingInverse: while the user manually edits To and From is back-calculated, the From card shows a loading state
  const [loadingInverse, setLoadingInverse] = useState(false);

  // ====== P0 #3: Price Impact hard guard — ≥3% requires user confirmation, ≥10% outright blocked ======
  const [piConfirmOpen, setPiConfirmOpen] = useState(false);
  const [piConfirmAccepted, setPiConfirmAccepted] = useState(false);
  // Reset the "I accept risk" flag whenever pair / amount changes
  useEffect(() => {
    setPiConfirmAccepted(false);
    setPiConfirmOpen(false);
  }, [fromToken, toToken, fromAmount]);

  // ====== On page mount: load mining global data once in the background (refreshes the cache used for phase detection) ======
  useEffect(() => {
    try { fetchMiningGlobal({ silent: true }); } catch (e) {}
  }, [fetchMiningGlobal]);

  // ====== ✅ New DexRouter: read isPaused once on mount and on address change (cached; not re-queried during quoting) ======
  //   Note: platformFeeBp is private in the contract with no getter; the frontend uniformly uses the constant default of 15bp
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pd = await viemReadContract({ address: ROUTER_ADDRESS, abi: _ROUTER_ABI_JSON, functionName: 'isPaused' }).catch(() => false);
        if (!alive) return;
        setRouterPaused(Boolean(pd));
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [ROUTER_ADDRESS]);

  // Helper: address -> token display name (WBNB is automatically shown as BNB; unknown addresses are shown truncated)
  const addrToSym = (addr, extTokens = null) => addrToSymbol(addr, extTokens);

  const slippagePercent = (slippageBps / 100).toFixed(2);

  const fromTokenData = resolveTokenById(fromToken, customTokens);
  const toTokenData = resolveTokenById(toToken, customTokens);
  // Display symbol (custom token ids are lowercase addresses, so always use the token object's symbol for display)
  const fromSymbol = fromTokenData?.symbol || fromToken;
  const toSymbol = toTokenData?.symbol || toToken;

  const isFromNative = fromToken === 'BNB';
  const isToNative = toToken === 'BNB';
  const isCFOInvolved = fromToken === 'CFO' || toToken === 'CFO';

  const fromBalance = useMemo(() => {
    if (fromToken === 'BNB') return bnbBalance;
    if (fromToken === 'CFO') return cfoBalance;
    return tokenBalances[fromToken] || '0';
  }, [fromToken, bnbBalance, cfoBalance, tokenBalances]);

  // ====== ✅ ⑤ To card real-balance completion (same rules as fromBalance) ======
  const toBalance = useMemo(() => {
    if (toToken === 'BNB') return bnbBalance;
    if (toToken === 'CFO') return cfoBalance;
    return tokenBalances[toToken] || '0';
  }, [toToken, bnbBalance, cfoBalance, tokenBalances]);

  const exchangeRate = useMemo(() => {
    if (!fromAmount || !toAmount || parseFloat(fromAmount) === 0) return null;
    return (parseFloat(toAmount) / parseFloat(fromAmount)).toFixed(6);
  }, [fromAmount, toAmount]);

  // ====== Price Impact: computed from the real From/To direct-pair reserves. If reserves cannot be fetched, return "--" instead of showing a fake 0% ======
  const priceImpact = useMemo(() => {
    if (!fromAmount || !toAmount) return '--';
    const resA = currentPairReserves?.aSymReserve;
    const resB = currentPairReserves?.bSymReserve;
    if (resA && resB && parseFloat(resA) > 0 && parseFloat(resB) > 0) {
      const raw = calculatePriceImpact(fromAmount, toAmount, resA, resB);
      if (!isFinite(raw)) return '--';
      return raw.toFixed(2);
    }
    return '--';
  }, [fromAmount, toAmount, currentPairReserves]);

  const minReceived = useMemo(() => {
    if (!toAmount) return '0';
    return calculateMinimumReceived(toAmount, slippagePercent);
  }, [toAmount, slippagePercent]);

  // ====== Sync from the recent trading pair / external state: update local from/to when swapPair changes ======
  useEffect(() => {
    if (swapPair?.from && swapPair?.to) {
      setFromToken(swapPair.from);
      setToToken(swapPair.to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapPair?.from, swapPair?.to]);

  // ====== Read decimals from chain at runtime: when a token is selected, fetch asynchronously and write to decimalsOverride (persisted) ======
  useEffect(() => {
    const addrs = [fromTokenData?.address, toTokenData?.address]
      .filter(a => a && !/^0x0+$/i.test(a)); // Skip native BNB (zero address)
    if (addrs.length === 0) return;
    let cancelled = false;
    (async () => {
      await Promise.all(addrs.map(async (a) => {
        try {
          const d = await fetchDecimals(a);
          if (!cancelled) setTokenDecimals(a, d);
        } catch (e) {
          console.warn('[decimals] fetch failed:', a, e?.message || String(e));
        }
      }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromToken, toToken, fromTokenData?.address, toTokenData?.address]);

  // ====== Mining reward prediction: real on-chain rate (MINING contract dynamic stage1/stage2 switch) + real token USDT price ======
  const [miningRewardEst, setMiningRewardEst] = useState('0');
  useEffect(() => {
    let cancelled = false;
    async function loadMiningEst() {
      if (!fromAmount || parseFloat(fromAmount) <= 0 || !fromTokenData) {
        if (!cancelled) setMiningRewardEst('0');
        return;
      }
      try {
        // ⭐ Mining eligibility: the contract only checks whether path[0]/path[end] are stablecoins; intermediate bridge tokens are ignored.
        // Compare by address (more reliable than symbol strings): the from/to token address must hit USDT_ADDRESS/USDC_ADDRESS/DAI_ADDRESS to count as a stablecoin
        const fSym = _isBnbAliases(fromToken) ? 'WBNB' : fromToken;
        const tSym = _isBnbAliases(toToken)   ? 'WBNB' : toToken;
        const fAddrRaw = (fSym === 'WBNB') ? WBNB_ADDRESS : (TOKENS[fSym]?.address || (fromTokenData?.address) || (fromTokenData?.tokenAddress) || (fromTokenData?.contractAddress) || (fromTokenData?.addr));
        const tAddrRaw = (tSym === 'WBNB') ? WBNB_ADDRESS : (TOKENS[tSym]?.address || (toTokenData?.address) || (toTokenData?.tokenAddress) || (toTokenData?.contractAddress) || (toTokenData?.addr));
        const fAddr = fAddrRaw ? viemGetAddress(fAddrRaw).toLowerCase() : null;
        const tAddr = tAddrRaw ? viemGetAddress(tAddrRaw).toLowerCase() : null;
        // ⭐ The stablecoin address set uniformly uses viemGetAddress + toLowerCase (avoids checksum mismatches)
        const STABLE_ADDRS = new Set([
          USDT_ADDRESS ? viemGetAddress(USDT_ADDRESS).toLowerCase() : '',
          USDC_ADDRESS ? viemGetAddress(USDC_ADDRESS).toLowerCase() : '',
          DAI_ADDRESS  ? viemGetAddress(DAI_ADDRESS).toLowerCase()  : '',
        ].filter(Boolean));
        const firstIsStable = fAddr ? STABLE_ADDRS.has(fAddr) : false;
        const lastIsStable  = tAddr ? STABLE_ADDRS.has(tAddr) : false;
        if (!firstIsStable && !lastIsStable) {
          if (!cancelled) setMiningRewardEst('0');
          return;
        }
        // 1) Real token USDT price (Pancake Router getAmountsOut; no fake prices from deep fallbacks)
        let usdtPrice = null;
        // ⭐ When any stablecoin (USDT/USDC/DAI) is on the from side, treat it directly at a price of 1 USDT (avoids route query failures)
        if (firstIsStable && fAddr && STABLE_ADDRS.has(fAddr)) {
          usdtPrice = 1;
        } else {
          const tok = TOKENS[fSym];
          const addr = tok?.address || fAddrRaw;
          if (addr) {
            const routerAddr = viemGetAddress(PANCAKE_SWAP_ROUTER_V2);
            const inWei = parseTokenAmount('1', getTokenDecimals(fSym, customTokens));
            for (const p of [[addr, USDT_ADDRESS], [addr, WBNB_ADDRESS, USDT_ADDRESS]]) {
              try {
                const out = await viemReadContract({
                  address: routerAddr,
                  abi: PANCAKE_ROUTER_ABI,
                  functionName: 'getAmountsOut',
                  args: [inWei, p.map(a => viemGetAddress(a))],
                });
                usdtPrice = parseFloat(viemFormatUnits(out[out.length - 1], 18));
                break;
              } catch (e) {
                continue;
              }
            }
          }
        }
        if (usdtPrice == null || usdtPrice <= 0) {
          if (!cancelled) setMiningRewardEst('0');
          return;
        }
        const volUSDT = parseFloat(fromAmount) * usdtPrice;
        if (volUSDT < MINING_MIN_VOLUME_USDT) {
          // ⭐ Contract MIN_VOLUME: volume below 1 USDT yields zero; the frontend mirrors this by not showing mining rewards
          if (!cancelled) setMiningRewardEst('0');
          return;
        }
        // 2) Phase determination (computed on the frontend in sync: prefer cached miningStore values, fall back to frontend constants)
        // phase1Produced / phase1Cap are both stored as "CFO amount (formatted with 18 decimals)" (see miningStore L57-L61)
        const produced1 = (typeof phase1Produced === 'number' && !isNaN(phase1Produced)) ? phase1Produced : 0;
        const cap1 = (typeof phase1Cap === 'number' && !isNaN(phase1Cap) && phase1Cap > 0) ? phase1Cap : MINING_STAGE1_CAP_CFO;
        const inStage2 = produced1 >= cap1;
        // rate: USDT required per 1 CFO mined (computed directly from frontend constants, no longer dependent on RPC)
        const usdtPerCfo = inStage2
          ? (MINING_STAGE2_RATE_E6 / E6)
          : (MINING_STAGE1_RATE_E6 / E6);
        if (!cancelled && usdtPerCfo > 0) {
          setMiningRewardEst((volUSDT / usdtPerCfo).toFixed(4));
        } else if (!cancelled) {
          setMiningRewardEst('0');
        }
      } catch (e) {
        console.warn('[swap] failed to read the real mining rate:', e?.message || e);
        if (!cancelled) setMiningRewardEst('0');
      }
    }
    loadMiningEst();
    return () => {
      cancelled = true;
    };
  }, [fromAmount, fromToken, fromTokenData, toToken, toTokenData, phase1Produced, phase1Cap]);

  const priceImpactWarning = priceImpact !== '--' && parseFloat(priceImpact) >= 5;

  // ====== ① Load the current trading pair reserves + ② other LP reserves for the From token ======
  // force=true: bypass the readPairReserves cache and force a re-read of the latest on-chain data (use right after reserves change, e.g. after a successful swap)
  const loadReserves = useCallback(async (force = false) => {
    const fNorm = _isBnbAliases(fromToken) ? 'WBNB' : fromToken;
    const tNorm = _isBnbAliases(toToken)   ? 'WBNB' : toToken;
    try {
      if (fNorm !== tNorm) {
        const r = await readPairReserves(fromToken, toToken, force, customTokens);
        if (r) {
          let aRes, bRes;
          if (r.aSym === fNorm && r.bSym === tNorm) { aRes = r.reserveA; bRes = r.reserveB; }
          else if (r.aSym === tNorm && r.bSym === fNorm) { aRes = r.reserveB; bRes = r.reserveA; }
          else { aRes = r.reserveA; bRes = r.reserveB; }
          setCurrentPairReserves({ ...r, aSymReserve: aRes, bSymReserve: bRes, fromSym: fNorm, toSym: tNorm });
        } else {
          setCurrentPairReserves({ fromSym: fNorm, toSym: tNorm, aSymReserve: null, bSymReserve: null });
        }
      } else {
        setCurrentPairReserves({ fromSym: fNorm, toSym: tNorm, aSymReserve: null, bSymReserve: null });
      }
      const others = getAllOtherTokenSymbols(fromToken, customTokens)
        .map(s => _isBnbAliases(s) ? 'WBNB' : s);
      const dict = {};
      await Promise.all(others.map(async (other) => {
        try {
          const r = await readPairReserves(fNorm, other, force, customTokens);
          if (!r) return;
          const aNorm = r.aSym, bNorm = r.bSym;
          const k = aNorm < bNorm ? `${aNorm}|${bNorm}` : `${bNorm}|${aNorm}`;
          dict[k] = r;
        } catch (e) {
          console.error('[OtherLP] readPairReserves failed:', e?.message || String(e));
        }
      }));
      setOtherPairsReal(dict);
    } catch (e) {
      console.error('[loadReserves] failed:', e?.message || String(e));
      setCurrentPairReserves(null);
      setOtherPairsReal({});
      try { showToast && showToast('warning', 'chain_reserves_load_failed'); } catch {}
    }
  }, [fromToken, toToken, decimalsOverride, customTokens]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadReserves(false);
      if (cancelled) {
        // Unmount mid-request: already did setState before noticing; React 18+ tolerates this safely.
      }
    })();
    return () => { cancelled = true; };
  }, [loadReserves]);

  useEffect(() => {
    // While the user is editing To (direction='to'), prevent back-and-forth bouncing: after fromAmount is back-calculated and set, simulateQuote would otherwise recompute To
    if (direction === 'to') return;
    if (!fromAmount || parseFloat(fromAmount) === 0) {
      setToAmount('');
      return;
    }
    const timer = setTimeout(() => {
      setDirection('from');
      simulateQuote();
    }, 300);
    return () => clearTimeout(timer);
  }, [fromAmount, fromToken, toToken, direction, decimalsOverride]);

  // ====== C. Manual To change sync: back-calculate From (runs when direction==='to'), avoiding loops with simulateQuote ======
  useEffect(() => {
    if (direction !== 'to') return;
    if (!toAmount || parseFloat(toAmount) === 0) {
      setFromAmount('');
      return;
    }
    const timer = setTimeout(() => {
      simulateQuoteInverse();
    }, 350);
    return () => clearTimeout(timer);
  }, [toAmount, fromToken, toToken, direction, decimalsOverride]);

  // ====== ③ Real rate Quote: Swap Routes shared utility concurrent quoting, selects path with maximum output amount ======
  // 1) buildCandidatePaths constructs candidate paths (auto-dedupe/self-loop filtering, includes 3-hop paths)
  // 2) getBestPathExactInput uses Promise.allSettled to query getAmountsOut for all paths concurrently,
  //    then selects the path with max net output after deducting hop-count gas penalty weight (same early Pancake V2 approach)
  async function simulateQuote() {
    setLoadingQuote(true);
    setQuoteSource('');
    try {
      const fromTok = _isBnbAliases(fromToken) ? 'WBNB' : fromToken;
      const toTok = _isBnbAliases(toToken)   ? 'WBNB' : toToken;
      if (fromTok === toTok) {
        setToAmount(fromAmount);
        setQuoteSource('same');
        setUsedRoute([]);
        checkApproval();
        return;
      }
      const fAddr = symToAddr(fromTok, customTokens);
      const tAddr = symToAddr(toTok, customTokens);
      if (!fAddr || !tAddr) {
        setToAmount('');
        setQuoteSource('fail-no-token');
        setUsedRoute([]);
        try { showToast && showToast('warning', 'unknown_token_no_quote'); } catch {}
        checkApproval();
        return;
      }
      const decIn  = getTokenDecimals(fromTok, customTokens);
      const decOut = getTokenDecimals(toTok, customTokens);
      const amountInWei = parseTokenAmount(fromAmount || '0', decIn);
      if (amountInWei <= 0n) {
        console.warn('[SimQ] skip: amountInWei <= 0 (parse result is not positive)');
        setToAmount('');
        checkApproval();
        return;
      }

      // ① New unified quote: mixed V2 + V3 (getBestQuoteExactInputMixed -> picks best.bestOutWei)
      //   Path construction and V3 fee-tier enumeration already run concurrently inside the util; here we only consume the result
      const usdtAddr = symToAddr('USDT', customTokens);
      const busdAddr = symToAddr('BUSD', customTokens);
      const routeResult = await getBestQuoteExactInputMixed(amountInWei, fAddr, tAddr, {
        wbnbAddr: WBNB_ADDRESS,
        usdtAddr: usdtAddr || undefined,
        busdAddr: busdAddr || undefined,
      });

      if (routeResult.ok && routeResult.best && routeResult.bestOutWei) {
        const rawOutWei = routeResult.bestOutWei;
        // Deduct the platform fee (15bp on-chain default; use the new value if the owner has changed it)
        const netOutWei = deductPlatformFee(rawOutWei, platformFeeBp);
        const outStr = viemFormatUnits(netOutWei, decOut);
        const outPretty = (parseFloat(outStr) || 0).toFixed(6);
        setToAmount(outPretty);
        setQuoteSource(
          routeResult.best.type === 'v3-single' ? 'pancake-v3'
            : (routeResult.best.type === 'dag-multi' || routeResult.best.type === 'v2-multi') ? 'pancake-multi'
            : 'pancake',
        );
        // usedRoute is for display only (it does not affect execution; execution takes best.hops)
        setUsedRoute(routeResult.best.hops.map(h => addrToSym(h.to, customTokens)).length
          ? [addrToSym(fAddr, customTokens), ...routeResult.best.hops.map(h => addrToSym(h.to, customTokens))]
          : []);
        setBestRoute(routeResult.best);
        checkApproval();
        return;
      }
      // ============== All routes failed: classified readable error prompts ==============
      setToAmount('');
      setQuoteSource('fail-no-liquidity');
      setUsedRoute([]);
      setBestRoute(null);
      resetReadProvider(true);
      try {
        const errMsg = routeResult.firstErrMsg || '';
        if (/network|timeout|fetch|ECONN|rpc/i.test(errMsg)) {
          showToast && showToast('warning', 'rpc_node_down_switch');
        } else {
          try {
            const factoryAddr = viemGetAddress(PANCAKE_SWAP_FACTORY_V2);
            const hasDirect = await viemReadContract({
              address: factoryAddr,
              abi: FACTORY_ABI,
              functionName: 'getPair',
              args: [viemGetAddress(fAddr), viemGetAddress(tAddr)],
            }).catch(() => viemZeroAddress);
            if (!hasDirect || hasDirect === viemZeroAddress) {
              showToast && showToast('warning', 'no_liquidity_no_quote');
            } else {
              showToast && showToast('warning', 'no_liquidity_no_quote');
            }
          } catch {
            showToast && showToast('warning', 'no_liquidity_no_quote');
          }
        }
      } catch {}
      console.warn('[Quote] all routes failed: no candidate pool / no live rate', {
        fromTok, toTok,
        firstErrMsg: routeResult.firstErrMsg,
      });
      checkApproval();
    } catch (e) {
      console.error('quote failed', e);
      resetReadProvider(true);
      setToAmount('');
      setQuoteSource('fail-exception');
      setUsedRoute([]);
      try { showToast && showToast('warning', 'chain_query_failed'); } catch {}
    } finally {
      setLoadingQuote(false);
    }
  }


  // ====== C. Reverse quote (user edits To → back-calculate From): shared util parallel queries all routes, picks min input amount ======
  async function simulateQuoteInverse() {
    setLoadingInverse(true);
    setQuoteSource('');
    try {
      const fromTok = _isBnbAliases(fromToken) ? 'WBNB' : fromToken;
      const toTok = _isBnbAliases(toToken)   ? 'WBNB' : toToken;
      if (fromTok === toTok) {
        setFromAmount(toAmount);
        setQuoteSource('same');
        setUsedRoute([]);
        checkApproval();
        return;
      }
      const fAddr = symToAddr(fromTok, customTokens);
      const tAddr = symToAddr(toTok, customTokens);
      if (!fAddr || !tAddr) {
        setFromAmount('');
        setQuoteSource('fail-no-token');
        setUsedRoute([]);
        try { showToast && showToast('warning', 'unknown_token_no_quote'); } catch {}
        checkApproval();
        return;
      }
      const decIn  = getTokenDecimals(fromTok, customTokens);
      const decOut = getTokenDecimals(toTok, customTokens);
      const amountOutWei = parseTokenAmount(toAmount || '0', decOut);
      if (amountOutWei <= 0n) {
        setFromAmount('');
        setUsedRoute([]);
        checkApproval();
        return;
      }

      // ① Construct candidate paths (same public function + same order as forward direction for consistency)
      const usdtAddrInv = symToAddr('USDT', customTokens);
      const busdAddrInv = symToAddr('BUSD', customTokens);
      const pathAddrsList = buildCandidatePaths(fAddr, tAddr, {
        wbnbAddr: WBNB_ADDRESS,
        usdtAddr: usdtAddrInv || undefined,
        busdAddr: busdAddrInv || undefined,
        includeTripleHops: true,
      });
      if (pathAddrsList.length === 0) {
        setFromAmount('');
        setQuoteSource('fail-no-liquidity');
        setUsedRoute([]);
        try { showToast && showToast('warning', 'no_liquidity_no_quote'); } catch {}
        checkApproval();
        return;
      }

      // ② Concurrent full-path query getAmountsIn → select minimum input
      const invResult = await getBestPathExactOutput(amountOutWei, pathAddrsList, PANCAKE_SWAP_ROUTER_V2);

      if (invResult.ok && invResult.bestPath && invResult.bestInWei != null) {
        const inWei = invResult.bestInWei;
        const inStr = viemFormatUnits(inWei, decIn);
        const inPretty = (parseFloat(inStr) || 0).toFixed(6);
        setFromAmount(inPretty);
        setQuoteSource('pancake-inv');
        setUsedRoute(invResult.bestPath.map(a => addrToSym(a, customTokens)));
        checkApproval();
        return;
      }
      // All paths failed → readable error prompt
      setFromAmount('');
      setQuoteSource('fail-no-liquidity');
      setUsedRoute([]);
      resetReadProvider(true);
      try {
        const errMsg = invResult.firstErrMsg || '';
        if (/network|timeout|fetch|ECONN|rpc/i.test(errMsg)) {
          showToast && showToast('warning', 'rpc_node_down_switch');
        } else {
          showToast && showToast('warning', 'no_liquidity_no_quote');
        }
      } catch {}
      console.warn('[QuoteInverse] all routes failed: no candidate pool / no live rate', {
        fromTok, toTok,
        firstErrMsg: invResult.firstErrMsg,
        totalCandidates: pathAddrsList.length,
      });
      checkApproval();
    } catch (e) {
      console.error('quote inverse failed', e);
      resetReadProvider(true);
      setFromAmount('');
      setQuoteSource('fail-exception');
      setUsedRoute([]);
      try { showToast && showToast('warning', 'chain_query_failed'); } catch {}
    } finally {
      setLoadingInverse(false);
    }
  }


  // ====== C. Manual To change -> set direction='to' + setToAmount (the useEffect above -> simulateQuoteInverse back-calculates From) ======
  function handleToAmountChange(val) {
    setDirection('to');
    setToAmount(val);
  }

  // ====== B. Manual From card change -> set direction='from' + setFromAmount (the debounce useEffect launches simulateQuote after 300ms)
  // Important: if direction is not explicitly reset to 'from' here, the direction='to' set when the To card was last edited remains,
  //       and the "if (direction === 'to') return;" at the top of the debounce useEffect fires, so the timer is never set and To is never converted.
  function handleFromAmountChange(val) {
    setDirection('from');
    setFromAmount(val);
  }

  // ====== B. From card 25%/50%/75%/MAX shortcut buttons: MAX reserves 0.0005 BNB for gas (avoids transfer failures on native swaps) ======
  function handlePickFromPercent(pctKey) {
    const bal = parseFloat(fromBalance || '0');
    if (!bal || bal <= 0) return;
    let pct = 0;
    if (pctKey === '25') pct = 0.25;
    else if (pctKey === '50') pct = 0.5;
    else if (pctKey === '75') pct = 0.75;
    else if (pctKey === 'max') pct = 1;
    let raw = bal * pct;
    // MAX: BNB reserve 0.0005 for gas; ERC20 reserve 0.5% to avoid insufficient balance for signing due to fees/slippage
    if (pctKey === 'max' && fromToken === 'BNB') {
      raw = Math.max(0, bal - 0.0005);
    } else if (pctKey === 'max' && !isFromNative) {
      raw = raw * 0.995;
    }
    if (raw <= 0) return;
    const dec = getTokenDecimals(fromToken, customTokens);
    const pretty = Number(raw.toFixed(dec)).toString();
    // Percent shortcut overrides user intent — treat it as editing the From card (reset direction)
    // so debounce effect picks up the change and requotes the To side.
    setDirection('from');
    setFromAmount(pretty);
  }

  async function checkApproval() {
    if (isFromNative) {
      setFromApproved(true);
      return;
    }
    if (!fromTokenData) return;
    // BY_INVEST mode: the approval target is the ROUTER (first transferFrom(user->router), then the router does transfer(router->pair))
    try {
      const amtWei = parseTokenAmount(fromAmount || '0', getTokenDecimals(fromToken, customTokens));
      const _spender = viemGetAddress(ROUTER_ADDRESS);
      const _owner = viemGetAddress(address);
      const _token = viemGetAddress(fromTokenData.address);
      const allowance = await viemReadContract({
        address: _token,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [_owner, _spender],
      }).catch(() => 0n);
      if (amtWei <= 0n) {
        if (allowance > 0n) setFromApproved(true);
        return;
      }
      // Stablecoin inputs: router pulls the 0.15% platform fee from the input
      // side via a separate transferFrom, so allowance must cover amount + fee.
      const requiredWei = getRequiredInputAllowanceWei(amtWei, _token);
      setFromApproved(allowance >= requiredWei);
    } catch {
      // Swallow silently: network/address errors must not mislead the user
    }
  }

  function handleSwitchTokens() {
    const tmpTok = fromToken;
    const tmpAmt = fromAmount;
    setFromToken(toToken);
    setToToken(tmpTok);
    setFromAmount(toAmount);
    setToAmount(tmpAmt);
    setFromApproved(false);
    // After swap arrows: user intention is now to work from the new From card.
    // Reset direction='from' so the debounce quote effect will re-quote the new To card properly.
    setDirection('from');
    try { setSwapPair(toToken, tmpTok); } catch (e) {}
  }

  function openTokenSelect(side) {
    openTokenSelectModal(side, (token) => {
      if (side === 'from') {
        setFromToken(token);
        setDirection('from');
        try { setSwapPair(token, toToken); } catch (e) {}
      } else {
        setToToken(token);
        setDirection('to');
        try { setSwapPair(fromToken, token); } catch (e) {}
      }
      closeTokenSelectModal();
    });
  }

  // Approval: returning true means approval succeeded (the swap can proceed); false means failure/rejection (abort)
  // P0-02 fix: accepts exactAmountWei for precise approval (not unlimited MAX)
  async function handleApprove(exactAmountWei = null) {
    if (!connected) {
      showWalletModal();
      return false;
    }
    if (!fromTokenData) return false;
    setLoadingApprove(true);
    try {
      // R-001 FIX: Calculate exact amount internally if caller forgot; NEVER fall back to MAX_UINT256
      let baseAmount;
      if (exactAmountWei != null) {
        baseAmount = BigInt(exactAmountWei);
      } else {
        const decimals = fromTokenData.decimals || getTokenDecimals(fromToken, customTokens) || 18;
        const amtRawWei = viemParseUnits((fromAmount || '0').toString(), decimals);
        if (amtRawWei <= 0n) {
          showToast('error', 'invalid_amount');
          return false;
        }
        baseAmount = amtRawWei;
      }
      // Stablecoin inputs: include the 0.15% platform fee the router pulls
      // from the input side (commission transferFrom + swap transferFrom).
      const approvalAmount = getRequiredInputAllowanceWei(baseAmount, fromTokenData.address);
      // Safety net: never allow MAX_UINT256 to reach chain
      if (approvalAmount >= VIEM_MAX_UINT256) {
        throw new Error('Unlimited approval is blocked for safety');
      }
      // BY_INVEST mode: the approve target is the ROUTER (0x72BB...ae28).
      // The contract first calls _transferTokenByInvest(token, user, pair, amt):
      //   (1) transferFrom(user -> router)  (2) transfer(router -> pair)
      // Step (2) is transfer() (not transferFrom), so it does not trigger the tax-token pair whitelist check.
      // ⚠️ Prerequisite for plan A: the "BY_INVEST & commission are mutually exclusive" check in CommissionLib must be lifted on the contract side.
      const { hash } = await viemWriteContract({
        address: viemGetAddress(fromTokenData.address),
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [viemGetAddress(ROUTER_ADDRESS), approvalAmount],
      });
      showToast('info', 'approve_tx_submitted');
      await viemWaitForTransaction(hash);
      setFromApproved(true);
      showToast('success', 'approve_success');
      return true;
    } catch (e) {
      console.error('[swap][viem] approve failed', e);
      if (e?.code === 4001 || e?.message?.includes('rejected') || e?.cause?.message?.includes('rejected')) {
        showToast('error', 'user_rejected_approve');
      } else {
        showToast('error', 'approve_failed');
      }
      return false;
    } finally {
      setLoadingApprove(false);
    }
  }

  async function handleSwap(forceAcceptPi = false) {
    if (!connected) {
      showWalletModal();
      return;
    }
    if (routerPaused) {
      try { showToast && showToast('error', 'router_paused'); } catch {}
      return;
    }
    if (!fromAmount || parseFloat(fromAmount) === 0) {
      return;
    }

    // ====== P0 #3: Price Impact guard — MUST be checked BEFORE any approval/signature ======
    const piNum = priceImpact === '--' ? NaN : parseFloat(priceImpact);
    if (!isNaN(piNum) && piNum >= 10) {
      try { showToast && showToast('error', 'price_impact_too_high_blocked'); } catch {}
      return;
    }
    if (!isNaN(piNum) && piNum >= 3 && !piConfirmAccepted && !forceAcceptPi) {
      setPiConfirmOpen(true);
      return;
    }

    const fromTok = _isBnbAliases(fromToken) ? 'WBNB' : fromToken;
    const toTok = _isBnbAliases(toToken)   ? 'WBNB' : toToken;
    const fAddr = symToAddr(fromTok, customTokens);
    const tAddr = symToAddr(toTok, customTokens);
    if (!fAddr || !tAddr) { return; }
    const decIn  = getTokenDecimals(fromTok, customTokens);
    const decOut = getTokenDecimals(toTok, customTokens);
    const amountInWei = viemParseUnits(fromAmount || '0', decIn);
    if (amountInWei <= 0n) { return; }
    // ⚠️ Use a distinct local name to avoid shadowing the outer isFromNative (outer = fromToken==='BNB', used for buttons and the approve skip)
    //   Here _isFromSideEth means "whether the from side is treated as native coin inside the Router (goes via msg.value + ETH_PLACEHOLDER)"
    //   = the user's original symbol is 'BNB' (i.e. fromTok=WBNB while the external fromToken==='BNB'), and the WBNB address is used internally
    const _isFromSideEth = fromToken === 'BNB';
    const _isToSideEth   = toToken   === 'BNB';

    // Approval check: the outer isFromNative (=fromToken==='BNB') already sets fromApproved=true
    if (!isFromNative && !fromApproved) {
      const approved = await handleApprove(amountInWei);
      if (!approved) { return; }
    }
    setLoadingSwap(true);
    try {
      // ====== New DexRouter: first decide the entry function and parameters from bestRoute ======
      // 1) If bestRoute is missing or the pair/amount has changed, re-quote once as a fallback
      let route = bestRoute;
      if (!route || !route.type) {
        const usdtAddr = symToAddr('USDT', customTokens);
        const busdAddr = symToAddr('BUSD', customTokens);
        const r = await getBestQuoteExactInputMixed(amountInWei, fAddr, tAddr, {
          wbnbAddr: WBNB_ADDRESS, usdtAddr: usdtAddr || undefined, busdAddr: busdAddr || undefined,
        }).catch((e) => ({ ok: false, err: e && e.message ? e.message : String(e) }));
        if (!r.ok || !r.best) {
          try { showToast && showToast('warning', 'no_liquidity_no_quote'); } catch {}
          return;
        }
        route = r.best;
      }

      // 2) Compute minReturnAmount (slippage and the platform fee were already deducted at quote time; do not deduct twice here)
      const minOutStr = minReceived && parseFloat(minReceived) > 0 ? minReceived : '0';
      const amountOutMin = viemParseUnits(minOutStr, decOut);
      if (amountOutMin <= 0n) {
        try { showToast && showToast('warning', 'route_slippage_too_high_pls_refresh'); } catch {}
        return;
      }

      // 3) Common parameters
      const deadline = BigInt(Math.floor(Date.now() / 1000) + (Number(txDeadlineMinutes) || TX_DEADLINE_MINUTES) * 60);
      // The referrer is captured and stashed from ?ref= by a global hook; read it uniformly here (format + self-referral check)
      const ref = isValidReferrer(getStoredReferrer(), address);
      const refAddr = ref ? viemGetAddress(ref) : viemZeroAddress;
      const routerAddr = viemGetAddress(ROUTER_ADDRESS);
      const userAddr = viemGetAddress(address);
      const _addrMask = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn;

      // 4) Build BaseRequest (required by dagSwapTo / uniswapV3SwapToWithBaseRequest / swapWrapToWithBaseRequest)
      //    from side: native coin -> pass ETH_PLACEHOLDER; encodeBaseRequest recognizes it and keeps the low 160 bits clean;
      //               ERC20 -> pass fAddr; encodeBaseRequest stacks MODE_DIRECT onto bits 253/251/249
      //    to   side: native coin -> ETH_PLACEHOLDER; ERC20 -> tAddr; the to field itself is an address and gets no MODE bits
      const fromTokenRaw = _isFromSideEth ? viemGetAddress(ETH_PLACEHOLDER) : viemGetAddress(fAddr);
      const toTokenRaw   = _isToSideEth   ? viemGetAddress(ETH_PLACEHOLDER) : viemGetAddress(tAddr);
      const baseRequest = encodeBaseRequest(
        fromTokenRaw,
        toTokenRaw,
        amountInWei,
        amountOutMin,
        deadline,
        MODE_DIRECT, // encodeBaseRequest skips MODE for ETH_PLACEHOLDER; it only takes effect for ERC20
      );
      // viem encodes anonymous tuples (no struct name) as arrays rather than objects, so expand in ABI order:
      //   (uint256 fromToken, address toToken, uint256 fromTokenAmount, uint256 minReturnAmount, uint256 deadLine)
      const baseRequestArr = [
        baseRequest.fromToken,
        baseRequest.toToken,
        baseRequest.fromTokenAmount,
        baseRequest.minReturnAmount,
        baseRequest.deadLine,
      ];

      // 5) Assemble ExtraData and append it to the end of calldata (tightly packed flag-scan format, 3 words = 96 bytes)
      //    Automatically selects the fee direction (stablecoin side preferred; defaults to the TO side if neither is), and writes the fee-deduction token address into tokenWithMode
      const commissionFromAddr = _isFromSideEth ? viemGetAddress(ETH_PLACEHOLDER) : fAddr;
      const commissionToAddr   = _isToSideEth   ? viemGetAddress(ETH_PLACEHOLDER) : tAddr;
      const extraData = buildExtraData(userAddr, refAddr, platformFeeBp > 0n ? platformFeeBp : 15n, {
        fromAddr: commissionFromAddr,
        toAddr:   commissionToAddr,
      });

      // 6) Select the entry function by route.type
      let functionName = '';
      let args = [];
      let value = 0n;
      // gas=0 marks swap-type transactions; before sending, utils/swapGas.js computes gas uniformly as
      // "pure swap estimate + registered pool count x per-pool notification budget"; wrap/unwrap triggers no mining notification, so a fixed small value is used.
      let gas = 0n;
      const ORDER_ID_ZERO = 0n;
      // Decoupled WBNB/BNB alias check: judged by the user's actual selected symbol
      const fromSymRaw = fromToken;
      const toSymRaw = toToken;
      const needWrap   = (fromSymRaw === 'BNB'  && toSymRaw === 'WBNB');   // BNB->WBNB (native in -> WBNB token out)
      const needUnwrap = (fromSymRaw === 'WBNB' && toSymRaw === 'BNB');   // WBNB->BNB (WBNB token in -> native out)
      if (needWrap || needUnwrap) {
        functionName = 'swapWrapToWithBaseRequest';
        args = [ORDER_ID_ZERO, userAddr, baseRequestArr];
        value = needWrap ? amountInWei : 0n;
        gas = 400_000n;
      } else if (route.type === 'v2-single') {
        // V2 single-hop → unxswapTo(srcToken uint256, amount, minReturn, receiver, bytes32[] pools)
        //   srcToken: lower 160 bits = token address (or ETH_PLACEHOLDER for native)
        //   ERC20: MODE_DIRECT is encoded in pools[0] bits 251-249 by encodeV2PoolKey
        //   Native coin (BNB): the contract's TransferLib hard-requires MODE_LEGACY (bits 251-249 = 000),
        //     otherwise it reverts with "ETH as fromToken is not allowed for non-legacy mode"
        const srcToken = _isFromSideEth
          ? (BigInt(viemGetAddress(ETH_PLACEHOLDER)) & _addrMask)
          : (BigInt(viemGetAddress(fAddr)) & _addrMask);
        functionName = 'unxswapTo';
        let _pools = (route.poolKeys || []).map(k => k);
        // Native coin input: clear the MODE bits of pools[0] -> MODE_LEGACY (hard requirement of the contract's TransferLib)
        if (_isFromSideEth && _pools.length > 0) {
          const _TRANSFER_MODE_MASK = 0x0E00000000000000000000000000000000000000000000000000000000000000n;
          const v = BigInt(_pools[0]);
          _pools[0] = '0x' + (v & ~_TRANSFER_MODE_MASK).toString(16).padStart(64, '0');
        }
        args = [srcToken, amountInWei, amountOutMin, userAddr, _pools];
        value = _isFromSideEth ? amountInWei : 0n;
      } else if (route.type === 'v3-single') {
        functionName = 'uniswapV3SwapToWithBaseRequest';
        // V3 poolKey bit layout aligned with the contract's Constants.sol:
        //   Native coin input (BNB): the contract first wraps WBNB with payer=the contract itself, clearing pools[0] bits 251-249
        //     -> MODE_LEGACY(0); the callback goes through the contract's internal payment path (isomorphic to V2 native input)
        //   Native coin output (BNB): set bit253 (_WETH_UNWRAP_MASK) on the last hop; the contract unwraps WBNB->BNB to the receiver
        const _V3_TRANSFER_MODE_MASK = 0x0E00000000000000000000000000000000000000000000000000000000000000n;
        const _V3_WETH_UNWRAP_BIT = 1n << 253n;
        const _v3Keys = route.poolKeys || [];
        const pools = _v3Keys.map((k, idx) => {
          let v = typeof k === 'bigint' ? k : BigInt(k || 0n);
          if (_isFromSideEth && idx === 0) v = v & ~_V3_TRANSFER_MODE_MASK;
          if (_isToSideEth && idx === _v3Keys.length - 1) v = v | _V3_WETH_UNWRAP_BIT;
          return v;
        });
        args = [ORDER_ID_ZERO, userAddr, baseRequestArr, pools];
        value = _isFromSideEth ? amountInWei : 0n;
      } else if (route.type === 'v2-multi') {
        // V2 multi-hop -> unxswapTo(srcToken, amount, minReturn, receiver, bytes32[] pools)
        //   The pools array has multiple elements, one poolKey per hop (encoded by encodeV2PoolKey in swapRoutes.js)
        //   Native coin input: the contract's TransferLib hard-requires pools[0] MODE = MODE_LEGACY (000),
        //     otherwise it reverts with "ETH as fromToken is not allowed for non-legacy mode".
        //     Clear bits 251-249 (MODE_DIRECT -> MODE_LEGACY), keeping TAX_MASK/REVERSE/WETH/NUMERATOR.
        //   Native coin output: the unwrap bit of the last hop is already set by encodeV2PoolKey in swapRoutes.js
        const srcToken = _isFromSideEth
          ? (BigInt(viemGetAddress(ETH_PLACEHOLDER)) & _addrMask)
          : (BigInt(viemGetAddress(fAddr)) & _addrMask);
        let pools = (route.poolKeys || []).map(k => k);
        // Native coin input: clear the MODE bits of pools[0] -> MODE_LEGACY (hard requirement of the contract's TransferLib)
        if (_isFromSideEth && pools.length > 0) {
          const _TRANSFER_MODE_MASK = 0x0E00000000000000000000000000000000000000000000000000000000000000n;
          const v = BigInt(pools[0]);
          pools[0] = '0x' + (v & ~_TRANSFER_MODE_MASK).toString(16).padStart(64, '0');
        }
        functionName = 'unxswapTo';
        args = [srcToken, amountInWei, amountOutMin, userAddr, pools];
        value = _isFromSideEth ? amountInWei : 0n;
      } else {
        try { showToast && showToast('warning', 'no_liquidity_no_quote'); } catch {}
        return;
      }
      // 7) Encode base calldata then append ExtraData
      //    V2-single: when the user wants native BNB output, the unwrap flag bit must be set on the pool key
      //    (_WETH_MASK = bit 254) so that UnxswapRouter unwraps WBNB into BNB for the receiver;
      //    otherwise toToken resolves to WBNB while the receiver expects BNB -> revert.
      if (route.type === 'v2-single' && _isToSideEth && Array.isArray(route.poolKeys) && route.poolKeys.length) {
        const _WETH_BIT = 1n << 254n;
        route.poolKeys = route.poolKeys.map((oldHex) => {
          const v = BigInt(oldHex);
          return '0x' + (v | _WETH_BIT).toString(16).padStart(64, '0');
        });
        // v2-single uses route.poolKeys; write back to args[4]
        if (args && args.length >= 5) args[4] = route.poolKeys;
      }

      const baseCalldata = viemEncodeFunctionData({ abi: _ROUTER_ABI_JSON, functionName, args });
      const finalCalldata = appendExtraData(baseCalldata, extraData);

      // 8) Send via injected provider: custom calldata with appended ExtraData
      //    cannot use viemWriteContract (ABI re-encode would overwrite appended bytes)
      showToast('info', 'tx_sent_waiting');
      let hash;
      if (typeof window !== 'undefined') {
        const inj = (window.okxwallet || window.ethereum || window.binanceChainWallet || null);
        if (!inj) throw new Error('no injected provider');
        const ethReq = inj.request ? inj.request.bind(inj) : null;
        if (!ethReq) throw new Error('provider no request');

        // Gas ceiling: wrap/unwrap triggers no mining notification, so a fixed small value is used (gas was already set to
        // 400,000 in that branch); swap-type transactions (gas===0) are computed as "pure swap estimate +
        // registered pool count x per-pool notification budget". The factory notification loop skips the remaining pools without reverting when gasleft < 650k, causing
        // eth_estimateGas to converge to an underestimate that excludes notification cost, so the notification budget must be added explicitly.
        let finalGas = gas;
        if (gas === 0n) {
          let baseGas = FALLBACK_BASE_GAS;
          try {
            const estHex = await ethReq({
              method: 'eth_estimateGas',
              params: [{ from: userAddr, to: routerAddr, data: finalCalldata, value: '0x' + value.toString(16) }],
            });
            if (typeof estHex === 'string' && estHex.startsWith('0x') && BigInt(estHex) > 0n) baseGas = BigInt(estHex);
          } catch (estErr) {
            // Estimation failure is non-blocking (some contract wallets can still sign); baseGas falls back to FALLBACK.
            console.warn('[swap] estimateGas failed, using fallback base gas:', estErr?.shortMessage || estErr?.message || '');
          }
          let poolCount = ASSUMED_POOL_COUNT_ON_ERROR;
          try {
            const traderPools = await viemReadContract({
              address: MINING_POOL_FACTORY_ADDRESS,
              abi: MINING_POOL_FACTORY_ABI,
              functionName: 'getTraderPools',
              args: [userAddr],
            });
            poolCount = countActivePools(traderPools);
          } catch (e) {
            console.warn('[swap] getTraderPools failed, assuming', ASSUMED_POOL_COUNT_ON_ERROR, 'pools:', e?.shortMessage || e?.message || '');
          }
          finalGas = computeSwapGas(baseGas, poolCount);
        }

        // Do not force chainId: the wallet signs on its current network; passing the wrong chainId makes the wallet's internal simulation
        // fail and greys out the "confirm" button without any prompt.
        const txParams = {
          from: userAddr,
          to: routerAddr,
          data: finalCalldata,
          value: '0x' + value.toString(16),
          gas: '0x' + finalGas.toString(16),
        };
        hash = await ethReq({ method: 'eth_sendTransaction', params: [txParams] });
      } else {
        throw new Error('no browser wallet provider');
      }

      await viemWaitForTransaction(hash);

      setFromAmount('');
      setToAmount('');
      setBestRoute(null);
      showToast('success', 'swap_success_excl');
      try { await refreshBalances?.(); } catch (e) {}
      try { await loadReserves(true); } catch (e) { console.warn('[swap] post-swap loadReserves failed:', e?.message || String(e)); }
    } catch (e) {
      console.error('[swap] swap failed', e);
      const errMsg = e?.message || e?.cause?.message || '';
      if (e?.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied') || errMsg.includes('User rejected')) {
        showToast('error', 'user_rejected_sig');
      } else if (errMsg.includes('INSUFFICIENT_OUTPUT_AMOUNT') || errMsg.includes('insufficient output') || errMsg.includes('minReturn')) {
        showToast('error', 'insufficient_output');
      } else if (/paused|halt/i.test(errMsg)) {
        showToast('error', 'router_paused');
      } else if (errMsg.includes('not enough') || errMsg.includes('BEP20') || errMsg.includes('transfer') || errMsg.includes('transferFrom') || errMsg.includes('Allowance')) {
        showToast('error', 'swap_failed_generic');
      } else {
        showToast('error', 'swap_failed_generic');
      }
    } finally {
      setLoadingSwap(false);
    }
  }


  const hasAmount = !!fromAmount && parseFloat(fromAmount) > 0;
  const balanceInsufficient = hasAmount && parseFloat(fromBalance) < parseFloat(fromAmount);
  const showApproveBtn = !isFromNative && connected && hasAmount && !fromApproved && !loadingApprove;
  // Price Impact hard flags for button + text
  const piNum2 = priceImpact === '--' ? NaN : parseFloat(priceImpact);
  const piTooHigh = !isNaN(piNum2) && piNum2 >= 10;
  const swapBtnDisabled = !connected ? false : (!hasAmount || loadingQuote || loadingSwap || balanceInsufficient || piTooHigh);

  let btnText;
  if (!connected) btnText = t('connect_wallet');
  else if (!hasAmount) btnText = t('enter_amount');
  else if (piTooHigh) btnText = t('price_impact_too_high');
  else if (balanceInsufficient) btnText = t('insufficient_balance');
  else if (showApproveBtn || loadingApprove) btnText = loadingApprove ? t('approving') : t('approve_token_btn').replace('{symbol}', fromToken);
  else btnText = t('swap_title');

  // Uniformly go through handleSwap: internally it approves first according to the approval state, then continues the swap (on successful approval it automatically prompts the swap signature)
  const btnClick = connected ? handleSwap : showWalletModal;
  const btnDisabled = (!connected ? false : (!hasAmount || loadingQuote || loadingSwap || balanceInsufficient || piTooHigh));
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[420px]">
        {/* ====== DEX standard: minimal card (glow-border / gradient frame / animations removed) ====== */}
        <div className="rounded-xl p-4"
          style={{
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-default)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {/* ====== Slippage selector: 4 preset pill buttons + a custom % input box, compact layout ====== */}
          <div className="mb-3">
            <div className="flex items-center justify-center gap-1.5 flex-wrap">
              {PRESET_SLIP_PCT.map((pct) => {
                const active = Math.abs(pct * PCT_TO_BPS - slippageBps) < 0.0001 && customSlipInput === '';
                return (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => handlePresetSlippage(pct)}
                    className="h-7 px-2.5 rounded-lg text-xs font-semibold transition-colors flex-shrink-0"
                    style={active ? {
                      background: 'var(--color-primary-500)',
                      color: '#fff',
                    } : {
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border-subtle)',
                    }}
                  >
                    {pct}%
                  </button>
                );
              })}
              <div className="relative w-[72px] flex-shrink-0">
                <input
                  type="text"
                  inputMode="decimal"
                  value={customSlipInput}
                  onChange={handleCustomSlippageChange}
                  onKeyDown={blockInvalidNumericKeys}
                  placeholder={t('custom') || 'Custom'}
                  className="w-full h-7 px-2 pr-6 rounded-lg text-xs font-medium outline-none transition-colors"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    color: 'var(--color-text-primary)',
                    border: customSlipInput
                      ? '1px solid var(--color-border-strong)'
                      : '1px solid var(--color-border-subtle)',
                  }}
                />
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
                  %
                </span>
              </div>
            </div>
          </div>

          {/* ====== Input area: From / arrow / To, compact spacing ====== */}
          <div className="space-y-1">
            <SwapInputCard
              label={t('pay')}
              tokenSymbol={fromSymbol}
              tokenData={fromTokenData}
              amount={fromAmount}
              onAmountChange={handleFromAmountChange}
              onSelectToken={() => openTokenSelect('from')}
              balance={formatBalance(fromBalance, 4)}
              balanceInsufficient={balanceInsufficient}
              contractAddress={fromTokenData?.address || ''}
              pairReserve={currentPairReserves?.aSymReserve || ''}
              pairCounterpart={toToken}
              percentButtons
              onPickPercent={handlePickFromPercent}
            />

            {/* ====== Center swap arrow ====== */}
            <div className="flex justify-center -my-2 relative z-10">
              <button
                onClick={handleSwitchTokens}
                aria-label={t('switch_tokens') || 'Switch tokens'}
                className="w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200"
                style={{
                  background: 'linear-gradient(to right, #FBBF24, #F97316)',
                  border: 'none',
                  color: '#fff',
                  boxShadow: '0 2px 8px 0 rgba(249, 115, 22, 0.4)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'linear-gradient(to right, #F59E0B, #EA580C)';
                  e.currentTarget.style.boxShadow = '0 4px 12px 0 rgba(249, 115, 22, 0.5)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'linear-gradient(to right, #FBBF24, #F97316)';
                  e.currentTarget.style.boxShadow = '0 2px 8px 0 rgba(249, 115, 22, 0.4)';
                }}
              >
                <ArrowDownUp className="w-3.5 h-3.5" />
              </button>
            </div>

            <SwapInputCard
              label={t('receive')}
              tokenSymbol={toSymbol}
              tokenData={toTokenData}
              amount={toAmount}
              onAmountChange={handleToAmountChange}
              onSelectToken={() => openTokenSelect('to')}
              balance={formatBalance(toBalance, 4)}
              loading={loadingQuote || loadingInverse}
              contractAddress={toTokenData?.address || ''}
              pairReserve={currentPairReserves?.bSymReserve || ''}
              pairCounterpart={fromToken}
            />
          </div>

          {/* ====== Collapsible details area: route + trade details (collapsed by default) ====== */}
          <div className="mt-3 px-1">
            {/* Route path */}
            {usedRoute && usedRoute.length >= 2 && (
              <div className="flex items-center justify-between py-0.5 text-xs">
                <span style={{ color: 'var(--color-text-tertiary)' }}>{t('trade_route') || 'Route'}</span>
                <span className="font-medium font-numeric truncate ml-2 flex items-center gap-1" style={{ color: 'var(--color-text-secondary)' }}>
                  {usedRoute.join(' → ')}
                  {usedRoute.length >= 3 && (
                    <span className="ml-0.5 px-1 py-0.5 rounded text-[10px] font-semibold flex-shrink-0" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>
                      {usedRoute.length - 1} hops
                    </span>
                  )}
                </span>
              </div>
            )}
            {/* Trade details collapse toggle button */}
            <button
              type="button"
              onClick={() => setDetailsExpanded(v => !v)}
              className="flex w-full items-center justify-between py-1.5 group"
              aria-expanded={detailsExpanded}
            >
              <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: 'var(--color-text-secondary)' }}>
                <Info size={12} />
                {t('trade_details') || 'Trade Details'}
              </span>
              <ChevronDown
                className="w-3.5 h-3.5 transition-transform duration-200"
                style={{
                  color: 'var(--color-text-tertiary)',
                  transform: detailsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </button>
            {detailsExpanded && (
              <div className="mt-2 space-y-2 rounded-xl p-3"
                style={{
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-default)',
                }}
              >
                {/* 1. Exchange rate (real rate enforced: show a red warning when it cannot be fetched; never display fake data) */}
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('exchange_rate')}</span>
                  {(() => {
                    const failPrefix = quoteSource && String(quoteSource).startsWith('fail');
                    const loading = loadingQuote || loadingInverse;
                    if (loading) {
                      return (
                        <span className="font-medium font-numeric truncate flex items-center gap-1" style={{ color: 'var(--state-info)' }}>
                          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--state-info)' }} />
                          {t('loading_real_rate') || 'Loading real rate...'}
                        </span>
                      );
                    }
                    if (failPrefix) {
                      const msgMap = {
                        'fail-no-provider': t('rpc_node_down') || 'BSC node is abnormal',
                        'fail-no-token': t('unknown_token_no_quote') || 'Token not listed',
                        'fail-no-liquidity': t('no_liquidity_no_quote') || 'Trading pair lacks liquidity',
                        'fail-exception': t('chain_query_failed') || 'On-chain query failed',
                      };
                      return (
                        <span className="font-medium font-numeric truncate flex items-center gap-1" style={{ color: 'var(--state-error)' }}>
                          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                          {msgMap[String(quoteSource)] || (t('no_real_rate') || 'No real rate')}
                        </span>
                      );
                    }
                    if (parseFloat(fromAmount || '0') > 0 && parseFloat(toAmount || '0') > 0 && quoteSource && !String(quoteSource).startsWith('fail')) {
                      return (
                        <span className="font-medium font-numeric truncate" style={{ color: 'var(--color-text-primary)' }}>
                          1 {fromSymbol} = {exchangeRate} {toSymbol}
                          {quoteSource === 'pancake' || quoteSource === 'pancake-inv' ? (
                            <span className="ml-1 px-1 py-0.5 rounded text-[10px] font-semibold"
                              style={{ background: 'var(--state-success-bg)', color: 'var(--state-success)' }}
                            >
                              PCS
                            </span>
                          ) : quoteSource === 'same' ? null : null}
                        </span>
                      );
                    }
                    return (
                      <span className="font-medium font-numeric truncate" style={{ color: 'var(--color-text-tertiary)' }}>
                        {t('enter_amount_rate')}
                      </span>
                    );
                  })()}
                </div>
                {/* 2. Slippage */}
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('slippage_tolerance')}</span>
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                      {slippagePercent}%
                    </span>
                  </div>
                </div>
                {/* 3. Price Impact */}
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('price_impact')}</span>
                  <span className={`font-medium font-numeric flex items-center gap-1`}
                    style={{ color: priceImpactWarning ? 'var(--state-error)' : 'var(--color-text-primary)' }}
                  >
                    {priceImpact === '--' ? (
                      <span className="font-medium" style={{ color: 'var(--color-text-tertiary)' }}>--</span>
                    ) : (
                      <>
                        {priceImpact}%
                        {priceImpactWarning && <AlertTriangle className="inline w-3 h-3 flex-shrink-0" />}
                      </>
                    )}
                    {usedRoute && usedRoute.length >= 3 && priceImpact !== '--' && (
                      <span className="ml-0.5 px-1 py-0.5 rounded text-[10px] font-semibold flex-shrink-0" style={{ background: 'var(--state-warning-bg)', color: 'var(--state-warning)' }}>
                        {t('price_impact_multi_hop') || 'via hops'}
                      </span>
                    )}
                  </span>
                </div>
                {/* 4. Minimum received */}
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('min_received')}</span>
                  <span className="font-medium font-numeric truncate" style={{ color: 'var(--color-text-primary)' }}>
                    {formatBalance(minReceived, 6)} {toSymbol}
                  </span>
                </div>
                {/* Divider + other LP list (no separate POOLS title; connected directly below) */}
                <div className="pt-2 mt-1" style={{ borderTop: '1px dashed var(--color-border-default)' }}>
                  <div className="space-y-1.5">
                    {(() => {
                      const others = getOtherLpsList(fromToken, otherPairsReal, customTokens);
                      if (others.length === 0) {
                        return (
                          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                            {t('no_other_pools') || 'No other liquidity pools'}
                          </span>
                        );
                      }
                      return others.map(item => (
                        <div
                          key={item.name}
                          className="flex items-center gap-2 text-[11px]"
                        >
                          <span
                            className="font-semibold shrink-0 w-24 truncate"
                            style={{ color: 'var(--color-text-primary)' }}
                          >
                            {item.name}
                          </span>
                          <span
                            className="flex-1 border-b border-dashed opacity-40"
                            style={{ borderColor: 'var(--color-border-default)' }}
                          />
                          <span
                            className="font-numeric font-medium shrink-0 whitespace-nowrap text-right"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {item.aCompact} <span style={{color:'var(--color-text-tertiary)'}}>/</span> {item.bCompact}
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ====== Main button ====== */}
          <div className="mt-3">
            <button
              onClick={btnClick}
              disabled={btnDisabled || loadingApprove || loadingSwap}
              className={`w-full h-11 rounded-xl font-semibold text-base flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed`}
              style={{
                background: 'linear-gradient(to right, #FBBF24, #F97316)',
                color: '#ffffff',
                border: 'none',
                boxShadow: '0 4px 14px 0 rgba(249, 115, 22, 0.4)',
              }}
              onMouseEnter={(e) => {
                if (e.currentTarget.disabled) return;
                e.currentTarget.style.background = 'linear-gradient(to right, #F59E0B, #EA580C)';
                e.currentTarget.style.boxShadow = '0 6px 20px 0 rgba(249, 115, 22, 0.5)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'linear-gradient(to right, #FBBF24, #F97316)';
                e.currentTarget.style.boxShadow = '0 4px 14px 0 rgba(249, 115, 22, 0.4)';
              }}
            >
              {loadingApprove || loadingSwap ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : !connected ? (
                <Wallet className="w-5 h-5" />
              ) : null}
              <span>{btnText}</span>
            </button>
            {/* ====== Mining reward: one-line text directly below the button (all frames and emphasis removed, text information only) ====== */}
            <div className="mt-2.5 flex flex-col items-center justify-center gap-1 text-[11px]">
              <div className="flex items-center justify-center gap-1.5">
                <Zap className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-warn-500)' }} />
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {t('mining_reward_est')}:
                </span>
                <span
                  className="font-numeric font-semibold"
                  style={{ color: 'var(--color-warn-500)' }}
                >
                  +{formatBalance(miningRewardEst, 4)} CFO
                </span>
              </div>
              {/* ====== Mining reward source explanation: real on-chain rate + real token USDT price ====== */}
              {parseFloat(miningRewardEst) > 0 && (
                <div className="flex items-center justify-center gap-1 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  <span>⚡</span>
                  <span>{t('mining_reward_est_source') || 'Mining reward estimated in real-time by trading volume'}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ====== P0 #3: Price Impact ≥3% confirm dialog (stop sandwich-prone users) ====== */}
      {piConfirmOpen && priceImpact !== '--' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.55)' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setPiConfirmOpen(false); } }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-5 shadow-2xl flex flex-col gap-4"
            style={{
              background: 'var(--color-bg-primary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center rounded-full w-10 h-10 flex-shrink-0"
                style={{ background: 'var(--state-warning-bg)' }}
              >
                <AlertTriangle className="w-5 h-5" style={{ color: 'var(--state-warning)' }} />
              </div>
              <div className="flex flex-col">
                <h3 className="text-base font-semibold leading-tight" style={{ color: 'var(--color-text-primary)' }}>
                  {t('price_impact_high_title') || 'High Price Impact'}
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('price_impact_high_prompt') || 'Your trade size will move the market significantly.'}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 p-3 rounded-lg" style={{ background: 'var(--color-bg-tertiary)' }}>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--color-text-secondary)' }}>{t('price_impact')}</span>
                <span className="font-semibold font-numeric" style={{ color: 'var(--state-error)' }}>
                  {priceImpact}%
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--color-text-secondary)' }}>{t('slippage_tolerance')}</span>
                <span className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                  {slippagePercent}%
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--color-text-secondary)' }}>{t('min_received')}</span>
                <span className="font-medium font-numeric truncate" style={{ color: 'var(--color-text-primary)' }}>
                  {formatBalance(minReceived, 6)} {toSymbol}
                </span>
              </div>
              {usedRoute && usedRoute.length >= 3 && (
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('trade_route') || 'Route'}</span>
                  <span className="font-medium font-numeric truncate ml-2" style={{ color: 'var(--color-text-primary)' }}>
                    {usedRoute.join(' → ')}
                  </span>
                </div>
              )}
            </div>

            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {t('price_impact_risk_desc') || 'You will receive fewer tokens due to your own trade size. If you set slippage too low, this transaction may still fail. Slippage alone cannot protect you against this type of loss.'}
            </p>

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setPiConfirmOpen(false)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-primary)',
                  border: '1px solid var(--color-border-default)',
                }}
              >
                {t('cancel') || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => {
                  // NOTE: Do NOT schedule handleSwap() via setTimeout(fn, 0).
                  // In React 18, setTimeout fires inside a stale render closure where piConfirmAccepted is still the old false copy,
                  // so the PI guard rejects it again → the dialog flashes closed then reopens, forcing the user to click Accept twice.
                  // Instead pass forceAcceptPi=true directly as a function argument: by-value parameters are always fresh.
                  setPiConfirmAccepted(true);
                  setPiConfirmOpen(false);
                  handleSwap(true);
                }}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                style={{
                  background: 'var(--state-error)',
                  color: '#ffffff',
                }}
              >
                {t('price_impact_accept_risk') || 'Accept & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SwapInputCard({ label, tokenSymbol, tokenData, amount, onAmountChange, onSelectToken, balance, readOnly = false, loading = false, balanceInsufficient = false, contractAddress = '', pairReserve = '0', pairCounterpart = '', percentButtons = false, onPickPercent = null }) {
  const { t } = useTranslation();
  const isCFO = tokenSymbol === 'CFO';
  const percentList = [
    { key: '25', label: '25%' },
    { key: '50', label: '50%' },
    { key: '75', label: '75%' },
    { key: 'max', label: 'MAX' },
  ];

  return (
    /* ====== DEX standard: flat input block (removed the independent card-within-card background) -> overall rounded-xl with only a very faint hover ====== */
    <div
      className="rounded-xl px-3.5 py-2.5 transition-colors"
      style={{
        background: 'var(--color-bg-tertiary)',
        border: `1px solid ${balanceInsufficient ? 'var(--state-error)' : 'var(--color-border-subtle)'}`,
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {label}
        </span>
        <span className="text-xs" style={{ color: balanceInsufficient ? 'var(--state-error)' : 'var(--color-text-tertiary)' }}>
          {t('balance')}: <span className="font-numeric">{balance}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => !readOnly && onAmountChange(sanitizeAmountInput(e.target.value))}
            onKeyDown={blockInvalidNumericKeys}
            readOnly={readOnly}
            className="w-full bg-transparent outline-none text-xl font-semibold font-numeric"
            style={{
              color: loading ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
              caretColor: 'var(--color-primary-500)',
            }}
          />
        </div>
        {/* ====== Currency select button: pill capsule + light gray background (removed the glow outside the gradient logo) ====== */}
        <button
          onClick={onSelectToken}
          className="flex items-center gap-2 px-3.5 py-2 rounded-full transition-colors"
          style={{
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-default)',
            color: 'var(--color-text-primary)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-bg-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--color-bg-secondary)';
          }}
        >
          <TokenIcon src={tokenIconSrc(tokenData)} symbol={tokenSymbol} size={24} />
          <span className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>
            {isCFO ? 'CFO' : tokenSymbol}
          </span>
          <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-text-tertiary)' }} />
        </button>
      </div>
      {/* ====== Shortcut percentage buttons ====== */}
      {percentButtons && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {percentList.map(item => (
            <button
              key={item.key}
              type="button"
              onClick={(e) => { e.stopPropagation(); onPickPercent && onPickPercent(item.key); }}
              disabled={readOnly}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-default)',
              }}
              onMouseEnter={(e) => {
                if (readOnly) return;
                e.currentTarget.style.background = 'var(--state-info-bg)';
                e.currentTarget.style.borderColor = 'var(--color-primary-500)';
                e.currentTarget.style.color = 'var(--color-primary-500)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-bg-secondary)';
                e.currentTarget.style.borderColor = 'var(--color-border-default)';
                e.currentTarget.style.color = 'var(--color-text-primary)';
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* ====== Card footer: contract address + token amount on the same row (auto-wraps when space is tight; the amount is spaced via gap) ====== */}
      {contractAddress && (
        <div
          className="mt-3 pt-2.5 border-t flex flex-wrap items-center justify-between gap-x-8 gap-y-1.5"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          {/* Left: contract address (shown in full without truncation; break-all wraps if too long; min-w-0 guarantees proper shrinking and wrapping) */}
          <span
            className="text-[10px] font-numeric leading-tight break-all min-w-0"
            style={{ color: 'var(--color-text-secondary)' }}
            title={contractAddress}
          >
            {contractAddress}
          </span>
          {/* Right: token amount (never wraps; shrink-0 keeps the amount always fully displayed and uncompressed; gap-x-8 gives wide spacing from the address; show -- instead of 0 when there is no data) */}
          <span
            className="text-[10px] font-numeric font-semibold shrink-0 whitespace-nowrap text-right"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {pairReserve && String(pairReserve) !== '0' && String(pairReserve).trim() !== ''
              ? `${formatCompact(pairReserve)} ${tokenSymbol}`
              : <span style={{ color: 'var(--color-text-tertiary)' }}>--</span>
            }
          </span>
        </div>
      )}
    </div>
  );
}
