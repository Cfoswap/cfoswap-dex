// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {RouterVolumeHarness, MockToken6, MockToken18} from "./RouterVolumeHarness.sol";

/// @title Mining volume rule tests.
/// @dev Enforces the agreed mining policy at the router level: only swaps
///      with a stablecoin leg (spending or receiving) produce mining
///      volume. Pure token/token swaps, including BNB pairs, return zero
///      volume and therefore trigger no mining notification at all.
///
///      Mainnet stable addresses are codeless on a local chain and an
///      external call to a codeless address reverts even inside try/catch,
///      so the volume branches are exercised with mock tokens registered
///      through the owner toggleStablecoin entry point; the constructor
///      whitelist seeding itself is checked via the isStablecoin view.
contract VolumeRuleTest is Test {
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address internal constant USDD = 0xd17479997f34dd9156deEF8F9BA5045cD2E3F1C5;
    address internal constant TUSD = 0x14016E85a25aeb13065688cAFB43044C2ef86784;
    address internal constant DAI  = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
    // Native BNB placeholder used by some adapter entry points.
    address internal constant NATIVE = address(0);

    RouterVolumeHarness internal router;
    MockToken6 internal token6;
    MockToken18 internal stable18a;
    MockToken18 internal stable18b;

    function setUp() public {
        address[3] memory recips = [address(0xA1), address(0xA2), address(0xA3)];
        uint256[3] memory shares = [uint256(5000), 3000, 2000];
        router = new RouterVolumeHarness(recips, shares);
        token6 = new MockToken6();
        stable18a = new MockToken18();
        stable18b = new MockToken18();
        router.toggleStablecoin(address(stable18a), true);
        router.toggleStablecoin(address(stable18b), true);
    }

    // ---------- Stablecoin leg rules ----------

    function testStableInProducesVolume() external view {
        // Spending stablecoins: the from-token amount is the volume.
        uint256 v = router.calcVolumeUSDT18(address(stable18a), CAKE, 1_000 ether, 5_000 ether);
        assertEq(v, 1_000 ether, "stable->token volume = stable spent");
    }

    function testStableOutProducesVolume() external view {
        // Receiving stablecoins: the to-token amount is the volume.
        uint256 v = router.calcVolumeUSDT18(CAKE, address(stable18a), 100 ether, 2_000 ether);
        assertEq(v, 2_000 ether, "token->stable volume = stable received");
    }

    function testStableToStableUsesFromSide() external view {
        uint256 v = router.calcVolumeUSDT18(address(stable18a), address(stable18b), 1_000 ether, 999 ether);
        assertEq(v, 1_000 ether, "stable->stable uses from amount");
    }

    function testTokenTokenProducesZero() external view {
        // No stablecoin leg -> no on-chain stablecoin count -> no mining.
        assertEq(router.calcVolumeUSDT18(CAKE, WBNB, 100 ether, 10 ether), 0, "CAKE->WBNB = 0");
        assertEq(router.calcVolumeUSDT18(WBNB, CAKE, 10 ether, 100 ether), 0, "WBNB->CAKE = 0");
    }

    function testBnbPairProducesZero() external view {
        // BNB counts as a token: native BNB without a stablecoin leg must
        // never mine; a stablecoin leg does count.
        assertEq(router.calcVolumeUSDT18(NATIVE, CAKE, 10 ether, 100 ether), 0, "BNB->CAKE = 0");
        assertEq(router.calcVolumeUSDT18(CAKE, NATIVE, 100 ether, 10 ether), 0, "CAKE->BNB = 0");
        assertEq(
            router.calcVolumeUSDT18(NATIVE, address(stable18a), 10 ether, 3_000 ether),
            3_000 ether,
            "BNB->stable counts"
        );
    }

    function testZeroAmountsProduceZero() external view {
        assertEq(router.calcVolumeUSDT18(address(stable18a), CAKE, 0, 0), 0, "zero amounts = 0");
    }

    // ---------- Decimal normalization ----------

    function testSixDecimalStableScaledTo18() external {
        // A 6-decimal stablecoin amount must normalize to 18 decimals.
        assertEq(router.isStablecoin(address(token6)), false, "mock not stable yet");
        router.toggleStablecoin(address(token6), true);
        uint256 v = router.calcVolumeUSDT18(address(token6), CAKE, 1_000 * 1e6, 0);
        assertEq(v, 1_000 ether, "6-decimal stable scaled to 1e18");
    }

    function testToggleStableOffStopsVolume() external {
        router.toggleStablecoin(address(stable18a), false);
        assertEq(router.calcVolumeUSDT18(address(stable18a), CAKE, 1_000 ether, 0), 0, "disabled stable = 0");
        router.toggleStablecoin(address(stable18a), true);
        assertEq(
            router.calcVolumeUSDT18(address(stable18a), CAKE, 1_000 ether, 0),
            1_000 ether,
            "re-enabled stable counts"
        );
    }

    // ---------- Day-one whitelist coverage ----------

    function testDefaultWhitelistSeeded() external view {
        // Constructor must seed every agreed BSC stablecoin. Volume math on
        // these addresses is a passthrough on BSC where they are real
        // 18-decimal contracts.
        address[6] memory stables = [USDT, USDC, BUSD, USDD, TUSD, DAI];
        for (uint256 i = 0; i < stables.length; i++) {
            assertTrue(router.isStablecoin(stables[i]), "default stable must be whitelisted");
        }
        assertFalse(router.isStablecoin(WBNB), "WBNB must not be a stablecoin");
        assertFalse(router.isStablecoin(CAKE), "CAKE must not be a stablecoin");
    }
}
