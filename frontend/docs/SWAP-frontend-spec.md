# 88DEX / CFOSWAP 前端 SWAP 模块技术规格文档

> 版本：v1.0  
> 日期：2026-08-30  
> 适用范围：SWAP 前端开发  
> 技术栈假设：ethers.js v5 + React 18 + TypeScript（严格模式）  
> 部署目标链：BSC（Binance Smart Chain）主网

---

## 1. 概述

### 1.1 CfoswapRouter 是什么

CfoswapRouter 是 88DEX/CFOSWAP 项目部署在 BSC 链上的 DEX 聚合路由合约，基于 OKX DexRouter 修改而来。它是 SWAP 前端与链上流动性交互的**唯一入口**：前端不直接调用任何 PancakeSwap / Biswap / MDEX 等底层 DEX 的合约，而是把报价引擎算出的路径编码成 calldata，统一交给 CfoswapRouter 执行。

CfoswapRouter 本身不实现具体的兑换逻辑，而是把请求分发给 5 个子路由库（library），由各子路由库完成与底层流动性池的实际交互。同时 CfoswapRouter 负责：

- 平台费的分发（最多 3 个接收地址按比例分账）；
- 挖矿通知（swap 成功后通知 CfoSwapMining 合约，触发流动性挖矿奖励）；
- 安全控制（`nonReentrant` 重入锁、`whenNotPaused` 暂停开关）。

### 1.2 5 个子路由库的职责（library link 关系）

CfoswapRouter 在部署时，将以下 5 个子路由库作为 **library link** 链接进 Router 的 bytecode 中。前端无需直接调用这些 library，但需要理解它们的职责，以选择正确的入口函数：

| 子路由库 | 职责 | 对应入口函数 |
| --- | --- | --- |
| `SmartSwapRouter` | 智能聚合交换，支持把一笔大额交易拆成多个批次（batches）并行执行，取最优聚合结果 | `smartSwapTo` / `smartSwapByOrderId` |
| `DagRouter` | DAG 多跳路由，按一条完整的 `RouterPath[]` 链路串联多个池子完成兑换 | `dagSwapTo` / `dagSwapByOrderId` |
| `UnxswapRouter` | V2 风格（UniV2/PancakeV2）单链路交换，`pools` 用 `bytes32[]` 编码 | `unxswapTo` / `unxswapByOrderId` / `unxswapToWithBaseRequest` |
| `UnxswapV3Router` | V3 风格（UniV3/PancakeV3）单链路交换，`pools` 用 `uint256[]` 编码，带 callback 回调 | `uniswapV3SwapTo` / `uniswapV3SwapToWithBaseRequest` |
| `SwapWrapRouter` | 原生币与包装币互转（BNB ↔ WBNB），不参与挖矿通知、不收佣金 | `swapWrap` / `swapWrapToWithBaseRequest` |

> **library link 说明**：5 个子路由库的地址在部署 CfoswapRouter 时通过 linker 写入 Router bytecode。前端只需知道 CfoswapRouter 主地址即可，调用时库逻辑已内联进 Router。文档中子路由库地址不暴露给前端。

### 1.3 SWAP 前端核心职责

SWAP 前端承担三条主线工作，**全程不依赖任何外部报价 API**（不调用 OKX / 1inch / 0x）：

1. **自研报价引擎**：自行遍历 BSC 链上主流 DEX 流动性池，计算最优兑换路径与预期到账金额；
2. **编码 calldata**：根据报价结果选择对应入口函数，用 `ethers.utils.defaultAbiCoder` 编码参数与 `ExtraData`；
3. **发交易**：完成钱包授权（approve）、发送交易、等待确认、错误处理与 UI 反馈。

---

## 2. CfoswapRouter 架构

### 2.1 合约地址

