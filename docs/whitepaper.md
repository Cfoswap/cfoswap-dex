# CFOSWAP 白皮书 / CFOSWAP Whitepaper

**版本 v1.1 · 2026-09-05 · BNB Smart Chain (BSC)**

> 本白皮书中所有机制、参数、合约地址均以已部署/已审计的链上合约源码为准。
> All mechanisms and parameters in this whitepaper are grounded in the deployed, open-source smart contracts.

---

## 摘要 / Abstract

**中文**：CFOSWAP 是**全球首个将交易挖矿机制集成到 DEX 聚合路由中的去中心化交易协议**，部署于 BNB Smart Chain。协议包含两层：（1）**CfoRouter 聚合路由**——整合多套 DEX 路由策略，为交易者寻找最优报价，并采用单边即时扣除模式收取平台费；（2）**CFO 代币与挖矿体系**——总量固定 10 亿枚、无预挖，其中 1 亿枚通过交易挖矿线性释放，9 亿枚锁定并需多签 + Timelock 公示期方可激活。协议同时提供用户自建矿池（「韭菜庄园」模式）、交易税自动分发等机制，全部合约通过 Sourcify 开源验证，核心合约不可升级，owner 权限最终移交 Gnosis Safe 多签。

**English**: CFOSWAP is the **world's first decentralized trading protocol to integrate trade mining directly into a DEX aggregation router**, deployed on BNB Smart Chain. It has two layers: (1) the **CfoRouter** aggregation router, which combines multiple DEX routing strategies for best quotes and charges a platform fee via immediate single-side deduction; (2) the **CFO token and mining system** — a fixed supply of 1 billion tokens with no pre-mine, of which 100 million are released linearly through trade mining and 900 million are locked behind multisig + Timelock activation. The protocol also offers user-created mining pools and automated tax distribution. All contracts are verified open-source on Sourcify; the core router is non-upgradeable, and ownership is transferred to a Gnosis Safe multisig.

---

## 1. 项目概述 / Overview

### 1.1 背景与定位

BSC 上的 DEX 聚合器解决了「交易在哪条路径上最优」的问题，但普通交易者很少从平台的交易流量增长中获益。CFOSWAP 作为**全球首个交易挖矿聚合器**，把平台增长的价值以**链上可验证**的方式返还给交易者：

- 每一笔通过 CfoRouter 的交易都被链上记录为交易量；
- 交易量按稳定币口径折算后，转化为 CFO 代币奖励；
- 奖励线性释放，防止一次性砸盘；
- 交易即挖矿，无需质押、无需锁仓，交易者在正常兑换过程中自动获得收益。

### 1.2 协议组成

| 模块 | 合约 | 职责 |
|---|---|---|
| 代币 | CfoToken | ERC20，固定总量 10 亿，交易税机制 |
| 交易挖矿 | CfoMining | 交易量折算、奖励线性释放 |
| 自建矿池 | CfoMiningPoolFactory + CfoMiningPool | 用户建池、报名、按池发奖 |
| 聚合路由 | CfoRouter | 最优路径、单边扣费、gas 地板价 |
| 路由库 | CfoDagRouter / CfoSmartRouter / CfoWrapRouter / CfoUnxRouter / CfoUnxV3Router | 5 套路由策略，编译期链接 |

---

## 2. 聚合路由 / Aggregation Router

### 2.1 多策略路由

CfoRouter 在一次交易中并行/串行尝试多套路由策略并取最优报价：

- **CfoDagRouter**：有向无环图路由，覆盖多跳路径组合；
- **CfoSmartRouter**：智能拆分与路径选择；
- **CfoWrapRouter**：原生币（BNB）与 WBNB 包装、稳定币直兑；
- **CfoUnxRouter / CfoUnxV3Router**：Uniswap V2 风格与 V3 集中流动性池。

路由库地址在编译期硬编码链接进 CfoRouter，**CfoRouter 无代理合约、不可升级**，部署后行为确定。

### 2.2 平台手续费

