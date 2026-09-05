import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeployedMap, EnvCfg, StepStatus, ToastKind } from '../types/foundry'
import type { BindStateMap, BindingStepMeta } from '../hooks/useBindFlow'
import { useBindFlow } from '../hooks/useBindFlow'
import { useWallet } from '@/hooks/useWallet'
import styles from '../FoundryDeploy.module.css'
import { ALL_CONTRACTS } from '../data/deployMeta'
import CopyableAddress from '@/components/common/CopyableAddress'

const STATUS_ICON: Record<StepStatus, string> = {
  idle: '⏳',
  pending: '⏳',
  running: '🔨',
  success: '✅',
  error: '❌',
  skipped: '⏭️',
}

const COPY: {
  readonly title: string
  readonly subtitle: string
  readonly runAll: string
  readonly rerun: string
  readonly expandLogs: string
  readonly collapseLogs: string
  readonly groups: {
    readonly token: string
    readonly pool: string
    readonly mining: string
    readonly router: string
    readonly own: string
  }
  readonly targetContract: string
  readonly functionSig: string
  readonly preflight: string
  readonly walletFallback: string
  readonly errWallet: string
  readonly errChain: string
  readonly signingWallet: string
} = {
  title: '🔗 一键绑定 12 条交易（多签 SAFE_ADDRESS 配置时追加 4 条所有权转移）',
  subtitle:
    '按顺序 D1→D12 串行执行；若 Tab1 中填写了 SAFE_ADDRESS，则自动追加 D13-D16 的 transferOwnership。',
  runAll: '🔗 一键执行全部绑定（钱包签名）',
  rerun: '🔁 重跑',
  expandLogs: '展开日志',
  collapseLogs: '收起日志',
  groups: {
    token: 'D1-D3：CfoToken 绑定',
    pool: 'D4-D6：CfoMiningPoolFactory 绑定',
    mining: 'D7-D8：CfoMining 绑定',
    router: 'D9-D12：挖矿目标与白名单授权',
    own: 'D13-D16：所有权移交 Gnosis Safe',
  },
  targetContract: '目标合约：',
  functionSig: '函数签名：',
  preflight: '9 合约尚未全部部署成功，请先完成 Tab2「一键部署」。',
  walletFallback: '（默认用签名钱包地址）',
  errWallet: '钱包未连接，请先到 Tab1 顶部点击「连接钱包」。',
  errChain: '当前链非 BSC 主网（chainId 56），请在钱包中切换或点击切链按钮。',
  signingWallet: '签名钱包：',
}

export type BindingPanelProps = {
  readonly env: EnvCfg
  readonly deployed: DeployedMap
  readonly notify: (kind: ToastKind, message: string) => void
  readonly persist: (snapshot: BindStateMap) => Promise<void>
  readonly initialStates?: BindStateMap
  readonly deployFlowAllSuccess: boolean
  /** 仅用于展示（实际签名钱包来自 useWallet 全局 hook） */
  readonly deployerAddress: string
  readonly onStatesChange: (states: BindStateMap) => void
}

