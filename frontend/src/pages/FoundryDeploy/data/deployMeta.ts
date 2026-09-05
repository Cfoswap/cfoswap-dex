// Foundry 部署 / 绑定的硬编码元数据（按新架构：钱包签名 + 服务端 forge verify 重写）
// - 删除所有涉及 PRIVATE_KEY / RPC 传递给服务端的遗留逻辑
// - 新增 getConstructorArgsAsValues / buildArgsAsValues 返回 JS 原生类型数组（未 ABI 编码）
// - 新增 preCheck：一键关联前先查链上状态，已绑定则跳过（避免 "factory already set" 类错误）
// ----------------------------------------------------------------------------------------
import type {
  ContractMeta,
  DeployedMap,
  DeployEnvConfig as EnvCfg,
} from '../types/foundry'
import type { ethers } from 'ethers'

/** preCheck 运行时上下文（由 useBindFlow 注入） */
export type PreCheckContext = {
  /** ethers provider（用于 .call() 查链上） */
  provider: ethers.providers.Provider
  /** 当前步骤目标合约的 Interface */
  iface: ethers.utils.Interface
  /** 当前步骤目标合约地址（= deployed[BindingStep.toKey]） */
  targetAddr: string
  /** 所有已部署合约地址 */
  deployed: DeployedMap
  /** 部署参数配置 */
  env: EnvCfg
  /** 当前签名钱包地址 */
  deployerAddr: string
}

/** 返回 shouldSkip=true 表示链上已绑定，runOne 将跳过并标记 skipped */
export type PreCheckResult = { shouldSkip: boolean; reason?: string }

/** 预检函数：可选，未提供则始终执行 */
export type PreCheckFn = (ctx: PreCheckContext) => Promise<PreCheckResult>

// localStorage 持久化快照键：双源恢复（服务端 + 本地）辅存
export const DEPLOY_LOCAL_KEY = 'cfoswap:deploy:v2:hydrate' as const

// ----------------------------
// 小工具：BPS 百分比 → BPS 整数（40% → 4000）
// 新 API 里 BPS 已经是基点，所以这里不需要换算。
// 钱包为空时的回退：使用部署者地址填充
// ----------------------------
const fallback = (addr: string | undefined | null, deployer: string): string =>
  addr && /^0x[a-fA-F0-9]{40}$/.test(addr) ? addr : deployer

const BPS_SCALE = 100 // 面板上用户输入的是百分比数字（40 → 40%），内部存 BPS 需 ×100
// 注意：DeployEnvConfig.TEAM_BPS / PLATFORM_BPS 已经是 BPS（基点）

// ----------------------------
// Phase A：5 个路由库（无构造参数）
// ----------------------------
export const LIBRARY_CONTRACTS: readonly ContractMeta[] = [
  {
    id: 'lib_dag',
    name: 'CfoDagRouter',
    contract: 'src/router/router/CfoDagRouter.sol:CfoDagRouter',
    constructorArgs: [],
    category: 'Phase A',
    getConstructorArgsAsValues: () => [],
  },
  {
    id: 'lib_smart',
    name: 'CfoSmartRouter',
    contract: 'src/router/router/CfoSmartRouter.sol:CfoSmartRouter',
    constructorArgs: [],
    category: 'Phase A',
    getConstructorArgsAsValues: () => [],
  },
  {
    id: 'lib_wrap',
    name: 'CfoWrapRouter',
    contract: 'src/router/router/CfoWrapRouter.sol:CfoWrapRouter',
    constructorArgs: [],
    category: 'Phase A',
    getConstructorArgsAsValues: () => [],
  },
  {
    id: 'lib_unx',
    name: 'CfoUnxRouter',
    contract: 'src/router/router/CfoUnxRouter.sol:CfoUnxRouter',
    constructorArgs: [],
    category: 'Phase A',
    getConstructorArgsAsValues: () => [],
  },
  {
    id: 'lib_unxv3',
    name: 'CfoUnxV3Router',
    contract: 'src/router/router/CfoUnxV3Router.sol:CfoUnxV3Router',
    constructorArgs: [],
    category: 'Phase A',
    getConstructorArgsAsValues: () => [],
  },
] as const

