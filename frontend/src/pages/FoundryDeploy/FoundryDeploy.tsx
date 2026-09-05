// Foundry 一键部署台（React18 + TS + CSS Modules）
// 主组件：Tab 容器 + 顶部状态栏 + Toast 管理
// ---------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BindStepState,
  DeployedMap,
  DeployStepState,
  EnvCfg,
  HealthResp,
  StepStatus,
  ToastItem,
  ToastKind,
} from './types/foundry'
import type { DeployStateMap } from './hooks/useDeployFlow'
import type { BindStateMap } from './hooks/useBindFlow'
import styles from './FoundryDeploy.module.css'
import ServiceStatusBar from './components/ServiceStatusBar'
import ConfigPanel from './components/ConfigPanel'
import DeployPanel from './components/DeployPanel'
import BindingPanel from './components/BindingPanel'
import ResultPanel from './components/ResultPanel'
import MintPanel from './components/MintPanel'
import MintGrantPanel from './components/MintGrantPanel'
import PoolFeePanel from './components/PoolFeePanel'
import TaxConfigPanel from './components/TaxConfigPanel'
import RecipientPanel from './components/RecipientPanel'
import { useDeployApi } from './hooks/useDeployApi'
import { ALL_CONTRACTS, BINDING_STEPS, DEFAULT_ENV_CFG, DEPLOY_LOCAL_KEY } from './data/deployMeta'
import { useWallet } from '@/hooks/useWallet'

// ===================================================================
// 双源恢复：模块级工具函数（全程 unknown + 形状校验，禁 any）
// ===================================================================

/** 快照形状类型（未校验，字段全是 unknown 级可选） */
type SnapshotShape = {
  savedAt?: unknown
  deployStates?: unknown
  deployed?: unknown
  bindStates?: unknown
}

/** idle DeployStepState 默认值（与 TS 类型严格对齐） */
function idleDeployStepState(): DeployStepState {
  return {
    status: 'idle' as StepStatus,
    address: '',
    txHash: '',
    output: '',
    exitCode: null,
    elapsedMs: 0,
    startedAt: null,
    endedAt: null,
    verifyTaskId: undefined,
  }
}

/** idle BindStepState 默认值 */
function idleBindStepState(): BindStepState {
  return {
    status: 'idle' as StepStatus,
    txHash: '',
    output: '',
    exitCode: null,
    elapsedMs: 0,
    startedAt: null,
    endedAt: null,
  }
}

/** 纯对象判断（非 null/array） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 合法以太坊地址判断：0x + 40 hex */
function isValidEthAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)
}

/**
 * 形状校验：把 unknown 收窄为合法 SnapshotShape（字段仍是 unknown）
 * 不合法整个返回 null
 */
function validateSnapShape(raw: unknown): SnapshotShape | null {
  if (!isPlainObject(raw)) return null
  const snap: SnapshotShape = {}
  if ('savedAt' in raw) snap.savedAt = raw.savedAt
  if ('deployStates' in raw) snap.deployStates = raw.deployStates
  if ('deployed' in raw) snap.deployed = raw.deployed
  if ('bindStates' in raw) snap.bindStates = raw.bindStates
  return snap
}

/** 把 unknown deployStates 标准化为「9 key 之外也接受但合法才保留」的对象 */
function normalizeDeployStates(raw: unknown): Record<string, DeployStepState> {
  const out: Record<string, DeployStepState> = {}
  if (!isPlainObject(raw)) return out
  for (const k of Object.keys(raw)) {
    const v = raw[k]
    if (!isPlainObject(v)) continue
    const step = idleDeployStepState()
    // 逐字段收窄，缺字段保持 idle 默认
    if (typeof v.status === 'string') {
      const s = v.status as StepStatus
      if (s === 'idle' || s === 'pending' || s === 'running' || s === 'success' || s === 'error') {
        step.status = s
      }
    }
    if (typeof v.address === 'string') step.address = v.address
    if (typeof v.txHash === 'string') step.txHash = v.txHash
    if (typeof v.output === 'string') step.output = v.output
    if (v.exitCode === null) step.exitCode = null
    else if (typeof v.exitCode === 'number') step.exitCode = v.exitCode
    if (typeof v.elapsedMs === 'number') step.elapsedMs = v.elapsedMs
    if (v.startedAt === null) step.startedAt = null
    else if (typeof v.startedAt === 'number') step.startedAt = v.startedAt
    if (v.endedAt === null) step.endedAt = null
    else if (typeof v.endedAt === 'number') step.endedAt = v.endedAt
    if (typeof v.verifyTaskId === 'string') step.verifyTaskId = v.verifyTaskId
    if (v.verifyStatus === 'running' || v.verifyStatus === 'success' || v.verifyStatus === 'failed') {
      step.verifyStatus = v.verifyStatus
    }
    if (typeof v.verifyMessage === 'string') step.verifyMessage = v.verifyMessage
    out[k] = step
  }
  return out
}

