export const BSC_CHAIN_ID = 56;
export const BSC_CHAIN_ID_HEX = '0x38';

export const BSC_NETWORK = {
  chainId: BSC_CHAIN_ID_HEX,
  chainName: 'BNB Smart Chain Mainnet',
  nativeCurrency: {
    name: 'BNB',
    symbol: 'BNB',
    decimals: 18
  },
  rpcUrls: [
    'https://bsc-dataseed1.binance.org',
    'https://bsc-dataseed2.binance.org',
    'https://bsc-dataseed3.binance.org',
    'https://bsc-dataseed4.binance.org',
    'https://bsc-dataseed.binance.org',
    'https://1rpc.io/bnb',
    'https://bsc-rpc.publicnode.com',
    'https://bsc.publicnode.com',
    'https://binance.llamarpc.com',
    'https://bsc.blockpi.network/v1/rpc/public'
  ],
  blockExplorerUrls: ['https://bscscan.com']
};

// RPC list ordered by measured reliability/latency on BSC mainnet; multi-RPC fallback loops over this list
export const RPC_URLS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.nodereal.io',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org',
  'https://1rpc.io/bnb',
  'https://bsc.publicnode.com',
  'https://binance.llamarpc.com',
  'https://bsc.blockpi.network/v1/rpc/public',
];
export const RPC_URL = RPC_URLS[0];

// ====== Standard BSC constants (Pancake V2 / Uniswap V3 BSC / WBNB) ======
export const PANCAKE_SWAP_ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
export const PANCAKE_SWAP_FACTORY_V2 = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
// Uniswap V3 (official BSC deployment) Factory — corresponds to the router contract's
// ChainConfig._FF_FACTORY (0xdB1d…4461F7) and the uniswapV3SwapCallback; pools are verified by
// the contract callback via CREATE2(factory, token0, token1, fee, Uniswap V3 init code hash)
export const UNISWAP_V3_FACTORY = '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7';
// Official Uniswap V3 fee tiers (fee unit 1e-6): 0.01% / 0.05% / 0.3% / 1%
export const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000];

export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const ARK_ADDRESS = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
export const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
export const USDC_ADDRESS = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
export const DAI_ADDRESS = '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3';

// ====== New DexRouter system: native token / Permit2 placeholders ======
export const ETH_PLACEHOLDER = '0xEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeee';
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// MODE_* high-bit encoding aligns with Constants.sol's _TRANSFER_MODE_MASK = 0x0E00… (bits 253/251/249)
//   MODE_BY_INVEST = 0b010 → 0x0400… (first transferFrom(user→router), then transfer(router→pair), bypassing the tax-token pair whitelist)
//   MODE_LEGACY    = 0b000 → 0x0000…
//   Note: it is NOT "small number + <<160" — that only moves 0 to bit160 and can never reach bits 249~253
//   Tax tokens + non-whitelisted pairs (e.g. CAKE→USDC/ETH) require switching to MODE_BY_INVEST, usable only after the contract lifts the BY_INVEST & commission mutual exclusion
export const MODE_DIRECT = 0x0A00000000000000000000000000000000000000000000000000000000000000n; // MODE_DIRECT: transferFrom(user→pair), compatible with non-tax tokens + whitelisted tax-token pairs
export const MODE_LEGACY = 0x0000000000000000000000000000000000000000000000000000000000000000n;

export const BSC_DEX_FACTORIES = [
  PANCAKE_SWAP_FACTORY_V2,
];

// ====== On-chain business contract addresses (BSC mainnet, updated 2026-09-05) ======
export const ROUTER_ADDRESS = '0x42b65F80A1C6aB5766418e2222F19AB037F2c3DF';
export const MINING_ADDRESS = '0x297Dc646e0268aA2F2B8C9acaD9C12DcfdFf13F4';
export const CFO_TOKEN_ADDRESS = '0x0bDf9703DECEeBa6C1AB8E35F0F76B470D37519D';
export const MINING_POOL_FACTORY_ADDRESS = '0x98180D72bBF38F75E741BdcA65daaB45a6597AD4';

export const ASTE_ADDRESS = '0xe6367363e90126e5bd0dde928633727e4cff08b7';
// PancakeSwap V2 Factory (still used by the liquidity page; kept unchanged)
export const PANCAKE_FACTORY_ADDRESS = PANCAKE_SWAP_FACTORY_V2;
export const FACTORY_ADDRESS = PANCAKE_FACTORY_ADDRESS;
export const EIGHT_EIGHT_TOKEN_ADDRESS = CFO_TOKEN_ADDRESS;

