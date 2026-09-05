// 封装 Foundry 本地 Express 服务的所有 fetch 调用
// 按新架构重写：钱包签名发交易，服务端仅负责 forge verify / build / env
// Base URL: http://127.0.0.1:3011 (部署服务专用端口；3001 为 SWAP 主前端，勿占用)
// API 列表：GET /health · GET/POST /api/env · GET /api/build/contracts ·
//           POST /api/build/router-bytecode · POST /api/forge/verify ·
//           GET /api/forge/verify/:id · POST /api/forge/verify/retry-all ·
//           GET /api/deployer/result
// ----------------------------------------------------------------------
import { useCallback } from 'react'
import type {
  BuildContractInfo,
  DeployEnvConfig,
  DeployerResultResp,
  EnvCfg,
  HealthResp,
  RetryAllVerifyResp,
  RouterBytecodeResp,
  RouterLibraries,
  VerifyRequestBody,
  VerifyStatusResp,
  VerifySubmitResp,
} from '../types/foundry'

/** 给 /api/build/contracts 的真实响应体：服务端返回 { ok, contracts, outDir }（不是扁平数组！） */
export type BuildContractsResp = {
  ok: boolean
  contracts: BuildContractInfo[]
  outDir: string
}

/** GET /api/env 响应包装（和旧调用方 r.ok/r.env 结构一致） */
export type GetEnvResp = {
  ok: boolean
  env: EnvCfg
}

const BASE_URL = 'http://127.0.0.1:3011'

/** 对 fetch 的薄封装：统一 JSON 解析 + 网络错误转 Error */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 300)}` : ''}`)
  }
  return (await res.json()) as T
}

// ---------------- 对外 Hook ----------------
export function useDeployApi() {
  /** 1) GET /health — 服务健康检查 */
  const getHealth = useCallback(async (): Promise<HealthResp> => {
    try {
      return await request<HealthResp>('/health')
    } catch {
      // 网络错误时返回一个「未启动」结构，避免页面异常
      return {
        status: 'offline',
        forgePath: '',
        castPath: '',
        pwd: '',
      }
    }
  }, [])

  /** 2) GET /api/env — 读取环境配置（无 PRIVATE_KEY 字段） */
  const getEnv = useCallback(async (): Promise<GetEnvResp> => {
    try {
      const raw = await request<DeployEnvConfig>('/api/env')
      return { ok: true, env: raw }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`读取环境配置失败：${msg}`)
    }
  }, [])

  /** 3) POST /api/env — 保存环境配置到 .env（双端兼容 saved/ok 字段） */
  const saveEnv = useCallback(async (env: DeployEnvConfig): Promise<{ saved: true }> => {
    const resp = await request<{ saved?: unknown; ok?: unknown }>('/api/env', {
      method: 'POST',
      body: JSON.stringify(env),
    })
    // 兼容两种响应：新服务端返回 {saved:true}，旧服务端返回 {ok:true} 但无 saved
    const isSaved = resp?.saved === true || (resp?.saved === undefined && resp?.ok === true)
    if (!isSaved) {
      throw new Error(
        `服务端未确认保存成功（resp=${JSON.stringify(resp).slice(0, 120)}）`
      )
    }
    return { saved: true }
  }, [])

  /** 4) GET /api/build/contracts — 读取 9 合约编译构建信息数组
   *  【⚠️ 关键修复】服务端返回 { ok, contracts, outDir }（object），直接 useBuildContracts 数组会让 .find() 变成 not a function
   */
  const getBuildContracts = useCallback(async (): Promise<BuildContractInfo[]> => {
    const resp = await request<BuildContractsResp>('/api/build/contracts')
    if (!resp || !Array.isArray(resp.contracts)) {
      throw new Error(
        `服务端返回 /api/build/contracts 结构非法：${
          typeof resp === 'object' && resp ? 'keys=' + Object.keys(resp).join(',') : String(resp)
        }`
      )
    }
    return resp.contracts
  }, [])

  /** 5) POST /api/build/router-bytecode — 传入 5 库地址，返回链接后的 Router 创建字节码 */
  const getRouterBytecode = useCallback(
    async (libraries: RouterLibraries): Promise<RouterBytecodeResp> => {
      return await request<RouterBytecodeResp>('/api/build/router-bytecode', {
        method: 'POST',
        body: JSON.stringify({ libraries }),
      })
    },
    []
  )

  /** 6) POST /api/forge/verify — 提交一个合约做后台异步验证（不阻塞） */
  const submitVerify = useCallback(
    async (body: VerifyRequestBody): Promise<VerifySubmitResp> => {
      return await request<VerifySubmitResp>('/api/forge/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    []
  )

  /** 7) GET /api/forge/verify/:id — 轮询验证任务进度 */
  const getVerifyStatus = useCallback(async (id: string): Promise<VerifyStatusResp> => {
    return await request<VerifyStatusResp>(`/api/forge/verify/${encodeURIComponent(id)}`)
  }, [])

  /** 7b) POST /api/forge/verify/retry-all — 一键重提全部已部署合约的 Sourcify 验证 */
  const retryAllVerify = useCallback(
    async (deployed?: Record<string, string>): Promise<RetryAllVerifyResp> => {
      return await request<RetryAllVerifyResp>('/api/forge/verify/retry-all', {
        method: 'POST',
        body: JSON.stringify(deployed ? { deployed } : {}),
      })
    },
    []
  )

  /** 8) GET /api/deployer/result — 读取上次持久化的完整结果 */
  const getResult = useCallback(async (): Promise<DeployerResultResp> => {
    return await request<DeployerResultResp>('/api/deployer/result')
  }, [])

  /** 兼容原 POST /api/deployer/result（写入结果快照）——保持功能，用同一 fetch 函数 */
  const saveResult = useCallback(async (data: unknown): Promise<DeployerResultResp> => {
    return await request<DeployerResultResp>('/api/deployer/result', {
      method: 'POST',
      body: JSON.stringify({ data }),
    })
  }, [])

  /** 清空服务端已部署数据（DELETE /api/deployer/result）→ 允许重新一键部署 */
  const clearResult = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    return await request('/api/deployer/result', { method: 'DELETE' })
  }, [])

  return {
    BASE_URL,
    // 健康
    getHealth,
    // 环境配置
    getEnv,
    saveEnv,
    // 编译构建
    getBuildContracts,
    getRouterBytecode,
    // 开源验证
    submitVerify,
    getVerifyStatus,
    retryAllVerify,
    // 结果持久化
    getResult,
    saveResult,
    clearResult,
  }
}

export default useDeployApi
