// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VestingAccumulator} from "./VestingAccumulator.sol";

interface ICfoToken {
    function mint(address to, uint256 amount) external;
}

/// @notice Minimal interface to the referral registry (MiningPoolFactory):
/// fetch the whole referral chain in one call to avoid level-by-level
/// cross-contract queries.
interface IReferrerRegistry {
    function globalReferrerOf(address user) external view returns (address);
    function bindReferrerOf(address trader, address referrer) external;
    function getReferrerChain(address user, uint256 maxDepth) external view returns (address[] memory);
}

contract CfoMining is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Maximum number of supported referral levels. Fixed to 8 to match the
    // OKX-style 8-level waterfall distribution. The owner does not need
    // to fill all 8 levels; unused rates stay at zero which simply skips
    // that tier without extra cost.
    uint256 public constant REF_MAX_LEVELS = 8;

    address public cfoToken;

    /// @notice Canonical bind-once referral registry. Lives on the
    /// MiningPoolFactory contract so trade mining, every user-created
    /// pool and LP notifications see the exact same upline regardless
    /// of which contract processed a trader's first interaction.
    address public miningPoolFactory;

    // Whitelisted callers (Router contracts that can trigger onSwap)
    mapping(address => bool) public isAllowedCaller;
    address[] public allowedCallers;

    // Stage parameters for mining rewards
    uint256 public constant INIT_STAGE1_CAP = 10_000_000 ether;
    uint256 public constant INIT_STAGE1_RATE = 150 ether;
    uint256 public constant INIT_STAGE2_CAP = 90_000_000 ether;
    uint256 public constant INIT_STAGE2_RATE = 1500 ether;

    uint256 public stage1Cap = INIT_STAGE1_CAP;
    uint256 public stage1Rate = INIT_STAGE1_RATE;
    uint256 public stage2Cap = INIT_STAGE2_CAP;
    uint256 public stage2Rate = INIT_STAGE2_RATE;

    uint256 public totalMintedStage1;
    uint256 public totalMintedStage2;

    /// @notice Immutable vesting duration. Fixed at deployment, can never be changed.
    /// @dev Making it immutable prevents retroactive changes to reward release rates.
    uint256 public immutable VESTING_DURATION;

    // ====== Per-trade linear vesting accumulator (merged by UTC day) ======
    //
    // Each trade reward is merged into a daily bucket keyed by the UTC
    // calendar day; the bucket starts at that day's 00:00 UTC and vests
    // linearly over VESTING_DURATION from its start. Daily buckets count
    // down independently and never accelerate each other. Same-day trades
    // are claimable on the trade day itself (the bucket starts no more than
    // 24h earlier, which only favors the user). Gas is independent of trade
    // count: any number of trades on the same day writes one bucket; the
    // number of unvested buckets never exceeds the vesting period in days,
    // and matured buckets are amortized and cleaned on claim. See
    // VestingAccumulator for details.
    mapping(address => VestingAccumulator.Accumulator) internal userAcc;

    // Per-user opt-out switch: everyone participates in CFO farm mining by
    // default and a user may opt out. After opting out, the user's own
    // trades no longer produce trader rewards, but upline referral rewards
    // are still paid (referral payout is governed solely by referralRateBp);
    // already-accrued rewards are unaffected and remain claimable.
    mapping(address => bool) public miningOptOut;

    // Referral parameters. 8-element array indexed by level:
    //   referralRateBp[0] = L1 direct upline share (bps)
    //   referralRateBp[1] = L2 grand-upline share (bps)
    //   ...
    //   referralRateBp[7] = L8 share (bps)
    // Only the first few entries need to be non-zero at setup time; the
    // rest can be raised later via setReferralRates without a redeploy.
    uint256[REF_MAX_LEVELS] public referralRateBp;
    uint256 public constant REF_BPS_LIMIT = 3000; // 30% combined referral cap
    uint256 public totalReferralDistributed;

    event CfoTokenSet(address indexed token);
    event MiningPoolFactorySet(address indexed factory);
    event CallerAdded(address indexed caller);
    event CallerRemoved(address indexed caller);
    event StageParamsSet(uint256 s1Cap, uint256 s1Rate, uint256 s2Cap, uint256 s2Rate);
    event ReferralRatesSet(uint256[REF_MAX_LEVELS] rates);
    event ReferrerBound(address indexed trader, address indexed referrer);
    event SwapRecorded(address indexed trader, uint256 volumeUSDT18, uint256 reward, uint256 stage);
    event ReferralReward(address indexed referrer, address indexed trader, uint256 amount, uint256 level);
    event Claimed(address indexed user, uint256 amount);
    event MiningOptOutSet(address indexed user, bool optOut);
    event TokensRescued(address indexed token, address to, uint256 amount);

    constructor(uint256 vestingDuration) Ownable(msg.sender) {
        require(vestingDuration > 0, "Mining: zero vesting duration");
        VESTING_DURATION = vestingDuration;
        // Default allocation matches the previous 2-level setup so the
        // behavior is unchanged on day one. L1 20%, L2 10%, higher tiers
        // disabled (0%). Owner can raise higher tiers at any time.
        referralRateBp[0] = 2000;
        referralRateBp[1] = 1000;
    }

    function setCfoToken(address v) external onlyOwner {
        require(v != address(0), "Mining: zero address");
        cfoToken = v;
        emit CfoTokenSet(v);
    }

    /// @notice Points this contract at the canonical MiningPoolFactory that
    /// owns the platform-wide bind-once referral map. Must be called once
    /// after both contracts are deployed so trade-mining respects the same
    /// referral lineage as every LP pool. May only be set once.
    function setMiningPoolFactory(address v) external onlyOwner {
        require(v != address(0), "Mining: zero factory");
        require(miningPoolFactory == address(0), "Mining: factory already set");
        miningPoolFactory = v;
        emit MiningPoolFactorySet(v);
    }

    function addCaller(address v) external onlyOwner {
        require(v != address(0), "Mining: zero caller");
        require(!isAllowedCaller[v], "Mining: caller exists");
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
        require(isAllowedCaller[v], "Mining: caller not found");
        isAllowedCaller[v] = false;
        emit CallerRemoved(v);
    }

    function allowedCallersCount() external view returns (uint256) {
        return allowedCallers.length;
    }

    function setStageParams(uint256 s1Cap, uint256 s1Rate, uint256 s2Cap, uint256 s2Rate) external onlyOwner {
        require(s1Rate > 0 && s2Rate > 0, "Mining: zero rate");
        // Cap can only decrease or stay (cannot oversell); rate can only increase or stay
        require(s1Cap <= INIT_STAGE1_CAP, "Mining: s1Cap overflow");
        require(s2Cap <= INIT_STAGE2_CAP, "Mining: s2Cap overflow");
        require(s1Cap >= totalMintedStage1, "Mining: s1Cap < minted");
        require(s2Cap >= totalMintedStage2, "Mining: s2Cap < minted");
        require(s1Rate >= stage1Rate, "Mining: s1Rate can't decrease");
        require(s2Rate >= stage2Rate, "Mining: s2Rate can't decrease");
        stage1Cap = s1Cap;
        stage1Rate = s1Rate;
        stage2Cap = s2Cap;
        stage2Rate = s2Rate;
        emit StageParamsSet(s1Cap, s1Rate, s2Cap, s2Rate);
    }

    /// @notice Sets the 8-level referral rate schedule. Rates are in bps
    /// and are applied to the same `baseReward` value in order (L1..L8).
    /// The sum of all 8 rates may not exceed REF_BPS_LIMIT (30%) so the
    /// combined referral payout stays capped at 30% of the trader base.
    function setReferralRates(uint256[REF_MAX_LEVELS] calldata rates) external onlyOwner {
        uint256 total;
        for (uint256 i = 0; i < REF_MAX_LEVELS; i++) {
            total += rates[i];
        }
        require(total <= REF_BPS_LIMIT, "Mining: ref bps exceed 30%");
        for (uint256 i = 0; i < REF_MAX_LEVELS; i++) {
            referralRateBp[i] = rates[i];
        }
        emit ReferralRatesSet(rates);
    }

    /// @notice Single-level setter for day-to-day tuning. Does not require
    /// passing the full 8-element array. Checks the combined cap after the
    /// update so the owner cannot accidentally over-allocate.
    function setReferralRateBp(uint8 level, uint256 bpVal) external onlyOwner {
        require(level < REF_MAX_LEVELS, "Mining: level out of range");
        uint256 total;
        for (uint256 i = 0; i < REF_MAX_LEVELS; i++) {
            total += (i == level) ? bpVal : referralRateBp[i];
        }
        require(total <= REF_BPS_LIMIT, "Mining: ref bps exceed 30%");
        referralRateBp[level] = bpVal;
        emit ReferralRatesSet(referralRateBp);
    }

    /// @notice Convenience helper: returns the current 8-level rate array
    /// in a single view call for front-ends.
    function getReferralRates() external view returns (uint256[REF_MAX_LEVELS] memory) {
        return referralRateBp;
    }

    /// @notice Self-service opt-out / opt-back-in for CFO farm trade mining.
    /// After opting out, the caller's own trades no longer produce trader
    /// rewards; upline referral rewards are unaffected and already-accrued
    /// rewards remain claimable.
    function setMiningOptOut(bool optOut) external {
        miningOptOut[msg.sender] = optOut;
        emit MiningOptOutSet(msg.sender, optOut);
    }

    modifier onlyAllowedCaller() {
        require(isAllowedCaller[msg.sender], "Mining: not allowed caller");
        _;
    }

    function onSwap(address trader, uint256 volumeUSDT18, address ref) external onlyAllowedCaller nonReentrant {
        require(cfoToken != address(0), "Mining: CFO not set");
        require(trader != address(0), "Mining: zero trader");

        if (volumeUSDT18 == 0) return;

        // Bind referral relationship on the canonical MiningPoolFactory
        // map so trade mining and every LP pool observe the same upline.
        // The factory enforces first-bind-wins semantics so we simply
        // forward the upline and let the single-source-of-truth decide.
        address factory = miningPoolFactory;
        require(factory != address(0), "Mining: factory not set");
        IReferrerRegistry registry = IReferrerRegistry(factory);
        if (ref != address(0) && ref != trader) {
            bool needBind = true;
            try registry.globalReferrerOf(trader) returns (address cur) {
                needBind = (cur == address(0));
            } catch {}
            if (needBind) {
                try registry.bindReferrerOf(trader, ref) {
                    emit ReferrerBound(trader, ref);
                } catch {}
            }
        }

        // Fetch up to 8 referral levels in a single call; a failure is
        // treated as an empty chain and never blocks trader rewards.
        address[REF_MAX_LEVELS] memory ancestors;
        uint256 ancestorCount;
        {
            address[] memory chain;
            try registry.getReferrerChain(trader, REF_MAX_LEVELS) returns (address[] memory c) {
                chain = c;
            } catch {
                chain = new address[](0);
            }
            ancestorCount = chain.length;
            if (ancestorCount > REF_MAX_LEVELS) ancestorCount = REF_MAX_LEVELS;
            for (uint256 i = 0; i < ancestorCount; i++) {
                ancestors[i] = chain[i];
            }
        }

        // Pre-calculate total referral basis points given the real ancestor
        // chain. The sum is bounded by REF_BPS_LIMIT but we re-sum here to
        // avoid spending gas on rates that have no ancestor to pay.
        uint256 refBpsTotal;
        {
            uint256 lim = ancestorCount;
            for (uint256 i = 0; i < lim; i++) {
                refBpsTotal += referralRateBp[i];
            }
        }

        // Opt-out switch: an opted-out trader earns no trader reward; if
        // there is also no referral payout at all, return early.
        bool optedOut = miningOptOut[trader];
        if (optedOut && refBpsTotal == 0) return;

        // ----- Stage 1: 10,000,000 CFO @ 150 USDT / 1.0 CFO trader reward -----
        // ----- Stage 2: 90,000,000 CFO @ 1500 USDT / 1.0 CFO trader reward -----
        //
        // Every swap is conceptually rewarded by (10000 + refBpsTotal)/10000
        // times the base trader reward: the 1x goes to the trader and the
        // rest is paid up the referral waterfall. Both shares are accounted
        // against the same per-stage cap so the 100,000,000 CFO aggregate
        // issuance is always respected exactly.

        uint256 remainingVolume = volumeUSDT18;
        uint256 baseReward;   // 1x trader portion (not yet stage-capped)
        uint256 stageUsed;
        uint256 s1BaseUsed;   // how much baseReward pulls from stage 1 pool
        uint256 s2BaseUsed;
        {
            bool stage1Open = totalMintedStage1 < stage1Cap;
            if (stage1Open) {
                // Stage-1 trader reward = volume / stage1Rate, 1:1 with the
                // per-round "1 CFO per 150 USDT" commitment.
                uint256 s1PoolLeftBase = stage1Cap - totalMintedStage1;
                uint256 r1 = (remainingVolume * 1 ether) / stage1Rate;
                if (r1 > s1PoolLeftBase) {
                    // Stage 1 base pool exhausted for this transaction.
                    r1 = s1PoolLeftBase;
                    s1BaseUsed = r1;
                    uint256 volUsed1 = (r1 * stage1Rate + 1 ether - 1) / 1 ether;
                    if (volUsed1 < remainingVolume) {
                        remainingVolume -= volUsed1;
                        // Stage 2: only touched if there is leftover volume
                        // AND the stage-2 pool is still open.
                        if (totalMintedStage2 < stage2Cap) {
                            uint256 s2PoolLeftBase = stage2Cap - totalMintedStage2;
                            uint256 r2 = (remainingVolume * 1 ether) / stage2Rate;
                            if (r2 > s2PoolLeftBase) r2 = s2PoolLeftBase;
                            s2BaseUsed = r2;
                            stageUsed = 2;
                        } else {
                            stageUsed = 1;
                        }
                    } else {
                        remainingVolume = 0;
                        stageUsed = 1;
                    }
                } else {
                    s1BaseUsed = r1;
                    stageUsed = 1;
                }
            } else {
                if (totalMintedStage2 < stage2Cap) {
                    uint256 s2PoolLeftBase = stage2Cap - totalMintedStage2;
                    uint256 r2 = (remainingVolume * 1 ether) / stage2Rate;
                    if (r2 > s2PoolLeftBase) r2 = s2PoolLeftBase;
                    s2BaseUsed = r2;
                    stageUsed = 2;
                }
            }
            baseReward = s1BaseUsed + s2BaseUsed;
        }

        if (baseReward == 0) return;

        // Referral gross: every ancestor level earns `baseReward * rateBp[i] / 10000`
        // referral bps. We size the total, then scale it down if it does not
        // actually fit the remaining referral room in the two stage caps
        // (because we already reserved `baseReward` out of them).
        uint256 refTotalGross = (baseReward * refBpsTotal) / 10000;

        // Stage 1 referral room = (stage1Cap - totalMintedStage1 - s1BaseMinted)
        // Stage 2 referral room = (stage2Cap - totalMintedStage2 - s2BaseMinted)
        // An opted-out user mints no trader portion, so the full stage room
        // is left available for referral payouts.
        // If the gross referral amount does not fit we scale down all
        // referral payouts proportionally and recompute s1/s2 referral
        // splits on the reduced amount.
        uint256 s1BaseMinted = optedOut ? 0 : s1BaseUsed;
        uint256 s2BaseMinted = optedOut ? 0 : s2BaseUsed;
        uint256 s1RefRoom = s1BaseMinted < (stage1Cap - totalMintedStage1)
            ? (stage1Cap - totalMintedStage1 - s1BaseMinted)
            : 0;
        uint256 s2RefRoom = s2BaseMinted < (stage2Cap - totalMintedStage2)
            ? (stage2Cap - totalMintedStage2 - s2BaseMinted)
            : 0;
        uint256 refTotalNet = refTotalGross;
        {
            uint256 totalRoom = s1RefRoom + s2RefRoom;
            if (refTotalNet > totalRoom) {
                refTotalNet = totalRoom;
            }
        }

        // Stage-1:stage-2 referral split mirrors the trader base split so
        // one pool is never drained first.
        uint256 s1RefUsed;
        uint256 s2RefUsed;
        if (refTotalNet > 0) {
            if (baseReward > 0) {
                s1RefUsed = (refTotalNet * s1BaseUsed) / baseReward;
                s2RefUsed = refTotalNet - s1RefUsed;
                if (s1RefUsed > s1RefRoom) {
                    // Correct rare rounding overflow
                    s2RefUsed = s2RefUsed + (s1RefUsed - s1RefRoom);
                    s1RefUsed = s1RefRoom;
                }
                if (s2RefUsed > s2RefRoom) {
                    // Cap net total if neither room is enough; should never
                    // trigger due to the earlier `totalRoom` min, but we
                    // stay defensive.
                    refTotalNet = s1RefUsed + s2RefRoom;
                    s2RefUsed = s2RefRoom;
                }
            }
        }

        // Final bookkeeping: stage pools -> accounting caps. When opted out,
        // only the actually minted referral portion is counted; the trader
        // quota stays inside the stage pool for later trades to mine.
        totalMintedStage1 += s1BaseMinted + s1RefUsed;
        totalMintedStage2 += s2BaseMinted + s2RefUsed;

        // Mint trader portion first and credit into user's accumulator so
        // claiming is O(1) and vesting is enforced per the global duration.
        // An opted-out trader is not minted trader rewards; referral rewards
        // are minted and paid as usual below.
        if (!optedOut) {
            ICfoToken(cfoToken).mint(address(this), baseReward);
            _addReward(trader, baseReward);
        }

        emit SwapRecorded(trader, volumeUSDT18, optedOut ? 0 : baseReward, stageUsed);

        // Distribute referral amounts level by level. If the gross total
        // was reduced above because the cap was nearly full we scale every
        // level by the same ratio so fairness is preserved across tiers.
        if (refTotalNet > 0) {
            uint256 refPaid;
            for (uint256 lvl = 0; lvl < ancestorCount && refPaid < refTotalNet; lvl++) {
                uint256 rateBp = referralRateBp[lvl];
                address ancestor = ancestors[lvl];
                if (rateBp == 0 || ancestor == address(0)) continue;
                uint256 reward;
                if (refTotalGross == refTotalNet) {
                    reward = (baseReward * rateBp) / 10000;
                } else {
                    // Scale by net/gross to cap the referral outflow while
                    // preserving relative ratios.
                    uint256 grossLvl = (baseReward * rateBp) / 10000;
                    reward = (grossLvl * refTotalNet) / refTotalGross;
                }
                if (reward == 0) continue;
                if (refPaid + reward > refTotalNet) {
                    reward = refTotalNet - refPaid;
                }
                if (reward == 0) break;

                ICfoToken(cfoToken).mint(ancestor, reward);
                totalReferralDistributed += reward;
                refPaid += reward;
                emit ReferralReward(ancestor, trader, reward, lvl + 1);
            }
        }
    }

    /// @notice Claim all vested (released) rewards.
    /// @dev Released amounts are computed linearly per daily bucket;
    /// matured buckets are amortized and cleaned during this call.
    function claim() external nonReentrant returns (uint256 cfoOut) {
        cfoOut = VestingAccumulator.settleClaim(userAcc[msg.sender], VESTING_DURATION);
        require(cfoOut > 0, "Mining: nothing to claim");

        SafeERC20.safeTransfer(IERC20(cfoToken), msg.sender, cfoOut);

        emit Claimed(msg.sender, cfoOut);
        return cfoOut;
    }

    /// @notice View the current claimable amount for a user.
    function getClaimable(address user) external view returns (uint256) {
        return VestingAccumulator.claimable(userAcc[user], VESTING_DURATION);
    }

    /// @notice View the full vesting state for a user (frontend helper).
    function getVestingInfo(address user) external view returns (
        uint256 totalAllocated,
        uint256 totalClaimed,
        uint256 releasedNow,
        uint256 claimableNow
    ) {
        return VestingAccumulator.info(userAcc[user], VESTING_DURATION);
    }

    // ====== Internal: reward accrual ======

    /// @dev Credit a trader reward. Same-UTC-day rewards merge into one
    /// daily bucket that vests linearly from that day's 00:00 UTC.
    function _addReward(address user, uint256 amount) internal {
        VestingAccumulator.addReward(userAcc[user], amount);
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(token != cfoToken, "Mining: cannot rescue CFO");
        require(to != address(0), "Mining: zero to");
        require(amount > 0, "Mining: zero amount");
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(amount <= bal, "Mining: insufficient balance");
        SafeERC20.safeTransfer(IERC20(token), to, amount);
        emit TokensRescued(token, to, amount);
    }
}