// ----------------------------
// Phase B：3 个独立业务合约
// ----------------------------
export const STANDALONE_CONTRACTS: readonly ContractMeta[] = [
  {
    id: 'biz_token',
    name: 'CfoToken',
    contract: 'src/token/CfoToken.sol:CfoToken',
    desc: '代币全称 Cfoswap Token / 符号 CFO',
    category: 'Phase B',
    // CfoToken 为无参构造（合约内 constructor() 不接受参数）。
    // INITIAL_MINT 仍保留在配置中仅做展示说明（如需预铸可在部署后单独调用 mint）。
    constructorArgs: [],
    getConstructorArgs: () => [],
    getConstructorArgsAsValues: () => [],
  },
  {
    id: 'biz_pool',
    name: 'CfoMiningPoolFactory',
    contract: 'src/mining/CfoMiningPools.sol:CfoMiningPoolFactory',
    desc: '矿池工厂（主网交易挖矿池 + 自定义矿池）',
    category: 'Phase B',
    getConstructorArgs: () => [],
    getConstructorArgsAsValues: () => [],
  },
  {
    id: 'biz_mining',
    name: 'CfoMining',
    contract: 'src/mining/CfoMining.sol:CfoMining',
    desc: '交易挖矿主合约',
    category: 'Phase B',
    // 构造参数：uint256 vestingSeconds（天 × 86400）
    getConstructorArgs: (c) => [String((c.VESTING_DAYS || 365) * 86400)],
    getConstructorArgsAsValues: (c) => [String((c.VESTING_DAYS || 365) * 86400)],
  },
] as const

// ----------------------------
// Phase C：主路由（链接 5 个库）
// 构造：(address owner, address[3] wallets, uint256[3] bpses) — 3 个参数（其中 2 个定长数组）
// 若实际合约展开为 7 个独立参数，服务端 BuildContractInfo.constructorInputs 会决定编码方式，
// 这里只提供 值数组 的两种常见形状之一：按 3 个参数（owner + address[3] + uint256[3]）。
// 同时保留旧版 7 个扁平化字符串，供 UI 显示。
// ----------------------------
export const ROUTER_CONTRACT: ContractMeta = {
  id: 'biz_router',
  name: 'CfoRouter',
  contract: 'src/router/CfoRouter.sol:CfoRouter',
  desc: '主路由（内聚挖矿通知逻辑）',
  category: 'Phase C',
  getConstructorArgs: (cfg: EnvCfg, deployerAddr: string) => {
    const owner = deployerAddr
    const w1 = fallback(cfg.PLATFORM_WALLETS?.[0], deployerAddr)
    const w2 = fallback(cfg.PLATFORM_WALLETS?.[1], deployerAddr)
    const w3 = fallback(cfg.PLATFORM_WALLETS?.[2], deployerAddr)
    const bps0 = String(cfg.PLATFORM_BPS?.[0] ?? 40 * BPS_SCALE)
    const bps1 = String(cfg.PLATFORM_BPS?.[1] ?? 30 * BPS_SCALE)
    const bps2 = String(cfg.PLATFORM_BPS?.[2] ?? 30 * BPS_SCALE)
    // 旧版 UI 显示：7 个扁平参数
    return [owner, w1, w2, w3, bps0, bps1, bps2]
  },
  getConstructorArgsAsValues: (cfg: EnvCfg, deployerAddr: string) => {
    const owner = deployerAddr
    const wallets: [string, string, string] = [
      fallback(cfg.PLATFORM_WALLETS?.[0], deployerAddr),
      fallback(cfg.PLATFORM_WALLETS?.[1], deployerAddr),
      fallback(cfg.PLATFORM_WALLETS?.[2], deployerAddr),
    ]
    const bpses: [string, string, string] = [
      String(cfg.PLATFORM_BPS?.[0] ?? 40 * BPS_SCALE),
      String(cfg.PLATFORM_BPS?.[1] ?? 30 * BPS_SCALE),
      String(cfg.PLATFORM_BPS?.[2] ?? 30 * BPS_SCALE),
    ]
    // 3 个参数：owner + address[3] + uint256[3]
    // （若服务端 BuildContractInfo.constructorInputs 显示为 7 个扁平参数，
    //  useDeployFlow 里会按 constructorInputs.length 动态展开为 7 flat）
    return [owner, wallets, bpses] as const
  },
} as const

