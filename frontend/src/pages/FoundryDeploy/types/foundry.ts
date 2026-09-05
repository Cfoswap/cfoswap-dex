// Foundry 部署模块通用类型定义（按新架构：钱包签名 + 服务端 forge verify 重写）
// 严格 TS：禁 any，单文件单类型语义清晰
// ---------------------------------------------------------------------

/** 部署步骤的状态枚举（图标对应） */
export type StepStatus = 'idle' | 'pending' | 'running' | 'success' | 'error' | 'skipped'

// ============================================================
// 1. 环境配置（与 GET / POST /api/env 字段严格对齐：无 PRIVATE_KEY）
// ============================================================
/** BPS 基点：1 BPS = 0.01%。所以 40% = 4000 BPS。 */
export type Bps = number
/** 以太坊地址：0x 前缀 42 字符字符串（未校验 checksum，交给链上验证）。 */
export type EthAddress = string

export type DeployEnvConfig = {
  RPC_URL: string
  BSCSCAN_API_KEY: string
  /** 税费 3 钱包（Token.setTeamDistribution 的 address[3]） */
  TEAM_WALLETS: [EthAddress, EthAddress, EthAddress]
  /** 税费 3 钱包的 BPS 分配（总和应为 10000 = 100%） */
  TEAM_BPS: [Bps, Bps, Bps]
  /** 平台费 3 钱包（Router 构造参数的 address[3]） */
  PLATFORM_WALLETS: [EthAddress, EthAddress, EthAddress]
  /** 平台费 3 钱包的 BPS 分配（总和应为 10000） */
  PLATFORM_BPS: [Bps, Bps, Bps]
  /** 助力金接收地址（CfoMiningPoolFactory.setBoostFeeRecipient；留空则绑定步骤自动使用签名钱包地址） */
  BOOST_FEE_RECIPIENT: EthAddress
  /** 主矿池线性解锁天数（部署时自动 × 86400 转秒） */
  VESTING_DAYS: number
  /** Gnosis Safe 多签地址（选填；填写后绑定步骤追加 4 条 transferOwnership） */
  SAFE_ADDRESS: EthAddress
  /** Token 初始铸造量（wei；按字符串存避免大整数精度问题也可，但接口定义为 number/string，这里用 string 兼容 JS 数字精度） */
  INITIAL_MINT: string
}

/**
 * 兼容旧 EnvCfg 别名（DeployPanel/BindingPanel 里少改点引用，
 * 实际字段按 DeployEnvConfig。后续面板会通过适配函数读数组字段。）
 */
export type EnvCfg = DeployEnvConfig

// ============================================================
// 2. 9 合约部署结果地址 key 映射（保持不变，Phase A 5 库 + Phase B 3 + Phase C 1）
// ============================================================
export type DeployedMap = {
  lib_dag: string
  lib_smart: string
  lib_wrap: string
  lib_unx: string
  lib_unxv3: string
  biz_token: string
  biz_pool: string
  biz_mining: string
  biz_router: string
}

// ============================================================
// 3. 合约编译构建信息（对应 GET /api/build/contracts 返回项）
// ============================================================
export type BuildContractInfo = {
  /**
   * 服务端 CONTRACTS.key（真实合约名字符串，如 'CfoDagRouter' | 'CfoRouter'）。
   * ⚠️ 注意：前端流转的「业务别名」是 DeployedMap key（如 'lib_dag' | 'biz_router'），
   *       查询 BuildContractInfo 时必须先通过 ALIAS_TO_CONTRACT_KEY[alias] 转为合约名再匹配。
   */
  readonly key: string
  /** 合约名（如 CfoDagRouter / CfoRouter），与 deployMeta.name 可交叉校验 */
  readonly name: string
  /** 源码相对路径，如 src/router/router/CfoDagRouter.sol */
  readonly srcPath: string
  /** 完整合约 ABI（JSON 数组） */
  readonly abi: readonly unknown[]
  /** 构造参数输入描述数组（每一项含 name/type/internalType 等，等同 ABI 的 constructor inputs） */
  readonly constructorInputs: readonly {
    readonly name: string
    readonly type: string
    readonly internalType?: string
  }[]
  /** 创建字节码（0x 前缀。CfoRouter 为含 __$占位符$__ 的未链接版本） */
  readonly bytecode: string
  /** 是否需要链接（仅 CfoRouter = true） */
  readonly requiresLinking: boolean
  /** 部署阶段 */
  readonly phase: 'A' | 'B' | 'C'
  /** 部署顺序（1..9） */
  readonly order: number
  /** 链接依赖的库名数组（仅 CfoRouter 有值：5 个库的合约名） */
  readonly libraryDeps?: readonly string[]
}

