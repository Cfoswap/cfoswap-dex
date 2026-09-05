# CFOSWAP Whitepaper

**Version v1.1 · 2026-09-05 · BNB Smart Chain (BSC)**

> All mechanisms, parameters, and contract addresses in this whitepaper are grounded in the deployed, open-source smart contracts.

---

## Abstract

CFOSWAP is the **world's first decentralized trading protocol to integrate trade mining directly into a DEX aggregation router**, deployed on BNB Smart Chain. The protocol consists of two layers: (1) the **CfoRouter** aggregation router, which combines multiple DEX routing strategies to find the best quote for traders and charges a platform fee via immediate single-side deduction; (2) the **CFO token and mining system** — a fixed supply of 1 billion tokens with no pre-mine, of which 100 million are released linearly through trade mining and 900 million are locked and activatable only via multisig plus a Timelock public-notice period. The protocol also provides user-created mining pools and automated tax-token distribution. All contracts are verified open-source on Sourcify; the core router is non-upgradeable, and ownership is ultimately transferred to a Gnosis Safe multisig.

---

## 1. Overview

### 1.1 Background and Positioning

DEX aggregators on BSC solve the problem of "which route gives the best price," but ordinary traders rarely benefit from the growth of platform trading volume. As the **world's first trade-mining aggregator**, CFOSWAP returns the value created by platform growth to traders in an **on-chain, verifiable** way:

- Every trade through CfoRouter is recorded on-chain as trading volume;
- Volume is denominated in stablecoin terms and converted into CFO token rewards;
- Rewards vest linearly to prevent one-off dumping;
- Trading is mining — no staking and no lock-up required; traders earn automatically in the normal course of swapping.

### 1.2 Protocol Components

| Module | Contract | Responsibility |
|---|---|---|
| Token | CfoToken | ERC20, fixed 1 billion supply, transaction tax |
| Trade mining | CfoMining | Volume conversion, linear reward vesting |
| User pools | CfoMiningPoolFactory + CfoMiningPool | User-created pools, enrollment, per-pool rewards |
| Aggregation router | CfoRouter | Best routing, single-side fee deduction, gas floor |
| Router libraries | CfoDagRouter / CfoSmartRouter / CfoWrapRouter / CfoUnxRouter / CfoUnxV3Router | 5 routing strategies, linked at compile time |

---

## 2. Aggregation Router

### 2.1 Multi-Strategy Routing

CfoRouter attempts multiple routing strategies within a single trade and takes the best quote:

- **CfoDagRouter**: directed-acyclic-graph routing covering multi-hop path combinations;
- **CfoSmartRouter**: smart splitting and path selection;
- **CfoWrapRouter**: native coin (BNB) and WBNB wrapping, direct stablecoin swaps;
- **CfoUnxRouter / CfoUnxV3Router**: Uniswap V2-style pools and V3 concentrated-liquidity pools.

The library addresses are hardcoded and linked into CfoRouter at compile time. **CfoRouter has no proxy contract and is non-upgradeable** — its behavior is deterministic once deployed.

### 2.2 Platform Fee

- **Immediate single-side deduction**: the fee is deducted directly from the user's input side and does not interfere with quote logic;
- Default fee rate: **0.15% (15 bp)**;
- Hard cap: **3% (300 bp)** — enforced in-contract by `MAX_PLATFORM_FEE_BP = 300`; the owner may only adjust within the ≤3% range;
- Fee revenue can be split among up to 3 recipient addresses; the shares must sum to exactly 100%.

### 2.3 Gas Floor and Silent-Failure Prevention

After the swap, the aggregated transaction must also notify the mining contract and the pool factory. If gas is insufficient, downstream notifications are silently skipped, producing "trade succeeded but no reward." CfoRouter therefore enforces a **dynamic gas floor**:

```
gas floor = BASE_GAS + active_pool_count × PER_POOL_GAS
```

Calibrated by GasProfile tests (worst case: 10 cold pools):

- Mining notification budget: 800,000 gas;
- Factory notification: 200,000 base + 560,000 per pool;
- Worst-case floor for 10 enrolled pools: ~6.75M gas;
- Transactions below the floor revert outright instead of silently swallowing rewards.

The tests also include a **delivery assertion**: beyond checking the budget size, they assert that every pool actually paid out a reward — preventing the case where budget numbers look right while all sub-calls burn out-of-gas and are skipped.

---

## 3. CFO Tokenomics

### 3.1 Key Parameters

| Parameter | Value | Contract basis |
|---|---|---|
| Token name | Cfoswap Token (symbol: CFO) | CfoToken constructor |
| Decimals | 18 | ERC20 |
| Total supply | **1,000,000,000 CFO (1 billion, fixed)** | `MAX_SUPPLY = 1_000_000_000 × 10^18` |
| Pre-mine | **None** | — |
| Transaction tax cap | **1% (100 bp)**, adjustable only within ≤1% | `MAX_TAX_BP = 100` |
| Initial tax rate | 1% | `taxRate = 100` |