export const TOKENS = {
  // Note: decimals is no longer hardcoded; read from on-chain decimals() at runtime (see utils.fetchDecimals),
  // persisted to walletStore.decimalsOverride, falls back to ERC20 standard 18.
  BNB: {
    symbol: 'BNB',
    name: 'BNB',
    address: '0x0000000000000000000000000000000000000000',
    logoURI: 'img/tokens/bnb.png',
    isNative: true
  },
  WBNB: {
    symbol: 'WBNB',
    name: 'Wrapped BNB',
    address: WBNB_ADDRESS,
    logoURI: 'img/tokens/wbnb.png',
    isNative: false
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    address: USDT_ADDRESS,
    logoURI: 'img/tokens/usdt.png',
    isNative: false
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    address: USDC_ADDRESS,
    logoURI: 'img/tokens/usdc.png',
    isNative: false
  },
  ETH: {
    symbol: 'ETH',
    name: 'Ethereum',
    address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    logoURI: 'img/tokens/eth.png',
    isNative: false
  },
  DAI: {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: DAI_ADDRESS,
    logoURI: 'img/tokens/dai.png',
    isNative: false
  },
  CAKE: {
    symbol: 'CAKE',
    name: 'PancakeSwap Token',
    address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    logoURI: 'img/tokens/cake.png',
    isNative: false
  },
  ARK: {
    symbol: 'ARK',
    name: 'Arkham',
    address: ARK_ADDRESS,
    logoURI: 'img/tokens/ark.png',
    isNative: false
  },
  BTCB: {
    symbol: 'BTCB',
    name: 'Bitcoin BEP2',
    address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    logoURI: 'img/tokens/btc.png',
    isNative: false
  },
  CFO: {
    symbol: 'CFO',
    name: 'Cfoswap Token',
    address: CFO_TOKEN_ADDRESS,
    logoURI: 'img/tokens/cfo.png?v=6',
    taxBps: 100,
    buyTaxBps: 100,
    sellTaxBps: 100,
    isNative: false
  },
  PRO: {
    symbol: 'PRO',
    name: 'ProBit Token',
    address: '0x8d65744527f55d0b2338350912d5c99a81ddf0e2',
    logoURI: 'img/tokens/pro.jpg',
    isNative: false
  },
  ASTE: {
    symbol: 'ASTE',
    name: 'Astral Ecology',
    address: ASTE_ADDRESS,
    logoURI: 'img/tokens/aste.png',
    isNative: false
  }
};

export const HOT_TOKENS = ['BNB', 'USDT', 'CFO', 'ASTE', 'ETH', 'CAKE', 'USDC', 'ARK', 'PRO'];

export const RELEASE_PERIOD_OPTIONS = [
  { value: 30, label: '30 Days' },
  { value: 90, label: '90 Days' },
  { value: 180, label: '180 Days' },
  { value: 365, label: '365 Days' },
];

export const BOOST_MIN_BNB = 0.01;
export const BOOST_MAX_BNB = 1;
export const MAX_BEHAVIOR_REWARD = 30;

export const TX_DEADLINE_MINUTES = 10;
export const DEFAULT_SLIPPAGE = 10;

// ====== New DexRouter ABI (entry functions from 0x5994_router/DexRouter.sol) ======
// All main entries: external payable nonReentrant whenNotPaused
export const ROUTER_ABI = [
  // === Platform / Owner read ===
  // Note: platformFeeBp is private in the contract with no getter, so the frontend assumes the default 15bp; WBNB is a contract constant with no getter
  'function isPaused() external view returns (bool)',
  // === 1) SmartSwapRouter: multi-batch aggregation ===
  'function smartSwapByOrderId(uint256 orderId, (uint256,address,uint256,uint256,uint256) baseRequest, uint256[] batchesAmount, (address[],address[],uint256[],bytes[],uint256)[][] batches, bytes[] pmmRequests) external payable returns (uint256 returnAmount)',
  'function smartSwapTo(uint256 orderId, address receiver, (uint256,address,uint256,uint256,uint256) baseRequest, uint256[] batchesAmount, (address[],address[],uint256[],bytes[],uint256)[][] batches, bytes[] pmmRequests) external payable returns (uint256 returnAmount)',
  // === 2) DagRouter: DAG multi-hop ===
  'function dagSwapByOrderId(uint256 orderId, (uint256,address,uint256,uint256,uint256) baseRequest, (address[],address[],uint256[],bytes[],uint256)[] paths) external payable returns (uint256 returnAmount)',
  'function dagSwapTo(uint256 orderId, address receiver, (uint256,address,uint256,uint256,uint256) baseRequest, (address[],address[],uint256[],bytes[],uint256)[] paths) external payable returns (uint256 returnAmount)',
  // === 3) UnxswapRouter: V2-style single-chain (pools = bytes32[]) ===
  'function unxswapByOrderId(uint256 srcToken, uint256 amount, uint256 minReturn, bytes32[] pools) external payable returns (uint256 returnAmount)',
  'function unxswapTo(uint256 srcToken, uint256 amount, uint256 minReturn, address receiver, bytes32[] pools) external payable returns (uint256 returnAmount)',
  'function unxswapToWithBaseRequest(uint256 orderId, address receiver, (uint256,address,uint256,uint256,uint256) baseRequest, bytes32[] pools) external payable returns (uint256 returnAmount)',
  // === 4) UnxswapV3Router: V3-style (pools = uint256[]) ===
  'function uniswapV3SwapTo(uint256 receiver, uint256 amount, uint256 minReturn, uint256[] pools) external payable returns (uint256 returnAmount)',
  'function uniswapV3SwapToWithBaseRequest(uint256 orderId, address receiver, (uint256,address,uint256,uint256,uint256) baseRequest, uint256[] pools) external payable returns (uint256 returnAmount)',
  'function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes data) external',
  // === 5) SwapWrapRouter: BNB ↔ WBNB ===
  'function swapWrap(uint256 orderId, uint256 rawdata) external payable',
  'function swapWrapToWithBaseRequest(uint256 orderId, address receiver, (uint256,address,uint256,uint256,uint256) baseRequest) external payable',
];

