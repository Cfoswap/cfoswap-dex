export interface NativeCurrency {
  name: string
  symbol: string
  decimals: number
}

export interface SafeContracts {
  singleton: string
  proxyFactory: string
  fallbackHandler: string
}

export interface ChainConfig {
  chainId: number
  chainIdHex: string
  name: string
  shortName: string
  rpcUrl: string
  explorerUrl: string
  nativeCurrency: NativeCurrency
  safeUrlPrefix: string
  safeTransactionService?: string
  isTestnet?: boolean
  safeContracts?: SafeContracts
}

export interface LogEntry {
  id: string
  type: 'ok' | 'err' | 'warn' | 'info' | 'hint'
  message: string
  timestamp: number
}
