// 【按新架构重写】Tab1：环境配置面板
// - 删除 PRIVATE_KEY / CHAIN_ID / ROUTER_OWNER 字段
// - 在表单顶部添加「钱包状态」卡片（使用项目全局 useWallet）
// - 配置分组：链与 BscScan / 税费 Team / 平台费 Platform / 解锁 & 助力金 & 初始铸造 & Safe
// - 所有比例字段 UI 以「百分比（%）」展示，内部按 BPS（×100）存入 DeployEnvConfig
// ---------------------------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DeployEnvConfig as EnvCfg, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'
import { DEFAULT_ENV_CFG } from '../data/deployMeta'
import { useDeployApi } from '../hooks/useDeployApi'
import { useWallet } from '@/hooks/useWallet'
import CopyableAddress from '@/components/common/CopyableAddress'

const BPS_SCALE = 100 // UI % → 内部 BPS 基点换算

// 合法 EVM 地址：0x + 40 位 hex，不强制大小写（checksum 大小写混合合法）
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

// ----------- 中文文案常量 -----------
const COPY: {
  readonly title: string
  readonly subtitle: string
  readonly fillDefaults: string
  readonly save: string
  readonly groups: {
    readonly chain: string
    readonly tax: string
    readonly platform: string
    readonly vesting: string
  }
  readonly taxSumHint: string
  readonly platformSumHint: string
  readonly saveOK: string
  readonly walletCard: {
    readonly title: string
    readonly connected: string
    readonly wrongChain: string
    readonly disconnected: string
    readonly connectBtn: string
    readonly switchBtn: string
    readonly addressLabel: string
    readonly chainLabel: string
  }
} = {
  title: '⚙️ 参数配置 (.env)',
  subtitle: '按分组填写即可；前端仅保存配置到服务端 .env（**全程不触碰私钥**）。部署/绑定交易由你自己的钱包签名发送，链上确认后服务端异步执行 forge verify 开源。',
  fillDefaults: '🎯 一键填充默认值',
  save: '💾 保存配置到服务端',
  groups: {
    chain: '🔗 链节点 & BscScan',
    tax: '💰 税费 Team（Token.setTeamDistribution · address[3] + uint256[3] BPS）',
    platform: '🏢 平台费 Platform（Router 构造 · address[3] + uint256[3] BPS）',
    vesting: '🔒 解锁期 & 初始铸造 & 多签移交',
  },
  taxSumHint: '三项比例之和必须等于 100%（UI 百分比 → 自动 ×100 存为 BPS 基点）',
  platformSumHint: '三项比例之和必须等于 100%（UI 百分比 → 自动 ×100 存为 BPS 基点）',
  saveOK: '✅ 配置保存成功',
  walletCard: {
    title: '👛 钱包状态（部署 & 绑定交易由下方钱包签名发送）',
    connected: '✅ 已连接',
    wrongChain: '⚠️ 链错误',
    disconnected: '⚪ 未连接',
    connectBtn: '🔌 连接钱包（MetaMask / OKX Wallet）',
    switchBtn: '🔀 切到 BSC 主网（chainId 56）',
    addressLabel: '连接地址：',
    chainLabel: '当前链：',
  },
}

export type ConfigPanelProps = {
  readonly env: EnvCfg
  readonly onChange: (next: EnvCfg) => void
  readonly notify: (kind: ToastKind, message: string) => void
}

function pctFromBps(bps: number): string {
  const v = bps / BPS_SCALE
  return Number.isFinite(v) ? String(v) : '0'
}
function bpsFromPctInput(pctStr: string): number {
  const v = parseFloat(pctStr)
  if (!Number.isFinite(v)) return 0
  return Math.round(v * BPS_SCALE)
}

/**
 * F-5 修复（v2）：三项 BPS 百分比输入 → 保证和严格等于 10000 BPS = 100%
 * 规则（总和 >10000 时**按比例压缩前两项**，杜绝 60+70+0=130% 写入合约）：
 *   1. 每项先单项 clamp [0, 10000]
 *   2. 若用户手动改 p2 且正好 b0+b1+b2Input===10000 → 尊重原值
 *   3. 否则先算 c2 = max(0, 10000-c0-c1)，再检查总和：
 *        - 总和 == 10000 → 直接返回
 *        - 总和 > 10000 且 c0+c1 >= 10000 → c0:c1 按比例缩放至和=10000，c2=0（最后一项吸收舍入误差保精确）
 *        - 总和 > 10000 且 c0+c1 < 10000 → 只裁剪 c2 到 10000-c0-c1
 *        - 总和 < 10000 → 差额补到 c2（让最后一项兜底）
 */
