import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeployedMap, EnvCfg, HealthResp, StepStatus, ToastKind } from '../types/foundry'
import type { DeployStateMap } from '../hooks/useDeployFlow'
import { useDeployFlow } from '../hooks/useDeployFlow'
import styles from '../FoundryDeploy.module.css'
import {
  ALL_CONTRACTS,
  CONTRACT_INDEX,
  LIBRARY_CONTRACTS,
  STANDALONE_CONTRACTS,
  ROUTER_CONTRACT,
} from '../data/deployMeta'
import CopyableAddress from '@/components/common/CopyableAddress'

const BPS_PER_PCT = 100 // 1% = 100 BPS (和 ConfigPanel 一致)

const COPY: {
  readonly title: string
  readonly subtitle: string
  readonly swVerify: string
  readonly swStopOnError: string
  readonly phases: { readonly A: string; readonly B: string; readonly C: string }
  readonly deployAll: string
  readonly retry: string
  readonly retryVerify: string
  readonly retryingVerify: string
  readonly verifyRunning: string
  readonly verifySuccess: string
  readonly verifyFailed: string
  readonly expandLogs: string
  readonly collapseLogs: string
  readonly linkedLibs: string
  readonly constructorLabel: string
  readonly errHealth: string
  readonly errWallet: string
  readonly errChain: string
  readonly errTax: string
  readonly errPlatform: string
} = {
  title: '📦 一键部署 9 合约',
  subtitle: '按 Phase A → B → C 的依赖顺序串行执行。Phase C 主路由会链接 Phase A 的 5 个库。',
  swVerify: '部署时自动提交 forge verify（异步开源验证）',
  swStopOnError: '遇到失败立即停下（跳过后续合约）',
  phases: {
    A: 'Phase A：5 个路由库合约（串行）',
    B: 'Phase B：3 个独立业务合约（A 完成后）',
    C: 'Phase C：CfoRouter（A+B 完成后，链接 5 个库）',
  },
  deployAll: '🚀 一键部署全部 9 个合约（钱包签名）',
  retry: '🔁 重部署',
  retryVerify: '🔄 重新验证全部合约',
  retryingVerify: '🔄 正在重新提交验证…',
  verifyRunning: '🔄 开源验证中…',
  verifySuccess: '✅ 已开源',
  verifyFailed: '❌ 开源失败',
  expandLogs: '展开日志',
  collapseLogs: '收起日志',
  linkedLibs: '已链接库列表（Phase A 完成后自动填入）：',
  constructorLabel: '构造参数（灰色只读，来自 Tab1 配置）：',
  errHealth: '部署服务未连接，请先启动本地 foundry/start-deploy-server.ps1（127.0.0.1:3011）',
  errWallet: '钱包未连接，请先到 Tab1 顶部点击「连接钱包（MetaMask / OKX Wallet）」',
  errChain: '当前链非 BSC 主网（chainId 56），请在钱包中切换或点击切链按钮',
  errTax: '税费比例（TEAM_BPS ①②③）之和必须等于 100%',
  errPlatform: '平台费比例（PLATFORM_BPS ①②③）之和必须等于 100%',
}

const STATUS_ICON: Record<StepStatus, string> = {
  idle: '⏳',
  pending: '⏳',
  running: '🔨',
  success: '✅',
  error: '❌',
  skipped: '⏭️',
}

export type DeployPanelProps = {
  readonly env: EnvCfg
  /** 仅用于展示（实际签名钱包来自 useWallet 全局 hook） */
  readonly deployerAddress: string
  readonly health: HealthResp
  readonly notify: (kind: ToastKind, message: string) => void
  readonly persist: (snapshot: DeployStateMap, deployed: DeployedMap) => Promise<void>
  readonly onStatesChange: (states: DeployStateMap, deployed: DeployedMap) => void
  readonly initialStates?: DeployStateMap
  /** 清空已部署数据（服务端 + localStorage + 前端 state），允许重新一键部署 */
  readonly onClearData: () => Promise<void>
}

