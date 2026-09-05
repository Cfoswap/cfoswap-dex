// 自建矿池销毁费面板：调整 CfoMiningPoolFactory.createPool 时销毁的 CFO 数量
// 链上接口 setCreatePoolFee(uint256)（onlyOwner），设为 0 即关闭销毁
// 输入单位：CFO 整数（1 = 1 个 CFO），前端自动 ×10^18 转 wei
// --------------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import type { DeployedMap, EnvCfg, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'
import CopyableAddress from '@/components/common/CopyableAddress'

// ================ 常量 ================
const CFO_DECIMALS = 18
const ONE_CFO = 10n ** BigInt(CFO_DECIMALS)
// 4-byte selectors（cast sig 验证）
const SEL_CREATE_POOL_FEE = '0x871564eb' // CREATE_POOL_FEE() -> (uint256)
const SEL_SET_CREATE_POOL_FEE = '0xcb84d997' // setCreatePoolFee(uint256)
const SEL_OWNER = '0x8da5cb5b' // owner() -> (address)

// ================ 类型 ================
export interface PoolFeePanelProps {
  readonly deployed: DeployedMap
  readonly walletAddr: string
  readonly notify: (kind: ToastKind, msg: string) => void
  readonly env: EnvCfg
}

// ================ 组件 ================
export default function PoolFeePanel({ deployed, walletAddr, notify, env }: PoolFeePanelProps) {
  // ---- 部署地址（CfoMiningPoolFactory 工厂合约）----
  const poolFactoryAddr = deployed.biz_pool ?? ''

  // ---- 输入：CFO 整数数量（string 保存输入中态，提交时校验；0 = 关闭销毁）----
  const [feeCfo, setFeeCfo] = useState('')

  // ---- 链上只读 ----
  const [onChainFeeWei, setOnChainFeeWei] = useState<string>('')
  const [onChainOwner, setOnChainOwner] = useState<string>('')
  const [loadingOnChain, setLoadingOnChain] = useState(false)

  // ---- 签名状态 ----
  const [loadingSet, setLoadingSet] = useState(false)
  const [lastTx, setLastTx] = useState<string>('')

  const hasAddr = !!poolFactoryAddr

  // 输入校验：非负整数（按 CFO 个数，不支持小数）
  const inputValid = useMemo(() => /^\d+$/.test(feeCfo.trim()), [feeCfo])
  const feeWei = useMemo(() => {
    if (!inputValid) return ''
    try {
      return (BigInt(feeCfo.trim()) * ONE_CFO).toString()
    } catch {
      return ''
    }
  }, [feeCfo, inputValid])

  // ---- 读链上状态（硬编码 selector，避开 ethers Interface 解析问题）----
  const refreshChainState = useCallback(async () => {
    if (!hasAddr) return
    setLoadingOnChain(true)
    try {
      // 钱包已连接时走钱包注入的 provider（与签名同链，避免 env RPC 不可达）；
      // 未连接时回退到 env 配置的公共 RPC
      const injected = (
        window as unknown as { ethereum?: ethers.providers.ExternalProvider }
      ).ethereum
      const provider =
        walletAddr && injected
          ? new ethers.providers.Web3Provider(injected)
          : new ethers.providers.JsonRpcProvider(env.RPC_URL)
      const { defaultAbiCoder } = ethers.utils
      const [feeRaw, ownerRaw] = await Promise.all([
        provider.call({ to: poolFactoryAddr, data: SEL_CREATE_POOL_FEE }),
        provider.call({ to: poolFactoryAddr, data: SEL_OWNER }),
      ])
      setOnChainFeeWei(
        feeRaw !== '0x' ? defaultAbiCoder.decode(['uint256'], feeRaw)[0].toString() : ''
      )
      setOnChainOwner(
        ownerRaw !== '0x' ? (defaultAbiCoder.decode(['address'], ownerRaw)[0] as string) : ''
      )
    } catch (e) {
      notify('error', `查询链上状态失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingOnChain(false)
    }
  }, [hasAddr, poolFactoryAddr, walletAddr, env.RPC_URL, notify])

  useEffect(() => {
    void refreshChainState()
  }, [refreshChainState])

  // 首次读到链上值后预填输入框（仅当输入框未被用户动过）
  useEffect(() => {
    if (onChainFeeWei && feeCfo === '') {
      setFeeCfo(formatCfo(onChainFeeWei))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChainFeeWei])

  const isOwner =
    !!walletAddr && !!onChainOwner && walletAddr.toLowerCase() === onChainOwner.toLowerCase()

  // ---- 签名修改 ----
  const handleSetFee = useCallback(async () => {
    if (!hasAddr) {
      notify('error', '⚠️ 尚未部署 CfoMiningPoolFactory 工厂合约')
      return
    }
    if (!walletAddr) {
      notify('error', '⚠️ 请先连接钱包')
      return
    }
    if (!isOwner) {
      notify('error', `❌ 当前钱包不是工厂合约 owner。owner=${onChainOwner || '查询中…'}`)
      return
    }
    if (!inputValid) {
      notify('error', '⚠️ 请输入非负整数（单位：个 CFO），填 0 表示关闭销毁')
      return
    }
    if (!feeWei) {
      notify('error', '⚠️ 数量换算失败，请检查输入')
      return
    }

    setLoadingSet(true)
    setLastTx('')
    try {
      const provider = new ethers.providers.Web3Provider(
        (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
      )
      const signer = provider.getSigner()
      const { defaultAbiCoder } = ethers.utils
      const txData =
        SEL_SET_CREATE_POOL_FEE + defaultAbiCoder.encode(['uint256'], [feeWei]).slice(2)
      const tx = await signer.sendTransaction({
        to: poolFactoryAddr,
        data: txData,
        gasLimit: 200_000,
      })
      setLastTx(tx.hash)
      notify('info', `📤 已提交签名：${tx.hash.slice(0, 18)}...`)
      const receipt = await tx.wait(2)
      if (receipt.status === 1) {
        notify('success', `✅ 销毁数量修改成功！tx=${tx.hash.slice(0, 18)}...`)
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
      setLoadingSet(false)
    }
  }, [
    hasAddr,
    poolFactoryAddr,
    walletAddr,
    isOwner,
    onChainOwner,
    inputValid,
    feeWei,
    notify,
    refreshChainState,
  ])

  const globalDisabled = loadingSet || loadingOnChain || !walletAddr

  return (
    <div className="space-y-4">
      {/* 顶部说明 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>🏭 自建矿池销毁费 — 创建矿池时销毁的 CFO 数量</h3>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          用户调用工厂合约 <code>createPool</code> 自建矿池时，会从创建者钱包转
          <code> CREATE_POOL_FEE </code> 数量的 CFO 到销毁地址（0x…dEaD）。
          本面板由合约 <code>owner</code> 调整该数量；<strong>填 0 表示关闭销毁</strong>。
          输入单位为「个 CFO」（1 = 1 个 CFO，100 = 100 个 CFO），自动换算 wei。
        </p>
      </div>

      {/* 合约地址 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>① 合约地址</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-28 shrink-0">矿池工厂合约：</span>
            {poolFactoryAddr ? (
              <CopyableAddress
                value={poolFactoryAddr}
                explorerBaseUrl="https://bscscan.com"
                explorerType="address"
              />
            ) : (
              <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">
                ⚠️ 未部署
              </code>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-28 shrink-0">合约 owner：</span>
            {onChainOwner ? (
              <CopyableAddress
                value={onChainOwner}
                explorerBaseUrl="https://bscscan.com"
                explorerType="address"
              />
            ) : (
              <span className="text-xs text-slate-400 italic">查询中…</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-28 shrink-0">你的钱包：</span>
            {walletAddr ? (
              <CopyableAddress value={walletAddr} mode="short" />
            ) : (
              <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">
                ⚠️ 未连接
              </code>
            )}
            {walletAddr && onChainOwner ? (
              isOwner ? (
                <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
                  ✅ 权限正常（你是 owner）
                </span>
              ) : (
                <span className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
                  ❌ 当前钱包非 owner，无法修改
                </span>
              )
            ) : null}
          </div>
        </div>
      </div>

      {/* 链上当前值 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>② 链上当前销毁数量</h3>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div className="border border-slate-200 rounded-lg px-3 py-2 bg-slate-50">
            <div className="text-xs text-slate-500">当前 CREATE_POOL_FEE</div>
            <div className="text-sm font-medium text-slate-800 mt-0.5 break-all">
              {onChainFeeWei ? (
                <>
                  {formatCfo(onChainFeeWei)} <span className="text-slate-500">CFO</span>
                  {BigInt(onChainFeeWei) === 0n && (
                    <span className="text-amber-600 ml-2">（当前已关闭销毁）</span>
                  )}
                </>
              ) : (
                '-'
              )}
            </div>
          </div>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void refreshChainState()}
            disabled={loadingOnChain || !hasAddr}
            className={`${styles.btnSecondary} px-4 py-2 text-sm disabled:opacity-50`}
          >
            {loadingOnChain ? '⏳ 查询中…' : '🔄 刷新链上状态'}
          </button>
        </div>
      </div>

      {/* 签名修改 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>③ 修改销毁数量</h3>
        <div className="mt-3">
          <label className="block text-sm text-slate-700 mb-1">
            新的销毁数量（单位：个 CFO，整数；填 0 = 关闭销毁）
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={feeCfo}
            onChange={(e) => setFeeCfo(e.target.value)}
            disabled={globalDisabled}
            className="w-56 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100"
            placeholder="例如：1000"
            spellCheck={false}
          />
          {feeCfo.trim() !== '' && !inputValid && (
            <span className="text-xs text-red-600 ml-2">⚠️ 只允许非负整数（不支持小数）</span>
          )}
          {inputValid && feeWei && (
            <span className="text-xs text-slate-500 ml-2">
              = {feeCfo.trim()} 个 CFO（wei: {feeWei.slice(0, 24)}…）
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSetFee()}
            disabled={globalDisabled || !hasAddr || !isOwner || !inputValid}
            className={`${styles.btnPrimary} px-5 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loadingSet ? '⏳ 签名中…' : '🏭 签名修改销毁数量'}
          </button>
          <span className="text-xs text-slate-500">
            编码：selector <code>{SEL_SET_CREATE_POOL_FEE}</code> + ABI(uint256)
          </span>
        </div>

        {lastTx && (
          <div className="mt-3 text-xs text-slate-600">
            上次 tx：
            <a
              href={`https://bscscan.com/tx/${lastTx}`}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-600 hover:underline break-all"
            >
              {lastTx}
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

// ================ 辅助 ================
function formatCfo(weiStr: string): string {
  try {
    const v = BigInt(weiStr)
    return (v / ONE_CFO).toString()
  } catch {
    return weiStr
  }
}