| 名称 | 占位符 | 说明 |
| --- | --- | --- |
| CfoswapRouter 主路由 | `{{CFOSWAP_ROUTER_ADDRESS}}` | 部署后填入，前端唯一调用入口 |
| CfoSwapToken 代币 | `{{CFO_SWAP_TOKEN_ADDRESS}}` | 项目代币 |
| CfoMiningPool 矿池工厂 | `{{CFO_MINING_POOL_ADDRESS}}` | 矿池工厂 |
| CfoSwapMining 挖矿奖励 | `{{CFO_SWAP_MINING_ADDRESS}}` | swap 成功后被通知的挖矿合约 |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bC9165` | BSC 固定值，见第 8 节 |
| 平台费接收地址 0 | `{{PLATFORM_FEE_ADDR_0}}` | 占比 40% |
| 平台费接收地址 1 | `{{PLATFORM_FEE_ADDR_1}}` | 占比 30% |
| 平台费接收地址 2 | `{{PLATFORM_FEE_ADDR_2}}` | 占比 30% |

### 2.2 构造函数

```solidity
constructor(
    address _owner,
    address[3] feeRecipients,
    uint256[3] feeShares
)
```

- `_owner`：合约 owner（可配置费率、暂停等）；
- `feeRecipients`：3 个平台费接收地址；
- `feeShares`：3 个地址的分账比例（对应 40 / 30 / 30）。

### 2.3 平台费机制

- **上限**：最大 3%（300 bp）；
- **默认**：0.15%；
- **分发**：按 40% / 30% / 30% 分发到 3 个 `feeRecipients` 地址；
- **强制覆盖**：Router 在每个入口函数内部调用 `_overridePlatformFee(extraData, toToken)`，会根据 `toToken` 覆盖前端传入的 `CommissionInfo`，确保费率不可被前端绕过为 0bp（详见第 5 节模块 6 的前端零费率保护）。

### 2.4 挖矿通知

CfoswapRouter 内置 `CfoMiningHook` 逻辑。除 `swapWrap` / `swapWrapToWithBaseRequest`（包装币互换无价格暴露，明确排除挖矿通知与佣金）外，其余所有入口函数在 swap 成功后调用：

```solidity
_notifyMining(fromToken, toToken, fromTokenAmount, returnAmount, firstRef)
```

该函数会通知 `{{CFO_SWAP_MINING_ADDRESS}}` 合约，按交易量结算流动性挖矿奖励。前端无需直接调用挖矿合约，但需注意：`firstRef`（首级 referrer）取自 `ExtraData.commissionInfo.referrerAddress`。

---

## 3. 5 个入口函数（从 DexRouter.sol 读取的实际签名）

> 以下签名全部来自 `contracts_mod_20260830_v3/0x5994_router/DexRouter.sol` 第 370–681 行源码，均带 `external payable nonReentrant whenNotPaused` 修饰符。`uniswapV3SwapCallback` 除外（无 `payable`）。

### 3.1 智能聚合交换（多批次）—— SmartSwapRouter

```solidity
// 由 msg.sender 接收结果
function smartSwapByOrderId(
    uint256 orderId,
    BaseRequest calldata baseRequest,
    uint256[] calldata batchesAmount,
    RouterPath[][] calldata batches,
    PMMLib.PMMSwapRequest[] calldata pmmRequests
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);

// 指定 receiver 接收结果
function smartSwapTo(
    uint256 orderId,
    address receiver,
    BaseRequest calldata baseRequest,
    uint256[] calldata batchesAmount,
    RouterPath[][] calldata batches,
    PMMLib.PMMSwapRequest[] calldata pmmRequests
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);
```

- 内部调用 `SmartSwapRouter.smartSwapTo(...)`；
- `batchesAmount[i]` 对应 `batches[i]` 这一批的输入金额，多批并行执行后聚合；
- `pmmRequests` 当前**仅用于 calldata 长度计算**，不参与实际 swap 逻辑（前端可传空数组 `[]`）；
- swap 后触发 `_notifyMining`。

### 3.2 DAG 多跳路由 —— DagRouter

```solidity
// 由 msg.sender 接收结果
function dagSwapByOrderId(
    uint256 orderId,
    BaseRequest calldata baseRequest,
    RouterPath[] calldata paths
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);

// 指定 receiver 接收结果
function dagSwapTo(
    uint256 orderId,
    address receiver,
    BaseRequest calldata baseRequest,
    RouterPath[] calldata paths
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);
```

- 内部调用 `DagRouter.dagSwapTo(...)`；
- `paths` 为一条完整的多跳链路（`USDT → WBNB → CAKE`）；
- swap 后触发 `_notifyMining`。

### 3.3 V2 风格交换 —— UnxswapRouter

```solidity
// 由 msg.sender 接收结果（bare 签名）
function unxswapByOrderId(
    uint256 srcToken,
    uint256 amount,
    uint256 minReturn,
    bytes32[] calldata pools
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);

// 指定 receiver 接收结果（bare 签名）
function unxswapTo(
    uint256 srcToken,
    uint256 amount,
    uint256 minReturn,
    address receiver,
    bytes32[] calldata pools
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);

// 带 BaseRequest 的结构化签名
function unxswapToWithBaseRequest(
    uint256 orderId,
    address receiver,
    BaseRequest calldata baseRequest,
    bytes32[] calldata pools
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);
```

- 内部调用 `UnxswapRouter.unxswapTo(...)` / `unxswapToWithBaseRequest(...)`；
- **关键**：`pools` 类型是 `bytes32[]`（不是 `address[]`，也不是 `uint256[]`），每个 `bytes32` 内编码了池子地址与方向 / unwrap 标志；
- `srcToken` 是 `uint256`，原生币用 `0xEeee...` 或 `address(0)`（`address(0)` 将在未来移除，前端统一用 `0xEeee`）；
- bare 签名（前两个）的 fromToken / toToken 由 `UniswapTokenInfoHelper.getUnxswapTokenInfo` 从 `pools` 推断；
- swap 后触发 `_notifyMining`。

### 3.4 V3 风格交换 —— UnxswapV3Router

```solidity
// bare 签名，receiver 编码为 uint256（带 orderId 掩码）
function uniswapV3SwapTo(
    uint256 receiver,
    uint256 amount,
    uint256 minReturn,
    uint256[] calldata pools
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);

