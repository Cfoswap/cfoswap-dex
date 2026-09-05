// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VestingAccumulator} from "./VestingAccumulator.sol";

interface ICfoToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IPancakePairLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

uint256 constant POOL_REF_MAX_LEVELS = 8;
uint256 constant POOL_REF_BPS_LIMIT = 3000; // Upper bound of combined referral bps.

contract CfoMiningPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Custom errors replace long revert strings to shrink runtime bytecode
    // and reduce gas cost.
    error InvalidMode();
    error InvalidVestingOption();
    error ZeroTotalReward();
    error ZeroRewardPerUsd();
    error ZeroRewardToken();
    error RefBpsExceedLimit();
    error TotalRewardScaledZero();
    error RewardPerUsdScaledZero();
    error NotPoolOwner();
    error NotFactory();
    error NotFactoryOrCaller();
    error NotFactoryOwner();
    error AlreadyActivated();
    error BelowRequiredReward();
    error ZeroTrader();
    error NothingToClaim();
    error ZeroUser();
    error PoolAlreadyEnded();
    error PoolDelisted();
    error AlreadyEnrolled();
    error NotEnrolled();
    error LevelOutOfRange();
    error BoostCannotDecrease();
    error ZeroNewOwner();
    error SameOwner();
    error ZeroToken();
    error BalanceTooLow();
    error AccountingBroken();
    error CannotWithdrawUserReserved();

    CfoMiningPoolFactory public immutable factory;
    address public poolOwner;
    string public name;
    address public immutable rewardToken;
    uint256 public immutable totalReward;
    uint256 public immutable totalRewardRequired;
    uint8 public immutable mode;
    address public immutable targetPair;
    uint256 public immutable vestingDuration;

    // 8-level referral schedule stored as an 8-slot array. L1..L8 share
    // of the base trader reward, expressed in basis points. The first two
    // slots (l1bp, l2bp) are always exposed individually as a convenience
    // helper for UIs that only configure the first two tiers.
    uint256[POOL_REF_MAX_LEVELS] public referralRateBp;

    event PoolReferralRateSet(uint8 level, uint256 bpVal, uint256[POOL_REF_MAX_LEVELS] rates);

    // Back-compat: read-only accessors that mirror the legacy two-rate
    // storage layout so existing frontends / subgraph schemas keep working.
    function l1bp() external view returns (uint256) { return referralRateBp[0]; }
    function l2bp() external view returns (uint256) { return referralRateBp[1]; }

    uint256 public immutable rewardPerUsd;

    bool public isActivated;
    bool public isEnded;
    bool public isVerified;
    bool public _isDelisted;
    uint256 public depositedReward;
    uint256 public distributedReward;
    uint256 public distributedReferral;
    uint256 public remainingReward;

    uint256 public totalCommitted;
    uint256 public startTime;
    uint256 public boostPaidTotal;

    // ====== Per-reward linear vesting accumulator (merged by UTC day) ======
    //
    // Rewards from swaps on the same UTC day merge into one daily bucket
    // anchored at that day's 00:00 UTC, vesting linearly over
    // vestingDuration (30/90/180/365 days). Each bucket counts down
    // independently; buckets never accelerate each other. Rewards are
    // claimable on the trade day itself (the bucket anchor is earlier than
    // the trade timestamp by at most 24h, which is user-favourable). Gas
    // is independent of trade count: any number of same-day swaps writes a
    // single bucket, and the number of open buckets never exceeds the
    // vesting period in days; matured buckets are amortised on claim.
    // See VestingAccumulator for details.
    mapping(address => VestingAccumulator.Accumulator) internal userAcc;
    mapping(address => bool) public enrolledTraders;
    /// @notice Number of traders currently enrolled in this pool. Tracked
    /// in lockstep with enrolledTraders: +1 in enroll(), -1 in unenroll().
    /// The AlreadyEnrolled/NotEnrolled guards make double counting impossible.
    uint256 public enrolledCount;

    event RewardDeposited(address indexed owner, uint256 amount);
    event TraderEnrolled(address indexed trader);
    event TraderUnenrolled(address indexed trader);
    event SwapRecorded(address indexed trader, uint256 volumeUSDT18, uint256 reward);
    event ReferrerBound(address indexed trader, address indexed referrer);
    event ReferralReward(address indexed referrer, address indexed trader, uint256 amount, uint256 level);
    event Claimed(address indexed user, uint256 amount);
    event BoostPaid(uint256 paidTotal);
    event VerifiedSet(bool verified);
    event Delisted();

    constructor(
        address payable _factory,
        address _owner,
        string memory _name,
        address _rewardToken,
        uint256 _totalReward,
        uint8 _mode,
        address _targetPair,
        uint8 _vestingOption,
        uint256[POOL_REF_MAX_LEVELS] memory _referralRateBp,
        uint256 _rewardPerUsd
    ) {
        if (_mode != 0 && _mode != 1) revert InvalidMode();
        if (_vestingOption > 3) revert InvalidVestingOption();
        if (_totalReward == 0) revert ZeroTotalReward();
        if (_rewardPerUsd == 0) revert ZeroRewardPerUsd();
        if (_rewardToken == address(0)) revert ZeroRewardToken();

        uint256 ratesSum;
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) {
            referralRateBp[i] = _referralRateBp[i];
            ratesSum += _referralRateBp[i];
        }
        if (ratesSum > POOL_REF_BPS_LIMIT) revert RefBpsExceedLimit();

        uint8 decimals;
        {
            try IERC20Metadata(_rewardToken).decimals() returns (uint8 d) {
                decimals = (d > 30) ? 18 : d;
            } catch {
                decimals = 18;
            }
        }
        uint256 scale = 10 ** decimals;
        uint256 totalReward_ = (_totalReward * scale) / 1 ether;
        uint256 rewardPerUsd_ = (_rewardPerUsd * scale) / 1 ether;
        if (totalReward_ == 0) revert TotalRewardScaledZero();
        if (rewardPerUsd_ == 0) revert RewardPerUsdScaledZero();

        factory = CfoMiningPoolFactory(_factory);
        poolOwner = _owner;
        name = _name;
        rewardToken = _rewardToken;
        totalReward = totalReward_;
        // 1:1 deposit: trader rewards and referral rewards share one prize
        // pool, so the required deposit is exactly totalReward with no extra
        // referral budget; when no referral is paid out the trader can mine
        // the full amount.
        totalRewardRequired = totalReward_;
        mode = _mode;
        targetPair = _targetPair;
        rewardPerUsd = rewardPerUsd_;

        uint256[4] memory vestingDays = [uint256(30), 90, 180, 365];
        vestingDuration = vestingDays[_vestingOption] * 1 days;
    }

    modifier onlyPoolOwner() {
        if (msg.sender != poolOwner) revert NotPoolOwner();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != address(factory)) revert NotFactory();
        _;
    }

    modifier onlyFactoryOrCaller() {
        if (msg.sender != address(factory) && !factory.isAllowedCaller(msg.sender)) revert NotFactoryOrCaller();
        _;
    }

    modifier onlyFactoryOwner() {
        if (msg.sender != factory.owner()) revert NotFactoryOwner();
        _;
    }

    function depositReward(uint256 amount) external onlyPoolOwner nonReentrant {
        if (isActivated) revert AlreadyActivated();
        if (amount < totalRewardRequired) revert BelowRequiredReward();
        SafeERC20.safeTransferFrom(IERC20(rewardToken), msg.sender, address(this), amount);
        depositedReward += amount;
        // Single prize pool: the deposit is the total mineable budget;
        // both trader rewards and referral rewards are paid from it.
        remainingReward += totalReward;
        isActivated = true;
        emit RewardDeposited(msg.sender, amount);
    }

    /// @notice Called by Router/Factory when a swap occurs. Awards rewards based on volume.
    /// @param path The full swap path, used by mode-1 pools to match the target pair tokens.
    function onSwap(address trader, uint256 volumeUSDT18, address ref, address[] calldata path) external onlyFactoryOrCaller nonReentrant {
        if (!isActivated || isEnded || volumeUSDT18 == 0) return;

        if (_isDelisted) return;
        if (trader == address(0)) revert ZeroTrader();

        // Referral binding happens once at the factory onSwap entry
        // (bind-once); pools never bind independently.

        if (!enrolledTraders[trader]) return;

        // Mode 1: only count volume if the swap path involves the target pair's tokens.
        // Scans the entire path so TOKEN/WBNB pairs work with stablecoin-bridged paths
        // (e.g. TOKEN -> WBNB -> USDT or USDT -> WBNB -> TOKEN).
        if (mode == 1 && targetPair != address(0)) {
            (address token0, address token1) = factory.getPairTokens(targetPair);
            bool matched = false;
            for (uint256 i = 0; i < path.length; i++) {
                if (path[i] == targetPair || path[i] == token0 || path[i] == token1) {
                    matched = true;
                    break;
                }
            }
            if (!matched) return;
        }

        if (startTime == 0) {
            startTime = block.timestamp;
        }

        uint256 reward = (volumeUSDT18 * rewardPerUsd) / 1 ether;
        if (reward == 0) return;

        if (reward > remainingReward) {
            reward = remainingReward;
            if (reward == 0) return;
        }

        remainingReward -= reward;
        distributedReward += reward;

        // Add reward to user's pool accumulator (O(1), settles first then adds rate)
        _addReward(trader, reward);
        totalCommitted += reward;

        if (remainingReward == 0) {
            isEnded = true;
        }

        // Fetch the referral chain in one factory call (up to 8 levels),
        // replacing per-level cross-contract queries.
        address[POOL_REF_MAX_LEVELS] memory ancestors;
        {
            address[] memory chain = factory.getReferrerChain(trader, POOL_REF_MAX_LEVELS);
            uint256 cnt = chain.length;
            if (cnt > POOL_REF_MAX_LEVELS) cnt = POOL_REF_MAX_LEVELS;
            for (uint256 i = 0; i < cnt; i++) {
                ancestors[i] = chain[i];
            }
        }

        emit SwapRecorded(trader, volumeUSDT18, reward);

        // Referral rewards share the same prize pool (remainingReward):
        // when uplines exist, each level is paid instantly from the amount
        // derived from the trader reward at its bp rate, stopping when the
        // budget is exhausted; with no referrer/upline no referral payout
        // occurs and the trader can mine the entire totalReward.
        for (uint256 lvl = 0; lvl < POOL_REF_MAX_LEVELS && remainingReward > 0; lvl++) {
            uint256 rateBp = referralRateBp[lvl];
            address ancestor = ancestors[lvl];
            if (rateBp == 0 || ancestor == address(0)) continue;
            uint256 levelReward = (reward * rateBp) / 10000;
            if (levelReward == 0) continue;
            if (levelReward > remainingReward) levelReward = remainingReward;

            remainingReward -= levelReward;
            distributedReferral += levelReward;
            SafeERC20.safeTransfer(IERC20(rewardToken), ancestor, levelReward);
            emit ReferralReward(ancestor, trader, levelReward, lvl + 1);
        }

        if (remainingReward == 0) {
            isEnded = true;
        }
    }

    /// @notice Claim all vested (released) rewards.
    /// @dev Released amounts are computed linearly per daily bucket;
    /// matured buckets are amortised and cleaned during this call.
    function claim() external nonReentrant returns (uint256 out) {
        out = VestingAccumulator.settleClaim(userAcc[msg.sender], vestingDuration);
        if (out == 0) revert NothingToClaim();

        totalCommitted -= out;
        SafeERC20.safeTransfer(IERC20(rewardToken), msg.sender, out);

        emit Claimed(msg.sender, out);
        return out;
    }

    /// @notice Factory proxy claim: transfers the user's claimable rewards directly.
    /// @dev Called by Factory during claimAllMyPools / claimPools.
    function claimFor(address user) external onlyFactory nonReentrant returns (uint256 out) {
        if (user == address(0)) revert ZeroUser();
        out = VestingAccumulator.settleClaim(userAcc[user], vestingDuration);
        if (out == 0) return 0;

        totalCommitted -= out;
        SafeERC20.safeTransfer(IERC20(rewardToken), user, out);

        emit Claimed(user, out);
        return out;
    }

    function getClaimable(address user) external view returns (uint256) {
        return VestingAccumulator.claimable(userAcc[user], vestingDuration);
    }

    /// @notice View the full vesting state for a user (frontend helper).
    function getVestingInfo(address user) external view returns (
        uint256 totalAllocated,
        uint256 totalClaimed,
        uint256 releasedNow,
        uint256 claimableNow
    ) {
        return VestingAccumulator.info(userAcc[user], vestingDuration);
    }

    // ====== Internal: reward accrual ======

    /// @dev Credit a trader reward. Same-UTC-day rewards merge into one
    /// daily bucket that vests linearly from that day's 00:00 UTC.
    function _addReward(address user, uint256 amount) internal {
        VestingAccumulator.addReward(userAcc[user], amount);
    }

    function enroll() external {
        if (isEnded) revert PoolAlreadyEnded();
        if (_isDelisted) revert PoolDelisted();
        if (enrolledTraders[msg.sender]) revert AlreadyEnrolled();
        enrolledTraders[msg.sender] = true;
        enrolledCount += 1;
        // Sync the factory rosters: the factory records the enrollment in
        // both the append-only history (batch claims) and the compact
        // active list (swap notifications). A factory revert (e.g. the
        // enrollment cap) rolls the whole call back, so pool and factory
        // state never diverge.
        factory.onPoolEnroll(msg.sender);
        emit TraderEnrolled(msg.sender);
    }

    function unenroll() external {
        if (!enrolledTraders[msg.sender]) revert NotEnrolled();
        enrolledTraders[msg.sender] = false;
        enrolledCount -= 1;
        // Remove the pool from the factory active list; the append-only
        // history is retained so already-earned rewards stay claimable.
        factory.onPoolUnenroll(msg.sender);
        emit TraderUnenrolled(msg.sender);
    }

    function getReferralRates() external view returns (uint256[POOL_REF_MAX_LEVELS] memory) {
        return referralRateBp;
    }

    /// @notice Per-pool single-level referral rate setter. Only the pool
    /// owner may call it. The combined 8-level sum must stay within
    /// POOL_REF_BPS_LIMIT (30%) so the required deposit does not go out
    /// of sync with the budget. Note: this only changes future referral
    /// computations; already-accrued rewards are never retroactively
    /// affected.
    function setPoolReferralRate(uint8 level, uint256 bpVal) external onlyPoolOwner {
        if (level >= POOL_REF_MAX_LEVELS) revert LevelOutOfRange();
        uint256 total;
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) {
            total += (i == level) ? bpVal : referralRateBp[i];
        }
        if (total > POOL_REF_BPS_LIMIT) revert RefBpsExceedLimit();
        referralRateBp[level] = bpVal;
        emit PoolReferralRateSet(level, bpVal, referralRateBp);
    }

    /// @notice Full-array referral rate setter. Convenience for the pool
    /// owner that wants to update the whole schedule in one call.
    function setPoolReferralRates(uint256[POOL_REF_MAX_LEVELS] calldata rates) external onlyPoolOwner {
        uint256 total;
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) total += rates[i];
        if (total > POOL_REF_BPS_LIMIT) revert RefBpsExceedLimit();
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) referralRateBp[i] = rates[i];
        emit PoolReferralRateSet(type(uint8).max, 0, referralRateBp);
    }

    function poolInfo() external view returns (
        string memory name_,
        address rewardToken_,
        uint256 totalReward_,
        uint256 totalRewardRequired_,
        uint256 depositedReward_,
        uint256 distributedReward_,
        uint256 distributedReferral_,
        uint256 remainingReward_,
        uint256 vestingDuration_,
        uint8 mode_,
        address targetPair_,
        bool isActivated_,
        bool isEnded_,
        bool isVerified_,
        bool isDelisted_,
        uint256 startTime_,
        uint256 boostPaidTotal_,
        address poolOwner_,
        uint256 rewardPerUsd_,
        uint256 l1bp_,
        uint256 l2bp_,
        uint256[POOL_REF_MAX_LEVELS] memory rates_
    ) {
        return (
            name, rewardToken, totalReward, totalRewardRequired,
            depositedReward, distributedReward, distributedReferral,
            remainingReward, vestingDuration,
            mode, targetPair, isActivated, isEnded, isVerified, _isDelisted,
            startTime, boostPaidTotal, poolOwner, rewardPerUsd,
            referralRateBp[0], referralRateBp[1], referralRateBp
        );
    }

    function setBoostPaid(uint256 _paidTotal) external onlyFactory {
        if (_paidTotal < boostPaidTotal) revert BoostCannotDecrease();
        boostPaidTotal = _paidTotal;
        emit BoostPaid(_paidTotal);
    }

    function setVerified(bool v) external onlyFactoryOwner {
        isVerified = v;
        emit VerifiedSet(v);
    }

    function delist() external onlyFactoryOwner {
        _isDelisted = true;
        emit Delisted();
    }

    function transferPoolOwner(address newOwner) external onlyPoolOwner {
        if (newOwner == address(0)) revert ZeroNewOwner();
        if (newOwner == poolOwner) revert SameOwner();
        poolOwner = newOwner;
    }

    function withdrawStuckTokens(address token, uint256 amount) external onlyPoolOwner nonReentrant {
        if (token == address(0)) revert ZeroToken();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal < amount) revert BalanceTooLow();

        if (token == rewardToken) {
            uint256 reservedForUsers = remainingReward + totalCommitted;
            if (bal < reservedForUsers) revert AccountingBroken();
            if (bal - reservedForUsers < amount) revert CannotWithdrawUserReserved();
        }

        SafeERC20.safeTransfer(IERC20(token), msg.sender, amount);
    }
}

