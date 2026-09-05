// 【按新架构重写】9 合约串行部署编排 Hook（钱包签名 eth_sendTransaction，服务端仅 forge verify）
// 流程：
//   0) useWallet() 检查连接 + chainId=56 → 切链；调用者在 runAll 前也应做预检
//   1) GET /api/build/contracts 拉取 9 合约编译信息（含 bytecode / abi / constructorInputs）
//   2) Phase A (5 库)：循环直接发创建交易 data = bytecode，等 receipt 拿 contractAddress
//   3) Phase B (3 合约)：先用 ethers.defaultAbiCoder.encode 按 constructorInputs + meta.getConstructorArgsAsValues
//        编码得 extraData → data = bytecode + extraData.slice(2)
//   4) Phase C (CfoRouter)：先 POST /api/build/router-bytecode 传入 5 库地址，拿到链接后 bytecode；
//        再和 Phase B 一样 encode 构造参数 + 发送
//   5) 每部署成功一个 → 立刻 POST /api/forge/verify 提交后台异步验证，verifyTaskId 存入 state。
//   6) 支持单条重跑。
// -----------------------------------------------------------------------------------------------
import { ethers } from 'ethers'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BuildContractInfo,
  DeployedMap,
  DeployEnvConfig as EnvCfg,
  DeployStepState,
  RouterLibraries,
  ToastKind,
  VerifyRequestBody,
} from '../types/foundry'
import {
  ALIAS_TO_CONTRACT_KEY,
  ALL_CONTRACTS,
  CONTRACT_INDEX,
  LIBRARY_CONTRACTS,
} from '../data/deployMeta'
import { useDeployApi } from './useDeployApi'
import { useWallet } from '@/hooks/useWallet'

/** 9 合约的运行时状态表（对外导出只读；内部使用可变版本） */
export type DeployStateMap = Record<keyof DeployedMap, DeployStepState>

const CHAIN_ID_BSC = 56

const EMPTY_STEP: DeployStepState = {
  status: 'idle',
  address: '',
  txHash: '',
  output: '',
  exitCode: null,
  elapsedMs: 0,
  startedAt: null,
  endedAt: null,
  verifyTaskId: undefined,
}

function buildInitialState(): DeployStateMap {
  const obj = {} as DeployStateMap
  for (const c of ALL_CONTRACTS) {
    obj[c.id] = { ...EMPTY_STEP }
  }
  return obj
}

// -------- 工具：按 constructorInputs.length 把可能嵌套的 values 展开为扁平 --------
// 例：inputs.len = 7, values = [owner, [w1,w2,w3], [b1,b2,b3]] → flat = [owner,w1,w2,w3,b1,b2,b3]
//      inputs.len = 3, values = [owner, [w1,w2,w3], [b1,b2,b3]] → flat = values (原样)
function flattenToInputCount(values: readonly unknown[], inputsLen: number): readonly unknown[] {
  if (values.length === inputsLen) return values
  // 尝试扁平化（只有 values 长度小于 inputsLen 时，且第一个/第二个/第三个元素是数组时）
  const flat: unknown[] = []
  for (const v of values) {
    if (Array.isArray(v)) flat.push(...v)
    else flat.push(v)
  }
  if (flat.length === inputsLen) return flat
  // 还是不匹配就返回原值（让 encode 自身抛错提示更清晰）
  return values
}

