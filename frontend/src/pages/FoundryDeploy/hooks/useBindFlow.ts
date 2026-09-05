// 【按新架构重写】11+4 条绑定交易串行编排 Hook（钱包签名 eth_sendTransaction）
// 每条绑定：
//   1) 钱包预检（连接 + chainId=56；必要时切链）
//   2) 根据 BuildContractInfo.abi + sig + buildArgsAsValues 返回的 JS 原生值数组
//      → 用 ethers.utils.Interface.encodeFunctionData(sig, values) 得到 data
//   3) signer.sendTransaction({ from, to=targetAddr, data }) → tx.wait(1) → receipt.status===1 成功
// ------------------------------------------------------------------------------------------------
import { ethers } from 'ethers'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BindStepState,
  BuildContractInfo,
  DeployedMap,
  DeployEnvConfig as EnvCfg,
  ToastKind,
} from '../types/foundry'
import type { BindingStep } from '../data/deployMeta'
import {
  ALIAS_TO_CONTRACT_KEY,
  BINDING_STEPS,
  OWNER_TRANSFERS,
} from '../data/deployMeta'
import { useDeployApi } from './useDeployApi'
import { useWallet } from '@/hooks/useWallet'

export type BindingStepMeta = BindingStep & {
  // 继承自 data/deployMeta；保留与旧 Hook 对外一致的别名以减少 Panel 改动
}

export type BindStateMap = Record<string, BindStepState>

const CHAIN_ID_BSC = 56

const EMPTY_STEP: BindStepState = {
  status: 'idle',
  txHash: '',
  output: '',
  exitCode: null,
  elapsedMs: 0,
  startedAt: null,
  endedAt: null,
}