/** 9 合约完整列表（按部署顺序） */
export const ALL_CONTRACTS: readonly ContractMeta[] = [
  ...LIBRARY_CONTRACTS,
  ...STANDALONE_CONTRACTS,
  ROUTER_CONTRACT,
] as const

/**
 * 前端业务别名（DeployedMap key）→ 服务端 CONTRACTS.key（真实合约名）映射表。
 * 用途：useDeployFlow.deployOne / useDeployApi 等在查询 BuildContractInfo 时，
 *       服务端返回的 key 字段是「合约名」（如 CfoDagRouter），而前端流转的是「业务别名」（如 lib_dag），
 *       必须通过此表完成一次转换，否则 find 匹配不到。
 * 新增合约时同步在此追加 1 行。
 */
export const ALIAS_TO_CONTRACT_KEY: Readonly<Record<keyof DeployedMap, string>> = {
  lib_dag: 'CfoDagRouter',
  lib_smart: 'CfoSmartRouter',
  lib_wrap: 'CfoWrapRouter',
  lib_unx: 'CfoUnxRouter',
  lib_unxv3: 'CfoUnxV3Router',
  biz_token: 'CfoToken',
  biz_pool: 'CfoMiningPoolFactory',
  biz_mining: 'CfoMining',
  biz_router: 'CfoRouter',
} as const

/** 9 合约 ID → 序号 */
export const CONTRACT_INDEX: Readonly<Record<keyof DeployedMap, number>> = ALL_CONTRACTS.reduce(
  (acc, cur, idx) => {
    acc[cur.id] = idx + 1
    return acc
  },
  {} as Record<keyof DeployedMap, number>
)

// ----------------------------
// 链上预检辅助函数（preCheck 通用模板）
// ----------------------------

/**
 * 查某个 viewSig 返回值 === expected（或包含 expected 地址）→ 已绑定→跳过。
 * 适用于 D2/D3/D4/D5/D6/D7/D8 这类简单单 view 查询场景。
 */
function skipIfViewEq(viewSig: string, expectedFn: (d: DeployedMap, c: EnvCfg, deployer: string) => unknown): PreCheckFn {
  return async (ctx) => {
    const data = ctx.iface.encodeFunctionData(viewSig)
    let ret: string
    try {
      ret = await ctx.provider.call({ to: ctx.targetAddr, data })
    } catch {
      // 查询失败 → 不跳过，让主流程尝试执行
      return { shouldSkip: false }
    }
    const decoded = ctx.iface.decodeFunctionResult(viewSig, ret)
    const expected = expectedFn(ctx.deployed, ctx.env, ctx.deployerAddr)
    const actual = decoded[0]
    // 地址比较：都是 0x 开头小写
    const eq = typeof actual === 'string' && typeof expected === 'string'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected
    if (eq) {
      const pretty = typeof actual === 'string' && actual.startsWith('0x')
        ? actual.slice(0, 6) + '…' + actual.slice(-4)
        : String(actual)
      return { shouldSkip: true, reason: `已绑定（${viewSig}=${pretty}）` }
    }
    return { shouldSkip: false }
  }
}

/**
 * 检查白名单数组（allowedCallersCount + 遍历 allowedCallers(uint256)）是否包含目标地址。
 * 适用于 D10/D11 的 addCaller 场景。
 */
function skipIfInAllowlist(checkAddrKey: keyof DeployedMap): PreCheckFn {
  return async (ctx) => {
    const checkAddr = ctx.deployed[checkAddrKey]
    if (!checkAddr) return { shouldSkip: false }
    // 第一步：查 count
    const countData = ctx.iface.encodeFunctionData('allowedCallersCount()')
    let countRet: string
    try {
      countRet = await ctx.provider.call({ to: ctx.targetAddr, data: countData })
    } catch {
      return { shouldSkip: false }
    }
    const [countBN] = ctx.iface.decodeFunctionResult('allowedCallersCount()', countRet) as [ethers.BigNumber]
    const count = countBN.toNumber()
    // 第二步：遍历查每个索引
    for (let i = 0; i < count; i += 1) {
      const oneData = ctx.iface.encodeFunctionData('allowedCallers(uint256)', [i])
      let oneRet: string
      try {
        oneRet = await ctx.provider.call({ to: ctx.targetAddr, data: oneData })
      } catch {
        continue
      }
      const [addr] = ctx.iface.decodeFunctionResult('allowedCallers(uint256)', oneRet) as [string]
      if (addr.toLowerCase() === checkAddr.toLowerCase()) {
        return { shouldSkip: true, reason: `已在白名单中（索引 ${i}）` }
      }
    }
    return { shouldSkip: false }
  }
}