export function useDeployFlow(args: {
  /** 环境配置（实时取） */
  env: EnvCfg
  /** 推送 toast */
  notify: (kind: ToastKind, message: string) => void
  /** 每一步成功后持久化落盘 */
  persist: (snapshot: DeployStateMap, deployed: DeployedMap) => Promise<void>
}) {
  const { env, notify, persist } = args

  // ---- 钱包 / API ----
  const { account, chainId, signer, switchChain, isConnected, provider } = useWallet()
  const { getBuildContracts, getRouterBytecode, submitVerify, getVerifyStatus, retryAllVerify } =
    useDeployApi()

  const [buildInfos, setBuildInfos] = useState<BuildContractInfo[] | null>(null)
  const [buildLoading, setBuildLoading] = useState(false)

  const [states, setStates] = useState<DeployStateMap>(() => buildInitialState())
  const [running, setRunning] = useState(false)
  const [progressIdx, setProgressIdx] = useState<number>(0)
  const [progressText, setProgressText] = useState<string>('')
  const [verifyEnabled, setVerifyEnabled] = useState(true)
  const [stopOnError, setStopOnError] = useState(true)
  /** 「重新验证全部合约」请求进行中（按钮 loading + 防重复） */
  const [verifyRetrying, setVerifyRetrying] = useState(false)

  const lockRef = useRef(false)
  /** 组件是否仍挂载：避免异步回调触发 setState on unmounted（N-1 崩溃根因之一） */
  const mountedRef = useRef(true)
  /** states 的同步快照 ref：retryOne 等回调需要同步读最新 states，不能靠 setState updater（异步调度） */
  const statesRef = useRef<DeployStateMap>(states)
  useEffect(() => {
    statesRef.current = states
  }, [states])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** 安全 setState（仅挂载时更新） */
  const safeSetStates = useCallback((updater: React.SetStateAction<DeployStateMap>) => {
    if (!mountedRef.current) return
    setStates(updater)
  }, [])
  const safeSetRunning = useCallback((v: boolean) => {
    if (!mountedRef.current) return
    setRunning(v)
  }, [])
  const safeSetProgress = useCallback((idx: number, text?: string) => {
    if (!mountedRef.current) return
    setProgressIdx(idx)
    if (text !== undefined) setProgressText(text)
  }, [])

  // ---- F-2 切链后状态丢失：监听 chainId，运行中切链→强制暂停 + toast ----
  const lastChainIdRef = useRef<number | null>(chainId ?? null)
  useEffect(() => {
    const prev = lastChainIdRef.current
    const curr = chainId ?? null
    lastChainIdRef.current = curr
    // 只在「从有效链切出」时告警（首次挂载不触发）
    if (prev !== null && curr !== null && prev !== curr) {
      notify('warning', `检测到链切换：${prev} → ${curr ?? '—'}`)
    }
    if (curr !== CHAIN_ID_BSC) {
      if (running) {
        // 强制暂停：后续交易将因 chainId 断言失败而停止
        safeSetRunning(false)
        lockRef.current = false
        notify(
          'error',
          `⚠️ 已检测到当前链为 ${curr ?? '未知'}（非 BSC 主网 56），部署流程已强制暂停。请切回 BSC 主网 (chainId=56) 后重试。`
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, running])

  // ---- 开源验证状态轮询：每 6s 拉取所有未结束的 verify 任务，回写 verifyStatus ----
  // 终态（success/failed）不再轮询；404（服务端任务丢失）标记失败并引导 retry-all；
  // 普通网络错误本轮忽略，下轮继续（保持 running，不误报）。
  useEffect(() => {
    let cancelled = false
    let polling = false
    const POLL_MS = 6000

    const tick = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const cur = statesRef.current
        const targets: { key: keyof DeployedMap; id: string; name: string }[] = []
        for (const c of ALL_CONTRACTS) {
          const s = cur[c.id]
          if (s.verifyTaskId && s.verifyStatus !== 'success' && s.verifyStatus !== 'failed') {
            targets.push({ key: c.id, id: s.verifyTaskId, name: c.name })
          }
        }
        if (targets.length === 0) return

        const outcomes = await Promise.all(
          targets.map(async (t) => {
            try {
              const r = await getVerifyStatus(t.id)
              return { t, ok: true as const, r }
            } catch (err) {
              return { t, ok: false as const, err: err instanceof Error ? err.message : String(err) }
            }
          })
        )
        if (cancelled || !mountedRef.current) return

        const next: DeployStateMap = { ...statesRef.current }
        let changed = false
        for (const o of outcomes) {
          const k = o.t.key
          if (o.ok) {
            const st = o.r.status
            if (st === 'success' || st === 'failed') {
              next[k] = {
                ...next[k],
                verifyStatus: st,
                verifyMessage: o.r.tail || o.r.stderrPreview || o.r.error || '',
              }
              changed = true
              if (st === 'failed') {
                const reason = (o.r.tail || o.r.stderrPreview || '未知错误').slice(0, 150)
                notify(
                  'warning',
                  `📝 ${o.t.name} 开源验证未通过：${reason}\n可点击「🔄 重新验证全部合约」重试。`
                )
              }
            }
          } else if (o.err.includes('HTTP 404')) {
            next[k] = {
              ...next[k],
              verifyStatus: 'failed',
              verifyMessage: '验证任务在服务端不存在（服务可能重启过），请点击「重新验证全部合约」',
            }
            changed = true
            notify('warning', `📝 ${o.t.name} 的验证任务在服务端不存在，请点击「🔄 重新验证全部合约」。`)
          }
          // 其他网络错误：本轮忽略，下轮继续轮询
        }
        if (changed) {
          statesRef.current = next
          safeSetStates(next)
        }
      } finally {
        polling = false
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [getVerifyStatus, safeSetStates, notify])

  /** 当前 DeployedMap（地址） */
  const deployed: DeployedMap = useMemo(() => {
    const obj = {} as DeployedMap
    for (const c of ALL_CONTRACTS) obj[c.id] = states[c.id].address
    return obj
  }, [states])

  // ---- 拉取 BuildContractInfo（首次进入 + provider 就绪时） ----
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      setBuildLoading(true)
      try {
        const list = await getBuildContracts()
        if (!cancelled) setBuildInfos(list ?? [])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!cancelled) notify('warning', `编译信息加载失败：${msg.slice(0, 120)}（点击一键部署时将自动重试）`)
      } finally {
        if (!cancelled) setBuildLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 从外部注入已保存的结果 */
  const hydrate = useCallback((partial: Partial<DeployStateMap>) => {
    setStates((prev) => {
      const next: DeployStateMap = { ...prev }
      for (const k of Object.keys(partial)) {
        const key = k as keyof DeployedMap
        next[key] = { ...EMPTY_STEP, ...(partial[key] as DeployStepState | undefined) }
      }
      return next
    })
  }, [])

  /** 重置全部状态 */
  const resetAll = useCallback(() => {
    setStates(buildInitialState())
    setProgressIdx(0)
    setProgressText('')
  }, [])

  // ================================================================
  // 底层通用：发送「合约创建」交易 → 等确认 → 返回 {txHash, address}
  //   切链校验 + 二次实时 chainId 断言；显式 chainId:56 防止签名时钱包静默切链
  // ================================================================
  const sendCreateTx = useCallback(
    async (bytecode: string, extraEncoded = ''): Promise<{ txHash: string; address: string; logs: string }> => {
      // 1) 钱包连接 + 签名者
      if (!isConnected || !account) {
        throw new Error('钱包未连接，请先在「参数配置」顶部连接钱包（MetaMask / OKX Wallet）')
      }
      if (!signer || !provider) {
        throw new Error('签名者未就绪，请重连钱包')
      }
      // 2) 链校验：56 —— 切链后通过 provider.getNetwork() 实时断言（避免 wallet Hook 滞后）
      async function assertBscChain(step: string): Promise<void> {
        let tries = 0
        while (tries < 5) {
          tries += 1
          const net = await provider!.getNetwork()
          const realChainId = Number(net.chainId)
          if (realChainId === CHAIN_ID_BSC) return
          notify('info', `[${step}] 实时 chainId=${realChainId}，等待钱包同步为 56…（${tries}/5）`)
          await new Promise((r) => setTimeout(r, 300))
        }
        const net2 = await provider!.getNetwork()
        throw new Error(
          `[${step}] chainId 二次校验失败：provider 仍报告 chainId=${Number(net2.chainId)}，期望 56。请不要在签名弹窗时切链。`
        )
      }
      if (chainId !== CHAIN_ID_BSC) {
        notify('info', `当前链为 ${chainId ?? '—'}，正在请求切换到 BSC 主网 (chainId=56)…`)
        const ok = await switchChain(CHAIN_ID_BSC)
        if (!ok) throw new Error('切链被拒或失败：钱包未切换到 BSC 主网（chainId 56）')
        // 切链后必须等 provider 内部状态同步完
        await new Promise((r) => setTimeout(r, 500))
      }
      await assertBscChain('before-sign')
      // 3) 构造 data：bytecode + encodedConstructorParams.slice(2)
      if (!bytecode || !bytecode.startsWith('0x')) {
        throw new Error(`创建字节码非法（应以 0x 开头）：${bytecode ? bytecode.slice(0, 24) : '空'}`)
      }
      let fullData = bytecode
      if (extraEncoded) {
        const tail = extraEncoded.startsWith('0x') ? extraEncoded.slice(2) : extraEncoded
        fullData = bytecode + tail
      }
      // 4) 发交易（合约创建：不写 to 字段）—— 显式 chainId 让钱包拒绝发送到非 56 链
      const logs: string[] = []
      logs.push(`[sendCreateTx] from=${account} dataLen=${fullData.length}`)
      const txReq: ethers.providers.TransactionRequest = {
        from: account,
        data: fullData,
        chainId: CHAIN_ID_BSC,
      }
      const tx = await signer.sendTransaction(txReq)
      logs.push(`txHash=${tx.hash} nonce=${tx.nonce} gasLimit=${String(tx.gasLimit ?? '—')}`)
      // 5) 二次 chainId 校验 + 等 1 确认
      await assertBscChain('after-send')
      const receipt = await tx.wait(1)
      if (!receipt.contractAddress) {
        throw new Error(`交易已上链但未获得 contractAddress；status=${receipt.status}；tx=${tx.hash}`)
      }
      if (receipt.status !== 1) {
        throw new Error(`创建交易执行失败（status=0）；请在 BscScan 查看 input 还原 revert。tx=${tx.hash}`)
      }
      const recv = receipt as unknown as { chainId?: number | string }
      if (Number(recv.chainId ?? 0) !== 0 && Number(recv.chainId) !== CHAIN_ID_BSC) {
        throw new Error(
          `Receipt chainId=${String(recv.chainId)} 非预期 56（疑似切链到其他链）。tx=${tx.hash}`
        )
      }
      logs.push(`receipt OK contractAddress=${receipt.contractAddress}`)
      return {
        txHash: tx.hash,
        address: receipt.contractAddress,
        logs: logs.join('\n'),
      }
    },
    [isConnected, account, signer, provider, chainId, switchChain, notify]
  )

  // ================================================================
  // 构造参数 ABI encode → 返回 0x 开头的 extraEncoded（直接拼接到 bytecode）
  // ================================================================
  const encodeConstructorFor = useCallback(
    (info: BuildContractInfo, values: readonly unknown[]): string => {
      const inputs = info.constructorInputs ?? []
      if (inputs.length === 0) return ''
      const types = inputs.map((i) => i.type)
      const flatVals = flattenToInputCount(values, inputs.length)
      try {
        return ethers.utils.defaultAbiCoder.encode(types, flatVals as Parameters<typeof ethers.utils.defaultAbiCoder.encode>[1])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `构造参数编码失败（合约 ${info.name}，inputs.len=${inputs.length} values.len=${values.length} flat.len=${flatVals.length} types=${types.join(',')}）：${msg}`
        )
      }
    },
    []
  )

  // ================================================================
  // 用 meta.buildConstructorArgs(UI 显示用的字符串数组) 构造 verify 的 constructorArgs
  // ================================================================
  const buildVerifyConstructorArgsStrings = useCallback(
    (meta: (typeof ALL_CONTRACTS)[number], depMap: DeployedMap): readonly string[] => {
      if (meta.getConstructorArgs) {
        return meta.getConstructorArgs(env, account ?? '', depMap)
      }
      return meta.constructorArgs ? [...meta.constructorArgs] : []
    },
    [env, account]
  )

  // ================================================================
  // 部署单个合约（按 BuildContractInfo.key → 找编译信息 + meta）
  // ================================================================
  const deployOne = useCallback(
    async (
      key: keyof DeployedMap,
      infos: readonly BuildContractInfo[],
      depMap: DeployedMap
    ): Promise<{ info: BuildContractInfo; txHash: string; address: string; logs: string; verifyTaskId?: string }> => {
      const contractKey = ALIAS_TO_CONTRACT_KEY[key]
      const info = infos.find((i) => i.key === contractKey)
      if (!info)
        throw new Error(
          `找不到 BuildContractInfo：alias=${key} → contractKey=${contractKey}。请确认 /api/build/contracts 返回 9 合约且 ALIAS_TO_CONTRACT_KEY 映射正确`,
        )
      const meta = ALL_CONTRACTS.find((m) => m.id === key)
      if (!meta) throw new Error(`找不到 ContractMeta：id=${key}`)

      // Phase C：先请求链接后 bytecode（传入 5 个库地址）
      let bytecode = info.bytecode
      if (info.requiresLinking && key === 'biz_router') {
        const missingLibs = LIBRARY_CONTRACTS.filter((l) => !depMap[l.id])
        if (missingLibs.length) {
          throw new Error(`Router 链接依赖的库尚未就绪：${missingLibs.map((l) => l.name).join('、')}`)
        }
        const libraries: RouterLibraries = {
          CfoDagRouter: depMap.lib_dag,
          CfoSmartRouter: depMap.lib_smart,
          CfoWrapRouter: depMap.lib_wrap,
          CfoUnxRouter: depMap.lib_unx,
          CfoUnxV3Router: depMap.lib_unxv3,
        }
        const resp = await getRouterBytecode(libraries)
        if (!resp?.bytecode) throw new Error('POST /api/build/router-bytecode 返回空 bytecode')
        bytecode = resp.bytecode
      }

      // 构造参数编码
      let extraEncoded = ''
      const values = meta.getConstructorArgsAsValues
        ? meta.getConstructorArgsAsValues(env, account ?? '', depMap)
        : []
      if (values.length > 0 || (info.constructorInputs?.length ?? 0) > 0) {
        extraEncoded = encodeConstructorFor(info, values)
      }

      const result = await sendCreateTx(bytecode, extraEncoded)

      // 立刻提交 forge verify 异步任务（不阻塞部署流程，但 await 一下确保拿到 id）
      let verifyTaskId: string | undefined
      if (verifyEnabled) {
        try {
          const body: VerifyRequestBody = {
            address: result.address,
            contractKey,
            chainId: CHAIN_ID_BSC,
          }
          // 构造参数（字符串数组形式；服务端按 BuildContractInfo.constructorInputs[i].type 自动编码）
          const strings = buildVerifyConstructorArgsStrings(meta, depMap)
          if (strings.length) body.constructorArgs = strings
          // 仅 CfoRouter 带 libraries
          if (key === 'biz_router') {
            body.libraries = {
              CfoDagRouter: depMap.lib_dag,
              CfoSmartRouter: depMap.lib_smart,
              CfoWrapRouter: depMap.lib_wrap,
              CfoUnxRouter: depMap.lib_unx,
              CfoUnxV3Router: depMap.lib_unxv3,
            }
          }
          const vResp = await submitVerify(body)
          verifyTaskId = vResp?.id
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          notify(
            'warning',
            `📝 ${meta.name} 提交 forge verify 失败（不影响部署）：${msg.slice(0, 80)}`
          )
        }
      }

      return { info, txHash: result.txHash, address: result.address, logs: result.logs, verifyTaskId }
    },
    [
      env,
      account,
      sendCreateTx,
      encodeConstructorFor,
      verifyEnabled,
      submitVerify,
      buildVerifyConstructorArgsStrings,
      getRouterBytecode,
      notify,
    ]
  )

  /** 整体串行跑 */
  const runAll = useCallback(async () => {
    if (lockRef.current) return
    lockRef.current = true
    safeSetRunning(true)
    try {
      // ---- a. 若 buildInfos 还没加载，这里重试一次 ----
      let infos: BuildContractInfo[] | null = buildInfos
      if (!infos || infos.length === 0) {
        setBuildLoading(true)
        notify('info', '📦 正在从服务端加载合约编译信息（/api/build/contracts）…')
        infos = await getBuildContracts()
        setBuildInfos(infos ?? [])
        setBuildLoading(false)
        if (!infos || infos.length < 9) {
          throw new Error(`编译信息不足 9 合约（仅 ${infos?.length ?? 0} 个）。请确认 forge build 成功`)
        }
      }

      // ---- b. 预检：钱包 + 链 ----
      if (!isConnected || !account) {
        throw new Error('钱包未连接：请先在「参数配置」顶部连接钱包')
      }
      if (chainId !== CHAIN_ID_BSC) {
        notify('info', `当前链为 ${chainId ?? '—'}，请求切到 BSC 主网…`)
        const ok = await switchChain(CHAIN_ID_BSC)
        if (!ok) throw new Error('切链失败：请在钱包中手动切到 BSC 主网（chainId 56）再执行')
        await new Promise((r) => setTimeout(r, 500))
      }

      let snap: DeployStateMap = { ...states }
      let depMap: DeployedMap = {} as DeployedMap
      for (const c of ALL_CONTRACTS) depMap[c.id] = snap[c.id].address

      let errored = false

      for (const meta of ALL_CONTRACTS) {
        const idx = CONTRACT_INDEX[meta.id]
        if (errored && stopOnError) {
          safeSetStates((prev) => ({ ...prev, [meta.id]: { ...EMPTY_STEP } }))
          continue
        }
        if (snap[meta.id].status === 'success' && snap[meta.id].address) {
          safeSetProgress(idx, `已部署 · ${meta.name}`)
          continue
        }

        safeSetProgress(idx - 1, `正在部署第 ${idx}/9 个：${meta.name} ...`)

        const startedAt = Date.now()
        safeSetStates((prev) => ({
          ...prev,
          [meta.id]: { ...EMPTY_STEP, status: 'running', startedAt },
        }))
        snap = { ...snap, [meta.id]: { ...snap[meta.id], status: 'running', startedAt } }

        try {
          const r = await deployOne(meta.id, infos!, depMap)
          const endedAt = Date.now()
          const nextStep: DeployStepState = {
            status: 'success',
            address: r.address,
            txHash: r.txHash,
            output: r.logs,
            exitCode: 0,
            elapsedMs: endedAt - startedAt,
            startedAt,
            endedAt,
            verifyTaskId: r.verifyTaskId,
            verifyStatus: r.verifyTaskId ? 'running' : undefined,
            verifyMessage: '',
          }
          safeSetStates((prev) => ({ ...prev, [meta.id]: nextStep }))
          snap = { ...snap, [meta.id]: nextStep }
          depMap = { ...depMap, [meta.id]: nextStep.address }
          notify('success', `✅ ${meta.name} 部署成功 → ${nextStep.address}`)
          if (mountedRef.current) void persist(snap, depMap)
        } catch (err) {
          errored = true
          const endedAt = Date.now()
          const message = err instanceof Error ? err.message : String(err)
          const nextStep: DeployStepState = {
            status: 'error',
            address: snap[meta.id].address,
            txHash: '',
            output: message,
            exitCode: -1,
            elapsedMs: endedAt - startedAt,
            startedAt,
            endedAt,
          }
          safeSetStates((prev) => ({ ...prev, [meta.id]: nextStep }))
          snap = { ...snap, [meta.id]: nextStep }
          notify('error', `❌ ${meta.name} 部署失败：${message}`)
          if (stopOnError) break
        }
      }
      if (mountedRef.current) {
        setProgressText(errored ? '部署结束（含失败项，可单独重跑）' : '全部 9 合约部署完成 🎉')
        notify(errored ? 'warning' : 'success', errored ? '流程执行完毕（含失败项）' : '全部 9 合约部署完成 🎉')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('error', `🚨 部署流程被中断：${msg}`)
      if (mountedRef.current) setProgressText(`错误：${msg.slice(0, 60)}`)
    } finally {
      lockRef.current = false
      safeSetRunning(false)
    }
  }, [
    buildInfos,
    states,
    stopOnError,
    deployOne,
    persist,
    notify,
    getBuildContracts,
    isConnected,
    account,
    chainId,
    switchChain,
    safeSetStates,
    safeSetRunning,
    safeSetProgress,
  ])

  /** 单独重跑一个合约（可能依赖 Phase A 已就绪） */
  const retryOne = useCallback(
    async (id: keyof DeployedMap) => {
      const meta = ALL_CONTRACTS.find((c) => c.id === id)
      if (!meta) return
      if (lockRef.current) {
        notify('warning', '全局部署进行中，稍后再试')
        return
      }
      lockRef.current = true
      safeSetRunning(true)
      try {
        // 加载 build infos（若尚未加载）
        let infos: BuildContractInfo[] | null = buildInfos
        if (!infos || infos.length === 0) {
          infos = await getBuildContracts()
          setBuildInfos(infos ?? [])
        }
        if (!infos || infos.length === 0) throw new Error('合约编译信息尚未就绪（/api/build/contracts）')

        // 钱包 + 链预检
        if (!isConnected || !account) throw new Error('钱包未连接')
        if (chainId !== CHAIN_ID_BSC) {
          const ok = await switchChain(CHAIN_ID_BSC)
          if (!ok) throw new Error('切链失败，请在钱包里手动切到 BSC 主网（56）')
          await new Promise((r) => setTimeout(r, 500))
        }

        const startedAt = Date.now()
        safeSetStates((prev) => ({
          ...prev,
          [id]: { ...EMPTY_STEP, status: 'running', startedAt },
        }))
        // 从 statesRef 同步读取最新 depMap（不能用 setState updater 回调——React 18 异步调度，读到的是空对象）
        const curStates = statesRef.current
        let depMap: DeployedMap = {} as DeployedMap
        for (const c of ALL_CONTRACTS) depMap[c.id] = curStates[c.id]?.address ?? ''
        // biz_router 依赖 Phase A
        if (id === 'biz_router') {
          const missing = LIBRARY_CONTRACTS.filter((l) => !depMap[l.id]).map((l) => l.name)
          if (missing.length) {
            throw new Error(`Phase A 路由库尚未部署：${missing.join('、')}`)
          }
        }

        const r = await deployOne(id, infos, depMap)
        const endedAt = Date.now()
        const nextStep: DeployStepState = {
          status: 'success',
          address: r.address,
          txHash: r.txHash,
          output: r.logs,
          exitCode: 0,
          elapsedMs: endedAt - startedAt,
          startedAt,
          endedAt,
          verifyTaskId: r.verifyTaskId,
          verifyStatus: r.verifyTaskId ? 'running' : undefined,
          verifyMessage: '',
        }
        safeSetStates((prev) => {
          const next = { ...prev, [id]: nextStep }
          depMap = {} as DeployedMap
          for (const c of ALL_CONTRACTS) depMap[c.id] = next[c.id].address
          if (mountedRef.current) void persist(next, depMap)
          return next
        })
        notify('success', `✅ ${meta.name} 重部署成功`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        safeSetStates((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            status: 'error',
            output: message,
            exitCode: -1,
            endedAt: Date.now(),
          },
        }))
        notify('error', `❌ ${meta.name} 重部署失败：${message}`)
      } finally {
        lockRef.current = false
        safeSetRunning(false)
      }
    },
    [buildInfos, deployOne, getBuildContracts, isConnected, account, chainId, switchChain, persist, notify, safeSetStates, safeSetRunning]
  )

  /** 一键重提全部已部署合约的 Sourcify 开源验证（POST /api/forge/verify/retry-all） */
  const retryVerifyAll = useCallback(async (): Promise<void> => {
    if (lockRef.current) {
      notify('warning', '部署进行中，请等部署结束后再重试开源验证')
      return
    }
    const cur = statesRef.current
    const depMap: DeployedMap = {} as DeployedMap
    for (const c of ALL_CONTRACTS) depMap[c.id] = cur[c.id]?.address ?? ''
    const deployedCount = Object.values(depMap).filter((a) =>
      /^0x[a-fA-F0-9]{40}$/.test(a)
    ).length
    if (deployedCount === 0) {
      notify('warning', '当前没有已部署的合约，请先完成一键部署')
      return
    }
    lockRef.current = true
    setVerifyRetrying(true)
    try {
      const resp = await retryAllVerify(depMap)
      const next: DeployStateMap = { ...statesRef.current }
      for (const item of resp.submitted) {
        const k = item.alias as keyof DeployedMap
        if (next[k]) {
          // 新任务 id 回写并重置为 running，轮询 effect 会自动接上
          next[k] = {
            ...next[k],
            verifyTaskId: item.id,
            verifyStatus: 'running',
            verifyMessage: '',
          }
        }
      }
      statesRef.current = next
      safeSetStates(next)
      if (mountedRef.current) void persist(next, depMap)
      notify('success', `🔄 已重新提交 ${resp.submitted.length} 个合约的开源验证，状态每 6 秒自动刷新`)
      if (resp.skipped.length > 0) {
        const detail = resp.skipped
          .map((s) => `${s.contractKey}（${s.reason}）`)
          .join('；')
          .slice(0, 200)
        notify('warning', `以下合约被跳过：${detail}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('error', `🔄 重新验证全部合约失败：${msg}`)
    } finally {
      lockRef.current = false
      if (mountedRef.current) setVerifyRetrying(false)
    }
  }, [retryAllVerify, notify, safeSetStates, persist])

  /** 构建构造参数（给 DeployPanel 展示用的字符串数组） */
  const buildConstructorArgs = useCallback(
    (meta: (typeof ALL_CONTRACTS)[number]): string[] => {
      if (meta.getConstructorArgs) {
        return meta.getConstructorArgs(env, account ?? '', deployed)
      }
      return meta.constructorArgs ? [...meta.constructorArgs] : []
    },
    [env, account, deployed]
  )

  /** 部署是否全部成功（用于校验 Tab3） */
  const allSuccess = useMemo<boolean>(() => {
    return ALL_CONTRACTS.every((c) => states[c.id].status === 'success' && states[c.id].address)
  }, [states])

  // 签名者地址（给 DeployPanel 作为旧 deployerAddress 字段来源）
  const deployerAddress = account ?? ''

  return {
    states,
    deployed,
    running,
    progressIdx,
    progressText,
    verifyEnabled,
    setVerifyEnabled,
    stopOnError,
    setStopOnError,
    runAll,
    retryOne,
    resetAll,
    hydrate,
    retryVerifyAll,
    verifyRetrying,
    buildConstructorArgs,
    allSuccess,
    // 新增：编译信息 + 加载中标志（给 Panel 展示）
    buildInfos,
    buildLoading,
    // 钱包相关向上暴露（用于 DeployPanel preflight）
    wallet: {
      isConnected,
      account,
      chainId,
      deployerAddress,
    },
  }
}

export default useDeployFlow