function computeNormalizedBpsTripleFromPct(
  p0Str: string,
  p1Str: string,
  p2Str: string
): [number, number, number] {
  const b0 = bpsFromPctInput(p0Str)
  const b1 = bpsFromPctInput(p1Str)
  const b2Input = bpsFromPctInput(p2Str)
  const c0 = Math.max(0, Math.min(10000, b0))
  const c1 = Math.max(0, Math.min(10000, b1))
  let c2: number
  if (b0 + b1 + b2Input === 10000) c2 = b2Input
  else c2 = Math.max(0, 10000 - c0 - c1)
  c2 = Math.max(0, Math.min(10000, c2))
  const preSum = c0 + c1 + c2
  if (preSum === 10000) return [c0, c1, c2]
  if (preSum > 10000) {
    if (c0 + c1 >= 10000) {
      const sum = c0 + c1
      let s0 = Math.round((c0 * 10000) / sum)
      let s1 = 10000 - s0 // s1 吸收舍入误差
      // 边界防护：极端舍入导致 s1 负或 s0 越界
      if (s0 > 10000) { s0 = 10000; s1 = 0 }
      if (s1 < 0) { s0 += s1; s1 = 0 } // s1<0 等价于把差额从 s0 扣回
      return [s0, s1, 0]
    }
    const trimmed2 = 10000 - c0 - c1
    return [c0, c1, Math.max(0, trimmed2)]
  }
  const gap = 10000 - preSum
  return [c0, c1, c2 + gap]
}
// UI 百分比展示（保留 2 位小数）
function fmtPctFromBps(bps: number): string {
  const v = bps / BPS_SCALE
  if (!Number.isFinite(v)) return '0'
  // 整数就不带小数
  if (Math.round(v) === v) return String(Math.round(v))
  return String(Math.round(v * 100) / 100)
}