// ----------------------------
// 12 绑定 + 可选 4 条 transferOwnership
// 每个 BindingStep 额外带 buildArgsAsValues：返回 JS 原生值数组（未 ABI 编码，按 ABI 函数参数个数）
// ----------------------------
export type BindingStep = {
  readonly id: string
  readonly label: string
  readonly toKey: keyof DeployedMap
  readonly sig: string
  /**
   * 【可选】链上预检：runOne 执行前先查链上状态。
   *  返回 { shouldSkip: true } 则跳过该步骤并在 UI 显示「已绑定·跳过」。
   *  不提供则始终执行。
   */
  readonly preCheck?: PreCheckFn
  /**
   * 【旧版兼容】返回扁平字符串数组（显示用）。
   *  对 address[3] 会把 3 个地址拆开追加，对 uint256[3] 同理。
   *  第三参数 deployerAddr 用于地址为空时回退到签名者钱包。
   */
  readonly buildArgs: (c: EnvCfg, d: DeployedMap, deployerAddr?: string) => readonly string[]
  /**
   * 【新版核心】返回 JS 原生值数组（函数参数个数）：
   *  对 setTeamDistribution(address[3],uint256[3]) 返回长度 2 的数组：
   *    [ [addr0,addr1,addr2], [bps0,bps1,bps2] ]
   *  第三参数 deployerAddr 用于地址为空时回退到签名者钱包。
   */
  readonly buildArgsAsValues: (c: EnvCfg, d: DeployedMap, deployerAddr?: string) => readonly unknown[]
}

