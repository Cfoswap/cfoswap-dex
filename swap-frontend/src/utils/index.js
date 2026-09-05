import {
  isAddress as viemIsAddress,
  formatEther as viemFormatEther,
  parseUnits as viemParseUnits,
  formatUnits as viemFormatUnits,
  createPublicClient,
  createWalletClient,
  http,
  custom,
  getAddress,
  parseEther,
  formatEther,
  parseAbi,
  zeroAddress,
  maxUint256,
} from 'viem';
import { bsc } from 'viem/chains';
import { RPC_URLS, EXPLORER_URL, BSC_CHAIN_ID } from '@/config/index.js';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';

// viem MaxUint256 constant (2^256 - 1)
export const VIEM_MAX_UINT256 = maxUint256;
export const VIEM_ZERO_ADDRESS = zeroAddress;

export function shortenAddress(address, chars = 4) {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function isValidAddress(address) {
  if (!address || typeof address !== 'string') return false;
  try {
    return viemIsAddress(address);
  } catch {
    return false;
  }
}

export function formatBalance(balance, decimals = 4) {
  if (!balance) return '0.0000';
  try {
    const num = typeof balance === 'string' || typeof balance === 'number'
      ? parseFloat(balance)
      : parseFloat(viemFormatEther(balance));
    if (isNaN(num)) return '0.0000';
    if (num === 0) return '0.0000';
    if (num < 0.0001) return '<0.0001';
    return num.toFixed(decimals).replace(/\.?0+$/, '') || '0';
  } catch {
    return '0.0000';
  }
}

export function formatPrice(price) {
  if (!price) return '0.00';
  const num = parseFloat(price);
  if (isNaN(num)) return '0.00';
  if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (num >= 1) return num.toFixed(2);
  if (num >= 0.01) return num.toFixed(4);
  return num.toFixed(8);
}

export function formatUSD(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return '$0.00';
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '$' + num.toFixed(2);
}

export function calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut) {
  if (!amountIn || !amountOut || !reserveIn || !reserveOut) return 0;
  try {
    const amountInWithFee = parseFloat(amountIn) * 0.9975;
    const numerator = amountInWithFee * parseFloat(reserveOut);
    const denominator = parseFloat(reserveIn) + amountInWithFee;
    const spotPrice = parseFloat(reserveOut) / parseFloat(reserveIn);
    const executionPrice = parseFloat(amountOut) / parseFloat(amountIn);
    const impact = ((spotPrice - executionPrice) / spotPrice) * 100;
    return Math.max(0, impact);
  } catch {
    return 0;
  }
}

export function calculateMinimumReceived(amountOut, slippagePercent) {
  const outNum = parseFloat(amountOut);
  const slipNum = parseFloat(slippagePercent) / 100;
  if (!isFinite(outNum) || !isFinite(slipNum)) return '0';
  const raw = outNum * (1 - slipNum);
  if (raw <= 0 || !isFinite(raw)) return '0';
  // Floor to 8 decimals — never overshoot the user's signed floor.
  // Previously toFixed(8) used banker-rounding and could round UP by a few wei,
  // causing INSUFFICIENT_OUTPUT_AMOUNT reverts exactly at the boundary.
  const floored = Math.floor(raw * 1e8) / 1e8;
  return floored.toFixed(8);
}

export function getExplorerTxUrl(txHash) {
  return `${EXPLORER_URL}/tx/${txHash}`;
}

export function getExplorerAddressUrl(address) {
  return `${EXPLORER_URL}/address/${address}`;
}

export function getExplorerTokenUrl(address) {
  return `${EXPLORER_URL}/token/${address}`;
}

export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // fall through to fallback
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

export function parseTokenAmount(amount, decimals = 18) {
  try {
    return viemParseUnits(amount.toString(), decimals);
  } catch (e) {
    // FS-102 FIX: Log invalid inputs so malformed data can be traced back; caller-side >0n checks are still required
    if (import.meta.env.DEV) {
      console.error('[parseTokenAmount] invalid input (returned 0n):', { amount: typeof amount === 'string' || typeof amount === 'number' ? amount : `[${typeof amount}]`, decimals, errMsg: e?.message });
    }
    return 0n;
  }
}

export function formatTokenAmount(amount, decimals = 18, displayDecimals = 4) {
  try {
    const formatted = viemFormatUnits(amount, decimals);
    return formatBalance(formatted, displayDecimals);
  } catch {
    return '0.0000';
  }
}

