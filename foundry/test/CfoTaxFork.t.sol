// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {CfoToken} from "../src/token/CfoToken.sol";
import {CfoMiningPoolFactory, CfoMiningPool} from "../src/mining/CfoMiningPools.sol";
import {CfoMining} from "../src/mining/CfoMining.sol";

// Minimal interfaces (test-only).
interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH is IERC20Min {
    function deposit() external payable;
}

interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IPancakeRouter {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

/// @title BSC mainnet fork integration test: dual-pool adaptive routing —
/// tax is auto-sold for USDT and distributed within the same transaction.
/// Run: forge test --fork-url <BSC_RPC> --match-contract CfoTaxForkTest -vvv
contract CfoTaxForkTest is Test {
    IPancakeRouter internal constant ROUTER =
        IPancakeRouter(0x10ED43C718714eb63d5aA57B78B54704E256024E);
    IPancakeFactory internal constant FACTORY =
        IPancakeFactory(0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73);
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    CfoToken internal token;
    address internal pairUsdt;
    address internal pairWbnb;

    address internal w1 = address(0x1111);
    address internal w2 = address(0x2222);
    address internal w3 = address(0x3333);

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC", string("https://bsc.publicnode.com")));

        token = new CfoToken();

        // Seed funds: BNB -> WBNB, then part of WBNB -> USDT.
        vm.deal(address(this), 80 ether);
        IWETH(WBNB).deposit{value: 80 ether}();
        uint256 wbnbBefore = IERC20Min(WBNB).balanceOf(address(this));
        _approveAndSwap(WBNB, USDT, wbnbBefore * 55 / 80);
        require(IERC20Min(USDT).balanceOf(address(this)) > 20_000 ether, "USDT seed too small");

        // Mint CFO.
        token.grantMinterQuota(address(this), 3_000_000 ether);
        token.mint(address(this), 3_000_000 ether);
        IERC20Min(address(token)).approve(address(ROUTER), type(uint256).max);
        IERC20Min(USDT).approve(address(ROUTER), type(uint256).max);
        IERC20Min(WBNB).approve(address(ROUTER), type(uint256).max);

        // CFO/USDT pool: 1M CFO / 10k USDT (1 CFO = 0.01 USDT).
        ROUTER.addLiquidity(
            address(token), USDT,
            1_000_000 ether, 10_000 ether, 0, 0,
            address(this), block.timestamp + 300
        );

        // CFO/WBNB pool: 1M CFO / WBNB worth 10k USDT (same price, no arbitrage spread).
        uint256[] memory q = ROUTER.getAmountsOut(10_000 ether, _path(USDT, WBNB));
        ROUTER.addLiquidity(
            address(token), WBNB,
            1_000_000 ether, q[1], 0, 0,
            address(this), block.timestamp + 300
        );

        pairUsdt = FACTORY.getPair(address(token), USDT);
        pairWbnb = FACTORY.getPair(address(token), WBNB);
        require(pairUsdt != address(0) && pairWbnb != address(0), "pools not created");

        // Register both LPs as taxed pairs + sell parameters + 40/30/30 team wallets.
        token.setIsPair(pairUsdt, true);
        token.setIsPair(pairWbnb, true);
        token.setPancakeParams(address(ROUTER), USDT, WBNB);
        token.setTeamDistribution([w1, w2, w3], [uint256(4000), 3000, 3000]);
    }

    /// Direction 1: buy on the USDT pool (USDT->CFO); the tax exits 3-hop
    /// via the WBNB pool in the same tx; USDT lands in team wallets.
    function test_01_BuyOnUsdtPool_AutoDistributesSameTx() public {
        address trader = vm.addr(999);
        IERC20Min(USDT).transfer(trader, 2_000 ether);

        uint256[3] memory before = _walletBalances();
        vm.startPrank(trader);
        IERC20Min(USDT).approve(address(ROUTER), type(uint256).max);
        ROUTER.swapExactTokensForTokens(1_000 ether, 0, _path(USDT, address(token)), trader, block.timestamp + 300);
        vm.stopPrank();

        _assertFullyDistributed(before, "USDT-pool buy");
    }

    /// Direction 2: sell on the USDT pool (CFO->USDT); the tax exits 3-hop
    /// via the WBNB pool in the same tx.
    function test_02_SellOnUsdtPool_AutoDistributesSameTx() public {
        address trader = vm.addr(888);
        IERC20Min(USDT).transfer(trader, 2_000 ether);

        vm.startPrank(trader);
        IERC20Min(USDT).approve(address(ROUTER), type(uint256).max);
        IERC20Min(address(token)).approve(address(ROUTER), type(uint256).max);
        ROUTER.swapExactTokensForTokens(1_000 ether, 0, _path(USDT, address(token)), trader, block.timestamp + 300);
        uint256 cfoBal = IERC20Min(address(token)).balanceOf(trader);

        uint256[3] memory before = _walletBalances();
        ROUTER.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            cfoBal / 2, 0, _path(address(token), USDT), trader, block.timestamp + 300
        );
        vm.stopPrank();

        _assertFullyDistributed(before, "USDT-pool sell");
    }

    /// Direction 3: buy on the WBNB pool (WBNB->CFO); the tax exits
    /// directly via the USDT pool in the same tx; USDT goes straight to
    /// team wallets.
    function test_03_BuyOnWbnbPool_AutoDistributesSameTx() public {
        address trader = vm.addr(777);
        IERC20Min(WBNB).transfer(trader, 5 ether);

        uint256[3] memory before = _walletBalances();
        vm.startPrank(trader);
        IERC20Min(WBNB).approve(address(ROUTER), type(uint256).max);
        ROUTER.swapExactTokensForTokens(2 ether, 0, _path(WBNB, address(token)), trader, block.timestamp + 300);
        vm.stopPrank();

        _assertFullyDistributed(before, "WBNB-pool buy");
    }

    /// Direction 4: sell on the WBNB pool (CFO->WBNB); the tax exits
    /// directly via the USDT pool in the same tx.
    function test_04_SellOnWbnbPool_AutoDistributesSameTx() public {
        address trader = vm.addr(666);
        IERC20Min(WBNB).transfer(trader, 5 ether);

        vm.startPrank(trader);
        IERC20Min(WBNB).approve(address(ROUTER), type(uint256).max);
        IERC20Min(address(token)).approve(address(ROUTER), type(uint256).max);
        ROUTER.swapExactTokensForTokens(2 ether, 0, _path(WBNB, address(token)), trader, block.timestamp + 300);
        uint256 cfoBal = IERC20Min(address(token)).balanceOf(trader);

        uint256[3] memory before = _walletBalances();
        ROUTER.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            cfoBal / 2, 0, _path(address(token), WBNB), trader, block.timestamp + 300
        );
        vm.stopPrank();

        _assertFullyDistributed(before, "WBNB-pool sell");
    }

    /// Fallback: residual tax CFO (simulating a silent auto-sell failure
    /// under extreme market conditions) can be manually sold by anyone.
    function test_05_ManualSwap_FallbackDistributes() public {
        // Simulate residue: a plain transfer sends CFO into the token
        // contract (not a pair transfer, so auto-sell does not trigger).
        token.grantMinterQuota(address(this), 10_000 ether);
        token.mint(address(this), 10_000 ether);
        IERC20Min(address(token)).transfer(address(token), 5_000 ether);

        uint256[3] memory before = _walletBalances();
        vm.prank(vm.addr(12345));
        token.swapAccumulatedTax();

        _assertFullyDistributed(before, "manual fallback");
    }

    /// Manual tax sell must revert when the tax balance is zero.
    function test_06_RevertWhen_NoTaxBalance() public {
        vm.expectRevert(bytes("CFO: no tax balance"));
        token.swapAccumulatedTax();
    }

    function _assertFullyDistributed(uint256[3] memory before, string memory tag) internal {
        assertEq(token.balanceOf(address(token)), 0, string.concat(tag, ": tax CFO residue"));
        uint256 g1 = IERC20Min(USDT).balanceOf(w1) - before[0];
        uint256 g2 = IERC20Min(USDT).balanceOf(w2) - before[1];
        uint256 g3 = IERC20Min(USDT).balanceOf(w3) - before[2];
        assertGt(g1, 0, string.concat(tag, ": w1 no USDT"));
        assertGt(g2, 0, string.concat(tag, ": w2 no USDT"));
        assertGt(g3, 0, string.concat(tag, ": w3 no USDT"));
        uint256 total = g1 + g2 + g3;
        // 40/30/30 split (1% tolerance).
        assertApproxEqRel(g1, (total * 40) / 100, 0.01e18, string.concat(tag, ": w1 share"));
        assertApproxEqRel(g2, (total * 30) / 100, 0.01e18, string.concat(tag, ": w2 share"));
        assertApproxEqRel(g3, (total * 30) / 100, 0.01e18, string.concat(tag, ": w3 share"));
        emit log_named_decimal_uint(string.concat(tag, " -> distributed USDT"), total, 18);
    }

    function _walletBalances() internal view returns (uint256[3] memory b) {
        b[0] = IERC20Min(USDT).balanceOf(w1);
        b[1] = IERC20Min(USDT).balanceOf(w2);
        b[2] = IERC20Min(USDT).balanceOf(w3);
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function _approveAndSwap(address tIn, address tOut, uint256 amount) internal {
        IERC20Min(tIn).approve(address(ROUTER), type(uint256).max);
        ROUTER.swapExactTokensForTokens(amount, 0, _path(tIn, tOut), address(this), block.timestamp + 300);
    }
}

