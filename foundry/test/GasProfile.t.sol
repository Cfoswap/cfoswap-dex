// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {CfoToken} from "../src/token/CfoToken.sol";
import {CfoMiningPoolFactory, CfoMiningPool} from "../src/mining/CfoMiningPools.sol";
import {CfoMining} from "../src/mining/CfoMining.sol";

interface IERC20Mock {
    function approve(address, uint256) external returns (bool);
}

// Minimal LP stand-in: only token0()/token1() are read by the factory.
contract MockPair {
    address public immutable token0;
    address public immutable token1;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }
}

/// @title Gas profiling for the mining notification budget chain.
/// @dev Runs on a local (non-fork) chain. Measures the worst-case gas cost
///      of each notification leg so the router floor and factory budgets can
///      be calibrated from real numbers instead of guesses:
///        - CfoMining.onSwap  (network-wide farm, 8-level referrals)
///        - CfoMiningPoolFactory.onSwap  (factory fan-out, per enrolled pool)
///        - factory view call     (active pool count for the router floor)
contract GasProfileTest is Test {
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;

    CfoToken internal token;
    CfoMining internal mining;
    CfoMiningPoolFactory internal factory;

    address internal trader = address(0xA11CE);
    address internal trader2 = address(0xB0B);

    // 8-level upline chain.
    address[8] internal refs;

    address[] internal pools;

    uint256[8] internal rates8 = [
        uint256(1000), 500, 300, 300, 300, 300, 150, 150
    ]; // sum = 3000 bps (30% cap)

    function setUp() public {
        token = new CfoToken();
        mining = new CfoMining(365 days);
        factory = new CfoMiningPoolFactory();

        // Fund CFO.
        token.grantMinterQuota(address(this), 200_000_000 ether);
        token.mint(address(this), 50_000_000 ether);

        // Wire trade mining.
        token.grantMinterQuota(address(mining), 200_000_000 ether);
        mining.setCfoToken(address(token));
        mining.setMiningPoolFactory(address(factory));
        mining.addCaller(address(this));
        mining.setReferralRates(rates8);

        // Wire pool factory.
        factory.setCfoToken(address(token));
        factory.setCfoMining(address(mining));
        factory.setCreatePoolFee(0);
        factory.addCaller(address(this));

        // 8-level referral chain for both traders.
        for (uint256 i = 0; i < 8; i++) {
            refs[i] = address(uint160(0x1000 + i));
        }
        factory.bindReferrerOf(trader, refs[0]);
        factory.bindReferrerOf(trader2, refs[0]);
        for (uint256 i = 0; i < 7; i++) {
            factory.bindReferrerOf(refs[i], refs[i + 1]);
        }
    }

    function _newFundedEnrolledPool(address who) internal returns (address pool) {
        MockPair pair = new MockPair(WBNB, CAKE);
        pool = factory.createPoolV2(
            "gas-pool",
            address(token),
            100_000 ether,       // totalReward
            0.1 ether,           // rewardPerUsd: 1000 USDT volume -> 100 CFO
            1,                   // mode = pair pool
            address(pair),
            3,                   // 365-day vesting
            rates8
        );
        IERC20Mock(address(token)).approve(pool, type(uint256).max);
        CfoMiningPool(pool).depositReward(100_000 ether);
        vm.prank(who);
        CfoMiningPool(pool).enroll();
        pools.push(pool);
    }

    function testProfileAll() external {
        address[] memory path = new address[](2);
        path[0] = USDT;
        path[1] = CAKE;
        uint256 vol = 1_000 ether;

        // ---------- 1. Network-wide mining leg ----------
        // Cold (first swap for trader, accumulator init + 8-level payouts).
        uint256 g0 = gasleft();
        mining.onSwap(trader, vol, refs[0]);
        emit log_named_uint("mining.onSwap cold (8-lvl) gas", g0 - gasleft());

        // Warm (steady state).
        g0 = gasleft();
        mining.onSwap(trader, vol, refs[0]);
        emit log_named_uint("mining.onSwap warm (8-lvl) gas", g0 - gasleft());

        // No-referrer warm (no referral payouts).
        g0 = gasleft();
        mining.onSwap(address(0xDEAD), vol, address(0));
        emit log_named_uint("mining.onSwap warm (no ref) gas", g0 - gasleft());

        // ---------- 2. Factory fan-out leg ----------
        // Factory overhead with zero enrolled pools for the trader.
        g0 = gasleft();
        factory.onSwap(address(0xFA17), vol, refs[0], path);
        emit log_named_uint("factory.onSwap 0 pools gas", g0 - gasleft());

        // Incremental: pools for `trader` are created/enrolled one by one;
        // each step the new pool is cold (first reward) while older pools
        // are warm. Marginal cost ~= warm pool cost + one cold delta.
        uint256 prev;
        for (uint256 n = 1; n <= 10; n++) {
            _newFundedEnrolledPool(trader);
            g0 = gasleft();
            factory.onSwap(trader, vol, refs[0], path);
            uint256 used = g0 - gasleft();
            emit log_named_uint("factory.onSwap cumulative gas", used);
            emit log_named_uint("  marginal vs previous", used - prev);
            prev = used;
        }

        // ---------- 3. All-cold fan-out (worst case single swap) ----------
        // trader2 enrolls into 10 fresh pools WITHOUT swapping in between,
        // so a single onSwap hits 10 cold accumulators at once.
        for (uint256 n = 0; n < 10; n++) {
            _newFundedEnrolledPool(trader2);
        }
        g0 = gasleft();
        factory.onSwap(trader2, vol, refs[0], path);
        emit log_named_uint("factory.onSwap 10 all-cold gas", g0 - gasleft());

        // ---------- 4. View call cost (router floor pool-count query) ----------
        g0 = gasleft();
        (address[] memory list, bool[] memory active) = factory.getTraderPools(trader);
        emit log_named_uint("factory.getTraderPools(10) gas", g0 - gasleft());
        emit log_named_uint("  returned entries", list.length);
        assertTrue(active.length == 10);

        // ---------- 5. Absolute worst case: factory-only leg (mining leg
        // disabled or failing) with a FRESH referral chain whose 8 upline
        // addresses have never received any transfer (cold accounts: 25k
        // access + 20k balance slot each), plus cold per-trader accumulators
        // in all 10 pools. This is the budget ceiling the router floor must
        // cover when the mining leg cannot warm the referral accounts first.
        address trader5 = address(0x5E15E1);
        address[8] memory refsCold;
        for (uint256 i = 0; i < 8; i++) {
            refsCold[i] = address(uint160(0x9000 + i));
        }
        factory.bindReferrerOf(trader5, refsCold[0]);
        for (uint256 i = 0; i < 7; i++) {
            factory.bindReferrerOf(refsCold[i], refsCold[i + 1]);
        }
        // Enrollment is capped at MAX_ENROLLED_POOLS (10); use the last 10
        // pools so every accumulator is cold for trader5.
        assertEq(factory.getActivePoolCount(trader5), 0, "fresh trader: 0 active");
        for (uint256 i = pools.length - 10; i < pools.length; i++) {
            vm.prank(trader5);
            CfoMiningPool(pools[i]).enroll();
        }
        assertEq(factory.getActivePoolCount(trader5), 10, "trader5: 10 active");
        g0 = gasleft();
        factory.onSwap(trader5, vol, refsCold[0], path);
        uint256 coldColdGas = g0 - gasleft();
        emit log_named_uint("factory.onSwap 10 cold pools + cold refs gas", coldColdGas);

        // Budget-chain assertion: the router sizes the factory leg as
        // NOTIFY_GAS_FACTORY_BASE (200k) + activePools * NOTIFY_GAS_PER_POOL
        // (560k). The measured worst case must fit with slack, otherwise the
        // router floor would under-provision and pool rewards would be
        // skipped in production.
        uint256 factoryBudget = 200_000 + 10 * 560_000;
        assertLt(coldColdGas, factoryBudget, "factory leg exceeds router budget");

        // Delivery assertion: every one of the 10 pools must actually have
        // paid the trader reward (no silent OOG skip). distributedReward
        // counts the trader reward credited inside onSwap.
        for (uint256 i = pools.length - 10; i < pools.length; i++) {
            assertGt(CfoMiningPool(pools[i]).distributedReward(), 0, "pool did not reward trader5");
        }
    }

    /// @notice The 11th active enrollment must revert, bounding per-swap
    /// notification gas. Unenrolling frees the slot again.
    function testEnrollmentCap() external {
        address user = address(0xC0FFEE);
        uint256[8] memory rates;
        rates[0] = 2000;
        for (uint256 i = 0; i < 10; i++) {
            MockPair pair = new MockPair(WBNB, CAKE);
            address pool = factory.createPoolV2(
                "cap-pool", address(token), 100_000 ether, 0.1 ether,
                1, address(pair), 3, rates
            );
            IERC20Mock(address(token)).approve(pool, type(uint256).max);
            CfoMiningPool(pool).depositReward(100_000 ether);
            vm.prank(user);
            CfoMiningPool(pool).enroll();
        }
        assertEq(factory.getActivePoolCount(user), 10, "10 active after 10 enrolls");

        // 11th distinct pool must revert.
        MockPair extra = new MockPair(WBNB, CAKE);
        address pool11 = factory.createPoolV2(
            "cap-pool", address(token), 100_000 ether, 0.1 ether,
            1, address(extra), 3, rates
        );
        IERC20Mock(address(token)).approve(pool11, type(uint256).max);
        CfoMiningPool(pool11).depositReward(100_000 ether);
        vm.prank(user);
        vm.expectRevert(bytes4(keccak256("EnrollmentLimitReached()")));
        CfoMiningPool(pool11).enroll();

        // Unenroll from one pool, then enrolling pool11 succeeds.
        address firstEnrolled;
        (address[] memory list, ) = factory.getTraderPools(user);
        firstEnrolled = list[0];
        vm.prank(user);
        CfoMiningPool(firstEnrolled).unenroll();
        assertEq(factory.getActivePoolCount(user), 9, "9 active after unenroll");
        vm.prank(user);
        CfoMiningPool(pool11).enroll();
        assertEq(factory.getActivePoolCount(user), 10, "10 active after re-enroll");

        // History still covers all 11 distinct pools (append-only), so batch
        // claims remain complete.
        (address[] memory history, ) = factory.getTraderPools(user);
        assertEq(history.length, 11, "history append-only");
    }

    /// @notice enrolledCount tracks current participants per pool:
    /// +1 on each unique enroll, -1 on each unenroll. Reverted calls
    /// (double enroll / double unenroll) must not move the counter, and
    /// counts are isolated across pools.
    function testEnrolledCountTracksJoinLeave() external {
        address alice = address(0x1111);
        address bob = address(0x2222);

        address pool1 = _newFundedPool("count-pool-1");
        assertEq(CfoMiningPool(pool1).enrolledCount(), 0, "fresh pool: 0 participants");

        // Two distinct traders join -> 2.
        vm.prank(alice);
        CfoMiningPool(pool1).enroll();
        assertEq(CfoMiningPool(pool1).enrolledCount(), 1, "alice joined: 1");
        vm.prank(bob);
        CfoMiningPool(pool1).enroll();
        assertEq(CfoMiningPool(pool1).enrolledCount(), 2, "bob joined: 2");

        // Double enroll reverts and must not change the count.
        vm.prank(alice);
        vm.expectRevert(bytes4(keccak256("AlreadyEnrolled()")));
        CfoMiningPool(pool1).enroll();
        assertEq(CfoMiningPool(pool1).enrolledCount(), 2, "double enroll: still 2");

        // A second pool has its own independent counter.
        address pool2 = _newFundedPool("count-pool-2");
        vm.prank(bob);
        CfoMiningPool(pool2).enroll();
        assertEq(CfoMiningPool(pool2).enrolledCount(), 1, "pool2: 1");
        assertEq(CfoMiningPool(pool1).enrolledCount(), 2, "pool1 unaffected: 2");

        // Alice leaves -> 1; a second unenroll reverts and keeps the count.
        vm.prank(alice);
        CfoMiningPool(pool1).unenroll();
        assertEq(CfoMiningPool(pool1).enrolledCount(), 1, "alice left: 1");
        vm.prank(alice);
        vm.expectRevert(bytes4(keccak256("NotEnrolled()")));
        CfoMiningPool(pool1).unenroll();
        assertEq(CfoMiningPool(pool1).enrolledCount(), 1, "double unenroll: still 1");

        // Re-join after leaving -> 2 again.
        vm.prank(alice);
        CfoMiningPool(pool1).enroll();
        assertEq(CfoMiningPool(pool1).enrolledCount(), 2, "alice rejoined: 2");
    }

    function _newFundedPool(string memory name) internal returns (address pool) {
        MockPair pair = new MockPair(WBNB, CAKE);
        pool = factory.createPoolV2(
            name,
            address(token),
            100_000 ether, // totalReward
            0.1 ether, // rewardPerUsd
            1, // mode = pair pool
            address(pair),
            3, // 365-day vesting
            rates8
        );
        IERC20Mock(address(token)).approve(pool, type(uint256).max);
        CfoMiningPool(pool).depositReward(100_000 ether);
    }
}
