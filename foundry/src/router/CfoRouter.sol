// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./libraries/EthReceiver.sol";
import "./libraries/PMMLib.sol";
import "./libraries/PausableModuleV2.sol";
import "./libraries/ExtraDataLib.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/ICfoRouter.sol";
import "./interfaces/IUniswapV3SwapCallback.sol";

import "./router/CfoSmartRouter.sol";
import "./router/CfoDagRouter.sol";
import "./router/CfoUnxRouter.sol";
import "./router/CfoUnxV3Router.sol";
import "./router/CfoWrapRouter.sol";

import "./libraries/UniswapTokenInfoHelper.sol";

/// @dev Minimal view of the mining pool factory used to size the factory
/// notification gas budget to the trader's actual enrolled-pool count.
interface IPoolFactoryView {
    function getActivePoolCount(address trader) external view returns (uint256);
}

contract CfoRouter is EthReceiver, ICfoRouter, IUniswapV3SwapCallback, PausableModuleV2, ReentrancyGuard {

    string public constant version = "v1.0.10-rfq-anti-arbitrage-cfo-v1";

    // ============================================================
    // Mining notification logic: all volume normalization and
    // downstream notification runs inside the router bytecode.
    // ============================================================

    // Target contracts that receive onSwap notifications. Both can be
    // updated by the owner after deployment to allow migrations. Setting
    // either to address(0) disables that leg.
    address public cfoMining;
    address public miningPoolFactory;

    // ============================================================
    // Mining notification gas budgeting (calibrated by fork/gas-profile
    // measurements, worst case = 8-level referral payouts + cold storage):
    //   - CfoMining.onSwap cold:                    ~580k  -> budget 800k
    //   - factory fan-out base overhead:             ~60k   -> budget 200k
    //   - single pool onSwap cold (cold refs):       ~470k  -> budget 560k
    // The router enforces a gas floor AFTER the swap but BEFORE any
    // notification: if gasleft() is below the requirement the whole call
    // reverts, which makes eth_estimateGas binary-search up to the real
    // requirement automatically. Unused gas is refunded.
    // ============================================================

    // Gas budget for the network-wide mining leg (one isolated call).
    uint256 private constant NOTIFY_GAS_MINING = 800_000;
    // Gas budget for the factory leg before any per-pool fan-out.
    uint256 private constant NOTIFY_GAS_FACTORY_BASE = 200_000;
    // Gas budget per enrolled pool inside the factory fan-out. Sized above
    // the pool sub-call budget (550k) plus the factory's own per-pool
    // overhead; the factory leg total is base + activePools * this value.
    uint256 private constant NOTIFY_GAS_PER_POOL = 560_000;
    // Extra margin for ABI encoding, event emission and 63/64 CALL losses.
    uint256 private constant NOTIFY_GAS_MARGIN = 150_000;

    // BSC mainnet stablecoin addresses for volume normalization.
    address public constant HOOK_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant HOOK_USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address public constant HOOK_BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant HOOK_USDD = 0xd17479997f34dd9156deEF8F9BA5045cD2E3F1C5;
    address public constant HOOK_TUSD = 0x14016E85a25aeb13065688cAFB43044C2ef86784;
    address public constant HOOK_DAI  = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
    address public constant HOOK_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    // Whitelist of stablecoins whose value is treated as $1.00 with the
    // same 18-decimal normalized representation.
    mapping(address => bool) public isStablecoin;

    // Maximum platform fee expressed in basis points (1 bp = 0.01%).
    // Upper bound is hard-coded (3%) so neither the owner nor a faulty
    // front-end can exceed the contractual 3% commitment. Effective
    // rate may be tuned by the owner down to zero.
    uint256 private constant MAX_PLATFORM_FEE_BP = 300; // 3.00%
    // Day-one platform fee. Used to seed the mutable state below so
    // front-ends get predictable behaviour before any owner tuning.
    uint256 private constant DEFAULT_PLATFORM_FEE_BP = 15; // 0.15%
    // CommissionLib uses denominator 1e9. bp (1e-4) × this = rate (1e-9).
    // 0.15% = 15 bp = 1,500,000 / 1e9.
    uint256 private constant BP_TO_COMMISSION_RATE = 100_000;

    // Mutable state: owner can adjust these without a redeploy. Front-end
    // values embedded inside CommissionInfo are ignored at runtime; only
    // these owner-updated values are authoritative. This removes any
    // risk of a rogue trader self-submitting a 0-rate CommissionInfo to
    // bypass platform fees while still triggering mining rewards.
    address[3] private _platformFeeRecipients;
    uint256[3] private _platformFeeShares;      // bps, sum MUST == 10000
    uint256    private _platformFeeBp;

    // BPS denominator used by share validation.
    uint256 private constant SHARE_BPS_DENOMINATOR = 10_000;

    event PlatformFeeDistributionChanged(address[3] indexed oldRecipients, address[3] indexed newRecipients, uint256[3] oldShares, uint256[3] newShares);
    event PlatformFeeBpChanged(uint256 oldBp, uint256 newBp);
    event MiningNotified(address indexed trader, uint256 volumeUSDT18, address indexed referrer, uint256 notifiedMask);
    event TargetsSet(address cfoMining, address miningPoolFactory);
    event StablecoinToggled(address indexed token, bool enabled);

    // Raised by the pre-notification gas floor. Forces eth_estimateGas to
    // report the full worst-case requirement (swap + both notification legs)
    // instead of the degraded-path minimum where silent skips are allowed.
    error InsufficientGasForMining(uint256 available, uint256 required);

    constructor(address _owner, address[3] memory feeRecipients, uint256[3] memory feeShares)
        PausableModuleV2(_owner)
        ReentrancyGuard()
    {
        uint256 total;
        for (uint256 i = 0; i < 3; i++) {
            require(feeRecipients[i] != address(0), "Router: zero fee recipient");
            total += feeShares[i];
        }
        require(total == SHARE_BPS_DENOMINATOR, "Router: shares sum != 100%");
        require(DEFAULT_PLATFORM_FEE_BP <= MAX_PLATFORM_FEE_BP, "Router: default exceeds max");
        _platformFeeRecipients = feeRecipients;
        _platformFeeShares    = feeShares;
        _platformFeeBp        = DEFAULT_PLATFORM_FEE_BP;
        // Initialize stablecoin whitelist
        isStablecoin[HOOK_USDT] = true;
        isStablecoin[HOOK_USDC] = true;
        isStablecoin[HOOK_BUSD] = true;
        isStablecoin[HOOK_USDD] = true;
        isStablecoin[HOOK_TUSD] = true;
        isStablecoin[HOOK_DAI]  = true;
    }

    /// @notice Owner-only: update the three wallets that receive platform
    /// commissions and their share weights. Share weights are in basis
    /// points and MUST sum to 10000 (100%). No recipient may be the zero
    /// address because that would silently drop fees and leak value.
    function setPlatformFeeDistribution(address[3] calldata recipients, uint256[3] calldata shares) external onlyOwner {
        uint256 total;
        for (uint256 i = 0; i < 3; i++) {
            require(recipients[i] != address(0), "Router: zero recipient");
            total += shares[i];
        }
        require(total == SHARE_BPS_DENOMINATOR, "Router: shares sum != 100%");
        emit PlatformFeeDistributionChanged(_platformFeeRecipients, recipients, _platformFeeShares, shares);
        _platformFeeRecipients = recipients;
        _platformFeeShares    = shares;
    }

    /// @notice Owner-only: adjust the platform-fee rate. Hard upper bound
    /// is 3% (MAX_PLATFORM_FEE_BP) which is enforced both here and in the
    /// assembly override so a bad owner transaction cannot accidentally
    /// lock the rate above 3%.
    function setPlatformFeeBp(uint256 bp) external onlyOwner {
        require(bp <= MAX_PLATFORM_FEE_BP, "Router: exceeds 3% cap");
        emit PlatformFeeBpChanged(_platformFeeBp, bp);
        _platformFeeBp = bp;
    }

    /// @notice Owner-only: set the downstream mining targets. Either
    /// address can be zero to disable that notification leg.
    function setMiningTargets(address _cfoMining, address _miningPoolFactory) external onlyOwner {
        cfoMining = _cfoMining;
        miningPoolFactory = _miningPoolFactory;
        emit TargetsSet(_cfoMining, _miningPoolFactory);
    }

    /// @notice Owner-only: add or remove a token from the stablecoin
    /// whitelist used by the volume-normalization logic.
    function toggleStablecoin(address token, bool enabled) external onlyOwner {
        require(token != address(0), "Router: zero token");
        isStablecoin[token] = enabled;
        emit StablecoinToggled(token, enabled);
    }

    // ============================================================
    // Internal: mining + platform-fee helpers
    // ============================================================

    /**
     * @dev Extract the first-level referrer from the extraData referrer
     * list used by OKX's CommissionInfo multi-level model. Returns
     * address(0) when no referrer list exists. The returned value is
     * passed to the mining hook as the single-level referrer.
     */
    function _firstRefFromExtra(ICfoRouter.ExtraData memory extraData)
        private
        pure
        returns (address firstRef)
    {
        ICfoRouter.CommissionInfo memory ci = extraData.commissionInfo;
        if (ci.commissionLength == 0) return address(0);
        assembly ("memory-safe") {
            firstRef := mload(add(ci, 0xc0))
        }
    }

    /**
     * @dev Write the authoritative platform commission into CommissionInfo
     * using the EXACT memory layout CommissionLib expects (OKX raw asm
     * offsets). Every slot that CommissionLib mloads is overwritten here;
     * the front-end supplied values are discarded.
     *
     * Stablecoin-priority fee policy:
     *   1. fromToken is a stablecoin → fee taken from fromToken before swap
     *      (isFromTokenCommission)
     *   2. else if toToken is a stablecoin → fee taken from toToken after swap
     *      (isToTokenCommission)
     *   3. neither side is a stablecoin → fall back to toToken; CommissionLib
     *      converts the collected fee to USDT via PancakeSwap V2, and degrades
     *      to distributing the raw token if no swap path exists
     *
     * CommissionLib raw memory layout (OKX design — used by fromToken AND
     * toToken paths identically):
     *   +0x40 tokenWithMode
     *   +0x60 toBCommission        (0=none, 1=NoToB, 2=ToB)
     *   +0x80 commissionLength     (number of tiers)
     *   +0xa0, +0xe0, +0x120 ...   commissionRate[i]
     *   +0xc0, +0x100, +0x140 ...  referrerAddress[i]
     *
     * Fixes over previous version:
     *   - Bug A: feeBp raw (15) passed to 1e9 denominator → ×100_000 now
     *   - Bug B: static address[3]/uint256[3] had no length slot; asm used
     *            +0x20/+0x40/+0x60 (dynamic offsets) → now +0x00/+0x20/+0x40
     *   - Bug C: toBCommission written as 2 (ToB) → 1 (NoToB, correct for
     *            our ToC scene)
     *   - Bug D: CommissionLib reads commissionLength from +0x80; previous
     *            code never wrote this slot → now hard-coded to 3
     *   - Bug E: tokenWithMode never written (asm +0x40 actually wrote
     *            toBCommission in Solana struct layout) → now correctly
     *            placed at +0x40 per CommissionLib convention
     */
    function _overridePlatformFee(
        ICfoRouter.CommissionInfo memory ci,
        address fromToken,
        address toToken
    ) private view {
        if (_platformFeeBp == 0) {
            ci.commissionLength = 0;
            return;
        }

        // ---- 1. Stablecoin-priority: decide which side bears the fee ----
        bool fromCommission = false;
        bool toCommission   = false;
        address feeToken;

        if (isStablecoin[fromToken]) {
            fromCommission = true;
            feeToken       = fromToken;
        } else if (isStablecoin[toToken]) {
            toCommission = true;
            feeToken     = toToken;
        } else {
            // Fallback: take from toToken side; CommissionLib converts to USDT
            toCommission = true;
            feeToken     = toToken;
        }

        // ---- 2. Compute the 3 tier rates ----
        address[3] memory recs   = _platformFeeRecipients;
        uint256[3] memory shares = _platformFeeShares;
        uint256 feeBp = _platformFeeBp;

        // feeBp (bps 1e-4) × 100_000 = rate over denominator 1e9
        // E.g. 15 bp × 100_000 = 1,500,000 → 1,500,000/1e9 = 0.15%
        uint256 r0 = (feeBp * shares[0] / 10_000) * BP_TO_COMMISSION_RATE;
        uint256 r1 = (feeBp * shares[1] / 10_000) * BP_TO_COMMISSION_RATE;
        uint256 r2 = feeBp * BP_TO_COMMISSION_RATE - r0 - r1; // absorbs rounding so the tiers sum exactly

        // ---- 3. Write the Solana-struct bool pair fields first ----
        ci.isFromTokenCommission = fromCommission;
        ci.isToTokenCommission   = toCommission;

        // ---- 4. Write remaining fields at the exact CommissionLib asm offsets ----
        assembly ("memory-safe") {
            // tokenWithMode: for the toToken fee path this is the token address
            // directly; for the fromToken fee path CommissionLib decodes the mode
            // internally. The front-end always uses PERMIT2_SIGNATURE mode, whose
            // encoding is handled by TransferLib, so here we only store the
            // address.
            mstore(add(ci, 0x40), feeToken)

            // toBCommission: NoToB mode = 1 (ToC scenario, no ToB rebate)
            mstore(add(ci, 0x60), 1)

            // commissionLength / referrerNum: 3 tiers
            mstore(add(ci, 0x80), 3)

            // Static address[3] / uint256[3] arrays are inline in memory with no
            // length slot: recs+0x00=recs[0], +0x20=recs[1], +0x40=recs[2]
            mstore(add(ci, 0xa0), r0)
            mstore(add(ci, 0xc0), mload(add(recs, 0x00)))
            mstore(add(ci, 0xe0), r1)
            mstore(add(ci, 0x100), mload(add(recs, 0x20)))
            mstore(add(ci, 0x120), r2)
            mstore(add(ci, 0x140), mload(add(recs, 0x40)))
        }
    }

    /**
     * @dev Notify the downstream mining contracts about a completed swap.
     * Volume is normalized to USDT-18 before being forwarded. All
     * downstream calls are fire-and-forget: any revert in the targets
     * can never affect the swap outcome.
     *
     * @param fromToken Address of the source token (ERC20)
     * @param toToken   Address of the destination token (ERC20)
     * @param fromAmount Spent source amount (native token decimals)
     * @param toAmount   Received destination amount (native token decimals)
     * @param firstRef   First-level referrer address (or zero)
     */
    function _notifyMining(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 toAmount,
        address firstRef
    ) private {
        address mining = cfoMining;
        address factory = miningPoolFactory;
        if (mining == address(0) && factory == address(0)) return;

        uint256 volumeUSDT18 = _calcVolumeUSDT18(fromToken, toToken, fromAmount, toAmount);
        if (volumeUSDT18 == 0) return;

        address[] memory path = new address[](2);
        path[0] = fromToken;
        path[1] = toToken;

        // Dynamic gas floor: size the requirement to the trader's actual
        // enrolled-pool count. The factory fans the swap out to every pool
        // the trader is enrolled in; each pool onSwap (8-level referral
        // payouts, cold accumulator) costs up to NOTIFY_GAS_PER_POOL. The
        // floor reverts after the swap but before notifications, so wallets
        // that do not let users edit gas limits still submit enough gas:
        // eth_estimateGas observes the revert and binary-searches up until
        // the floor passes. Unused gas is refunded.
        uint256 required = NOTIFY_GAS_MARGIN;
        uint256 miningGas;
        uint256 factoryGas;
        if (mining != address(0)) {
            miningGas = NOTIFY_GAS_MINING;
            required += miningGas;
        }
        if (factory != address(0)) {
            uint256 poolCount = _activePoolCount(factory, msg.sender);
            factoryGas = NOTIFY_GAS_FACTORY_BASE + poolCount * NOTIFY_GAS_PER_POOL;
            required += factoryGas;
        }
        if (gasleft() < required) revert InsufficientGasForMining(gasleft(), required);

        _notifyAllTargets(msg.sender, volumeUSDT18, firstRef, path, mining, factory, miningGas, factoryGas);
    }

    /**
     * @dev Computes the USD-denominated volume of the swap normalized to
     * 18 decimals (USDT-style). Mining rewards are benchmarked to the
     * stablecoin amount actually spent or received, so the stablecoin
     * count itself is the volume (1 unit = $1):
     *   1. If fromToken is a stablecoin -> use fromAmount.
     *   2. Else if toToken is a stablecoin -> use toAmount.
     *   3. Pure token/token swaps (no stablecoin leg, including BNB pairs)
     *      return 0: no on-chain stablecoin count exists and no price feed
     *      is trusted, so such swaps do not trigger mining at all.
     */
    function _calcVolumeUSDT18(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 toAmount
    ) internal view returns (uint256 volumeUSDT18) {
        if (isStablecoin[fromToken]) {
            return _to18Decimals(fromToken, fromAmount);
        }
        if (isStablecoin[toToken]) {
            return _to18Decimals(toToken, toAmount);
        }
        return 0;
    }

    /// @dev Number of pools the trader is currently enrolled in. A view
    /// failure (factory misconfigured/migrated) degrades to zero: the
    /// factory leg then runs with its base budget only and skips pools
    /// gracefully instead of blocking the trade.
    function _activePoolCount(address factory, address trader) private view returns (uint256 count) {
        try IPoolFactoryView(factory).getActivePoolCount(trader) returns (uint256 n) {
            count = n;
        } catch {
            count = 0;
        }
    }

    /**
     * @dev Scales an ERC20 amount from its native decimals to 18 decimals.
     */
    function _to18Decimals(address token, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint8 decimals;
        if (token == address(0)) {
            decimals = 18;
        } else {
            // Low-level call: a call to a codeless address "succeeds" with
            // empty returndata, which an interface-level try/catch does NOT
            // catch (the subsequent decode failure still reverts). Guard
            // both conditions explicitly and fall back to 18 decimals.
            (bool ok, bytes memory ret) =
                token.staticcall(abi.encodeWithSelector(IERC20DecimalsMin.decimals.selector));
            decimals = (ok && ret.length >= 32) ? abi.decode(ret, (uint8)) : 18;
        }
        if (decimals == 18) return amount;
        if (decimals > 18) {
            return amount / (10 ** (decimals - 18));
        }
        return amount * (10 ** (18 - decimals));
    }

    /**
     * @dev Sends onSwap notifications to both targets with isolated gas
     * budgets so that reverts in one target cannot block the other.
     * Each leg receives exactly the budget sized by the caller (the floor
     * guarantees it is available); unused gas is refunded.
     * Returns a bitmask of successful deliveries:
     *   0x1 -> cfoMining succeeded
     *   0x2 -> miningPoolFactory succeeded
     */
    function _notifyAllTargets(
        address trader,
        uint256 volumeUSDT18,
        address referrer,
        address[] memory path,
        address mining,
        address factory,
        uint256 miningGas,
        uint256 factoryGas
    ) internal {
        uint256 notifiedMask;

        if (mining != address(0)) {
            bytes memory data = abi.encodeWithSignature(
                "onSwap(address,uint256,address)",
                trader,
                volumeUSDT18,
                referrer
            );
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = mining.call{gas: miningGas}(data);
            if (ok) notifiedMask |= 0x1;
        }

        if (factory != address(0)) {
            bytes memory data = abi.encodeWithSignature(
                "onSwap(address,uint256,address,address[])",
                trader,
                volumeUSDT18,
                referrer,
                path
            );
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = factory.call{gas: factoryGas}(data);
            if (ok) notifiedMask |= 0x2;
        }

        emit MiningNotified(trader, volumeUSDT18, referrer, notifiedMask);
    }

    /// ================================ smartSwap related ================================
    /// @notice Executes a smart swap directly to a specified receiver address.
    /// @param orderId Unique identifier for the swap order, facilitating tracking.
    /// @param baseRequest Contains essential parameters for the swap such as source and destination tokens, amounts, and deadline.
    /// @param batchesAmount Array indicating amounts for each batch in the swap, allowing for split operations.
    /// @param batches Detailed routing information for executing the swap across different paths or protocols.
    /// @param pmmRequests PMM swap requests (currently used only for calldata length calculation, not for swap logic).
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function smartSwapByOrderId(
        uint256 orderId,
        BaseRequest calldata baseRequest,
        uint256[] calldata batchesAmount,
        RouterPath[][] calldata batches,
        PMMLib.PMMSwapRequest[] calldata pmmRequests
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 returnAmount)
    {
        uint256 swapDataLength = 4 + abi.encode(orderId, baseRequest, batchesAmount, batches, pmmRequests).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, CommonLib.bytes32ToAddress(baseRequest.fromToken), baseRequest.toToken);
        returnAmount = CfoSmartRouter.smartSwapTo(orderId, msg.sender, baseRequest, batchesAmount, batches, extraData);
        _notifyMining(
            CommonLib.bytes32ToAddress(baseRequest.fromToken),
            baseRequest.toToken,
            baseRequest.fromTokenAmount,
            returnAmount,
            firstRef
        );
    }

    /// @notice Executes a smart swap directly to a specified receiver address.
    /// @param orderId Unique identifier for the swap order, facilitating tracking.
    /// @param receiver Address to receive the output tokens from the swap.
    /// @param baseRequest Contains essential parameters for the swap such as source and destination tokens, amounts, and deadline.
    /// @param batchesAmount Array indicating amounts for each batch in the swap, allowing for split operations.
    /// @param batches Detailed routing information for executing the swap across different paths or protocols.
    /// @param pmmRequests PMM swap requests (currently used only for calldata length calculation, not for swap logic).
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function smartSwapTo(
        uint256 orderId,
        address receiver,
        BaseRequest calldata baseRequest,
        uint256[] calldata batchesAmount,
        RouterPath[][] calldata batches,
        PMMLib.PMMSwapRequest[] calldata pmmRequests
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 returnAmount)
    {
        uint256 swapDataLength = 4 + abi.encode(orderId, receiver, baseRequest, batchesAmount, batches, pmmRequests).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, CommonLib.bytes32ToAddress(baseRequest.fromToken), baseRequest.toToken);
        returnAmount = CfoSmartRouter.smartSwapTo(orderId, receiver, baseRequest, batchesAmount, batches, extraData);
        _notifyMining(
            CommonLib.bytes32ToAddress(baseRequest.fromToken),
            baseRequest.toToken,
            baseRequest.fromTokenAmount,
            returnAmount,
            firstRef
        );
    }

    /// ================================ dagSwap related ================================
    /// @notice Executes a DAG swap to a specified receiver using structured base request parameters.
    /// @param orderId Unique identifier for the swap order, facilitating tracking and reference.
    /// @param baseRequest Struct containing essential swap parameters including source token, destination token, amount, minimum return, and deadline.
    /// @param paths An array of RouterPath structs defining the DAG swap route.
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function dagSwapByOrderId(
        uint256 orderId,
        BaseRequest calldata baseRequest,
        RouterPath[] calldata paths
    ) external payable nonReentrant whenNotPaused returns (uint256 returnAmount) {
        uint256 swapDataLength = 4 + abi.encode(orderId, baseRequest, paths).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, CommonLib.bytes32ToAddress(baseRequest.fromToken), baseRequest.toToken);
        returnAmount = CfoDagRouter.dagSwapTo(orderId, msg.sender, baseRequest, paths, extraData);
        _notifyMining(
            CommonLib.bytes32ToAddress(baseRequest.fromToken),
            baseRequest.toToken,
            baseRequest.fromTokenAmount,
            returnAmount,
            firstRef
        );
    }

    /// @notice Executes a DAG swap to a specified receiver using structured base request parameters.
    /// @param orderId Unique identifier for the swap order, facilitating tracking and reference.
    /// @param receiver The address that will receive the swapped tokens.
    /// @param baseRequest Struct containing essential swap parameters including source token, destination token, amount, minimum return, and deadline.
    /// @param paths An array of RouterPath structs defining the DAG swap route.
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function dagSwapTo(
        uint256 orderId,
        address receiver,
        BaseRequest calldata baseRequest,
        RouterPath[] calldata paths
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 returnAmount)
    {
        uint256 swapDataLength = 4 + abi.encode(orderId, receiver, baseRequest, paths).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, CommonLib.bytes32ToAddress(baseRequest.fromToken), baseRequest.toToken);
        returnAmount = CfoDagRouter.dagSwapTo(orderId, receiver, baseRequest, paths, extraData);
        _notifyMining(
            CommonLib.bytes32ToAddress(baseRequest.fromToken),
            baseRequest.toToken,
            baseRequest.fromTokenAmount,
            returnAmount,
            firstRef
        );
    }

    /// ============================== uniswapV3Swap related ==============================
    /// @notice Executes a swap using the Uniswap V3 protocol.
    /// @param receiver The address that will receive the swap funds (encoded as uint256 with order ID mask).
    /// @param amount The amount of the source token to be swapped.
    /// @param minReturn The minimum acceptable amount of tokens to receive from the swap, guarding against excessive slippage.
    /// @param pools An array of pool identifiers used to define the swap route within Uniswap V3.
    /// @return returnAmount The amount of tokens received after the completion of the swap.
    function uniswapV3SwapTo(
        uint256 receiver,
        uint256 amount,
        uint256 minReturn,
        uint256[] calldata pools
    ) external payable nonReentrant whenNotPaused returns (uint256 returnAmount) {
        uint256 swapDataLength = 4 + abi.encode(receiver, amount, minReturn, pools).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // V3 bare signature has no explicit fromToken/toToken; decode the
        // pool array to infer the token pair using the helper.
        bool sendValueV3 = msg.value > 0;
        (address fromToken, address toToken) = UniswapTokenInfoHelper.getUniswapV3TokenInfo(sendValueV3, pools);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, fromToken, toToken);
        returnAmount = CfoUnxV3Router.uniswapV3SwapTo(receiver, amount, minReturn, pools, extraData);
        _notifyMining(fromToken, toToken, amount, returnAmount, firstRef);
    }

    /// @notice Executes a Uniswap V3 token swap to a specified receiver using structured base request parameters. For uniswapV3, if fromToken or toToken is ETH, the address needs to be 0xEeee.
    /// @param orderId Unique identifier for the swap order, facilitating tracking and reference.
    /// @param receiver The address that will receive the swapped tokens.
    /// @param baseRequest Struct containing essential swap parameters including source token, destination token, amount, minimum return, and deadline.
    /// @param pools An array of pool identifiers defining the Uniswap V3 swap route, with encoded swap direction and unwrap flags.
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function uniswapV3SwapToWithBaseRequest(
        uint256 orderId,
        address receiver,
        BaseRequest calldata baseRequest,
        uint256[] calldata pools
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 returnAmount)
    {
        uint256 swapDataLength = 4 + abi.encode(orderId, receiver, baseRequest, pools).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, CommonLib.bytes32ToAddress(baseRequest.fromToken), baseRequest.toToken);
        returnAmount = CfoUnxV3Router.uniswapV3SwapToWithBaseRequest(orderId, receiver, baseRequest, pools, extraData);
        _notifyMining(
            CommonLib.bytes32ToAddress(baseRequest.fromToken),
            baseRequest.toToken,
            baseRequest.fromTokenAmount,
            returnAmount,
            firstRef
        );
    }

    /// ============================== unxswap related ==============================
    /// @notice Executes a token swap using the Unxswap protocol, sending the output directly to a specified receiver.
    ///         The srcToken can be 0xEeee or address(0) for temporary use, the address(0) usage will removed in the future.
    /// @param srcToken The source token to be swapped.
    /// @param amount The amount of the source token to be swapped.
    /// @param minReturn The minimum amount of destination tokens expected from the swap, ensuring the trade does not proceed under unfavorable conditions.
    /// @param pools An array of pool identifiers to specify the swap route, optimizing for best rates.
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function unxswapByOrderId(
        uint256 srcToken,
        uint256 amount,
        uint256 minReturn,
        bytes32[] calldata pools
    ) external payable nonReentrant whenNotPaused returns (uint256 returnAmount) {
        uint256 swapDataLength = 4 + abi.encode(srcToken, amount, minReturn, pools).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        bool sendUx = msg.value > 0;
        (address fromToken, address toToken) = UniswapTokenInfoHelper.getUnxswapTokenInfo(sendUx, pools);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, fromToken, toToken);
        returnAmount = CfoUnxRouter.unxswapTo(srcToken, amount, minReturn, msg.sender, pools, extraData);
        _notifyMining(fromToken, toToken, amount, returnAmount, firstRef);
    }

    /// @notice Executes a token swap using the Unxswap protocol, sending the output directly to a specified receiver.
    ///         The srcToken can be 0xEeee or address(0) for temporary use, the address(0) usage will removed in the future.
    /// @param srcToken The source token to be swapped.
    /// @param amount The amount of the source token to be swapped.
    /// @param minReturn The minimum amount of destination tokens expected from the swap, ensuring the trade does not proceed under unfavorable conditions.
    /// @param receiver The address where the swapped tokens will be sent.
    /// @param pools An array of pool identifiers to specify the swap route, optimizing for best rates.
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function unxswapTo(
        uint256 srcToken,
        uint256 amount,
        uint256 minReturn,
        address receiver,
        bytes32[] calldata pools
    ) external payable nonReentrant whenNotPaused returns (uint256 returnAmount) {
        uint256 swapDataLength = 4 + abi.encode(srcToken, amount, minReturn, receiver, pools).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        bool sendUx2 = msg.value > 0;
        (address fromToken, address toToken) = UniswapTokenInfoHelper.getUnxswapTokenInfo(sendUx2, pools);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, fromToken, toToken);
        returnAmount = CfoUnxRouter.unxswapTo(srcToken, amount, minReturn, receiver, pools, extraData);
        _notifyMining(fromToken, toToken, amount, returnAmount, firstRef);
    }

    /// @notice Executes a Unxswap token swap to a specified receiver using structured base request parameters. For unxswap, if fromToken or toToken is ETH, the address can be 0xEeee or address(0) for temporary use, the address(0) usage will removed in the future.
    /// @param orderId Unique identifier for the swap order, facilitating tracking and reference.
    /// @param receiver The address that will receive the swapped tokens.
    /// @param baseRequest Struct containing essential swap parameters including source token, destination token, amount, minimum return, and deadline.
    /// @param pools An array of pool identifiers defining the Unxswap route, with encoded swap direction and WETH unwrap flags.
    /// @return returnAmount The total amount of destination tokens received from the swap.
    function unxswapToWithBaseRequest(
        uint256 orderId,
        address receiver,
        BaseRequest calldata baseRequest,
        bytes32[] calldata pools
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 returnAmount)
    {
        uint256 swapDataLength = 4 + abi.encode(orderId, receiver, baseRequest, pools).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // Read the front-end supplied referrer BEFORE the platform-fee
        // override rewrites commissionInfo (the override fills the tier-1
        // referrer slot with a fee-recipient address).
        address firstRef = _firstRefFromExtra(extraData);
        _overridePlatformFee(extraData.commissionInfo, CommonLib.bytes32ToAddress(baseRequest.fromToken), baseRequest.toToken);
        returnAmount = CfoUnxRouter.unxswapToWithBaseRequest(orderId, receiver, baseRequest, pools, extraData);
        _notifyMining(
            CommonLib.bytes32ToAddress(baseRequest.fromToken),
            baseRequest.toToken,
            baseRequest.fromTokenAmount,
            returnAmount,
            firstRef
        );
    }

    /// ================================ swapWrap related ================================
    /// @notice Executes a simple swap between ETH and WETH using encoded parameters.
    /// @param orderId Unique identifier for the swap order, facilitating tracking and reference.
    /// @param rawdata Encoded data containing swap direction, transfer mode and amount information using bit masks.
    /// @dev This function supports bidirectional swaps between ETH and WETH with minimal gas overhead.
    /// The rawdata parameter encodes:
    /// - Transfer mode in bits [251:249], direction (reversed flag) in bit 255: false=ETH->WETH, true=WETH->ETH
    function swapWrap(uint256 orderId, uint256 rawdata) external payable nonReentrant whenNotPaused {
        uint256 swapDataLength = 4 + abi.encode(orderId, rawdata).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // WETH-wrap swaps are excluded from mining notifications and
        // commissions (no price exposure change for the end user).
        return CfoWrapRouter.swapWrap(orderId, rawdata, extraData);
    }

    /// @notice Executes a swap between ETH and WETH using structured base request parameters to a specified receiver.
    /// @param orderId Unique identifier for the swap order, facilitating tracking and reference.
    /// @param receiver The address that will receive the swapped tokens.
    /// @param baseRequest Struct containing essential swap parameters including source token (with mode in high bits [251:249]), destination token, amount, minimum return, and deadline.
    /// @dev This function validates that the token pair is either ETH->WETH or WETH->ETH and executes the swap accordingly.
    /// It extracts the amount and mode from the baseRequest and determines the swap direction based on the token addresses.
    function swapWrapToWithBaseRequest(
        uint256 orderId,
        address receiver,
        BaseRequest calldata baseRequest
    )
        external
        payable
        nonReentrant
        whenNotPaused
    {
        uint256 swapDataLength = 4 + abi.encode(orderId, receiver, baseRequest).length;
        ICfoRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
        // WETH-wrap swaps are excluded from mining notifications and
        // commissions (no price exposure change for the end user).
        return CfoWrapRouter.swapWrapToWithBaseRequest(orderId, receiver, baseRequest, extraData);
    }

    /// ================================ uniswapV3Callback ==============================
    /// @notice callback function for both CfoUnxV3Router and UnxswapV3ExactOutRouter
    /// @dev The first 32 bytes of data is a flag to identify which router to call
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external whenNotPaused override {
        require(data.length >= 32, "Invalid callback data");
        bytes32 flag = bytes32(data[:32]);
        if (flag == V3_EXACT_IN_CALLBACK_FLAG) {
            CfoUnxV3Router.uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
        } else {
            revert("Unknown V3 callback flag");
        }
    }
}

/// @dev Minimal interface for reading ERC20 token decimals. Used by the
/// volume-normalization logic in _calcVolumeUSDT18.
interface IERC20DecimalsMin {
    function decimals() external view returns (uint8);
}
