// 收款地址管理面板：单独修改 税费(CfoToken) / 手续费(CfoRouter) / 助力金(Factory) 接收钱包
// 税费/手续费为 3 钱包数组（合约函数要求整组提交）：改单个钱包时，其余钱包与分成比例
// 自动按链上现值回传，实现「改哪个只动哪个」；每改一个钱包 = 1 笔独立签名交易。
// 手续费钱包在 Router 中为 private 无 getter，通过 eth_getStorageAt 直读固定存储槽
// （slot 5-7 = 3 个地址，slot 8-10 = 3 个分成 bps；forge inspect storageLayout 验证）。
// --------------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react'
import { ethers } from 'ethers'
import type { DeployedMap, EnvCfg, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'
import CopyableAddress from '@/components/common/CopyableAddress'

// 4-byte selectors（cast sig 验证）
const SEL_OWNER = '0x8da5cb5b' // owner() -> (address)
const SEL_TEAM_WALLETS = '0x4c1ccf12' // teamWallets(uint256) -> (address)
const SEL_TEAM_SHARES = '0x8647b613' // teamShares(uint256) -> (uint256)
const SEL_SET_TEAM_DIST = '0x63243564' // setTeamDistribution(address[3],uint256[3])
const SEL_SET_FEE_DIST = '0x38074d1e' // setPlatformFeeDistribution(address[3],uint256[3])
const SEL_BOOST_RECIPIENT = '0x1591b47a' // boostFeeRecipient() -> (address)
const SEL_SET_BOOST = '0x2b954686' // setBoostFeeRecipient(address)

// Router 固定数组存储槽
const ROUTER_RECIPIENT_SLOTS = [5, 6, 7]
const ROUTER_SHARE_SLOTS = [8, 9, 10]
const SHARES_SUM_BPS = 10000

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

// ================ 类型 ================
interface AddrSetState {
  addrs: string[]
  sharesBps: number[]
  owner: string
}

interface BoostState {
  addr: string
  owner: string
}

type SetKind = 'tax' | 'fee'

export interface RecipientPanelProps {
  readonly deployed: DeployedMap
  readonly walletAddr: string
  readonly notify: (kind: ToastKind, msg: string) => void
  readonly env: EnvCfg
}

// ================ 工具 ================
function isValidAddr(v: string): boolean {
  return ADDR_RE.test(v.trim()) && v.trim().toLowerCase() !== ZERO_ADDR
}

function bpsPct(bps: number): string {
  return `${bps / 100}%`
}

// ================ 组件 ================
export default function RecipientPanel({ deployed, walletAddr, notify, env }: RecipientPanelProps) {
  const tokenAddr = deployed.biz_token ?? ''
  const routerAddr = deployed.biz_router ?? ''
  const factoryAddr = deployed.biz_pool ?? ''

  const [tax, setTax] = useState<AddrSetState | null>(null)
  const [fee, setFee] = useState<AddrSetState | null>(null)
  const [boost, setBoost] = useState<BoostState | null>(null)
  const [loadingTax, setLoadingTax] = useState(false)
  const [loadingFee, setLoadingFee] = useState(false)
  const [loadingBoost, setLoadingBoost] = useState(false)

  // 每行独立的新地址输入 / 签名中状态 / 上次 tx（key: 'tax-0' | 'fee-2' | 'boost'）
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({})
  const [lastTx, setLastTx] = useState<Record<string, string>>({})

  const makeProvider = useCallback((): ethers.providers.BaseProvider => {
    const injected = (
      window as unknown as { ethereum?: ethers.providers.ExternalProvider }
    ).ethereum
    return walletAddr && injected
      ? new ethers.providers.Web3Provider(injected)
      : new ethers.providers.JsonRpcProvider(env.RPC_URL)
  }, [walletAddr, env.RPC_URL])

  // ---- 链上只读：税费 3 钱包（CfoToken public getter）----
  const refreshTax = useCallback(async () => {
    if (!tokenAddr) return
    setLoadingTax(true)
    try {
      const provider = makeProvider()
      const { defaultAbiCoder } = ethers.utils
      const addrs: string[] = []
      const sharesBps: number[] = []
      for (let i = 0; i < 3; i++) {
        const wData = SEL_TEAM_WALLETS + defaultAbiCoder.encode(['uint256'], [i]).slice(2)
        const wRet = await provider.call({ to: tokenAddr, data: wData })
        addrs.push(defaultAbiCoder.decode(['address'], wRet)[0] as string)
        const sData = SEL_TEAM_SHARES + defaultAbiCoder.encode(['uint256'], [i]).slice(2)
        const sRet = await provider.call({ to: tokenAddr, data: sData })
        sharesBps.push(Number((defaultAbiCoder.decode(['uint256'], sRet)[0] as ethers.BigNumber).toString()))
      }
      const oRet = await provider.call({ to: tokenAddr, data: SEL_OWNER })
      const owner = defaultAbiCoder.decode(['address'], oRet)[0] as string
      setTax({ addrs, sharesBps, owner })
    } catch (e) {
      notify('error', `读取税费钱包失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingTax(false)
    }
  }, [tokenAddr, makeProvider, notify])

  // ---- 链上只读：手续费 3 钱包（CfoRouter private 变量 → 存储槽直读）----
  const refreshFee = useCallback(async () => {
    if (!routerAddr) return
    setLoadingFee(true)
    try {
      const provider = makeProvider() as ethers.providers.JsonRpcProvider
      const { defaultAbiCoder } = ethers.utils
      const addrs: string[] = []
      const sharesBps: number[] = []
      for (const slot of ROUTER_RECIPIENT_SLOTS) {
        const raw = await provider.send('eth_getStorageAt', [
          routerAddr,
          '0x' + slot.toString(16),
          'latest',
        ])
        addrs.push(ethers.utils.getAddress('0x' + String(raw).slice(-40)))
      }
      for (const slot of ROUTER_SHARE_SLOTS) {
        const raw = await provider.send('eth_getStorageAt', [
          routerAddr,
          '0x' + slot.toString(16),
          'latest',
        ])
        sharesBps.push(parseInt(String(raw), 16))
      }
      const sum = sharesBps.reduce((a, b) => a + b, 0)
      if (addrs.some((a) => a === ZERO_ADDR) || sum !== SHARES_SUM_BPS) {
        throw new Error(`存储槽回读校验失败（分成合计=${sum} bps，应为 10000），请刷新重试`)
      }
      const oRet = await provider.call({ to: routerAddr, data: SEL_OWNER })
      const owner = defaultAbiCoder.decode(['address'], oRet)[0] as string
      setFee({ addrs, sharesBps, owner })
    } catch (e) {
      notify('error', `读取手续费钱包失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingFee(false)
    }
  }, [routerAddr, makeProvider, notify])

  // ---- 链上只读：助力金接收（Factory public getter）----
  const refreshBoost = useCallback(async () => {
    if (!factoryAddr) return
    setLoadingBoost(true)
    try {
      const provider = makeProvider()
      const { defaultAbiCoder } = ethers.utils
      const bRet = await provider.call({ to: factoryAddr, data: SEL_BOOST_RECIPIENT })
      const addr = defaultAbiCoder.decode(['address'], bRet)[0] as string
      const oRet = await provider.call({ to: factoryAddr, data: SEL_OWNER })
      const owner = defaultAbiCoder.decode(['address'], oRet)[0] as string
      setBoost({ addr, owner })
    } catch (e) {
      notify('error', `读取助力金接收地址失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingBoost(false)
    }
  }, [factoryAddr, makeProvider, notify])

  const refreshAll = useCallback(() => {
    void refreshTax()
    void refreshFee()
    void refreshBoost()
  }, [refreshTax, refreshFee, refreshBoost])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // ---- 签名：修改税费/手续费 3 钱包中的某一个（其余按链上现值回传）----
  const handleSetOne = useCallback(
    async (kind: SetKind, index: number) => {
      const state = kind === 'tax' ? tax : fee
      const target = kind === 'tax' ? tokenAddr : routerAddr
      const selector = kind === 'tax' ? SEL_SET_TEAM_DIST : SEL_SET_FEE_DIST
      const label = kind === 'tax' ? '税费' : '手续费'
      const key = `${kind}-${index}`
      if (!target) {
        notify('error', `⚠️ 尚未部署${label}对应的合约`)
        return
      }
      if (!walletAddr) {
        notify('error', '⚠️ 请先连接钱包')
        return
      }
      if (!state) {
        notify('error', '⚠️ 链上当前值尚未读取，请先刷新')
        return
      }
      if (walletAddr.toLowerCase() !== state.owner.toLowerCase()) {
        notify('error', `❌ 当前钱包不是合约 owner（owner=${state.owner}），无法修改`)
        return
      }
      const newAddrRaw = (edits[key] ?? '').trim()
      if (!isValidAddr(newAddrRaw)) {
        notify('error', '⚠️ 新地址格式不正确（需 0x + 40 位 hex，且不能为零地址）')
        return
      }
      const newAddr = ethers.utils.getAddress(newAddrRaw)
      if (newAddr.toLowerCase() === state.addrs[index].toLowerCase()) {
        notify('warning', '新地址与链上当前地址相同，无需修改')
        return
      }

      setBusyKeys((p) => ({ ...p, [key]: true }))
      try {
        const provider = new ethers.providers.Web3Provider(
          (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
        )
        const signer = provider.getSigner()
        const { defaultAbiCoder } = ethers.utils
        const addrs = [...state.addrs]
        addrs[index] = newAddr
        const data =
          selector +
          defaultAbiCoder
            .encode(['address[3]', 'uint256[3]'], [addrs, state.sharesBps.map((b) => b.toString())])
            .slice(2)
        const tx = await signer.sendTransaction({ to: target, data, gasLimit: 200_000 })
        setLastTx((p) => ({ ...p, [key]: tx.hash }))
        notify('info', `📤 已提交签名（${label}钱包${index + 1}）：${tx.hash.slice(0, 18)}...`)
        const receipt = await tx.wait(2)
        if (receipt.status === 1) {
          notify('success', `✅ ${label}钱包${index + 1}修改成功！`)
          setEdits((p) => ({ ...p, [key]: '' }))
          if (kind === 'tax') await refreshTax()
          else await refreshFee()
        } else {
          notify('error', `❌ 交易失败：${tx.hash}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('4001')) {
          notify('warning', '用户取消签名')
        } else {
          notify('error', `签名失败：${msg.slice(0, 120)}`)
        }
      } finally {
        setBusyKeys((p) => ({ ...p, [key]: false }))
      }
    },
    [tax, fee, tokenAddr, routerAddr, walletAddr, edits, notify, refreshTax, refreshFee]
  )

  // ---- 签名：修改助力金接收地址 ----
  const handleSetBoost = useCallback(async () => {
    if (!factoryAddr) {
      notify('error', '⚠️ 尚未部署 CfoMiningPoolFactory 工厂合约')
      return
    }
    if (!walletAddr) {
      notify('error', '⚠️ 请先连接钱包')
      return
    }
    if (!boost) {
      notify('error', '⚠️ 链上当前值尚未读取，请先刷新')
      return
    }
    if (walletAddr.toLowerCase() !== boost.owner.toLowerCase()) {
      notify('error', `❌ 当前钱包不是合约 owner（owner=${boost.owner}），无法修改`)
      return
    }
    const newAddrRaw = (edits['boost'] ?? '').trim()
    if (!isValidAddr(newAddrRaw)) {
      notify('error', '⚠️ 新地址格式不正确（需 0x + 40 位 hex，且不能为零地址）')
      return
    }
    const newAddr = ethers.utils.getAddress(newAddrRaw)
    if (newAddr.toLowerCase() === boost.addr.toLowerCase()) {
      notify('warning', '新地址与链上当前地址相同，无需修改')
      return
    }

    setBusyKeys((p) => ({ ...p, boost: true }))
    try {
      const provider = new ethers.providers.Web3Provider(
        (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
      )
      const signer = provider.getSigner()
      const { defaultAbiCoder } = ethers.utils
      const data = SEL_SET_BOOST + defaultAbiCoder.encode(['address'], [newAddr]).slice(2)
      const tx = await signer.sendTransaction({ to: factoryAddr, data, gasLimit: 100_000 })
      setLastTx((p) => ({ ...p, boost: tx.hash }))
      notify('info', `📤 已提交签名（助力金接收）：${tx.hash.slice(0, 18)}...`)
      const receipt = await tx.wait(2)
      if (receipt.status === 1) {
        notify('success', '✅ 助力金接收地址修改成功！')
        setEdits((p) => ({ ...p, boost: '' }))
        await refreshBoost()
      } else {
        notify('error', `❌ 交易失败：${tx.hash}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('4001')) {
        notify('warning', '用户取消签名')
      } else {
        notify('error', `签名失败：${msg.slice(0, 120)}`)
      }
    } finally {
      setBusyKeys((p) => ({ ...p, boost: false }))
    }
  }, [factoryAddr, walletAddr, boost, edits, notify, refreshBoost])

  // ---- 渲染：合约头部（地址 + owner 权限徽章）----
  const renderContractHeader = (
    addr: string,
    addrLabel: string,
    owner: string | undefined,
    loading: boolean
  ): JSX.Element => (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-slate-500 w-24 shrink-0">{addrLabel}：</span>
        {addr ? (
          <CopyableAddress
            value={addr}
            explorerBaseUrl="https://bscscan.com"
            explorerType="address"
          />
        ) : (
          <code className="text-xs text-red-700 bg-red-50 px-2 py-1 rounded">⚠️ 未部署</code>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-slate-500 w-24 shrink-0">合约 owner：</span>
        {owner ? (
          <>
            <CopyableAddress value={owner} explorerBaseUrl="https://bscscan.com" explorerType="address" />
            {walletAddr ? (
              walletAddr.toLowerCase() === owner.toLowerCase() ? (
                <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
                  ✅ 权限正常（你是 owner）
                </span>
              ) : (
                <span className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
                  ❌ 当前钱包非 owner（D13-D16 转多签后需用多签钱包操作）
                </span>
              )
            ) : (
              <span className="text-xs text-slate-400 italic">连接钱包后校验权限</span>
            )}
          </>
        ) : loading ? (
          <span className="text-xs text-slate-400 italic">查询中…</span>
        ) : (
          <span className="text-xs text-slate-400 italic">-</span>
        )}
      </div>
    </div>
  )

  // ---- 渲染：3 钱包数组卡片的单行 ----
  const renderAddrRow = (
    key: string,
    index: number,
    currentAddr: string,
    pctLabel: string,
    onSubmit: () => void
  ): JSX.Element => {
    const busy = !!busyKeys[key]
    const value = edits[key] ?? ''
    const valid = isValidAddr(value)
    return (
      <div className="border border-slate-200 rounded-lg px-3 py-2.5 bg-slate-50">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-700 w-28 shrink-0">
            钱包{index + 1}（{pctLabel}）
          </span>
          <CopyableAddress value={currentAddr} mode="short" />
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={value}
            onChange={(e) => setEdits((p) => ({ ...p, [key]: e.target.value }))}
            disabled={busy || !walletAddr}
            placeholder="新地址 0x…（只改这一个，其余自动保持不变）"
            spellCheck={false}
            className="flex-1 min-w-[260px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100"
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !walletAddr || !valid}
            className={`${styles.btnPrimary} px-4 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {busy ? '⏳ 签名中…' : '✏️ 修改'}
          </button>
        </div>
        {value.trim() !== '' && !isValidAddr(value) && (
          <div className="text-xs text-red-600 mt-1">⚠️ 地址格式不正确（0x + 40 位 hex）</div>
        )}
        {lastTx[key] && (
          <div className="text-xs text-slate-600 mt-1.5">
            上次 tx：
            <a
              href={`https://bscscan.com/tx/${lastTx[key]}`}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-600 hover:underline break-all"
            >
              {lastTx[key]}
            </a>
          </div>
        )}
      </div>
    )
  }

  const globalLoading = loadingTax || loadingFee || loadingBoost

  return (
    <div className="space-y-4">
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>📥 收款地址管理 — 税费 / 手续费 / 助力金接收钱包</h3>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          每个钱包可<strong>单独修改</strong>：在对应行填入新地址并签名即可，其余钱包与分成比例自动保持链上现值不变。
          三类修改互不影响，每改一个钱包 = 1 笔独立交易；仅合约 <code>owner</code> 可操作。
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={refreshAll}
            disabled={globalLoading}
            className={`${styles.btnSecondary} px-4 py-2 text-sm disabled:opacity-50`}
          >
            {globalLoading ? '⏳ 查询中…' : '🔄 刷新链上状态'}
          </button>
        </div>
      </div>

      {/* ① 税费接收（CfoToken，3 钱包） */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>① 💰 税费接收钱包（CfoToken · 交易税 1% 换 USDT 后分发）</h3>
        {renderContractHeader(tokenAddr, '代币合约', tax?.owner, loadingTax)}
        <div className="mt-3 space-y-2">
          {tax ? (
            [0, 1, 2].map((i) =>
              renderAddrRow(
                `tax-${i}`,
                i,
                tax.addrs[i],
                bpsPct(tax.sharesBps[i]),
                () => void handleSetOne('tax', i)
              )
            )
          ) : (
            <div className="text-sm text-slate-400 italic py-2">
              {loadingTax ? '链上状态读取中…' : tokenAddr ? '点击「刷新链上状态」读取当前配置' : '部署 CfoToken 后可用'}
            </div>
          )}
        </div>
      </div>

      {/* ② 手续费接收（CfoRouter，3 钱包） */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>② 💸 手续费接收钱包（CfoRouter · 平台手续费 USDT 分发）</h3>
        {renderContractHeader(routerAddr, '路由合约', fee?.owner, loadingFee)}
        <div className="mt-3 space-y-2">
          {fee ? (
            [0, 1, 2].map((i) =>
              renderAddrRow(
                `fee-${i}`,
                i,
                fee.addrs[i],
                bpsPct(fee.sharesBps[i]),
                () => void handleSetOne('fee', i)
              )
            )
          ) : (
            <div className="text-sm text-slate-400 italic py-2">
              {loadingFee ? '链上状态读取中…' : routerAddr ? '点击「刷新链上状态」读取当前配置' : '部署 CfoRouter 后可用'}
            </div>
          )}
        </div>
      </div>

      {/* ③ 助力金接收（Factory，1 钱包） */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>③ 🏭 助力金接收钱包（CfoMiningPoolFactory · 自建矿池 BNB 助力费）</h3>
        {renderContractHeader(factoryAddr, '工厂合约', boost?.owner, loadingBoost)}
        <div className="mt-3">
          {boost ? (
            <div className="border border-slate-200 rounded-lg px-3 py-2.5 bg-slate-50">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-700 w-28 shrink-0">当前接收地址</span>
                <CopyableAddress value={boost.addr} mode="short" />
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={edits['boost'] ?? ''}
                  onChange={(e) => setEdits((p) => ({ ...p, boost: e.target.value }))}
                  disabled={!!busyKeys['boost'] || !walletAddr}
                  placeholder="新地址 0x…"
                  spellCheck={false}
                  className="flex-1 min-w-[260px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100"
                />
                <button
                  type="button"
                  onClick={() => void handleSetBoost()}
                  disabled={!!busyKeys['boost'] || !walletAddr || !isValidAddr(edits['boost'] ?? '')}
                  className={`${styles.btnPrimary} px-4 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {busyKeys['boost'] ? '⏳ 签名中…' : '✏️ 修改'}
                </button>
              </div>
              {(edits['boost'] ?? '').trim() !== '' && !isValidAddr(edits['boost'] ?? '') && (
                <div className="text-xs text-red-600 mt-1">⚠️ 地址格式不正确（0x + 40 位 hex）</div>
              )}
              {lastTx['boost'] && (
                <div className="text-xs text-slate-600 mt-1.5">
                  上次 tx：
                  <a
                    href={`https://bscscan.com/tx/${lastTx['boost']}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-600 hover:underline break-all"
                  >
                    {lastTx['boost']}
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-slate-400 italic py-2">
              {loadingBoost
                ? '链上状态读取中…'
                : factoryAddr
                ? '点击「刷新链上状态」读取当前配置'
                : '部署 CfoMiningPoolFactory 后可用'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