/** Tab1：参数配置表单（按新架构：无 PRIVATE_KEY + 顶部钱包卡片） */
function ConfigPanel({ env, onChange, notify }: ConfigPanelProps): JSX.Element {
  const { saveEnv } = useDeployApi()
  const [saving, setSaving] = useState(false)

  // 全局钱包 Hook
  const { isConnected, account, chainId, connectWallet, switchChain } = useWallet()
  const [connecting, setConnecting] = useState(false)
  const [switching, setSwitching] = useState(false)

  // F-5：BPS 三元组本地 pct 字符串（真实 env.BPS 在 onChange 时归一化写入）。
  // UI 上保持用户正在输入的原始字符串，只有在失焦/提交时再归一化 → 避免输入抖动。
  const pctStr = (arr: readonly number[]): [string, string, string] => [
    fmtPctFromBps(arr[0] ?? 0),
    fmtPctFromBps(arr[1] ?? 0),
    fmtPctFromBps(arr[2] ?? 0),
  ]
  const [teamPct, setTeamPct] = useState<[string, string, string]>(() => pctStr(env.TEAM_BPS))
  const [platformPct, setPlatformPct] = useState<[string, string, string]>(() => pctStr(env.PLATFORM_BPS))
  // F-4 + 需求改：INITIAL_MINT UI 以「枚」为单位显示（用户填 1 = 1 枚 CFO），内部存 wei 字符串
  // 换算：wei = 枚 × 1e18（CFO 18 位小数）
  // —— 必须全程零浮点（BigInt/纯字符串），否则 10000*1e18.toString()='1e+22' 科学计数法会被正则拦截
  //    同时避免 parseFloat(超大值) 变 Infinity 导致回显'0'
  const CFO_DECIMALS = 18
  const ONE_CFO_BI = 10n ** BigInt(CFO_DECIMALS)
  /** 正整数无前导零字符串（0 -> '0'，其它去掉左侧多余的 0） */
  const normIntStr = (s: string): string => {
    if (!s) return '0'
    // 仅数字正则保证安全，不接受负号/小数点
    if (!/^[0-9]+$/.test(s)) return '0'
    let i = 0
    while (i < s.length - 1 && s[i] === '0') i++
    return s.slice(i) || '0'
  }
  /** wei（纯整数字符串，不可空） → 枚字符串（人类可读；整数直接显示；小数最多 4 位避免长串抖动） */
  const mintCfoFromWei = (weiStr: string): string => {
    const wei = normIntStr(weiStr || '0')
    try {
      const weiBi = BigInt(wei)
      const whole = weiBi / ONE_CFO_BI
      const frac = weiBi % ONE_CFO_BI
      if (frac === 0n) return whole.toString()
      // 小数部分固定 18 位，左补零对齐
      const fracPadded = frac.toString().padStart(CFO_DECIMALS, '0')
      // 最多取 4 位，去掉 trailing zero
      let frac4 = fracPadded.slice(0, 4)
      while (frac4.endsWith('0')) frac4 = frac4.slice(0, -1)
      return `${whole.toString()}${frac4 ? '.' + frac4 : ''}`
    } catch {
      return '0'
    }
  }
  /**
   * 枚字符串 → wei 字符串（纯整数，无小数点）
   * 算法（零浮点，BigInt 精确）：
   *   "123.45" -> integer='123', frac='45'
   *   frac 不足 18 位 → 右补零；超过 18 位 → 取前 19 位做四舍五入到第 18 位（BigInt 进位）
   *   result = integer * 1e18 + frac18
   */
  const mintWeiFromCfoStr = (cfoStr: string): string => {
    const raw = (cfoStr || '').trim()
    if (!raw) return '0'
    if (!RE_CFO_NUM_SAFE.test(raw)) return '0'
    const hasDot = raw.includes('.')
    const [intPartRaw, fracPartRaw = ''] = hasDot ? raw.split('.') : [raw, '']
    const intPart = BigInt(normIntStr(intPartRaw || '0'))
    // 处理小数：最多 18 位有效；第 19 位四舍五入
    let fracBi = 0n
    const maxFrac = CFO_DECIMALS
    if (fracPartRaw) {
      if (fracPartRaw.length <= maxFrac) {
        const padded = (fracPartRaw + '0'.repeat(maxFrac)).slice(0, maxFrac)
        fracBi = BigInt(normIntStr(padded))
      } else {
        // 超 18 位：取前 18 位 + 第 19 位判断进位
        const head18 = fracPartRaw.slice(0, maxFrac)
        const nineteenth = fracPartRaw[maxFrac] ?? '0'
        fracBi = BigInt(normIntStr(head18))
        if (Number(nineteenth) >= 5) fracBi += 1n
      }
    }
    const result = intPart * ONE_CFO_BI + fracBi
    return result.toString()
  }
  // 正则：允许正数、支持小数点（必须是合法十进制，无空格无字母无符号；安全版供换算前校验）
  const RE_CFO_NUM_SAFE = /^[0-9]+(\.[0-9]+)?$/
  const RE_CFO_NUM = RE_CFO_NUM_SAFE
  const [mintCfoStr, setMintCfoStr] = useState<string>(() => mintCfoFromWei(env.INITIAL_MINT))
  // 当 env 从外部（hydrate/getEnv）整体变化时，同步本地 mint 输入
  useEffect(() => {
    setMintCfoStr(mintCfoFromWei(env.INITIAL_MINT))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.INITIAL_MINT])
  // 提交前最后一刻：把当前 mintCfoStr 写回 env（防止还没失焦就点保存漏同步）
  const flushMintToEnv = useCallback(
    (nextEnv: EnvCfg): EnvCfg => {
      const wei = mintWeiFromCfoStr(mintCfoStr)
      return { ...nextEnv, INITIAL_MINT: wei }
    },
    [mintCfoStr]
  )
  // 当 env 从外部（hydrate/getEnv）整体变化时，同步本地 pct 输入
  useEffect(() => {
    setTeamPct(pctStr(env.TEAM_BPS))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(env.TEAM_BPS)])
  useEffect(() => {
    setPlatformPct(pctStr(env.PLATFORM_BPS))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(env.PLATFORM_BPS)])

  // --------- 钱包操作 ---------
  const handleConnect = useCallback(async () => {
    setConnecting(true)
    try {
      const ok = await connectWallet()
      if (!ok) notify('warning', '钱包连接已取消或失败，请重试')
    } finally {
      setConnecting(false)
    }
  }, [connectWallet, notify])

  const handleSwitchToBsc = useCallback(async () => {
    setSwitching(true)
    try {
      const ok = await switchChain(56)
      if (!ok) notify('warning', '切链失败，请在钱包中手动切换至 BSC 主网（chainId 56）')
    } finally {
      setSwitching(false)
    }
  }, [switchChain, notify])

  const walletStatusColor = useMemo(() => {
    if (!isConnected) return 'gray'
    if (chainId !== 56) return 'yellow'
    return 'green'
  }, [isConnected, chainId])

  // --------- 配置变更 helpers ---------
  const setStr = useCallback(
    (key: keyof EnvCfg) => (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ ...env, [key]: e.target.value as never })
    },
    [env, onChange]
  )
  const setNum = useCallback(
    (key: 'VESTING_DAYS') => (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseInt(e.target.value, 10)
      // F-4：VESTING_DAYS 至少 1 天（clamp 到 [1, 36500] 上限防天文数字）
      const safe = Number.isFinite(v) ? Math.max(1, Math.min(36500, v)) : 365
      onChange({ ...env, [key]: safe as never })
    },
    [env, onChange]
  )
  // 三元组：钱包地址数组（含 F-3：非法地址时输入框红框 + 下方提示）
  const setWalletArr = useCallback(
    (key: 'TEAM_WALLETS' | 'PLATFORM_WALLETS', idx: 0 | 1 | 2) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const arr = [...env[key]] as [string, string, string]
        arr[idx] = e.target.value
        onChange({ ...env, [key]: arr })
      },
    [env, onChange]
  )
  // F-5：三元组百分比字符串 → 内部归一化 BPS；同步本地字符串状态。
  const handleBpsArrPctChange = useCallback(
    (key: 'TEAM_BPS' | 'PLATFORM_BPS', idx: 0 | 1 | 2) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        if (key === 'TEAM_BPS') {
          const next: [string, string, string] = [...teamPct] as [string, string, string]
          next[idx] = e.target.value
          setTeamPct(next)
          const norm = computeNormalizedBpsTripleFromPct(next[0], next[1], next[2])
          onChange({ ...env, TEAM_BPS: norm })
        } else {
          const next: [string, string, string] = [...platformPct] as [string, string, string]
          next[idx] = e.target.value
          setPlatformPct(next)
          const norm = computeNormalizedBpsTripleFromPct(next[0], next[1], next[2])
          onChange({ ...env, PLATFORM_BPS: norm })
        }
      },
    [env, onChange, teamPct, platformPct]
  )
  // 失焦时做一次强制归一化 + 同步显示字符串（避免用户输入后显示有偏差）
  const handleBpsArrPctBlur = useCallback(
    (key: 'TEAM_BPS' | 'PLATFORM_BPS') => () => {
      const p = key === 'TEAM_BPS' ? teamPct : platformPct
      const norm = computeNormalizedBpsTripleFromPct(p[0], p[1], p[2])
      const nextFmt: [string, string, string] = [
        fmtPctFromBps(norm[0]),
        fmtPctFromBps(norm[1]),
        fmtPctFromBps(norm[2]),
      ]
      if (key === 'TEAM_BPS') setTeamPct(nextFmt)
      else setPlatformPct(nextFmt)
      onChange({ ...env, [key]: norm })
    },
    [env, onChange, teamPct, platformPct]
  )

  // --------- F-3 全局校验：所有地址合法 + BPS 和=100% ---------
  const validation = useMemo(() => {
    const addrIssues: { key: string; label: string; value: string }[] = []
    const wallets: [keyof EnvCfg, number, string][] = [
      ['TEAM_WALLETS', 0, '税费钱包①'],
      ['TEAM_WALLETS', 1, '税费钱包②'],
      ['TEAM_WALLETS', 2, '税费钱包③'],
      ['PLATFORM_WALLETS', 0, '平台费钱包①'],
      ['PLATFORM_WALLETS', 1, '平台费钱包②'],
      ['PLATFORM_WALLETS', 2, '平台费钱包③'],
    ]
    for (const [k, i, label] of wallets) {
      const v = (env[k] as unknown as string[])[i] ?? ''
      if (v && !ADDR_RE.test(v)) addrIssues.push({ key: `${String(k)}[${i}]`, label, value: v })
    }
    // SAFE_ADDRESS（选填）
    if (env.SAFE_ADDRESS && !ADDR_RE.test(env.SAFE_ADDRESS)) {
      addrIssues.push({ key: 'SAFE_ADDRESS', label: 'Gnosis Safe 多签地址', value: env.SAFE_ADDRESS })
    }
    // BOOST_FEE_RECIPIENT（选填）
    if (env.BOOST_FEE_RECIPIENT && !ADDR_RE.test(env.BOOST_FEE_RECIPIENT)) {
      addrIssues.push({ key: 'BOOST_FEE_RECIPIENT', label: '助力金接收地址', value: env.BOOST_FEE_RECIPIENT })
    }
    const taxSum = (env.TEAM_BPS?.[0] ?? 0) + (env.TEAM_BPS?.[1] ?? 0) + (env.TEAM_BPS?.[2] ?? 0)
    const platSum = (env.PLATFORM_BPS?.[0] ?? 0) + (env.PLATFORM_BPS?.[1] ?? 0) + (env.PLATFORM_BPS?.[2] ?? 0)
    const bpsOk = taxSum === 10000 && platSum === 10000
    return {
      addrIssues,
      anyAddrInvalid: addrIssues.length > 0,
      taxSum,
      platSum,
      bpsOk,
      // F-4（改按枚）：INITIAL_MINT 现在校验 mintCfoStr（UI字符串）按 CFO 正则
      canSave: addrIssues.length === 0 && bpsOk && RE_CFO_NUM.test(mintCfoStr || ''),
    }
  }, [env, mintCfoStr, RE_CFO_NUM])

  // --------- 合计校验 ---------
  const taxSumPct = useMemo(() => {
    const v =
      (env.TEAM_BPS?.[0] ?? 0) / BPS_SCALE +
      (env.TEAM_BPS?.[1] ?? 0) / BPS_SCALE +
      (env.TEAM_BPS?.[2] ?? 0) / BPS_SCALE
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN
  }, [env.TEAM_BPS])
  const platformSumPct = useMemo(() => {
    const v =
      (env.PLATFORM_BPS?.[0] ?? 0) / BPS_SCALE +
      (env.PLATFORM_BPS?.[1] ?? 0) / BPS_SCALE +
      (env.PLATFORM_BPS?.[2] ?? 0) / BPS_SCALE
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN
  }, [env.PLATFORM_BPS])

  const handleFillDefaults = useCallback(() => {
    onChange({ ...DEFAULT_ENV_CFG })
    setMintCfoStr(mintCfoFromWei(DEFAULT_ENV_CFG.INITIAL_MINT))
    notify('info', '已填充默认值（比例 40/30/30%、Vesting 365天、初始铸造 0 枚）')
  }, [onChange, notify, mintCfoFromWei])

  const handleSave = useCallback(async () => {
    // F-3 + F-4：保存前最后一道全局拦截（防 onChange 异步漏网的非法状态落盘）
    const addrIssues: string[] = []
    const wallets: [keyof EnvCfg, number, string][] = [
      ['TEAM_WALLETS', 0, '税费钱包①'],
      ['TEAM_WALLETS', 1, '税费钱包②'],
      ['TEAM_WALLETS', 2, '税费钱包③'],
      ['PLATFORM_WALLETS', 0, '平台费钱包①'],
      ['PLATFORM_WALLETS', 1, '平台费钱包②'],
      ['PLATFORM_WALLETS', 2, '平台费钱包③'],
    ]
    for (const [k, i, label] of wallets) {
      const v = (env[k] as unknown as string[])[i] ?? ''
      if (v && !ADDR_RE.test(v)) addrIssues.push(label)
    }
    if (env.SAFE_ADDRESS && !ADDR_RE.test(env.SAFE_ADDRESS)) {
      addrIssues.push('Gnosis Safe 多签地址')
    }
    if (env.BOOST_FEE_RECIPIENT && !ADDR_RE.test(env.BOOST_FEE_RECIPIENT)) {
      addrIssues.push('助力金接收地址')
    }
    if (addrIssues.length > 0) {
      notify('error', `以下地址格式有误，请修正后再保存：${addrIssues.join('、')}`)
      return
    }
    // F-4（改按枚）：校验 UI 字符串（CFO 枚数），合法后再换算写回 env
    if (!RE_CFO_NUM.test(mintCfoStr || '')) {
      notify('error', 'Token 初始铸造量必须是正数字（单位：枚，允许小数点，例：1 = 1 枚 CFO）')
      return
    }
    const envToSave = flushMintToEnv(env)
    // 换算后内部必须是纯整数 wei（冗余保险，理论上不会失败）
    if (!/^[0-9]+$/.test(envToSave.INITIAL_MINT || '')) {
      notify('error', 'Token 初始铸造量换算失败，请检查输入后重试')
      return
    }
    if (Math.abs(taxSumPct - 100) > 0.001) {
      notify('error', `税费比例之和必须等于 100%，当前为 ${taxSumPct}%`)
      return
    }
    if (Math.abs(platformSumPct - 100) > 0.001) {
      notify('error', `平台费比例之和必须等于 100%，当前为 ${platformSumPct}%`)
      return
    }
    setSaving(true)
    try {
      const resp = await saveEnv(envToSave)
      if (!resp?.saved) {
        throw new Error('服务端返回 saved !== true')
      }
      // 保存成功后同步 onChange（让 env 中 INITIAL_MINT 变成已换算的 wei）
      onChange(envToSave)
      notify('success', COPY.saveOK)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('error', `保存失败：${msg.slice(0, 120)}`)
    } finally {
      setSaving(false)
    }
  }, [env, saveEnv, onChange, notify, taxSumPct, platformSumPct, mintCfoStr, RE_CFO_NUM, flushMintToEnv])

  // --------- 字段 renderer（扁平 input）F-3 扩展：支持 invalid 红框 + 错误文字；F-4 INITIAL_MINT 也复用 ---------
  const fieldStr = (
    key: keyof EnvCfg & string,
    label: string,
    placeholder: string,
    opts: {
      type?: string
      hint?: string
      invalid?: boolean
      invalidHint?: string
    } = {}
  ): JSX.Element => {
    const val = env[key] as unknown as string
    const invalidCls = opts.invalid
      ? ' border-2 border-red-400 bg-red-50 focus:outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200'
      : ''
    return (
      <label key={key} className={styles.field}>
        <span className={styles.fieldLabel}>{label}</span>
        <div className="flex-1 flex flex-col gap-1 justify-center min-w-0">
          <span className="relative flex-1">
            <input
              type={opts.type ?? 'text'}
              className={styles.textInput + invalidCls}
              placeholder={placeholder}
              value={val ?? ''}
              onChange={setStr(key as keyof EnvCfg)}
              autoComplete="off"
              spellCheck={false}
            />
            {opts.hint && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none select-none">
                {opts.hint}
              </span>
            )}
          </span>
          {opts.invalid && opts.invalidHint && (
            <span className="text-xs text-red-600 pl-1">{opts.invalidHint}</span>
          )}
        </div>
      </label>
    )
  }

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{COPY.title}</h2>
        <p className="text-xs text-slate-500">{COPY.subtitle}</p>
      </header>

      {/* =========================================================
          钱包状态卡片（最上方）
          ========================================================= */}
      <div
        className={
          'mb-4 rounded-lg border p-4 ' +
          (walletStatusColor === 'green'
            ? 'border-primary-200 bg-primary-50'
            : walletStatusColor === 'yellow'
            ? 'border-amber-200 bg-amber-50'
            : 'border-slate-200 bg-slate-50')
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span
              className={
                'inline-block w-3 h-3 rounded-full ' +
                (walletStatusColor === 'green'
                  ? 'bg-primary-500'
                  : walletStatusColor === 'yellow'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-slate-400')
              }
              aria-hidden
            />
            <span className="text-sm font-semibold text-slate-800">{COPY.walletCard.title}</span>
            <span
              className={
                'text-xs font-medium ' +
                (walletStatusColor === 'green'
                  ? 'text-primary-700'
                  : walletStatusColor === 'yellow'
                  ? 'text-amber-700'
                  : 'text-slate-500')
              }
            >
              （
              {walletStatusColor === 'green'
                ? COPY.walletCard.connected
                : walletStatusColor === 'yellow'
                ? COPY.walletCard.wrongChain
                : COPY.walletCard.disconnected}
              ）
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-500">{COPY.walletCard.addressLabel}</span>
              {account ? (
                <CopyableAddress value={account} mode="short" explorerBaseUrl="https://bscscan.com" />
              ) : (
                <span className="text-xs italic text-slate-400">（未连接）</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-500">{COPY.walletCard.chainLabel}</span>
              <span
                className={
                  'text-xs font-mono px-2 py-0.5 rounded border ' +
                  (chainId === 56
                    ? 'text-primary-700 bg-primary-50 border-primary-200'
                    : 'text-amber-700 bg-amber-50 border-amber-200')
                }
              >
                chainId = {chainId ?? '—'}
              </span>
              {isConnected && chainId !== 56 && (
                <span className="text-[11px] font-medium text-amber-700">
                  请在钱包切到 BSC 主网（chainId 56）
                </span>
              )}
            </div>
          </div>

          {!isConnected ? (
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className={`${styles.btnPrimary} px-4 py-2 disabled:opacity-60`}
            >
              {connecting ? '连接中…' : COPY.walletCard.connectBtn}
            </button>
          ) : chainId !== 56 ? (
            <button
              type="button"
              onClick={handleSwitchToBsc}
              disabled={switching}
              className={`${styles.btnSecondary} px-4 py-2 disabled:opacity-60`}
            >
              {switching ? '切链中…' : COPY.walletCard.switchBtn}
            </button>
          ) : null}
        </div>
      </div>

      {/* =========================================================
          分组 1：链与 BscScan（删除 PRIVATE_KEY、CHAIN_ID、ROUTER_OWNER）
          ========================================================= */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>{COPY.groups.chain}</h3>
        <div className={styles.gridTwoCols}>
          {fieldStr('RPC_URL', 'BSC RPC 节点', 'https://bsc.publicnode.com', { type: 'url' })}
          {fieldStr('BSCSCAN_API_KEY', 'BscScan API Key', '可在 bscscan.com/myapikey 获取', {
            type: 'password',
          })}
        </div>
      </div>

      {/* =========================================================
          分组 2：税费 Team（3 钱包 + 3 百分比输入，自动转 BPS）
          ========================================================= */}
      <div className={styles.group}>
        <div className="flex items-center justify-between mb-2">
          <h3 className={styles.groupTitle}>{COPY.groups.tax}</h3>
          <span
            className={`text-xs font-medium ${
              Math.abs(taxSumPct - 100) < 0.001 ? 'text-primary-600' : 'text-red-600'
            }`}
          >
            当前合计 {taxSumPct}% — {COPY.taxSumHint}
          </span>
        </div>
        <div className={styles.gridTwoCols}>
          {[0, 1, 2].map((i) => {
            const idx = i as 0 | 1 | 2
            const v = env.TEAM_WALLETS[idx] ?? ''
            const invalid = Boolean(v) && !ADDR_RE.test(v)
            const invalidCls = invalid
              ? ' border-2 border-red-400 bg-red-50 focus:outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200'
              : ''
            return (
              <label key={`TEAM_WALLETS_${idx}`} className={styles.field}>
                <span className={styles.fieldLabel}>税费钱包 {['①', '②', '③'][idx]}</span>
                <div className="flex-1 flex flex-col gap-1 justify-center min-w-0">
                  <span className="relative flex-1">
                    <input
                      type="text"
                      className={styles.textInput + invalidCls}
                      placeholder={`0x...（未填则使用你的钱包地址）`}
                      value={v}
                      onChange={setWalletArr('TEAM_WALLETS', idx)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </span>
                  {invalid && (
                    <span className="text-xs text-red-600 pl-1">
                      地址格式错误：请填写 0x + 40 位十六进制字符（例：0x1234...abcd）
                    </span>
                  )}
                </div>
              </label>
            )
          })}
          {[0, 1, 2].map((i) => {
            const idx = i as 0 | 1 | 2
            return (
              <label key={`TEAM_BPS_${idx}`} className={styles.field}>
                <span className={styles.fieldLabel}>税费比例 {['①', '②', '③'][idx]}</span>
                <span className="relative flex-1">
                  <input
                    type="number"
                    className={styles.textInput}
                    placeholder={['40', '30', '30'][idx]}
                    value={pctFromBps(env.TEAM_BPS[idx] ?? 0)}
                    onChange={handleBpsArrPctChange('TEAM_BPS', idx)}
                    onBlur={handleBpsArrPctBlur('TEAM_BPS')}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none select-none">
                    %（×100 = BPS）
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </div>

      {/* =========================================================
          分组 4：平台费 Platform（3 钱包 + 3 百分比）
          ========================================================= */}
      <div className={styles.group}>
        <div className="flex items-center justify-between mb-2">
          <h3 className={styles.groupTitle}>{COPY.groups.platform}</h3>
          <span
            className={`text-xs font-medium ${
              Math.abs(platformSumPct - 100) < 0.001 ? 'text-primary-600' : 'text-red-600'
            }`}
          >
            当前合计 {platformSumPct}% — {COPY.platformSumHint}
          </span>
        </div>
        <div className={styles.gridTwoCols}>
          {[0, 1, 2].map((i) => {
            const idx = i as 0 | 1 | 2
            const v = env.PLATFORM_WALLETS[idx] ?? ''
            const invalid = Boolean(v) && !ADDR_RE.test(v)
            const invalidCls = invalid
              ? ' border-2 border-red-400 bg-red-50 focus:outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200'
              : ''
            return (
              <label key={`PLATFORM_WALLETS_${idx}`} className={styles.field}>
                <span className={styles.fieldLabel}>平台费钱包 {['①', '②', '③'][idx]}</span>
                <div className="flex-1 flex flex-col gap-1 justify-center min-w-0">
                  <span className="relative flex-1">
                    <input
                      type="text"
                      className={styles.textInput + invalidCls}
                      placeholder={`0x...（未填则使用你的钱包地址）`}
                      value={v}
                      onChange={setWalletArr('PLATFORM_WALLETS', idx)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </span>
                  {invalid && (
                    <span className="text-xs text-red-600 pl-1">
                      地址格式错误：请填写 0x + 40 位十六进制字符（例：0x1234...abcd）
                    </span>
                  )}
                </div>
              </label>
            )
          })}
          {[0, 1, 2].map((i) => {
            const idx = i as 0 | 1 | 2
            return (
              <label key={`PLATFORM_BPS_${idx}`} className={styles.field}>
                <span className={styles.fieldLabel}>平台费比例 {['①', '②', '③'][idx]}</span>
                <span className="relative flex-1">
                  <input
                    type="number"
                    className={styles.textInput}
                    placeholder={['40', '30', '30'][idx]}
                    value={pctFromBps(env.PLATFORM_BPS[idx] ?? 0)}
                    onChange={handleBpsArrPctChange('PLATFORM_BPS', idx)}
                    onBlur={handleBpsArrPctBlur('PLATFORM_BPS')}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none select-none">
                    %（×100 = BPS）
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </div>

      {/* =========================================================
          分组 5：Vesting 天数 / 助力金接收 / INITIAL_MINT / SAFE_ADDRESS
          ========================================================= */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>{COPY.groups.vesting}</h3>
        <div className={styles.gridTwoCols}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>主矿池线性解锁天数</span>
            <span className="relative flex-1">
              <input
                type="number"
                className={styles.textInput}
                placeholder="365"
                value={String(env.VESTING_DAYS ?? 365)}
                onChange={setNum('VESTING_DAYS')}
                min={1}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none select-none">
                天（部署时自动 ×86400 转秒传给合约）
              </span>
            </span>
          </label>
          {fieldStr(
            'BOOST_FEE_RECIPIENT',
            '助力金接收地址（PoolFactory.setBoostFeeRecipient · 选填）',
            '请粘贴助力金钱包地址，留空则绑定 D6 自动使用签名钱包',
            {
              type: 'text',
              invalid: Boolean(env.BOOST_FEE_RECIPIENT) && !ADDR_RE.test(env.BOOST_FEE_RECIPIENT),
              invalidHint: '地址格式错误：请填写 0x + 40 位十六进制字符',
            }
          )}
          {/* INITIAL_MINT：按「枚」为单位（CFO 人类友好），内部存 wei；自定义受控渲染，不复用 fieldStr */}
          {(() => {
            const invalid = !RE_CFO_NUM.test(mintCfoStr || '')
            const invalidCls = invalid
              ? ' border-2 border-red-400 bg-red-50 focus:outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200'
              : ''
            return (
              <label key="INITIAL_MINT_CFO" className={styles.field}>
                <span className={styles.fieldLabel}>Token 初始铸造量 INITIAL_MINT</span>
                <div className="flex-1 flex flex-col gap-1 justify-center min-w-0">
                  <span className="relative flex-1">
                    <input
                      type="text"
                      inputMode="decimal"
                      className={styles.textInput + invalidCls}
                      placeholder="例如：1（=1 枚 CFO；内部自动 ×10¹⁸ 转 wei）"
                      value={mintCfoStr}
                      onChange={(e) => setMintCfoStr(e.target.value)}
                      // 失焦时：写回 env（转换成 wei）→ 同时格式化显示（例如 1.0000 → 1）
                      onBlur={() => {
                        if (RE_CFO_NUM.test(mintCfoStr || '')) {
                          const wei = mintWeiFromCfoStr(mintCfoStr)
                          onChange({ ...env, INITIAL_MINT: wei })
                          // 格式化（如 1.500 变成 1.5，1.0 变成 1），避免输入抖动
                          const fmt = mintCfoFromWei(wei)
                          if (fmt !== mintCfoStr) setMintCfoStr(fmt)
                        }
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none select-none">
                      CFO 枚
                    </span>
                  </span>
                  {invalid && (
                    <span className="text-xs text-red-600 pl-1">
                      必须是正数字（单位：枚，允许小数点，例：1 = 1 枚 CFO）
                    </span>
                  )}
                  {!invalid && (
                    <span className="text-xs text-slate-500 pl-1">
                      换算为 wei：{mintWeiFromCfoStr(mintCfoStr)}（构造参数传给 CfoToken 合约）
                    </span>
                  )}
                </div>
              </label>
            )
          })()}
          {fieldStr(
            'SAFE_ADDRESS',
            'Gnosis Safe 多签地址（选填）',
            '选填：填写后绑定步骤末尾自动追加 D12-D15 移交所有权',
            {
              type: 'text',
              invalid: Boolean(env.SAFE_ADDRESS) && !ADDR_RE.test(env.SAFE_ADDRESS),
              invalidHint: '地址格式错误：请填写 0x + 40 位十六进制字符',
            }
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-3 pt-2 mt-4 border-t border-slate-100">
        <button type="button" onClick={handleFillDefaults} className={`${styles.btnGhost} px-4 py-2`}>
          {COPY.fillDefaults}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !validation.canSave}
          className={`${styles.btnPrimary} px-5 py-2 disabled:opacity-60`}
        >
          {saving ? '保存中…' : COPY.save}
        </button>
      </footer>
    </section>
  )
}

export default ConfigPanel
