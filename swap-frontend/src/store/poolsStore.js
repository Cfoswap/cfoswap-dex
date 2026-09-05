import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MINING_POOL_FACTORY_ADDRESS,
  MINING_POOL_FACTORY_ABI,
  MINING_POOL_ABI,
  PAIR_ABI,
  ERC20_ABI,
  TOKENS,
} from '@/config/index.js';
import { getReadProvider, withRpcFallback, viemReadContract, calcBigIntPct } from '@/utils/index.js';
import { getAddress, formatEther as viemFormatEther } from 'viem';

const POOLS_CACHE_TTL = 30_000; // Pool list cache TTL 30s

// BigInt serialization/deserialization utilities
const BIGINT_FLAG = '__b__';
const replacer = (_key, value) => {
  if (typeof value === 'bigint') return { [BIGINT_FLAG]: value.toString() };
  return value;
};
const reviver = (_key, value) => {
  if (value && typeof value === 'object' && BIGINT_FLAG in value) {
    return BigInt(value[BIGINT_FLAG]);
  }
  return value;
};

const symbolCache = {};
async function getTokenSymbol(address) {
  if (!address) return '';
  const addr = address.toLowerCase();
  if (symbolCache[addr]) return symbolCache[addr];
  for (const key of Object.keys(TOKENS)) {
    const tok = TOKENS[key];
    if (tok.address && tok.address.toLowerCase() === addr) {
      symbolCache[addr] = key;
      return key;
    }
  }
  try {
    const sym = await Promise.race([
      viemReadContract({
        address: getAddress(address),
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('symbol timeout')), 3000))
    ]);
    symbolCache[addr] = sym;
    return sym;
  } catch {
    symbolCache[addr] = address.slice(0, 6);
    return symbolCache[addr];
  }
}

async function mapPoolBaseInfo(poolAddr) {
  const info = await viemReadContract({
    address: getAddress(poolAddr),
    abi: MINING_POOL_ABI,
    functionName: 'poolInfo',
  });
  // poolInfo() layout: name, rewardToken, totalReward, totalRewardRequired,
  // depositedReward, distributedReward, distributedReferral, remainingReward,
  // vestingDuration, mode, targetPair, isActivated, isEnded, isVerified,
  // isDelisted, startTime, boostPaidTotal, poolOwner, rewardPerUsd, l1bp, l2bp, referralRateBp[8]
  const [
    name, rewardToken, totalReward, , , , ,
    remainingReward, vestingDuration, mode, targetPair,
    isActivated, isEnded, isVerified, , startTime,
    boostPaidTotal, creator, rewardPerUsd, l1bp, l2bp,
  ] = info;
  const totalDistributed = BigInt(totalReward || 0n) - BigInt(remainingReward || 0n);
  const vestingDays = vestingDuration ? Number(vestingDuration) / 86400 : 0;
  const modeStr = Number(mode) === 1 ? 'target_pair' : 'all_pairs';
  const boostPaid = Number(viemFormatEther(boostPaidTotal || 0n));
  const referralRewardPercent = (Number(l1bp || 0) + Number(l2bp || 0)) / 100;
  const rewardPerUsdNum = Number(viemFormatEther(rewardPerUsd || 0n));

  const rewardTokenSymbol = await getTokenSymbol(rewardToken);

  let pairDisplay = '';
  let pairTokenA = '';
  let pairTokenB = '';
  if (modeStr === 'target_pair' && targetPair) {
    try {
      let t0, t1;
      try {
        [t0, t1] = await Promise.race([
          viemReadContract({
            address: getAddress(MINING_POOL_FACTORY_ADDRESS),
            abi: MINING_POOL_FACTORY_ABI,
            functionName: 'getPairTokens',
            args: [getAddress(targetPair)],
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('getPairTokens timeout')), 3000))
        ]);
      } catch (e) {
        t0 = await viemReadContract({
          address: getAddress(targetPair),
          abi: PAIR_ABI,
          functionName: 'token0',
        });
        t1 = await viemReadContract({
          address: getAddress(targetPair),
          abi: PAIR_ABI,
          functionName: 'token1',
        });
      }
      let s0 = await getTokenSymbol(t0);
      let s1 = await getTokenSymbol(t1);
      if (s0 === 'WBNB') s0 = 'BNB';
      if (s1 === 'WBNB') s1 = 'BNB';
      if (s1 === 'BNB') {
        const tmpS = s0; s0 = s1; s1 = tmpS;
        const tmpA = t0; t0 = t1; t1 = tmpA;
      }
      pairDisplay = `${s0}/${s1}`;
      pairTokenA = t0;
      pairTokenB = t1;
    } catch (e) {
      pairDisplay = '';
    }
  }

  // Participant count from the pool's on-chain enrolledCount counter
  // (enroll +1 / unenroll -1). The pool list comes from the configured
  // factory, so every pool is expected to support it; a read failure leaves
  // the count at 0 (UI shows '—') and never drops the pool.
  let participants = 0;

  const totalReferralDistributed = BigInt(info[6] || 0n);
  const progress = calcBigIntPct(totalDistributed, totalReward);

  let poolBalance = 0n;
  try {
    poolBalance = await Promise.race([
      viemReadContract({
        address: getAddress(rewardToken),
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [getAddress(poolAddr)],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('balanceOf timeout')), 3000))
    ]);
  } catch (e) {
    poolBalance = 0n;
  }

  try {
    const count = await Promise.race([
      viemReadContract({
        address: getAddress(poolAddr),
        abi: MINING_POOL_ABI,
        functionName: 'enrolledCount',
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('enrolledCount timeout')), 3000))
    ]);
    participants = Number(count || 0n);
  } catch (e) {
    participants = 0;
  }

  return {
    address: poolAddr,
    name,
    rewardToken,
    rewardTokenSymbol,
    mode: modeStr,
    pairDisplay,
    pairTokenA,
    pairTokenB,
    totalReward,
    remainingReward,
    totalDistributed,
    poolBalance,
    progress,
    participants,
    totalReferralDistributed,
    boostPaid,
    isVerified: !!isVerified,
    isOfficial: false,
    isHot: boostPaid > 0,
    isEnded: !!isEnded,
    startTime: startTime ? Number(startTime) * 1000 : 0,
    referralRewardPercent,
    creator,
    rewardPerUsd: rewardPerUsdNum,
    vestingDays,
    isActivated: !!isActivated,
    myPending: 0n,
    myClaimed: 0n,
    vestingTotal: 0n,
    vestingReleased: 0n,
    myReferralEarned: 0n,
    isEnrolled: false,
  };
}