// 带 BaseRequest 的结构化签名
function uniswapV3SwapToWithBaseRequest(
    uint256 orderId,
    address receiver,
    BaseRequest calldata baseRequest,
    uint256[] calldata pools
) external payable nonReentrant whenNotPaused returns (uint256 returnAmount);

// V3 callback（合约回调，前端不主动调用，但需理解其存在）
function uniswapV3SwapCallback(
    int256 amount0Delta,
    int256 amount1Delta,
    bytes calldata data
) external whenNotPaused override;
```

- 内部调用 `UnxswapV3Router.uniswapV3SwapTo(...)` / `uniswapV3SwapToWithBaseRequest(...)`；
- **关键**：`pools` 类型是 `uint256[]`（与 V2 的 `bytes32[]` 不同），每个 `uint256` 编码了 V3 pool 地址与 swap 方向 / unwrap 标志；
- V3 的 fromToken / toToken 若为 ETH，地址用 `0xEeee`；
- `uniswapV3SwapCallback` 是 V3 池子回调 Router 的入口，`data` 前 32 字节是 flag（`V3_EXACT_IN_CALLBACK_FLAG`），用于区分 exact-in 路由；前端不直接调用，但 Router 必须能正确响应；
- swap 后触发 `_notifyMining`。

### 3.5 包装币转换 —— SwapWrapRouter

```solidity
// 位掩码编码（轻量）
function swapWrap(
    uint256 orderId,
    uint256 rawdata
) external payable nonReentrant whenNotPaused;