export const BINDING_STEPS: readonly BindingStep[] = [
  // D1-D3 Token
  {
    id: 'D1',
    label: 'Token.setTeamDistribution（税费 3 地址 / 40·30·30 内部转基点）',
    toKey: 'biz_token',
    sig: 'setTeamDistribution(address[3],uint256[3])',
    preCheck: async (ctx) => {
      // teamWallets(uint256)(address) 是 mapping，查 3 个索引
      const expectedW0 = ctx.env.TEAM_WALLETS?.[0] || ctx.deployerAddr
      const expectedW1 = ctx.env.TEAM_WALLETS?.[1] || ctx.deployerAddr
      const expectedW2 = ctx.env.TEAM_WALLETS?.[2] || ctx.deployerAddr
      const indexes = [0n, 1n, 2n]
      let allMatch = true
      const actuals: string[] = []
      for (const idx of indexes) {
        const data = ctx.iface.encodeFunctionData('teamWallets(uint256)', [idx])
        let ret: string
        try {
          ret = await ctx.provider.call({ to: ctx.targetAddr, data })
        } catch {
          allMatch = false
          break
        }
        const [addr] = ctx.iface.decodeFunctionResult('teamWallets(uint256)', ret) as [string]
        actuals.push(addr)
        const expected = idx === 0n ? expectedW0 : idx === 1n ? expectedW1 : expectedW2
        if (addr.toLowerCase() !== expected.toLowerCase()) {
          allMatch = false
          break
        }
      }
      if (allMatch) {
        return { shouldSkip: true, reason: '已绑定（teamWallets[0..2] 全部匹配）' }
      }
      return { shouldSkip: false }
    },
    buildArgs: (c: EnvCfg, _d: DeployedMap, deployer = '') => {
      const wallets = c.TEAM_WALLETS || []
      const bps = c.TEAM_BPS || []
      return [
        fallback(wallets[0], deployer),
        fallback(wallets[1], deployer),
        fallback(wallets[2], deployer),
        String(bps[0] ?? 40 * BPS_SCALE),
        String(bps[1] ?? 30 * BPS_SCALE),
        String(bps[2] ?? 30 * BPS_SCALE),
      ]
    },
    buildArgsAsValues: (c: EnvCfg, _d: DeployedMap, deployer = '') => {
      const wallets: [string, string, string] = [
        fallback(c.TEAM_WALLETS?.[0], deployer),
        fallback(c.TEAM_WALLETS?.[1], deployer),
        fallback(c.TEAM_WALLETS?.[2], deployer),
      ]
      const bpses: [string, string, string] = [
        String(c.TEAM_BPS?.[0] ?? 40 * BPS_SCALE),
        String(c.TEAM_BPS?.[1] ?? 30 * BPS_SCALE),
        String(c.TEAM_BPS?.[2] ?? 30 * BPS_SCALE),
      ]
      return [wallets, bpses] as const
    },
  },
  {
    id: 'D2',
    label: 'Token.setMainMiningContract → CfoMining',
    toKey: 'biz_token',
    sig: 'setMainMiningContract(address)',
    preCheck: skipIfViewEq('mainMiningContract()', (d) => d.biz_mining),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining],
  },
  {
    id: 'D3',
    label: 'Token.setTaxEnabled(true) 开启交易税',
    toKey: 'biz_token',
    sig: 'setTaxEnabled(bool)',
    preCheck: skipIfViewEq('taxEnabled()', () => true),
    buildArgs: () => ['true'],
    buildArgsAsValues: () => [true],
  },
  // D4-D6 PoolFactory
  {
    id: 'D4',
    label: 'PoolFactory.setCfoToken → Token地址',
    toKey: 'biz_pool',
    sig: 'setCfoToken(address)',
    preCheck: skipIfViewEq('cfoToken()', (d) => d.biz_token),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_token],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_token],
  },
  {
    id: 'D5',
    label: 'PoolFactory.setCfoMining → Mining地址',
    toKey: 'biz_pool',
    sig: 'setCfoMining(address)',
    preCheck: skipIfViewEq('cfoMining()', (d) => d.biz_mining),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining],
  },
  {
    id: 'D6',
    label: 'PoolFactory.setBoostFeeRecipient → 助力费地址（优先读配置 BOOST_FEE_RECIPIENT，留空则使用部署者钱包）',
    toKey: 'biz_pool',
    sig: 'setBoostFeeRecipient(address)',
    preCheck: skipIfViewEq('boostFeeRecipient()', (_d, c, deployer) => {
      const v = c.BOOST_FEE_RECIPIENT && /^0x[a-fA-F0-9]{40}$/.test(c.BOOST_FEE_RECIPIENT)
        ? c.BOOST_FEE_RECIPIENT
        : deployer
      return v
    }),
    buildArgs: (c, _d, deployer = '') => {
      const v = c.BOOST_FEE_RECIPIENT && /^0x[a-fA-F0-9]{40}$/.test(c.BOOST_FEE_RECIPIENT)
        ? c.BOOST_FEE_RECIPIENT
        : (deployer || '')
      return [v]
    },
    buildArgsAsValues: (c, _d, deployer = '') => {
      const v = c.BOOST_FEE_RECIPIENT && /^0x[a-fA-F0-9]{40}$/.test(c.BOOST_FEE_RECIPIENT)
        ? c.BOOST_FEE_RECIPIENT
        : (deployer || '')
      return [v]
    },
  },
  // D7-D8 CfoMining
  {
    id: 'D7',
    label: 'CfoMining.setCfoToken → Token地址',
    toKey: 'biz_mining',
    sig: 'setCfoToken(address)',
    preCheck: skipIfViewEq('cfoToken()', (d) => d.biz_token),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_token],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_token],
  },
  {
    id: 'D8',
    label: 'CfoMining.setMiningPoolFactory → PoolFactory地址',
    toKey: 'biz_mining',
    sig: 'setMiningPoolFactory(address)',
    preCheck: skipIfViewEq('miningPoolFactory()', (d) => d.biz_pool),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_pool],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_pool],
  },
  // D9 Router
  {
    id: 'D9',
    label: 'Router.setMiningTargets（双目标 Mining + PoolFactory）',
    toKey: 'biz_router',
    sig: 'setMiningTargets(address,address)',
    preCheck: async (ctx) => {
      // 查 Router.cfoMining() 和 Router.miningPoolFactory()，两个都匹配才跳过
      const expectedMining = ctx.deployed.biz_mining?.toLowerCase()
      const expectedPool = ctx.deployed.biz_pool?.toLowerCase()
      // 查 mining 地址
      const mData = ctx.iface.encodeFunctionData('cfoMining()')
      let mRet: string
      try { mRet = await ctx.provider.call({ to: ctx.targetAddr, data: mData }) } catch { return { shouldSkip: false } }
      const [actualMining] = ctx.iface.decodeFunctionResult('cfoMining()', mRet) as [string]
      if (actualMining.toLowerCase() !== expectedMining) return { shouldSkip: false }
      // 查 pool 地址
      const pData = ctx.iface.encodeFunctionData('miningPoolFactory()')
      let pRet: string
      try { pRet = await ctx.provider.call({ to: ctx.targetAddr, data: pData }) } catch { return { shouldSkip: false } }
      const [actualPool] = ctx.iface.decodeFunctionResult('miningPoolFactory()', pRet) as [string]
      if (actualPool.toLowerCase() !== expectedPool) return { shouldSkip: false }
      return { shouldSkip: true, reason: '已绑定（cfoMining + miningPoolFactory 双目标匹配）' }
    },
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining, d.biz_pool],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining, d.biz_pool],
  },
  // D10-D11 白名单
  {
    id: 'D10',
    label: 'CfoMining.addCaller(Router) 授权挖矿调用',
    toKey: 'biz_mining',
    sig: 'addCaller(address)',
    preCheck: skipIfInAllowlist('biz_router'),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_router],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_router],
  },
  {
    id: 'D11',
    label: 'PoolFactory.addCaller(Router) 授权矿池转发调用',
    toKey: 'biz_pool',
    sig: 'addCaller(address)',
    preCheck: skipIfInAllowlist('biz_router'),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_router],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_router],
  },
  {
    id: 'D12',
    label: 'PoolFactory.addCaller(CfoMining) 授权邀请关系绑定',
    toKey: 'biz_pool',
    sig: 'addCaller(address)',
    preCheck: skipIfInAllowlist('biz_mining'),
    buildArgs: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining],
    buildArgsAsValues: (_c: EnvCfg, d: DeployedMap) => [d.biz_mining],
  },
] as const