contract CfoMiningPoolFactory is Ownable {
    using SafeERC20 for IERC20;

    // Custom errors replace long revert strings to shrink runtime bytecode
    // and reduce gas cost.
    error NotAllowedCallerNorPool();
    error EnrollmentLimitReached();
    error ZeroTrader();
    error BadReferrer();
    error NotRegisteredPool();
    error ZeroMiningAddr();
    error SelfReferral();
    error RefBpsExceedLimit();
    error ZeroAddress();
    error CfoNotContract();
    error ZeroCaller();
    error CallerExists();
    error CallerNotFound();
    error ZeroRecipient();
    error NotAllowedCaller();
    error PoolNotRegistered();
    error PoolIsDelisted();
    error BoostTooSmall();
    error BoostTooLarge();
    error PoolAlreadyEnded();
    error BoostRecipientNotSet();
    error BnbTransferFailed();
    error CfoNotSet();
    error InvalidVestingOption();
    error InvalidMode();
    error RewardTokenNotContract();
    error InvalidTargetPair();
    error PairZeroToken();
    error TargetPairNotLp();
    error ZeroTotalReward();
    error NotRegistered();
    error StartOutOfRange();
    error UseBoostPoolToPayBnb();

    address public cfoToken;

    // Maximum number of pools a trader may be actively enrolled in at the
    // same time. The router gas floor budgets factory notification as
    // base + activePools * per-pool gas, so active enrollments must be
    // bounded to keep swap gas finite.
    uint256 public constant MAX_ENROLLED_POOLS = 10;
    // Gas forwarded to a single pool onSwap sub-call. Calibrated by
    // GasProfile.t.sol: the worst measured pool (cold accumulator paying 8
    // referral levels into never-touched cold accounts) costs ~470k; 550k
    // leaves headroom for harder forks/state growth.
    uint256 private constant POOL_CALL_GAS = 550_000;
    // Minimum gasleft() required before attempting the next pool. Must
    // exceed POOL_CALL_GAS scaled by the 63/64 forwarding rule (550k needs
    // ~559k available) plus loop/event overhead.
    uint256 private constant POOL_GATE_GAS = 600_000;
    // Gas budget for one claimFor sub-call in batch claims.
    uint256 private constant CLAIM_CALL_GAS = 150_000;
    // gasleft() gate between claim sub-calls.
    uint256 private constant CLAIM_GATE_GAS = 160_000;
    // PoolNotifySkipped reason codes.
    uint8 private constant SKIP_GAS_GATE = 1;
    uint8 private constant SKIP_CALL_FAILED = 2;

    /// @notice Address of the CfoMining contract. We keep it for
    /// future permission/accounting lookups, but the authoritative
    /// bind-once referral map lives inside this factory so both trade
    /// mining and every user-created LP pool observe exactly the same
    /// lineage regardless of which contract the user interacts with
    /// first.
    address public cfoMining;

    /// @notice Canonical bind-once referral map. Populated either by an
    /// onSwap notification that carries a `ref` upline (via
    /// bindReferrerOf) or through the owner's emergency override. Once
    /// a trader's upline is written it can never be changed.
    mapping(address => address) public globalReferrerOf;

    mapping(address => bool) public isAllowedCaller;
    address[] public allowedCallers;

    uint256 public CREATE_POOL_FEE = 1000 ether;

    address public boostFeeRecipient;
    uint256 public constant BOOST_MIN_AMOUNT = 0.01 ether;
    uint256 public constant BOOST_MAX_AMOUNT = 1 ether;

    // Factory-wide reference 8-level referral schedule (L1 20%, L2 10% by
    // default, higher tiers disabled). Exposed for frontends to prefill
    // pool creation; the authoritative per-pool rates are the array passed
    // to createPoolV2. Owner can tune the schedule via setDefaultReferralRates
    // without a redeploy.
    uint256[POOL_REF_MAX_LEVELS] public defaultReferralRates;

    address[] public pools;
    mapping(address => bool) public isRegistered;
    mapping(address => bool) public isDelisted;
    mapping(address => address[2]) private pairTokens;

    // Cached pool type at creation: mode=1 stores its targetPair, mode=0
    // stores the zero address. Swap notifications pre-filter by path
    // locally so no external call is made to irrelevant pools.
    mapping(address => address) public poolTargetPair;

    // Trader enrollment rosters:
    //  - history: append-only (re-enrollment never duplicates), used by
    //    batch claims so rewards earned before unenrolling stay claimable.
    //  - active list: compact roster of currently enrolled pools, kept in
    //    sync by the enroll/unenroll callbacks. Swap notifications iterate
    //    this list (bounded by MAX_ENROLLED_POOLS), and the router sizes
    //    its gas floor from its length via getActivePoolCount.
    mapping(address => address[]) private traderPoolsHistory;
    mapping(address => address[]) private traderActivePools;
    mapping(address => mapping(address => bool)) private traderPoolSeen;
    mapping(address => mapping(address => bool)) private traderPoolActive;
    mapping(address => mapping(address => uint256)) private traderActiveIndex;

    struct ClaimBatchResult {
        uint256 poolsChecked;
        uint256 poolsClaimed;
        uint256 totalClaimedWei;
    }

    event ClaimAllPools(address indexed user, uint256 poolsChecked, uint256 poolsClaimed, uint256 totalClaimedWei);
    event ClaimPools(address indexed user, uint256 poolsChecked, uint256 poolsClaimed, uint256 totalClaimedWei);

    event PoolCreated(address indexed pool, address indexed owner, string name, address rewardToken);
    event CreatePoolFeeSet(uint256 fee);
    event CfoTokenSet(address indexed token);
    event CallerAdded(address indexed caller);
    event CallerRemoved(address indexed caller);
    event BoostFeeRecipientSet(address indexed recipient);
    event Boosted(address indexed pool, address indexed payer, uint256 amount, uint256 newPaidTotal);
    event PoolDelisted(address indexed pool);
    event PoolVerifiedChanged(address indexed pool, bool verified);
    event SwapForwarded(uint256 poolsCount, uint256 notifiedCount, uint256 volumeUSDT18);
    // Emitted when an enrolled pool is not notified during fan-out, with
    // the pool index inside the active roster and the reason code
    // (SKIP_GAS_GATE / SKIP_CALL_FAILED). Enables off-chain monitoring of
    // reward-delivery gaps.
    event PoolNotifySkipped(address indexed trader, address indexed pool, uint256 index, uint8 reason);
    event DefaultReferralRatesSet(uint256[POOL_REF_MAX_LEVELS] rates);
    event CfoMiningSet(address indexed mining);
    event ReferrerBound(address indexed trader, address indexed referrer);
    event ReferrerOverridden(address indexed trader, address indexed referrer);

    constructor() Ownable(msg.sender) {
        boostFeeRecipient = msg.sender;
        // Day-one defaults: L1 20% and L2 10%, higher tiers disabled. Matches
        // the trade-mining contract so referral payouts are consistent across
        // the whole platform. Owner can raise higher tiers later.
        defaultReferralRates[0] = 2000;
        defaultReferralRates[1] = 1000;
        // defaultReferralRates[2..7] = 0 by default (8-level programmable)
    }

    /// @notice Bind-once referral setter. Two classes of callers are
    /// authorised: (1) whitelisted integrations such as CfoMining,
    /// and (2) any pool contract that was formally
    /// registered by this factory itself. Because every CfoMiningPool is
    /// instantiated inside createPool via `new CfoMiningPool(...)` the
    /// registered-pool gate is guaranteed to be opened exactly once at
    /// construction and no third-party contract can spoof bindings.
    /// Once a trader's upline is recorded it can never be overwritten,
    /// so whichever notification lands first wins.
    function bindReferrerOf(address trader, address ref) external {
        if (!isAllowedCaller[msg.sender] && !isRegistered[msg.sender]) revert NotAllowedCallerNorPool();
        if (trader == address(0)) revert ZeroTrader();
        if (ref == address(0) || ref == trader) revert BadReferrer();
        if (globalReferrerOf[trader] == address(0)) {
            globalReferrerOf[trader] = ref;
            emit ReferrerBound(trader, ref);
        }
    }

    /// @notice Pool enrollment callback (callable only by pools registered
    /// by this factory). On first enrollment the pool is appended to the
    /// trader's append-only history (batch claims); every enrollment adds
    /// the pool to the compact active roster used for swap notifications.
    /// Reverts when the trader already holds MAX_ENROLLED_POOLS active
    /// enrollments to keep per-swap notification gas bounded.
    function onPoolEnroll(address trader) external {
        if (!isRegistered[msg.sender]) revert NotRegisteredPool();
        address pool = msg.sender;
        if (traderPoolActive[trader][pool]) return;
        if (traderActivePools[trader].length >= MAX_ENROLLED_POOLS) revert EnrollmentLimitReached();
        if (!traderPoolSeen[trader][pool]) {
            traderPoolSeen[trader][pool] = true;
            traderPoolsHistory[trader].push(pool);
        }
        traderActiveIndex[trader][pool] = traderActivePools[trader].length;
        traderActivePools[trader].push(pool);
        traderPoolActive[trader][pool] = true;
    }

    /// @notice Pool unenrollment callback. Removes the pool from the active
    /// roster (O(1) swap-and-pop); the append-only history is retained so
    /// earned-but-unclaimed rewards remain covered by batch claims.
    function onPoolUnenroll(address trader) external {
        if (!isRegistered[msg.sender]) revert NotRegisteredPool();
        address pool = msg.sender;
        if (!traderPoolActive[trader][pool]) return;
        uint256 idx = traderActiveIndex[trader][pool];
        uint256 last = traderActivePools[trader].length - 1;
        if (idx != last) {
            address moved = traderActivePools[trader][last];
            traderActivePools[trader][idx] = moved;
            traderActiveIndex[trader][moved] = idx;
        }
        traderActivePools[trader].pop();
        traderPoolActive[trader][pool] = false;
        traderActiveIndex[trader][pool] = 0;
    }

    /// @notice Number of pools the trader is currently enrolled in. Read by
    /// the router pre-swap gas floor to size the factory notification budget
    /// (base + count * per-pool gas). View-only: always returns the live
    /// active roster length, never reverts on a misconfigured factory.
    function getActivePoolCount(address trader) external view returns (uint256) {
        return traderActivePools[trader].length;
    }

    /// @notice Returns the upline chain of an address, up to maxDepth
    /// levels, in a single call instead of per-level cross-contract
    /// queries (saves 7-8 external calls per swap). Levels without an
    /// upline are truncated.
    function getReferrerChain(address user, uint256 maxDepth)
        external
        view
        returns (address[] memory chain)
    {
        address[] memory tmp = new address[](maxDepth);
        uint256 cnt;
        address cur = globalReferrerOf[user];
        for (uint256 i = 0; i < maxDepth; i++) {
            if (cur == address(0)) break;
            tmp[cnt] = cur;
            cnt++;
            cur = globalReferrerOf[cur];
        }
        chain = new address[](cnt);
        for (uint256 j = 0; j < cnt; j++) chain[j] = tmp[j];
    }

    /// @notice Trader enrollment history together with the current active
    /// flag per entry (frontend batch-claim / roster display).
    function getTraderPools(address trader)
        external
        view
        returns (address[] memory poolList, bool[] memory activeList)
    {
        address[] storage mine = traderPoolsHistory[trader];
        uint256 n = mine.length;
        poolList = new address[](n);
        activeList = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            poolList[i] = mine[i];
            activeList[i] = traderPoolActive[trader][mine[i]];
        }
    }

    function setCfoMining(address v) external onlyOwner {
        if (v == address(0)) revert ZeroMiningAddr();
        cfoMining = v;
        emit CfoMiningSet(v);
    }

    /// @notice Owner-only emergency migration. Lets the DAO recover a
    /// broken legacy referral relationship. The normal bind-once path
    /// via bindReferrerOf does NOT depend on this gate.
    function emergencyOverrideReferrer(address trader, address referrer) external onlyOwner {
        if (trader == address(0)) revert ZeroTrader();
        if (referrer == trader) revert SelfReferral();
        globalReferrerOf[trader] = referrer;
        emit ReferrerOverridden(trader, referrer);
    }

    function setDefaultReferralRates(uint256[POOL_REF_MAX_LEVELS] calldata rates) external onlyOwner {
        uint256 sum;
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) sum += rates[i];
        if (sum > POOL_REF_BPS_LIMIT) revert RefBpsExceedLimit();
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) defaultReferralRates[i] = rates[i];
        emit DefaultReferralRatesSet(rates);
    }

    function getDefaultReferralRates() external view returns (uint256[POOL_REF_MAX_LEVELS] memory) {
        return defaultReferralRates;
    }

    function _isContract(address a) private view returns (bool) {
        uint256 s;
        assembly ("memory-safe") { s := extcodesize(a) }
        return a != address(0) && s > 0;
    }

    function setCfoToken(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        if (!_isContract(v)) revert CfoNotContract();
        cfoToken = v;
        emit CfoTokenSet(v);
    }

    function addCaller(address v) external onlyOwner {
        if (v == address(0)) revert ZeroCaller();
        if (isAllowedCaller[v]) revert CallerExists();
        isAllowedCaller[v] = true;
        allowedCallers.push(v);
        emit CallerAdded(v);
    }

    function addCallersBatch(address[] calldata vs) external onlyOwner {
        for (uint256 i = 0; i < vs.length; i++) {
            address v = vs[i];
            if (v != address(0) && !isAllowedCaller[v]) {
                isAllowedCaller[v] = true;
                allowedCallers.push(v);
                emit CallerAdded(v);
            }
        }
    }

    function removeCaller(address v) external onlyOwner {
        if (!isAllowedCaller[v]) revert CallerNotFound();
        isAllowedCaller[v] = false;
        emit CallerRemoved(v);
    }

    function allowedCallersCount() external view returns (uint256) {
        return allowedCallers.length;
    }

    function setCreatePoolFee(uint256 v) external onlyOwner {
        CREATE_POOL_FEE = v;
        emit CreatePoolFeeSet(v);
    }

    function setBoostFeeRecipient(address v) external onlyOwner {
        if (v == address(0)) revert ZeroRecipient();
        boostFeeRecipient = v;
        emit BoostFeeRecipientSet(v);
    }

    function setPairTokens(address pair, address token0, address token1) external onlyOwner {
        pairTokens[pair] = [token0, token1];
    }

    function getPairTokens(address pair) external view returns (address token0, address token1) {
        token0 = pairTokens[pair][0];
        token1 = pairTokens[pair][1];
    }

    /// @notice Router notification entry. Only notifies pools the trader
    /// is currently enrolled in, with mode-1 pools pre-filtered locally by
    /// swap path. Cost is proportional to the trader's own enrollment list
    /// (usually 0~3), not to the total number of pools on the platform.
    /// @param path Swap path used for mode-1 pair matching.
    function onSwap(address trader, uint256 volumeUSDT18, address ref, address[] calldata path) external {
        if (!isAllowedCaller[msg.sender]) revert NotAllowedCaller();
        if (volumeUSDT18 == 0 || trader == address(0)) return;

        // Referral binding completes locally at the factory entry
        // (bind-once; skipped when already bound).
        if (ref != address(0) && ref != trader && globalReferrerOf[trader] == address(0)) {
            globalReferrerOf[trader] = ref;
            emit ReferrerBound(trader, ref);
        }

        address[] storage mine = traderActivePools[trader];
        uint256 n = mine.length;
        uint256 notified;
        for (uint256 i = 0; i < n; i++) {
            // A fully-loaded pool onSwap (trader reward + 8 instant referral
            // transfers, cold accumulator and cold referral accounts) costs
            // ~0.47M gas per profiling. Stop before attempting a sub-call
            // that cannot receive its full budget: an OOG sub-call reverts
            // and burns the gas forwarded.
            // The router gas floor guarantees enough gas for all active pools
            // under normal wallet behaviour; this gate is the last line of
            // defence for manually lowered gas limits, and emits a monitored
            // event instead of skipping silently.
            if (gasleft() < POOL_GATE_GAS) {
                for (uint256 j = i; j < n; j++) {
                    emit PoolNotifySkipped(trader, mine[j], j, SKIP_GAS_GATE);
                }
                break;
            }
            // Loop body in a separate stack frame to avoid stack-too-deep
            // under viaIR.
            if (_notifyOnePool(mine[i], i, trader, volumeUSDT18, ref, path)) {
                notified++;
            }
        }
        emit SwapForwarded(n, notified, volumeUSDT18);
    }

    /// @dev Notify a single pool: delisted / path-mismatch / ended pools are
    /// pre-filtered before the external call (normal business filtering, no
    /// event). Split into its own function to isolate the stack frame;
    /// returns whether the pool was actually notified. Gas-gate cuts and
    /// failed external calls emit PoolNotifySkipped so reward gaps are
    /// visible off-chain instead of failing silently.
    function _notifyOnePool(
        address p,
        uint256 index,
        address trader,
        uint256 volumeUSDT18,
        address ref,
        address[] calldata path
    ) internal returns (bool) {
        if (isDelisted[p]) return false;
        // mode=1: skip pools whose target pair does not match the swap path,
        // without making any external call.
        address pair = poolTargetPair[p];
        if (pair != address(0) && !_pathMatchesPair(pair, path)) return false;
        bool ended;
        try CfoMiningPool(p).isEnded() returns (bool e) { ended = e; } catch { return false; }
        if (ended) return false;
        try CfoMiningPool(p).onSwap{gas: POOL_CALL_GAS}(trader, volumeUSDT18, ref, path) {
            return true;
        } catch {
            emit PoolNotifySkipped(trader, p, index, SKIP_CALL_FAILED);
            return false;
        }
    }

    /// @dev Local path matching: a pair matches when the path contains the
    /// pair address itself or either of its tokens.
    function _pathMatchesPair(address pair, address[] calldata path) internal view returns (bool) {
        address t0 = pairTokens[pair][0];
        address t1 = pairTokens[pair][1];
        for (uint256 i = 0; i < path.length; i++) {
            address tok = path[i];
            if (tok == pair || tok == t0 || tok == t1) return true;
        }
        return false;
    }

    function boostPool(address pool) external payable {
        if (!isRegistered[pool]) revert PoolNotRegistered();
        if (isDelisted[pool]) revert PoolIsDelisted();
        if (msg.value < BOOST_MIN_AMOUNT) revert BoostTooSmall();
        if (msg.value > BOOST_MAX_AMOUNT) revert BoostTooLarge();
        bool ended;
        try CfoMiningPool(pool).isEnded() returns (bool e) { ended = e; } catch {}
        if (ended) revert PoolAlreadyEnded();
        if (boostFeeRecipient == address(0)) revert BoostRecipientNotSet();

        uint256 oldTotal = CfoMiningPool(pool).boostPaidTotal();
        uint256 newTotal = oldTotal + msg.value;
        CfoMiningPool(pool).setBoostPaid(newTotal);

        (bool success, ) = boostFeeRecipient.call{value: msg.value, gas: 2300}("");
        if (!success) revert BnbTransferFailed();

        emit Boosted(pool, msg.sender, msg.value, newTotal);
    }

    /**
     * @notice 8-level aware pool creation. Each rate slot corresponds to
     * referral level N+1. Rates are in basis points; sum must stay within
     * POOL_REF_BPS_LIMIT (30%).
     */
    function createPoolV2(
        string calldata name,
        address rewardToken,
        uint256 totalReward,
        uint256 rewardPerUsd,
        uint8 mode,
        address targetPair,
        uint8 vestingOption,
        uint256[POOL_REF_MAX_LEVELS] calldata referralRateBpArr
    ) external returns (address poolAddr) {
        return _createPoolInner(name, rewardToken, totalReward, rewardPerUsd, mode, targetPair, vestingOption, referralRateBpArr);
    }

    function _createPoolInner(
        string calldata name,
        address rewardToken,
        uint256 totalReward,
        uint256 rewardPerUsd,
        uint8 mode,
        address targetPair,
        uint8 vestingOption,
        uint256[POOL_REF_MAX_LEVELS] memory rates
    ) internal returns (address poolAddr) {
        if (cfoToken == address(0)) revert CfoNotSet();
        if (vestingOption > 3) revert InvalidVestingOption();
        if (mode != 0 && mode != 1) revert InvalidMode();

        if (!_isContract(rewardToken)) revert RewardTokenNotContract();

        if (mode == 1) {
            if (!_isContract(targetPair)) revert InvalidTargetPair();
            // No owner pre-registration required: read the LP token0()/token1()
            // via staticcall and cache them, so anyone can create a pair pool.
            // The owner can still pre-set/override via setPairTokens.
            if (pairTokens[targetPair][0] == address(0)) {
                try IPancakePairLike(targetPair).token0() returns (address t0) {
                    try IPancakePairLike(targetPair).token1() returns (address t1) {
                        if (t0 == address(0) || t1 == address(0)) revert PairZeroToken();
                        pairTokens[targetPair] = [t0, t1];
                    } catch {
                        revert TargetPairNotLp();
                    }
                } catch {
                    revert TargetPairNotLp();
                }
            }
        }

        if (totalReward == 0) revert ZeroTotalReward();
        uint256 ratesSum;
        for (uint256 i = 0; i < POOL_REF_MAX_LEVELS; i++) ratesSum += rates[i];
        if (ratesSum > POOL_REF_BPS_LIMIT) revert RefBpsExceedLimit();

        CfoMiningPool pool = new CfoMiningPool(
            payable(address(this)),
            msg.sender,
            name,
            rewardToken,
            totalReward,
            mode,
            targetPair,
            vestingOption,
            rates,
            rewardPerUsd
        );
        poolAddr = address(pool);

        if (CREATE_POOL_FEE > 0) {
            SafeERC20.safeTransferFrom(
                IERC20(cfoToken),
                msg.sender,
                address(0x000000000000000000000000000000000000dEaD),
                CREATE_POOL_FEE
            );
        }

        pools.push(poolAddr);
        isRegistered[poolAddr] = true;
        isDelisted[poolAddr] = false;
        // mode=1 caches the target pair (local path pre-filtering at notify
        // time); mode=0 always stores the zero address.
        poolTargetPair[poolAddr] = (mode == 1) ? targetPair : address(0);

        emit PoolCreated(poolAddr, msg.sender, name, rewardToken);
    }

    function ownerDelistPool(address pool) external onlyOwner {
        if (!isRegistered[pool]) revert NotRegistered();
        isDelisted[pool] = true;
        CfoMiningPool(pool).delist();
        emit PoolDelisted(pool);
    }

    function ownerSetPoolVerified(address pool, bool v) external onlyOwner {
        if (!isRegistered[pool]) revert NotRegistered();
        CfoMiningPool(pool).setVerified(v);
        emit PoolVerifiedChanged(pool, v);
    }

    function getAllPools() external view returns (address[] memory) {
        return pools;
    }

    function poolsCount() external view returns (uint256) {
        return pools.length;
    }

    /// @notice Claim rewards from every pool the trader has ever enrolled
    /// in. Iterates the append-only enrollment history (pools unenrolled
    /// from are included; their earned rewards stay claimable inside the
    /// pool). When the pool count does not fit in one transaction, continue
    /// with claimMyPoolsPage.
    function claimAllMyPools() external returns (ClaimBatchResult memory r) {
        (r, ) = _claimPage(msg.sender, 0, type(uint256).max);
        emit ClaimAllPools(msg.sender, r.poolsChecked, r.poolsClaimed, r.totalClaimedWei);
    }

    /// @notice Paginated batch claim. `start` is the first index (from 0),
    /// `maxCount` bounds how many pools are checked on this page. Returns
    /// nextStart for the following page; when nextStart >= history length
    /// the whole roster has been covered.
    function claimMyPoolsPage(uint256 start, uint256 maxCount)
        external
        returns (ClaimBatchResult memory r, uint256 nextStart)
    {
        (r, nextStart) = _claimPage(msg.sender, start, maxCount);
        emit ClaimPools(msg.sender, r.poolsChecked, r.poolsClaimed, r.totalClaimedWei);
    }

    function _claimPage(address user, uint256 start, uint256 maxCount)
        internal
        returns (ClaimBatchResult memory r, uint256 nextStart)
    {
        address[] storage mine = traderPoolsHistory[user];
        uint256 total = mine.length;
        if (start > total) revert StartOutOfRange();
        uint256 end = total;
        if (maxCount != type(uint256).max && start + maxCount < total) {
            end = start + maxCount;
        }
        uint256 i = start;
        for (; i < end; i++) {
            if (gasleft() < CLAIM_GATE_GAS) break;
            address p = mine[i];
            if (!isRegistered[p] || isDelisted[p]) continue;
            r.poolsChecked++;
            try CfoMiningPool(p).claimFor{gas: CLAIM_CALL_GAS}(user) returns (uint256 got) {
                if (got > 0) {
                    r.poolsClaimed++;
                    r.totalClaimedWei += got;
                }
            } catch {}
        }
        nextStart = i;
    }

    function claimPools(address[] calldata poolList) external returns (ClaimBatchResult memory r) {
        uint256 n = poolList.length;
        for (uint256 i = 0; i < n; i++) {
            if (gasleft() < CLAIM_GATE_GAS) break;
            address p = poolList[i];
            if (!isRegistered[p] || isDelisted[p]) continue;
            r.poolsChecked++;
            try CfoMiningPool(p).claimFor{gas: CLAIM_CALL_GAS}(msg.sender) returns (uint256 got) {
                if (got > 0) {
                    r.poolsClaimed++;
                    r.totalClaimedWei += got;
                }
            } catch {}
        }
        emit ClaimPools(msg.sender, r.poolsChecked, r.poolsClaimed, r.totalClaimedWei);
    }

    receive() external payable {
        revert UseBoostPoolToPayBnb();
    }
}