// 结构化编码
function swapWrapToWithBaseRequest(
    uint256 orderId,
    address receiver,
    BaseRequest calldata baseRequest
) external payable nonReentrant whenNotPaused;
```

- 内部调用 `SwapWrapRouter.swapWrap(...)` / `swapWrapToWithBaseRequest(...)`；
- **rawdata 位编码**：
  - bits [251:249]：transfer mode（与 `fromToken` 高位编码一致）；
  - bit 255：方向 reversed 标志，`false = ETH→WETH`，`true = WETH→ETH`；
- **明确排除**：包装币互换不触发 `_notifyMining`，不收佣金（无价格暴露变化）；
- 无 `returns`（不返回金额）。

### 3.6 ExtraData 的解码机制（重要）

所有入口函数体内都有如下模式：

```solidity
uint256 swapDataLength = 4 + abi.encode(<所有显式参数>).length;
IDexRouter.ExtraData memory extraData = ExtraDataLib.getDecodedExtraData(swapDataLength);
```

**含义**：`ExtraData` 不是作为显式参数传入，而是**附加在 calldata 尾部**。Router 通过计算显式参数编码后的长度，定位到 calldata 末尾的 `ExtraData` 字节并解码。因此前端在构造交易 calldata 时，必须：

1. 先按函数签名正常编码所有显式参数；
2. 再把 `ExtraData`（编码后的 bytes）**追加**到 calldata 末尾；
3. `value`（msg.value）按是否为原生币支付设置。

---

## 4. 参数结构体定义（从 IDexRouter.sol 读取）

> 以下结构体全部来自 `contracts_mod_20260830_v3/0x5994_router/IDexRouter.sol`。

### 4.1 BaseRequest

```solidity
struct BaseRequest {
    uint256 fromToken;        // 高 3 位编码 transfer mode，低 160 位是 token address
    address toToken;          // 目标代币地址（原生币用 0xEeee）
    uint256 fromTokenAmount;  // 输入金额（含精度）
    uint256 minReturnAmount;  // 最低收到金额（滑点保护）
    uint256 deadLine;         // 截止时间（秒级时间戳）
}
```

- **关键**：`fromToken` 是 `uint256` 类型，**高 3 位（bits [162:160] 或等价的高位）编码 transfer mode**，低 160 位才是真正的 token address。前端构造时需按 mode 把 mode 标志位 OR 到 token 地址上；
- `toToken` 是普通 `address`，原生币场景用 `0xEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeee`。

### 4.2 RouterPath

```solidity
struct RouterPath {
    address[] mixAdapters;  // 适配器地址列表（指向底层 DEX 的 adapter）
    address[] assetTo;       // 每一跳的资产接收地址
    uint256[] rawData;       // 每一跳的原始数据（费率档 / 方向等）
    bytes[] extraData;       // 每一跳的附加数据
    uint256 fromToken;       // 该路径起始 token（同样带 mode 高位编码）
}
```

### 4.3 CommissionInfo（平台费 / 佣金）

```solidity
struct CommissionInfo {
    bool isFromTokenCommission;  // 0x00 是否从 fromToken 收佣金
    bool isToTokenCommission;    // 0x20 是否从 toToken 收佣金
    uint256 tokenWithMode;       // 0x40 收佣金的 token（若 isToTokenCommission 则纯地址，否则带 mode 高位）
    uint256 toBCommission;       // 0x60 0=无, 1=无 toB 佣金, 2=有 toB 佣金
    uint256 commissionLength;    // 0x80 佣金级数（本项目简化为 ≤1）
    uint256 commissionRate;       // 0xa0 首级费率（bp）
    address referrerAddress;     // 0xc0 首级 referrer
    uint256 commissionRate2;      // 0xe0
    address referrerAddress2;     // 0x100
    uint256 commissionRate3;      // 0x120
    address referrerAddress3;     // 0x140
    uint256 commissionRate4;      // 0x160
    address referrerAddress4;     // 0x180
    uint256 commissionRate5;      // 0x1a0
    address referrerAddress5;     // 0x1c0
    uint256 commissionRate6;      // 0x1e0
    address referrerAddress6;     // 0x200
    uint256 commissionRate7;      // 0x220
    address referrerAddress7;     // 0x240
    uint256 commissionRate8;      // 0x260
    address referrerAddress8;     // 0x280
}
```

- **本项目简化**：已移除多级 referral，`commissionLength ≤ 1`，仅使用 `commissionRate` + `referrerAddress`（首级），2~8 级全部置 0 / `address(0)`；
- 平台费由 Router 的 `_overridePlatformFee` 强制覆盖，前端传入的费率仅作占位，实际以 Router 内部配置为准（默认 0.15%）。

### 4.4 TrimInfo（截留，可选）

```solidity
struct TrimInfo {
    bool hasTrim;           // 0x00 是否启用截留
    uint256 trimRate;       // 0x20 截留费率
    address trimAddress;    // 0x40 截留接收地址
    uint256 toBTrim;        // 0x60 0=无, 1=无 toB 截留, 2=有 toB 截留
    uint256 expectAmountOut;// 0x80 预期产出
    uint256 chargeRate;     // 0xa0 收取费率
    address chargeAddress;  // 0xc0 收取地址
}
```

- 前端默认不启用（`hasTrim = false`，其余置 0）。

### 4.5 Permit2Info（Permit2 授权，可选）

```solidity
struct Permit2Info {
    address owner;     // 0x00 签名 owner
    uint256 nonce;     // 0x20
    uint256 deadline;  // 0x40
    bytes signature;   // 0x60 签名
    uint256[] amounts; // 0x80 各 token 授权金额
}
```

- 本项目采用直接 approve 方案（见第 5 节模块 3），**默认不使用 Permit2**，`owner = address(0)` 表示未启用。

### 4.6 ExtraData（聚合）

```solidity
struct ExtraData {
    CommissionInfo commissionInfo;  // 平台费
    TrimInfo trimInfo;              // 截留（可选）
    Permit2Info permit2Info;        // Permit2（可选）
    address refundTo;               // 退款地址（通常 = 用户地址）
}
```

- 附加在 calldata 尾部（见 3.6）；
- `refundTo` 一般填发起交易的用户地址。

### 4.7 内部结构体（仅供理解，前端不编码）

`SwapCache`、`AfterSwapParams`、`ExactOutSwapCache` 为 Router 内部执行缓存，前端无需构造。

---

## 5. SWAP 前端 6 大工作模块

### 模块 1：自研报价引擎（最核心，工作量最大）

**职责**：不依赖任何外部报价 API，自行遍历 BSC 链上流动性池，计算最优兑换路径。

**输入**：`fromToken`、`toToken`、`fromAmount`  
**输出**：最优路径（paths / batches / pools）+ 预期收到金额 + 价格影响 %

#### 实现要点

1. **维护主流池子列表**：
   - PancakeSwap V2（Factory: `0xcA143Ce32C7985b50b4FA5d3b2E6F2D236C4E1E2`）
   - PancakeSwap V3（多费率档：0.01% / 0.05% / 0.25% / 1%）
   - Biswap
   - MDEX
   - 其他主流 V2 / V3 DEX

2. **实时查储备量**：
   - V2 池：调 `getReserves()` 返回 `(reserve0, reserve1)`；
   - V3 池：调 `slot0()` 取 `sqrtPriceX96`，调 `liquidity()` 取流动性，按 `sqrtPriceX96` 与 tick 计算当前价格区间内的有效兑换量。

3. **路径算法**：
   - 使用 Dijkstra（最短/最优路径）或 Yen's algorithm（K 条最短路径）；
   - 最多 3–4 跳，中间币优先选 WBNB / USDT / USDC / CAKE 等高流动性资产；
   - 每跳算出输出量（V2 用 `x*y=k` 常数积公式扣 0.25% 手续费；V3 按 tick 区间分段计算）。

4. **支持拆分**：
   - 大额交易（超过单池深度阈值）拆成多批次并行执行，调用 `smartSwapTo`；
   - `batchesAmount[]` 为每批金额，`batches[][]` 为每批路径。

5. **缓存**：
   - 池子储备量缓存 5–10 秒，避免每次报价都查链；
   - 缓存 key = 池子地址，value = `{ reserves, timestamp }`。

6. **WebSocket 实时同步**：
   - 监听 V2 池的 `Sync` 事件与 `Swap` 事件；
   - 监听 V3 池的 `Swap` 事件；
   - 收到事件即更新对应池子的缓存储备量，使下次报价即时反映链上最新状态。

**输出结构建议**（TypeScript）：

```typescript
interface QuoteResult {
  pathType: 'v2-single' | 'v3-single' | 'dag-multi' | 'smart-split' | 'wrap';
  expectedOut: string;        // 预期到账（最小单位字符串）
  priceImpact: number;        // 价格影响百分比 0~100
  // 路径原始数据，供模块 2 编码
  pools?: string[];           // V2/V3 单跳
  routerPaths?: RouterPath[]; // DAG 多跳
  batchesAmount?: string[];   // SmartSwap 拆分金额
  batches?: RouterPath[][];   // SmartSwap 每批路径
  hops: { tokenIn: string; tokenOut: string; pool: string; fee: number; dex: string }[];
}
```

---

### 模块 2：参数编码

**职责**：根据报价引擎返回的 `pathType`，选择对应入口函数，编码 calldata（含尾部追加的 `ExtraData`）。

#### 函数选择映射

| pathType | 入口函数 | 关键参数 |
| --- | --- | --- |
| `v2-single` | `unxswapTo` | `srcToken(uint256), amount, minReturn, receiver, pools(bytes32[])` |
| `v3-single` | `uniswapV3SwapTo` | `receiver(uint256), amount, minReturn, pools(uint256[])` |
| `dag-multi` | `dagSwapTo` | `orderId, receiver, BaseRequest, paths(RouterPath[])` |
| `smart-split` | `smartSwapTo` | `orderId, receiver, BaseRequest, batchesAmount[], batches[][], pmmRequests[](空)` |
| `wrap` | `swapWrap` | `orderId, rawdata` |

#### ExtraData 编码

- `CommissionInfo`：平台费（费率由 Router 覆盖，前端填默认 0.15% = 15bp 占位，`commissionLength = 1`，`referrerAddress` 填首级或 `address(0)`）；
- `TrimInfo`：默认不启用（`hasTrim=false`）；
- `Permit2Info`：默认不启用（`owner = address(0)`）；
- `refundTo`：用户地址。

#### ethers.js v5 编码示例

```typescript
import { ethers } from 'ethers';