/** Tab3：绑定交易面板 */
function BindingPanel(props: BindingPanelProps): JSX.Element {
  const {
    env,
    deployed,
    notify,
    persist,
    initialStates,
    deployFlowAllSuccess,
    deployerAddress,
    onStatesChange,
  } = props
  const [logOpenMap, setLogOpenMap] = useState<Record<string, boolean>>({})

  const { isConnected, chainId, account } = useWallet()
  const flow = useBindFlow({ env, deployed, notify, persist })

  // ------------------------------------------------------------------
  // 🐛【修复：切 Tab 页面颤抖（闭环重渲染死循环）——同 DeployPanel 对称修复】
  // 链路：hydrate → flow.setState → onStatesChange(父) → 父 setState → initialStates引用变
  //       → 依赖(JSON.stringify 含时间戳) 变 → 再 hydrate → 无限循环 → 颤抖
  // 阻断：hydrate 侧 + 上报侧都用 ref 存"上次指纹"，内容严格相等即跳过
  // ------------------------------------------------------------------
  const lastHydrateHashRef = useRef<string>('')
  const lastReportedStatesHashRef = useRef<string>('')
  /** 【关键】flow 真的被 hydrate/内部动作改过才允许上报父，防止 mount 瞬间 idle 覆盖父 A3 恢复数据 */
  const didHydrateOrMutateRef = useRef<boolean>(false)
  /** 判断 initialStates 是否是"绑定全 idle 空壳"：是则禁止反向 hydrate 回写 flow */
  const isAllIdleBind = (obj: Record<string, unknown>): boolean => {
    const keys = Object.keys(obj)
    if (keys.length === 0) return true
    for (const k of keys) {
      const v = obj[k]
      if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>
        if (rec.status !== 'idle') return false
        if (typeof rec.txHash === 'string' && rec.txHash !== '') return false
      }
    }
    return true
  }
  // useBindFlow 的返回结构：没有 running 字段，但有 states/steps/runAll/runOne/retryOne
  type BindFlowShape = typeof flow

  // ✅ F-4/N-1 修复：副作用（hydrate、onStatesChange）必须放 useEffect，不能放在 useMemo 里。
  useEffect(() => {
    if (!initialStates) return
    if (Object.keys(initialStates).length === 0) return
    const fingerprint = JSON.stringify(initialStates)
    if (fingerprint === lastHydrateHashRef.current) return
    if (didHydrateOrMutateRef.current && isAllIdleBind(initialStates as Record<string, unknown>)) return
    lastHydrateHashRef.current = fingerprint
    didHydrateOrMutateRef.current = true
    flow.hydrate(initialStates)
  }, [flow, initialStates])

  useEffect(() => {
    if (!didHydrateOrMutateRef.current) return
    const fp = JSON.stringify(flow.states ?? null)
    if (fp === lastReportedStatesHashRef.current) return
    lastReportedStatesHashRef.current = fp
    onStatesChange(flow.states)
  }, [flow.states, onStatesChange])

  // 同 DeployPanel 补充守卫：flow 内部一旦有非 idle / runningLike 行为就开变异门
  useEffect(() => {
    if (
      flow.states &&
      typeof flow.states === 'object' &&
      !isAllIdleBind(flow.states as Record<string, unknown>)
    ) {
      didHydrateOrMutateRef.current = true
    }
  }, [flow.states])
  // useBindFlow 的 running 字段（如有）
  useEffect(() => {
    const f = flow as BindFlowShape & { running?: boolean }
    if (typeof f.running === 'boolean' && f.running) didHydrateOrMutateRef.current = true
  }, [flow])

  const toggleLog = useCallback((id: string) => {
    setLogOpenMap((m) => ({ ...m, [id]: !m[id] }))
  }, [])

  const grouped = useMemo(() => {
    const token: BindingStepMeta[] = []
    const pool: BindingStepMeta[] = []
    const mining: BindingStepMeta[] = []
    const router: BindingStepMeta[] = []
    const own: BindingStepMeta[] = []
    for (const s of flow.steps) {
      if (['D1', 'D2', 'D3'].includes(s.id)) token.push(s)
      else if (['D4', 'D5', 'D6'].includes(s.id)) pool.push(s)
      else if (['D7', 'D8'].includes(s.id)) mining.push(s)
      else if (['D9', 'D10', 'D11', 'D12'].includes(s.id)) router.push(s)
      else own.push(s)
    }
    return { token, pool, mining, router, own }
  }, [flow.steps])

  const nameByKey = (key: keyof DeployedMap): string => {
    return ALL_CONTRACTS.find((c) => c.id === key)?.name ?? String(key)
  }

  const renderStep = (s: BindingStepMeta): JSX.Element => {
    const st = flow.states[s.id]
    const open = !!logOpenMap[s.id]
    const targetAddr = deployed[s.toKey]
    return (
      <div key={s.id} className={styles.stepRow}>
        <div className="flex items-start gap-3 w-full">
          <div className={`${styles.stepNo} w-8 h-8 shrink-0`}>{s.id}</div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-800">{s.label}</span>
              <span className={`text-sm ${styles.statusIcon}`} aria-hidden>
                {STATUS_ICON[st?.status ?? 'idle']}
              </span>
            </div>
            <div className="mt-1 flex flex-col gap-1 text-xs text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{COPY.targetContract}</span>
                <span className="font-semibold text-slate-700">{nameByKey(s.toKey)}</span>
                {targetAddr ? (
                  <CopyableAddress
                    value={targetAddr}
                    explorerBaseUrl="https://bscscan.com"
                    explorerType="address"
                  />
                ) : (
                  <span className="italic text-slate-400">（未部署）</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{COPY.functionSig}</span>
                <span className="font-mono text-[11px] bg-slate-50 border border-slate-200 px-2 py-0.5 rounded">
                  {s.sig}
                </span>
              </div>
              {st?.txHash ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">TX：</span>
                  <CopyableAddress
                    value={st.txHash}
                    explorerBaseUrl="https://bscscan.com"
                    explorerType="tx"
                  />
                </div>
              ) : null}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-2">
            <button
              type="button"
              disabled={flow.running || st?.status === 'running'}
              onClick={() => void flow.retryOne(s.id)}
              className={`${styles.btnSmall} disabled:opacity-50`}
            >
              {COPY.rerun}
            </button>
            {st?.output ? (
              <button
                type="button"
                className={styles.btnGhostSmall}
                onClick={() => toggleLog(s.id)}
              >
                {open ? COPY.collapseLogs : COPY.expandLogs}
              </button>
            ) : null}
          </div>
        </div>
        {open && st?.output ? (
          <pre className={styles.logBox}>
            <code>{st.output}</code>
          </pre>
        ) : null}
      </div>
    )
  }

  const progressPct =
    flow.steps.length > 0 ? Math.round((flow.progressIdx / flow.steps.length) * 100) : 0

  // 预检：钱包 + 链（9合约部署成功在下方也独立提示）
  const walletOk = isConnected && !!account
  const chainOk = chainId === 56
  const signingAddr = account ?? deployerAddress

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{COPY.title}</h2>
        <p className="text-xs text-slate-500">{COPY.subtitle}</p>
        {signingAddr ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
            <span className="font-medium">{COPY.signingWallet}</span>
            <CopyableAddress value={signingAddr} mode="short" />
          </div>
        ) : null}
      </header>

      {/* 分组 */}
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>{COPY.groups.token}</h3>
        <div className="flex flex-col gap-3">{grouped.token.map(renderStep)}</div>
      </div>
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>{COPY.groups.pool}</h3>
        <div className="flex flex-col gap-3">{grouped.pool.map(renderStep)}</div>
      </div>
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>{COPY.groups.mining}</h3>
        <div className="flex flex-col gap-3">{grouped.mining.map(renderStep)}</div>
      </div>
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>{COPY.groups.router}</h3>
        <div className="flex flex-col gap-3">{grouped.router.map(renderStep)}</div>
      </div>
      {grouped.own.length > 0 ? (
        <div className={`${styles.phaseCard} ${styles.phaseB}`}>
          <h3 className={styles.phaseTitle}>{COPY.groups.own}</h3>
          <div className="flex flex-col gap-3">{grouped.own.map(renderStep)}</div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-3">
        <div className={styles.progressWrap}>
          <div
            className={`${styles.progressBar} ${styles.progressBarOrange}`}
            style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
          />
        </div>
        {flow.progressText && (
          <div className="text-xs text-slate-600 font-mono">{flow.progressText}</div>
        )}
        {!walletOk && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 p-3 rounded-lg">
            ❌ {COPY.errWallet}
          </div>
        )}
        {walletOk && !chainOk && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 p-3 rounded-lg">
            ❌ {COPY.errChain}
          </div>
        )}
        {!deployFlowAllSuccess && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded-lg">
            ⚠️ {COPY.preflight}
          </div>
        )}
        <button
          type="button"
          disabled={flow.running || !deployFlowAllSuccess || !walletOk || !chainOk}
          className={`${styles.btnOrangeBig} disabled:opacity-60`}
          onClick={() => void flow.runAll()}
        >
          {flow.running ? flow.progressText || '绑定中…' : COPY.runAll}
        </button>
        <button
          type="button"
          disabled={flow.running || !deployFlowAllSuccess || !walletOk || !chainOk}
          className="ml-3 px-5 py-2.5 rounded-lg text-sm font-semibold border-2 border-rose-500 text-rose-600 bg-white hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
          onClick={() => void flow.runAll(true)}
          title="跳过链上预检，强制重新执行全部绑定交易（Router 换地址后必用）"
        >
          🔄 强制重新绑定（跳过预检）
        </button>
        <p className="text-[11px] text-slate-400">
          注：所有未填写的 *WALLET / BOOST_FEE_RECIPIENT 字段将使用签名钱包地址
          {COPY.walletFallback}
        </p>
      </div>
    </section>
  )
}

export default BindingPanel