/// @title BSC mainnet fork integration test: pool creation without owner
/// registration + 1:1 reward top-up + referral rewards from the shared pool.
contract CfoMiningPoolFactoryForkTest is Test {
    IPancakeRouter internal constant ROUTER =
        IPancakeRouter(0x10ED43C718714eb63d5aA57B78B54704E256024E);
    IPancakeFactory internal constant FACTORY =
        IPancakeFactory(0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73);
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    CfoToken internal feeToken;
    CfoMiningPoolFactory internal factory;
    // Genuine feeToken/USDT Pancake pair created on the fork; used as the
    // mode=1 targetPair so the factory auto-reads token0/token1 from a real
    // LP without depending on any previously deployed mainnet contract.
    address internal pairUsdt;

    address internal creator = vm.addr(1);
    address internal traderA = vm.addr(2);
    address internal traderB = vm.addr(3);
    address internal ref1    = vm.addr(4);
    address internal ref2    = vm.addr(5);

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC", string("https://bsc.publicnode.com")));

        feeToken = new CfoToken();
        factory = new CfoMiningPoolFactory();
        factory.setCfoToken(address(feeToken));
        factory.addCaller(address(this)); // let the test contract simulate router onSwap reports

        // Create-pool fee is 1000 CFO per pool.
        feeToken.grantMinterQuota(address(this), 200_000 ether);
        feeToken.mint(creator, 100_000 ether);
        vm.prank(creator);
        feeToken.approve(address(factory), type(uint256).max);

        // Seed USDT.
        vm.deal(address(this), 20 ether);
        IWETH(WBNB).deposit{value: 20 ether}();
        IERC20Min(WBNB).approve(address(ROUTER), type(uint256).max);
        address[] memory p = new address[](2);
        p[0] = WBNB; p[1] = USDT;
        ROUTER.swapExactTokensForTokens(15 ether, 0, p, address(this), block.timestamp + 300);

        // Build a real feeToken/USDT pair on the fork (40k CFO / 400 USDT,
        // 1 CFO = 0.01 USDT). No isPair registration happens here, so the
        // token's own tax never interferes with test accounting.
        feeToken.mint(address(this), 40_000 ether);
        IERC20Min(address(feeToken)).approve(address(ROUTER), type(uint256).max);
        IERC20Min(USDT).approve(address(ROUTER), type(uint256).max);
        ROUTER.addLiquidity(
            address(feeToken), USDT,
            40_000 ether, 400 ether, 0, 0,
            address(this), block.timestamp + 300
        );
        pairUsdt = FACTORY.getPair(address(feeToken), USDT);
        require(pairUsdt != address(0), "feeToken/USDT pair not created");
    }

    /// mode=1 targeted-pair pool: owner never calls setPairTokens; the
    /// factory auto-reads token0/token1 from the LP.
    function test_01_Mode1Pool_AutoReadPairTokens_NoOwnerRegistration() public {
        vm.prank(creator);
        address poolAddr = factory.createPoolV2(
            "p1", USDT, 100 ether, 0.5 ether, 1, pairUsdt, 0,
            [uint256(2000), 1000, 0, 0, 0, 0, 0, 0]
        );
        (address t0, address t1) = factory.getPairTokens(pairUsdt);
        assertTrue(t0 != address(0) && t1 != address(0), "pair tokens auto-read failed");
        assertTrue(
            (t0 == address(feeToken) && t1 == USDT) || (t0 == USDT && t1 == address(feeToken)),
            "auto-read tokens must be feeToken and USDT"
        );

        // 1:1 top-up: 100 USDT of rewards requires depositing only 100
        // (the old logic required 130).
        IERC20Min(USDT).transfer(creator, 200 ether);
        vm.startPrank(creator);
        IERC20Min(USDT).approve(poolAddr, type(uint256).max);
        CfoMiningPool(poolAddr).depositReward(100 ether);
        vm.stopPrank();

        (,,,,,,, uint256 remaining,,,,,,,,,,,,,,) = CfoMiningPool(poolAddr).poolInfo();
        assertEq(CfoMiningPool(poolAddr).totalRewardRequired(), 100 ether, "required must be 1:1");
        assertEq(remaining, 100 ether, "shared pool must be 100");
    }

    /// Shared reward pool: with a referrer, the trader plus all referral
    /// levels never exceed the deposited amount; without a referrer the
    /// trader mines the whole pool.
    function test_02_SharedRewardPool_ReferralFromSameBudget() public {
        vm.prank(creator);
        address poolAddr = factory.createPoolV2(
            "p2", USDT, 100 ether, 0.5 ether, 1, pairUsdt, 0,
            [uint256(2000), 1000, 0, 0, 0, 0, 0, 0]
        );
        IERC20Min(USDT).transfer(creator, 200 ether);
        vm.startPrank(creator);
        IERC20Min(USDT).approve(poolAddr, type(uint256).max);
        CfoMiningPool(poolAddr).depositReward(100 ether);
        vm.stopPrank();

        // Traders enroll.
        vm.prank(traderA); CfoMiningPool(poolAddr).enroll();
        vm.prank(traderB); CfoMiningPool(poolAddr).enroll();

        address[] memory path = new address[](2);
        path[0] = USDT; path[1] = address(feeToken);

        // First bind ref1 -> ref2 (an onSwap report binds it; enrollment/rewards not required).
        factory.onSwap(ref1, 1, ref2, path);
        // traderA trades 100U with referrer ref1: trader reward 50, L1 instant 10, L2 instant 5.
        factory.onSwap(traderA, 100 ether, ref1, path);
        // traderB trades 70U without referrer: trader reward 35; budget exhausted, pool ends.
        factory.onSwap(traderB, 70 ether, address(0), path);

        assertEq(IERC20Min(USDT).balanceOf(ref1) - 0 > 0 ? IERC20Min(USDT).balanceOf(ref1) : 0, 10 ether, "L1 referral");
        assertEq(IERC20Min(USDT).balanceOf(ref2), 5 ether, "L2 referral");
        assertTrue(CfoMiningPool(poolAddr).isEnded(), "pool should end when budget exhausted");

        // Trader rewards vest linearly; after the vesting period they are claimed in full.
        vm.warp(block.timestamp + 40 days);
        vm.prank(traderA);
        uint256 gotA = CfoMiningPool(poolAddr).claim();
        vm.prank(traderB);
        uint256 gotB = CfoMiningPool(poolAddr).claim();
        assertEq(gotA, 50 ether, "traderA vested reward");
        assertEq(gotB, 35 ether, "traderB vested reward");

        // Total distribution 50 + 35 + 10 + 5 = 100; the pool holds zero USDT.
        assertEq(IERC20Min(USDT).balanceOf(poolAddr), 0, "pool must drain exactly to 0");
    }

    /// After unenrollment the factory keeps the pool in history
    /// (active=false) and later swaps no longer notify it, but rewards
    /// earned before unenrolling remain claimable via factory batch claims.
    function test_03_Unenroll_HistoryKept_RewardsClaimableViaFactory() public {
        vm.prank(creator);
        address poolAddr = factory.createPoolV2(
            "p3", USDT, 100 ether, 0.5 ether, 1, pairUsdt, 0,
            [uint256(0), 0, 0, 0, 0, 0, 0, 0]
        );
        IERC20Min(USDT).transfer(creator, 200 ether);
        vm.startPrank(creator);
        IERC20Min(USDT).approve(poolAddr, type(uint256).max);
        CfoMiningPool(poolAddr).depositReward(100 ether);
        vm.stopPrank();

        vm.prank(traderA); CfoMiningPool(poolAddr).enroll();

        address[] memory path = new address[](2);
        path[0] = USDT; path[1] = address(feeToken);

        // Trade 100U while enrolled: 50U reward produced (linear vesting).
        factory.onSwap(traderA, 100 ether, address(0), path);
        assertEq(_remaining(poolAddr), 50 ether, "first swap must notify enrolled pool");

        // Unenroll.
        vm.prank(traderA); CfoMiningPool(poolAddr).unenroll();
        (address[] memory hist, bool[] memory act) = factory.getTraderPools(traderA);
        assertEq(hist.length, 1, "history must retain pool");
        assertEq(hist[0], poolAddr, "history pool mismatch");
        assertFalse(act[0], "active flag must be false after unenroll");

        // Another 100U after unenrolling: the pool is not notified and the budget is untouched.
        factory.onSwap(traderA, 100 ether, address(0), path);
        assertEq(_remaining(poolAddr), 50 ether, "unenrolled pool must not be notified");
        assertFalse(CfoMiningPool(poolAddr).isEnded(), "pool must stay alive");

        // After the vesting period, factory batch claims still recover rewards from historical pools.
        vm.warp(block.timestamp + 40 days);
        uint256 balBefore = IERC20Min(USDT).balanceOf(traderA);
        vm.prank(traderA);
        CfoMiningPoolFactory.ClaimBatchResult memory r = factory.claimAllMyPools();
        assertEq(r.poolsClaimed, 1, "must claim from historical pool");
        assertEq(r.totalClaimedWei, 50 ether, "claimed amount mismatch");
        assertEq(IERC20Min(USDT).balanceOf(traderA) - balBefore, 50 ether, "USDT not received");
    }

    /// Notification filter: only pools that are currently enrolled AND
    /// path-matched are notified; unenrolled or irrelevant pools receive
    /// no external call at all. Gas scales with the trader's own
    /// enrollment count, not with the total number of platform pools.
    function test_04_NotificationFilter_OnlyEnrolledAndPathMatched() public {
        address btcb = 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c;
        // Canonical Pancake WBNB/BTCB pair serves as a disjoint-path
        // fixture (genuine mainnet LP, unrelated to any project token).
        address wbnbBtcPair = FACTORY.getPair(WBNB, btcb);
        require(wbnbBtcPair != address(0), "WBNB/BTCB pair must exist on mainnet fork");

        // Pool A targets feeToken/USDT; pool B targets WBNB/BTCB — fully disjoint paths.
        vm.prank(creator);
        address poolA = factory.createPoolV2("pA", USDT, 100 ether, 0.5 ether, 1, pairUsdt, 0, [uint256(0), 0, 0, 0, 0, 0, 0, 0]);
        vm.prank(creator);
        address poolB = factory.createPoolV2("pB", USDT, 100 ether, 0.5 ether, 1, wbnbBtcPair, 0, [uint256(0), 0, 0, 0, 0, 0, 0, 0]);

        for (uint256 i = 0; i < 2; i++) {
            address p = i == 0 ? poolA : poolB;
            IERC20Min(USDT).transfer(creator, 100 ether);
            vm.startPrank(creator);
            IERC20Min(USDT).approve(p, type(uint256).max);
            CfoMiningPool(p).depositReward(100 ether);
            vm.stopPrank();
        }

        // traderA enrolls only in A.
        vm.prank(traderA); CfoMiningPool(poolA).enroll();

        address[] memory pathA = new address[](2);
        pathA[0] = USDT; pathA[1] = address(feeToken);
        factory.onSwap(traderA, 100 ether, address(0), pathA);
        assertEq(_remaining(poolA), 50 ether, "enrolled+matching pool A must be notified");
        assertEq(_remaining(poolB), 100 ether, "unenrolled pool B must not be notified");

        // Then enroll in B and trade on B's path: B is notified; A is
        // path-mismatched and skipped by the factory's local pre-filter.
        vm.prank(traderA); CfoMiningPool(poolB).enroll();
        address[] memory pathB = new address[](2);
        pathB[0] = WBNB; pathB[1] = btcb;
        factory.onSwap(traderA, 100 ether, address(0), pathB);
        assertEq(_remaining(poolA), 50 ether, "path-mismatched pool A must be skipped");
        assertEq(_remaining(poolB), 50 ether, "enrolled+matching pool B must be notified");
    }

    function _remaining(address pool) internal view returns (uint256) {
        (,,,,,,, uint256 remaining,,,,,,,,,,,,,,) = CfoMiningPool(pool).poolInfo();
        return remaining;
    }
}

