// 铸币授权面板：给 CfoMining 合约授予 CFO 代币铸造额度
// 一次性操作（额度用完前无需重复），用于让 onSwap → mint 成功
// --------------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import type { DeployedMap, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'

// ================ 常量 ================
const CFO_DECIMALS = 18
const DEFAULT_GRANT_CFO = '100000000'
const ONE_CFO = 10n ** BigInt(CFO_DECIMALS)
// 4-byte selectors（cast sig 验证）
const SEL_MINTER_QUOTA      = '0x90bee6d1'  // minterQuota(address) -> (uint256)
const SEL_TOTAL_QUOTA       = '0x507c1819'  // totalQuotaAllocated() -> (uint256)
const SEL_TOTAL_SUPPLY      = '0x18160ddd'  // totalSupply() -> (uint256)
const SEL_MAX_SUPPLY        = '0x32cb6b0c'  // MAX_SUPPLY() -> (uint256)
const SEL_OWNER             = '0x8da5cb5b'  // owner() -> (address)
const SEL_GRANT_MINTER_QUOTA = '0x5790907c' // grantMinterQuota(address,uint256)

// ================ 类型 ================
export interface MintGrantPanelProps {
  readonly deployed: DeployedMap
  readonly walletAddr: string
  readonly notify: (kind: ToastKind, msg: string) => void
}