export type OwnershipTransfer = {
  readonly id: string
  readonly label: string
  readonly toKey: keyof DeployedMap
  readonly sig: 'transferOwnership(address)'
}

/** 可选 D13-16: 若配置 SAFE_ADDRESS 则追加执行 */
export const OWNER_TRANSFERS: readonly OwnershipTransfer[] = [
  { id: 'D13', label: 'Token.transferOwnership → Gnosis Safe', toKey: 'biz_token', sig: 'transferOwnership(address)' },
  { id: 'D14', label: 'PoolFactory.transferOwnership → Safe', toKey: 'biz_pool', sig: 'transferOwnership(address)' },
  { id: 'D15', label: 'CfoMining.transferOwnership → Safe', toKey: 'biz_mining', sig: 'transferOwnership(address)' },
  { id: 'D16', label: 'Router.transferOwnership → Safe', toKey: 'biz_router', sig: 'transferOwnership(address)' },
] as const

/**
 * 默认配置（一键填充）。
 * 新字段：数组形式的钱包/BPS；比例按 40/30/30（已转为 BPS 基点：×100）。
 */
export const DEFAULT_ENV_CFG: EnvCfg = {
  RPC_URL: 'https://bsc.publicnode.com',
  BSCSCAN_API_KEY: 'BUKW8ENCENXVTZ48G9RSXAV3CW9HYY75R7',
  TEAM_WALLETS: [
    '0x030eafef7ed7fbaf0749a8593c49f6233bd38a7b',
    '0x69af68026a9ed4fc32e0d358568695e8f7c7233a',
    '0x106507feb15866bbcb8c2f70b1b4ffe10e180ed6',
  ],
  TEAM_BPS: [40 * BPS_SCALE, 30 * BPS_SCALE, 30 * BPS_SCALE],
  PLATFORM_WALLETS: [
    '0x072f9f2869e62bdf119ee76de7189a1be05b1498',
    '0x7078a4ed4e8c7f3a308e7b64180905565ce79f4f',
    '0x0f5ce6f88deb316d9217e89719af8cfc69513db7',
  ],
  PLATFORM_BPS: [40 * BPS_SCALE, 30 * BPS_SCALE, 30 * BPS_SCALE],
  BOOST_FEE_RECIPIENT: '0x6f6bce96ebb81a74c35cb84426f596befbe26e1d',
  VESTING_DAYS: 365,
  SAFE_ADDRESS: '',
  INITIAL_MINT: '0',
} as const