export function useBindFlow(args: {
  env: EnvCfg
  deployed: DeployedMap
  notify: (kind: ToastKind, message: string) => void
  persist: (snapshot: BindStateMap) => Promise<void>
}) {
  const { env, deployed, notify, persist } = args
  const { getBuildContracts } = useDeployApi()
  const { account, chainId, signer, switchChain, isConnected, provider } = useWallet()

  const lockRef = useRef(false)
  /** 挂载守卫：防止异步回调 setState on unmounted（N-1 崩溃根因之一） */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const safeSetStates = useCallback((updater: React.SetStateAction<BindStateMap>) => {
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
  const [buildInfos, setBuildInfos] = useState<BuildContractInfo[] | null>(null)
  const [states, setStates] = useState<BindStateMap>({})
  const [running, setRunning] = useState(false)
  const [progressIdx, setProgressIdx] = useState<number>(0)
  const [progressText, setProgressText] = useState<string>('')

  // ---- F-2 切链后状态丢失：监听 chainId，运行中切链→强制暂停 + toast ----
  const lastChainIdRef = useRef<number | null>(chainId ?? null)
  useEffect(() => {
    const prev = lastChainIdRef.current
    const curr = chainId ?? null
    lastChainIdRef.current = curr
    if (prev !== null && curr !== null && prev !== curr) {
      notify('warning', `检测到链切换：${prev} → ${curr ?? '—'}`)
    }
    if (curr !== CHAIN_ID_BSC) {
      if (running) {
        safeSetRunning(false)
        lockRef.current = false
        notify(
          'error',
          `⚠️ 已检测到当前链为 ${curr ?? '未知'}（非 BSC 主网 56），绑定流程已强制暂停。请切回 BSC 主网 (chainId=56) 后重试。`
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, running])

  // ---- 加载 build infos（绑定需要 ABI 做 encodeFunctionData） ----
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const list = await getBuildContracts()
        if (!cancelled) setBuildInfos(list ?? [])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!cancelled) notify('warning', `绑定：加载合约 ABI 失败：${msg.slice(0, 80)}（执行时会自动重试）`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 动态计算当前步骤列表（若 SAFE_ADDRESS 有值追加所有权转移） */
  const steps: readonly BindingStepMeta[] = useMemo<BindingStepMeta[]>(() => {
    const list: BindingStepMeta[] = BINDING_STEPS.map((b) => ({ ...b }))
    if (env.SAFE_ADDRESS) {
      for (const t of OWNER_TRANSFERS) {
        const safeAddr = env.SAFE_ADDRESS
        list.push({
          id: t.id,
          label: t.label,
          toKey: t.toKey,
          sig: 'transferOwnership(address)',
          buildArgs: () => [safeAddr],
          buildArgsAsValues: () => [safeAddr],
        })
      }
    }
    return list
  }, [env.SAFE_ADDRESS])

  /** 初始化所有步骤为 idle（保证 setState 可索引） */
  const ensureInitStates = useCallback(
    (base: BindStateMap): BindStateMap => {
      const next: Record<string, BindStepState> = { ...base }
      for (const s of steps) {
        if (!next[s.id]) next[s.id] = { ...EMPTY_STEP }
      }
      return next
    },
    [steps]
  )

  /** 外部注入历史结果 */
  const hydrate = useCallback(
    (partial: BindStateMap) => {
      setStates((prev) => {
        const merged = { ...prev, ...partial }
        return ensureInitStates(merged)
      })
    },
    [ensureInitStates]
  )

  // ================================================================
  // 通用：发送「合约调用」交易 → 等 1 确认 → {txHash, success}
  //   切链二次校验 + 显式 chainId:56 防止签名时钱包静默切链
  // ================================================================
  const sendCallTx = useCallback(
    async (to: string, data: string): Promise<{ txHash: string; success: boolean; logs: string }> => {
      if (!isConnected || !account) {
        throw new Error('钱包未连接：请先在「参数配置」顶部连接钱包（MetaMask / OKX Wallet）')
      }
      if (!signer) throw new Error('签名者未就绪，请重连钱包')
      if (!provider) throw new Error('Provider 未就绪，请重连钱包')
      if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
        throw new Error(`目标 to 地址非法：${to}`)
      }
      if (!data || !data.startsWith('0x')) {
        throw new Error(`调用 data 非法：${data ? data.slice(0, 24) : '空'}`)
      }
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
      // 切链
      if (chainId !== CHAIN_ID_BSC) {
        notify('info', `当前链为 ${chainId ?? '—'}，请求切到 BSC 主网…`)
        const ok = await switchChain(CHAIN_ID_BSC)
        if (!ok) throw new Error('切链被拒或失败：钱包未切换到 BSC 主网（chainId 56）')
        await new Promise((r) => setTimeout(r, 500))
      }
      await assertBscChain('before-sign')
      const logs: string[] = []
      logs.push(`[sendCallTx] from=${account} to=${to} dataLen=${data.length}`)
      // 显式 chainId 让钱包拒绝发到其他链
      const tx = await signer.sendTransaction({
        from: account,
        to,
        data,
        chainId: CHAIN_ID_BSC,
      })
      logs.push(`txHash=${tx.hash} nonce=${tx.nonce} gasLimit=${String(tx.gasLimit ?? '—')}`)
      await assertBscChain('after-send')
      const receipt = await tx.wait(1)
      const success = receipt.status === 1
      if (!success) {
        throw new Error(`绑定调用执行失败（status=0）；请在 BscScan 查看 revert。tx=${tx.hash}`)
      }
      const recv = receipt as unknown as { chainId?: number | string }
      if (Number(recv.chainId ?? 0) !== 0 && Number(recv.chainId) !== CHAIN_ID_BSC) {
        throw new Error(
          `Receipt chainId=${String(recv.chainId)} 非预期 56（疑似切链到其他链）。tx=${tx.hash}`
        )
      }
      logs.push(`receipt OK status=${receipt.status} block=${String(receipt.blockNumber ?? '—')} gasUsed=${String(receipt.gasUsed ?? '—')}`)
      return { txHash: tx.hash, success, logs: logs.join('\n') }
    },
    [isConnected, account, signer, provider, chainId, switchChain, notify]
  )

  // ================================================================
  // 按合约 key 找 BuildContractInfo（取其 ABI 生成 Interface 编码函数调用）
  // ================================================================
  const encodeFunctionDataFor = useCallback(
    (toKey: keyof DeployedMap, sig: string, values: readonly unknown[], infos: readonly BuildContractInfo[]): string => {
      const contractKey = ALIAS_TO_CONTRACT_KEY[toKey]
      const info = infos.find((i) => i.key === contractKey)
      if (!info || !info.abi || info.abi.length === 0) {
        throw new Error(
          `绑定：找不到合约 alias=${String(toKey)}→contractKey=${contractKey} 的 ABI（/api/build/contracts），无法编码 ${sig}`,
        )
      }
      const iface = new ethers.utils.Interface(info.abi as ethers.utils.Fragment[])
      try {
        // encodeFunctionData(functionFragment, values)
        return iface.encodeFunctionData(sig, values as unknown[])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `绑定：函数编码失败（${String(toKey)} · ${sig} · values.len=${values.length}）：${msg}`
        )
      }
    },
    []
  )

  // ================================================================
  // 执行单条绑定：返回更新后的 BindStateMap snapshot
  //   若 meta.preCheck 存在，先查链上状态——已绑定则跳过（status='skipped'）
  // ================================================================
  const runOne = useCallback(
    async (meta: BindingStepMeta, infos: readonly BuildContractInfo[], localStates: BindStateMap, force = false): Promise<BindStateMap> => {
      const targetAddr = deployed[meta.toKey]
      if (!targetAddr) {
        throw new Error(`目标合约 [${String(meta.toKey)}] 尚未部署到地址（请先完成 Tab2 一键部署）`)
      }
      const deployerAddr = account ?? ''
      if (!deployerAddr) throw new Error('签名钱包地址为空，请先连接钱包')

      // ---- 🔍 链上预检（force=true 时跳过） ----
      if (!force && meta.preCheck && provider) {
        safeSetStates((prev) => ({
          ...prev,
          [meta.id]: { ...EMPTY_STEP, status: 'running', startedAt: Date.now(), output: '🔍 链上预检中…' },
        }))
        const contractKey = ALIAS_TO_CONTRACT_KEY[meta.toKey]
        const info = infos.find((i) => i.key === contractKey)
        if (info?.abi && info.abi.length > 0) {
          const iface = new ethers.utils.Interface(info.abi as ethers.utils.Fragment[])
          try {
            const result = await meta.preCheck({
              provider,
              iface,
              targetAddr,
              deployed,
              env,
              deployerAddr,
            })
            if (result.shouldSkip) {
              const reason = result.reason || '链上已绑定，跳过'
              const step: BindStepState = {
                status: 'skipped',
                txHash: '',
                output: reason,
                exitCode: null,
                elapsedMs: 0,
                startedAt: Date.now(),
                endedAt: Date.now(),
              }
              const newStates = { ...localStates, [meta.id]: step }
              safeSetStates(newStates)
              notify('info', `⏭️ ${meta.id} 跳过：${reason}`)
              return newStates
            }
          } catch (preErr) {
            // 预检失败（如 RPC 超时）→ 不跳过，继续尝试执行
            const msg = preErr instanceof Error ? preErr.message.slice(0, 60) : String(preErr)
            notify('warning', `${meta.id} 预检异常（${msg}），继续尝试执行…`)
          }
        }
      }

      // ---- 正常执行绑定交易 ----
      const argsValues = meta.buildArgsAsValues(env, deployed, deployerAddr)
      if (argsValues.some((v) => v == null || v === '')) {
        notify(
          'warning',
          `${meta.id} ${meta.label} 的参数存在空值，将继续提交由链上校验（可能 revert）`
        )
      }
      const startedAt = Date.now()
      safeSetStates((prev) => ({
        ...prev,
        [meta.id]: { ...EMPTY_STEP, status: 'running', startedAt },
      }))
      const data = encodeFunctionDataFor(meta.toKey, meta.sig, argsValues, infos)
      const r = await sendCallTx(targetAddr, data)
      const endedAt = Date.now()
      const nextStep: BindStepState = {
        status: 'success',
        txHash: r.txHash,
        output: r.logs,
        exitCode: 0,
        elapsedMs: endedAt - startedAt,
        startedAt,
        endedAt,
      }
      const newStates = { ...localStates, [meta.id]: nextStep }
      safeSetStates(newStates)
      return newStates
    },
    [deployed, env, account, provider, encodeFunctionDataFor, sendCallTx, notify, safeSetStates]
  )

  const runAll = useCallback(async (force = false) => {
    if (lockRef.current) return
    lockRef.current = true
    safeSetRunning(true)
    try {
      // 1) build infos
      let infos: BuildContractInfo[] | null = buildInfos
      if (!infos || infos.length === 0) {
        notify('info', '🔗 绑定：正在加载合约 ABI …')
        infos = await getBuildContracts()
        setBuildInfos(infos ?? [])
      }
      if (!infos || infos.length === 0) {
        throw new Error('绑定：合约 ABI 未就绪（/api/build/contracts）')
      }
      // 2) 钱包 + 链
      if (!isConnected || !account) throw new Error('钱包未连接：请先在「参数配置」顶部连接钱包')
      if (chainId !== CHAIN_ID_BSC) {
        notify('info', `当前链为 ${chainId ?? '—'}，请求切到 BSC 主网…`)
        const ok = await switchChain(CHAIN_ID_BSC)
        if (!ok) throw new Error('切链失败，请在钱包中手动切到 BSC 主网（chainId 56）')
        await new Promise((r) => setTimeout(r, 500))
      }
      // 3) 运行
      let local = ensureInitStates({})
      safeSetStates(local)
      let errored = false
      let skippedCount = 0
      let successCount = 0
      for (let i = 0; i < steps.length; i += 1) {
        const meta = steps[i]
        safeSetProgress(i, `正在绑定第 ${i + 1}/${steps.length} 条：${meta.id} ${meta.label.slice(0, 28)} ...`)
        try {
          local = await runOne(meta, infos, local, force)
          const thisStep = local[meta.id]
          if (thisStep?.status === 'skipped') {
            skippedCount += 1
            notify('info', `⏭️ ${meta.id} 已绑定，跳过（${thisStep.output}）`)
          } else {
            successCount += 1
            notify('success', `✅ ${meta.id} 绑定成功`)
          }
          if (mountedRef.current) void persist(local)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // force 模式下：已知幂等 revert → 标记 skipped 继续跑
          const TOLERATED_PATTERNS = [/factory already set/i, /caller exists/i, /role already granted/i]
          const isTolerated = force && TOLERATED_PATTERNS.some((re) => re.test(message))
          if (isTolerated) {
            skippedCount += 1
            const step: BindStepState = {
              status: 'skipped',
              txHash: '',
              output: `幂等跳过（${message.slice(0, 60)}）`,
              exitCode: null,
              elapsedMs: 0,
              startedAt: Date.now(),
              endedAt: Date.now(),
            }
            local = { ...local, [meta.id]: step }
            safeSetStates(local)
            notify('info', `⏭️ ${meta.id} 幂等跳过：${message.slice(0, 40)}`)
          } else {
            errored = true
            const step: BindStepState = {
              status: 'error',
              txHash: '',
              output: message,
              exitCode: -1,
              elapsedMs: 0,
              startedAt: Date.now(),
              endedAt: Date.now(),
            }
            local = { ...local, [meta.id]: step }
            safeSetStates(local)
            notify('error', `❌ ${meta.id} 绑定失败：${message}`)
            // 正常模式遇错停下
            if (!force) break
          }
        }
      }
      if (mountedRef.current) {
        setProgressText(
          errored
            ? '绑定结束（含失败项，可单独重跑）'
            : `全部完成 🎉 成功 ${successCount} 条，跳过（已绑定）${skippedCount} 条`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify('error', `🚨 绑定流程被中断：${msg}`)
      if (mountedRef.current) setProgressText(`错误：${msg.slice(0, 60)}`)
    } finally {
      lockRef.current = false
      safeSetRunning(false)
    }
  }, [
    steps,
    ensureInitStates,
    runOne,
    persist,
    notify,
    buildInfos,
    getBuildContracts,
    isConnected,
    account,
    chainId,
    switchChain,
    safeSetStates,
    safeSetRunning,
    safeSetProgress,
  ])

  const retryOne = useCallback(
    async (id: string) => {
      if (lockRef.current) {
        notify('warning', '全局绑定进行中，稍后再试')
        return
      }
      const meta = steps.find((s) => s.id === id)
      if (!meta) return
      lockRef.current = true
      safeSetRunning(true)
      try {
        // build infos
        let infos: BuildContractInfo[] | null = buildInfos
        if (!infos || infos.length === 0) {
          infos = await getBuildContracts()
          setBuildInfos(infos ?? [])
        }
        if (!infos || infos.length === 0) throw new Error('绑定：合约 ABI 未就绪')
        // 钱包 + 链
        if (!isConnected || !account) throw new Error('钱包未连接')
        if (chainId !== CHAIN_ID_BSC) {
          const ok = await switchChain(CHAIN_ID_BSC)
          if (!ok) throw new Error('切链失败，请在钱包里手动切到 BSC 主网（56）')
          await new Promise((r) => setTimeout(r, 500))
        }

        // 复用 runOne（force=false）：重跑前同样执行链上预检，
        // 已绑定的一次性 setter（如 D8 setMiningPoolFactory）会标记 skipped，
        // 不再硬发交易触发 "factory already set" revert
        const baseStates = ensureInitStates(states)
        const newStates = await runOne(meta, infos, baseStates, false)
        if (mountedRef.current) void persist(newStates)
        const thisStep = newStates[meta.id]
        if (thisStep?.status === 'skipped') {
          notify('info', `⏭️ ${meta.id} 已绑定，跳过（${thisStep.output}）`)
        } else {
          notify('success', `✅ ${meta.id} 重跑成功`)
        }
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
        notify('error', `❌ ${meta.id} 重跑失败：${message}`)
      } finally {
        lockRef.current = false
        safeSetRunning(false)
      }
    },
    [steps, states, account, buildInfos, getBuildContracts, isConnected, chainId, switchChain, runOne, ensureInitStates, notify, persist, safeSetStates, safeSetRunning]
  )

  const allSuccess = useMemo<boolean>(() => {
    return steps.every((s) => states[s.id]?.status === 'success')
  }, [steps, states])

  return {
    steps,
    states: ensureInitStates(states),
    running,
    progressIdx,
    progressText,
    runAll,
    retryOne,
    hydrate,
    allSuccess,
  }
}

export default useBindFlow