/** 把 unknown bindStates 标准化 */
function normalizeBindStates(raw: unknown): BindStateMap {
  const out: BindStateMap = {}
  if (!isPlainObject(raw)) return out
  for (const k of Object.keys(raw)) {
    const v = raw[k]
    if (!isPlainObject(v)) continue
    const step = idleBindStepState()
    if (typeof v.status === 'string') {
      const s = v.status as StepStatus
      if (s === 'idle' || s === 'pending' || s === 'running' || s === 'success' || s === 'error') {
        step.status = s
      }
    }
    if (typeof v.txHash === 'string') step.txHash = v.txHash
    if (typeof v.output === 'string') step.output = v.output
    if (v.exitCode === null) step.exitCode = null
    else if (typeof v.exitCode === 'number') step.exitCode = v.exitCode
    if (typeof v.elapsedMs === 'number') step.elapsedMs = v.elapsedMs
    if (v.startedAt === null) step.startedAt = null
    else if (typeof v.startedAt === 'number') step.startedAt = v.startedAt
    if (v.endedAt === null) step.endedAt = null
    else if (typeof v.endedAt === 'number') step.endedAt = v.endedAt
    out[k] = step
  }
  return out
}

/** 把 unknown deployed 地址标准化（仅保留合法 0x 地址） */
function normalizeDeployed(raw: unknown): Partial<DeployedMap> {
  const out: Partial<DeployedMap> = {}
  if (!isPlainObject(raw)) return out
  const keys: (keyof DeployedMap)[] = [
    'lib_dag', 'lib_smart', 'lib_wrap', 'lib_unx', 'lib_unxv3',
    'biz_token', 'biz_pool', 'biz_mining', 'biz_router',
  ]
  for (const k of keys) {
    if (k in raw && isValidEthAddress(raw[k])) out[k] = raw[k] as string
  }
  return out
}

/** 取合法 savedAt 字符串或 null */
function normalizeSavedAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Date.parse 能解析才认为有效
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return null
  return raw
}

/**
 * 合并两个快照：server 优先覆盖，local 补缺，最后统一 idle fallback
 * 返回完全合法、类型确定的对象
 */
function mergeSnapshots(
  serverSnap: SnapshotShape | null,
  localSnap: SnapshotShape | null,
): {
  deployStates: DeployStateMap
  bindStates: BindStateMap
  deployed: DeployedMap
  savedAt: string | null
} {
  const serverDs = normalizeDeployStates(serverSnap?.deployStates)
  const localDs = normalizeDeployStates(localSnap?.deployStates)
  const serverDp = normalizeDeployed(serverSnap?.deployed)
  const localDp = normalizeDeployed(localSnap?.deployed)
  const serverBs = normalizeBindStates(serverSnap?.bindStates)
  const localBs = normalizeBindStates(localSnap?.bindStates)

  // 1) deployStates：9 key 全部构造，server→local→idle 三级回退
  const deployStates = {} as DeployStateMap
  for (const c of ALL_CONTRACTS) {
    const k = c.id
    if (serverDs[k]) {
      deployStates[k] = { ...idleDeployStepState(), ...serverDs[k] }
    } else if (localDs[k]) {
      deployStates[k] = { ...idleDeployStepState(), ...localDs[k] }
    } else {
      deployStates[k] = idleDeployStepState()
    }
  }

  // 2) deployed：server 全地址优先；其次从合并后 deployStates 推导；缺失用 ''
  const deployed = {} as DeployedMap
  for (const c of ALL_CONTRACTS) {
    const k = c.id
    const serverAddr = serverDp[k]
    const derivedAddr = deployStates[k].address
    if (serverAddr && isValidEthAddress(serverAddr)) {
      deployed[k] = serverAddr
    } else if (isValidEthAddress(derivedAddr)) {
      deployed[k] = derivedAddr
    } else if (localDp[k] && isValidEthAddress(localDp[k])) {
      deployed[k] = localDp[k]
    } else {
      deployed[k] = ''
    }
    // 同步：如果 deployed 有地址但 deployStates.address 是空，就回写
    if (deployed[k] && !deployStates[k].address) {
      deployStates[k] = { ...deployStates[k], address: deployed[k] }
    }
  }

  // 3) bindStates：server 优先合并 local
  const bindStates: BindStateMap = { ...localBs, ...serverBs }

  // 4) savedAt：取较新的（两者都有效时对比时间戳）
  const sAt = normalizeSavedAt(serverSnap?.savedAt)
  const lAt = normalizeSavedAt(localSnap?.savedAt)
  let savedAt: string | null = null
  if (sAt && lAt) savedAt = Date.parse(sAt) >= Date.parse(lAt) ? sAt : lAt
  else if (sAt) savedAt = sAt
  else if (lAt) savedAt = lAt

  return { deployStates, bindStates, deployed, savedAt }
}

