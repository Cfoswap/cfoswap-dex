// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./FeeSwapHarness.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

/// @dev Fork tests against BSC mainnet: verify the commission→USDT swap logic
///      works for all representative token types, and degrades gracefully
///      (ok=false, no revert) when no PancakeSwap path exists.
contract FeeSwapTest is Test {
    FeeSwapHarness harness;

    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant PEG_ETH = 0x2170Ed0880ac9A755fd29B2688956BD959F933F8;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC", string("https://bsc.publicnode.com")));
        harness = new FeeSwapHarness();
    }

    /// CAKE → WBNB → USDT (2-hop ERC20 commission, previously reverted)
    function testFork_FeeSwap_CakeToUSDT() public {
        uint256 amountIn = 1e18; // 1 CAKE
        deal(CAKE, address(harness), amountIn);

        (uint256 out, bool ok) = harness.swapFeeToUSDT(CAKE, amountIn);
        emit log_named_uint("CAKE fee -> USDT out", out);
        assertTrue(ok, "swap should succeed");
        assertGt(out, 0, "USDT out must be > 0");
        assertGt(IERC20Min(USDT).balanceOf(address(harness)), 0);
    }

    /// Native BNB: wrap → WBNB → USDT (ETH-side commission, e.g. CAKE→BNB)
    function testFork_FeeSwap_BnbWrapToUSDT() public {
        uint256 amountIn = 0.01 ether;
        deal(address(harness), amountIn);

        harness.wrapETH(amountIn);
        (uint256 out, bool ok) = harness.swapFeeToUSDT(WBNB, amountIn);
        emit log_named_uint("BNB fee -> USDT out", out);
        assertTrue(ok, "swap should succeed");
        assertGt(out, 0, "USDT out must be > 0");
    }

    /// USDC → WBNB → USDT (stablecoin fromToken fee, e.g. USDC→BNB)
    function testFork_FeeSwap_UsdcToUSDT() public {
        uint256 amountIn = 10e18; // 10 USDC
        deal(USDC, address(harness), amountIn);

        (uint256 out, bool ok) = harness.swapFeeToUSDT(USDC, amountIn);
        emit log_named_uint("USDC fee -> USDT out", out);
        assertTrue(ok, "swap should succeed");
        assertGt(out, 0, "USDT out must be > 0");
    }

    /// Binance-Peg ETH → WBNB → USDT (ERC20 commission, e.g. ETH→CAKE / CAKE→ETH)
    function testFork_FeeSwap_PegEthToUSDT() public {
        uint256 amountIn = 0.01e18; // 0.01 ETH
        deal(PEG_ETH, address(harness), amountIn);

        (uint256 out, bool ok) = harness.swapFeeToUSDT(PEG_ETH, amountIn);
        emit log_named_uint("ETH-peg fee -> USDT out", out);
        assertTrue(ok, "swap should succeed");
        assertGt(out, 0, "USDT out must be > 0");
    }

    /// USDT short-circuit (e.g. BNB→USDT fee token already USDT)
    function testFork_FeeSwap_UsdtNoSwap() public {
        uint256 amountIn = 5e18;
        deal(USDT, address(harness), amountIn);

        (uint256 out, bool ok) = harness.swapFeeToUSDT(USDT, amountIn);
        assertTrue(ok, "USDT pass-through ok");
        assertEq(out, amountIn, "USDT must pass through unchanged");
    }

    /// Degradation: token with no PancakeSwap V2 route must NOT revert,
    /// returns ok=false so callers distribute the original token.
    function testFork_FeeSwap_NoPathDegrades() public {
        // An EOA-ish address with no code: approve call succeeds (no-op),
        // PancakeRouter swap reverts internally -> ok=false without reverting us.
        address bogus = 0x000000000000000000000000000000000000dEaD;
        (uint256 out, bool ok) = harness.swapFeeToUSDT(bogus, 1e18);
        assertFalse(ok, "swap should report failure for unroutable token");
        assertEq(out, 1e18, "amountOut echoes amountIn on failure");
    }

    /// Zero amount must not revert (guards Pancake INSUFFICIENT_INPUT_AMOUNT)
    function testFork_FeeSwap_ZeroAmountSafe() public {
        (uint256 out, bool ok) = harness.swapFeeToUSDT(CAKE, 0);
        assertFalse(ok, "zero swap reports failure (degrade path), never reverts");
        assertEq(out, 0);
    }
}
