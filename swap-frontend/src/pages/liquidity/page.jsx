import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/config/i18n.js';
import { ChevronDown, Plus, Minus, Wallet, Info, Loader2, Droplets, Coins, Search } from 'lucide-react';
import { getAddress as viemGetAddress, formatUnits as viemFormatUnits, parseUnits as viemParseUnits, zeroAddress as viemZeroAddress } from 'viem';
import { TOKENS, PAIR_ABI, ERC20_ABI, PANCAKE_SWAP_ROUTER_V2, PANCAKE_SWAP_FACTORY_V2, PANCAKE_ROUTER_ABI, FACTORY_ABI, WBNB_ADDRESS, USDT_ADDRESS, DEFAULT_SLIPPAGE, TX_DEADLINE_MINUTES } from '@/config/index.js';
import { formatBalance, parseTokenAmount, fetchDecimals, sanitizeAmountInput, blockInvalidNumericKeys, viemReadContract, viemWriteContract, viemWaitForTransaction, VIEM_MAX_UINT256 } from '@/utils/index.js';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import { usePrefsStore } from '@/store/prefsStore.js';
import { useLiquidityStore } from '@/store/liquidityStore.js';
import { tokenAddrById, decimalsById, resolveTokenById, tokenIconSrc } from '@/utils/tokens.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';

const TABS = [
  { id: 'add', key: 'add_liquidity' },
  { id: 'remove', key: 'remove_liquidity' },
];

const REMOVE_PCTS = [25, 50, 75, 100];

// EVM / viem error messages → user-friendly localized text; show raw error if no match (truncated)
function translateEvmError(rawMsg) {
  if (!rawMsg) return '';
  const t = i18n.t;
  if (rawMsg.includes('Wrong network') || rawMsg.includes('Wrong network: expected BSC chainId')) return t('liq_err_wrong_network');
  if (rawMsg.includes('Wallet not connected')) return t('liq_err_wallet_not_connected');
  if (rawMsg.includes('No wallet provider available')) return t('liq_err_no_wallet');
  if (rawMsg.includes('insufficient')) return t('liq_err_insufficient');
  if (rawMsg.includes('gas')) return t('liq_err_gas');
  if (rawMsg.includes('timeout') || rawMsg.includes('HttpRequestError') || rawMsg.includes('Network Error')) return t('liq_err_network_timeout');
  if (rawMsg.includes('Unlimited approval')) return t('liq_err_unlimited_approval');
  if (rawMsg.includes('Non-2xx')) return t('liq_err_node_error');
  if (rawMsg.includes('execution reverted')) return t('liq_err_reverted');
  // No friendly match → return truncated raw error (strip long hex strings)
  const cleaned = String(rawMsg)
    .replace(/0x[a-fA-F0-9]{40,}/g, '0x…')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 120 ? cleaned.slice(0, 120) + '…' : cleaned;
}

// Robustly convert any value (string / number / bigint / object with wei / hex) to BigInt, or null if impossible
function toBigIntSafe(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') { if (!isFinite(v)) return null; try { return BigInt(Math.floor(v)); } catch { return null; } }
  if (typeof v === 'string') {
    const s = v.trim().replace(/,/g, '');
    if (!s) return null;
    try {
      if (/^0x[a-fA-F0-9]+$/.test(s)) return BigInt(s);
      return BigInt(s);
    } catch {
      // Try parseTokenAmount-style fallback (strip trailing decimals point)
      try {
        const [intPart = '0'] = s.split('.');
        return BigInt(intPart || '0');
      } catch { return null; }
    }
  }
  if (typeof v === 'object') {
    // viem Result wrapper (some RPC return nested { result: ... })
    if (typeof v.result !== 'undefined') return toBigIntSafe(v.result);
    // ethers v5 BigNumber: { _hex, _isBigNumber }  /  ethers v6: { value, _ethers }
    if (v._isBigNumber === true && typeof v._hex === 'string') try { return BigInt(v._hex); } catch { /* fall */ }
    if (typeof v.hex === 'string') try { return BigInt(v.hex); } catch { /* fall */ }
    // Common cases: { _hex: '0x...' }, { value: ... }, { wei: ... }, raw.toString()
    if (typeof v._hex === 'string') try { return BigInt(v._hex); } catch { /* fall */ }
    if (typeof v.wei !== 'undefined') return toBigIntSafe(v.wei);
    if (typeof v.value !== 'undefined') return toBigIntSafe(v.value);
    try { const s = v.toString(); if (s && s !== '[object Object]') return toBigIntSafe(s); } catch { /* fall */ }
  }
  return null;
}

// Convert a number to a decimal string without scientific notation (trailing zeros stripped)
function toDecimalStr(num) {
  if (typeof num === 'string') num = parseFloat(num);
  if (!isFinite(num) || num === 0) return '0';
  // Ensure sufficient precision with toFixed(18), then strip trailing zeros
  let str = num.toFixed(18);
  str = str.replace(/\.?0+$/, '');
  return str || '0';
}

// Calculate the LP percentage exactly with BigInt and return a decimal string (no scientific notation)
function calcLpPercent(balanceStr, pct) {
  if (!balanceStr || parseFloat(balanceStr) <= 0 || pct <= 0) return '0';
  try {
    // Fix decimals to 18 digits and convert to BigInt
    const balWei = viemParseUnits(balanceStr, 18);
    const pctWei = (balWei * BigInt(Math.floor(pct * 100))) / 10000n; // compute pct% with integer math
    if (pctWei <= 0n) return '0';
    // Format the BigInt wei value into a plain decimal string
    const str = pctWei.toString().padStart(19, '0');
    const intPart = str.slice(0, -18);
    let decPart = str.slice(-18);
    // Strip trailing zeros
    decPart = decPart.replace(/0+$/, '');
    return decPart ? `${intPart}.${decPart}` : intPart;
  } catch {
    return '0';
  }
}

// Token id (built-in symbol / custom lowercase address) → on-chain address (native BNB maps to WBNB)
// extTokens optionally pass walletStore's customTokens (address-keyed dict)
const _isBnbAliases = (s) => s === 'BNB' || s === 'WBNB';
function symToAddr(sym, extTokens = null) {
  return tokenAddrById(sym, extTokens);
}

// Token decimals: prefer decimalsOverride read from chain (config is not hardcoded), fall back to the ERC20 standard of 18
function getTokenDecimals(sym, extTokens = null) {
  return decimalsById(sym, extTokens, useWalletStore.getState().decimalsOverride);
}

