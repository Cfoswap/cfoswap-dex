// Swap gas ceiling resolution.
//
// Why this exists: the mining-pool factory forwards a swap notification to each
// pool the trader has enrolled in, but it bails out of the loop when
// `gasleft() < 650_000` (MiningPools.sol) — it skips the remaining pools
// WITHOUT reverting. Because of that graceful degradation, eth_estimateGas
// converges to the cheapest gas that makes the tx succeed, i.e. the swap with
// ZERO pool notifications. Multiplying that estimate by 1.5 still leaves less
// than 650k by the time the factory loop runs, so every pool is skipped
// (SwapForwarded notified=0). The fix is to budget for the notifications
// explicitly on top of the (swap-only) estimate, instead of scaling the
// underestimated value.

// Per-pool notification budget. Matches the factory's `gasleft() < 650_000`
// gate (the pool sub-call is capped at 600k, so 650k covers it plus frame cost).
export const POOL_NOTIFY_GAS = 650_000n;

// Fixed headroom over the swap-only estimate (multi-hop, farm notification,
// node-to-node estimate variance). Unused gas is refunded.
export const BASE_BUFFER_GAS = 300_000n;

// Fallback swap-only gas when eth_estimateGas fails (single-hop ~300k; this
// covers V3 / multi-hop plus the farm notification).
export const FALLBACK_BASE_GAS = 700_000n;

// Absolute floor so a pathologically small estimate can never under-fund a swap.
export const MIN_GAS_FLOOR = 1_200_000n;

// Conservative pool count assumed when the on-chain enrollment lookup fails,
// so an RPC hiccup never silently under-budgets notifications.
export const ASSUMED_POOL_COUNT_ON_ERROR = 3;

// Pure gas computation. `baseGas` is the swap-only estimate (or fallback),
// `poolCount` is the number of pools the trader is actively enrolled in.
export function computeSwapGas(baseGas, poolCount) {
  const base = typeof baseGas === 'bigint' && baseGas > 0n ? baseGas : FALLBACK_BASE_GAS;
  const n = Number.isFinite(poolCount) && poolCount > 0 ? Math.floor(poolCount) : 0;
  const gas = base + BigInt(n) * POOL_NOTIFY_GAS + BASE_BUFFER_GAS;
  return gas < MIN_GAS_FLOOR ? MIN_GAS_FLOOR : gas;
}

// Count actively-enrolled pools from the factory's getTraderPools result.
// viem returns a { poolList, activeList } object for named multi-output ABIs;
// accept the array tuple form too. Returns ASSUMED_POOL_COUNT_ON_ERROR on failure.
export function countActivePools(result) {
  try {
    const activeList = Array.isArray(result) ? result[1] : result?.activeList;
    if (!Array.isArray(activeList)) return ASSUMED_POOL_COUNT_ON_ERROR;
    return activeList.filter(Boolean).length;
  } catch {
    return ASSUMED_POOL_COUNT_ON_ERROR;
  }
}