/// @title BSC mainnet fork integration test: CFO farm opt-out switch.
/// After opting out, the trader's own transactions no longer produce trader
/// rewards, but upline referral rewards still pay out; rejoining restores.
contract CfoMiningOptOutForkTest is Test {
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    CfoToken internal token;
    CfoMiningPoolFactory internal factory;
    CfoMining internal mining;

    address internal trader = vm.addr(2);
    address internal normal = vm.addr(3);
    address internal ref1   = vm.addr(4);
    address internal ref2   = vm.addr(5);

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC", string("https://bsc.publicnode.com")));

        token = new CfoToken();
        factory = new CfoMiningPoolFactory();
        mining = new CfoMining(30 days);

        factory.setCfoToken(address(token));
        mining.setCfoToken(address(token));
        mining.setMiningPoolFactory(address(factory));
        // D12-equivalent setup: the factory whitelists CfoMining so referral binding works.
        factory.addCaller(address(mining));
        // The test contract simulates router onSwap reports.
        mining.addCaller(address(this));

        token.grantMinterQuota(address(mining), 200_000_000 ether);
    }

    function test_01_OptOut_TraderRewardSkipped_ReferralStillPaid() public {
        // Establish the ref1 -> ref2 relationship.
        mining.onSwap(ref1, 1500 ether, ref2);
        // Control: a normal opted-in trader mining 1500U produces 10 CFO trader reward.
        mining.onSwap(normal, 1500 ether, ref1);
        (uint256 normalAlloc,,,) = mining.getVestingInfo(normal);
        assertEq(normalAlloc, 10 ether, "normal trader must accrue 10 CFO");

        // trader opts out of the farm.
        vm.prank(trader);
        mining.setMiningOptOut(true);
        assertTrue(mining.miningOptOut(trader), "opt-out flag must be set");

        uint256 ref1Before = IERC20Min(address(token)).balanceOf(ref1);
        uint256 ref2Before = IERC20Min(address(token)).balanceOf(ref2);
        // Post-opt-out trade: no trader reward, but L1/L2 referral rewards still pay (20%/10% of 10 CFO).
        mining.onSwap(trader, 1500 ether, ref1);

        (uint256 alloc,,,) = mining.getVestingInfo(trader);
        assertEq(alloc, 0, "opted-out trader must not accrue trader reward");
        assertEq(mining.getClaimable(trader), 0, "opted-out trader has nothing claimable");
        assertEq(IERC20Min(address(token)).balanceOf(ref1) - ref1Before, 2 ether, "L1 referral must still pay");
        assertEq(IERC20Min(address(token)).balanceOf(ref2) - ref2Before, 1 ether, "L2 referral must still pay");

        // Rejoin: the next trade produces rewards again.
        vm.prank(trader);
        mining.setMiningOptOut(false);
        assertFalse(mining.miningOptOut(trader), "opt-out flag must clear on rejoin");
        mining.onSwap(trader, 1500 ether, ref1);
        (alloc,,,) = mining.getVestingInfo(trader);
        assertEq(alloc, 10 ether, "rejoined trader must accrue again");
    }

    function test_02_OptOut_NoReferral_NoMint() public {
        // Opted out and no referrer: no CFO may be minted at all.
        vm.prank(trader);
        mining.setMiningOptOut(true);

        uint256 supplyBefore = token.totalSupply();
        mining.onSwap(trader, 1500 ether, address(0));
        assertEq(token.totalSupply(), supplyBefore, "no CFO may be minted when opted-out and no ref");
    }
}