async function fillPoolUserData(poolAddr, userAddr) {
  if (!userAddr) return null;
  let isEnrolled = false;
  let myPending = 0n;
  let myClaimed = 0n;
  let vestingTotal = 0n;
  let vestingReleased = 0n;
  // The pool contract emits ReferralReward events but exposes no
  // per-user referral-earned view, so this stays 0 (no data source).
  const myReferralEarned = 0n;
  try {
    const poolChecksum = getAddress(poolAddr);
    const userChecksum = getAddress(userAddr);
    [myPending, isEnrolled] = await Promise.all([
      viemReadContract({
        address: poolChecksum,
        abi: MINING_POOL_ABI,
        functionName: 'getClaimable',
        args: [userChecksum],
      }, { maxRetries: 3 }).catch((e) => { console.warn('[fillPoolUserData] getClaimable read failed:', poolAddr, e?.shortMessage || e?.message); return 0n; }),
      viemReadContract({
        address: poolChecksum,
        abi: MINING_POOL_ABI,
        functionName: 'enrolledTraders',
        args: [userChecksum],
      }, { maxRetries: 3 }).catch((e) => { console.warn('[fillPoolUserData] enrolledTraders read failed:', poolAddr, e?.shortMessage || e?.message); return false; }),
    ]);
    // Daily-bucket linear vesting tuple:
    // (totalAllocated, totalClaimed, releasedNow, claimableNow)
    const acc = await viemReadContract({
      address: poolChecksum,
      abi: MINING_POOL_ABI,
      functionName: 'getVestingInfo',
      args: [userChecksum],
    }, { maxRetries: 3 }).catch((e) => { console.warn('[fillPoolUserData] getVestingInfo read failed:', poolAddr, e?.shortMessage || e?.message); return null; });
    if (acc) {
      // getVestingInfo: (totalAllocated, totalClaimed, releasedNow, claimableNow)
      vestingTotal = BigInt(acc[0] ?? 0n);
      myClaimed = BigInt(acc[1] ?? 0n);
      vestingReleased = BigInt(acc[2] ?? 0n);
    }
    // isEnrolled is derived only from on-chain enrolledTraders: accrued
    // rewards remain claimable after unenrolling, so non-zero
    // vestingTotal/myPending must not imply enrolled state (claim does not
    // check enrollment on-chain).
  } catch (e) {
    console.warn('[fillPoolUserData] full pipeline failed:', poolAddr, e?.shortMessage || e?.message || e);
  }
  return { myPending, myClaimed, vestingTotal, vestingReleased, myReferralEarned, isEnrolled: !!isEnrolled };
}

