// 税收配置面板：CFO 代币交易税相关配置
// ① 合约与权限状态
// ② setIsPair(lp, true/false)：双池（CFO/USDT + CFO/WBNB）逐个登记/移除，只有经过已登记 pair 的买卖才扣 1% 税
// ③ setPancakeParams(router, usdt, wbnb)：配置税币售卖路由（双池自适应路由，CFO→USDT 即时分发）
// ④ swapAccumulatedTax()：极端行情下自动售卖被跳过时的兜底补卖（独立交易，任何人可调用，调用者付 gas）
// --------------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import type { DeployedMap, EnvCfg, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'
import CopyableAddress from '@/components/common/CopyableAddress'

// ================ 常量 ================
// 4-byte selectors（cast sig 验证）
const SEL_OWNER          = '0x8da5cb5b' // owner() -> (address)
const SEL_TAX_ENABLED    = '0x870bd30b' // taxEnabled() -> (bool)
const SEL_TAX_RATE       = '0x771a3a1d' // taxRate() -> (uint256)
const SEL_IS_PAIR        = '0xe5e31b13' // isPair(address) -> (bool)
const SEL_PANCAKE_ROUTER = '0xc21ebd07' // pancakeRouter() -> (address)
const SEL_USDT           = '0xc54e44eb' // USDT() -> (address)
const SEL_WBNB           = '0x8dd95002' // WBNB() -> (address)
const SEL_SET_IS_PAIR    = '0x2410d887' // setIsPair(address,bool)
const SEL_SET_PANCAKE    = '0x4325b2f3' // setPancakeParams(address,address,address)
const SEL_BALANCE_OF     = '0x70a08231' // balanceOf(address) -> (uint256)
const SEL_EST_TAX_USDT   = '0x50aaf7df' // estimateTaxValueUsdt18View() -> (uint256)
const SEL_SWAP_TAX       = '0xf2a80a88' // swapAccumulatedTax()

// BSC 主网官方地址（预填默认值，可改）
const BSC_PANCAKE_ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const BSC_USDT              = '0x55d398326f99059fF775485246999027B3197955'
const BSC_WBNB              = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
// CFO 双池：每次重新部署后 LP 地址都会变，留空由用户粘贴新池地址
const DEFAULT_CFO_USDT_LP   = ''
const DEFAULT_CFO_WBNB_LP   = ''

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// ================ 类型 ================
export interface TaxConfigPanelProps {
  readonly deployed: DeployedMap
  readonly walletAddr: string
  readonly notify: (kind: ToastKind, msg: string) => void
  readonly env: EnvCfg
}