// ====== Pancake V2 Router ABI (still used by the liquidity page; the quote engine's getAmountsOut uses it too) ======
export const PANCAKE_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] amounts)',
  'function getAmountsIn(uint256 amountOut, address[] path) external view returns (uint256[] amounts)',
  'function factory() external view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external returns (uint256 amountToken, uint256 amountETH)',
  'function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external returns (uint256 amountETH)',
];

// ====== Uniswap V3 Pool ABI (needed for pure-frontend V3 quotes) ======
export const V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function factory() external view returns (address)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function tickSpacing() external view returns (int24)',
];

// ====== Uniswap V3 Factory ABI (pool address lookup = getPool(tokenA, tokenB, fee)) ======
export const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)'
];

export const CFO_TOKEN_ABI = [
  ...ERC20_ABI,
  // Constants
  'function BPS_DENOMINATOR() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function MAX_TAX_BP() view returns (uint256)',
  // Tax rate
  'function taxRate() view returns (uint256)',
  'function taxEnabled() view returns (bool)',
  'function setTaxRate(uint256 bp) external',
  'function setTaxEnabled(bool v) external',
  // Pair marker (taxable pair)
  'function isPair(address pair) view returns (bool)',
  'function setIsPair(address pair, bool v) external',
  // Tax-exempt address (main mining contract only)
  'function mainMiningContract() view returns (address)',
  'function setMainMiningContract(address _m) external',
  // Minter quota mechanism
  'function minterQuota(address minter) view returns (uint256)',
  'function wasMinter(address minter) view returns (bool)',
  'function totalQuotaAllocated() view returns (uint256)',
  'function grantMinterQuota(address minter, uint256 addAmount) external',
  'function revokeMinterQuota(address minter) external',
  'function mint(address to, uint256 amount) external',
  // Pancake parameters
  'function pancakeRouter() view returns (address)',
  'function USDT() view returns (address)',
  'function WBNB() view returns (address)',
  // Tax value estimation
  'function estimateTaxValueUsdt18View() view returns (uint256)',
  // Events
  'event TaxRateChanged(uint256 oldBp, uint256 newBp)',
  'event TaxEnabledChanged(bool enabled)',
  'event TaxDistributed(uint256 amountCFO, uint256 amountUSDT)',
  'event TaxSwapFailed(uint256 amountCFO)',
  'event PairSet(address pair, bool isPair)',
  'event MainMiningContractSet(address indexed oldAddr, address indexed newAddr)',
  'event MinterQuotaGranted(address indexed minter, uint256 totalAdded, uint256 newRemaining, uint256 totalAllocated)',
  'event MinterQuotaRevoked(address indexed minter, uint256 remainingReturned, uint256 totalAllocated)',
];

