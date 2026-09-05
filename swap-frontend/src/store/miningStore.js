import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MINING_ABI, MINING_ADDRESS, MINING_POOL_FACTORY_ABI, MINING_POOL_FACTORY_ADDRESS } from '@/config/index.js';
import { viemReadContract, getViemPublicClient } from '@/utils/index.js';
import { getAddress, formatUnits as viemFormatUnits, keccak256, concat, pad, toHex } from 'viem';

const MINING_GLOBAL_CACHE_TTL = 60_000; // Global data cache TTL 60s
const MINING_USER_CACHE_TTL = 30_000;   // User data cache TTL 30s

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// CfoSwapMining deployed storage layout (verified on-chain against getVestingInfo):
//   slot 11 = mapping(address => VestingAccumulator.Accumulator) userAcc
// Accumulator struct slots relative to the mapping value base:
//   +0 buckets.length, +1 packed head(uint64)|sumAmount(uint192),
//   +2 sumAmountStart(uint192), +3 totalAllocated(uint192), +4 totalClaimed(uint192)
// Bucket element i is at keccak256(base) + i, packed dayStart(uint64)|amount(uint192).
// One bucket == one UTC day that produced rewards, i.e. one vesting "batch".
const USER_ACC_MAPPING_SLOT = 11n;
const U64_MASK = (1n << 64n) - 1n;
const U192_MASK = (1n << 192n) - 1n;

const _mappingBaseSlot = (userAddr, mappingSlot) =>
  keccak256(concat([pad(userAddr, { size: 32 }), pad(toHex(mappingSlot), { size: 32 })]));
const _plusSlot = (hexSlot, delta) => toHex(BigInt(hexSlot) + BigInt(delta));

let _vestingDurationCache = null;
async function _getVestingDuration(miningAddr) {
  if (_vestingDurationCache != null) return _vestingDurationCache;
  _vestingDurationCache = await viemReadContract({
    address: miningAddr,
    abi: MINING_ABI,
    functionName: 'VESTING_DURATION',
  });
  return _vestingDurationCache;
}

/**
 * Read the number of daily buckets still vesting for a user via raw storage
 * slots (the contract exposes no bucket-count getter). Returns null when the
 * on-chain layout cannot be validated, so the UI can hide the count.
 */
async function _readVestingBucketCount(miningAddr, userAddr, totalAllocatedExpected) {
  try {
    const client = getViemPublicClient();
    const duration = await _getVestingDuration(miningAddr);
    const base = _mappingBaseSlot(getAddress(userAddr), USER_ACC_MAPPING_SLOT);

    const length = BigInt(await client.getStorageAt({ address: miningAddr, slot: base }));
    if (length === 0n) return 0;

    // Cross-validate the raw struct against getVestingInfo before trusting it.
    const allocRaw = BigInt(await client.getStorageAt({ address: miningAddr, slot: _plusSlot(base, 3) })) & U192_MASK;
    if (allocRaw !== BigInt(totalAllocatedExpected)) {
      console.warn('[miningStore] vesting storage layout mismatch, hiding bucket count');
      return null;
    }

    const packedHead = BigInt(await client.getStorageAt({ address: miningAddr, slot: _plusSlot(base, 1) }));
    const head = packedHead & U64_MASK;
    if (head >= length) return 0;

    const dataStart = keccak256(base);
    const readDayStart = async (i) => {
      const raw = BigInt(await client.getStorageAt({ address: miningAddr, slot: _plusSlot(dataStart, Number(i)) }));
      return raw & U64_MASK;
    };

    // Buckets are ascending by dayStart. Binary search the first bucket in
    // [head, length) whose vesting window is still open (dayStart + duration > now).
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    let lo = head;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const dayStart = await readDayStart(mid);
      if (dayStart + BigInt(duration) > nowTs) hi = mid;
      else lo = mid + 1n;
    }
    return Number(length - lo);
  } catch (e) {
    console.warn('[miningStore] vesting bucket count read failed:', e);
    return null;
  }
}

