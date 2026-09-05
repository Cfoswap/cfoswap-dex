// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VestingAccumulator
/// @notice Per-reward linear vesting accumulator (rewards merged by UTC calendar day).
/// @dev Vesting rule: all rewards recorded within the same UTC calendar day are
/// merged into a single "daily bucket" whose start is fixed at 00:00 UTC of that
/// day. Rewards in a bucket vest linearly over vestingDuration starting at the
/// bucket start; each bucket counts down independently and never accelerates
/// another. The bucket start precedes that day's transactions, so a small portion
/// is already claimable on the transaction day itself (the later a transaction
/// occurs in the day, the more vesting is advanced, up to a 24h head start; the
/// bias is in the user's favor).
///
/// Gas profile: gas grows only with the number of active days, not with the
/// number of transactions — any number of transactions on the same day write a
/// single bucket. The number of unexpired buckets is naturally bounded by
/// vestingDuration in days (30/90/180/365). Expired buckets are lazily dequeued
/// at claim time (amortized O(1)); pruning is capped per call, and any unpruned
/// expired buckets are counted in full by released()'s read-only scan, so
/// correctness never depends on pruning having caught up.
library VestingAccumulator {
    struct DailyBucket {
        uint64 dayStart; // Timestamp of 00:00 UTC of the bucket's day
        uint192 amount; // Total rewards merged into that day
    }

    struct Accumulator {
        DailyBucket[] buckets; // Ascending by day; [0, head) are dequeued/pruned
        uint64 head; // Index of the oldest unpruned bucket (ring-buffer frontier)
        uint192 sumAmount; // Σ amount over unpruned buckets
        uint192 sumAmountStart; // Σ amount * dayStart over unpruned buckets
        uint192 totalAllocated; // Cumulative rewards ever recorded
        uint192 totalClaimed; // Cumulative amount ever claimed
    }

    /// @dev Max expired buckets dequeued per claim. Once amortized, the steady
    /// state prunes 0 to a few buckets; the cap is only hit on the first claim
    /// after long inactivity, and the remainder is covered by released()'s
    /// read-only scan.
    uint256 internal constant PRUNE_CAP = 64;

    /// @dev Record a reward: merge it into the current day's bucket if it is the
    /// same UTC day, otherwise push a new bucket. No pruning is done here —
    /// recording sits on the transaction path with a tight gas budget, so cleanup
    /// is deferred to the claim path and amortized there; the array grows by at
    /// most one slot per day, keeping costs predictable.
    function addReward(Accumulator storage a, uint256 amount) internal {
        if (amount == 0) return;
        uint256 dayStart = (block.timestamp / 1 days) * 1 days;

        uint256 n = a.buckets.length;
        if (n > a.head && uint256(a.buckets[n - 1].dayStart) == dayStart) {
            a.buckets[n - 1].amount += uint192(amount);
        } else {
            a.buckets.push(DailyBucket({dayStart: uint64(dayStart), amount: uint192(amount)}));
        }
        a.sumAmount += uint192(amount);
        a.sumAmountStart += uint192(amount * dayStart);
        a.totalAllocated += uint192(amount);
    }

    /// @dev Dequeue expired buckets: buckets with dayStart + duration <= now are
    /// fully vested, so their storage slots are deleted and their amounts removed
    /// from the active sums. At most PRUNE_CAP buckets are pruned per call;
    /// leaving some unpruned does not affect released()'s correctness (the
    /// read-only scan accounts for them).
    function prune(Accumulator storage a, uint256 duration) internal {
        uint256 nowTs = block.timestamp;
        uint256 h = a.head;
        uint256 n = a.buckets.length;
        uint256 cnt;
        while (h < n && cnt < PRUNE_CAP) {
            DailyBucket memory b = a.buckets[h];
            if (uint256(b.dayStart) + duration > nowTs) break;
            a.sumAmount -= b.amount;
            a.sumAmountStart -= uint192(uint256(b.amount) * uint256(b.dayStart));
            delete a.buckets[h];
            unchecked {
                ++h;
                ++cnt;
            }
        }
        a.head = uint64(h);
    }

    /// @notice Cumulative amount vested so far = fully vested dequeued buckets +
    /// fully vested unpruned buckets + the linear portion of unexpired buckets.
    /// @dev The unexpired portion is computed with an aggregated formula using a
    /// single division:
    ///   Σ amount_i * (now - dayStart_i) / duration
    ///   = (now * Σamount_i - Σamount_i*dayStart_i) / duration
    /// Versus per-bucket division this overpays by at most (bucket count - 1) wei
    /// (one fewer floor; the bias favors the user). Every active bucket satisfies
    /// elapsed < duration, so the active portion is strictly less than the active
    /// buckets' total and the result can never exceed totalAllocated. It is
    /// continuous across vesting expiry boundaries with no jumps.
    function released(Accumulator storage a, uint256 duration) internal view returns (uint256) {
        uint256 nowTs = block.timestamp;
        uint256 activeSum = uint256(a.sumAmount);
        // Dequeued buckets are fully vested; their total = totalAllocated - unpruned sum.
        uint256 releasedNow = uint256(a.totalAllocated) - activeSum;
        uint256 activeSumStart = uint256(a.sumAmountStart);

        uint256 h = a.head;
        uint256 n = a.buckets.length;
        for (uint256 i = h; i < n;) {
            DailyBucket storage b = a.buckets[i];
            uint256 ds = uint256(b.dayStart);
            if (ds + duration > nowTs) break; // Buckets are day-ascending; later ones expire later
            uint256 amt = uint256(b.amount);
            releasedNow += amt;
            activeSum -= amt;
            activeSumStart -= amt * ds;
            unchecked { ++i; }
        }

        if (activeSum > 0) {
            releasedNow += (nowTs * activeSum - activeSumStart) / duration;
        }
        return releasedNow;
    }

    /// @notice Amount currently claimable (vested - already claimed).
    function claimable(Accumulator storage a, uint256 duration) internal view returns (uint256) {
        uint256 rel = released(a, duration);
        uint256 claimed = uint256(a.totalClaimed);
        return rel > claimed ? rel - claimed : 0;
    }

    /// @dev Claim entry point: prune lazily first, then settle and book the
    /// amount against totalClaimed. Returns the amount to transfer; 0 means
    /// nothing is claimable. The caller is responsible for reentrancy protection
    /// and performing the actual token transfer.
    function settleClaim(Accumulator storage a, uint256 duration) internal returns (uint256 amount) {
        prune(a, duration);
        uint256 rel = released(a, duration);
        uint256 claimed = uint256(a.totalClaimed);
        if (rel <= claimed) return 0;
        amount = rel - claimed;
        a.totalClaimed = uint192(claimed + amount);
    }

    /// @notice Accumulator status view (frontend helper): total allocated, total
    /// claimed, vested so far, and currently claimable.
    function info(Accumulator storage a, uint256 duration)
        internal
        view
        returns (uint256 totalAllocated, uint256 totalClaimed, uint256 releasedNow, uint256 claimableNow)
    {
        totalAllocated = uint256(a.totalAllocated);
        totalClaimed = uint256(a.totalClaimed);
        releasedNow = released(a, duration);
        claimableNow = releasedNow > totalClaimed ? releasedNow - totalClaimed : 0;
    }
}