// ====== CfoSwapMining Official CFO Trading Mining Contract ABI ======
export const MINING_ABI = [
  // Claim rewards
  'function claim() external returns (uint256 cfoOut)',
  'function getClaimable(address user) external view returns (uint256)',
  // ====== CfoSwapMining daily-bucket linear vesting (O(1) claim model) ======
  // Returns: totalAllocated, totalClaimed, releasedToDate(cumulative), claimableNow
  'function getVestingInfo(address user) external view returns (uint256 totalAllocated, uint256 totalClaimed, uint256 releasedNow, uint256 claimableNow)',
  // User trade-mining opt-out switch: default false (participating). true = quit.
  'function miningOptOut(address user) external view returns (bool)',
  'function setMiningOptOut(bool optOut) external',
  // Referrer bindings live on the MiningPoolFactory (single source of truth)
  'function miningPoolFactory() external view returns (address)',
  // Contract parameter query
  'function cfoSwapToken() external view returns (address)',
  'function isAllowedCaller(address caller) external view returns (bool)',
  'function allowedCallers(uint256 index) external view returns (address)',
  'function allowedCallersCount() external view returns (uint256)',
  // Stage parameter query
  'function stage1Cap() external view returns (uint256)',
  'function stage1Rate() external view returns (uint256)',
  'function stage2Cap() external view returns (uint256)',
  'function stage2Rate() external view returns (uint256)',
  'function totalMintedStage1() external view returns (uint256)',
  'function totalMintedStage2() external view returns (uint256)',
  'function VESTING_DURATION() external view returns (uint256)',
  // Referral parameters (8-level bps array; getter takes level index)
  'function referralRateBp(uint256 level) external view returns (uint256)',
  'function REF_BPS_LIMIT() external view returns (uint256)',
  'function totalReferralDistributed() external view returns (uint256)',
  // Events
  'event Claimed(address indexed user, uint256 amount)',
  'event SwapRecorded(address indexed trader, uint256 volumeUSDT18, uint256 reward, uint256 stage)',
  'event ReferralReward(address indexed referrer, address indexed trader, uint256 amount, uint256 level)',
  'event ReferrerBound(address indexed trader, address indexed referrer)',
  'event CfoSwapTokenSet(address indexed token)',
  'event CallerAdded(address indexed caller)',
  'event CallerRemoved(address indexed caller)',
];

export const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
  'function allPairs(uint) external view returns (address pair)',
  'function allPairsLength() external view returns (uint)'
];

export const PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function factory() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() external view returns (uint)',
  'function balanceOf(address owner) external view returns (uint)',
  'function approve(address spender, uint value) external returns (bool)'
];

export const POOL_ABI = PAIR_ABI;

// ====== MiningPool Single Pool Contract (user-created pool) ABI ======
export const MINING_POOL_ABI = [
  // Deposit rewards (pool creator only)
  'function depositReward(uint256 amount) external',
  // Enroll / Unenroll
  'function enroll() external',
  'function unenroll() external',
  'function enrolledTraders(address user) external view returns (bool)',
  // On-chain participant counter (new pool template): enroll +1 / unenroll -1
  'function enrolledCount() external view returns (uint256)',
  // Claim rewards
  'function claim() external returns (uint256)',
  'function claimFor(address user) external returns (uint256)',
  'function getClaimable(address user) external view returns (uint256)',
  // Daily-bucket linear vesting: totalAllocated, totalClaimed, releasedToDate(cumulative), claimableNow
  'function getVestingInfo(address user) external view returns (uint256 totalAllocated, uint256 totalClaimed, uint256 releasedNow, uint256 claimableNow)',
  // Pool info query
  'function factory() external view returns (address)',
  'function poolOwner() external view returns (address)',
  'function name() external view returns (string)',
  'function rewardToken() external view returns (address)',
  'function totalReward() external view returns (uint256)',
  'function totalRewardRequired() external view returns (uint256)',
  'function mode() external view returns (uint8)',
  'function targetPair() external view returns (address)',
  'function vestingDuration() external view returns (uint256)',
  'function l1bp() external view returns (uint256)',
  'function l2bp() external view returns (uint256)',
  'function rewardPerUsd() external view returns (uint256)',
  'function isActivated() external view returns (bool)',
  'function isEnded() external view returns (bool)',
  'function isVerified() external view returns (bool)',
  'function _isDelisted() external view returns (bool)',
  'function depositedReward() external view returns (uint256)',
  'function distributedReward() external view returns (uint256)',
  'function distributedReferral() external view returns (uint256)',
  'function remainingReward() external view returns (uint256)',
  'function startTime() external view returns (uint256)',
  'function boostPaidTotal() external view returns (uint256)',
  // On-chain poolInfo() layout (verified against deployed pool 0xe349…A8D4 raw return):
  // 22 outputs — no remainingReferral; referralRateBp is a fixed uint256[8] inline at the tail.
  'function poolInfo() external view returns (string name_, address rewardToken_, uint256 totalReward_, uint256 totalRewardRequired_, uint256 depositedReward_, uint256 distributedReward_, uint256 distributedReferral_, uint256 remainingReward_, uint256 vestingDuration_, uint8 mode_, address targetPair_, bool isActivated_, bool isEnded_, bool isVerified_, bool isDelisted_, uint256 startTime_, uint256 boostPaidTotal_, address poolOwner_, uint256 rewardPerUsd_, uint256 l1bp_, uint256 l2bp_, uint256[8] referralRateBp_)',
  // Events
  'event RewardDeposited(address indexed owner, uint256 amount)',
  'event TraderEnrolled(address indexed trader)',
  'event TraderUnenrolled(address indexed trader)',
  'event SwapRecorded(address indexed trader, uint256 volumeUSDT18, uint256 reward)',
  'event ReferrerBound(address indexed trader, address indexed referrer)',
  'event ReferralReward(address indexed referrer, address indexed trader, uint256 amount, uint256 level)',
  'event Claimed(address indexed user, uint256 amount)',
  'event BoostPaid(uint256 paidTotal)',
  'event VerifiedSet(bool verified)',
  'event Delisted()',
];