### 3.2 Supply Structure (only contractually determined parts)

| Portion | Amount | Release / activation |
|---|---|---|
| Trade-mining emission | **100,000,000 CFO (100 million)** | Stage1 cap 10 million + Stage2 cap 90 million; minted by CfoMining per trade mining; contract hard caps guarantee at most 100 million minted |
| Locked portion | **900,000,000 CFO (900 million)** | Locked; activation requires an **external multisig wallet (Gnosis Safe) plus a Timelock public-notice period** |

> Beyond these two portions, this whitepaper defines no team/ecosystem/marketing allocation. Any future allocation must be executed by an on-chain transaction after multisig approval and Timelock public notice, and is verifiable on-chain.

Two-layer hard-cap protection: the stage caps inside CfoMining guarantee at most 100 million tokens are minted for mining, while `MAX_SUPPLY` inside CfoToken guarantees the global total never exceeds 1 billion. The mint quota granted to the mining contract equals Stage1 + Stage2 = 100 million; an insufficient quota reverts when exhausted, and even an over-grant cannot cause over-issuance.

### 3.3 Transaction Tax Mechanism

- Transfers of CFO incur a transaction tax (rate ≤1%); proceeds are distributed to team/operations multisig wallets;
- There are 3 tax wallets with on-chain split ratios of 40% / 30% / 30% (readable via `teamWallets` / `teamShares`);
- Tax-token selling supports **PancakeSwap V2** semantics only; V3 pools cause tax deduction failures/leakage, so CFO liquidity is placed on V2 only;
- **Dual-pool requirement**: both the CFO/USDT and CFO/WBNB V2 pools must exist and be registered; with a single pool, auto-selling silently skips due to insufficient routing;
- Initial liquidity must be fully injected **before** registering the tax pools, so the injection itself is not taxed 1%;
- The initial prices of the two pools must be consistent (the WBNB pool priced by the BNB/USDT market rate at injection) to prevent arbitrage;
- Adding or removing liquidity after registration also incurs the 1% tax (by design).

After tax tokens arrive, the contract swaps them (automatically or manually) to USDT and distributes to the tax wallets, with slippage protection at 90% of expected output.

---

## 4. Trade Mining

### 4.1 Volume Conversion

- Only trades involving a **stablecoin leg** (USDT / USDC / BUSD / USDD / TUSD / DAI) are converted into volume;
- Token/token trades (including BNB) count as zero volume — there is no trustworthy USD denomination for them;
- 6-decimal stablecoins are uniformly scaled to 18-decimal precision;
- No manual price feeds are used in routing (the hardcoded BNB price has been permanently removed, and the Chainlink oracle plan was canceled); the stablecoin leg is denominated directly.

### 4.2 Reward Vesting (Linear)

- Each reward vests linearly over **365 days** starting at **00:00 UTC of the trade day** (`VESTING_DURATION = 31,536,000` seconds);
- Multiple trades on the same day merge into a single daily bucket and do not accelerate each other;
- Multiple rewards vest independently — a new reward never unlocks an older one early;
- A tiny fraction is claimable on the trade day itself (~0.27% on the 365-day schedule), which is user-favorable;
- Matured buckets are amortized and pruned on claim; claims never get stuck (verified under heavy-history stress tests);
- Conservation: lifetime claims equal lifetime allocations, asserted by tests.

### 4.3 Mining Opt-Out Switch

- Users may opt out of trade mining; after opting out, **their own trades no longer generate rewards**;
- The switch defaults to participating and can be toggled at any time;
- Opting out affects only the user's own trade rewards and no other mechanism.

---

## 5. User-Created Mining Pools

### 5.1 Pool Creation

- Anyone can create a pool via CfoMiningPoolFactory (e.g., a community pool);
- Creation burn fee `CREATE_POOL_FEE`: source default 1,000 CFO; in production the owner sets it to 10 CFO, burned to 0x…dEaD; setting it to 0 disables the fee;
- Pool types:
  - **mode=1 pair pool**: bound to an LP pair; token0/token1 are read automatically with no owner registration needed; trades whose path matches the pair earn rewards;
  - **mode=0 shared-reward pool**: rewards paid from a shared budget;
- Reward token, reward-per-volume, vesting duration (e.g., 365 days) are set at creation.

### 5.2 Enrollment and Participant Count

- After a user enrolls, only their matching trades are notified to that pool for rewards;
- Each pool tracks **`enrolledCount` (current participant count)** on-chain: +1 on enroll, −1 on unenroll;
- Double enroll / double unenroll are blocked by `AlreadyEnrolled` / `NotEnrolled` reverts, making count drift impossible;
- Enrollment cap: **10 pools per trader** (`MAX_ENROLLED_POOLS = 10`), bounding per-trade gas; the 11th enrollment reverts, and unenrolling frees a slot;
- The factory maintains two rosters:
  - **History roster** (append-only): every pool ever enrolled in, used for batch claims; rewards earned before unenrolling remain claimable;
  - **Active roster**: currently enrolled pools only; swap notifications iterate only this list, and the router sizes its gas floor from it.