export const usePoolsStore = create(
  persist(
    (set, get) => ({
      pools: [],
      loading: false,
      loadingUserData: false,
      error: null,
      lastPoolsUpdateAt: 0,
      currentUserAddr: null,

  /**
   * Load mining pool list
   * @param {object} options
   * @param {boolean} [options.silent=false] - Silent refresh: do not show loading
   * @param {string} [options.userAddr] - User address for loading personal data
   */
  fetchPools: async (options = {}) => {
    const { silent = false, userAddr = null } = options;
    if (!silent) set({ loading: true, error: null });

    try {
      const poolAddresses = await withRpcFallback(async () => {
        return await viemReadContract({
          address: getAddress(MINING_POOL_FACTORY_ADDRESS),
          abi: MINING_POOL_FACTORY_ABI,
          functionName: 'getAllPools',
        });
      }, { maxRetries: 2 });

      getReadProvider(false);

      const baseList = await Promise.all(
        poolAddresses.map(async (addr) => {
          try {
            return await mapPoolBaseInfo(addr);
          } catch (e) {
            console.warn('[poolsStore] pool base info read failed:', addr, e?.message || e);
            return null;
          }
        })
      );
      const validBaseList = baseList.filter(Boolean);

      set({
        pools: validBaseList,
        loading: false,
        lastPoolsUpdateAt: Date.now(),
        currentUserAddr: userAddr,
      });

      // Load personal data asynchronously
      if (userAddr && validBaseList.length > 0) {
        set({ loadingUserData: true });
        (async () => {
          try {
            const CONCURRENCY = 5;
            for (let i = 0; i < validBaseList.length; i += CONCURRENCY) {
              const batch = validBaseList.slice(i, i + CONCURRENCY);
              await Promise.all(
                batch.map(async (pool) => {
                  const userData = await fillPoolUserData(pool.address, userAddr);
                  if (userData) {
                    // Functional patch: never clobber rows updated by
                    // concurrent async updates
                    set((state) => ({
                      pools: state.pools.map((p) =>
                        p.address.toLowerCase() === pool.address.toLowerCase()
                          ? { ...p, ...userData }
                          : p
                      ),
                    }));
                  }
                })
              );
            }
          } catch (e) {
            console.warn('[poolsStore] user data loading failed:', e);
          } finally {
            set({ loadingUserData: false });
          }
        })();
      }
    } catch (e) {
      console.error('[poolsStore] pool list loading failed:', e);
      if (!silent) {
        set({ loading: false, error: e });
      } else {
        set({ loading: false });
      }
    }
  },

  // Called when opening pools page: skips reload if cache exists and has not expired
  maybeRefreshPools: (userAddr = null) => {
    const { loading, lastPoolsUpdateAt, currentUserAddr } = get();
    if (loading) return;
    const now = Date.now();
    const expired = now - lastPoolsUpdateAt > POOLS_CACHE_TTL;
    const addrChanged = currentUserAddr !== userAddr;
    if (lastPoolsUpdateAt === 0 || expired || addrChanged) {
      const silent = lastPoolsUpdateAt > 0 && !addrChanged;
      get().fetchPools({ silent, userAddr });
    }
  },

  // Manual refresh
  refreshPools: (userAddr = null) => {
    return get().fetchPools({ silent: false, userAddr });
  },

  // Invalidate cache (called after claiming rewards or creating a pool)
  invalidatePools: () => {
    set({ lastPoolsUpdateAt: 0 });
  },

  // Clear (called when wallet is disconnected)
  clearPoolsUserData: () => {
    const { pools } = get();
    // Only clear personal data fields, keep base pool list
    const resetPools = pools.map(p => ({
      ...p,
      myPending: 0n,
      myClaimed: 0n,
      vestingTotal: 0n,
      vestingReleased: 0n,
      myReferralEarned: 0n,
      isEnrolled: false,
    }));
    set({
      pools: resetPools,
      currentUserAddr: null,
      loadingUserData: false,
    });
  },
    }),
    {
      name: 'cfoswap-pools-store',
      // Custom storage handling for BigInt serialization
      storage: {
        getItem: (name) => {
          try {
            const str = localStorage.getItem(name);
            if (!str) return null;
            return JSON.parse(str, reviver);
          } catch (e) {
            return null;
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value, replacer));
          } catch (e) {}
        },
        removeItem: (name) => {
          try { localStorage.removeItem(name); } catch (e) {}
        },
      },
      // Only persist data and cache timestamps, do not persist loading/error states
      partialize: (state) => ({
        pools: state.pools,
        lastPoolsUpdateAt: state.lastPoolsUpdateAt,
        currentUserAddr: state.currentUserAddr,
      }),
      version: 5,
    }
  )
);