// Alias exports, maintain backward compatibility
export const viemParseTokenAmount = parseTokenAmount;
export const viemFormatTokenAmount = formatTokenAmount;
export { viemFormatUnits, viemFormatEther };

/**
 * Amount input sanitization: allow only digits + at most one decimal point, no minus sign/e/letters, limit decimal places
 */
export function sanitizeAmountInput(raw, maxDecimals = 4) {
  if (raw === '' || raw === null || raw === undefined) return '';
  let val = String(raw).replace(/[^\d.]/g, '');
  const parts = val.split('.');
  if (parts.length > 2) {
    val = parts[0] + '.' + parts.slice(1).join('');
  }
  if (val.startsWith('.')) val = '0' + val;
  if (val !== '' && val !== '0' && !val.includes('.') && val.startsWith('0')) {
    val = val.replace(/^0+/, '') || '0';
  }
  if (val.includes('.') && maxDecimals >= 0) {
    const [intPart, decPart] = val.split('.');
    val = intPart + '.' + decPart.slice(0, maxDecimals);
  }
  return val;
}

export function sanitizeSlippageInput(raw) {
  const cleaned = sanitizeAmountInput(raw, 2);
  // Cap at 50% — slippage higher than 50% always means user got robbed.
  // Clamp here so BOTH custom input fields (swap-page inline + SlippageDrawer)
  // automatically cut off at the UI value layer (not just the store write guard).
  const n = parseFloat(cleaned);
  if (!isNaN(n) && n > 50) return '50';
  return cleaned;
}

export function sanitizeIntegerInput(raw) {
  if (raw === '' || raw === null || raw === undefined) return '';
  const val = String(raw).replace(/[^\d]/g, '');
  if (val === '') return '';
  const n = parseInt(val, 10);
  return isNaN(n) ? '' : String(n);
}

export function blockInvalidNumericKeys(e) {
  if (['e', 'E', '+', '-', ','].includes(e.key)) {
    e.preventDefault();
  }
}

export function blockInvalidIntegerKeys(e) {
  if (['.', 'e', 'E', '+', '-', ','].includes(e.key)) {
    e.preventDefault();
  }
}

// ====== Read token decimals from chain at runtime ======
// Use viem version uniformly, remove ethers dependency
export { viemFetchDecimals as fetchDecimals };

export const isValidEVMAddress = isValidAddress;
export const isAddress = isValidAddress;

export function formatBNB(amount) {
  return formatTokenAmount(amount, 18, 4);
}

export function formatCFO(amount) {
  return formatTokenAmount(amount, 18, 2);
}

// ====== Public multi-RPC polling - viem version ======

let _viemPublicClientFallback = null;
let _viemLastGoodIdx = 0;
let _walletProviderBroken = false;