/** 安全读取 localStorage：失败返回 null，绝不抛错 */
function readLocalStorageSafe(key: string): SnapshotShape | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return validateSnapShape(parsed)
  } catch {
    return null
  }
}

/** 安全写入 localStorage：失败静默 */
function writeLocalStorageSafe(key: string, data: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // 忽略：隐私模式/配额限制等均不影响渲染
  }
}

// ---------- 页面级中文文案常量 ----------
const T = {
  title: '🚀 CFO合约一键部署台 (Foundry版)',
  subtitle:
    '前端通过 MetaMask / OKX Wallet 签名发送 eth_sendTransaction 完成部署与绑定；本地 Node 服务仅提供 forge build 产物与 forge verify 异步开源验证（服务端不触碰私钥）。',
  tabs: [
    { id: 'config' as const, label: '⚙️ 参数配置' },
    { id: 'deploy' as const, label: '📦 一键部署 9 合约' },
    { id: 'bind' as const, label: '🔗 一键绑定 12 条交易' },
    { id: 'mint' as const, label: '💎 铸造CFO代币' },
    { id: 'mintgrant' as const, label: '🪙 铸币授权（给挖矿合约）' },
    { id: 'poolfee' as const, label: '🏭 自建矿池销毁费' },
    { id: 'taxcfg' as const, label: '💰 交易税配置' },
    { id: 'recipients' as const, label: '📥 收款地址管理' },
    { id: 'result' as const, label: '📋 结果汇总与日志' },
  ] as const,
}

type TabId = (typeof T.tabs)[number]['id']

const INITIAL_HEALTH: HealthResp = {
  status: 'offline',
  forgePath: '',
  castPath: '',
  pwd: '',
}

const TAB_STORAGE_KEY = 'cfoswap:deploy:tab'

