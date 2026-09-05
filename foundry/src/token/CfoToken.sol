// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPancakeRouter02 {
    function factory() external view returns (address);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory);
}

interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

contract CfoToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR       = 10000;
    uint256 public constant MAX_SUPPLY            = 1_000_000_000 * 10**18;
    uint256 public constant MAX_TAX_BP            = 100;
    uint256 public constant TIMELOCK_DURATION     = 7 days;

    uint256 public taxRate = 100;
    bool    public taxEnabled = true;

    mapping(address => bool) public isPair;

    address public mainMiningContract;

    mapping(address => uint256) public minterQuota;
    mapping(address => bool)    public wasMinter;
    uint256 public totalQuotaAllocated;

    struct NextStageProposal {
        address targetMinter;
        uint256 totalAmount;
        bytes   data;
        uint256 proposeTime;
        bool    exists;
    }
    NextStageProposal public nextProposal;

    address[3]  public teamWallets;
    uint256[3]  public teamShares = [uint256(4000), 3000, 3000];

    IPancakeRouter02 public pancakeRouter;
    address public USDT;
    address public WBNB;

    // Lazy cache for tax-exit pair addresses. Pancake V2 pairs are created
    // deterministically by the factory and are immutable, so a non-zero address
    // is cached on first lookup, saving two getPair cross-contract calls per tax
    // swap. A zero result (pair not created yet) is not cached; the next
    // transaction fills it in automatically once the pool exists.
    address private _cachedPairUsdt;
    address private _cachedPairWbnb;

    bool private _inSwapAndDistribute;

    event TaxRateChanged(uint256 oldBp, uint256 newBp);
    event TaxEnabledChanged(bool enabled);
    event TaxDistributed(uint256 amountCFO, uint256 amountUSDT);
    event PairSet(address pair, bool isPair);
    event MainMiningContractSet(address indexed oldAddr, address indexed newAddr);
    event MinterQuotaGranted(address indexed minter, uint256 totalAdded, uint256 newRemaining, uint256 totalAllocated);
    event MinterQuotaRevoked(address indexed minter, uint256 remainingReturned, uint256 totalAllocated);
    event NextStageProposed(address indexed targetMinter, uint256 amount, uint256 proposeTime);
    event NextStageExecuted(address indexed targetMinter, uint256 amount);
    event NextStageCancelled(address indexed targetMinter, uint256 amount);
    event TeamDistributionSet();
    event PancakeParamsSet();
    event Rescue(address token, uint256 amount, address to);

    modifier onlyMinter() {
        require(minterQuota[msg.sender] > 0, "CFO: not minter or no quota left");
        _;
    }

    modifier lockTheSwap() {
        _inSwapAndDistribute = true;
        _;
        _inSwapAndDistribute = false;
    }

    constructor() ERC20("Cfoswap Token", "CFO") Ownable(msg.sender) {

    }

    function setTaxRate(uint256 bp) external onlyOwner {
        require(bp <= MAX_TAX_BP, "CFO: tax exceeds 1% cap");
        uint256 old = taxRate;
        taxRate = bp;
        emit TaxRateChanged(old, bp);
    }

    function setTaxEnabled(bool v) external onlyOwner {
        taxEnabled = v;
        emit TaxEnabledChanged(v);
    }

    function setIsPair(address pair, bool v) external onlyOwner {
        require(pair != address(0), "CFO: zero pair");
        if (v) {
            uint256 cs; assembly { cs := extcodesize(pair) }
            require(cs > 0, "CFO: not a contract");
            (bool ok, ) = pair.staticcall(abi.encodeWithSelector(0x0902f1ac));
            require(ok, "CFO: not a valid LP Pair");
        }
        isPair[pair] = v;
        emit PairSet(pair, v);
    }

    function setMainMiningContract(address _m) external onlyOwner {
        require(_m != address(0), "CFO: zero mining addr");
        uint256 cs; assembly { cs := extcodesize(_m) }
        require(cs > 0, "CFO: not a contract");
        address old = mainMiningContract;
        mainMiningContract = _m;
        emit MainMiningContractSet(old, _m);
    }

    function grantMinterQuota(address minter, uint256 addAmount) external onlyOwner {
        require(minter != address(0), "CFO: zero minter");
        require(addAmount > 0, "CFO: zero add");
        require(totalSupply() + totalQuotaAllocated + addAmount <= MAX_SUPPLY, "CFO: exceeds global MAX_SUPPLY cap");
        minterQuota[minter] += addAmount;
        totalQuotaAllocated += addAmount;
        wasMinter[minter] = true;
        emit MinterQuotaGranted(minter, addAmount, minterQuota[minter], totalQuotaAllocated);
    }

    function revokeMinterQuota(address minter) external onlyOwner {
        require(minter != address(0), "CFO: zero minter");
        uint256 returned = minterQuota[minter];
        minterQuota[minter] = 0;
        if (returned > 0) {
            totalQuotaAllocated -= returned;
        }
        emit MinterQuotaRevoked(minter, returned, totalQuotaAllocated);
    }

    function proposeActivateNextStage(
        uint256 totalAmount,
        address targetMinter,
        bytes calldata
    ) external onlyOwner {
        require(!nextProposal.exists, "CFO: proposal pending");
        require(targetMinter != address(0), "CFO: zero minter");
        require(totalAmount > 0, "CFO: zero amount");
        require(totalSupply() + totalQuotaAllocated + totalAmount <= MAX_SUPPLY, "CFO: exceeds MAX_SUPPLY");
        nextProposal = NextStageProposal({
            targetMinter: targetMinter,
            totalAmount:  totalAmount,
            data:         "",
            proposeTime:  block.timestamp,
            exists:       true
        });
        emit NextStageProposed(targetMinter, totalAmount, block.timestamp);
    }

    function executeActivateNextStage() external {
        require(nextProposal.exists, "CFO: no proposal");
        require(
            block.timestamp >= nextProposal.proposeTime + TIMELOCK_DURATION,
            "CFO: timelock not met"
        );
        NextStageProposal memory p = nextProposal;
        delete nextProposal;
        require(totalSupply() + totalQuotaAllocated + p.totalAmount <= MAX_SUPPLY, "CFO: exceeds MAX_SUPPLY");
        minterQuota[p.targetMinter] += p.totalAmount;
        totalQuotaAllocated += p.totalAmount;
        wasMinter[p.targetMinter] = true;
        emit MinterQuotaGranted(p.targetMinter, p.totalAmount, minterQuota[p.targetMinter], totalQuotaAllocated);
        emit NextStageExecuted(p.targetMinter, p.totalAmount);
    }

    function cancelActivateNextStage() external onlyOwner {
        require(nextProposal.exists, "CFO: no proposal");
        NextStageProposal memory p = nextProposal;
        delete nextProposal;
        emit NextStageCancelled(p.targetMinter, p.totalAmount);
    }

    function setTeamDistribution(
        address[3] calldata wallets,
        uint256[3] calldata shares
    ) external onlyOwner {
        uint256 total;
        for (uint256 i = 0; i < 3; i++) {
            require(wallets[i] != address(0), "CFO: zero team wallet");
            total += shares[i];
        }
        require(total == BPS_DENOMINATOR, "CFO: shares sum != 10000");
        teamWallets = wallets;
        teamShares  = shares;
        emit TeamDistributionSet();
    }

    function setPancakeParams(address _r, address _usdt, address _wbnb) external onlyOwner {
        require(_r != address(0) && _usdt != address(0) && _wbnb != address(0), "CFO: zero address");
        pancakeRouter = IPancakeRouter02(_r);
        USDT = _usdt;
        WBNB = _wbnb;
        // A router change may imply a factory change; invalidate cached pairs.
        _cachedPairUsdt = address(0);
        _cachedPairWbnb = address(0);
        emit PancakeParamsSet();
    }

    function mint(address to, uint256 amount) external onlyMinter {
        require(to != address(0), "CFO: mint to zero");
        require(amount > 0, "CFO: zero mint");
        require(amount <= minterQuota[msg.sender], "CFO: mint exceeds quota");
        require(totalSupply() + amount <= MAX_SUPPLY, "CFO: mint exceeds MAX_SUPPLY");
        minterQuota[msg.sender] -= amount;
        totalQuotaAllocated -= amount;
        _mint(to, amount);
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(this), "CFO: cannot rescue CFO itself");
        require(token != address(0),    "CFO: use rescueETH for ETH");
        require(to != address(0),       "CFO: zero to");
        require(amount > 0,             "CFO: zero amount");
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(amount <= bal,          "CFO: insufficient balance");
        IERC20(token).safeTransfer(to, amount);
        emit Rescue(token, amount, to);
    }

    function _update(address from, address to, uint256 value) internal override {

        if (from == address(0)) {
            require(totalSupply() + value <= MAX_SUPPLY, "CFO: exceeds MAX_SUPPLY");
        }
        if (value == 0) { super._update(from, to, value); return; }

        bool mmcNonZero = (mainMiningContract != address(0));
        bool fromExempt = (from == address(this)) || (mmcNonZero && from == mainMiningContract);
        bool toExempt   = (to   == address(this)) || (mmcNonZero && to   == mainMiningContract);
        if (!taxEnabled || fromExempt || toExempt) {
            super._update(from, to, value);
            return;
        }

        bool involvesPair = isPair[from] || isPair[to];
        if (!involvesPair) {
            super._update(from, to, value);
            return;
        }

        uint256 tax = (value * taxRate) / BPS_DENOMINATOR;
        uint256 sendAmount = value - tax;

        super._update(from, to, sendAmount);
        if (tax > 0) {
            super._update(from, address(this), tax);
            // Dual-pool adaptive exit: the pool the user trades on is never the
            // same pool the tax exits through (see autoDistribute), so the tax is
            // sold for USDT and distributed within this same transaction — no
            // accumulation, no threshold. The self-call fails silently on extreme
            // slippage or a missing exit pool; the tax stays in the contract and is
            // sold later by a subsequent transaction or by swapAccumulatedTax(),
            // never blocking the user's transfer.
            if (!_inSwapAndDistribute && _distributeParamsReady()) {
                address touchedPair = isPair[from] ? from : to;
                try this.autoDistribute(touchedPair) {} catch {}
            }
        }
    }

    function _distributeParamsReady() internal view returns (bool) {
        return address(pancakeRouter) != address(0)
            && USDT != address(0)
            && WBNB != address(0)
            && teamWallets[0] != address(0)
            && teamWallets[1] != address(0)
            && teamWallets[2] != address(0);
    }

    function estimateTaxValueUsdt18View() external view returns (uint256) {
        uint256 cfoBal = balanceOf(address(this));
        if (cfoBal == 0 || address(pancakeRouter) == address(0) || USDT == address(0) || WBNB == address(0)) return 0;
        (, uint256 est) = _estimateBestPath(cfoBal);
        return est;
    }

    /// @dev Lazily load the two tax-exit pair addresses (cache non-zero only).
    function _taxPairs() internal returns (address pairUsdt, address pairWbnb) {
        pairUsdt = _cachedPairUsdt;
        pairWbnb = _cachedPairWbnb;
        if (pairUsdt == address(0) || pairWbnb == address(0)) {
            address factory = pancakeRouter.factory();
            if (pairUsdt == address(0)) {
                pairUsdt = IPancakeFactory(factory).getPair(address(this), USDT);
                if (pairUsdt != address(0)) _cachedPairUsdt = pairUsdt;
            }
            if (pairWbnb == address(0)) {
                pairWbnb = IPancakeFactory(factory).getPair(address(this), WBNB);
                if (pairWbnb != address(0)) _cachedPairWbnb = pairWbnb;
            }
        }
    }

    /// @dev Top up router allowance on demand: the canonical PancakeV2 Router is
    /// trusted, so approve max once when allowance is insufficient; afterwards it
    /// is only consumed by use, with no further storage writes.
    function _ensureRouterAllowance(uint256 needed) internal {
        if (IERC20(address(this)).allowance(address(this), address(pancakeRouter)) < needed) {
            _approve(address(this), address(pancakeRouter), type(uint256).max);
        }
    }

    /// @notice Self-call entry point for the auto-sell triggered inside the
    /// transfer hook (callable only by the contract itself).
    /// @dev Rule: the tax-exit pool must differ from the pool the user is trading
    /// on, otherwise the swap hits the pair lock / reserve check.
    ///   - User trades on the CFO/USDT pool -> tax routes CFO->WBNB->USDT
    ///     (3 hops, exiting through the CFO/WBNB pool);
    ///   - User trades on the CFO/WBNB pool -> tax routes CFO->USDT directly
    ///     (exiting through the CFO/USDT pool).
    /// Both pair addresses are queried from the Pancake factory and cached; no
    /// manual registration is required.
    function autoDistribute(address touchedPair) external lockTheSwap {
        require(msg.sender == address(this), "CFO: self only");
        uint256 tokenAmount = balanceOf(address(this));
        if (tokenAmount == 0 || !_distributeParamsReady()) return;

        (address pairUsdt, address pairWbnb) = _taxPairs();

        bool viaWbnb;
        uint256 expectedOut;
        if (touchedPair == pairUsdt) {
            viaWbnb = true;                 // Trading on the USDT pool: exit 3-hop via the WBNB pool
        } else if (touchedPair == pairWbnb) {
            viaWbnb = false;                // Trading on the WBNB pool: exit directly via the USDT pool
        } else {
            address[] memory best;
            (best, expectedOut) = _estimateBestPath(tokenAmount);
            viaWbnb = (best.length == 3);   // Other registered pairs: pick the route with the better quote
        }
        _swapAndDistribute(tokenAmount, viaWbnb, expectedOut);
    }

    /// @dev Fallback entry point: anyone can manually sell residual tax CFO held
    /// by the contract in a standalone transaction (odd leftovers from silent
    /// auto-sell failures under extreme market conditions). Auto-selects the route
    /// with the better quote; USDT proceeds go only to teamWallets.
    function swapAccumulatedTax() external lockTheSwap {
        uint256 tokenAmount = balanceOf(address(this));
        require(tokenAmount > 0, "CFO: no tax balance");
        require(_distributeParamsReady(), "CFO: pancake/team params unset");
        (address[] memory best, uint256 bestOut) = _estimateBestPath(tokenAmount);
        _swapAndDistribute(tokenAmount, best.length == 3, bestOut);
    }

    /// @dev Pick the better swap route for distributing tax CFO into USDT.
    /// Tries the direct CFO->USDT pool (2 hops) and the CFO->WBNB->USDT route (3 hops),
    /// returns the path with the larger expected USDT output. Both are tried with
    /// try/catch so a missing/illiquid pool does not abort the estimate.
    function _estimateBestPath(uint256 cfoAmount) internal view returns (address[] memory bestPath, uint256 bestOut) {
        // Direct route: CFO -> USDT (2 hops)
        address[] memory pDirect = new address[](2);
        pDirect[0] = address(this);
        pDirect[1] = USDT;
        uint256 outDirect = 0;
        try pancakeRouter.getAmountsOut(cfoAmount, pDirect) returns (uint256[] memory r) {
            if (r.length >= 2) outDirect = r[r.length - 1];
        } catch {}

        // Indirect route: CFO -> WBNB -> USDT (3 hops)
        address[] memory pWbnb = new address[](3);
        pWbnb[0] = address(this);
        pWbnb[1] = WBNB;
        pWbnb[2] = USDT;
        uint256 outWbnb = 0;
        try pancakeRouter.getAmountsOut(cfoAmount, pWbnb) returns (uint256[] memory r) {
            if (r.length >= 3) outWbnb = r[r.length - 1];
        } catch {}

        // Choose the route that yields more USDT; fall back to the WBNB route.
        if (outDirect > 0 && outDirect >= outWbnb) {
            return (pDirect, outDirect);
        }
        return (pWbnb, outWbnb);
    }

    /// @dev Sell tax CFO for USDT and distribute by teamShares. Two routes:
    /// Direct (CFO->USDT): the recipient cannot be this contract — CFO is a token
    /// of that pool, so PancakePair.swap would revert with INVALID_TO; instead
    /// sell in three proportional swaps directly to each team wallet (EOA).
    /// 3-hop (CFO->WBNB->USDT): the last hop is the WBNB/USDT pool, which does not
    /// contain this token, so the recipient may be this contract; sell the whole
    /// amount in one swap and then split proportionally to the three wallets,
    /// saving two swap fees.
    /// expectedOut is the caller's pre-quoted USDT estimate for the full amount
    /// (produced during route comparison); when 0, this function quotes the full
    /// amount once on the chosen route. Callers: autoDistribute (inside the hook,
    /// reverts swallowed by try/catch) and swapAccumulatedTax (standalone
    /// transaction, reverts surfaced directly to the caller).
    function _swapAndDistribute(uint256 tokenAmount, bool viaWbnbRoute, uint256 expectedOut) private {
        _ensureRouterAllowance(tokenAmount);

        if (viaWbnbRoute) {
            address[] memory pathWbnb = new address[](3);
            pathWbnb[0] = address(this);
            pathWbnb[1] = WBNB;
            pathWbnb[2] = USDT;

            if (expectedOut == 0) {
                uint256[] memory est = pancakeRouter.getAmountsOut(tokenAmount, pathWbnb);
                expectedOut = est[est.length - 1];
            }
            uint256 minOut = (expectedOut * 90) / 100;

            uint256 before = IERC20(USDT).balanceOf(address(this));
            pancakeRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                tokenAmount, minOut, pathWbnb, address(this), block.timestamp + 300
            );
            uint256 got = IERC20(USDT).balanceOf(address(this)) - before;
            require(got > 0, "CFO: swap returned no USDT");

            uint256 sent;
            for (uint256 i = 0; i < 3; i++) {
                // Last portion takes the remainder to avoid dust USDT from rounding
                uint256 portion = (i == 2) ? (got - sent) : ((got * teamShares[i]) / BPS_DENOMINATOR);
                sent += portion;
                IERC20(USDT).safeTransfer(teamWallets[i], portion);
            }
            emit TaxDistributed(tokenAmount, got);
            return;
        }

        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = USDT;

        // Quote the full amount once; derive each portion's minOut by share.
        // Split swaps incur no more slippage than selling the whole amount at
        // once, so the proportional values are conservative and the 10% tolerance
        // is sufficient anti-sandwich protection.
        if (expectedOut == 0) {
            uint256[] memory est = pancakeRouter.getAmountsOut(tokenAmount, path);
            expectedOut = est[est.length - 1];
        }

        uint256 totalUsdt;
        uint256 soldCfo;
        for (uint256 i = 0; i < 3; i++) {
            // Last portion takes the remainder to avoid dust tax CFO from rounding
            uint256 portion = (i == 2) ? (tokenAmount - soldCfo)
                                       : ((tokenAmount * teamShares[i]) / BPS_DENOMINATOR);
            if (portion == 0) continue;
            soldCfo += portion;

            uint256 minOut = (expectedOut * portion * 90) / (tokenAmount * 100);

            uint256 before = IERC20(USDT).balanceOf(teamWallets[i]);
            pancakeRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                portion, minOut, path, teamWallets[i], block.timestamp + 300
            );
            uint256 got = IERC20(USDT).balanceOf(teamWallets[i]) - before;
            require(got > 0, "CFO: swap returned no USDT");
            totalUsdt += got;
        }
        emit TaxDistributed(tokenAmount, totalUsdt);
    }

    receive() external payable {}
}
