// 铸造 CFO 面板：owner 授予配额 / 调用者 mint / 查询 totalSupply 与我的余额
// 严格 TS：0 any；零浮点 BigInt 字符串 wei 换算（与 ConfigPanel mintWeiFromCfoStr 同算法）
// --------------------------------------------------------------------------------
import { useCallback, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import type { DeployedMap, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'

// ================ Props ================
export interface MintPanelProps {
  readonly deployed: DeployedMap
  readonly walletAddr: string
  readonly notify: (kind: ToastKind, msg: string) => void
}

// ================ 常量（模块级 UPPER_SNAKE_CASE） ================
/** BSC 主网 chainId（十进制 56 的 0x 前缀小写形式） */
const BSC_CHAIN_ID_HEX = '0x38'
/** CFO 小数位：18 */
const CFO_DECIMALS = 18
const ONE_CFO_BI = 10n ** BigInt(CFO_DECIMALS)
/** 地址正则：0x + 40 hex chars */
const RE_ADDRESS = /^0x[a-fA-F0-9]{40}$/
/** 安全数字正则：正整数或带小数正数，无符号、无空格、无字母 */
const RE_CFO_NUM_SAFE = /^[0-9]+(\.[0-9]+)?$/

// 4-byte selectors（如果签名变了，这里跟着改；keccak256(signature).slice(0,10)）
// grantMinterQuota(address,uint256) — cast sig 验证：0x5790907c
const SEL_GRANT_MINTER_QUOTA = '0x5790907c'
// mint(address,uint256)
const SEL_MINT = '0x40c10f19'
// totalSupply()
const SEL_TOTAL_SUPPLY = '0x18160ddd'
// balanceOf(address)
const SEL_BALANCE_OF = '0x70a08231'

// ================ 小工具（纯函数） ================
/** 正整数无前导零归一化（BigInt 不会吞零，这里仅用于用户输入健壮性） */
const normIntStr = (s: string): string => {
  if (!s) return '0'
  if (!/^[0-9]+$/.test(s)) return '0'
  let i = 0
  while (i < s.length - 1 && s[i] === '0') i += 1
  return s.slice(i) || '0'
}

/**
 * 「枚 CFO」字符串 → wei 整数字符串（零浮点，避免 IEEE754 误差）
 * 与 ConfigPanel.mintWeiFromCfoStr 算法一致：
 *   "123.45" -> integer=123, frac=45 -> 补零到 18 位 -> result = int * 1e18 + frac18
 *   超过 18 位小数：第 19 位 >= 5 则进位
 */
const cfoStrToWei = (cfoStr: string): string => {
  const raw = (cfoStr || '').trim()
  if (!raw) return '0'
  if (!RE_CFO_NUM_SAFE.test(raw)) return '0'
  const hasDot = raw.includes('.')
  const [intPartRaw, fracPartRaw = ''] = hasDot ? raw.split('.') : [raw, '']
  const intPart = BigInt(normIntStr(intPartRaw || '0'))
  let fracBi = 0n
  if (fracPartRaw) {
    if (fracPartRaw.length <= CFO_DECIMALS) {
      const padded = (fracPartRaw + '0'.repeat(CFO_DECIMALS)).slice(0, CFO_DECIMALS)
      fracBi = BigInt(normIntStr(padded))
    } else {
      const head18 = fracPartRaw.slice(0, CFO_DECIMALS)
      const nineteenth = fracPartRaw[CFO_DECIMALS] ?? '0'
      fracBi = BigInt(normIntStr(head18))
      if (Number(nineteenth) >= 5) fracBi += 1n
    }
  }
  return (intPart * ONE_CFO_BI + fracBi).toString()
}

/**
 * wei（整数字符串）→ 「枚 CFO」人类可读字符串
 * 整数部分直接显示；小数最多 4 位（去尾随零）避免 UI 抖动
 */
const weiToCfoStr = (weiStr: string): string => {
  const wei = normIntStr(weiStr || '0')
  try {
    const weiBi = BigInt(wei)
    const whole = weiBi / ONE_CFO_BI
    const frac = weiBi % ONE_CFO_BI
    if (frac === 0n) return whole.toString()
    const fracPadded = frac.toString().padStart(CFO_DECIMALS, '0')
    let frac4 = fracPadded.slice(0, 4)
    while (frac4.endsWith('0')) frac4 = frac4.slice(0, -1)
    return `${whole.toString()}${frac4 ? '.' + frac4 : ''}`
  } catch {
    return '0'
  }
}

/** 用 Intl.NumberFormat 给数字加千分位（仅「枚」层展示用，精度使用 weiToCfoStr 格式化后的字符串） */
const formatCfoHuman = (cfoStr: string): string => {
  const raw = (cfoStr || '').trim()
  if (!raw) return '0'
  const hasDot = raw.includes('.')
  const [intPart, fracPart = ''] = hasDot ? raw.split('.') : [raw, '']
  try {
    const intFmt = Intl.NumberFormat('en-US').format(Number(normIntStr(intPart || '0')))
    return `${intFmt}${fracPart ? '.' + fracPart : ''}`
  } catch {
    return raw
  }
}

/**
 * ABI 编码：selector + (address, uint256) 的调用 data
 * 使用 ethers v5 defaultAbiCoder，与 useDeployFlow / useBindFlow 保持一致
 */
const encodeAddrUint256Call = (selector: string, addr: string, weiAmount: string): string => {
  const paramsEncoded = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256'],
    [addr, weiAmount]
  )
  // paramsEncoded 是 0x 开头的 128 hex 字符；去掉 0x 拼到 selector 后面
  return selector + paramsEncoded.slice(2)
}

/** ABI 编码：balanceOf(address) 的 data */
const encodeBalanceOfCall = (addr: string): string => {
  const paramsEncoded = ethers.utils.defaultAbiCoder.encode(['address'], [addr])
  return SEL_BALANCE_OF + paramsEncoded.slice(2)
}

/** 解码 eth_call 返回的 0x-prefixed uint256 → 整数字符串 */
const decodeUint256Result = (hex: unknown): string => {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return '0'
  try {
    const bi = BigInt(hex)
    return bi.toString()
  } catch {
    return '0'
  }
}

/** 从错误对象捕获完整字符串（不截断，交给 error toast 常驻显示） */
const errToFullString = (e: unknown): string => {
  if (e instanceof Error) {
    // 含 name + message + 可能的 stack（stack 常包含更完整原因，例如 MetaMask user rejected）
    return `${e.name}: ${e.message}${e.stack ? '\n' + e.stack : ''}`
  }
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

// ================ 组件 ================
function MintPanel({ deployed, walletAddr, notify }: MintPanelProps): JSX.Element {
  const bizToken = deployed.biz_token
  /** 合约地址是否就绪：空则功能全部置灰 */
  const tokenReady = !!bizToken && RE_ADDRESS.test(bizToken)
  /** 是否禁用所有按钮（合约未就绪 = true；各表单未过校验再单独 disabled 自己按钮） */
  const globalDisabled = !tokenReady

  // -------------------- Block A：授予铸造配额 --------------------
  const [grantMinter, setGrantMinter] = useState<string>(walletAddr || '')
  const [grantAmountCfo, setGrantAmountCfo] = useState<string>('')

  const grantMinterInvalid = !!grantMinter && !RE_ADDRESS.test(grantMinter)
  const grantWei = useMemo(() => cfoStrToWei(grantAmountCfo), [grantAmountCfo])
  const grantAmountInvalid = !!grantAmountCfo && !RE_CFO_NUM_SAFE.test(grantAmountCfo.trim())
  const grantGt0 = BigInt(grantWei || '0') > 0n
  const grantBtnDisabled =
    globalDisabled ||
    !walletAddr ||
    grantMinterInvalid ||
    grantAmountInvalid ||
    !grantGt0

  // -------------------- Block B：铸造 CFO 到指定地址 --------------------
  const [mintTo, setMintTo] = useState<string>(walletAddr || '')
  const [mintAmountCfo, setMintAmountCfo] = useState<string>('')

  const mintToInvalid = !!mintTo && !RE_ADDRESS.test(mintTo)
  const mintWei = useMemo(() => cfoStrToWei(mintAmountCfo), [mintAmountCfo])
  const mintAmountInvalid = !!mintAmountCfo && !RE_CFO_NUM_SAFE.test(mintAmountCfo.trim())
  const mintGt0 = BigInt(mintWei || '0') > 0n
  const mintBtnDisabled =
    globalDisabled ||
    !walletAddr ||
    mintToInvalid ||
    mintAmountInvalid ||
    !mintGt0

  // -------------------- Block C：辅助只读（totalSupply / balanceOf） --------------------
  const [totalSupplyCfo, setTotalSupplyCfo] = useState<string>('')
  const [myBalanceCfo, setMyBalanceCfo] = useState<string>('')
  const [loadingOnChain, setLoadingOnChain] = useState<boolean>(false)

  // ================ 公共：chainId 断言（取实时 eth_chainId） ================
  const assertBscChain = useCallback(async (): Promise<boolean> => {
    if (!window.ethereum?.request) {
      notify('error', '未检测到钱包 Provider（window.ethereum 不存在）。请先安装/连接 MetaMask 或 OKX Wallet。')
      return false
    }
    try {
      const chainId = await window.ethereum.request({ method: 'eth_chainId' })
      if (typeof chainId !== 'string' || chainId.toLowerCase() !== BSC_CHAIN_ID_HEX) {
        notify(
          'error',
          `当前链 chainId=${String(chainId)} 不是 BSC 主网（预期 0x38）。请先在钱包切换到 BSC Mainnet 后重试。`
        )
        return false
      }
      return true
    } catch (err) {
      notify('error', `读取 eth_chainId 失败：${errToFullString(err)}`)
      return false
    }
  }, [notify])

  // ================ 公共：用 window.ethereum.request 发送签名交易（不等 receipt） ================
  const sendSignedTx = useCallback(
    async (to: string, data: string): Promise<void> => {
      if (!window.ethereum?.request) {
        notify('error', '未检测到钱包 Provider（window.ethereum 不存在）。请先安装/连接 MetaMask 或 OKX Wallet。')
        return
      }
      if (!walletAddr) {
        notify('error', '钱包未连接：请先在页面顶部连接钱包（MetaMask / OKX Wallet）。')
        return
      }
      if (!RE_ADDRESS.test(to)) {
        notify('error', `目标合约地址非法：${to}`)
        return
      }
      const chainOk = await assertBscChain()
      if (!chainOk) return
      try {
        const txReq = {
          to,
          from: walletAddr,
          data,
          chainId: BSC_CHAIN_ID_HEX,
        } as const
        const result = await window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [txReq],
        })
        const txHash = typeof result === 'string' ? result : String(result ?? '')
        notify('info', `已发送，请在链上等待确认…\nTxHash: ${txHash}\n可到 https://bscscan.com/tx/${txHash} 查看进展。`)
      } catch (err) {
        notify('error', `发送交易失败：${errToFullString(err)}`)
      }
    },
    [assertBscChain, notify, walletAddr]
  )

  // ================ Block A 事件：签名授予配额 ================
  const handleClickGrant = useCallback(async (): Promise<void> => {
    if (grantBtnDisabled) return
    // 再兜底校验一遍（避免 disabled 被绕过）
    if (!RE_ADDRESS.test(grantMinter)) {
      notify('error', `被授予地址非法：${grantMinter}`)
      return
    }
    if (!grantGt0) {
      notify('error', '配额数量必须大于 0 枚 CFO。')
      return
    }
    const data = encodeAddrUint256Call(SEL_GRANT_MINTER_QUOTA, grantMinter, grantWei)
    await sendSignedTx(bizToken, data)
  }, [grantBtnDisabled, grantMinter, grantGt0, grantWei, bizToken, sendSignedTx, notify])

  // ================ Block B 事件：签名铸造 ================
  const handleClickMint = useCallback(async (): Promise<void> => {
    if (mintBtnDisabled) return
    if (!RE_ADDRESS.test(mintTo)) {
      notify('error', `收币地址非法：${mintTo}`)
      return
    }
    if (!mintGt0) {
      notify('error', '铸造数量必须大于 0 枚 CFO。')
      return
    }
    const data = encodeAddrUint256Call(SEL_MINT, mintTo, mintWei)
    await sendSignedTx(bizToken, data)
  }, [mintBtnDisabled, mintTo, mintGt0, mintWei, bizToken, sendSignedTx, notify])

  // ================ Block C 事件：eth_call 查询 totalSupply + balanceOf(walletAddr) ================
  const handleRefreshOnChain = useCallback(async (): Promise<void> => {
    if (globalDisabled) return
    if (!window.ethereum?.request) {
      notify('error', '未检测到钱包 Provider（window.ethereum 不存在）。请先安装/连接 MetaMask 或 OKX Wallet。')
      return
    }
    const chainOk = await assertBscChain()
    if (!chainOk) return
    setLoadingOnChain(true)
    try {
      const [supplyHex, balanceHex] = await Promise.all([
        window.ethereum.request({
          method: 'eth_call',
          params: [{ to: bizToken, data: SEL_TOTAL_SUPPLY }, 'latest'],
        }),
        walletAddr && RE_ADDRESS.test(walletAddr)
          ? window.ethereum.request({
              method: 'eth_call',
              params: [{ to: bizToken, data: encodeBalanceOfCall(walletAddr) }, 'latest'],
            })
          : Promise.resolve('0x0'),
      ] as const)
      const supplyWei = decodeUint256Result(supplyHex)
      const balanceWei = decodeUint256Result(balanceHex)
      setTotalSupplyCfo(weiToCfoStr(supplyWei))
      setMyBalanceCfo(weiToCfoStr(balanceWei))
      notify(
        'success',
        `刷新完成：总供应量 ${formatCfoHuman(weiToCfoStr(supplyWei))} 枚 CFO；我的余额 ${formatCfoHuman(weiToCfoStr(balanceWei))} 枚 CFO。`
      )
    } catch (err) {
      notify('error', `查询链上数据失败：${errToFullString(err)}`)
    } finally {
      setLoadingOnChain(false)
    }
  }, [assertBscChain, bizToken, globalDisabled, notify, walletAddr])

  // -------------------- 工具类名（错误红框，与 ConfigPanel 一致） --------------------
  const invalidCls = (invalid: boolean): string =>
    invalid
      ? ' border-2 border-red-400 bg-red-50 focus:outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200'
      : ''

  // ================ 渲染 ================
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>💎 铸造 CFO 代币（CfoToken）</h2>
        <p className="text-xs text-slate-500">
          仅在完成「一键部署 9 合约」后可用。所有交易由你钱包签名发送（<code>eth_sendTransaction</code>），页面不持有、不传递私钥。
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <label className={styles.fieldLabel}>当前 CfoToken 合约地址</label>
          <div className={styles.textInput + (!tokenReady ? ' bg-slate-100 text-slate-400' : '')}>
            {tokenReady ? (
              <code className="break-all">{bizToken}</code>
            ) : (
              <span className="text-red-600 font-medium">请先完成 CfoToken 部署（Biz Token = biz_token），完成后再回到本页。</span>
            )}
          </div>
        </div>
      </header>

      {/* ===================== Block A ===================== */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>A. owner 授予铸造配额（grantMinterQuota）</h3>
        <p className="text-xs text-slate-500 mb-3 pl-2.5">
          必须以 Token owner 身份调用（否则链上 revert）。被授予地址后续可使用 Block B 的「签名铸造」发起 mint（数量不超过配额）。
        </p>
        <div className={styles.gridTwoCols}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>被授予地址（minter）</span>
            <input
              type="text"
              className={styles.textInput + invalidCls(grantMinterInvalid)}
              placeholder="0x…（默认填你当前钱包地址，可改为其它地址）"
              value={grantMinter}
              onChange={(e) => setGrantMinter(e.target.value)}
              disabled={globalDisabled}
              spellCheck={false}
              autoComplete="off"
            />
            {grantMinterInvalid && (
              <span className="text-xs text-red-600 pl-1 font-medium">地址非法：需为 0x + 40 位 hex</span>
            )}
            {!grantMinterInvalid && globalDisabled && (
              <span className="text-xs text-slate-400 pl-1">需先完成 CfoToken 部署</span>
            )}
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>配额数量（枚 CFO，支持小数，例 10000 = 1 万枚）</span>
            <input
              type="text"
              inputMode="decimal"
              className={styles.textInput + invalidCls(grantAmountInvalid)}
              placeholder="例如：10000 或 123.45"
              value={grantAmountCfo}
              onChange={(e) => setGrantAmountCfo(e.target.value)}
              disabled={globalDisabled}
              spellCheck={false}
              autoComplete="off"
            />
            {grantAmountCfo && !grantAmountInvalid && (
              <span className="text-xs text-slate-500 pl-1">
                换算为 wei：{grantWei}（1 枚 = 10^18 wei）
              </span>
            )}
            {grantAmountInvalid && (
              <span className="text-xs text-red-600 pl-1 font-medium">数量非法：必须是正数字，支持小数（无字母、无空格）</span>
            )}
            {!grantAmountInvalid && grantAmountCfo && !grantGt0 && (
              <span className="text-xs text-red-600 pl-1 font-medium">数量必须大于 0</span>
            )}
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleClickGrant()}
            disabled={grantBtnDisabled}
            className={`${styles.btnPrimary} px-5 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            ✍️ 签名授予配额
          </button>
          <span className="text-xs text-slate-500">
            编码方式：selector {SEL_GRANT_MINTER_QUOTA} + ABI(address, uint256)
          </span>
        </div>
      </div>

      {/* ===================== Block B ===================== */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>B. 调用者铸造 CFO 到指定地址（mint(to, amount)）</h3>
        <p className="text-xs text-slate-500 mb-3 pl-2.5">
          调用者（from = 你钱包地址）必须在 Block A（或 owner 通过其它方式）获得过配额，且本次铸造量不得超过剩余配额。
        </p>
        <div className={styles.gridTwoCols}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>收币地址（to）</span>
            <input
              type="text"
              className={styles.textInput + invalidCls(mintToInvalid)}
              placeholder="0x…（默认填你当前钱包地址，可改为其它地址）"
              value={mintTo}
              onChange={(e) => setMintTo(e.target.value)}
              disabled={globalDisabled}
              spellCheck={false}
              autoComplete="off"
            />
            {mintToInvalid && (
              <span className="text-xs text-red-600 pl-1 font-medium">地址非法：需为 0x + 40 位 hex</span>
            )}
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>铸造数量（枚 CFO，支持小数）</span>
            <input
              type="text"
              inputMode="decimal"
              className={styles.textInput + invalidCls(mintAmountInvalid)}
              placeholder="例如：5000 或 100.1234"
              value={mintAmountCfo}
              onChange={(e) => setMintAmountCfo(e.target.value)}
              disabled={globalDisabled}
              spellCheck={false}
              autoComplete="off"
            />
            {mintAmountCfo && !mintAmountInvalid && (
              <span className="text-xs text-slate-500 pl-1">
                换算为 wei：{mintWei}（1 枚 = 10^18 wei）
              </span>
            )}
            {mintAmountInvalid && (
              <span className="text-xs text-red-600 pl-1 font-medium">数量非法：必须是正数字，支持小数（无字母、无空格）</span>
            )}
            {!mintAmountInvalid && mintAmountCfo && !mintGt0 && (
              <span className="text-xs text-red-600 pl-1 font-medium">数量必须大于 0</span>
            )}
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleClickMint()}
            disabled={mintBtnDisabled}
            className={`${styles.btnPrimary} px-5 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            💰 签名铸造
          </button>
          <span className="text-xs text-slate-500">
            编码方式：selector {SEL_MINT} + ABI(address, uint256)
          </span>
        </div>
      </div>

      {/* ===================== Block C ===================== */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>C. 辅助只读：链上总供应量 / 我的余额</h3>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRefreshOnChain()}
            disabled={globalDisabled || loadingOnChain}
            className={`${styles.btnSecondary} px-5 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loadingOnChain ? '⏳ 查询中…' : '🔄 刷新链上总供应量 / 我的余额'}
          </button>
          <span className="text-xs text-slate-500">
            通过 <code>eth_call</code> 读 totalSupply() 与 balanceOf(walletAddr)，不消耗 gas。
          </span>
        </div>

        {(totalSupplyCfo || myBalanceCfo) && (
          <div className="mt-4 grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <div className={`${styles.phaseCard} ${styles.phaseB}`}>
              <div className={styles.phaseTitle}>链上总供应量（totalSupply）</div>
              <div className="font-mono text-lg font-bold text-slate-900 break-all">
                {formatCfoHuman(totalSupplyCfo || '0')}
                <span className="ml-2 text-sm font-medium text-slate-500">枚 CFO</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono break-all">
                wei = {(BigInt(totalSupplyCfo ? cfoStrToWei(totalSupplyCfo) : '0')).toString()}
              </div>
            </div>

            <div className={`${styles.phaseCard} ${styles.phaseC}`}>
              <div className={styles.phaseTitle}>
                我的余额（balanceOf({walletAddr ? walletAddr.slice(0, 10) + '…' + walletAddr.slice(-8) : '未连接'})）
              </div>
              <div className="font-mono text-lg font-bold text-slate-900 break-all">
                {formatCfoHuman(myBalanceCfo || '0')}
                <span className="ml-2 text-sm font-medium text-slate-500">枚 CFO</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono break-all">
                wei = {(BigInt(myBalanceCfo ? cfoStrToWei(myBalanceCfo) : '0')).toString()}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default MintPanel