### 5.3 Notification Filtering and Gas Control

- Before onSwap notifications, the factory pre-filters locally: pools that are unenrolled or non-path-matching receive **no external call**;
- Each pool sub-call has an independent gas budget (`POOL_CALL_GAS = 550,000`) and a gasleft gate (`POOL_GATE_GAS = 600,000`);
- Skipped notifications emit events with reason codes (1 = gas gate, 2 = call failed) for off-chain monitoring;
- Batch claims (claimAll) iterate the history roster with a 150,000 gas budget per claim sub-call.

### 5.4 Boost Fee

- Creators/participants may pay a boost fee to increase a pool's weight, in the range 0.01–1 BNB (`BOOST_MIN/MAX_AMOUNT`);
- The boost fee recipient is set by the owner via `setBoostFeeRecipient`.

---

## 6. Security Model

### 6.1 Non-Upgradeability and Determinism

- **CfoRouter has no proxy and is non-upgradeable**; the 5 router libraries are linked at compile time, so behavior is deterministic after deployment;
- All 9 contracts are **verified open-source on Sourcify** (stdJsonInput format, viaIR + optimizer 200 + evmVersion london);
- Runtime bytecode is compared one-to-one against local forge artifacts (exact match after masking 11 library link slots in the router and 4 immutable sites in the mining contract).

### 6.2 Permission Governance

- All owner permissions are ultimately transferred to a **Gnosis Safe (Safe mode A) multisig wallet**;
- Activation of the 900 million locked tokens requires multisig plus a Timelock public-notice period;
- Tax/fee/boost recipient addresses are all readable and verifiable on-chain;
- Whitelisting: only authorized contracts such as Router and CfoMining can call the mining notification entries.

### 6.3 Silent-Failure Defenses

| Risk | Defense |
|---|---|
| Notifications skipped due to insufficient gas | Dynamic gas floor; under-floor transactions revert |
| try/catch swallowing sub-call failures | Skip events carry reason codes for off-chain monitoring |
| Single pool making tax-token sales impossible | Mandatory dual-pool requirement plus path checks |
| Participant count drift | Enroll/unenroll guards plus rollback consistency |
| Over-issuance | Two-layer hard caps (stage caps + MAX_SUPPLY) |
| Oracle manipulation | No manual price feeds / no Chainlink; stablecoin leg denominated directly |

### 6.4 Testing

- The Foundry suite of 38 test cases passes fully, including:
  - BSC mainnet fork tests (automatic tax distribution, fee-token swapping, pool notification filtering, opt-out);
  - Gas profiling tests (worst case: 10 cold pools);
  - Linear-vesting math precision and conservation tests;
  - Participant-count tests (enroll/unenroll/repeated actions/re-enrollment).
- Bytecode compliance: factory runtime size 24,098 bytes (EIP-170 limit 24,576).

---

## 7. Contract List

| Contract | Description | Upgradeable |
|---|---|---|
| CfoToken | ERC20 token, transaction tax | No (name fixed in constructor; rename requires redeploy) |
| CfoMining | Trade mining, linear vesting | No |
| CfoMiningPool | User-pool template (deployed via `new`, not clones) | No |
| CfoMiningPoolFactory | Pool factory, enrollment rosters | No |
| CfoRouter | Aggregation router main contract | **No, no proxy** |
| CfoDagRouter | DAG routing library | Library |
| CfoSmartRouter | Smart routing library | Library |
| CfoWrapRouter | Wrap/stablecoin routing library | Library |
| CfoUnxRouter | V2-style routing library | Library |
| CfoUnxV3Router | V3 routing library | Library |

> Deployment constraint: 6 contracts (5 router libraries + CfoRouter) must be deployed together in sequence, because CfoRouter hardcodes the 5 library addresses at compile time; CfoRouter cannot be deployed alone.

---

## 8. User Flows

**Traders**: select tokens in the aggregation UI → the router finds the best route automatically → sign the transaction (insufficient gas is rejected upfront) → the swap and mining accounting complete in the same transaction → rewards vest linearly over 365 days and can be claimed at any time. Trading is mining, with no staking required.

**Pool creators**: approve CFO → call createPoolV2 (burning 10 CFO) → deposit reward tokens → share the pool → users enroll → matching trades earn rewards.

---

## 9. Risk Disclosure

1. **Smart contract risk**: despite testing and open-source verification, undiscovered vulnerabilities may remain;
2. **Market risk**: CFO price and trading-volume volatility affect the fiat value of mining rewards;
3. **Liquidity risk**: the reward vesting period is long (365 days) and early liquidity depth is limited;
4. **Parameter changes**: tax rate (≤1%), platform fee (≤3%) and similar parameters may be adjusted by multisig within hard caps;
5. This whitepaper does not constitute investment advice.

---

*This whitepaper will be updated as the protocol iterates; the on-chain verified contracts remain the ultimate source of truth.*