const ROUTER_IFACE = new ethers.utils.Interface([
  'function unxswapTo(uint256 srcToken,uint256 amount,uint256 minReturn,address receiver,bytes32[] pools) external payable returns (uint256)',
  'function uniswapV3SwapTo(uint256 receiver,uint256 amount,uint256 minReturn,uint256[] pools) external payable returns (uint256)',
  'function dagSwapTo(uint256 orderId,address receiver,(uint256,address,uint256,uint256,uint256) baseRequest,(address[],address[],uint256[],bytes[],uint256)[] paths) external payable returns (uint256)',
  'function smartSwapTo(uint256 orderId,address receiver,(uint256,address,uint256,uint256,uint256) baseRequest,uint256[] batchesAmount,(address[],address[],uint256[],bytes[],uint256)[][] batches,bytes[] pmmRequests) external payable returns (uint256)',
  'function swapWrap(uint256 orderId,uint256 rawdata) external payable',
]);

// 编码 ExtraData（追加到 calldata 尾部）
function encodeExtraData(refundTo: string): string {
  // CommissionInfo（简化：仅首级，commissionLength=1，rate=15bp）
  const commissionInfo = ethers.utils.defaultAbiCoder.encode(
    ['bool', 'bool', 'uint256', 'uint256', 'uint256', 'uint256', 'address',
     'uint256', 'address', 'uint256', 'address', 'uint256', 'address',
     'uint256', 'address', 'uint256', 'address', 'uint256', 'address', 'uint256', 'address'],
    [true, false, 0, 1, 1, 15, ethers.constants.AddressZero,
     0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero,
     0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero],
  );
  const trimInfo = ethers.utils.defaultAbiCoder.encode(
    ['bool', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'address'],
    [false, 0, ethers.constants.AddressZero, 0, 0, 0, ethers.constants.AddressZero],
  );
  const permit2Info = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'bytes', 'uint256[]'],
    [ethers.constants.AddressZero, 0, 0, '0x', []],
  );
  const extraData = ethers.utils.defaultAbiCoder.encode(
    ['bytes', 'bytes', 'bytes', 'address'],
    [commissionInfo, trimInfo, permit2Info, refundTo],
  );
  return extraData;
}

