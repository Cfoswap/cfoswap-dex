import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DeployedMap, StepStatus, ToastKind } from '../types/foundry'
import type { DeployStateMap } from '../hooks/useDeployFlow'
import type { BindStateMap } from '../hooks/useBindFlow'
import styles from '../FoundryDeploy.module.css'
import {
  ALL_CONTRACTS,
  BINDING_STEPS,
  LIBRARY_CONTRACTS,
  OWNER_TRANSFERS,
  STANDALONE_CONTRACTS,
  ROUTER_CONTRACT,
} from '../data/deployMeta'
import type { BindingStep } from '../data/deployMeta'
import { useDeployApi } from '../hooks/useDeployApi'
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
  readonly cols: {
    readonly name: string
    readonly addr: string
    readonly action: string
    readonly deployTx: string
    readonly status: string
    readonly id: string
    readonly desc: string
    readonly tx: string
  }
  readonly reload: string
  readonly copyJSON: string
  readonly copied: string
  readonly noResult: string
  readonly jsonDesc: string
  readonly routerDesc: string
  readonly tabs: { readonly libs: string; readonly biz: string; readonly binds: string; readonly json: string }
} = {
  title: '📋 结果汇总与日志',
  subtitle: '从服务端持久化文件（deployed-addresses.json）读取，方便二次对照与分享。',
  tabs: {
    libs: '5 个路由库',
    biz: '4 个业务合约',
    binds: '绑定交易 (D1~D15)',
    json: '完整 JSON 存档',
  },
  cols: {
    name: '合约名',
    addr: '部署地址',
    action: '操作',
    deployTx: '部署哈希',
    status: '状态',
    id: '编号',
    desc: '说明 / 目标合约',
    tx: '交易哈希',
  },
  reload: '🔄 重新加载服务端保存的结果',
  copyJSON: '📋 复制所有地址 JSON',
  copied: '已复制 ✅',
  noResult: '服务端暂未保存结果（尚未开始部署或首次运行）。',
  jsonDesc: '下方为 /api/deployer/result 返回的完整数据（包含部署地址、状态及绑定交易）。',
  routerDesc: '（主路由）',
}

export type ResultPanelProps = {
  readonly deployStates: DeployStateMap
  readonly bindStates: BindStateMap
  readonly deployed: DeployedMap
  readonly notify: (kind: ToastKind, message: string) => void
  readonly onHydrateFromServer: (deploy: DeployStateMap, bind: BindStateMap, data: unknown) => void
  readonly bindStepsCount: number
  readonly ownerTransfersEnabled: boolean
}

// 兜底：单个 DeployStepState 空态（避免 deployStates 缺 key 时直接访问 .txHash/.status 抛错）
const EMPTY_DEPLOY = {
  status: 'idle' as StepStatus,
  address: '',
  txHash: '',
  output: '',
  exitCode: null,
  elapsedMs: 0,
  startedAt: null,
  endedAt: null,
}