// Token → USDT price (on-chain getAmountsOut, cached)
const _usdtPriceCache = new Map();
async function getTokenUsdtPrice(tokenSym) {
  const s = _isBnbAliases(tokenSym) ? 'WBNB' : tokenSym;
  if (_usdtPriceCache.has(s)) return _usdtPriceCache.get(s);
  if (s === 'USDT') { _usdtPriceCache.set('USDT', 1); return 1; }
  const tok = TOKENS[s];
  const addr = tok?.address;
  if (!addr) return null;
  try {
    const amountInWei = parseTokenAmount('1', getTokenDecimals(s));
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



export default function LiquidityPage() {
  const { t } = useTranslation();
  const { address, connected, bnbBalance, cfoBalance, tokenBalances, customTokens, showWalletModal, setTokenDecimals, refreshBalances } = useWalletStore();
  const { openTokenSelectModal, closeTokenSelectModal, slippageBps, txDeadlineMinutes, showToast, showWalletModal: openWallet } = useUiStore();
  const { liqPair, setLiqPair } = usePrefsStore();
  // Read position data from liquidityStore
  const positions = useLiquidityStore((s) => s.positions);
  const loadingPositions = useLiquidityStore((s) => s.loadingPositions);
  const maybeRefreshPositions = useLiquidityStore((s) => s.maybeRefreshPositions);
  const invalidatePositions = useLiquidityStore((s) => s.invalidatePositions);

  const [activeTab, setActiveTab] = useState(() => {
    try {
      return localStorage.getItem('cfoswap_liquidity_tab') || 'add';
    } catch { return 'add'; }
  });
  
  // Persist the active tab to localStorage
  const handleTabChange = (tab) => {
    setActiveTab(tab);
    try { localStorage.setItem('cfoswap_liquidity_tab', tab); } catch {}
  };

  const [tokenA, setTokenA] = useState(liqPair?.tokenA || 'BNB');
  const [tokenB, setTokenB] = useState(liqPair?.tokenB || 'USDT');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [loadingAApprove, setLoadingAApprove] = useState(false);
  const [loadingBApprove, setLoadingBApprove] = useState(false);
  const [loadingAdd, setLoadingAdd] = useState(false);
  const [approvedA, setApprovedA] = useState(false);
  const [approvedB, setApprovedB] = useState(false);
  const [selectingFor, setSelectingFor] = useState(null);
  const [addPairData, setAddPairData] = useState(null); // Actual reserves of the add-liquidity pair { reserveA, reserveB, totalSupply }
  const [isNewPair, setIsNewPair] = useState(false); // New trading pair (LP not created yet; first liquidity addition)
  const [activeInput, setActiveInput] = useState('A'); // Field the user last typed in: 'A' or 'B'; used to decide the reverse-conversion direction

  const [removePct, setRemovePct] = useState(50);
  const [removeCustomPct, setRemoveCustomPct] = useState('');
  const [removeLpAmount, setRemoveLpAmount] = useState(''); // Direct LP amount input (unit: tokens, not wei)
  // Local state only tracks the selected LP; position list and loading are fetched from store
  const [selectedLp, setSelectedLp] = useState(null);
  const [lpDropdownOpen, setLpDropdownOpen] = useState(false);
  const [pairSearch, setPairSearch] = useState('');
  const [lpBalance, setLpBalance] = useState('0');
  const [loadingLpApprove, setLoadingLpApprove] = useState(false);
  const [loadingRemove, setLoadingRemove] = useState(false);
  const [lpApproved, setLpApproved] = useState(false);
  const [selectedPairReserves, setSelectedPairReserves] = useState(null); // { reserveA, reserveB, totalSupply }
  const [lpApprovalCache, setLpApprovalCache] = useState({}); // { [pairAddrLower]: { amountWei: bigint, createdAt: number(sec) } }
  // Compute if user has sufficient LP approval (optimistic cache + UI state) for the current
  // remove amount. Used to correctly enable/disable the Remove button (UI disabled should not
  // depend purely on lpApproved local flag, which only updates after allowance check runs).
  function hasSufficientLpApprovalForRemove() {
    if (!selectedLp?.pairAddr) return lpApproved;
    const pct = removePct === 'custom' ? parseFloat(removeCustomPct) || 0 : removePct;
    const currentLpBal = lpBalance || selectedLp.lpAmount || '0';
    let liquidityWei;
    try {
      if (pct >= 99.99) {
        liquidityWei = toBigIntSafe(parseTokenAmount(currentLpBal, 18)) ?? 0n;
      } else if (removeLpAmount && parseFloat(removeLpAmount) > 0) {
        liquidityWei = toBigIntSafe(parseTokenAmount(removeLpAmount, 18)) ?? 0n;
      } else {
        const totalWei = toBigIntSafe(parseTokenAmount(currentLpBal, 18)) ?? 0n;
        liquidityWei = (totalWei * BigInt(Math.round(pct * 100))) / 10000n;
      }
    } catch { liquidityWei = 0n; }
    if (liquidityWei <= 0n) return false; // no amount = no approval check needed, button disabled by other cond
    const cacheKey = viemGetAddress(selectedLp.pairAddr).toLowerCase();
    const cached = lpApprovalCache[cacheKey];
    const optimisticOk = cached && typeof cached.amountWei === 'bigint'
      && (Math.floor(Date.now() / 1000) - (cached.createdAt || 0)) < 600
      && cached.amountWei >= liquidityWei;
    if (lpApproved || optimisticOk) return true;
    // Fallback: if amount is very small (< 1 LP unit) we can't be sure, but allow user
    // to click (handleRemove will re-check allowance and trigger approve if needed)
    return false;
  }
  const canRemoveNow = hasSufficientLpApprovalForRemove();

  const slippagePercent = (slippageBps / 100).toFixed(2);

  // Built-in tokens resolved by symbol id, user-imported tokens by lowercase address id
  const tokenAData = resolveTokenById(tokenA, customTokens);
  const tokenBData = resolveTokenById(tokenB, customTokens);
  // Display symbol (custom token ids are lowercase addresses, so use the token object's symbol for display)
  const symbolA = tokenAData?.symbol || tokenA;
  const symbolB = tokenBData?.symbol || tokenB;

  const isANative = tokenA === 'BNB';
  const isBNative = tokenB === 'BNB';

  const balanceA = useMemo(() => {
    if (tokenA === 'BNB') return bnbBalance;
    if (tokenA === 'CFO') return cfoBalance;
    return tokenBalances[tokenA] || '0';
  }, [tokenA, bnbBalance, cfoBalance, tokenBalances]);

  const balanceB = useMemo(() => {
    if (tokenB === 'BNB') return bnbBalance;
    if (tokenB === 'CFO') return cfoBalance;
    return tokenBalances[tokenB] || '0';
  }, [tokenB, bnbBalance, cfoBalance, tokenBalances]);

  const priceAB = useMemo(() => {
    if (!amountA || !amountB || parseFloat(amountA) === 0) return null;
    return (parseFloat(amountB) / parseFloat(amountA)).toFixed(6);
  }, [amountA, amountB]);

  const priceBA = useMemo(() => {
    if (!amountA || !amountB || parseFloat(amountB) === 0) return null;
    return (parseFloat(amountA) / parseFloat(amountB)).toFixed(6);
  }, [amountA, amountB]);

  const lpEstimate = useMemo(() => {
    if (!amountA || !amountB) return '0';
    const a = parseFloat(amountA);
    const b = parseFloat(amountB);
    return Math.sqrt(a * b).toFixed(6);
  }, [amountA, amountB]);

  const poolShare = useMemo(() => {
    if (!lpEstimate || parseFloat(lpEstimate) === 0) return '0.00';
    if (isNewPair) return '100.00'; // A new pair means 100% share
    const newLp = parseFloat(lpEstimate);
    const existing = addPairData?.totalSupply ? parseFloat(addPairData.totalSupply) : 0;
    if (existing > 0) return ((newLp / (existing + newLp)) * 100).toFixed(4);
    return '100.00';
  }, [lpEstimate, addPairData, isNewPair]);

  const removeAmount = useMemo(() => {
    // Use raw LP amount if user typed it directly (already sanitized, no scientific notation)
    if (removeLpAmount && parseFloat(removeLpAmount) > 0) {
      return removeLpAmount;
    }
    // Otherwise calculate from percentage using exact BigInt math
    const pct = removePct === 'custom' ? parseFloat(removeCustomPct) || 0 : removePct;
    return calcLpPercent(lpBalance, pct);
  }, [removePct, removeCustomPct, lpBalance, removeLpAmount]);

  const estReceiveA = useMemo(() => {
    if (!selectedPairReserves || parseFloat(removeAmount) <= 0) return '0';
    const lp = parseFloat(removeAmount);
    const total = parseFloat(selectedPairReserves.totalSupply) || 0;
    if (total <= 0) return '0';
    return toDecimalStr(lp / total * parseFloat(selectedPairReserves.reserveA));
  }, [removeAmount, selectedPairReserves]);

  const estReceiveB = useMemo(() => {
    if (!selectedPairReserves || parseFloat(removeAmount) <= 0) return '0';
    const lp = parseFloat(removeAmount);
    const total = parseFloat(selectedPairReserves.totalSupply) || 0;
    if (total <= 0) return '0';
    return toDecimalStr(lp / total * parseFloat(selectedPairReserves.reserveB));
  }, [removeAmount, selectedPairReserves]);

  // ====== Sync from recent pair / external state: update local tokenA/tokenB when liqPair changes ======
  useEffect(() => {
    if (liqPair?.tokenA && liqPair?.tokenB) {
      setTokenA(liqPair.tokenA);
      setTokenB(liqPair.tokenB);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liqPair?.tokenA, liqPair?.tokenB]);

  // Silently refresh positions on page open/wallet change (prefer cache, no white screen)
  useEffect(() => {
    if (!connected || !address) return;
    maybeRefreshPositions(address);
  }, [connected, address, maybeRefreshPositions]);

  // After positions update from store, default to the first position
  useEffect(() => {
    if (positions.length > 0 && !selectedLp) {
      setSelectedLp(positions[0]);
      setLpBalance(positions[0].lpAmount);
      setSelectedPairReserves(positions[0].reserves);
      // Default fill 50% quantity (precise BigInt calculation)
      setRemoveLpAmount(calcLpPercent(positions[0].lpAmount, 50));
    } else if (positions.length === 0) {
      setSelectedLp(null);
      setLpBalance('0');
      setSelectedPairReserves(null);
      setRemoveLpAmount('');
    }
  }, [positions, selectedLp]);

  // Automatically check the approval status on chain when LP selection / balance / wallet changes
  useEffect(() => {
    checkLpAllowance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLp?.pairAddr, lpBalance, connected, address]);

  // Token A input → auto-compute token B (triggered only when the user last typed A, to avoid loops)
  useEffect(() => {
    if (activeInput !== 'A') return;
    if (isNewPair) return; // No auto-conversion for a new pair
    if (!amountA || parseFloat(amountA) === 0) {
      if (amountB) setAmountB('');
      return;
    }
    const timer = setTimeout(() => {
      simulateAddLiquidity();
    }, 250);
    return () => clearTimeout(timer);
  }, [amountA, tokenA, tokenB, activeInput, isNewPair, addPairData]);

  // Token B input → compute token A in the reverse direction (spot rate)
  useEffect(() => {
    if (activeInput !== 'B') return;
    if (isNewPair) return; // No auto-conversion for a new pair
    if (!amountB || parseFloat(amountB) === 0) {
      if (amountA) setAmountA('');
      return;
    }
    const timer = setTimeout(() => {
      simulateAddLiquidityReverse();
    }, 250);
    return () => clearTimeout(timer);
  }, [amountB, tokenA, tokenB, activeInput, isNewPair, addPairData]);

  // When tokenA/tokenB change, detect whether the pair is an existing LP or a new pair
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAddPairData(null);
      setIsNewPair(false);
      setAmountA('');
      setAmountB('');
      setApprovedA(false);
      setApprovedB(false);
      const aAddr = symToAddr(tokenA, customTokens);
      const bAddr = symToAddr(tokenB, customTokens);
      if (!aAddr || !bAddr || aAddr === bAddr) return;
      try {
        const pairAddr = await viemReadContract({
          address: viemGetAddress(PANCAKE_SWAP_FACTORY_V2),
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [viemGetAddress(aAddr), viemGetAddress(bAddr)],
        });
        if (cancelled) return;
        if (!pairAddr || pairAddr === viemZeroAddress) {
          // LP does not exist → new trading pair
          setIsNewPair(true);
        } else {
          // LP exists → load its reserves
          const pairData = await loadPairReserves(tokenA, tokenB, customTokens);
          if (!cancelled && pairData) {
            setAddPairData(pairData);
          } else if (!cancelled) {
            setIsNewPair(true);
          }
        }
      } catch (e) {
        console.warn('[liquidity] detect pair failed:', e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenA, tokenB, customTokens]);

  // Always check approval status whenever amounts are entered (both new and existing pairs)
  useEffect(() => {
    if (!connected) {
      setApprovedA(false);
      setApprovedB(false);
      return;
    }
    const timer = setTimeout(() => {
      checkApprovals();
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountA, amountB, connected, tokenA, tokenB]);

  // When entering or switching pairs, fetch token A/B decimals from chain and write them to decimalsOverride (config is not hardcoded)
  useEffect(() => {
    const aAddr = symToAddr(tokenA, customTokens);
    const bAddr = symToAddr(tokenB, customTokens);
    const addrs = [aAddr, bAddr].filter(a => a && a !== viemZeroAddress);
    if (addrs.length === 0) return;
    let cancelled = false;
    (async () => {
      await Promise.all(addrs.map(async (a) => {
        try {
          const d = await fetchDecimals(a);
          if (!cancelled) setTokenDecimals(a, d);
        } catch (e) {
          console.warn('[liquidity] fetch decimals failed:', a, e?.message || String(e));
        }
      }));
    })();
    return () => { cancelled = true; };
  }, [tokenA, tokenB, customTokens]);

  // After reserve data loads, if user has already entered amounts (A or B), trigger another conversion (avoid race: addPairData completes async, but amountX effect won't rerun)
  useEffect(() => {
    if (isNewPair) return;
    if (!addPairData) return;
    if (activeInput === 'A' && amountA && parseFloat(amountA) > 0 && !amountB) {
      setTimeout(() => simulateAddLiquidity(), 0);
    } else if (activeInput === 'B' && amountB && parseFloat(amountB) > 0 && !amountA) {
      setTimeout(() => simulateAddLiquidityReverse(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPairData, isNewPair]);

  // Reload balances and pool reserves (uses the wallet store's refreshBalances)
  async function loadBalances() {
    try {
      await refreshBalances();
    } catch (e) {
      console.warn('[liquidity] refreshBalances failed', e);
    }
    // Also reload the current pair's reserves (they change after add/remove)
    if (!isNewPair && tokenA && tokenB && tokenA !== tokenB) {
      try {
        const pairData = await loadPairReserves(tokenA, tokenB, customTokens);
        if (pairData) setAddPairData(pairData);
      } catch (e) {
        console.warn('[liquidity] reload reserves failed', e);
      }
    }
  }

  // Read the actual reserves and total supply of a trading pair
  async function loadPairReserves(aSym, bSym, extTokens = null) {
    const aAddr = symToAddr(aSym, extTokens);
    const bAddr = symToAddr(bSym, extTokens);
    if (!aAddr || !bAddr) return null;
    try {
      const pairAddr = await viemReadContract({
        address: viemGetAddress(PANCAKE_SWAP_FACTORY_V2),
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [viemGetAddress(aAddr), viemGetAddress(bAddr)],
      });
      if (!pairAddr || pairAddr === viemZeroAddress) return null;
      const pairAddrChecksum = viemGetAddress(pairAddr);
      const [token0Addr, token1Addr, reserves, totalSupply] = await Promise.all([
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token0' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token1' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'getReserves' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'totalSupply' }).catch(() => 0n),
      ]);
      if (!token0Addr || !token1Addr || !reserves) return null;
      const t0 = token0Addr.toLowerCase();
      const t1 = token1Addr.toLowerCase();
      const aLow = aAddr.toLowerCase();
      const bLow = bAddr.toLowerCase();
      let reserveA, reserveB;
      if (aLow === t0 && bLow === t1) { reserveA = reserves[0]; reserveB = reserves[1]; }
      else if (aLow === t1 && bLow === t0) { reserveA = reserves[1]; reserveB = reserves[0]; }
      else return null;
      const decA = getTokenDecimals(aSym, extTokens);
      const decB = getTokenDecimals(bSym, extTokens);
      return {
        reserveA: viemFormatUnits(reserveA, decA),
        reserveB: viemFormatUnits(reserveB, decB),
        totalSupply: viemFormatUnits(totalSupply, 18),
      };
    } catch (e) {
      console.warn('[liquidity] loadPairReserves failed', aSym, bSym, e?.message || String(e));
      return null;
    }
  }

  // Add liquidity: token A input → auto-compute token B at the pool spot rate (reserveB/reserveA)
  // Note: getAmountsOut is for swaps (includes fee + slippage), so it is unsuitable for adding liquidity
  function simulateAddLiquidity() {
    try {
      if (isNewPair) return;
      const aNorm = _isBnbAliases(tokenA) ? 'WBNB' : tokenA;
      const bNorm = _isBnbAliases(tokenB) ? 'WBNB' : tokenB;
      if (aNorm === bNorm) {
        setAmountB(amountA);
        checkApprovals();
        return;
      }
      if (!amountA || parseFloat(amountA) === 0) {
        setAmountB('');
        return;
      }
      // Skip if addPairData is still loading (the effect will rerun later)
      if (!addPairData) return;
      const rA = parseFloat(addPairData.reserveA);
      const rB = parseFloat(addPairData.reserveB);
      if (!rA || rA <= 0 || !rB) {
        // Zero reserves are equivalent to a new pair; do not auto-compute
        return;
      }
      const amtA = parseFloat(amountA);
      const amtB = amtA * (rB / rA);
      if (isNaN(amtB) || !isFinite(amtB) || amtB <= 0) {
        setAmountB('');
        return;
      }
      setAmountB(amtB.toFixed(6).replace(/\.?0+$/, ''));
      checkApprovals();
    } catch (e) {
      console.error('simulate add liq failed', e);
    }
  }

  // Reverse direction: token B input → derive token A at the spot rate
  function simulateAddLiquidityReverse() {
    try {
      if (isNewPair) return;
      const aNorm = _isBnbAliases(tokenA) ? 'WBNB' : tokenA;
      const bNorm = _isBnbAliases(tokenB) ? 'WBNB' : tokenB;
      if (aNorm === bNorm) {
        setAmountA(amountB);
        checkApprovals();
        return;
      }
      if (!amountB || parseFloat(amountB) === 0) {
        setAmountA('');
        return;
      }
      if (!addPairData) return;
      const rA = parseFloat(addPairData.reserveA);
      const rB = parseFloat(addPairData.reserveB);
      if (!rA || !rB || rB <= 0) return;
      const amtB = parseFloat(amountB);
      const amtA = amtB * (rA / rB);
      if (isNaN(amtA) || !isFinite(amtA) || amtA <= 0) {
        setAmountA('');
        return;
      }
      setAmountA(amtA.toFixed(6).replace(/\.?0+$/, ''));
      checkApprovals();
    } catch (e) {
      console.error('simulate add liq reverse failed', e);
    }
  }

  async function checkApprovals() {
    try {
      if (!isANative && tokenAData && amountA) {
        const amtWei = toBigIntSafe(parseTokenAmount(amountA || '0', getTokenDecimals(tokenA))) ?? 0n;
        if (amtWei > 0n) {
          const allowance = await viemReadContract({
            address: viemGetAddress(tokenAData.address),
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [viemGetAddress(address), viemGetAddress(PANCAKE_SWAP_ROUTER_V2)],
          });
          const allowanceBi = toBigIntSafe(allowance) ?? 0n;
          setApprovedA(allowanceBi >= amtWei);
        }
      } else {
        setApprovedA(true);
      }
      if (!isBNative && tokenBData && amountB) {
        const amtWei = toBigIntSafe(parseTokenAmount(amountB || '0', getTokenDecimals(tokenB))) ?? 0n;
        if (amtWei > 0n) {
          const allowance = await viemReadContract({
            address: viemGetAddress(tokenBData.address),
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [viemGetAddress(address), viemGetAddress(PANCAKE_SWAP_ROUTER_V2)],
          });
          const allowanceBi = toBigIntSafe(allowance) ?? 0n;
          setApprovedB(allowanceBi >= amtWei);
        }
      } else {
        setApprovedB(true);
      }
    } catch (e) {
      console.error('check approvals failed', e);
    }
  }

  // MAX button: auto-fill the largest amount supportable by both balances, following the existing pool ratio
  function handleMax(isA) {
    // Only works when existing liquidity is present (requires addPairData)
    if (isNewPair || !addPairData) {
      // For a new pair, simply fill in the balance
      if (isA) { setActiveInput('A'); setAmountA(balanceA); }
      else { setActiveInput('B'); setAmountB(balanceB); }
      return;
    }
    const decA = getTokenDecimals(tokenA);
    const decB = getTokenDecimals(tokenB);
    const balA = parseFloat(balanceA) || 0;
    const balB = parseFloat(balanceB) || 0;
    const rA = parseFloat(addPairData.reserveA) || 0;
    const rB = parseFloat(addPairData.reserveB) || 0;
    if (rA <= 0 || rB <= 0 || balA <= 0) {
      // If reserves fail to load, simply fill MAX
      if (isA) { setActiveInput('A'); setAmountA(balanceA); }
      else { setActiveInput('B'); setAmountB(balanceB); }
      return;
    }
    // Ratio: B/A
    const ratio = rB / rA;
    let finalA, finalB;
    if (isA) {
      // Set A to MAX and compute the required B
      const neededB = balA * ratio;
      if (neededB <= balB) {
        finalA = balA;
        finalB = neededB;
      } else {
        // B insufficient → set B to MAX and derive A
        finalB = balB;
        finalA = balB / ratio;
      }
    } else {
      // Set B to MAX and compute the required A
      const neededA = balB / ratio;
      if (neededA <= balA) {
        finalB = balB;
        finalA = neededA;
      } else {
        // A insufficient → set A to MAX and derive B
        finalA = balA;
        finalB = balA * ratio;
      }
    }
    // Round to 6 decimal places (round slightly down so the result is never 0 and never exceeds the balance)
    const fmt = (v, bal) => {
      if (v <= 0) return '0';
      // Hold back 0.01% so the value never exceeds the balance
      const capped = Math.min(v, bal * 0.9999);
      return capped.toFixed(6).replace(/\.?0+$/, '');
    };
    const aStr = fmt(finalA, balA);
    const bStr = fmt(finalB, balB);
    // Set activeInput to null so the auto-conversion effects don't fire, then set both amounts
    setActiveInput(null);
    setAmountA(aStr);
    setAmountB(bStr);
    // Run the approval check with a slight delay
    setTimeout(() => checkApprovals(), 100);
  }

  function openTokenSelect(which) {
    setSelectingFor(which);
    openTokenSelectModal(which, (sym) => {
      if (which === 'A') {
        setTokenA(sym);
        try { setLiqPair(sym, tokenB); } catch (e) {}
      } else {
        setTokenB(sym);
        try { setLiqPair(tokenA, sym); } catch (e) {}
      }
      setApprovedA(false);
      setApprovedB(false);
      closeTokenSelectModal();
      setSelectingFor(null);
    });
  }

  async function handleApprove(isA, exactAmountWei = null) {
    if (!connected) { openWallet(); return false; }
    const tokData = isA ? tokenAData : tokenBData;
    if (!tokData) return false;
    if (isA) setLoadingAApprove(true); else setLoadingBApprove(true);
    try {
      // FS-001 FIX: Calculate exact amount internally if caller forgot; NEVER fall back to MAX
      // Safety: ignore React SyntheticEvent / accidental click event objects (onClick={handleApprove} pattern)
      const hasValidParam = exactAmountWei != null && (
        typeof exactAmountWei !== 'object' ||
        exactAmountWei._hex != null || exactAmountWei.hex != null ||
        exactAmountWei.wei != null || exactAmountWei.value != null ||
        exactAmountWei.result != null || exactAmountWei._isBigNumber === true
      );
      let approvalAmount;
      if (hasValidParam) {
        const bi = toBigIntSafe(exactAmountWei);
        if (bi == null) throw new Error(`Invalid amount: ${typeof exactAmountWei}`);
        approvalAmount = bi;
      } else {
        const amtStr = isA ? amountA : amountB;
        const amtRawWei = toBigIntSafe(parseTokenAmount(amtStr || '0', tokData.decimals || 18)) ?? 0n;
        if (amtRawWei <= 0n) {
          showToast('error', t('enter_valid_amount', '请输入有效金额'));
          return false;
        }
        approvalAmount = amtRawWei;
      }
      // Safety net: never allow MAX_UINT256 to reach chain
      if (approvalAmount >= VIEM_MAX_UINT256) {
        throw new Error('Unlimited approval is blocked for safety');
      }
      const routerAddr = viemGetAddress(PANCAKE_SWAP_ROUTER_V2);
      const tokAddr = viemGetAddress(tokData.address);
      // viem version: approve — exact amount, never unlimited allowance (P0-02 fix)
      showToast('info', t('please_wallet_sign', '请在钱包中签名确认授权...'));
      const { hash } = await viemWriteContract({
        address: tokAddr,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [routerAddr, approvalAmount],
      });
      showToast('info', t('tx_submitted_wait', '签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      if (isA) setApprovedA(true); else setApprovedB(true);
      showToast('success', t('approved_token', '已授权 {symbol}').replace('{symbol}', isA ? tokenA : tokenB));
      return true;
    } catch (e) {
      console.error('[liquidity][viem] approve failed', e);
      const errMsg = e?.message || e?.cause?.message || e?.shortMessage || String(e) || '';
      if (e?.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied')) {
        showToast('error', t('user_rejected_approve', '用户拒绝授权'));
      } else {
        const friendly = translateEvmError(errMsg);
        showToast('error', `${t('approve_failed', '授权失败')}: ${friendly || errMsg || '未知错误'}`);
      }
      return false;
    } finally {
      if (isA) setLoadingAApprove(false); else setLoadingBApprove(false);
    }
  }

  async function handleAddLiquidity() {
    if (!connected) { openWallet(); return; }
    if (!hasBothAmounts) return;
    setLoadingAdd(true);
    try {
      const amtAWei = toBigIntSafe(parseTokenAmount(amountA || '0', getTokenDecimals(tokenA))) ?? 0n;
      const amtBWei = toBigIntSafe(parseTokenAmount(amountB || '0', getTokenDecimals(tokenB))) ?? 0n;
      if (amtAWei <= 0n || amtBWei <= 0n) { setLoadingAdd(false); return; }

      // Approval check - read via public RPC (no signer needed)
      let needApproveA = false;
      let needApproveB = false;
      
      if (!isANative && tokenAData) {
        try {
          const allowanceA = await viemReadContract({
            address: viemGetAddress(tokenAData.address),
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [viemGetAddress(address), viemGetAddress(PANCAKE_SWAP_ROUTER_V2)],
          });
          const allowanceABi = toBigIntSafe(allowanceA) ?? 0n;
          if (allowanceABi < amtAWei) needApproveA = true;
        } catch (e) {
          // On RPC error, fall back to React state
          if (!approvedA) needApproveA = true;
        }
      } else if (!isANative && !approvedA) {
        needApproveA = true;
      }
      
      if (!isBNative && tokenBData) {
        try {
          const allowanceB = await viemReadContract({
            address: viemGetAddress(tokenBData.address),
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [viemGetAddress(address), viemGetAddress(PANCAKE_SWAP_ROUTER_V2)],
          });
          const allowanceBBi = toBigIntSafe(allowanceB) ?? 0n;
          if (allowanceBBi < amtBWei) needApproveB = true;
        } catch (e) {
          if (!approvedB) needApproveB = true;
        }
      } else if (!isBNative && !approvedB) {
        needApproveB = true;
      }
      
      if (needApproveA) {
        setLoadingAdd(false);
        await handleApprove(true, amtAWei);
        return;
      }
      if (needApproveB) {
        setLoadingAdd(false);
        await handleApprove(false, amtBWei);
        return;
      }

      // P1-02 fix: unified deadline from prefsStore, default TX_DEADLINE_MINUTES fallback
      const deadlineMin = Number(txDeadlineMinutes) || TX_DEADLINE_MINUTES;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);
      const aAddr = symToAddr(tokenA);
      const bAddr = symToAddr(tokenB);
      const slip = slippageBps || DEFAULT_SLIPPAGE;
      const amountAMin = (amtAWei * BigInt(10000 - slip)) / 10000n;
      const amountBMin = (amtBWei * BigInt(10000 - slip)) / 10000n;
      const routerAddr = viemGetAddress(PANCAKE_SWAP_ROUTER_V2);
      const userAddr = viemGetAddress(address);
      
      showToast('info', t('please_wallet_sign', '请在钱包中签名确认添加流动性...'));
      
      if (isANative && !isBNative) {
        // BNB + Token: addLiquidityETH
        const { hash } = await viemWriteContract({
          address: routerAddr,
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'addLiquidityETH',
          args: [viemGetAddress(bAddr), amtBWei, amountBMin, amountAMin, userAddr, deadline],
          value: amtAWei,
          gas: 1500000n,
        });
        showToast('info', t('tx_submitted_wait', '签名成功，等待链上确认...'));
        await viemWaitForTransaction(hash);
      } else if (!isANative && isBNative) {
        // Token + BNB: addLiquidityETH
        const { hash } = await viemWriteContract({
          address: routerAddr,
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'addLiquidityETH',
          args: [viemGetAddress(aAddr), amtAWei, amountAMin, amountBMin, userAddr, deadline],
          value: amtBWei,
          gas: 1500000n,
        });
        showToast('info', t('tx_submitted_wait', '签名成功，等待链上确认...'));
        await viemWaitForTransaction(hash);
      } else {
        // Token + Token: addLiquidity
        const { hash } = await viemWriteContract({
          address: routerAddr,
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'addLiquidity',
          args: [viemGetAddress(aAddr), viemGetAddress(bAddr), amtAWei, amtBWei, amountAMin, amountBMin, userAddr, deadline],
          value: 0n,
          gas: 1500000n,
        });
        showToast('info', t('tx_submitted_wait', '签名成功，等待链上确认...'));
        await viemWaitForTransaction(hash);
      }
      
      setAmountA('');
      setAmountB('');
      showToast('success', t('add_liquidity_success', '流动性添加成功'));
      loadBalances();
      // Invalidate position cache, silently refresh latest data in background
      invalidatePositions();
      useLiquidityStore.getState().fetchPositions({ silent: true, userAddr: address });
    } catch (e) {
      console.error('[liquidity][viem] add liquidity failed:', e);
      const errMsg = e?.message || e?.cause?.message || '';
      if (e?.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied')) {
        showToast('error', t('user_rejected_tx', '用户拒绝交易'));
      } else {
        if (errMsg.includes('INSUFFICIENT') || errMsg.includes('allowance') || errMsg.includes('transferFrom')) {
          showToast('error', t('approve_failed', '授权不足，请重新授权'));
        } else {
          showToast('error', t('add_liquidity_failed', '添加流动性失败'));
        }
      }
    } finally {
      setLoadingAdd(false);
    }
  }

  // Check the LP approval status on chain
  async function checkLpAllowance() {
    if (!connected || !selectedLp?.pairAddr || !address) {
      setLpApproved(false);
      return;
    }
    try {
      const routerAddr = viemGetAddress(PANCAKE_SWAP_ROUTER_V2);
      const userAddr = viemGetAddress(address);
      const lpAddr = viemGetAddress(selectedLp.pairAddr);
      // Read the balance directly from selectedLp.lpAmount (avoids state-update timing issues)
      const currentLpBalance = selectedLp.lpAmount || lpBalance || '0';
      // LP tokens are ERC20, so use ERC20_ABI
      const allowance = await viemReadContract({
        address: lpAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [userAddr, routerAddr],
      });
      // Approved if allowance covers the balance (unlimited approvals have a very large allowance, so this condition covers them too)
      const lpBalanceWei = toBigIntSafe(parseTokenAmount(currentLpBalance, 18)) ?? 0n;
      const allowanceBi = toBigIntSafe(allowance) ?? 0n;
      const isApproved = allowanceBi >= lpBalanceWei;
      setLpApproved(isApproved);
      if (import.meta.env.DEV) {
        console.log('[liquidity] check LP allowance:', { pair: selectedLp.pair, lpBalance: lpBalanceWei.toString(), allowance: allowanceBi.toString(), isApproved });
      }
    } catch (e) {
      console.error('[liquidity][viem] check LP allowance failed', e);
      setLpApproved(false);
    }
  }

  async function handleApproveLp(exactLpWei = null) {
    if (!connected) { openWallet(); return false; }
    if (!selectedLp?.pairAddr) {
      showToast('error', t('select_lp_first', '请先选择LP交易对'));
      return false;
    }
    setLoadingLpApprove(true);
    try {
      // FS-001 FIX: Calculate exact amount internally if caller forgot; NEVER fall back to MAX
      // Safety: ignore React SyntheticEvent / accidental click event objects (onClick={handleApproveLp} pattern)
      const hasValidParam = exactLpWei != null && (
        typeof exactLpWei !== 'object' ||
        exactLpWei._hex != null || exactLpWei.hex != null ||
        exactLpWei.wei != null || exactLpWei.value != null ||
        exactLpWei.result != null || exactLpWei._isBigNumber === true
      );
      let approvalAmount;
      if (hasValidParam) {
        const bi = toBigIntSafe(exactLpWei);
        if (bi == null) throw new Error(`Invalid LP amount: ${typeof exactLpWei}`);
        approvalAmount = bi;
      } else {
        const currentLpBal = lpBalance || selectedLp.lpAmount || '0';
        const pct = removePct === 'custom' ? parseFloat(removeCustomPct) || 0 : removePct;
        let liquidityWei;
        if (pct >= 99.99) {
          liquidityWei = toBigIntSafe(parseTokenAmount(currentLpBal, 18)) ?? 0n;
        } else if (removeLpAmount && parseFloat(removeLpAmount) > 0) {
          liquidityWei = toBigIntSafe(parseTokenAmount(removeLpAmount, 18)) ?? 0n;
        } else {
          const totalWei = toBigIntSafe(parseTokenAmount(currentLpBal, 18)) ?? 0n;
          liquidityWei = (totalWei * BigInt(Math.round(pct * 100))) / 10000n;
        }
        if (liquidityWei <= 0n) {
          showToast('error', t('enter_valid_amount', '请输入有效金额'));
          return false;
        }
        approvalAmount = liquidityWei;
      }
      if (approvalAmount >= VIEM_MAX_UINT256) {
        throw new Error('Unlimited approval is blocked for safety');
      }
      const pairAddr = viemGetAddress(selectedLp.pairAddr);
      const routerAddr = viemGetAddress(PANCAKE_SWAP_ROUTER_V2);
      // viem version: LP approval — exact amount, never unlimited allowance (P0-02 fix)
      showToast('info', t('approve_lp_with_amount', { amount: approvalAmount.toString().slice(0, 10) }));
      const { hash } = await viemWriteContract({
        address: pairAddr,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [routerAddr, approvalAmount],
      });
      showToast('info', t('tx_submitted_wait', '签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      // Update optimistic approval cache immediately so handleRemove allowance check skips
      // the re-approval even if RPC hasn't synced yet (prevents repeated auth popups)
      const pairKey = pairAddr.toLowerCase();
      const cached = lpApprovalCache[pairKey];
      const existingWei = cached?.amountWei || 0n;
      setLpApprovalCache({
        ...lpApprovalCache,
        [pairKey]: {
          amountWei: existingWei > approvalAmount ? existingWei : approvalAmount, // take max in case multiple approvals
          createdAt: Math.floor(Date.now() / 1000),
        },
      });
      setLpApproved(true);
      showToast('success', t('approve_success', '授权成功'));
      return true;
    } catch (e) {
      console.error('[liquidity][viem] approve LP failed', e);
      const errMsg = e?.message || e?.cause?.message || e?.shortMessage || String(e) || '';
      if (e?.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied')) {
        showToast('error', t('user_rejected_approve', '用户拒绝授权'));
      } else {
        const friendly = translateEvmError(errMsg);
        showToast('error', `${t('approve_failed', '授权失败')}: ${friendly || errMsg || '未知错误'}`);
      }
      return false;
    } finally {
      setLoadingLpApprove(false);
    }
  }

  async function handleRemove() {
    if (!connected) { openWallet(); return; }
    if (!selectedLp?.pairAddr) {
      showToast('error', t('select_lp_first', '请先选择LP交易对'));
      return;
    }

    // Calculate LP amount FIRST — needed for both exact approval and remove call
    const currentLpBal = lpBalance || selectedLp.lpAmount || '0';
    const pct = removePct === 'custom' ? parseFloat(removeCustomPct) || 0 : removePct;
    let liquidityWei;
    if (pct >= 99.99) {
      liquidityWei = toBigIntSafe(parseTokenAmount(currentLpBal, 18)) ?? 0n;
    } else if (removeLpAmount && parseFloat(removeLpAmount) > 0) {
      liquidityWei = toBigIntSafe(parseTokenAmount(removeLpAmount, 18)) ?? 0n;
    } else {
      const totalWei = toBigIntSafe(parseTokenAmount(currentLpBal, 18)) ?? 0n;
      liquidityWei = (totalWei * BigInt(Math.round(pct * 100))) / 10000n;
    }
    if (liquidityWei <= 0n) {
      showToast('error', t('invalid_amount', '请输入有效的移除数量'));
      return;
    }

    // P0-02 fix: check LP allowance on-chain, approve exact liquidityWei if insufficient (not MAX)
    // P1-03: plus optimistic approval cache to avoid repeated auth when RPC hasn't synced yet
    const pairAddr = viemGetAddress(selectedLp.pairAddr);
    const routerAddrStr = PANCAKE_SWAP_ROUTER_V2;
    const userAddrStr = address;
    const pairKey = pairAddr.toLowerCase();
    let allowance = 0n;
    try {
      const allowanceRaw = await viemReadContract({
        address: pairAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [viemGetAddress(userAddrStr), viemGetAddress(routerAddrStr)],
      });
      allowance = toBigIntSafe(allowanceRaw) ?? 0n;
    } catch {
      allowance = 0n;
    }
    // Check optimistic cache: if RPC hasn't caught up but user recently approved >= required
    const optimistic = lpApprovalCache[pairKey];
    const nowSec = Math.floor(Date.now() / 1000);
    const optimisticValid = optimistic && typeof optimistic.amountWei === 'bigint'
      && (nowSec - (optimistic.createdAt || 0)) < 600 // valid within 10 minutes
      && optimistic.amountWei >= liquidityWei;
    if (allowance < liquidityWei && !optimisticValid) {
      const ok = await handleApproveLp(liquidityWei);
      if (!ok) return;
    } else {
      setLpApproved(true);
      if (optimisticValid && import.meta.env.DEV) {
        console.log(`[liquidity][remove] using optimistic allowance cache: ${optimistic.amountWei.toString()} >= required ${liquidityWei.toString()}`);
      }
    }
    
    setLoadingRemove(true);
    try {
      const routerAddr = viemGetAddress(routerAddrStr);
      // P1-02 fix: unified deadline
      const deadlineMin = Number(txDeadlineMinutes) || TX_DEADLINE_MINUTES;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);
      const userAddr = viemGetAddress(userAddrStr);
      const wbnbAddrLower = TOKENS.WBNB.address.toLowerCase();
      
      showToast('info', t('loading', '加载中...'));
      
      // P0-01 fix: read token order + reserves + totalSupply, compute safe amountMin instead of 0n
      const [token0Addr, token1Addr, reserves, totalSupply] = await Promise.all([
        viemReadContract({ address: pairAddr, abi: PAIR_ABI, functionName: 'token0' }),
        viemReadContract({ address: pairAddr, abi: PAIR_ABI, functionName: 'token1' }),
        viemReadContract({ address: pairAddr, abi: PAIR_ABI, functionName: 'getReserves' }),
        viemReadContract({ address: pairAddr, abi: PAIR_ABI, functionName: 'totalSupply' }),
      ]);
      
      const token0 = viemGetAddress(token0Addr);
      const token1 = viemGetAddress(token1Addr);
      const [reserve0Raw, reserve1Raw] = reserves;
      const reserve0 = toBigIntSafe(reserve0Raw) ?? 0n;
      const reserve1 = toBigIntSafe(reserve1Raw) ?? 0n;
      const totalSupplyBi = toBigIntSafe(totalSupply) ?? 0n;
      
      // Compute theoretical withdrawable amounts based on LP share, then apply slippage floor
      // FS-002 FIX: NEVER keep 0n as fallback. If calc fails, abort the entire transaction to prevent sandwich attack.
      let amount0Min = 0n;
      let amount1Min = 0n;
      let amountMinCalcSucceeded = false;
      try {
        if (totalSupplyBi > 0n && reserve0 > 0n && reserve1 > 0n) {
          const theoreticalToken0 = (liquidityWei * reserve0) / totalSupplyBi;
          const theoreticalToken1 = (liquidityWei * reserve1) / totalSupplyBi;
          const slipBps = BigInt(slippageBps || DEFAULT_SLIPPAGE);
          amount0Min = (theoreticalToken0 * (10000n - slipBps)) / 10000n;
          amount1Min = (theoreticalToken1 * (10000n - slipBps)) / 10000n;
          amountMinCalcSucceeded = true;
        }
      } catch (calcErr) {
        console.error('[liquidity][remove] amountMin calc FAILED (aborted):', calcErr);
      }
      // FINAL SAFETY CHECK: abort if EITHER min is still 0n. Attackers can sandwich the 0n side even if the other side is positive.
      if (!amountMinCalcSucceeded || amount0Min <= 0n || amount1Min <= 0n) {
        showToast('error', t('rpc_read_failed_retry', '链上数据读取失败，请稍后重试'));
        throw new Error('Aborted: amountMin calc failed or either amount is 0n (sandwich attack hardening)');
      }
      
      // Determine if it's a BNB trading pair
      const isT0Wbnb = token0.toLowerCase() === wbnbAddrLower;
      const isT1Wbnb = token1.toLowerCase() === wbnbAddrLower;
      const isEthPair = isT0Wbnb || isT1Wbnb;
      
      if (import.meta.env.DEV) {
        console.log('[liquidity][remove] params:', {
          token0, token1, pairAddr, isEthPair, isT0Wbnb, isT1Wbnb,
          liquidityWei: liquidityWei.toString(),
          amount0Min: amount0Min.toString(),
          amount1Min: amount1Min.toString(),
          pct,
        });
      }
      
      showToast('info', t('please_wallet_sign', '请在钱包中签名确认移除流动性...'));
      
      let txHash;
      if (isEthPair) {
        // BNB pair: removeLiquidityETHSupportingFeeOnTransferTokens
        // Param order: token, liquidity, amountTokenMin, amountETHMin, to, deadline
        const nonWbnbToken = isT0Wbnb ? token1 : token0;
        const amountTokenMin = isT0Wbnb ? amount1Min : amount0Min;
        const amountEthMin = isT0Wbnb ? amount0Min : amount1Min;
        if (import.meta.env.DEV) {
          console.log('[liquidity][remove] removeLiquidityETHSupportingFeeOnTransferTokens, token:', nonWbnbToken);
          // Strict type assertion: if any param is wrong type, throw NOW instead of wallet silently graying sign button
          (function assertTypes() {
            const args = [nonWbnbToken, liquidityWei, amountTokenMin, amountEthMin, userAddr, deadline];
            const names = ['nonWbnbToken','liquidityWei','amountTokenMin','amountEthMin','userAddr','deadline'];
            const expected = ['address','bigint','bigint','bigint','address','bigint'];
            args.forEach((v, i) => {
              const exp = expected[i];
              const isAddr = typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
              const isOk = exp === 'bigint' ? typeof v === 'bigint' : isAddr;
              const preview = typeof v === 'bigint' ? v.toString()
                : (typeof v === 'object' ? ('OBJ:' + JSON.stringify(v, (_,val) => typeof val === 'bigint' ? val.toString() : val).slice(0,200))
                : String(v).slice(0,120));
              console.log(`[liquidity][remove][param-type] ${names[i]}: expected ${exp}, typeof=${typeof v}, ok=${isOk}, val=${preview}`);
              if (!isOk) throw new Error(`[remove] Invalid param type: ${names[i]} expected ${exp}, got typeof=${typeof v}, val=${preview.slice(0,200)}`);
            });
          })();
        }

        const { hash } = await viemWriteContract({
          address: routerAddr,
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'removeLiquidityETHSupportingFeeOnTransferTokens',
          args: [nonWbnbToken, liquidityWei, amountTokenMin, amountEthMin, userAddr, deadline],
          value: 0n,
          gas: 2000000n,
        });
        txHash = hash;
      } else {
        // Regular token pair: use standard removeLiquidity function
        if (import.meta.env.DEV) {
          console.log('[liquidity][remove] removeLiquidity, token0:', token0, 'token1:', token1);
          // Strict type assertion: if any param is wrong type, throw NOW instead of wallet silently graying sign button
          (function assertTypes() {
            const args = [token0, token1, liquidityWei, amount0Min, amount1Min, userAddr, deadline];
            const names = ['token0','token1','liquidityWei','amount0Min','amount1Min','userAddr','deadline'];
            const expected = ['address','address','bigint','bigint','bigint','address','bigint'];
            args.forEach((v, i) => {
              const exp = expected[i];
              const isAddr = typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
              const isOk = exp === 'bigint' ? typeof v === 'bigint' : isAddr;
              const preview = typeof v === 'bigint' ? v.toString()
                : (typeof v === 'object' ? ('OBJ:' + JSON.stringify(v, (_,val) => typeof val === 'bigint' ? val.toString() : val).slice(0,200))
                : String(v).slice(0,120));
              console.log(`[liquidity][remove][param-type] ${names[i]}: expected ${exp}, typeof=${typeof v}, ok=${isOk}, val=${preview}`);
              if (!isOk) throw new Error(`[remove] Invalid param type: ${names[i]} expected ${exp}, got typeof=${typeof v}, val=${preview.slice(0,200)}`);
            });
          })();
        }

        const { hash } = await viemWriteContract({
          address: routerAddr,
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'removeLiquidity',
          args: [token0, token1, liquidityWei, amount0Min, amount1Min, userAddr, deadline],
          value: 0n,
          gas: 2000000n,
        });
        txHash = hash;
      }
      
      showToast('info', t('tx_submitted_wait', '签名成功，等待链上确认...'));
      await viemWaitForTransaction(txHash);
      
      // Optimistic UI update
      const isFullRemove = pct >= 99.99;
      const currentPositions = useLiquidityStore.getState().positions;
      
      if (isFullRemove) {
        const updatedPositions = currentPositions.filter(p => p.pairAddr.toLowerCase() !== selectedLp.pairAddr.toLowerCase());
        useLiquidityStore.setState({ positions: updatedPositions });
        setSelectedLp(null);
        setLpBalance('0');
        setSelectedPairReserves(null);
      } else {
        const removeRatio = pct / 100;
        const updatedPositions = currentPositions.map(p => {
          if (p.pairAddr.toLowerCase() !== selectedLp.pairAddr.toLowerCase()) return p;
          const newLpAmount = (parseFloat(p.lpAmount) * (1 - removeRatio)).toFixed(18);
          const newAmountA = (parseFloat(p.amountA) * (1 - removeRatio)).toFixed(6);
          const newAmountB = (parseFloat(p.amountB) * (1 - removeRatio)).toFixed(6);
          return { ...p, lpAmount: newLpAmount, amountA: newAmountA, amountB: newAmountB };
        });
        useLiquidityStore.setState({ positions: updatedPositions });
        const updatedSelected = updatedPositions.find(p => p.pairAddr.toLowerCase() === selectedLp.pairAddr.toLowerCase());
        if (updatedSelected) {
          setSelectedLp(updatedSelected);
          setLpBalance(updatedSelected.lpAmount);
        }
      }
      
      setRemovePct(50);
      setRemoveCustomPct('');
      setRemoveLpAmount('');
      showToast('success', t('remove_success', '流动性移除成功'));
      loadBalances();
      invalidatePositions();
      useLiquidityStore.getState().fetchPositions({ userAddr: address, silent: true });
    } catch (e) {
      console.error('[liquidity][remove] failed', e);
      const errMsg = e?.message || e?.cause?.message || e?.shortMessage || String(e);
      if (e?.code === 4001 || errMsg.includes('rejected') || errMsg.includes('denied') || errMsg.includes('User denied')) {
        showToast('error', t('user_rejected_tx', '用户拒绝交易'));
      } else {
        showToast('error', t('tx_failed', '交易失败') + ': ' + errMsg.slice(0, 300));
      }
    } finally {
      setLoadingRemove(false);
    }
  }

  const hasBothAmounts = amountA && parseFloat(amountA) > 0 && amountB && parseFloat(amountB) > 0;
  const balanceAInsufficient = amountA && parseFloat(balanceA) < parseFloat(amountA);
  const balanceBInsufficient = amountB && parseFloat(balanceB) < parseFloat(amountB);

  // Show the empty state when connected with no holdings; loading/connecting states are handled by the logic below
  const displayPositions = connected ? positions : [];

  // Determine if input is a 0x-prefixed contract address
  const isAddressInput = useMemo(() => {
    const q = pairSearch.trim();
    return q.startsWith('0x') && q.length >= 40 && q.length <= 42;
  }, [pairSearch]);

  // LP search filter: match against the user's held pairs based on the input
  const filteredSearchPairs = useMemo(() => {
    const q = pairSearch.trim().toLowerCase();
    if (!q || isAddressInput) return [];
    // Only search matches within user's held positions
    return displayPositions.filter(lp => {
      const pairName = lp.pair.toLowerCase();
      const aSym = lp.tokenA.toLowerCase();
      const bSym = lp.tokenB.toLowerCase();
      return pairName.includes(q) || aSym.includes(q) || bSym.includes(q);
    });
  }, [pairSearch, displayPositions, isAddressInput]);

  // Select a pair via manual search: pick it immediately if held, otherwise query the chain
  async function selectSearchedPair(sa, sb, heldLp = null) {
    setLpDropdownOpen(false);
    setPairSearch('');
    // If existing position already held, select directly without chain re-query (useEffect will refresh approval state)
    if (heldLp) {
      setSelectedLp(heldLp);
      setLpBalance(heldLp.lpAmount);
      setSelectedPairReserves(heldLp.reserves);
      // Default fill 50% quantity (precise BigInt calculation)
      setRemovePct(50);
      setRemoveCustomPct('');
      setRemoveLpAmount(calcLpPercent(heldLp.lpAmount, 50));
      return;
    }
    const aAddr = symToAddr(sa);
    const bAddr = symToAddr(sb);
    if (!aAddr || !bAddr || aAddr === bAddr) return;
    try {
      const pairAddr = await viemReadContract({
        address: viemGetAddress(PANCAKE_SWAP_FACTORY_V2),
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [viemGetAddress(aAddr), viemGetAddress(bAddr)],
      });
      if (!pairAddr || pairAddr === viemZeroAddress) {
        showToast('error', t('no_liquidity_pair'));
        return;
      }
      const pairAddrChecksum = viemGetAddress(pairAddr);
      const userAddr = address ? viemGetAddress(address) : viemZeroAddress;
      const [bal, totalSupply, token0Addr, token1Addr, reserves] = await Promise.all([
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'balanceOf', args: [userAddr] }).catch(() => 0n),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'totalSupply' }).catch(() => 0n),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token0' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token1' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'getReserves' }).catch(() => null),
      ]);
      if (!token0Addr || !token1Addr || !reserves || totalSupply <= 0n) {
        showToast('error', t('no_liquidity_pair'));
        return;
      }
      const t0 = token0Addr.toLowerCase();
      const t1 = token1Addr.toLowerCase();
      const aLow = aAddr.toLowerCase();
      const bLow = bAddr.toLowerCase();
      let reserveA, reserveB;
      if (aLow === t0 && bLow === t1) { reserveA = reserves[0]; reserveB = reserves[1]; }
      else if (aLow === t1 && bLow === t0) { reserveA = reserves[1]; reserveB = reserves[0]; }
      else return;
      const decA = getTokenDecimals(sa);
      const decB = getTokenDecimals(sb);
      const share = Number(bal) / Number(totalSupply);
      const amountA = parseFloat(viemFormatUnits(reserveA, decA)) * share;
      const amountB = parseFloat(viemFormatUnits(reserveB, decB)) * share;
      const pairName = `${_isBnbAliases(sa) ? 'WBNB' : sa}/${_isBnbAliases(sb) ? 'WBNB' : sb}`;
      const lp = {
        pairAddr,
        pair: pairName,
        tokenA: _isBnbAliases(sa) ? 'BNB' : sa,
        tokenB: _isBnbAliases(sb) ? 'BNB' : sb,
        tokenAAddr: aAddr,
        tokenBAddr: bAddr,
        lpAmount: viemFormatUnits(bal, 18),
        amountA: amountA.toFixed(6),
        amountB: amountB.toFixed(6),
        share: (share * 100).toFixed(4),
        totalValue: '—',
        reserves: { reserveA: viemFormatUnits(reserveA, decA), reserveB: viemFormatUnits(reserveB, decB), totalSupply: viemFormatUnits(totalSupply, 18) },
      };
      setSelectedLp(lp);
      setLpBalance(lp.lpAmount);
      setSelectedPairReserves(lp.reserves);
      if (bal <= 0n) showToast('warning', t('no_lp_balance_this_pair'));
    } catch (e) {
      console.error('[liquidity] Search & select LP failed:', e);
      showToast('error', t('load_failed'));
    }
  }

  // Directly search and select pair by LP contract address
  async function selectPairByAddress() {
    const addrStr = pairSearch.trim();
    if (!addrStr.startsWith('0x') || addrStr.length < 40) {
      showToast('error', t('invalid_lp_address'));
      return;
    }
    setLpDropdownOpen(false);
    setPairSearch('');
    try {
      const pairAddrChecksum = viemGetAddress(addrStr);
      const userAddr = address ? viemGetAddress(address) : viemZeroAddress;
      const ERC20_MIN_ABI = [
        { 'inputs': [], 'name': 'symbol', 'outputs': [{ 'internalType': 'string', 'name': '', 'type': 'string' }], 'stateMutability': 'view', 'type': 'function' },
        { 'inputs': [], 'name': 'decimals', 'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }], 'stateMutability': 'view', 'type': 'function' },
      ];
      
      const [bal, totalSupply, token0Addr, token1Addr, reserves] = await Promise.all([
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'balanceOf', args: [userAddr] }).catch(() => 0n),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'totalSupply' }).catch(() => 0n),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token0' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'token1' }).catch(() => null),
        viemReadContract({ address: pairAddrChecksum, abi: PAIR_ABI, functionName: 'getReserves' }).catch(() => null),
      ]);
      if (!token0Addr || !token1Addr || !reserves || totalSupply <= 0n) {
        // Distinguish "pasted a token contract address" from "RPC/network failure":
        // a plain ERC20 answers symbol() but has no token0()/getReserves(); a dead/EOA
        // address or unreachable RPC answers neither.
        let isTokenContract = false;
        try {
          const probeSym = await viemReadContract({ address: pairAddrChecksum, abi: ERC20_MIN_ABI, functionName: 'symbol' });
          isTokenContract = typeof probeSym === 'string' && probeSym.length > 0;
        } catch (_) { isTokenContract = false; }
        showToast('error', isTokenContract ? t('lp_addr_is_token') : t('lp_query_network_fail'));
        return;
      }

      // Resolve token info from address (read directly from chain if not found in TOKENS)
      const resolveToken = async (addr) => {
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
      };
      
      const [tok0, tok1] = await Promise.all([resolveToken(token0Addr), resolveToken(token1Addr)]);
      if (!tok0.sym || !tok1.sym) {
        showToast('error', t('lp_pair_load_failed'));
        return;
      }
      
      // Assign reserves according to the token0/token1 order
      let reserveA, reserveB, sa, sb, decA, decB, tokenAAddr, tokenBAddr;
      // Always treat token0 as A and token1 as B
      sa = tok0.sym;
      sb = tok1.sym;
      decA = tok0.dec;
      decB = tok1.dec;
      tokenAAddr = tok0.address;
      tokenBAddr = tok1.address;
      reserveA = reserves[0];
      reserveB = reserves[1];
      
      const share = totalSupply > 0n ? Number(bal) / Number(totalSupply) : 0;
      const amountA = parseFloat(viemFormatUnits(reserveA, decA)) * share;
      const amountB = parseFloat(viemFormatUnits(reserveB, decB)) * share;
      // BNB alias handling
      const displayA = _isBnbAliases(sa) ? 'BNB' : sa;
      const displayB = _isBnbAliases(sb) ? 'BNB' : sb;
      const isNativeA = _isBnbAliases(sa);
      const isNativeB = _isBnbAliases(sb);
      const pairName = `${_isBnbAliases(sa) ? 'WBNB' : sa}/${_isBnbAliases(sb) ? 'WBNB' : sb}`;
      
      const lp = {
        pairAddr: pairAddrChecksum,
        pair: pairName,
        tokenA: displayA,
        tokenB: displayB,
        tokenAAddr: tokenAAddr,
        tokenBAddr: tokenBAddr,
        tokenADecimals: decA,
        tokenBDecimals: decB,
        isNativeA: isNativeA,
        isNativeB: isNativeB,
        lpAmount: viemFormatUnits(bal, 18),
        amountA: amountA.toFixed(6),
        amountB: amountB.toFixed(6),
        share: (share * 100).toFixed(4),
        totalValue: '—',
        reserves: { reserveA: viemFormatUnits(reserveA, decA), reserveB: viemFormatUnits(reserveB, decB), totalSupply: viemFormatUnits(totalSupply, 18) },
      };
      
      // Save as an imported LP so it is loaded automatically from next time
      useLiquidityStore.getState().addImportedLp(pairAddrChecksum);
      
      setSelectedLp(lp);
      setLpBalance(lp.lpAmount);
      setSelectedPairReserves(lp.reserves);
      if (bal <= 0n) {
        showToast('warning', t('no_lp_balance_this_pair'));
      } else {
        showToast('success', t('lp_imported'));
      }
    } catch (e) {
      console.error('[liquidity] LP search by address failed:', e);
      showToast('error', t('load_failed'));
    }
  }

  return (
    <div className="space-y-5 max-w-5xl mx-auto animate-fadeIn">
      <div className="max-w-[520px] mx-auto">
        {/* ====== DEX standard: minimal card (glow-border / gradient frame removed) ====== */}
        <div className="rounded-xl p-5"
          style={{
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-default)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {/* ====== Tabs: Uniswap-style "1px blue underline indicator bar" (no gradient filled buttons) ====== */}
          <div className="flex gap-6 border-b mb-5" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className="relative pb-3 text-sm font-semibold transition-colors"
                style={{
                  color: activeTab === tab.id ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                }}
              >
                {t(tab.key)}
                {/* Bottom indicator bar */}
                {activeTab === tab.id && (
                  <span
                    className="absolute left-0 right-0 -bottom-px h-0.5 rounded-full"
                    style={{ background: 'var(--color-primary-500)' }}
                  />
                )}
              </button>
            ))}
          </div>

          {activeTab === 'add' ? (
            <div className="space-y-3">
              <TokenRow
                label={t('token_a_label', '代币 A')}
                tokenSymbol={symbolA}
                tokenData={tokenAData}
                amount={amountA}
                onAmountChange={(v) => { setActiveInput('A'); setAmountA(v); }}
                onSelectToken={() => openTokenSelect('A')}
                balance={formatBalance(balanceA, 4)}
                balanceInsufficient={balanceAInsufficient}
                showMax={connected}
                onMax={() => handleMax(true)}
              />
              <div className="flex justify-center">
                {/* ====== Center plus mark: small blue-white circle + 1px light gray border (no glow) ====== */}
                <div className="w-8 h-8 rounded-full flex items-center justify-center -my-2.5 relative z-10"
                  style={{
                    background: 'var(--color-primary-500)',
                    border: '1px solid var(--color-border-default)',
                    color: '#fff',
                  }}
                >
                  <Plus className="w-4 h-4" />
                </div>
              </div>
              <TokenRow
                label={t('token_b_label', '代币 B')}
                tokenSymbol={symbolB}
                tokenData={tokenBData}
                amount={amountB}
                onAmountChange={(v) => { setActiveInput('B'); setAmountB(v); }}
                onSelectToken={() => openTokenSelect('B')}
                balance={formatBalance(balanceB, 4)}
                balanceInsufficient={balanceBInsufficient}
                accent
                showMax={connected}
                onMax={() => handleMax(false)}
              />

              {isNewPair && hasBothAmounts && (
                <div className="p-3 rounded-xl flex gap-2.5 text-xs"
                  style={{
                    background: 'rgba(245, 158, 11, 0.08)',
                    border: '1px solid rgba(245, 158, 11, 0.2)',
                    color: 'var(--color-warning-500, #f59e0b)',
                  }}
                >
                  <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    {t('new_pair_notice', '这是全新交易对，尚无流动性。您将成为第一个流动性提供者，输入的数量比例将决定初始价格。')}
                  </div>
                </div>
              )}

              {hasBothAmounts && (
                /* ====== Price preview: no standalone card, just a border divider with left/right rows ====== */
                <div className="mt-5 pt-4 border-t space-y-2.5 text-sm" style={{ borderColor: 'var(--color-border-subtle)' }}>
                  <div className="flex justify-between items-start">
                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('price')}</span>
                    <div className="text-right space-y-0.5">
                      <div className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                        1 {symbolA} = {priceAB} {symbolB}
                      </div>
                      <div className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                        1 {symbolB} = {priceBA} {symbolA}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('share_of_pool')}</span>
                    <span className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                      {poolShare}%
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('lp_estimate')}</span>
                    <span className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                      ~{formatBalance(lpEstimate, 4)} LP
                    </span>
                  </div>
                </div>
              )}

              <div className="mt-4 p-3.5 rounded-xl flex gap-3"
                style={{
                  background: 'rgba(59, 130, 246, 0.06)',
                  border: '1px solid rgba(59, 130, 246, 0.15)',
                }}
              >
                <Info className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--color-primary-400)' }} />
                <div className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('lp_notice_desc')}
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {!isANative && connected && amountA && parseFloat(amountA) > 0 && !approvedA && (
                  <button
                    onClick={() => handleApprove(true)}
                    disabled={loadingAApprove}
                    className="w-full h-11 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 transition-colors"
                    style={{
                      background: 'transparent',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border-strong)',
                    }}
                  >
                    {loadingAApprove && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loadingAApprove ? t('signing', '签名中...') : t('approve_token_btn', '授权 {symbol}').replace('{symbol}', tokenA)}
                  </button>
                )}
                {!isBNative && connected && amountB && parseFloat(amountB) > 0 && !approvedB && (
                  <button
                    onClick={() => handleApprove(false)}
                    disabled={loadingBApprove}
                    className="w-full h-11 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 transition-colors"
                    style={{
                      background: 'transparent',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border-strong)',
                    }}
                  >
                    {loadingBApprove && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loadingBApprove ? t('signing', '签名中...') : t('approve_token_btn', '授权 {symbol}').replace('{symbol}', tokenB)}
                  </button>
                )}
                <button
                  onClick={connected ? handleAddLiquidity : openWallet}
                  disabled={!connected || !hasBothAmounts || loadingAdd || loadingAApprove || loadingBApprove || balanceAInsufficient || balanceBInsufficient}
                  className="w-full h-11 rounded-xl font-bold text-base flex items-center justify-center gap-2 btn-primary disabled:opacity-50 transition-colors"
                >
                  {(loadingAdd || loadingAApprove || loadingBApprove) && <Loader2 className="w-5 h-5 animate-spin" />}
                  {!connected ? (
                    <><Wallet className="w-5 h-5" />{t('connect_wallet')}</>
                  ) : !hasBothAmounts ? (
                    t('enter_amount')
                  ) : balanceAInsufficient || balanceBInsufficient ? (
                    t('insufficient_balance')
                  ) : loadingAdd ? (
                    t('tx_pending_msg')
                  ) : (loadingAApprove || loadingBApprove) ? (
                    t('signing', '签名中...')
                  ) : (
                    <><Plus className="w-5 h-5" />{t('add_liquidity')}</>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* LP token selector: show LP pairs rather than a single token */}
              {!connected ? (
                <div className="rounded-xl p-8 text-center"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <Wallet className="w-10 h-10 mx-auto mb-3 opacity-40" style={{ color: 'var(--color-text-tertiary)' }} />
                  <button onClick={openWallet} className="btn-primary px-5 h-10 rounded-xl font-semibold text-sm inline-flex items-center gap-2">
                    <Wallet className="w-4 h-4" />{t('connect_wallet')}
                  </button>
                </div>
              ) : loadingPositions && displayPositions.length === 0 ? (
                <div className="rounded-xl p-8 text-center"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <Loader2 className="w-8 h-8 mx-auto animate-spin mb-3" style={{ color: 'var(--color-text-tertiary)' }} />
                  <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('loading')}
                  </p>
                </div>
              ) : (
              <div className="rounded-xl px-4 py-3.5 relative"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('lp_token_label')}
                </div>
                <button
                  onClick={() => setLpDropdownOpen(v => !v)}
                  className="w-full flex items-center gap-2 px-3 h-10 rounded-xl transition-colors"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-border-default)',
                  }}
                >
                  <div className="flex items-center gap-1 shrink-0">
                    <LpTokenIcon address={selectedLp?.tokenAAddr} symbol={selectedLp?.tokenA || 'BNB'} size={24} />
                    <LpTokenIcon address={selectedLp?.tokenBAddr} symbol={selectedLp?.tokenB || 'USDT'} size={24} />
                  </div>
                  <span className="font-semibold text-sm flex-1 text-left" style={{ color: 'var(--color-text-primary)' }}>
                    {selectedLp?.pair || (displayPositions.length === 0 ? t('no_positions') : '—')}
                  </span>
                  <ChevronDown
                    className="w-3.5 h-3.5 transition-transform"
                    style={{
                      color: 'var(--color-text-tertiary)',
                      transform: lpDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                  />
                </button>
                {/* LP dropdown list: search box + search results / existing holdings list */}
                {lpDropdownOpen && (
                  <div className="absolute left-4 right-4 mt-1 rounded-xl overflow-hidden z-20"
                    style={{
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border-default)',
                      boxShadow: 'var(--shadow-lg)',
                    }}
                  >
                    <div className="p-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
                      <div className="relative">
                        <Search
                          size={14}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2"
                          style={{ color: 'var(--color-text-tertiary)' }}
                        />
                        <input
                          type="text"
                          value={pairSearch}
                          onChange={(e) => setPairSearch(e.target.value)}
                          placeholder={t('search_lp_pair')}
                          className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none"
                          style={{
                            background: 'var(--color-bg-tertiary)',
                            color: 'var(--color-text-primary)',
                            border: '1px solid var(--color-border-default)',
                          }}
                        />
                      </div>
                    </div>
                    {isAddressInput ? (
                      <button
                        onClick={selectPairByAddress}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:opacity-80"
                        style={{ background: 'var(--color-bg-tertiary)' }}
                      >
                        <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary-500)' }} />
                        <span className="font-semibold text-sm flex-1" style={{ color: 'var(--color-text-primary)' }}>
                          {t('query_lp_by_address', 'Query LP by Address')}
                        </span>
                      </button>
                    ) : pairSearch.trim() ? (
                      filteredSearchPairs.length > 0 ? (
                        filteredSearchPairs.map((lp) => (
                          <button
                            key={lp.pairAddr}
                            onClick={() => {
                              setSelectedLp(lp);
                              setLpBalance(lp.lpAmount);
                              setSelectedPairReserves(lp.reserves);
                              setLpDropdownOpen(false);
                              setPairSearch('');
                              setLpApproved(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:opacity-80"
                            style={{
                              background: selectedLp?.pairAddr === lp.pairAddr ? 'var(--color-bg-tertiary)' : 'transparent',
                            }}
                          >
                            <div className="flex items-center gap-1 shrink-0">
                              <LpTokenIcon address={lp.tokenAAddr} symbol={lp.tokenA} size={24} />
                              <LpTokenIcon address={lp.tokenBAddr} symbol={lp.tokenB} size={24} />
                            </div>
                            <span className="font-semibold text-sm flex-1" style={{ color: 'var(--color-text-primary)' }}>
                              {lp.pair}
                            </span>
                            <span className="text-xs font-numeric whitespace-nowrap leading-tight text-right" style={{ color: 'var(--color-text-tertiary)' }}>
                              <div>{lp.amountA} {lp.tokenA}</div>
                              <div>{lp.amountB} {lp.tokenB}</div>
                            </span>
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                          {t('no_matching_positions', 'No matching positions')}
                        </div>
                      )
                    ) : displayPositions.length > 0 ? (
                      displayPositions.map(lp => (
                        <button
                          key={lp.pairAddr}
                          onClick={() => {
                            setSelectedLp(lp);
                            setLpBalance(lp.lpAmount);
                            setSelectedPairReserves(lp.reserves);
                            setLpDropdownOpen(false);
                            setLpApproved(false);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:opacity-80"
                          style={{
                            background: selectedLp?.pairAddr === lp.pairAddr ? 'var(--color-bg-tertiary)' : 'transparent',
                          }}
                        >
                          <div className="flex items-center gap-1 shrink-0">
                            <LpTokenIcon address={lp.tokenAAddr} symbol={lp.tokenA} size={24} />
                            <LpTokenIcon address={lp.tokenBAddr} symbol={lp.tokenB} size={24} />
                          </div>
                          <span className="font-semibold text-sm flex-1" style={{ color: 'var(--color-text-primary)' }}>
                            {lp.pair}
                          </span>
                          <span className="text-xs font-numeric whitespace-nowrap leading-tight text-right" style={{ color: 'var(--color-text-tertiary)' }}>
                            <div>{lp.amountA} {lp.tokenA}</div>
                            <div>{lp.amountB} {lp.tokenB}</div>
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                        {t('no_positions')}
                      </div>
                    )}
                  </div>
                )}
                <div className="text-xs mt-2 text-right font-numeric leading-tight" style={{ color: 'var(--color-text-tertiary)' }}>
                  <div>{selectedLp?.amountA} {selectedLp?.tokenA}</div>
                  <div>{selectedLp?.amountB} {selectedLp?.tokenB}</div>
                </div>
              </div>
              )}

              <div>
                <div className="text-xs font-medium mb-2.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('remove_pct')}
                </div>
                {/* Percentage buttons: four preset pill buttons (compact width) + custom input box (takes the remaining space via flex-1) */}
                <div className="flex items-center gap-1.5">
                  {REMOVE_PCTS.map(pct => (
                    <button
                      key={pct}
                      onClick={() => {
                        setRemovePct(pct);
                        setRemoveCustomPct('');
                        // Exact BigInt calculation; never output scientific notation
                        setRemoveLpAmount(calcLpPercent(lpBalance, pct));
                      }}
                      className="h-8 w-12 rounded-lg text-xs font-semibold transition-colors flex-shrink-0"
                      style={removePct === pct && !removeCustomPct ? {
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
                  ))}
                  {/* Custom input box: occupies the remaining space via flex-1 */}
                  <div className="relative h-8 flex-1 min-w-0">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={removeCustomPct}
                      onChange={(e) => {
                        const v = sanitizeAmountInput(e.target.value);
                        setRemoveCustomPct(v);
                        const num = parseFloat(v);
                        if (!isNaN(num) && num >= 0 && num <= 100) {
                          setRemovePct(num);
                          // Exact BigInt calculation; never output scientific notation
                          setRemoveLpAmount(calcLpPercent(lpBalance, num));
                        }
                      }}
                      onKeyDown={blockInvalidNumericKeys}
                      placeholder={t('custom') || 'Custom'}
                      className="w-full h-full px-3 pr-7 rounded-lg text-xs font-medium outline-none transition-colors text-center"
                      style={{
                        background: removeCustomPct ? 'var(--color-primary-500)' : 'var(--color-bg-tertiary)',
                        color: removeCustomPct ? '#fff' : 'var(--color-text-secondary)',
                        border: removeCustomPct
                          ? '1px solid var(--color-primary-500)'
                          : '1px solid var(--color-border-subtle)',
                      }}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium"
                      style={{ color: removeCustomPct ? 'rgba(255,255,255,0.8)' : 'var(--color-text-tertiary)' }}>
                      %
                    </span>
                  </div>
                </div>
              </div>

              {/* LP amount direct input box */}
              {selectedLp && (
              <div className="mt-3">
                <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('lp_amount', 'LP数量')}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={removeLpAmount}
                    onChange={(e) => {
                      const v = sanitizeAmountInput(e.target.value);
                      setRemoveLpAmount(v);
                    }}
                    onKeyDown={blockInvalidNumericKeys}
                    placeholder={t('enter_lp_amount', '输入LP数量')}
                    className="w-full h-10 px-4 pr-12 rounded-lg text-sm font-semibold outline-none transition-colors"
                    style={{
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-primary-500)',
                      border: '1px solid var(--color-primary-500)',
                    }}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium"
                    style={{ color: 'var(--color-text-tertiary)' }}>
                    LP
                  </span>
                  <button
                    onClick={() => {
                      setRemovePct(100);
                      setRemoveCustomPct('');
                      setRemoveLpAmount(lpBalance);
                    }}
                    className="absolute right-12 top-1/2 -translate-y-1/2 text-xs font-semibold px-2 py-0.5 rounded"
                    style={{ color: 'var(--color-primary-500)' }}
                  >
                    MAX
                  </button>
                </div>
                {/* Display full precision available balance */}
                <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('available_balance', '可用余额')}: {lpBalance} LP
                </div>
              </div>
              )}

              {/* Remove preview: no standalone card, separated directly by border-t (slippage display removed) */}
              {selectedLp && (
              <div className="pt-4 mt-2 border-t space-y-2.5 text-sm" style={{ borderColor: 'var(--color-border-subtle)' }}>
                <div className="flex justify-between">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('estimated_receive')} {selectedLp.tokenA}</span>
                  <span className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                    {estReceiveA} {selectedLp.tokenA}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('estimated_receive')} {selectedLp.tokenB}</span>
                  <span className="font-medium font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                    {estReceiveB} {selectedLp.tokenB}
                  </span>
                </div>
              </div>
              )}

              <div className="space-y-2">
                {connected && parseFloat(removeAmount) > 0 && !lpApproved && (
                  <button
                    onClick={() => handleApproveLp()}
                    disabled={loadingLpApprove}
                    className="w-full h-11 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 transition-colors"
                    style={{
                      background: 'transparent',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border-strong)',
                    }}
                  >
                    {loadingLpApprove && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loadingLpApprove ? t('approving') : t('approve_lp_token') || `${t('approve_token_generic')} LP`}
                  </button>
                )}
                <button
                  onClick={connected ? handleRemove : openWallet}
                  disabled={!connected || parseFloat(removeAmount) <= 0 || loadingRemove || (!canRemoveNow && parseFloat(removeAmount) > 0)}
                  className="w-full h-11 rounded-xl font-bold text-base flex items-center justify-center gap-2 btn-primary disabled:opacity-50 transition-colors"
                >
                  {loadingRemove && <Loader2 className="w-5 h-5 animate-spin" />}
                  {!connected ? (
                    <><Wallet className="w-5 h-5" />{t('connect_wallet')}</>
                  ) : parseFloat(removeAmount) <= 0 ? (
                    t('enter_amount')
                  ) : loadingRemove ? (
                    t('tx_pending_msg')
                  ) : (
                    <><Minus className="w-5 h-5" />{t('remove_liquidity')}</>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-[720px] mx-auto mt-8">
        <div className="flex items-center gap-2 mb-4">
          <Droplets className="w-5 h-5" style={{ color: 'var(--color-primary-500)' }} />
          <h2 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('my_liquidity')}
          </h2>
        </div>
        {!connected ? (
          <div className="rounded-xl p-8 text-center"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <Wallet className="w-12 h-12 mx-auto mb-3 opacity-40" style={{ color: 'var(--color-text-tertiary)' }} />
            <button
              onClick={openWallet}
              className="btn-primary px-6 h-11 rounded-xl font-semibold text-sm inline-flex items-center gap-2"
            >
              <Wallet className="w-4 h-4" />
              {t('connect_to_view')}
            </button>
          </div>
        ) : positions.length === 0 ? (
          <div className="rounded-xl p-8 text-center"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            {loadingPositions ? (
              <Loader2 className="w-10 h-10 mx-auto mb-3 animate-spin" style={{ color: 'var(--color-text-tertiary)' }} />
            ) : (
              <Coins className="w-12 h-12 mx-auto mb-3 opacity-40" style={{ color: 'var(--color-text-tertiary)' }} />
            )}
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {loadingPositions ? t('loading') : t('no_positions')}
            </p>
          </div>
        ) : (
          <>
            {/* ========== Desktop: 5-column table (shown at md and up) ========== */}
            <div className="hidden md:block rounded-xl overflow-hidden"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-default)',
              }}
            >
              {/* Header: 5 columns */}
              <div className="grid gap-3 px-5 py-3 text-xs font-medium"
                style={{
                  gridTemplateColumns: 'minmax(140px,1.5fr) minmax(150px,1fr) minmax(90px,1fr) minmax(110px,1fr) minmax(90px,1fr)',
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-tertiary)',
                  borderBottom: '1px solid var(--color-border-subtle)',
                }}
              >
                <div>{t('pool') || 'Pool'}</div>
                <div className="text-right">{t('tokens') || '代币'}</div>
                <div className="text-right">{t('lp_amount')}</div>
                <div className="text-right">{t('liq_total_value_label') || t('total_value')}</div>
                <div className="text-right">{t('pool_share')}</div>
              </div>
              {/* Rows: one row per LP, 5 columns */}
              {positions.map((pos, idx) => (
                <div
                  key={idx}
                  className="grid gap-3 px-5 py-4 items-center text-sm"
                  style={{
                    gridTemplateColumns: 'minmax(140px,1.5fr) minmax(150px,1fr) minmax(90px,1fr) minmax(110px,1fr) minmax(90px,1fr)',
                    borderBottom: idx < positions.length - 1 ? '1px solid var(--color-border-subtle)' : 'none',
                  }}
                >
                  {/* Pool name + icons */}
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex items-center gap-1 shrink-0">
                      <LpTokenIcon address={pos.tokenAAddr} symbol={pos.tokenA} size={24} />
                      <LpTokenIcon address={pos.tokenBAddr} symbol={pos.tokenB} size={24} />
                    </div>
                    <span className="font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                      {pos.pair}
                    </span>
                  </div>
                  {/* Underlying token amounts */}
                  <div className="text-right font-bold font-numeric text-xs leading-tight whitespace-nowrap" style={{ color: 'var(--color-text-primary)' }}>
                    <div>{pos.amountA} {pos.tokenA}</div>
                    <div style={{ color: 'var(--color-text-tertiary)' }}>{pos.amountB} {pos.tokenB}</div>
                  </div>
                  <div className="text-right font-bold font-numeric whitespace-nowrap" style={{ color: 'var(--color-text-primary)' }}>
                    {Number(pos.lpAmount).toFixed(2)}
                  </div>
                  <div className="text-right font-bold font-numeric whitespace-nowrap" style={{ color: 'var(--color-text-primary)' }}>
                    {pos.totalValue}
                  </div>
                  <div className="text-right font-bold font-numeric whitespace-nowrap" style={{ color: 'var(--color-primary-500)' }}>
                    {pos.share}
                  </div>
                </div>
              ))}
            </div>

            {/* ========== Mobile: compact row layout (shown below md), two rows, no scrolling ========== */}
            <div className="md:hidden rounded-xl overflow-hidden divide-y"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-default)',
              }}
            >
              {positions.map((pos, idx) => (
                <div key={idx} className="px-4 py-3.5 space-y-2.5">
                  {/* Row 1: pool icons + name + LP amount */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="flex items-center gap-1 shrink-0">
                        <LpTokenIcon symbol={pos.tokenA} size={24} />
                        <LpTokenIcon symbol={pos.tokenB} size={24} />
                      </div>
                      <span className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>
                        {pos.pair}
                      </span>
                    </div>
                    <span className="font-bold font-numeric text-sm shrink-0" style={{ color: 'var(--color-text-primary)' }}>
                      {Number(pos.lpAmount).toFixed(2)}
                    </span>
                  </div>
                  {/* Row 2: token amounts / pool share / total value, three equal columns */}
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{t('tokens') || '代币'}</div>
                      <div className="font-bold font-numeric leading-tight" style={{ color: 'var(--color-text-primary)' }}>
                        <div>{pos.amountA} {pos.tokenA}</div>
                        <div>{pos.amountB} {pos.tokenB}</div>
                      </div>
                    </div>
                    <div>
                      <div className="mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{t('pool_share')}</div>
                      <div className="font-bold font-numeric" style={{ color: 'var(--color-primary-500)' }}>
                        {pos.share}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{t('liq_total_value_label') || t('total_value')}</div>
                      <div className="font-bold font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                        {pos.totalValue}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Token icons for the LP list: unify BNB/WBNB aliases and render TokenIcon
function LpTokenIcon({ address, symbol, size = 24 }) {
  const isBnb = _isBnbAliases(symbol);
  const sym = isBnb ? 'BNB' : (symbol || '');
  // The BNB side inside an LP is backed by the WBNB contract, but displayed uniformly as BNB; other tokens match icons by contract address
  const src = isBnb ? '/img/tokens/bnb.png' : tokenIconSrc({ address });
  return <TokenIcon src={src} symbol={sym.toUpperCase()} size={size} />;
}

function TokenRow({ label, tokenSymbol, tokenData, amount, onAmountChange, onSelectToken, balance, readOnly = false, balanceInsufficient = false, accent = false, showMax = false, onMax = null }) {
  const { t } = useTranslation();
  return (
    /* ====== Same as the swap standard: flat input block + red border for insufficient balance ====== */
    <div
      className="rounded-xl px-4 py-3.5 transition-colors"
      style={{
        background: 'var(--color-bg-tertiary)',
        border: `1px solid ${balanceInsufficient ? 'var(--state-error)' : 'var(--color-border-subtle)'}`,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: balanceInsufficient ? 'var(--state-error)' : 'var(--color-text-tertiary)' }}>
            {t('balance')}: <span className="font-numeric">{balance}</span>
          </span>
          {showMax && onMax && (
            <button
              onClick={onMax}
              className="text-xs font-semibold px-1.5 py-0.5 rounded transition-colors hover:opacity-80"
              style={{ color: 'var(--color-primary-500)' }}
            >
              MAX
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => !readOnly && onAmountChange(sanitizeAmountInput(e.target.value))}
            onKeyDown={blockInvalidNumericKeys}
            readOnly={readOnly}
            className="w-full bg-transparent outline-none text-2xl font-semibold font-numeric"
            style={{
              color: readOnly ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
              caretColor: 'var(--color-primary-500)',
            }}
          />
        </div>
        {/* ====== Currency selector pill capsule button ====== */}
        <button
          onClick={onSelectToken}
          className="flex items-center gap-2 px-3.5 h-10 rounded-xl transition-colors"
          style={{
            background: accent ? 'rgba(139, 92, 246, 0.08)' : 'var(--color-bg-secondary)',
            border: `1px solid ${accent ? 'rgba(139, 92, 246, 0.3)' : 'var(--color-border-default)'}`,
            color: 'var(--color-text-primary)',
          }}
        >
          {/* Icons are resolved by contract address: show the built-in icon only when tokenData.address matches a built-in token; otherwise TokenIcon falls back to the symbol text */}
          <TokenIcon src={tokenIconSrc(tokenData)} symbol={tokenSymbol} size={24} />
          <span className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>
            {tokenSymbol}
          </span>
          <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-text-tertiary)' }} />
        </button>
      </div>
    </div>
  );
}