// 拼接最终 calldata = 函数编码 + ExtraData 追加
function buildCalldata(baseCalldata: string, refundTo: string): string {
  return ethers.utils.hexConcat([baseCalldata, encodeExtraData(refundTo)]);
}
```

完整调用示例见第 6 节。

---

### 模块 3：钱包授权 + 发交易

#### 授权模型（方案 B：直接 approve 给 CfoswapRouter）

不使用 OKX 的 `TokenApproveProxy`，直接把 token approve 给 `{{CFOSWAP_ROUTER_ADDRESS}}`。

#### 流程

1. **检查 allowance**：调 `fromToken.allowance(user, {{CFOSWAP_ROUTER_ADDRESS}})`，判断是否 ≥ `fromAmount`；
2. **不足则 approve**：调 `fromToken.approve({{CFOSWAP_ROUTER_ADDRESS}}, type(uint256).max)`；
   - 推荐授权最大值，避免频繁授权（用户可单独提供「取消授权」入口）；
3. **发送交易**：调 CfoswapRouter 对应入口函数，`value` 按是否为原生币支付设置；
4. **等待确认**：等待 1–2 个区块确认（`tx.wait(1)`）。

#### 特殊处理

- **BNB（原生币）**：不需要 approve，直接用 `msg.value` 携带金额；`fromToken` 用 `0xEeee`；
- **WBNB**：走标准 ERC20 approve 流程；BNB ↔ WBNB 互转走 `swapWrap`。

#### gas 估算

```typescript
async function estimateOrFallback(
  router: ethers.Contract,
  fn: string,
  args: any[],
  value?: ethers.BigNumber,
): Promise<{ data: string; value: ethers.BigNumber; gasLimit: number }> {
  const data = router.interface.encodeFunctionData(fn, args);
  let gasLimit: number;
  try {
    const est = await router.estimateGas[fn](...args, { value });
    gasLimit = Math.ceil(est.toNumber() * 1.2); // 加 20% buffer
  } catch {
    gasLimit = 500000; // 兜底
  }
  return { data, value: value ?? ethers.BigNumber.from(0), gasLimit };
}
```

---

### 模块 4：UI 展示

- **币种选择器**：支持搜索 + 自定义地址粘贴（粘贴后自动拉 `decimals()` / `symbol()` / `name()` 校验）；
- **金额输入**：支持 `50%` / `MAX` 快捷按钮（读余额）；
- **路径可视化**：`USDT → [PancakeV3 0.01%] → WBNB → [PancakeV2 0.3%] → CAKE`，每跳显示 DEX 与费率档；
- **滑点设置**：默认 0.5%，可选 0.1% / 0.5% / 1% / 3% / 自定义；
- **价格影响 % 显示**：红（>3%）/ 黄（1%~3%）/ 绿（<1%）三色；
- **最低收到金额（minReturn）**：实时显示，`minReturn = expectedOut × (1 - 滑点%)`；
- **swap 按钮状态**：`disabled → approving → pending → success / error`；
- **交易哈希**：可点击跳转 BscScan（`https://bscscan.com/tx/{hash}`）。

---

### 模块 5：数据源

- **代币列表**：维护 JSON 配置文件（`src/data/tokens.json`），含主流代币 + 合约地址 + 精度 + logo URL；
- **池子列表**：维护主流 DEX 的 Factory 合约地址，监听 `PairCreated`（V2）/ `PoolCreated`（V3）事件自动发现新池；
- **储备量**：实时查 `getReserves()` / `slot0() + liquidity()`；
- **代币价格**：从储备量反算（USDT 价格锚定 1），WBNB 价格 = `WBNB/USDT` 池储备量比；
- **RPC**：BSC 主网 RPC endpoint 列表（多节点容灾），见第 8 节。

---

### 模块 6：安全与错误处理

- **滑点保护**：`minReturn = expectedOut × (1 - 滑点%)`，写入 `BaseRequest.minReturnAmount`；
- **交易超时**：`deadLine = now + 20 分钟`（秒级时间戳），超时交易 revert；
- **错误处理（统一 toast，禁 alert）**：
  - 交易被拒（user denied）：`toast('用户取消')`；
  - 交易失败：`toast('交易失败，请重试')`，**不暴露后端堆栈**；
  - 滑点超限：`toast('价格变动超过滑点容忍')`；
  - 网络错误：`toast('网络异常，请检查 RPC')`；
- **前端零费率保护**：提交前校验 `CommissionInfo` 费率不为 0bp，避免用户逃费（实际由 Router `_overridePlatformFee` 兜底，前端做二次校验）；
- **平台费正确设置**：3 地址 3 比例（40% / 30% / 30%），由合约构造函数配置，前端只读不写。

---

## 6. ABI 编码示例（TypeScript + ethers.js v5）

以下为完整调用示例，所有合约地址使用占位符常量：