async function isProviderHealthy(client, timeoutMs = 5000) {
  if (!client) return false;
  try {
    await Promise.race([
      client.getBlockNumber(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Keep getReadProvider as alias of getViemPublicClient, maintain backward compatibility
export function getReadProvider(preferWallet = true) {
  return getViemPublicClient();
}

export function resetReadProvider(forceNext = true) {
  resetViemPublicClient(forceNext);
  _walletProviderBroken = false;
}

export function markWalletProviderBroken() {
  _walletProviderBroken = true;
  resetViemPublicClient(true);
}

export function resetWalletProviderStatus() {
  _walletProviderBroken = false;
}

// withRpcFallback is now a simple wrapper of viemReadContract (viemReadContract has built-in retry)
export async function withRpcFallback(fn, options = {}) {
  // viemReadContract already has built-in RPC fallback and retry
  return await fn(getViemPublicClient());
}

export async function probeProviderAndRecover() {
  try {
    const client = getViemPublicClient();
    const ok = await isProviderHealthy(client, 4000);
    if (!ok) {
      console.warn('[viem] Public client unresponsive, switching RPC...');
      resetViemPublicClient(true);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[RPC] probe failed:', e);
    resetViemPublicClient(true);
    return false;
  }
}

export function safeAddBigInt(a, b) {
  try { return BigInt(a || 0) + BigInt(b || 0); } catch { return 0n; }
}

export function calcPct(current, total) {
  if (!total || total === 0n || total === 0) return 0;
  try {
    const c = typeof current === 'bigint' ? parseFloat(viemFormatEther(current)) : parseFloat(current || 0);
    const t = typeof total === 'bigint' ? parseFloat(viemFormatEther(total)) : parseFloat(total || 0);
    if (t === 0) return 0;
    return Math.min(100, Math.max(0, (c / t) * 100));
  } catch { return 0; }
}

/**
 * Precise percentage calculation using BigInt integer arithmetic (no floating-point precision loss).
 * Multiply first, then divide, fully in BigInt domain. Supports arbitrary decimals.
 * @param {bigint} current - numerator (raw on-chain value, e.g. wei)
 * @param {bigint} total - denominator (raw on-chain value, e.g. wei)
 * @param {number} decimals - decimal places for the result (default 2, e.g. 33.33%)
 * @returns {number} percentage clamped to [0, 100]
 */
export function calcBigIntPct(current, total, decimals = 2) {
  try {
    const c = BigInt(current || 0);
    const t = BigInt(total || 0);
    if (t <= 0n) return 0;
    if (c <= 0n) return 0;
    if (c >= t) return 100;
    // Use precision factor: 10^(decimals+2) so after dividing by 100 we get desired decimal places
    const precision = 10n ** BigInt(decimals + 2);
    const raw = Number((c * precision) / t);
    const pct = raw / (10 ** decimals);
    return Math.min(100, Math.max(0, pct));
  } catch { return 0; }
}

// ==================== viem version utility functions (for newly migrated code) ====================

/**
 * Get viem public client, support multi-RPC fallback (poll by _lastGoodIdx)
 */
export function getViemPublicClient() {
  if (_viemPublicClientFallback) return _viemPublicClientFallback;
  // Try creating client starting from the last good node
  const n = RPC_URLS?.length || 0;
  for (let i = 0; i < n; i++) {
    const idx = (_viemLastGoodIdx + i) % n;
    const url = RPC_URLS[idx];
    try {
      _viemPublicClientFallback = createPublicClient({
        chain: bsc,
        transport: http(url, { timeout: 10000, retryCount: 2 }),
        batch: { multicall: false },
      });
      _viemLastGoodIdx = idx;
      return _viemPublicClientFallback;
    } catch (e) {
      console.warn('[viem] create client failed, try next:', url);
      continue;
    }
  }
  // Fallback: use the first node
  _viemPublicClientFallback = createPublicClient({
    chain: bsc,
    transport: http(RPC_URLS[0], { timeout: 10000, retryCount: 2 }),
  });
  return _viemPublicClientFallback;
}

/**
 * Reset viem public client, switch to next RPC node
 */
export function resetViemPublicClient(forceNext = true) {
  _viemPublicClientFallback = null;
  if (forceNext) {
    _viemLastGoodIdx = (_viemLastGoodIdx + 1) % Math.max(1, RPC_URLS?.length || 1);
  }
}

// ABI cache: avoid duplicate parseAbi
const _abiCache = new Map();

/**
 * Auto-resolve ABI: if string array (ethers style) is passed, auto parse with parseAbi; otherwise use directly
 */
function resolveAbi(abi) {
  if (!abi) return abi;
  // If already parsed object array (has type field), return directly
  if (Array.isArray(abi) && abi.length > 0 && typeof abi[0] === 'object' && 'type' in abi[0]) {
    return abi;
  }
  // If string array, cache parseAbi result
  const cacheKey = Array.isArray(abi) ? abi.join('|') : String(abi);
  if (_abiCache.has(cacheKey)) return _abiCache.get(cacheKey);
  try {
    const parsed = parseAbi(abi);
    _abiCache.set(cacheKey, parsed);
    return parsed;
  } catch (e) {
    console.warn('[viem] parseAbi failed, returning raw abi:', e);
    return abi;
  }
}

/**
 * viem version: read contract method (with auto retry and RPC fallback, auto resolve ethers-style string ABI)
 */
export async function viemReadContract(params, options = {}) {
  const { maxRetries = 2 } = options;
  let lastErr;
  const resolvedAbi = resolveAbi(params.abi);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        resetViemPublicClient(true);
      }
      const client = getViemPublicClient();
      const result = await client.readContract({
        ...params,
        abi: resolvedAbi,
        address: params.address ? getAddress(params.address) : undefined,
      });
      return result;
    } catch (e) {
      lastErr = e;
      const isBadData = e?.name === 'ContractFunctionExecutionError' && e?.message?.includes('could not decode');
      const isNetworkErr = e?.name === 'HttpRequestError' || e?.message?.includes('timeout') || e?.message?.includes('failed');
      if ((isBadData || isNetworkErr) && attempt < maxRetries) {
        console.warn(`[viem] readContract failed (attempt ${attempt + 1}/${maxRetries + 1}), switching RPC...`, e?.shortMessage || e?.message);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * viem version: simulate contract write (staticCall alternative, with auto retry and RPC fallback)
 */
export async function viemSimulateContract(params, options = {}) {
  const { maxRetries = 2 } = options;
  let lastErr;
  const resolvedAbi = resolveAbi(params.abi);
  const walletState = useWalletStore.getState();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        resetViemPublicClient(true);
      }
      const client = getViemPublicClient();
      const result = await client.simulateContract({
        ...params,
        abi: resolvedAbi,
        address: params.address ? getAddress(params.address) : undefined,
        account: params.account || (walletState?.address ? getAddress(walletState.address) : undefined),
      });
      return result;
    } catch (e) {
      lastErr = e;
      const isBadData = e?.name === 'ContractFunctionExecutionError' && e?.message?.includes('could not decode');
      const isNetworkErr = e?.name === 'HttpRequestError' || e?.message?.includes('timeout') || e?.message?.includes('failed');
      if ((isBadData || isNetworkErr) && attempt < maxRetries) {
        console.warn(`[viem] simulateContract failed (attempt ${attempt + 1}/${maxRetries + 1}), switching RPC...`, e?.shortMessage || e?.message);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * viem version: get native token (BNB) balance
 */
export async function viemGetBalance(address, options = {}) {
  const { maxRetries = 2 } = options;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) resetViemPublicClient(true);
      const client = getViemPublicClient();
      return await client.getBalance({ address: getAddress(address) });
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        console.warn(`[viem] getBalance failed (attempt ${attempt + 1}/${maxRetries + 1})`, e?.shortMessage || e?.message);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// viem version decimals cache
const _viemDecimalsCache = new Map();
const _viemDecimalsRunning = new Map();

/**
 * viem version: get token decimals
 */
export async function viemFetchDecimals(address, options = {}) {
  if (!address) return 18;
  const key = address.toLowerCase();
  if (_viemDecimalsCache.has(key)) return _viemDecimalsCache.get(key);
  if (_viemDecimalsRunning.has(key)) return _viemDecimalsRunning.get(key);
  const p = (async () => {
    try {
      const d = await viemReadContract({
        address: getAddress(address),
        abi: [
          {
            type: 'function',
            name: 'decimals',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'uint8' }],
          },
        ],
        functionName: 'decimals',
      }, options);
      const num = Number(d);
      _viemDecimalsCache.set(key, Number.isFinite(num) ? num : 18);
      return _viemDecimalsCache.get(key);
    } catch {
      _viemDecimalsCache.set(key, 18);
      return 18;
    } finally {
      _viemDecimalsRunning.delete(key);
    }
  })();
  _viemDecimalsRunning.set(key, p);
  return p;
}

/**
 * viem version: read ERC20 balance
 */
export async function viemGetERC20Balance(tokenAddress, ownerAddress, decimals, options = {}) {
  const bal = await viemReadContract({
    address: getAddress(tokenAddress),
    abi: [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ type: 'address', name: 'owner' }],
        outputs: [{ type: 'uint256' }],
      },
    ],
    functionName: 'balanceOf',
    args: [getAddress(ownerAddress)],
  }, options);
  if (decimals != null) {
    return viemFormatUnits(bal, decimals);
  }
  return bal;
}

/**
 * viem version: write contract (send transaction)
 * Use EIP-1193 provider directly (window.ethereum), no ethers needed
 */
export async function viemWriteContract(params, options = {}) {
  const { value: txValue, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce, ...restParams } = params;
  // Get connection status and address from walletStore
  const walletState = useWalletStore.getState();
  if (!walletState?.connected || !walletState?.address) {
    throw new Error('Wallet not connected');
  }

  // ============== G04 BLOCKING: BSC Mainnet (chainId 56) Gate ==============
  // All write transactions must be on BSC mainnet ONLY. Users on testnet/other chains
  // would accidentally sign txns targeting wrong contracts / lose funds via wrong nonces.
  // Query provider LIVE (do NOT trust walletState.chainId — it's stale after user switches network inside wallet without reloading page)
  let liveChainIdNum = walletState.chainId || 0;
  try {
    const tempProvider = (() => {
      if (typeof window === 'undefined') return null;
      const walletId = walletState.walletId;
      if (walletId === 'okx' && window.okxwallet) return window.okxwallet;
      if (walletId === 'binance' && window.BinanceChain) return window.BinanceChain;
      if (window.ethereum?.providers?.length) {
        if (walletId === 'metamask') return window.ethereum.providers.find(p => p.isMetaMask) || window.ethereum;
        return window.ethereum;
      }
      return window.ethereum || null;
    })();
    if (tempProvider && typeof tempProvider.request === 'function') {
      const rawChainId = await tempProvider.request({ method: 'eth_chainId' }).catch(() => null);
      if (rawChainId) liveChainIdNum = Number(rawChainId);
    }
  } catch (e) { /* fall back to walletState.chainId */ }
  if (liveChainIdNum !== Number(BSC_CHAIN_ID)) {
    try {
      useUiStore.getState().showToast('error', 'liq_err_wrong_network');
    } catch (e) {}
    throw new Error(`Wrong network: expected BSC chainId ${BSC_CHAIN_ID}, got ${liveChainIdNum}. Please switch your wallet to BSC Mainnet before signing.`);
  }

  // Use EIP-1193 provider directly (window.ethereum or corresponding wallet injected provider)
  let ethereumProvider = null;
  if (typeof window !== 'undefined') {
    // Get corresponding injected provider by walletId
    const walletId = walletState.walletId;
    if (walletId === 'okx' && window.okxwallet) {
      ethereumProvider = window.okxwallet;
    } else if (walletId === 'binance' && window.BinanceChain) {
      ethereumProvider = window.BinanceChain;
    } else if (window.ethereum) {
      // Generic handling for MetaMask/OKX
      if (window.ethereum.providers?.length) {
        if (walletId === 'metamask') {
          ethereumProvider = window.ethereum.providers.find(p => p.isMetaMask) || window.ethereum;
        } else {
          ethereumProvider = window.ethereum;
        }
      } else {
        ethereumProvider = window.ethereum;
      }
    }
  }
  
  if (!ethereumProvider) {
    throw new Error('No wallet provider available');
  }

  const walletClient = createWalletClient({
    account: getAddress(walletState.address),
    chain: bsc,
    transport: custom(ethereumProvider),
  });

  const resolvedAbi = resolveAbi(restParams.abi);
  const writeParams = {
    address: getAddress(restParams.address),
    abi: resolvedAbi,
    functionName: restParams.functionName,
    args: restParams.args || [],
    value: txValue,
  };
  // Pass through optional gas parameters
  if (gas !== undefined) writeParams.gas = gas;
  if (gasPrice !== undefined) writeParams.gasPrice = gasPrice;
  if (maxFeePerGas !== undefined) writeParams.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas !== undefined) writeParams.maxPriorityFeePerGas = maxPriorityFeePerGas;
  if (nonce !== undefined) writeParams.nonce = nonce;
  // Merge options
  Object.assign(writeParams, options);

  const hash = await walletClient.writeContract(writeParams);
  return { hash, wait: (waitOpts) => viemWaitForTransaction(hash, waitOpts) };
}

/**
 * viem version: wait for transaction confirmation
 */
export async function viemWaitForTransaction(txHash, options = {}) {
  const { confirmations = 1, timeout = 60000 } = options;
  const client = getViemPublicClient();
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations,
    timeout,
  });
  if (receipt.status === 'reverted') {
    throw new Error('Transaction reverted');
  }
  return receipt;
}

