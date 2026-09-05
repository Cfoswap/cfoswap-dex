// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {VestingAccumulator} from "../src/mining/VestingAccumulator.sol";

/// @dev Thin test wrapper: library functions are internal, exposed via the harness.
contract VestingHarness {
    VestingAccumulator.Accumulator internal acc;

    function add(uint256 amount) external {
        VestingAccumulator.addReward(acc, amount);
    }

    function releasedNow(uint256 duration) external view returns (uint256) {
        return VestingAccumulator.released(acc, duration);
    }

    function claimableNow(uint256 duration) external view returns (uint256) {
        return VestingAccumulator.claimable(acc, duration);
    }

    function doClaim(uint256 duration) external returns (uint256) {
        return VestingAccumulator.settleClaim(acc, duration);
    }

    function activeBuckets() external view returns (uint256) {
        return acc.buckets.length - acc.head;
    }

    function head() external view returns (uint256) {
        return acc.head;
    }

    function totalAllocated() external view returns (uint256) {
        return acc.totalAllocated;
    }
}

contract VestingAccumulatorTest is Test {
    VestingHarness internal h;

    uint256 internal constant D365 = 365 days;
    uint256 internal constant D30 = 30 days;
    uint256 internal constant MIDNIGHT = 1_700_000_000 - (1_700_000_000 % 86400);

    function setUp() public {
        h = new VestingHarness();
        vm.warp(MIDNIGHT + 1 hours); // 01:00 UTC
    }

    /// Any number of same-UTC-day rewards merge into one bucket: gas is
    /// independent of transaction count and rewards are claimable same-day.
    function test_01_SameDayMerges_SingleBucket_ClaimableSameDay() public {
        h.add(100 ether);
        for (uint256 i = 0; i < 199; i++) {
            h.add(1 ether);
        }
        assertEq(h.activeBuckets(), 1, "same-day rewards must merge into one bucket");
        assertEq(h.totalAllocated(), 299 ether, "allocated total");

        // Bucket starts 00:00 UTC; at 01:00, 299 * 1h/365d ~= 0.034 ether has vested.
        uint256 c = h.claimableNow(D365);
        assertGt(c, 0, "same-day reward must be partially claimable");
        assertLt(c, 1 ether, "only a tiny fraction vests on day one");
    }

    /// Daily buckets count down independently and never accelerate each
    /// other: a newly added bucket must not vest early when an older one matures.
    function test_02_IndependentBuckets_NoAcceleration() public {
        h.add(365 ether); // bucket A: d0

        vm.warp(MIDNIGHT + 365 days + 1 hours); // A just matured
        h.add(365 ether); // bucket B: d365

        // A fully matured (365); B has vested only 1 hour (~0.042).
        uint256 r1 = h.releasedNow(D365);
        assertGt(r1, 365 ether, "matured bucket A fully released");
        assertLt(r1, 365 ether + 0.1 ether, "bucket B only 1 hour vested");

        // B is 180 days in: total released ~= 365 + 180 = 545; it must never be 730
        // (the acceleration bug of the old merged-faucet model).
        vm.warp(MIDNIGHT + 365 days + 180 days + 1 hours);
        uint256 r2 = h.releasedNow(D365);
        assertGt(r2, 545 ether, "A full + B ~180 days");
        assertLt(r2, 546 ether, "B linear at 180/365");
        assertLt(r2, 730 ether, "new bucket must NOT accelerate from expired bucket");

        // B also matured: cumulative release equals the total allocated exactly.
        vm.warp(MIDNIGHT + 365 days + 380 days);
        uint256 got = h.doClaim(D365);
        assertEq(got, 730 ether, "life-of-user claim equals total allocated");
        assertEq(h.claimableNow(D365), 0, "nothing left");
    }

    /// Exact linear rate: 730 ether at 12:00 (12h/8760h = 1/730) vests exactly 1 ether.
    function test_03_LinearRate_ExactMath() public {
        vm.warp(MIDNIGHT + 12 hours);
        h.add(730 ether);
        assertEq(h.claimableNow(D365), 1 ether, "730 * 12h/365d == 1");

        assertEq(h.doClaim(D365), 1 ether, "claim 1");

        vm.warp(MIDNIGHT + 36 hours); // 1.5 days in -> 3 released cumulatively
        assertEq(h.releasedNow(D365), 3 ether, "730 * 1.5d/365d == 3");
        assertEq(h.claimableNow(D365), 2 ether, "2 new after 1 claimed");
        assertEq(h.doClaim(D365), 2 ether, "claim 2");
    }

    /// A reward added on the same UTC day after a claim merges into that
    /// day's bucket; the already-claimed portion is never paid twice.
    function test_04_MergeAfterPartialClaim_NoDoubleCount() public {
        vm.warp(MIDNIGHT + 12 hours);
        h.add(730 ether);
        assertEq(h.doClaim(D365), 1 ether);

        vm.warp(MIDNIGHT + 18 hours); // still the same UTC day
        h.add(730 ether);
        // Bucket total 1460; 18h vests 1460*18h/365d = 3; 1 already claimed -> 2 claimable.
        assertEq(h.activeBuckets(), 1, "same-day merge after claim");
        assertEq(h.releasedNow(D365), 3 ether, "1460 * 18h/365d == 3");
        assertEq(h.claimableNow(D365), 2 ether, "already-claimed excluded");
    }

    /// Cross-day: one bucket per day; under a 30-day vesting duration the
    /// matured buckets release in full and the total matches exactly.
    function test_05_MultiDay_Pool30d_FullReleaseExact() public {
        for (uint256 i = 0; i < 10; i++) {
            vm.warp(MIDNIGHT + i * 1 days + 12 hours);
            h.add(100 ether);
        }
        assertEq(h.activeBuckets(), 10, "one bucket per active day");

        vm.warp(MIDNIGHT + 40 days); // latest bucket d9 +30d = d39 matured
        assertEq(h.releasedNow(D30), 1000 ether, "all buckets matured exactly");
        assertEq(h.doClaim(D30), 1000 ether, "claim full");
        assertEq(h.claimableNow(D30), 0, "nothing left");
        assertEq(h.activeBuckets(), 0, "matured buckets pruned on claim");
    }

    /// First claim after long inactivity: matured buckets exceed the
    /// per-call prune cap, so a read-only walk covers the remainder and
    /// funds never get stuck; the second claim prunes the rest.
    function test_06_PruneCap_HeavyHistory_ClaimNeverStuck() public {
        for (uint256 i = 0; i < 100; i++) {
            vm.warp(MIDNIGHT + i * 1 days + 12 hours);
            h.add(1 ether);
        }
        vm.warp(MIDNIGHT + 200 days); // all 100 buckets matured under the 30-day duration

        uint256 got = h.doClaim(D30);
        assertEq(got, 100 ether, "all 100 matured buckets claimable despite prune cap");
        assertEq(h.claimableNow(D30), 0, "funds not stuck");
        assertEq(h.activeBuckets(), 36, "first claim prunes cap (64), walk covers rest");

        assertEq(h.doClaim(D30), 0, "no double claim");
        assertEq(h.activeBuckets(), 0, "second claim prunes remainder");
    }

    /// Conservation: two claims (mid-term + fully matured) sum exactly to
    /// the total allocated.
    function test_07_Conservation_LifetimeClaimsEqualAllocated() public {
        h.add(100 ether);

        vm.warp(MIDNIGHT + 100 days + 1 hours);
        uint256 c1 = h.doClaim(D365);
        assertGt(c1, 27 ether, "~100*100/365 vested");
        assertLt(c1, 28 ether);

        h.add(200 ether); // new daily bucket

        vm.warp(MIDNIGHT + 500 days); // both buckets matured
        uint256 c2 = h.doClaim(D365);
        assertEq(c1 + c2, 300 ether, "lifetime claims == total allocated");
        assertEq(h.doClaim(D365), 0, "repeated claim yields zero");
    }
}