```typescript
import { ethers } from 'ethers';

// 占位符常量
const CFOSWAP_ROUTER = '{{CFOSWAP_ROUTER_ADDRESS}}';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bC9165';
const ETH_PLACEHOLDER = '0xEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeee';

const ROUTER_ABI = [
  'function unxswapTo(uint256 srcToken,uint256 amount,uint256 minReturn,address receiver,bytes32[] pools) external payable returns (uint256)',
  'function uniswapV3SwapTo(uint256 receiver,uint256 amount,uint256 minReturn,uint256[] pools) external payable returns (uint256)',
  'function dagSwapTo(uint256 orderId,address receiver,(uint256,address,uint256,uint256,uint256) baseRequest,(address[],address[],uint256[],bytes[],uint256)[] paths) external payable returns (uint256)',
  'function smartSwapTo(uint256 orderId,address receiver,(uint256,address,uint256,uint256,uint256) baseRequest,uint256[] batchesAmount,(address[],address[],uint256[],bytes[],uint256)[][] batches,bytes[] pmmRequests) external payable returns (uint256)',
  'function swapWrap(uint256 orderId,uint256 rawdata) external payable',
];

// 1. 构造 BaseRequest
function buildBaseRequest(
  fromToken: string,
  toToken: string,
  amountIn: string,
  minReturn: string,
  deadlineSec: number,
) {
  return {
    fromToken: ethers.BigNumber.from(fromToken), // 注意：需按 mode 编码高位
    toToken,
    fromTokenAmount: ethers.BigNumber.from(amountIn),
    minReturnAmount: ethers.BigNumber.from(minReturn),
    deadLine: deadlineSec,
  };
}

// 2. 构造 RouterPath（DAG 多跳示例）
function buildRouterPath(
  fromTokenWithMode: string,
  mixAdapters: string[],
  assetTo: string[],
  rawData: string[],
  extraDataBytes: string[],
) {
  return {
    mixAdapters,
    assetTo,
    rawData: rawData.map((d) => ethers.BigNumber.from(d)),
    extraData: extraDataBytes,
    fromToken: ethers.BigNumber.from(fromTokenWithMode),
  };
}

// 3. 构造 ExtraData（含 CommissionInfo 平台费）
function encodeExtraData(refundTo: string): string {
  const commissionInfo = ethers.utils.defaultAbiCoder.encode(
    ['bool', 'bool', 'uint256', 'uint256', 'uint256', 'uint256', 'address',
     'uint256', 'address', 'uint256', 'address', 'uint256', 'address',
     'uint256', 'address', 'uint256', 'address', 'uint256', 'address', 'uint256', 'address'],
    [true, false, 0, 1, 1, 15, ethers.constants.AddressZero,
     0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero,
     0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero, 0, ethers.constants.AddressZero],
  );
  const trimInfo = ethers.utils.defaultAbiCoder.encode(
    ['bool', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'address'],
    [false, 0, ethers.constants.AddressZero, 0, 0, 0, ethers.constants.AddressZero],
  );
  const permit2Info = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'bytes', 'uint256[]'],
    [ethers.constants.AddressZero, 0, 0, '0x', []],
  );
  return ethers.utils.defaultAbiCoder.encode(
    ['bytes', 'bytes', 'bytes', 'address'],
    [commissionInfo, trimInfo, permit2Info, refundTo],
  );
}

// 4. 调用各入口函数
async function callUnxswap(
  signer: ethers.Signer,
  srcToken: string, amount: string, minReturn: string,
  receiver: string, pools: string[],
) {
  const router = new ethers.Contract(CFOSWAP_ROUTER, ROUTER_ABI, signer);
  const base = router.interface.encodeFunctionData('unxswapTo', [
    ethers.BigNumber.from(srcToken), amount, minReturn, receiver,
    pools.map((p) => ethers.utils.hexZeroPad(p, 32)),
  ]);
  const data = ethers.utils.hexConcat([base, encodeExtraData(receiver)]);
  const isNative = srcToken.toLowerCase() === ETH_PLACEHOLDER.toLowerCase();
  const tx = await signer.sendTransaction({
    to: CFOSWAP_ROUTER, data,
    value: isNative ? ethers.BigNumber.from(amount) : ethers.BigNumber.from(0),
  });
  return tx.wait(1);
}

async function callUniswapV3(
  signer: ethers.Signer, receiver: string, amount: string, minReturn: string,
  pools: string[], isNative: boolean,
) {
  const router = new ethers.Contract(CFOSWAP_ROUTER, ROUTER_ABI, signer);
  const base = router.interface.encodeFunctionData('uniswapV3SwapTo', [
    ethers.BigNumber.from(receiver), amount, minReturn,
    pools.map((p) => ethers.BigNumber.from(p)),
  ]);
  const data = ethers.utils.hexConcat([base, encodeExtraData(receiver)]);
  const tx = await signer.sendTransaction({
    to: CFOSWAP_ROUTER, data,
    value: isNative ? ethers.BigNumber.from(amount) : ethers.BigNumber.from(0),
  });
  return tx.wait(1);
}

async function callDagSwap(
  signer: ethers.Signer, orderId: number, receiver: string,
  baseRequest: any, paths: any[],
) {
  const router = new ethers.Contract(CFOSWAP_ROUTER, ROUTER_ABI, signer);
  const base = router.interface.encodeFunctionData('dagSwapTo', [
    orderId, receiver, baseRequest, paths,
  ]);
  const data = ethers.utils.hexConcat([base, encodeExtraData(receiver)]);
  const tx = await signer.sendTransaction({ to: CFOSWAP_ROUTER, data });
  return tx.wait(1);
}

async function callSmartSwap(
  signer: ethers.Signer, orderId: number, receiver: string,
  baseRequest: any, batchesAmount: string[], batches: any[][],
) {
  const router = new ethers.Contract(CFOSWAP_ROUTER, ROUTER_ABI, signer);
  const base = router.interface.encodeFunctionData('smartSwapTo', [
    orderId, receiver, baseRequest, batchesAmount, batches, [], // pmmRequests 空
  ]);
  const data = ethers.utils.hexConcat([base, encodeExtraData(receiver)]);
  const tx = await signer.sendTransaction({ to: CFOSWAP_ROUTER, data });
  return tx.wait(1);
}

async function callSwapWrap(
  signer: ethers.Signer, orderId: number, reversed: boolean, amount: string, mode: number,
) {
  // rawdata 编码：bit255 = reversed, bits[251:249] = mode, 低 160 位 = amount
  const rawdata = ethers.BigNumber.from(amount)
    .or(ethers.BigNumber.from(mode).shl(249))
    .or(reversed ? ethers.BigNumber.from(1).shl(255) : 0);
  const router = new ethers.Contract(CFOSWAP_ROUTER, ROUTER_ABI, signer);
  const base = router.interface.encodeFunctionData('swapWrap', [orderId, rawdata]);
  const data = ethers.utils.hexConcat([base, encodeExtraData(await signer.getAddress())]);
  const value = !reversed ? ethers.BigNumber.from(amount) : ethers.BigNumber.from(0); // ETH->WETH 携带 value
  const tx = await signer.sendTransaction({ to: CFOSWAP_ROUTER, data, value });
  return tx.wait(1);
}
```