/**
 * Check if address is valid (viem version, preferred to use)
 */
export function viemIsValidAddress(address) {
  if (!address || typeof address !== 'string') return false;
  try {
    return viemIsAddress(address);
  } catch {
    return false;
  }
}

/**
 * viem version: format native coin amount (BNB)
 */
export function viemFormatBNB(amount, displayDecimals = 4) {
  return viemFormatTokenAmount(amount, 18, displayDecimals);
}

/**
 * viem version: format CFO amount
 */
export function viemFormatCFO(amount, displayDecimals = 2) {
  return viemFormatTokenAmount(amount, 18, displayDecimals);
}

/**
 * viem version: parse BNB amount
 */
export function viemParseBNB(amount) {
  try {
    return parseEther(amount.toString());
  } catch {
    return 0n;
  }
}

// ====== Swap Route common utilities (Pancake V2 optimal path selection): shared logic across three places, prevent code drift ======
// ====== + V3 quote engine + BaseRequest/ExtraData encoding (required by the new DexRouter) ======
export {
  buildCandidatePaths,
  getBestPathExactInput,
  getBestPathExactOutput,
  verifyPathOutputMatches,
  // === New V3 quote & mixed-route entry points ===
  encodeV3PoolKey,
  encodeV2PoolKey,
  getBestV3SingleHopExactInput,
  getBestQuoteExactInputMixed,
  // === New encoding utilities ===
  encodeBaseRequest,
  buildExtraData,
  appendExtraData,
  deductPlatformFee,
  getRequiredInputAllowanceWei,
} from '@/utils/swapRoutes.js';