export const useMiningStore = create(
  persist(
    (set, get) => ({
      // Global mining data
      phase1Produced: 0,
      phase2Produced: 0,
      totalInviteBonus: '0',
      phase1Cap: 10_000_000,
      phase2Cap: 90_000_000,
      lastGlobalUpdateAt: 0,

      // User mining data (persisted)
      pendingReward: '0',
      totalMinedAmount: '0',
      hasBound: false,
      inviterAddress: '',
      vestingTotal: '0',
      vestingReleased: '0',
      vestingClaimed: '0',
      vestingCount: null, // null = unknown (hidden in UI), number = daily buckets still vesting
      isOptedOut: false,
      currentUserAddr: null,
      lastUserUpdateAt: 0,

      // Loading states
      loadingGlobal: false,
      loadingUser: false,
      error: null,

      /**
       * Load global mining data (does not require wallet connection)
       */
      fetchGlobal: async (options = {}) => {
        const { silent = false } = options;
        if (!silent) set({ loadingGlobal: true, error: null });

        try {
          const miningAddr = getAddress(MINING_ADDRESS);
          let stage1 = 0n, stage2 = 0n, totalRef = 0n, s1Cap = 0n, s2Cap = 0n;

          try { stage1 = await viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'totalMintedStage1' }); } catch (e) { console.warn('[miningStore] totalMintedStage1 failed:', e); }
          try { stage2 = await viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'totalMintedStage2' }); } catch (e) { console.warn('[miningStore] totalMintedStage2 failed:', e); }
          try { totalRef = await viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'totalReferralDistributed' }); } catch (e) { console.warn('[miningStore] totalReferralDistributed failed:', e); }
          try { s1Cap = await viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'stage1Cap' }); } catch (e) {}
          try { s2Cap = await viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'stage2Cap' }); } catch (e) {}

          set({
            phase1Produced: Number(viemFormatUnits(stage1, 18)),
            phase2Produced: Number(viemFormatUnits(stage2, 18)),
            totalInviteBonus: viemFormatUnits(totalRef, 18),
            phase1Cap: s1Cap > 0n ? Number(viemFormatUnits(s1Cap, 18)) : 10_000_000,
            phase2Cap: s2Cap > 0n ? Number(viemFormatUnits(s2Cap, 18)) : 90_000_000,
            lastGlobalUpdateAt: Date.now(),
            loadingGlobal: false,
          });
        } catch (e) {
          console.error('[miningStore] global mining data read failed:', e);
          set({ loadingGlobal: false, error: e });
        }
      },

      /**
       * Load user mining data
       */
      fetchUser: async (userAddr, options = {}) => {
        const { silent = false } = options;
        if (!userAddr) {
          set({
            pendingReward: '0',
            totalMinedAmount: '0',
            hasBound: false,
            inviterAddress: '',
            vestingTotal: '0',
            vestingReleased: '0',
            vestingClaimed: '0',
            vestingCount: null,
            isOptedOut: false,
            currentUserAddr: null,
            loadingUser: false,
          });
          return;
        }

        if (!silent) set({ loadingUser: true, error: null });

        try {
          const miningAddr = getAddress(MINING_ADDRESS);
          const factoryAddr = getAddress(MINING_POOL_FACTORY_ADDRESS);
          const userChecksum = getAddress(userAddr);

          // Fetch all user data in parallel:
          //  - getClaimable: claimable CFO right now (mining contract)
          //  - getVestingInfo: daily-bucket linear vesting (mining contract)
          //  - miningOptOut: user trade-mining opt-out switch
          //  - globalReferrerOf: bind-once referral map lives on the pool factory
          const [claimable, vestingInfo, optedOut, ref] = await Promise.all([
            viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'getClaimable', args: [userChecksum] })
              .catch(e => { console.warn('[miningStore] getClaimable failed:', e); return 0n; }),
            viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'getVestingInfo', args: [userChecksum] })
              .catch(e => { console.warn('[miningStore] getVestingInfo failed:', e); return null; }),
            viemReadContract({ address: miningAddr, abi: MINING_ABI, functionName: 'miningOptOut', args: [userChecksum] })
              .catch(e => { console.warn('[miningStore] miningOptOut failed:', e); return false; }),
            viemReadContract({ address: factoryAddr, abi: MINING_POOL_FACTORY_ABI, functionName: 'globalReferrerOf', args: [userChecksum] })
              .catch(e => { console.warn('[miningStore] globalReferrerOf failed:', e); return ZERO_ADDR; }),
          ]);

          const bound = ref && ref !== ZERO_ADDR;
          const pendingRewardStr = viemFormatUnits(claimable, 18);

          // Vesting tuple: (totalAllocated, totalClaimed, releasedNow, claimableNow)
          const totalAllocated = vestingInfo ? BigInt(vestingInfo[0] ?? 0n) : 0n;
          const totalClaimed = vestingInfo ? BigInt(vestingInfo[1] ?? 0n) : 0n;
          const releasedNow = vestingInfo ? BigInt(vestingInfo[2] ?? 0n) : 0n;
          const totalAllocatedStr = viemFormatUnits(totalAllocated, 18);
          const totalClaimedStr = viemFormatUnits(totalClaimed, 18);
          const releasedNowStr = viemFormatUnits(releasedNow, 18);

          // Daily-bucket count still vesting (raw storage read; null if unreadable)
          const vestingCount = await _readVestingBucketCount(miningAddr, userChecksum, totalAllocated);

          set({
            pendingReward: pendingRewardStr,
            totalMinedAmount: totalAllocatedStr,
            vestingTotal: totalAllocatedStr,
            vestingReleased: releasedNowStr,
            vestingClaimed: totalClaimedStr,
            vestingCount,
            isOptedOut: !!optedOut,
            hasBound: !!bound,
            inviterAddress: bound ? ref : '',
            currentUserAddr: userAddr,
            lastUserUpdateAt: Date.now(),
            loadingUser: false,
          });
        } catch (e) {
          console.error('[miningStore] user mining data read failed:', e);
          set({ loadingUser: false, error: e });
        }
      },

      /**
       * Called when opening mining page: skips reload if cache is still valid
       */
      maybeRefreshMining: (userAddr = null) => {
        const {
          loadingGlobal, loadingUser,
          lastGlobalUpdateAt, lastUserUpdateAt,
          currentUserAddr,
        } = get();
        const now = Date.now();
        const globalExpired = now - lastGlobalUpdateAt > MINING_GLOBAL_CACHE_TTL;
        const userExpired = now - lastUserUpdateAt > MINING_USER_CACHE_TTL;
        const addrChanged = currentUserAddr !== userAddr;

        // Refresh global data if never loaded or cache expired
        if (!loadingGlobal && (lastGlobalUpdateAt === 0 || globalExpired)) {
          const silentGlobal = lastGlobalUpdateAt > 0;
          get().fetchGlobal({ silent: silentGlobal });
        }

        // User data: refresh if address changed, never loaded, or cache expired
        if (userAddr) {
          if (!loadingUser && (lastUserUpdateAt === 0 || userExpired || addrChanged)) {
            const silentUser = lastUserUpdateAt > 0 && !addrChanged;
            get().fetchUser(userAddr, { silent: silentUser });
          }
        } else if (currentUserAddr) {
          // Wallet disconnected, clear user data
          get().clearUserData();
        }
      },

      /**
       * Manual refresh (called when clicking refresh button or after claiming rewards)
       */
      refreshMining: (userAddr = null) => {
        get().fetchGlobal({ silent: false });
        if (userAddr) {
          get().fetchUser(userAddr, { silent: false });
        } else {
          get().clearUserData();
        }
      },

      /**
       * Invalidate cache (called after claiming rewards, forces refresh on next maybeRefresh)
       */
      invalidateMining: () => {
        set({ lastGlobalUpdateAt: 0, lastUserUpdateAt: 0 });
      },

      /**
       * Clear user data (called when wallet is disconnected)
       */
      clearUserData: () => {
        set({
          pendingReward: '0',
          totalMinedAmount: '0',
          hasBound: false,
          inviterAddress: '',
          vestingTotal: '0',
          vestingReleased: '0',
          vestingClaimed: '0',
          vestingCount: null,
          isOptedOut: false,
          currentUserAddr: null,
          lastUserUpdateAt: 0,
          loadingUser: false,
        });
      },
    }),
    {
      name: 'cfoswap-mining-store',
      version: 3,
      // Only persist user data and cache timestamps, do not persist loading states
      partialize: (state) => ({
        pendingReward: state.pendingReward,
        totalMinedAmount: state.totalMinedAmount,
        hasBound: state.hasBound,
        inviterAddress: state.inviterAddress,
        vestingTotal: state.vestingTotal,
        vestingReleased: state.vestingReleased,
        currentUserAddr: state.currentUserAddr,
        lastUserUpdateAt: state.lastUserUpdateAt,
        phase1Produced: state.phase1Produced,
        phase2Produced: state.phase2Produced,
        totalInviteBonus: state.totalInviteBonus,
        phase1Cap: state.phase1Cap,
        phase2Cap: state.phase2Cap,
        lastGlobalUpdateAt: state.lastGlobalUpdateAt,
      }),
    }
  )
);