- 采用**单边即时扣除模式**：手续费从用户输入侧直接扣除，不影响兑换金额的报价逻辑；
- 默认费率 **0.15%（15 bp）**；
- 费率硬上限 **3%（300 bp）**，合约内 `MAX_PLATFORM_FEE_BP = 300`，owner 只能在 ≤3% 范围内调整；
- 手续费收入可分流至最多 3 个收款地址，分成比例合计必须为 100%。

### 2.3 Gas 地板价与防静默失败

聚合交易在兑换后还要通知挖矿合约与矿池工厂。若 gas 不足，后置通知会被静默跳过，导致「交易成功但没发奖」。为此 CfoRouter 实施**动态 gas 地板价**：

```
gas floor = BASE_GAS + 活跃矿池数 × PER_POOL_GAS
```

经 GasProfile 测试（10 个冷矿池最坏情况）校准：

- 挖矿通知预算 800,000 gas；
- 工厂通知基础 200,000 gas + 每池 560,000 gas；
- 10 个报名池的最坏情况地板价约 6.75M gas；
- gas 不足的交易直接 revert，而不是静默吞掉奖励。

测试同时包含「交付断言」：不仅校验 gas 预算大小，还断言每个矿池实际发放了奖励，防止预算数字看着对、子调用却全部 OOG 被跳过。

---

## 3. CFO 代币经济 / Tokenomics

### 3.1 基本参数

| 参数 | 值 | 合约依据 |
|---|---|---|
| 代币名称 | Cfoswap Token（symbol: CFO） | CfoToken 构造函数 |
| 精度 | 18 | ERC20 |
| 总供应量 | **1,000,000,000 CFO（10 亿，固定）** | `MAX_SUPPLY = 1_000_000_000 × 10^18` |
| 预挖 | **无** | — |
| 交易税上限 | **1%（100 bp）**，可调低/调高但 ≤1% | `MAX_TAX_BP = 100` |
| 初始税率 | 1% | `taxRate = 100` |

### 3.2 供应量结构（仅列已由合约确定的部分）

| 部分 | 数量 | 释放/激活方式 |
|---|---|---|
| 交易挖矿产出 | **100,000,000 CFO（1 亿）** | Stage1 上限 1,000 万 + Stage2 上限 9,000 万；由 CfoMining 按交易挖矿铸造，合约硬顶保证最多铸 1 亿 |
| 锁定部分 | **900,000,000 CFO（9 亿）** | 锁定，激活需**外部多签钱包（Gnosis Safe）+ Timelock 公示期** |

> 除上述两部分外，本白皮书不设团队/生态/营销等分配比例。任何后续分配均须经多签与 Timelock 公示后由链上交易执行，链上可查。

合约双层硬顶保护：CfoMining 内 stage cap 保证挖矿最多铸 1 亿；CfoToken 内 `MAX_SUPPLY` 保证全局永不超过 10 亿。给挖矿合约的铸币授权额度 = Stage1 + Stage2 = 1 亿，授权不足会在额度耗尽时 revert，超额授权也无法超发。

### 3.3 交易税机制

- 对 CFO 的转账收取交易税（税率 ≤1%），税款用于团队/运营多签钱包分发；
- 税费钱包为 3 个地址，链上分成比例 40% / 30% / 30%（可读 `teamWallets` / `teamShares`）；
- 税币售卖仅支持 **PancakeSwap V2** 语义；V3 池会导致扣税失败/漏税，因此 CFO 流动性只放 V2；
- **双池要求**：CFO/USDT 与 CFO/WBNB 两个 V2 池必须同时存在并登记，单池时自动售卖会因路径不足静默跳过；
- 初始流动性必须在登记税池之前注入完毕，避免注资动作被收 1% 税；
- 两池初始价格须一致（WBNB 池按注入时 BNB/USDT 市价折算），防止套利；
- 登记后再加/撤流动性也会产生 1% 税（设计如此）。