// ================ 组件 ================
export default function MintGrantPanel({ deployed, walletAddr, notify }: MintGrantPanelProps) {
  // ---- 部署地址 ----
  const cfoAddr = deployed.biz_token ?? ''
  const miningAddr = deployed.biz_mining ?? ''

  // ---- 输入 ----
  const [grantCfo, setGrantCfo] = useState(DEFAULT_GRANT_CFO)

  // ---- 链上只读 ----
  const [quota, setQuota] = useState<string>('')
  const [totalQuota, setTotalQuota] = useState<string>('')
  const [totalSupply, setTotalSupply] = useState<string>('')
  const [maxSupply, setMaxSupply] = useState<string>('')
  const [loadingOnChain, setLoadingOnChain] = useState(false)

  // ---- 签名状态 ----
  const [loadingGrant, setLoadingGrant] = useState(false)
  const [lastGrantTx, setLastGrantTx] = useState<string>('')

  // ---- 预检查 ----
  const hasAddrs = cfoAddr && miningAddr
  const grantWei = useMemo(() => {
    if (!grantCfo || !/^\d+(\.\d+)?$/.test(grantCfo)) return ''
    const [intPart, fracPart = ''] = grantCfo.split('.')
    const fracPadded = (fracPart + '0'.repeat(CFO_DECIMALS)).slice(0, CFO_DECIMALS)
    return (BigInt(intPart) * ONE_CFO + BigInt(fracPadded)).toString()
  }, [grantCfo])

  // ---- 读链上状态（硬编码selector，避开 ethers Interface 括号解析 bug）----
  const refreshChainState = useCallback(async () => {
    if (!hasAddrs || !walletAddr) return
    setLoadingOnChain(true)
    try {
      // 走钱包注入的 provider（本面板刷新前已要求连接钱包，与签名同链，
      // 避免 env 配置的公共 RPC 不可达导致 noNetwork）
      const provider = new ethers.providers.Web3Provider(
        (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
      )
      const { defaultAbiCoder } = ethers.utils
      const calls = [
        provider.call({ to: cfoAddr, data: SEL_MINTER_QUOTA + defaultAbiCoder.encode(['address'], [miningAddr]).slice(2) }),
        provider.call({ to: cfoAddr, data: SEL_TOTAL_QUOTA }),
        provider.call({ to: cfoAddr, data: SEL_TOTAL_SUPPLY }),
        provider.call({ to: cfoAddr, data: SEL_MAX_SUPPLY }),
      ]
      const results = await Promise.allSettled(calls)
      const decodeUint = (i: number) => {
        const r = results[i]
        if (r.status === 'fulfilled' && r.value !== '0x') {
          return defaultAbiCoder.decode(['uint256'], r.value)[0].toString()
        }
        return ''
      }
      setQuota(decodeUint(0))
      setTotalQuota(decodeUint(1))
      setTotalSupply(decodeUint(2))
      setMaxSupply(decodeUint(3))
    } catch (e) {
      notify('error', `查询链上状态失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingOnChain(false)
    }
  }, [hasAddrs, cfoAddr, miningAddr, walletAddr, notify])

  useEffect(() => { void refreshChainState() }, [refreshChainState])

  // ---- 签名授权 ----
  const handleGrant = useCallback(async () => {
    if (!hasAddrs) { notify('error', '⚠️ 尚未部署 CFO 代币或 Mining 合约'); return }
    if (!walletAddr) { notify('error', '⚠️ 请先连接钱包'); return }
    if (!grantWei || grantWei === '0') { notify('error', '⚠️ 授权数量必须大于 0'); return }

    setLoadingGrant(true)
    setLastGrantTx('')
    try {
      const provider = new ethers.providers.Web3Provider(
        (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
      )
      const signer = provider.getSigner()
      // 检查权限：只有 owner 能调 grantMinterQuota（硬编码 selector，避开 Interface 括号 bug）
      const { defaultAbiCoder } = ethers.utils
      const onChainOwner = await provider.call({ to: cfoAddr, data: SEL_OWNER })
      const owner = defaultAbiCoder.decode(['address'], onChainOwner)[0] as string
      if (owner.toLowerCase() !== walletAddr.toLowerCase()) {
        notify('error', `❌ 当前钱包不是 CFO 代币 owner。owner=${owner}`)
        return
      }

      const txData = SEL_GRANT_MINTER_QUOTA + defaultAbiCoder.encode(['address', 'uint256'], [miningAddr, grantWei]).slice(2)
      const tx = await signer.sendTransaction({
        to: cfoAddr,
        data: txData,
        gasLimit: 500_000,
      })
      setLastGrantTx(tx.hash)
      notify('info', `📤 已提交签名：${tx.hash.slice(0, 18)}...`)
      const receipt = await tx.wait(2)
      if (receipt.status === 1) {
        notify('success', `✅ 铸币额度授权成功！tx=${tx.hash.slice(0, 18)}...`)
        await refreshChainState()
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
      setLoadingGrant(false)
    }
  }, [hasAddrs, cfoAddr, miningAddr, walletAddr, grantWei, notify, refreshChainState])

  // ---- 渲染 ----
  const globalDisabled = loadingGrant || loadingOnChain || !walletAddr

  return (
    <div className="space-y-4">
      {/* 顶部说明 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>🪙 铸币授权 — 让挖矿功能生效</h3>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          CfoMining 合约通过 <code>onSwap</code> 收到交易通知时，需要调用 <code>CFO.mint()</code>
          给用户发矿。本面板给 Mining 合约授予铸造额度，一次性操作（额度耗尽前无需重复）。
        </p>
      </div>

      {/* 部署地址显示 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>① 合约地址</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-24">CFO 代币：</span>
            <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">
              {cfoAddr || '⚠️ 未部署'}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-24">Mining 合约：</span>
            <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">
              {miningAddr || '⚠️ 未部署'}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-24">你的钱包：</span>
            <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">
              {walletAddr || '⚠️ 未连接'}
            </code>
          </div>
        </div>
      </div>

      {/* 链上只读状态 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>② 链上只读状态</h3>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="Mining 当前额度" value={quota ? formatCfo(quota) + ' CFO' : '-'} />
          <Stat label="已分配总额" value={totalQuota ? formatCfo(totalQuota) + ' CFO' : '-'} />
          <Stat label="已流通总量" value={totalSupply ? formatCfo(totalSupply) + ' CFO' : '-'} />
          <Stat label="MAX_SUPPLY" value={maxSupply ? formatCfo(maxSupply) + ' CFO' : '-'} />
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void refreshChainState()}
            disabled={loadingOnChain || !hasAddrs}
            className={`${styles.btnSecondary} px-4 py-2 text-sm disabled:opacity-50`}
          >
            {loadingOnChain ? '⏳ 查询中…' : '🔄 刷新链上状态'}
          </button>
        </div>
        {quota === '0' && (
          <p className="mt-2 text-xs text-amber-600 font-medium">
            ⚠️ 当前额度为 0，交易不会触发产矿（onSwap → mint 会静默失败）
          </p>
        )}
      </div>

      {/* 签名授权 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>③ 签名授权</h3>
        <div className="mt-3">
          <label className="block text-sm text-slate-700 mb-1">
            授予 Mining 合约额度（单位：CFO，支持小数）
          </label>
          <input
            type="text"
            value={grantCfo}
            onChange={(e) => setGrantCfo(e.target.value)}
            disabled={globalDisabled}
            className="w-56 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100"
            placeholder="100000000"
            spellCheck={false}
          />
          {grantWei && (
            <span className="text-xs text-slate-500 ml-2">
              wei: {grantWei.slice(0, 24)}…（1 CFO = 10^18 wei）
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleGrant()}
            disabled={globalDisabled || !hasAddrs || !grantWei || grantWei === '0'}
            className={`${styles.btnPrimary} px-5 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loadingGrant ? '⏳ 签名中…' : '🪙 签名授权'}
          </button>
          <span className="text-xs text-slate-500">
            编码：selector <code>{SEL_GRANT_MINTER_QUOTA}</code> + ABI(address, uint256)
          </span>
        </div>

        {lastGrantTx && (
          <div className="mt-3 text-xs text-slate-600">
            上次 tx：<a
              href={`https://bscscan.com/tx/${lastGrantTx}`}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-600 hover:underline break-all"
            >
              {lastGrantTx}
            </a>
          </div>
        )}
      </div>

      {/* 预期效果说明 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>✅ 完成后预期效果</h3>
        <ul className="mt-2 text-sm text-slate-600 space-y-1 list-disc list-inside">
          <li><code>minterQuota[CfoMining 合约地址]</code> 变为 {grantCfo || '100000000'} CFO 的 wei 值</li>
          <li>交易通过 CfoRouter 执行 → onSwap → mint 正常产矿</li>
          <li>产矿额度 = 你授权的数量（建议刚好 = stage1Cap + stage2Cap = 100,000,000 CFO，即 1 亿）</li>
        </ul>
      </div>
    </div>
  )
}

// ================ 辅助 ================
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-slate-200 rounded-lg px-3 py-2 bg-slate-50">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-medium text-slate-800 mt-0.5 break-all">{value}</div>
    </div>
  )
}

function formatCfo(weiStr: string): string {
  try {
    const v = BigInt(weiStr)
    if (v === 0n) return '0'
    const whole = v / ONE_CFO
    const frac = v % ONE_CFO
    const fracStr = frac.toString().padStart(CFO_DECIMALS, '0').replace(/0+$/, '')
    return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString()
  } catch {
    return weiStr
  }
}