// ====== MiningPoolFactory Mining Pool Factory Contract ABI (with one-click batch claim) ======
export const MINING_POOL_FACTORY_ABI = [
  // Read methods
  'function cfoToken() external view returns (address)',
  'function CREATE_POOL_FEE() external view returns (uint256)',
  'function boostFeeRecipient() external view returns (address)',
  'function isAllowedCaller(address caller) external view returns (bool)',
  'function allowedCallers(uint256 index) external view returns (address)',
  'function allowedCallersCount() external view returns (uint256)',
  'function getAllPools() external view returns (address[])',
  'function poolsCount() external view returns (uint256)',
  'function pools(uint256 index) external view returns (address)',
  'function isRegistered(address pool) external view returns (bool)',
  'function isDelisted(address pool) external view returns (bool)',
  'function getPairTokens(address pair) external view returns (address token0, address token1)',
  'function getDefaultReferralRates() external view returns (uint256[8])',
  'function getTraderPools(address trader) external view returns (address[] poolList, bool[] activeList)',
  // Platform-wide bind-once referral map (single source of truth for mining + pools)
  'function globalReferrerOf(address trader) external view returns (address)',
  // Write methods - user
  'function createPoolV2(string calldata name, address rewardToken, uint256 totalReward, uint256 rewardPerUsd, uint8 mode, address targetPair, uint8 vestingOption, uint256[8] calldata referralRateBpArr) external returns (address poolAddr)',
  'function boostPool(address pool) external payable',
  'function claimAllMyPools() external returns (uint256 poolsChecked, uint256 poolsClaimed, uint256 totalClaimedWei)',
  'function claimPools(address[] calldata poolList) external returns (uint256 poolsChecked, uint256 poolsClaimed, uint256 totalClaimedWei)',
  // Events
  'event PoolCreated(address indexed pool, address indexed owner, string name, address rewardToken)',
  'event Boosted(address indexed pool, address indexed payer, uint256 amount, uint256 newPaidTotal)',
  'event ClaimAllPools(address indexed user, uint256 poolsChecked, uint256 poolsClaimed, uint256 totalClaimedWei)',
  'event ClaimPools(address indexed user, uint256 poolsChecked, uint256 poolsClaimed, uint256 totalClaimedWei)',
  'event CreatePoolFeeSet(uint256 fee)',
  'event PoolDelisted(address indexed pool)',
  'event PoolVerifiedChanged(address indexed pool, bool verified)',
];

export const ABIS = {
  ROUTER_ABI,
  PANCAKE_ROUTER_ABI,
  V3_POOL_ABI,
  V3_FACTORY_ABI,
  ERC20_ABI,
  CFO_TOKEN_ABI,
  MINING_ABI,
  MINING_POOL_ABI,
  MINING_POOL_FACTORY_ABI,
  FACTORY_ABI,
  PAIR_ABI,
  POOL_ABI,
};

export const WALLET_OPTIONS = [
  { id: 'okx', name: 'OKX Wallet', desc: 'Recommended · Global', icon: 'img/wallets/okx.png', injected: true, injectedName: 'okxwallet' },
  { id: 'metamask', name: 'MetaMask', desc: 'Most Popular', icon: 'img/wallets/metamask.png', injected: true },
  { id: 'binance', name: 'Binance Chain Wallet', desc: 'Binance Wallet', icon: 'img/wallets/binance.png', injected: true },
];

export const EXPLORER_URL = 'https://bscscan.com';

export const SLIPPAGE_DEFAULT = 0.1;