---

## 7. 合约地址占位符汇总

部署后统一替换，建议集中在 `src/config/contracts.ts` 管理（符合「禁组件直接读 import.meta.env」规范）：

| 占位符 | 含义 |
| --- | --- |
| `{{CFOSWAP_ROUTER_ADDRESS}}` | CfoswapRouter 主路由 |
| `{{CFO_SWAP_TOKEN_ADDRESS}}` | CfoSwapToken 代币 |
| `{{CFO_MINING_POOL_ADDRESS}}` | CfoMiningPool 矿池工厂 |
| `{{CFO_SWAP_MINING_ADDRESS}}` | CfoSwapMining 挖矿奖励 |
| `{{WBNB_ADDRESS}}` | BSC WBNB（固定 `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bC9165`） |
| `{{PLATFORM_FEE_ADDR_0}}` | 平台费接收地址 0（40%） |
| `{{PLATFORM_FEE_ADDR_1}}` | 平台费接收地址 1（30%） |
| `{{PLATFORM_FEE_ADDR_2}}` | 平台费接收地址 2（30%） |

---

## 8. BSC 链固定参数

| 参数 | 值 | 备注 |
| --- | --- | --- |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bC9165` | BSC WBNB |
| USDT (BEP20) | `0x55d398326f99059fF7754853763656856b4F9646` | **18 精度**（非 6） |
| USDC (BEP20) | `0x8AC76A51cc950d9822D6b93f3ADb8f5E1DdC4369` | **18 精度**（非 6） |
| BUSD | `0xe9e7CEA3DedcA5984789aC31D91eC8b53B7BbE55` | 18 精度 |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B66B27E6F2D236C4E` | V2 路由 |
| PancakeSwap V2 Factory | `0xcA143Ce32C7985b50b4FA5d3b2E6F2D236C4E1E2` | V2 工厂（监听 PairCreated） |
| PancakeSwap V3 Router | `0x13f4EA83D57d75E54d9c2F006B7DE6C7b9E8F2A5` | V3 路由 |
| BscScan 交易链接 | `https://bscscan.com/tx/{txHash}` | 交易哈希跳转 |
| BSC 主网 Chain ID | `56` | — |

### 推荐容灾 RPC（多节点）

前端应在 `src/config/` 维护一个 RPC endpoint 列表，请求失败时自动切换：

- `https://bsc-dataseed.binance.org`
- `https://bsc-dataseed1.defibit.io`
- `https://bsc-dataseed1.ninicoin.io`
- `https://bsc.publicnode.com`
- `https://rpc.ankr.com/bsc`

### 原生币 / 包装币约定

- 原生 BNB：在合约层用 `0xEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeeeEeee` 占位（`address(0)` 将在未来移除，前端统一用 `0xEeee`）；
- BNB ↔ WBNB 互转走 `swapWrap`，不走常规 swap 入口，不触发挖矿、不收佣金。

---

## 附录：入口函数与库映射速查表

| 入口函数 | 子路由库 | pools 类型 | 是否触发挖矿通知 | 是否收佣金 |
| --- | --- | --- | --- | --- |
| `smartSwapTo` / `smartSwapByOrderId` | SmartSwapRouter | `RouterPath[][]` | 是 | 是 |
| `dagSwapTo` / `dagSwapByOrderId` | DagRouter | `RouterPath[]` | 是 | 是 |
| `unxswapTo` / `unxswapByOrderId` / `unxswapToWithBaseRequest` | UnxswapRouter | `bytes32[]` | 是 | 是 |
| `uniswapV3SwapTo` / `uniswapV3SwapToWithBaseRequest` | UnxswapV3Router | `uint256[]` | 是 | 是 |
| `swapWrap` / `swapWrapToWithBaseRequest` | SwapWrapRouter | 无（rawdata 位编码） | 否 | 否 |

> 所有入口函数修饰符：`external payable nonReentrant whenNotPaused`（`uniswapV3SwapCallback` 为 `external whenNotPaused`，无 `payable`）。