/** Tab4：结果汇总表 */
function ResultPanel(props: ResultPanelProps): JSX.Element {
  const { deployStates, bindStates, deployed, notify, onHydrateFromServer, ownerTransfersEnabled } = props
  const { getResult } = useDeployApi()
  const [rawData, setRawData] = useState<unknown>(null)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
  const [loading, setLoading] = useState(false)

  const reloadFromServer = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getResult()
      setRawData(r.data)
      // 尝试解析并上抛以刷新父组件
      if (r.data && typeof r.data === 'object') {
        const d = r.data as Record<string, unknown>
        const nextDeploy = (d.deployStates ?? {}) as DeployStateMap
        const nextBind = (d.bindStates ?? {}) as BindStateMap
        onHydrateFromServer(nextDeploy, nextBind, r.data)
      }
      notify('success', '结果已从服务端重新加载')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('error', `加载失败：${msg.slice(0, 120)}`)
    } finally {
      setLoading(false)
    }
  }, [getResult, notify, onHydrateFromServer])

  useEffect(() => {
    void reloadFromServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getDeploy = (key: keyof DeployedMap) => {
    return (deployStates?.[key] ?? EMPTY_DEPLOY) as (typeof EMPTY_DEPLOY) & { verifyTaskId?: string }
  }

  const contractListJson = useMemo(() => {
    const obj: Record<string, { name: string; address: string; txHash: string; status: StepStatus }> = {}
    for (const c of ALL_CONTRACTS) {
      const d = getDeploy(c.id)
      obj[c.id] = {
        name: c.name,
        address: deployed[c.id],
        txHash: d.txHash,
        status: d.status,
      }
    }
    return obj
  }, [deployed, deployStates])

  const handleCopyJSON = useCallback(async () => {
    const payload = {
      contracts: contractListJson,
      bindings: bindStates,
      raw: rawData,
    }
    const text = JSON.stringify(payload, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      setJsonCopied(true)
      setTimeout(() => setJsonCopied(false), 1400)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('error', `复制失败：${msg}`)
    }
  }, [contractListJson, bindStates, rawData, notify])

  const bizContracts = useMemo(() => [...STANDALONE_CONTRACTS, ROUTER_CONTRACT], [])

  const bindingRows = useMemo<BindingStep[]>(() => {
    const list: BindingStep[] = [...BINDING_STEPS]
    if (ownerTransfersEnabled) {
      for (const t of OWNER_TRANSFERS) {
        list.push({
          id: t.id,
          label: t.label,
          toKey: t.toKey,
          sig: t.sig,
          buildArgs: () => [],
          buildArgsAsValues: () => [],
        })
      }
    }
    return list
  }, [ownerTransfersEnabled])

  const rawText = useMemo(() => {
    if (rawData == null) return ''
    try {
      return JSON.stringify(rawData, null, 2)
    } catch {
      return String(rawData)
    }
  }, [rawData])

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{COPY.title}</h2>
        <p className="text-xs text-slate-500">{COPY.subtitle}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={reloadFromServer}
            className={`${styles.btnSecondary} px-3 py-1.5 text-sm disabled:opacity-60`}
          >
            {loading ? '加载中…' : COPY.reload}
          </button>
          <button
            type="button"
            onClick={handleCopyJSON}
            className={`${styles.btnGhost} px-3 py-1.5 text-sm`}
          >
            {jsonCopied ? COPY.copied : COPY.copyJSON}
          </button>
        </div>
      </header>

      {/* 9 合约总览表 */}
      <div className="overflow-x-auto mb-6">
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>{COPY.cols.name}</th>
              <th>{COPY.cols.addr}</th>
              <th>{COPY.cols.action}</th>
              <th>{COPY.cols.deployTx}</th>
            </tr>
          </thead>
          <tbody>
            {ALL_CONTRACTS.map((c) => {
              const addr = deployed[c.id]
              const tx = getDeploy(c.id).txHash
              return (
                <tr key={c.id}>
                  <td className="whitespace-nowrap">
                    <span className="font-semibold text-slate-800">{c.name}</span>
                    {c.id === 'biz_router' ? (
                      <span className="ml-2 text-[10px] text-primary-700 bg-primary-50 border border-primary-200 px-1.5 py-0.5 rounded">
                        {COPY.routerDesc}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {addr ? (
                      <CopyableAddress value={addr} />
                    ) : (
                      <span className="italic text-slate-400">—</span>
                    )}
                  </td>
                  <td>
                    {addr ? (
                      <a
                        className="text-primary-700 hover:underline text-xs"
                        href={`https://bscscan.com/address/${addr}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        🔗 BscScan
                      </a>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td>
                    {tx ? (
                      <CopyableAddress value={tx} explorerBaseUrl="https://bscscan.com" explorerType="tx" />
                    ) : (
                      <span className="italic text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 5 路由库分组 */}
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>
          {COPY.tabs.libs}（Phase A）
        </h3>
        <div className="overflow-x-auto">
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{COPY.cols.status}</th>
                <th>{COPY.cols.name}</th>
                <th>{COPY.cols.addr}</th>
              </tr>
            </thead>
            <tbody>
              {LIBRARY_CONTRACTS.map((lib) => (
                <tr key={lib.id}>
                  <td className="whitespace-nowrap">
                    <span aria-hidden>{STATUS_ICON[getDeploy(lib.id).status]}</span>
                  </td>
                  <td className="whitespace-nowrap font-medium text-slate-800">{lib.name}</td>
                  <td>
                    {deployed[lib.id] ? (
                      <CopyableAddress value={deployed[lib.id]} />
                    ) : (
                      <span className="italic text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4 业务合约分组 */}
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>
          {COPY.tabs.biz}（Phase B + C）
        </h3>
        <div className="overflow-x-auto">
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{COPY.cols.status}</th>
                <th>{COPY.cols.name}</th>
                <th>{COPY.cols.addr}</th>
              </tr>
            </thead>
            <tbody>
              {bizContracts.map((biz) => (
                <tr key={biz.id}>
                  <td className="whitespace-nowrap">
                    <span aria-hidden>{STATUS_ICON[getDeploy(biz.id).status]}</span>
                  </td>
                  <td className="whitespace-nowrap font-medium text-slate-800">
                    {biz.name}
                    {biz.desc ? (
                      <span className="ml-2 text-[11px] text-slate-500">（{biz.desc}）</span>
                    ) : null}
                  </td>
                  <td>
                    {deployed[biz.id] ? (
                      <CopyableAddress value={deployed[biz.id]} />
                    ) : (
                      <span className="italic text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 绑定结果表 */}
      <div className={styles.phaseCard}>
        <h3 className={styles.phaseTitle}>{COPY.tabs.binds}</h3>
        <div className="overflow-x-auto">
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{COPY.cols.id}</th>
                <th>{COPY.cols.status}</th>
                <th>{COPY.cols.desc}</th>
                <th>{COPY.cols.tx}</th>
              </tr>
            </thead>
            <tbody>
              {bindingRows.map((r) => {
                const s = bindStates[r.id]
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap font-mono text-xs">{r.id}</td>
                    <td className="whitespace-nowrap">
                      <span aria-hidden>{STATUS_ICON[s?.status ?? 'idle']}</span>
                    </td>
                    <td className="text-sm text-slate-700">{r.label}</td>
                    <td>
                      {s?.txHash ? (
                        <CopyableAddress value={s.txHash} explorerBaseUrl="https://bscscan.com" explorerType="tx" />
                      ) : (
                        <span className="italic text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 完整 JSON 折叠 */}
      <div className={styles.phaseCard}>
        <button
          type="button"
          onClick={() => setJsonOpen((v) => !v)}
          className="flex items-center justify-between w-full text-left"
        >
          <h3 className={styles.phaseTitle}>{COPY.tabs.json}</h3>
          <span className="text-xs text-slate-500">{jsonOpen ? '收起 ▲' : '展开 ▼'}</span>
        </button>
        {jsonOpen && (
          <div className="mt-2">
            <p className="text-xs text-slate-500 mb-2">{COPY.jsonDesc}</p>
            {rawText ? (
              <pre className={styles.logBox}>
                <code>{rawText}</code>
              </pre>
            ) : (
              <p className="text-sm text-slate-400">{COPY.noResult}</p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export default ResultPanel