税款到账后由合约自动/手动兑换为 USDT 并分发给税费钱包，兑换滑点保护为预期输出的 90%。

---

## 4. 交易挖矿 / Trade Mining

### 4.1 交易量折算

- 只有涉及**稳定币腿**（USDT / USDC / BUSD / USDD / TUSD / DAI）的交易才折算交易量；
- 币/币交易（含 BNB）交易量记 0——因为没有可信的美元计价口径；
- 6 位小数稳定币统一缩放为 18 位精度；
- 折算结果用于计算奖励，路由内不使用任何人工喂价（BNB 价格硬编码已被永久移除，Chainlink 预言机方案已取消）。

### 4.2 奖励释放（线性归属）

- 每笔奖励从**交易当日 UTC 00:00** 起，在 **365 天**内线性释放（`VESTING_DURATION = 31,536,000` 秒）；
- 当天多笔交易合并为一个每日桶（bucket），不相互加速；
- 多笔奖励各自独立线性释放，不因为新奖励而提前解锁旧奖励；
- 当日即可领取极小比例（365 天档约 0.27%），对用户有利方向；
- 成熟桶在领取时摊销清理，领取不会卡住（重历史压测通过）；
- 守恒性：生命周期内累计领取 = 累计分配，测试断言通过。

### 4.3 挖矿退出开关

- 用户可主动退出交易挖矿（opt-out），退出后**本人交易不再产生奖励**；
- 开关默认参与，用户可随时切换；
- 退出操作仅影响本人的交易奖励，不影响其他任何机制。

---

## 5. 自建矿池 / User-Created Mining Pools

### 5.1 建池

- 任何用户可通过 CfoMiningPoolFactory 创建矿池（如「韭菜庄园」）；
- 建池销毁费 `CREATE_POOL_FEE`：源码默认 1000 CFO，生产环境由 owner 调为 10 CFO，销毁至 0x…dEaD，设为 0 可关闭；
- 矿池类型：
  - **mode=1 交易对池**：绑定一个 LP 交易对，自动读取 token0/token1，无需 owner 登记；交易路径命中该对即发奖；
  - **mode=0 共享奖励池**：奖励从共享预算出；
- 奖励代币、单位交易量奖励、释放周期（如 365 天）均在建池时设定。

### 5.2 报名与参与人数

- 用户报名（enroll）后，其匹配交易才会被通知到该池发奖；
- 每个矿池链上记录 **`enrolledCount`（当前参与人数）**：报名 +1、取消 -1；
- 重复报名/重复取消分别由 `AlreadyEnrolled` / `NotEnrolled` 拦截回滚，计数不可能偏差；
- 报名上限 **10 个池/人**（`MAX_ENROLLED_POOLS = 10`），用于控制单笔交易 gas 上限；第 11 个报名 revert，取消一个后可再报；
- 工厂维护两套名单：
  - **历史名单**（append-only）：所有报名过的池，用于批量领取，取消后已赚奖励仍可领；
  - **当前活跃名单**：只含在报池，交易通知只遍历它，路由据此计算 gas 地板。

### 5.3 通知过滤与 gas 控制

- onSwap 通知前在工厂本地预过滤：未报名、路径不匹配的池**不发起外部调用**；
- 每个池子调用有独立 gas 预算（`POOL_CALL_GAS = 550,000`）与 gasleft 闸门（`POOL_GATE_GAS = 600,000`）；
- 通知被跳过时发出带原因码的事件（1=gas 闸门，2=调用失败），供链下监控；
- 批量领取（claimAll）遍历历史名单，每个领取子调用 150,000 gas 预算。

### 5.4 助力金

- 建池者/参与者可支付助力金提升矿池权重，金额范围 0.01–1 BNB（`BOOST_MIN/MAX_AMOUNT`）；
- 助力金接收地址由 owner 通过 `setBoostFeeRecipient` 设置。

---

## 6. 安全模型 / Security

### 6.1 不可升级与确定性