/** Tab2：三阶段部署面板 */
function DeployPanel(props: DeployPanelProps): JSX.Element {
  const { env, deployerAddress, health, notify, persist, onStatesChange, initialStates, onClearData } = props
  const [logOpenMap, setLogOpenMap] = useState<Record<string, boolean>>({})

  // 新版 useDeployFlow：不再接受 deployerAddress 参数（内部用 useWallet）
  const flow = useDeployFlow({ env, notify, persist })

  // ------------------------------------------------------------------
  // 🐛【修复：切 Tab 页面颤抖（闭环重渲染死循环）】
  //
  // 旧链路：
  //   hydrate → flow.setState → onStatesChange(父) → 父 setState → initialStates引用变
  //   → hydrate 再触发（依赖是 JSON.stringify，含 Date.now() 字段每次都变）
  //   → 无限循环 → 视觉"颤抖"
  //
  // 阻断策略（源头降频，不做下游补丁）：
  //   ① hydrate 侧：用 ref 记"上次 hydrate 的内容指纹"，严格相等就跳过（哪怕引用不同）
  //   ② 上报侧：用 ref 记"上次上报的 states/deployed 内容指纹"，严格相等就不调父onStatesChange
  // ------------------------------------------------------------------
  const lastHydrateHashRef = useRef<string>('')
  const lastReportedStatesHashRef = useRef<string>('')
  const lastReportedDeployedHashRef = useRef<string>('')
  /** 【关键】flow 真的被 hydrate/内部动作改过才允许上报父，防止 mount 瞬间把 flow 初始 idle 覆盖父 A3 恢复的真实数据 */
  const didHydrateOrMutateRef = useRef<boolean>(false)
  /** 判断 initialStates 是否是"9 合约全 idle 空壳"：若是，禁止反向 hydrate（会把 flow 真数据写回 idle） */
  const isAllIdleDeploy = (obj: Record<string, unknown>): boolean => {
    const keys = Object.keys(obj)
    if (keys.length === 0) return true
    for (const k of keys) {
      const v = obj[k]
      if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>
        if ((rec.status as unknown) !== 'idle' && rec.status !== 'idle') return false
        if (typeof rec.address === 'string' && rec.address !== '') return false
        if (typeof rec.txHash === 'string' && rec.txHash !== '') return false
      }
    }
    return true
  }

  // ✅ F-4/N-1 修复：副作用（hydrate、onStatesChange）必须放 useEffect，禁止 useMemo 中调 setState 相关函数。
  useEffect(() => {
    if (!initialStates) return
    if (Object.keys(initialStates).length === 0) return
    const fingerprint = JSON.stringify(initialStates)
    if (fingerprint === lastHydrateHashRef.current) return
    // 禁止：父被写回 idle → idle 回传 → 反向把 flow 真数据抹成 idle（只在首次且非 idle 才 hydrate）
    if (didHydrateOrMutateRef.current && isAllIdleDeploy(initialStates as Record<string, unknown>)) return
    lastHydrateHashRef.current = fingerprint
    didHydrateOrMutateRef.current = true
    flow.hydrate(initialStates)
  }, [flow, initialStates])

  useEffect(() => {
    // 【关键守卫】mount 首次 flow 是 buildInitialState() 全 idle，此时上报会覆盖父 A3 恢复数据 → 直接跳过
    if (!didHydrateOrMutateRef.current) return
    const statesFp = JSON.stringify(flow.states ?? null)
    const deployedFp = JSON.stringify(flow.deployed ?? null)
    if (
      statesFp === lastReportedStatesHashRef.current &&
      deployedFp === lastReportedDeployedHashRef.current
    ) {
      return
    }
    lastReportedStatesHashRef.current = statesFp
    lastReportedDeployedHashRef.current = deployedFp
    onStatesChange(flow.states, flow.deployed)
  }, [flow.states, flow.deployed, onStatesChange])

  // 【补充守卫】用户直接点一键部署/重部署时，flow 内部会改 running/states（没走 hydrate）也需要把变异门打开，否则漏上报
  useEffect(() => {
    if (flow.running) didHydrateOrMutateRef.current = true
  }, [flow.running])
  // 【补充守卫2】flow 内部已经产生非 idle 状态（比如部署过程中 flow.running 变 true 之前有状态切换）也要开门
  useEffect(() => {
    if (
      flow.states &&
      typeof flow.states === 'object' &&
      !isAllIdleDeploy(flow.states as Record<string, unknown>)
    ) {
      didHydrateOrMutateRef.current = true
    }
  }, [flow.states])

  // 比例求和：直接读 env.TEAM_BPS / PLATFORM_BPS（数组，内部 BPS）
  // 显示用百分比，但校验用和=10000 BPS = 100%
  const taxSumBps =
    (env.TEAM_BPS?.[0] ?? 0) + (env.TEAM_BPS?.[1] ?? 0) + (env.TEAM_BPS?.[2] ?? 0)
  const platformSumBps =
    (env.PLATFORM_BPS?.[0] ?? 0) + (env.PLATFORM_BPS?.[1] ?? 0) + (env.PLATFORM_BPS?.[2] ?? 0)
  void BPS_PER_PCT

  const healthOk = health?.status === 'ok' && !!health.forgePath && !!health.castPath

  const preflight = useMemo(() => {
    const errs: string[] = []
    if (!healthOk) errs.push(COPY.errHealth)
    if (!flow.wallet.isConnected || !flow.wallet.account) errs.push(COPY.errWallet)
    if (flow.wallet.isConnected && flow.wallet.chainId !== 56) errs.push(COPY.errChain)
    if (taxSumBps !== 10000) errs.push(COPY.errTax)
    if (platformSumBps !== 10000) errs.push(COPY.errPlatform)
    return errs
  }, [healthOk, flow.wallet.isConnected, flow.wallet.account, flow.wallet.chainId, taxSumBps, platformSumBps])

  const toggleLog = useCallback((id: string) => {
    setLogOpenMap((m) => ({ ...m, [id]: !m[id] }))
  }, [])

  const renderStep = (meta: (typeof ALL_CONTRACTS)[number]): JSX.Element => {
    // ✅ N-1：防御式可选链（initialStates 不全时可能为 undefined，避免 STATUS_ICON[undefined] 抛错崩溃）
    const s = flow.states?.[meta.id]
    const st: StepStatus = s?.status ?? 'idle'
    const addr = s?.address ?? ''
    const txh = s?.txHash ?? ''
    const verifyId = s?.verifyTaskId
    const verifySt = s?.verifyStatus
    const verifyMsg = s?.verifyMessage ?? ''
    const logOutput = s?.output ?? ''
    const idx = CONTRACT_INDEX[meta.id] ?? 0
    const open = !!logOpenMap[meta.id]
    return (
      <div key={meta.id} className={styles.stepRow}>
        <div className="flex items-start gap-3 w-full">
          <div className={`${styles.stepNo} w-8 h-8 shrink-0`}>{idx}</div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-800">{meta.name}</span>
              <span className={`text-sm ${styles.statusIcon}`} aria-hidden>
                {STATUS_ICON[st]}
              </span>
              <span className="text-xs text-slate-500 font-mono">{meta.contract}</span>
              {meta.desc && <span className="text-xs text-primary-700">{meta.desc}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {addr ? (
                <CopyableAddress
                  value={addr}
                  explorerBaseUrl="https://bscscan.com"
                  explorerType="address"
                />
              ) : (
                <span className="text-xs text-slate-400 italic">地址：尚未部署</span>
              )}
              {txh ? (
                <CopyableAddress
                  value={txh}
                  mode="full"
                  explorerBaseUrl="https://bscscan.com"
                  explorerType="tx"
                />
              ) : null}
              {verifyId ? (
                verifySt === 'success' ? (
                  <span
                    className="text-[11px] text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded font-medium"
                    title={verifyMsg || 'Sourcify 验证通过'}
                  >
                    {COPY.verifySuccess}
                  </span>
                ) : verifySt === 'failed' ? (
                  <span
                    className="text-[11px] text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded font-medium"
                    title={verifyMsg || '验证失败，可点「重新验证全部合约」重试'}
                  >
                    {COPY.verifyFailed}
                  </span>
                ) : (
                  <span
                    className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded font-medium"
                    title={`验证任务 ${verifyId} 进行中，每 6 秒自动刷新`}
                  >
                    {COPY.verifyRunning}
                  </span>
                )
              ) : null}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-2">
            <button
              type="button"
              disabled={flow.running || st === 'running'}
              onClick={() => void flow.retryOne(meta.id)}
              className={`${styles.btnSmall} disabled:opacity-50`}
            >
              {COPY.retry}
            </button>
            {logOutput ? (
              <button
                type="button"
                className={styles.btnGhostSmall}
                onClick={() => toggleLog(meta.id)}
              >
                {open ? COPY.collapseLogs : COPY.expandLogs}
              </button>
            ) : null}
          </div>
        </div>
        {open && logOutput ? (
          <pre className={styles.logBox}>
            <code>{logOutput}</code>
          </pre>
        ) : null}
      </div>
    )
  }

  // Phase C：构造参数展示（通过 flow.buildConstructorArgs 统一生成）
  const routerConstructorArgs = useMemo<string[]>(() => {
    try {
      return flow.buildConstructorArgs(ROUTER_CONTRACT)
    } catch {
      return []
    }
  }, [flow])

  const progressPct = Math.round((flow.progressIdx / 9) * 100)

  /** 是否存在已部署合约（决定「重新验证全部合约」按钮是否可用） */
  const hasDeployedAny = useMemo<boolean>(() => {
    return Object.values(flow.deployed).some((a) => !!a && /^0x[a-fA-F0-9]{40}$/.test(a))
  }, [flow.deployed])

  // 顶部显示签名钱包（和 deployerAddress prop 一致，来自全局 useWallet 同步）
  const signingAddress = flow.wallet.deployerAddress || deployerAddress

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{COPY.title}</h2>
        <p className="text-xs text-slate-500">{COPY.subtitle}</p>
        {signingAddress ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
            <span className="font-medium">签名钱包：</span>
            <CopyableAddress value={signingAddress} mode="short" />
          </div>
        ) : null}
        {flow.buildLoading ? (
          <div className="mt-2 text-xs text-amber-700">
            📦 正在从服务端加载合约编译信息（/api/build/contracts）…
          </div>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-6 pb-4 mb-4 border-b border-slate-100">
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={flow.verifyEnabled}
            onChange={(e) => flow.setVerifyEnabled(e.target.checked)}
          />
          <span>{COPY.swVerify}</span>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={flow.stopOnError}
            onChange={(e) => flow.setStopOnError(e.target.checked)}
          />
          <span>{COPY.swStopOnError}</span>
        </label>
      </div>

      {/* Phase A */}
      <div className={`${styles.phaseCard} ${styles.phaseA}`}>
        <h3 className={styles.phaseTitle}>{COPY.phases.A}</h3>
        <div className="flex flex-col gap-3">{LIBRARY_CONTRACTS.map(renderStep)}</div>
      </div>

      {/* Phase B */}
      <div className={`${styles.phaseCard} ${styles.phaseB}`}>
        <h3 className={styles.phaseTitle}>{COPY.phases.B}</h3>
        <div className="flex flex-col gap-3">{STANDALONE_CONTRACTS.map(renderStep)}</div>
      </div>

      {/* Phase C */}
      <div className={`${styles.phaseCard} ${styles.phaseC}`}>
        <h3 className={styles.phaseTitle}>{COPY.phases.C}</h3>
        <div className="mb-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
          <div className="text-xs font-semibold text-slate-700 mb-2">{COPY.linkedLibs}</div>
          <div className="flex flex-wrap gap-2">
            {LIBRARY_CONTRACTS.map((lib) => {
              const addr = flow.deployed[lib.id]
              return (
                <span key={lib.id} className="text-xs">
                  <span className="font-semibold text-primary-700">{lib.name}</span>
                  <span className="text-slate-400">@</span>
                  {addr ? (
                    <CopyableAddress value={addr} mode="short" />
                  ) : (
                    <span className="text-slate-400 italic">未就绪</span>
                  )}
                </span>
              )
            })}
          </div>
          <div className="mt-3">
            <div className="text-xs font-semibold text-slate-700 mb-2">
              {COPY.constructorLabel}
            </div>
            <ol className="list-decimal list-inside text-[11px] font-mono text-slate-600 space-y-0.5 bg-white p-2 rounded border border-slate-200">
              {routerConstructorArgs.map((arg, i) => (
                <li key={i} className="truncate" title={arg}>
                  {arg || <span className="italic text-slate-400">（默认用签名钱包地址）</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex flex-col gap-3">{renderStep(ROUTER_CONTRACT)}</div>
      </div>

      {/* 进度条 + 执行按钮 */}
      <div className="mt-5 flex flex-col gap-3">
        <div className={styles.progressWrap}>
          <div
            className={styles.progressBar}
            style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
          />
        </div>
        {flow.progressText && (
          <div className="text-xs text-slate-600 font-mono">{flow.progressText}</div>
        )}
        {preflight.length > 0 && (
          <ul className="text-xs text-red-600 space-y-1 list-disc list-inside bg-red-50 border border-red-100 p-3 rounded-lg">
            {preflight.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            disabled={flow.running || preflight.length > 0}
            className={`${styles.btnPrimaryBig} disabled:opacity-60`}
            onClick={() => void flow.runAll()}
          >
            {flow.running ? flow.progressText || '部署中…' : COPY.deployAll}
          </button>
          <button
            type="button"
            disabled={flow.running || flow.verifyRetrying || !hasDeployedAny}
            className="text-xs px-3 py-2 rounded-lg border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 transition-colors"
            title="对全部已部署合约重新提交 Sourcify 开源验证，状态每 6 秒自动刷新"
            onClick={() => void flow.retryVerifyAll()}
          >
            {flow.verifyRetrying ? COPY.retryingVerify : COPY.retryVerify}
          </button>
          <button
            type="button"
            disabled={flow.running}
            className="text-xs px-3 py-2 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 transition-colors"
            onClick={() => {
              if (window.confirm('确定清空全部已部署数据？\n\n• 清空后页面回到 9 合约全 idle 初始态\n• 已上链的合约地址仍存在（无法撤销），但前端不再显示\n• 清空后可以重新一键部署到新地址\n\n确认继续？')) {
                flow.resetAll()
                void onClearData()
              }
            }}
          >
            🗑️ 清空已部署数据
          </button>
        </div>
      </div>
    </section>
  )
}

export default DeployPanel