function FoundryDeploy(): JSX.Element {
  const [tab, setTab] = useState<TabId>(() => {
    try {
      const saved = sessionStorage.getItem(TAB_STORAGE_KEY)
      if (
        saved === 'config' ||
        saved === 'deploy' ||
        saved === 'bind' ||
        saved === 'mint' ||
        saved === 'mintgrant' ||
        saved === 'poolfee' ||
        saved === 'taxcfg' ||
        saved === 'recipients' ||
        saved === 'result'
      ) {
        return saved as TabId
      }
    } catch { /* sessionStorage 不可用时静默回退 */ }
    return 'config'
  })
  const handleTabChange = useCallback((t: TabId) => {
    setTab(t)
    try { sessionStorage.setItem(TAB_STORAGE_KEY, t) } catch { /* ignore */ }
  }, [])

  const [health, setHealth] = useState<HealthResp>(INITIAL_HEALTH)
  const [env, setEnv] = useState<EnvCfg>({ ...DEFAULT_ENV_CFG })

  // 钱包：连接 + 签名者地址
  const { account: walletAccount, isConnected } = useWallet()
  // deployerAddress 直接取钱包地址（不再从服务端派生）
  const deployerAddress = isConnected && walletAccount ? walletAccount : ''

  const { getHealth, getEnv, getResult, saveResult, clearResult } = useDeployApi()

  // ---- Toast 管理（加上 unmount 时清理所有 timer，避免 setState on unmounted 崩溃）----
  // 【需求】error 级 toast：常驻不自动消失 + 手动 X 关闭 + 去截断 + 可复制
  //         其它级别：保持原 auto-dismiss（4.2s）
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastIdRef = useRef<number>(0)
  const toastTimersRef = useRef<Map<number, ReturnType<typeof window.setTimeout>>>(new Map())
  const dismissToast = useCallback((id: number) => {
    const t = toastTimersRef.current.get(id)
    if (t) {
      window.clearTimeout(t)
      toastTimersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])
  const copyToastText = useCallback(async (text: string, id: number) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        // 用短暂样式提示（不改 toast 内容避免跳动）
        console.info('[Toast copied]', text.slice(0, 60) + '…')
      }
    } catch {
      // 兜底：旧浏览器不可用也不打扰用户
    }
    // 视觉反馈：toast 边框瞬时高亮，避免 setState 抖动
    void id
  }, [])
  const notify = useCallback(
    (kind: ToastKind, message: string) => {
      if (!message) return
      toastIdRef.current += 1
      const id = toastIdRef.current
      setToasts((prev) => [...prev, { id, kind, message }])
      // error 级：常驻，仅手动 X 关闭
      if (kind !== 'error') {
        const timer = window.setTimeout(() => {
          toastTimersRef.current.delete(id)
          setToasts((prev) => prev.filter((t) => t.id !== id))
        }, 4200)
        toastTimersRef.current.set(id, timer)
      }
    },
    []
  )

  // ---- 健康轮询：每 10s ----
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const r = await getHealth()
        if (!cancelled) setHealth(r)
      } catch {
        if (!cancelled) setHealth(INITIAL_HEALTH)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 10000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      // ✅ N-1：清理所有 toast timer，防止 setToasts on unmounted
      for (const t of toastTimersRef.current.values()) window.clearTimeout(t)
      toastTimersRef.current.clear()
    }
  }, [getHealth])

  // ---- 首次进入：加载环境 ----
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const r = await getEnv()
        if (!cancelled && r?.ok && r.env) {
          setEnv((prev) => ({ ...prev, ...r.env }))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 静默：本地服务未启动时不打扰，顶部指示灯会红
        // eslint-disable-next-line no-console
        console.warn('[FoundryDeploy] 拉取 /api/env 失败：', msg)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getEnv])

  // ---- 子面板间通信：deploy states / bind states / deployed map ----
  const [deployStates, setDeployStates] = useState<DeployStateMap | null>(null)
  const [deployed, setDeployed] = useState<DeployedMap | null>(null)
  const [bindStates, setBindStates] = useState<BindStateMap | null>(null)

  // ---- 恢复状态条：最后一次成功合并的 savedAt（null 表示无有效恢复）----
  const [restoredSavedAt, setRestoredSavedAt] = useState<string | null>(null)

  const handleDeployStatesChange = useCallback(
    (s: DeployStateMap, d: DeployedMap) => {
      setDeployStates(s)
      setDeployed(d)
    },
    []
  )

  const handleBindStatesChange = useCallback((s: BindStateMap) => {
    setBindStates(s)
  }, [])

  // ---- 页面挂载：双源自动恢复（服务端为主，localStorage 为辅）----
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      // a) 并行安全读双源，失败一律 null
      const [serverSnap, localSnap] = await Promise.all([
        (async (): Promise<SnapshotShape | null> => {
          try {
            const r = await getResult()
            if (r?.ok && r?.exists) return validateSnapShape(r.data)
            return null
          } catch {
            return null
          }
        })(),
        Promise.resolve(readLocalStorageSafe(DEPLOY_LOCAL_KEY)),
      ])
      if (cancelled) return

      // b) 合并
      const merged = mergeSnapshots(serverSnap, localSnap)

      // c) 非 idle 计数（用于 toast 文案）
      let deployNonIdle = 0
      for (const c of ALL_CONTRACTS) {
        if (merged.deployStates[c.id].status !== 'idle') deployNonIdle += 1
      }
      const bindNonIdle = Object.values(merged.bindStates).filter(
        (s) => s && s.status !== 'idle'
      ).length
      const anyRecovered = deployNonIdle > 0 || bindNonIdle > 0

      // d) 写回 state（仅挂载时）
      if (!cancelled) {
        setDeployStates(merged.deployStates)
        setBindStates(merged.bindStates)
        setDeployed(merged.deployed)
        if (merged.savedAt || anyRecovered) setRestoredSavedAt(merged.savedAt)
      }

      // e) 若有可恢复内容，提示用户
      if (anyRecovered && !cancelled) {
        const savedLabel = merged.savedAt
          ? new Date(merged.savedAt).toLocaleString('zh-CN')
          : '未知时间'
        notify(
          'info',
          `✅ 已恢复 ${deployNonIdle}/9 合约 + ${bindNonIdle} 条绑定（最后保存：${savedLabel}），刷新不会丢失。`
        )
      }

      // f) 把合并后的最终状态立即双写回两边，修复不一致
      const finalSnap = {
        savedAt: merged.savedAt ?? new Date().toISOString(),
        deployStates: merged.deployStates,
        deployed: merged.deployed,
        bindStates: merged.bindStates,
      }
      writeLocalStorageSafe(DEPLOY_LOCAL_KEY, finalSnap)
      if (!cancelled) {
        try {
          await saveResult(finalSnap)
        } catch {
          // 服务端写失败不影响；localStorage 已写入兜底
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 持久化：每成功一步写一次服务端 + 同步 localStorage ----
  const persistDeploySnapshot = useCallback(
    async (snapshot: DeployStateMap, dep: DeployedMap): Promise<void> => {
      const savedAt = new Date().toISOString()
      const fullSnap = {
        savedAt,
        deployStates: snapshot,
        deployed: dep,
        bindStates,
      }
      // 双写：先写 localStorage（同步、极速兜底），再 POST 服务端
      writeLocalStorageSafe(DEPLOY_LOCAL_KEY, fullSnap)
      try {
        await saveResult(fullSnap)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        notify('warning', `保存快照失败（不影响部署，本地已兜底）：${msg.slice(0, 80)}`)
      }
    },
    [saveResult, bindStates, notify]
  )

  const persistBindSnapshot = useCallback(
    async (snapshot: BindStateMap): Promise<void> => {
      const savedAt = new Date().toISOString()
      const fullSnap = {
        savedAt,
        deployStates,
        deployed,
        bindStates: snapshot,
      }
      writeLocalStorageSafe(DEPLOY_LOCAL_KEY, fullSnap)
      try {
        await saveResult(fullSnap)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        notify('warning', `保存绑定快照失败（本地已兜底）：${msg.slice(0, 80)}`)
      }
    },
    [saveResult, deployStates, deployed, notify]
  )

  // ---- 清空已部署数据（允许重新一键部署）----
  const handleClearData = useCallback(async () => {
    // 1) 清服务端
    try {
      await clearResult()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('warning', `服务端清空失败（本地仍会重置）：${msg.slice(0, 80)}`)
    }
    // 2) 清 localStorage
    try { localStorage.removeItem(DEPLOY_LOCAL_KEY) } catch { /* ignore */ }
    // 3) 重置 React state → 9 合约全 idle
    setDeployStates(null)
    setDeployed(null)
    setBindStates(null)
    setRestoredSavedAt(null)
    notify('success', '🗑️ 已清空全部部署数据，可以重新一键部署了')
  }, [clearResult, notify])

  // ---- ResultTab 从服务端回灌（手动按钮触发）----
  const handleHydrateFromServer = useCallback(
    (d: DeployStateMap, b: BindStateMap, _data: unknown): void => {
      // 形状再保险：用 validateSnapShape + mergeSnapshots 标准化一遍
      const snap = validateSnapShape({
        deployStates: d as unknown,
        bindStates: b as unknown,
      })
      const merged = mergeSnapshots(snap, null)
      setDeployStates(merged.deployStates)
      setBindStates(merged.bindStates)
      setDeployed(merged.deployed)

      // 统计 + 提示
      let deployNonIdle = 0
      for (const c of ALL_CONTRACTS) {
        if (merged.deployStates[c.id].status !== 'idle') deployNonIdle += 1
      }
      const bindNonIdle = Object.values(merged.bindStates).filter(
        (s) => s && s.status !== 'idle'
      ).length

      // 同步：双写回两边，savedAt 用回灌时间
      const savedAt = new Date().toISOString()
      const finalSnap = {
        savedAt,
        deployStates: merged.deployStates,
        deployed: merged.deployed,
        bindStates: merged.bindStates,
      }
      writeLocalStorageSafe(DEPLOY_LOCAL_KEY, finalSnap)
      setRestoredSavedAt(savedAt)

      if (deployNonIdle > 0 || bindNonIdle > 0) {
        notify(
          'info',
          `📥 手动回灌完成：${deployNonIdle}/9 合约 + ${bindNonIdle} 条绑定已同步到页面 & 双源持久化。`
        )
      } else {
        notify('info', '📥 手动回灌完成：服务端暂无可恢复数据，页面已清空。')
      }
    },
    [notify]
  )

  // 构造传给 DeployPanel / BindingPanel 的默认 DeployStateMap / BindStateMap
  const initialDeployStates: DeployStateMap = useMemo(() => {
    return deployStates ?? ({} as DeployStateMap)
  }, [deployStates])

  const initialBindStates: BindStateMap = useMemo(() => {
    return bindStates ?? ({} as BindStateMap)
  }, [bindStates])

  const realDeployed: DeployedMap = useMemo<DeployedMap>(() => {
    return (
      deployed ?? {
        lib_dag: '',
        lib_smart: '',
        lib_wrap: '',
        lib_unx: '',
        lib_unxv3: '',
        biz_token: '',
        biz_pool: '',
        biz_mining: '',
        biz_router: '',
      }
    )
  }, [deployed])

  const deployFlowAllSuccess = useMemo<boolean>(() => {
    if (!deployStates) return false
    const keys: (keyof DeployedMap)[] = [
      'lib_dag',
      'lib_smart',
      'lib_wrap',
      'lib_unx',
      'lib_unxv3',
      'biz_token',
      'biz_pool',
      'biz_mining',
      'biz_router',
    ]
    return keys.every((k) => deployStates[k]?.status === 'success' && deployStates[k]?.address)
  }, [deployStates])

  // ---- 恢复状态条统计数据 ----
  const recoveredContractCount = useMemo<number>(() => {
    let n = 0
    for (const c of ALL_CONTRACTS) {
      const addr = deployStates?.[c.id]?.address ?? deployed?.[c.id] ?? ''
      if (addr) n += 1
    }
    return n
  }, [deployStates, deployed])

  const recoveredBindCount = useMemo<number>(() => {
    if (!bindStates) return 0
    return Object.values(bindStates).filter((s) => s && s.status !== 'idle').length
  }, [bindStates])

  const showRestoreBar: boolean =
    restoredSavedAt !== null || recoveredContractCount > 0

  return (
    <div className={styles.wrapper}>
      {/* 顶部标题 + 状态 */}
      <header className={styles.pageHeader}>
        <div className="min-w-0">
          <h1 className={styles.pageTitle}>{T.title}</h1>
          <p className="text-xs text-slate-500 mt-1 max-w-3xl leading-relaxed">{T.subtitle}</p>
        </div>
      </header>

      <ServiceStatusBar health={health} notify={notify} />

      {/* 恢复状态条：仅在有数据时显示（复用 .card 半透明样式，不新增 CSS） */}
      {showRestoreBar && (
        <div
          className="card"
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'rgba(59, 130, 246, 0.06)',
            border: '1px solid rgba(59, 130, 246, 0.18)',
            borderRadius: 8,
            color: '#1e40af',
            fontSize: 13,
            lineHeight: 1.6,
          }}
          role="status"
          aria-live="polite"
        >
          📚 已恢复 {recoveredContractCount}/9 合约部署 + {recoveredBindCount} 条绑定进度
          {restoredSavedAt
            ? `（最后保存：${new Date(restoredSavedAt).toLocaleString('zh-CN')}）`
            : ''}
        </div>
      )}

      {/* Tab 切换 */}
      <nav className={styles.tabBar} role="tablist">
        {T.tabs.map((t) => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => handleTabChange(t.id)}
              className={`${styles.tabBtn} ${active ? styles.tabBtnActive : ''}`}
            >
              {t.label}
            </button>
          )
        })}
      </nav>

      {/* Tab 内容 */}
      <div className={styles.tabContent} role="tabpanel" aria-label={tab}>
        {tab === 'config' && (
          <ConfigPanel env={env} onChange={setEnv} notify={notify} />
        )}
        {tab === 'deploy' && (
          <DeployPanel
            env={env}
            deployerAddress={deployerAddress}
            health={health}
            notify={notify}
            persist={persistDeploySnapshot}
            onStatesChange={handleDeployStatesChange}
            initialStates={initialDeployStates}
            onClearData={handleClearData}
          />
        )}
        {tab === 'bind' && (
          <BindingPanel
            env={env}
            deployed={realDeployed}
            notify={notify}
            persist={persistBindSnapshot}
            initialStates={initialBindStates}
            deployFlowAllSuccess={deployFlowAllSuccess}
            deployerAddress={deployerAddress}
            onStatesChange={handleBindStatesChange}
          />
        )}
        {tab === 'mint' && (
          <MintPanel
            deployed={realDeployed}
            walletAddr={walletAccount ?? ''}
            notify={notify}
          />
        )}
        {tab === 'mintgrant' && (
          <MintGrantPanel
            deployed={realDeployed}
            walletAddr={walletAccount ?? ''}
            notify={notify}
          />
        )}
        {tab === 'poolfee' && (
          <PoolFeePanel
            deployed={realDeployed}
            walletAddr={walletAccount ?? ''}
            notify={notify}
            env={env}
          />
        )}
        {tab === 'taxcfg' && (
          <TaxConfigPanel
            deployed={realDeployed}
            walletAddr={walletAccount ?? ''}
            notify={notify}
            env={env}
          />
        )}
        {tab === 'recipients' && (
          <RecipientPanel
            deployed={realDeployed}
            walletAddr={walletAccount ?? ''}
            notify={notify}
            env={env}
          />
        )}
        {tab === 'result' && (
          <ResultPanel
            deployStates={deployStates ?? ({} as DeployStateMap)}
            bindStates={bindStates ?? ({} as BindStateMap)}
            deployed={realDeployed}
            notify={notify}
            onHydrateFromServer={handleHydrateFromServer}
            bindStepsCount={BINDING_STEPS.length + (env.SAFE_ADDRESS ? 4 : 0)}
            ownerTransfersEnabled={!!env.SAFE_ADDRESS}
          />
        )}
      </div>

      {/* Toast 列表 */}
      <div className={styles.toastWrap} aria-live="polite">
        {toasts.map((t) => {
          const isError = t.kind === 'error'
          return (
            <div
              key={t.id}
              className={`${styles.toastItem} ${isError ? styles.toastItemPersistent : ''} ${
                t.kind === 'success'
                  ? styles.toastSuccess
                  : t.kind === 'error'
                  ? styles.toastError
                  : t.kind === 'warning'
                  ? styles.toastWarning
                  : styles.toastInfo
              }`}
            >
              <span aria-hidden className={styles.toastIcon}>
                {t.kind === 'success'
                  ? '✅'
                  : t.kind === 'error'
                  ? '❌'
                  : t.kind === 'warning'
                  ? '⚠️'
                  : 'ℹ️'}
              </span>
              <span
                className={`flex-1 min-w-0 break-words whitespace-pre-wrap ${styles.toastText} ${
                  isError ? styles.toastTextError : ''
                }`}
              >
                {t.message}
              </span>
              <div className={styles.toastActions}>
                <button
                  type="button"
                  className={styles.toastCopyBtn}
                  aria-label="复制报错内容"
                  title="复制内容"
                  onClick={() => void copyToastText(t.message, t.id)}
                >
                  复制
                </button>
                {(isError || true) && (
                  // 所有级别都支持手动 X（error 必须靠它关闭；其它级别保留 X 方便手动关掉）
                  <button
                    type="button"
                    className={styles.toastCloseBtn}
                    aria-label="关闭弹窗"
                    title="关闭"
                    onClick={() => dismissToast(t.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default FoundryDeploy