// ================ 组件 ================
export default function TaxConfigPanel({ deployed, walletAddr, notify, env }: TaxConfigPanelProps) {
  const cfoAddr = deployed.biz_token ?? ''
  const hasAddr = !!cfoAddr

  // ---- 输入（双池 LP，均需登记收税）----
  const [lpUsdtAddr, setLpUsdtAddr] = useState(DEFAULT_CFO_USDT_LP)
  const [lpWbnbAddr, setLpWbnbAddr] = useState(DEFAULT_CFO_WBNB_LP)
  const [routerAddr, setRouterAddr] = useState(BSC_PANCAKE_ROUTER_V2)
  const [usdtAddr, setUsdtAddr] = useState(BSC_USDT)
  const [wbnbAddr, setWbnbAddr] = useState(BSC_WBNB)

  // ---- 链上只读状态 ----
  const [onChainOwner, setOnChainOwner] = useState('')
  const [taxEnabled, setTaxEnabled] = useState<boolean | null>(null)
  const [taxRateBp, setTaxRateBp] = useState<string>('')
  const [lpUsdtRegistered, setLpUsdtRegistered] = useState<boolean | null>(null)
  const [lpWbnbRegistered, setLpWbnbRegistered] = useState<boolean | null>(null)
  const [onChainRouter, setOnChainRouter] = useState('')
  const [onChainUsdt, setOnChainUsdt] = useState('')
  const [onChainWbnb, setOnChainWbnb] = useState('')
  const [loadingOnChain, setLoadingOnChain] = useState(false)

  // ---- 手动售税只读状态 ----
  const [taxCfoWei, setTaxCfoWei] = useState('0')
  const [estUsdtWei, setEstUsdtWei] = useState('0')
  // null=查询中；false=旧版合约（运行时代码不含 swapAccumulatedTax selector，需重部署代币）
  const [supportsManualSwap, setSupportsManualSwap] = useState<boolean | null>(null)

  // ---- 签名状态 ----
  const [loadingPairUsdt, setLoadingPairUsdt] = useState(false)
  const [loadingPairWbnb, setLoadingPairWbnb] = useState(false)
  const [loadingPairAll, setLoadingPairAll] = useState(false)
  const [loadingParams, setLoadingParams] = useState(false)
  const [loadingSwap, setLoadingSwap] = useState(false)
  const [lastTx, setLastTx] = useState('')

  const lpUsdtValid = useMemo(() => ethers.utils.isAddress(lpUsdtAddr), [lpUsdtAddr])
  const lpWbnbValid = useMemo(() => ethers.utils.isAddress(lpWbnbAddr), [lpWbnbAddr])
  const paramsValid = useMemo(
    () => ethers.utils.isAddress(routerAddr) && ethers.utils.isAddress(usdtAddr) && ethers.utils.isAddress(wbnbAddr)
      && routerAddr !== ZERO_ADDR && usdtAddr !== ZERO_ADDR && wbnbAddr !== ZERO_ADDR,
    [routerAddr, usdtAddr, wbnbAddr]
  )

  const isOwner =
    !!walletAddr && !!onChainOwner && walletAddr.toLowerCase() === onChainOwner.toLowerCase()

  const getProvider = useCallback(() => {
    const injected = (
      window as unknown as { ethereum?: ethers.providers.ExternalProvider }
    ).ethereum
    return walletAddr && injected
      ? new ethers.providers.Web3Provider(injected)
      : new ethers.providers.JsonRpcProvider(env.RPC_URL)
  }, [walletAddr, env.RPC_URL])

  // ---- 读链上状态 ----
  const refreshChainState = useCallback(async () => {
    if (!hasAddr) return
    setLoadingOnChain(true)
    try {
      const provider = getProvider()
      const { defaultAbiCoder } = ethers.utils
      const calls = [
        provider.call({ to: cfoAddr, data: SEL_OWNER }),
        provider.call({ to: cfoAddr, data: SEL_TAX_ENABLED }),
        provider.call({ to: cfoAddr, data: SEL_TAX_RATE }),
        provider.call({ to: cfoAddr, data: SEL_PANCAKE_ROUTER }),
        provider.call({ to: cfoAddr, data: SEL_USDT }),
        provider.call({ to: cfoAddr, data: SEL_WBNB }),
        // 6: 合约累积的税 CFO 余额 balanceOf(本合约)
        provider.call({
          to: cfoAddr,
          data: SEL_BALANCE_OF + defaultAbiCoder.encode(['address'], [cfoAddr]).slice(2),
        }),
        // 7: 税余额折算 USDT 估值 estimateTaxValueUsdt18View()
        provider.call({ to: cfoAddr, data: SEL_EST_TAX_USDT }),
      ]
      if (lpUsdtValid) {
        calls.push(
          provider.call({
            to: cfoAddr,
            data: SEL_IS_PAIR + defaultAbiCoder.encode(['address'], [lpUsdtAddr]).slice(2),
          })
        )
      }
      if (lpWbnbValid) {
        calls.push(
          provider.call({
            to: cfoAddr,
            data: SEL_IS_PAIR + defaultAbiCoder.encode(['address'], [lpWbnbAddr]).slice(2),
          })
        )
      }
      const results = await Promise.allSettled(calls)
      const raw = (i: number): string =>
        results[i].status === 'fulfilled' && results[i].value !== '0x'
          ? (results[i] as PromiseFulfilledResult<string>).value
          : '0x'
      const decodeAddr = (i: number) =>
        raw(i) === '0x' ? '' : (defaultAbiCoder.decode(['address'], raw(i))[0] as string)
      setOnChainOwner(decodeAddr(0))
      setTaxEnabled(raw(1) === '0x' ? null : defaultAbiCoder.decode(['bool'], raw(1))[0])
      setTaxRateBp(raw(2) === '0x' ? '' : defaultAbiCoder.decode(['uint256'], raw(2))[0].toString())
      setOnChainRouter(decodeAddr(3))
      setOnChainUsdt(decodeAddr(4))
      setOnChainWbnb(decodeAddr(5))
      setTaxCfoWei(raw(6) === '0x' ? '0' : defaultAbiCoder.decode(['uint256'], raw(6))[0].toString())
      setEstUsdtWei(raw(7) === '0x' ? '0' : defaultAbiCoder.decode(['uint256'], raw(7))[0].toString())
      // isPair 查询位置：基础 8 条之后，USDT 池（若合法）在前、WBNB 池在后
      let nextIdx = 8
      if (lpUsdtValid) {
        const r = raw(nextIdx)
        setLpUsdtRegistered(r === '0x' ? null : defaultAbiCoder.decode(['bool'], r)[0])
        nextIdx += 1
      } else {
        setLpUsdtRegistered(null)
      }
      if (lpWbnbValid) {
        const r = raw(nextIdx)
        setLpWbnbRegistered(r === '0x' ? null : defaultAbiCoder.decode(['bool'], r)[0])
      } else {
        setLpWbnbRegistered(null)
      }
      // 运行时代码特性检测：是否包含 swapAccumulatedTax() selector（旧版代币无此函数）
      try {
        const code = await provider.getCode(cfoAddr)
        setSupportsManualSwap(typeof code === 'string' && code.toLowerCase().includes(SEL_SWAP_TAX.slice(2)))
      } catch {
        setSupportsManualSwap(null)
      }
    } catch (e) {
      notify('error', `查询链上状态失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingOnChain(false)
    }
  }, [hasAddr, cfoAddr, getProvider, lpUsdtValid, lpUsdtAddr, lpWbnbValid, lpWbnbAddr, notify])

  useEffect(() => {
    void refreshChainState()
  }, [refreshChainState])

  // ---- 发交易通用 ----
  const sendTx = useCallback(
    async (data: string, gasLimit: number, okMsg: string) => {
      if (!walletAddr) {
        notify('error', '⚠️ 请先连接钱包')
        return false
      }
      if (!isOwner) {
        notify('error', `❌ 当前钱包不是 CFO 合约 owner。owner=${onChainOwner || '查询中…'}`)
        return false
      }
      const provider = new ethers.providers.Web3Provider(
        (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
      )
      const signer = provider.getSigner()
      const tx = await signer.sendTransaction({ to: cfoAddr, data, gasLimit })
      setLastTx(tx.hash)
      notify('info', `📤 已提交签名：${tx.hash.slice(0, 18)}...`)
      const receipt = await tx.wait(2)
      if (receipt.status === 1) {
        notify('success', `✅ ${okMsg} tx=${tx.hash.slice(0, 18)}...`)
        await refreshChainState()
        return true
      }
      notify('error', `❌ 交易失败：${tx.hash}`)
      return false
    },
    [walletAddr, isOwner, onChainOwner, cfoAddr, notify, refreshChainState]
  )

  // ---- ② 登记/移除 LP（通用）----
  const setPair = useCallback(
    async (addr: string, register: boolean, label: string): Promise<boolean> => {
      const { defaultAbiCoder } = ethers.utils
      const data =
        SEL_SET_IS_PAIR +
        defaultAbiCoder.encode(['address', 'bool'], [addr, register]).slice(2)
      return sendTx(
        data,
        200_000,
        register ? `${label} LP 登记成功，该交易对买卖已开始扣税！` : `${label} LP 已移除，该交易对不再扣税`
      )
    },
    [sendTx]
  )

  const handleSetPair = useCallback(
    async (which: 'usdt' | 'wbnb', register: boolean) => {
      if (!hasAddr) {
        notify('error', '⚠️ 尚未部署 CFO 代币合约')
        return
      }
      const isUsdt = which === 'usdt'
      const addr = isUsdt ? lpUsdtAddr : lpWbnbAddr
      const valid = isUsdt ? lpUsdtValid : lpWbnbValid
      if (!valid) {
        notify('error', '⚠️ LP 地址格式不正确')
        return
      }
      const setLoading = isUsdt ? setLoadingPairUsdt : setLoadingPairWbnb
      setLoading(true)
      try {
        await setPair(addr, register, isUsdt ? 'CFO/USDT' : 'CFO/WBNB')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('4001')) notify('warning', '用户取消签名')
        else notify('error', `签名失败：${msg.slice(0, 150)}`)
      } finally {
        setLoading(false)
      }
    },
    [hasAddr, lpUsdtAddr, lpWbnbAddr, lpUsdtValid, lpWbnbValid, notify, setPair]
  )

  // ---- 一键登记两个 LP（依次两笔交易，任一失败则中止并提示）----
  const handleRegisterBoth = useCallback(async () => {
    if (!hasAddr) {
      notify('error', '⚠️ 尚未部署 CFO 代币合约')
      return
    }
    if (!lpUsdtValid || !lpWbnbValid) {
      notify('error', '⚠️ 请先把两个 LP 地址都填写正确')
      return
    }
    setLoadingPairAll(true)
    try {
      const steps: Array<{ addr: string; label: string; done: boolean | null }> = [
        { addr: lpUsdtAddr, label: 'CFO/USDT', done: lpUsdtRegistered },
        { addr: lpWbnbAddr, label: 'CFO/WBNB', done: lpWbnbRegistered },
      ]
      for (const s of steps) {
        if (s.done === true) continue
        notify('info', `📝 正在登记 ${s.label} LP…`)
        const ok = await setPair(s.addr, true, s.label)
        if (!ok) {
          notify('error', `❌ ${s.label} LP 登记失败，已中止（另一个池可能尚未登记）`)
          return
        }
      }
      notify('success', '✅ 两个 LP 均已登记，双池买卖全部开始扣税！')
    } finally {
      setLoadingPairAll(false)
    }
  }, [hasAddr, lpUsdtValid, lpWbnbValid, lpUsdtAddr, lpWbnbAddr, lpUsdtRegistered, lpWbnbRegistered, notify, setPair])

  // ---- ② 配置 Pancake 参数 ----
  const handleSetParams = useCallback(async () => {
    if (!hasAddr) {
      notify('error', '⚠️ 尚未部署 CFO 代币合约')
      return
    }
    if (!paramsValid) {
      notify('error', '⚠️ Router / USDT / WBNB 地址存在零地址或格式错误')
      return
    }
    setLoadingParams(true)
    try {
      const { defaultAbiCoder } = ethers.utils
      const data =
        SEL_SET_PANCAKE +
        defaultAbiCoder
          .encode(['address', 'address', 'address'], [routerAddr, usdtAddr, wbnbAddr])
          .slice(2)
      await sendTx(data, 200_000, '税币售卖参数配置成功！')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('4001')) notify('warning', '用户取消签名')
      else notify('error', `签名失败：${msg.slice(0, 150)}`)
    } finally {
      setLoadingParams(false)
    }
  }, [hasAddr, paramsValid, routerAddr, usdtAddr, wbnbAddr, notify, sendTx])

  // ---- ③ 手动售税分发（任何人可调用，不要求 owner，调用钱包付 gas）----
  const handleSwapTax = useCallback(async () => {
    if (!hasAddr) {
      notify('error', '⚠️ 尚未部署 CFO 代币合约')
      return
    }
    if (!walletAddr) {
      notify('error', '⚠️ 请先连接钱包（用于支付 gas）')
      return
    }
    if (supportsManualSwap === false) {
      notify('error', '❌ 当前代币为旧版合约，无 swapAccumulatedTax() 函数，请用修复后的代码重部署代币')
      return
    }
    setLoadingSwap(true)
    try {
      const provider = new ethers.providers.Web3Provider(
        (window as unknown as { ethereum: ethers.providers.ExternalProvider }).ethereum
      )
      const signer = provider.getSigner()
      const tx = await signer.sendTransaction({ to: cfoAddr, data: SEL_SWAP_TAX, gasLimit: 600_000 })
      setLastTx(tx.hash)
      notify('info', `📤 已提交手动售税：${tx.hash.slice(0, 18)}...`)
      const receipt = await tx.wait(2)
      if (receipt.status === 1) {
        notify('success', `✅ 售税分发成功，USDT 已按团队钱包比例打入 tx=${tx.hash.slice(0, 18)}...`)
        await refreshChainState()
      } else {
        notify('error', `❌ 售税交易失败：${tx.hash}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('4001')) notify('warning', '用户取消签名')
      else notify('error', `售税失败：${msg.slice(0, 200)}`)
    } finally {
      setLoadingSwap(false)
    }
  }, [hasAddr, walletAddr, supportsManualSwap, cfoAddr, notify, refreshChainState])

  const pancakeConfigured =
    !!onChainRouter && onChainRouter !== ZERO_ADDR &&
    !!onChainUsdt && onChainUsdt !== ZERO_ADDR &&
    !!onChainWbnb && onChainWbnb !== ZERO_ADDR

  const globalDisabled = loadingOnChain || !walletAddr

  // ---- 手动售税派生值 ----
  const taxCfoText = ethers.utils.formatUnits(taxCfoWei || '0', 18)
  const estUsdtText = ethers.utils.formatUnits(estUsdtWei || '0', 18)
  const hasTaxBalance = ethers.BigNumber.from(taxCfoWei || '0').gt(0)

  return (
    <div className="space-y-4">
      {/* 说明 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>💰 交易税配置 — LP 登记与税币分发</h3>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          CFO 代币内置 <strong>1%</strong> 交易税（合约内税率，由代币合约自身收取，与 Router 手续费无关）。
          配置链路：<strong>① 登记 LP</strong>（只有经过已登记 LP pair 的买卖才扣税）→
          <strong>② 配置售卖参数</strong>（PancakeSwap Router / USDT / WBNB）与团队钱包。
          配置完成后<strong>交易即分发</strong>：每笔买卖扣下的税 CFO 在<strong>同一笔交易内</strong>自动卖成 USDT，
          按团队钱包 40/30/30 即时到账——不累积、无阈值、无需任何人手动操作或额外出 gas。
          自动售卖走<strong>双池自适应路由</strong>（在 CFO/USDT 池交易时税从 CFO/WBNB 池离场，反之亦然，
          避开同池交易锁冲突），因此需同时存在 CFO/USDT 与 CFO/WBNB 两个流动性池；
          极端行情下若某笔自动售卖被跳过，税会零星留在合约，任何人可在 <strong>④</strong> 一键补卖。
        </p>
      </div>

      {/* 合约与权限 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>① 合约与权限</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-28 shrink-0">CFO 代币：</span>
            {cfoAddr ? (
              <CopyableAddress value={cfoAddr} explorerBaseUrl="https://bscscan.com" explorerType="address" />
            ) : (
              <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">⚠️ 未部署</code>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-28 shrink-0">合约 owner：</span>
            {onChainOwner ? (
              <CopyableAddress value={onChainOwner} explorerBaseUrl="https://bscscan.com" explorerType="address" />
            ) : (
              <span className="text-xs text-slate-400 italic">查询中…</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-28 shrink-0">你的钱包：</span>
            {walletAddr ? (
              <CopyableAddress value={walletAddr} mode="short" />
            ) : (
              <code className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded">⚠️ 未连接</code>
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
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <span className="text-slate-500 w-28 shrink-0">当前税率：</span>
            {taxEnabled === null ? (
              <span className="text-xs text-slate-400 italic">查询中…</span>
            ) : taxEnabled ? (
              <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
                ✅ 已开启，税率 {taxRateBp ? (Number(taxRateBp) / 100).toString() : '-'}%（{taxRateBp} bp）
              </span>
            ) : (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                ⏸️ 税收总开关已关闭（taxEnabled=false）
              </span>
            )}
          </div>
        </div>
      </div>

      {/* LP 登记（双池） */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>② 登记 LP 交易对（开启扣税，两个池都要登记）</h3>
        <div className="mt-3 space-y-4">
          <LpPairRow
            label="CFO/USDT LP Pair"
            addr={lpUsdtAddr}
            valid={lpUsdtValid}
            registered={lpUsdtRegistered}
            loading={loadingPairUsdt}
            disabled={globalDisabled || !hasAddr || !isOwner}
            btnPrimaryClass={styles.btnPrimary}
            btnSecondaryClass={styles.btnSecondary}
            onAddrChange={setLpUsdtAddr}
            onRegister={() => void handleSetPair('usdt', true)}
            onRemove={() => void handleSetPair('usdt', false)}
          />
          <LpPairRow
            label="CFO/WBNB LP Pair"
            addr={lpWbnbAddr}
            valid={lpWbnbValid}
            registered={lpWbnbRegistered}
            loading={loadingPairWbnb}
            disabled={globalDisabled || !hasAddr || !isOwner}
            btnPrimaryClass={styles.btnPrimary}
            btnSecondaryClass={styles.btnSecondary}
            onAddrChange={setLpWbnbAddr}
            onRegister={() => void handleSetPair('wbnb', true)}
            onRemove={() => void handleSetPair('wbnb', false)}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRegisterBoth()}
            disabled={
              globalDisabled || !hasAddr || !isOwner || loadingPairAll ||
              !lpUsdtValid || !lpWbnbValid ||
              (lpUsdtRegistered === true && lpWbnbRegistered === true)
            }
            className={`${styles.btnPrimary} px-5 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loadingPairAll ? '⏳ 依次签名两笔交易中…' : '🚀 一键登记两个 LP（两笔签名）'}
          </button>
          <span className="text-xs text-slate-500">
            两个地址都填好后点此按钮，钱包会依次弹出两次签名；已登记的池自动跳过
          </span>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          合约会校验该地址是合约且响应 getReserves()（即合法的 Uniswap V2 风格 LP）；
          双池自适应路由要求 <strong>CFO/USDT 与 CFO/WBNB 两个池都登记</strong>，否则未登记池内的买卖不扣税。
          新增其他 CFO 交易对时在上方填入地址单独登记即可。
        </p>
      </div>

      {/* Pancake 售卖参数 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>③ 税币售卖参数（税 CFO → USDT 路由）</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 text-sm">
          <AddrField label="PancakeSwap V2 Router" value={routerAddr} onChange={setRouterAddr} disabled={globalDisabled}
            onChain={onChainRouter} />
          <AddrField label="USDT" value={usdtAddr} onChange={setUsdtAddr} disabled={globalDisabled}
            onChain={onChainUsdt} />
          <AddrField label="WBNB" value={wbnbAddr} onChange={setWbnbAddr} disabled={globalDisabled}
            onChain={onChainWbnb} />
        </div>
        <div className="mt-3 text-xs">
          链上配置状态：
          {pancakeConfigured ? (
            <span className="text-green-700 font-medium"> ✅ 已配置（交易内自动分发与④兜底补卖均走此路由换成 USDT）</span>
          ) : (
            <span className="text-red-600 font-medium"> ❌ 未配置（税 CFO 无法换成 USDT 分发）</span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSetParams()}
            disabled={globalDisabled || !hasAddr || !isOwner || !paramsValid}
            className={`${styles.btnPrimary} px-5 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loadingParams ? '⏳ 签名中…' : '⚙️ 签名配置售卖参数'}
          </button>
          <span className="text-xs text-slate-500">
            selector <code>{SEL_SET_PANCAKE}</code> + ABI(address router, address usdt, address wbnb)
          </span>
        </div>
      </div>

      {/* ④ 兜底手动售税 */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>④ 兜底补卖残留税（正常情况无需操作）</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-40 shrink-0">合约累积税 CFO：</span>
            <span className="font-mono font-semibold text-slate-800">{taxCfoText}</span>
            <span className="text-xs text-slate-500">CFO</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-40 shrink-0">折合 USDT 估值：</span>
            <span className="font-mono font-semibold text-emerald-700">≈ {estUsdtText}</span>
            <span className="text-xs text-slate-500">USDT（按 PancakeSwap 当前报价）</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 w-40 shrink-0">手动售税函数：</span>
            {supportsManualSwap === null ? (
              <span className="text-xs text-slate-400 italic">检测中…</span>
            ) : supportsManualSwap ? (
              <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
                ✅ 当前合约支持 swapAccumulatedTax()
              </span>
            ) : (
              <span className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
                ❌ 旧版合约无此函数，需用修复后代码重部署代币
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSwapTax()}
            disabled={globalDisabled || !hasAddr || loadingSwap || supportsManualSwap === false || !hasTaxBalance}
            className={`${styles.btnPrimary} px-5 py-2.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loadingSwap ? '⏳ 售税交易确认中…' : '🔄 补卖残留税（任何人可点，钱包付 gas）'}
          </button>
          <span className="text-xs text-slate-500">
            selector <code>{SEL_SWAP_TAX}</code>（无参数，无需 owner）
          </span>
        </div>
        <p className="mt-2 text-xs text-slate-500 leading-relaxed">
          正常情况下每笔交易的税已在交易内自动分发完毕，「合约累积税 CFO」应始终为 0。
          仅当极端行情导致某笔自动售卖被跳过时才会有零星残留，任何人可点此按钮在<strong>独立交易</strong>
          中把全部残留税 CFO 经 PancakeSwap 卖成 USDT（10% 滑点保护），按 40/30/30 补分到团队钱包。
          无需 owner 权限，点击钱包支付 gas；税余额为 0 时按钮置灰。
        </p>
      </div>

      {/* 刷新 + tx */}
      <div className={styles.group}>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshChainState()}
            disabled={loadingOnChain || !hasAddr}
            className={`${styles.btnSecondary} px-4 py-2 text-sm disabled:opacity-50`}
          >
            {loadingOnChain ? '⏳ 查询中…' : '🔄 刷新链上状态'}
          </button>
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

// ================ 子组件 ================
// 单个 LP 登记行：地址输入 + 登记状态 + 登记/移除按钮
function LpPairRow({
  label,
  addr,
  valid,
  registered,
  loading,
  disabled,
  btnPrimaryClass,
  btnSecondaryClass,
  onAddrChange,
  onRegister,
  onRemove,
}: {
  label: string
  addr: string
  valid: boolean
  registered: boolean | null
  loading: boolean
  disabled: boolean
  btnPrimaryClass: string
  btnSecondaryClass: string
  onAddrChange: (v: string) => void
  onRegister: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div>
      <label className="block text-sm text-slate-700 mb-1">{label}（PancakeSwap V2 Cake-LP）</label>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={addr}
          onChange={(e) => onAddrChange(e.target.value.trim())}
          disabled={disabled}
          className="w-full md:w-[420px] px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100 font-mono"
          placeholder="0x..."
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onRegister}
          disabled={disabled || !valid || registered === true || loading}
          className={`${btnPrimaryClass} px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {loading ? '⏳ 签名中…' : '📝 登记'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled || !valid || registered === false || registered === null || loading}
          className={`${btnSecondaryClass} px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          移除
        </button>
      </div>
      {addr && !valid && <span className="text-xs text-red-600 ml-1">⚠️ 地址格式不正确</span>}
      <div className="mt-1 text-xs">
        登记状态：
        {registered === null ? (
          <span className="text-slate-400 italic"> 输入合法地址后自动查询…</span>
        ) : registered ? (
          <span className="text-green-700 font-medium"> ✅ 已登记（经过该 LP 的买卖扣 1% 税）</span>
        ) : (
          <span className="text-red-600 font-medium"> ❌ 未登记（经过该 LP 的买卖不扣税）</span>
        )}
      </div>
    </div>
  )
}

function AddrField({
  label,
  value,
  onChange,
  disabled,
  onChain,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
  onChain: string
}): JSX.Element {
  const valid = ethers.utils.isAddress(value) && value !== ZERO_ADDR
  const matched = !!onChain && onChain.toLowerCase() === value.toLowerCase()
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          disabled={disabled}
          className="w-full md:w-[420px] px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100 font-mono"
          spellCheck={false}
        />
        {!valid && <span className="text-xs text-red-600">⚠️ 地址格式错误</span>}
        {valid && onChain && (
          matched ? (
            <span className="text-xs text-green-700">✅ 与链上一致</span>
          ) : (
            <span className="text-xs text-amber-600">⚠️ 与链上现值不同（签名后将更新）</span>
          )
        )}
      </div>
    </div>
  )
}