// ============================================================
// 4. 合约部署元类型（deployMeta.ts 中使用）
//    getConstructorArgs 返回字符串数组（旧 API 兼容显示用），
//    新增 getConstructorArgsAsValues 返回 JS 原生类型数组（用于 ABI encode）。
// ============================================================
export type ContractMeta = {
  readonly id: keyof DeployedMap
  readonly name: string
  readonly contract: string
  readonly desc?: string
  readonly category: 'Phase A' | 'Phase B' | 'Phase C'
  readonly constructorArgs?: readonly string[]
  /**
   * 【旧版兼容】返回字符串数组（用于 DeployPanel 展示构造参数预览）。
   */
  readonly getConstructorArgs?: (
    cfg: DeployEnvConfig,
    deployerAddr: string,
    deployed: DeployedMap
  ) => string[]
  /**
   * 【新版核心】返回 JS 原生类型值数组（未编码），直接喂给 ethers ABI encoder：
   *  - address  → '0x...'
   *  - uint256  → 字符串 '123456789' 或 number（小整数）
   *  - address[3] / uint256[3] → 原生数组 ['0x...','0x...','0x...']
   *  - bool     → true / false
   */
  readonly getConstructorArgsAsValues?: (
    cfg: DeployEnvConfig,
    deployerAddr: string,
    deployed: DeployedMap
  ) => readonly unknown[]
}

// ============================================================
// 5. 部署 / 绑定步骤运行时状态（保持旧结构兼容 UI）
// ============================================================
/** 单个部署步骤运行时状态（DeployPanel / ResultPanel 使用） */
export type DeployStepState = {
  status: StepStatus
  address: string
  txHash: string
  /** 日志输出（保留） */
  output: string
  /** 兼容旧字段：-1 表示错误，0 表示成功，null 表示未执行 */
  exitCode: number | null
  elapsedMs: number
  startedAt: number | null
  endedAt: number | null
  /** 该合约提交的 Sourcify verify 任务 id（轮询 GET /api/forge/verify/:id 用） */
  verifyTaskId?: string
  /** Sourcify 开源验证状态（轮询回写；undefined = 未提交/未知） */
  verifyStatus?: VerifyTaskStatus
  /** 验证结果摘要（服务端 tail：成功匹配信息或失败原因） */
  verifyMessage?: string
}

/** 单个绑定步骤运行时状态（BindingPanel / ResultPanel 使用） */
export type BindStepState = {
  status: StepStatus
  txHash: string
  output: string
  exitCode: number | null
  elapsedMs: number
  startedAt: number | null
  endedAt: number | null
}

// ============================================================
// 6. 服务端 API 响应类型（按新 8 个 API 接口定义）
// ============================================================
/** GET /health */
export type HealthResp = {
  status: 'ok' | string
  forgePath: string
  castPath: string
  pwd: string
}

/** POST /api/build/router-bytecode body */
export type RouterLibraries = {
  CfoDagRouter: string
  CfoSmartRouter: string
  CfoWrapRouter: string
  CfoUnxRouter: string
  CfoUnxV3Router: string
}

/** POST /api/build/router-bytecode response */
export type RouterBytecodeResp = {
  bytecode: string
}

// ============================================================
// 7. Forge Verify 任务
// ============================================================
/** POST /api/forge/verify body（服务端自动按构造参数类型 + libraries 做编码） */
export type VerifyRequestBody = {
  /** 部署后合约地址 */
  address: string
  /**
   * 服务端 CONTRACTS.key（真实合约名，如 'CfoRouter'）。
   * 前端提交前必须通过 ALIAS_TO_CONTRACT_KEY[deployedMapKey] 转换。
   */
  contractKey: string
  /** 构造参数值数组（字符串数组形式；服务端按 BuildContractInfo.constructorInputs[i].type 自动 ABI 编码拼接） */
  constructorArgs?: readonly string[]
  /** 链接库名 → 地址（仅 CfoRouter 需要） */
  libraries?: Partial<RouterLibraries>
  /** chainId（固定 56，但服务端还是显式收一次） */
  chainId: number
}

/** POST /api/forge/verify response（异步任务已提交） */
export type VerifySubmitResp = {
  ok: true
  id: string
  sourcifyStatus: 'pending' | string
}

/** GET /api/forge/verify/:id response */
export type VerifyTaskStatus = 'running' | 'success' | 'failed'
export type VerifyTask = {
  id: string
  /** 真实合约名（同服务端 CONTRACTS.key），如 'CfoRouter' */
  contractKey: string
  status: VerifyTaskStatus
  stdout?: string
  stderr?: string
}

export type VerifyStatusResp = {
  ok?: boolean
  status: VerifyTaskStatus
  /** 服务端人类可读结果摘要（成功匹配信息 / 失败原因） */
  tail?: string
  stdoutPreview?: string
  stderrPreview?: string
  contractKey?: string
  address?: string
  /** 404 等错误响应时的错误信息 */
  error?: string
}

/** POST /api/forge/verify/retry-all 响应 */
export type RetryAllVerifyItem = {
  id: string
  contractKey: string
  /** DeployedMap 别名（lib_dag / biz_router 等） */
  alias: string
  address: string
}
export type RetryAllVerifySkipped = {
  contractKey: string
  alias: string | null
  reason: string
}
export type RetryAllVerifyResp = {
  ok: boolean
  total: number
  note?: string
  submitted: RetryAllVerifyItem[]
  skipped: RetryAllVerifySkipped[]
}

// ============================================================
// 8. 结果读写（/api/deployer/result，结构保持向上兼容）
// ============================================================
export type DeployerResultResp = {
  ok: boolean
  data: unknown
  exists: boolean
}

// ============================================================
// 9. Toast 提示（页面共享）
// ============================================================
export type ToastKind = 'success' | 'error' | 'info' | 'warning'
export type ToastItem = {
  id: number
  kind: ToastKind
  message: string
}