- **CfoRouter 无代理、不可升级**，5 个路由库编译期链接，部署后行为确定；
- 全部 9 个合约通过 **Sourcify 开源验证**（stdJsonInput 格式，viaIR + optimizer 200 + evmVersion london）；
- 运行时字节码与本地 forge 构建产物逐一比对（路由遮盖 11 个库链接槽、矿池遮盖 4 个 immutable 位点后完全一致）。

### 6.2 权限治理

- 所有 owner 权限最终移交 **Gnosis Safe（Safe mode A）多签钱包**；
- 9 亿锁定代币的激活需多签 + Timelock 公示期；
- 税费/手续费/助力金收款地址均可读、可链上核验；
- 白名单机制：只有 Router、CfoMining 等被授权合约能调用挖矿通知入口。

### 6.3 防静默失败设计

| 风险 | 防护 |
|---|---|
| gas 不足导致通知被跳过 | 动态 gas 地板价，不足直接 revert |
| try/catch 吞掉子调用失败 | 跳过事件带原因码，链下可监控 |
| 单池导致税币卖不掉 | 双池强制要求 + 路径检查 |
| 计数偏差 | 报名/取消守卫 + 回滚一致性 |
| 超发 | 双层硬顶（stage cap + MAX_SUPPLY） |
| 预言机操纵 | 不使用人工喂价/Chainlink，稳定币腿直接计价 |

### 6.4 测试

- Foundry 测试套件 38 个用例全部通过，含：
  - BSC 主网 fork 测试（税费自动分发、费币兑换、矿池通知过滤、opt-out）；
  - Gas 画像测试（最坏情况 10 个冷矿池）；
  - 线性释放数学精确性与守恒性测试；
  - 参与人数计数测试（报名/取消/重复操作/重报）。
- 字节码合规：工厂运行时 24,098 字节（EIP-170 上限 24,576）。

---

## 7. 合约清单 / Contracts

| 合约 | 说明 | 可升级 |
|---|---|---|
| CfoToken | ERC20 代币、交易税 | 否（构造函数固定名称，改名需重部署） |
| CfoMining | 交易挖矿、线性释放 | 否 |
| CfoMiningPool | 自建矿池模板（new 部署，非 clone） | 否 |
| CfoMiningPoolFactory | 建池工厂、报名名单 | 否 |
| CfoRouter | 聚合路由主合约 | **否，无代理** |
| CfoDagRouter | DAG 路由库 | 库 |
| CfoSmartRouter | 智能路由库 | 库 |
| CfoWrapRouter | 包装/稳定币路由库 | 库 |
| CfoUnxRouter | V2 风格路由库 | 库 |
| CfoUnxV3Router | V3 路由库 | 库 |

> 部署约束：6 个合约（5 路由库 + CfoRouter）必须一起按序部署，因为 CfoRouter 在编译期硬编码 5 个库地址；CfoRouter 不能单独部署。

---

## 8. 使用流程 / User Flows

**交易者**：在聚合界面选择币种 → 路由自动找最优路径 → 签名交易（gas 不足会直接提示）→ 交易同时完成兑换与挖矿记账 → 奖励 365 天线性释放，随时可领。交易即挖矿，无需质押。

**建池者**：approve CFO → 调 createPoolV2（销毁 10 CFO）→ 注入奖励代币 → 分享矿池 → 用户报名 → 交易匹配即发奖。

---

## 9. 风险提示 / Risk Disclosure

1. **智能合约风险**：合约虽经测试与开源验证，仍可能存在未发现漏洞；
2. **市场风险**：CFO 价格与交易量波动会影响挖矿收益的法币价值；
3. **流动性风险**：奖励释放期长（365 天），早期流动性深度有限；
4. **参数变更**：税率（≤1%）、平台费（≤3%）等可由多签在硬顶内调整；
5. 本白皮书不构成投资建议。

---

*本白皮书随协议迭代更新；以链上已验证合约为最终事实来源。*
*This whitepaper will be updated as the protocol iterates; the on-chain verified contracts remain the ultimate source of truth.*
