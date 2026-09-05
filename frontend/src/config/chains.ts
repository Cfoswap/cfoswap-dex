import type { ChainConfig } from '@/config/types'

// Safe 1.3.0 合约默认地址（CREATE2 确定性部署，除 zkSync Era 外所有 EVM 链地址相同）
export const DEFAULT_SAFE_SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552'
export const DEFAULT_SAFE_PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2'
export const DEFAULT_SAFE_FALLBACK_HANDLER = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4'

// zkSync Era 特殊地址（非标准 EVM）
const ZKSYNC_SAFE_CONTRACTS = {
  singleton: '0x4f5A8d1C0cA130Be81d98cF6c785535F00d041B7',
  proxyFactory: '0x9f4317Ee0a3f00522f132a9bF349d007Ba60DB09',
  fallbackHandler: '0x2289443D7c75E10a806B202F61d98D448F29c0c7'
}

// 主网
export const ETHEREUM: ChainConfig = {
  chainId: 1,
  chainIdHex: '0x1',
  name: 'Ethereum',
  shortName: 'ETH',
  rpcUrl: 'https://eth.llamarpc.com',
  explorerUrl: 'https://etherscan.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'eth',
  safeTransactionService: 'https://safe-transaction-ethereum.safe.global'
}

export const BSC_MAINNET: ChainConfig = {
  chainId: 56,
  chainIdHex: '0x38',
  name: 'BNB Smart Chain',
  shortName: 'BSC',
  rpcUrl: 'https://bsc-dataseed.binance.org/',
  explorerUrl: 'https://bscscan.com',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  safeUrlPrefix: 'bnb',
  safeTransactionService: 'https://safe-transaction-bsc.safe.global'
}

export const POLYGON: ChainConfig = {
  chainId: 137,
  chainIdHex: '0x89',
  name: 'Polygon',
  shortName: 'MATIC',
  rpcUrl: 'https://polygon-rpc.com',
  explorerUrl: 'https://polygonscan.com',
  nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
  safeUrlPrefix: 'matic',
  safeTransactionService: 'https://safe-transaction-polygon.safe.global'
}

export const ARBITRUM: ChainConfig = {
  chainId: 42161,
  chainIdHex: '0xa4b1',
  name: 'Arbitrum One',
  shortName: 'ARB',
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
  explorerUrl: 'https://arbiscan.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'arb1',
  safeTransactionService: 'https://safe-transaction-arbitrum.safe.global'
}

export const OPTIMISM: ChainConfig = {
  chainId: 10,
  chainIdHex: '0xa',
  name: 'Optimism',
  shortName: 'OP',
  rpcUrl: 'https://mainnet.optimism.io',
  explorerUrl: 'https://optimistic.etherscan.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'oeth',
  safeTransactionService: 'https://safe-transaction-optimism.safe.global'
}

export const AVALANCHE: ChainConfig = {
  chainId: 43114,
  chainIdHex: '0xa86a',
  name: 'Avalanche C-Chain',
  shortName: 'AVAX',
  rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
  explorerUrl: 'https://snowtrace.io',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  safeUrlPrefix: 'avax',
  safeTransactionService: 'https://safe-transaction-avalanche.safe.global'
}

export const GNOSIS_CHAIN: ChainConfig = {
  chainId: 100,
  chainIdHex: '0x64',
  name: 'Gnosis Chain',
  shortName: 'xDAI',
  rpcUrl: 'https://rpc.gnosischain.com',
  explorerUrl: 'https://gnosisscan.io',
  nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
  safeUrlPrefix: 'gno',
  safeTransactionService: 'https://safe-transaction-gnosis-chain.safe.global'
}

export const FANTOM: ChainConfig = {
  chainId: 250,
  chainIdHex: '0xfa',
  name: 'Fantom Opera',
  shortName: 'FTM',
  rpcUrl: 'https://rpc.ftm.tools',
  explorerUrl: 'https://ftmscan.com',
  nativeCurrency: { name: 'FTM', symbol: 'FTM', decimals: 18 },
  safeUrlPrefix: 'ftm'
}

export const CELO: ChainConfig = {
  chainId: 42220,
  chainIdHex: '0xa4ec',
  name: 'Celo',
  shortName: 'CELO',
  rpcUrl: 'https://forno.celo.org',
  explorerUrl: 'https://celoscan.io',
  nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
  safeUrlPrefix: 'celo'
}

export const AURORA: ChainConfig = {
  chainId: 1313161554,
  chainIdHex: '0x4e454152',
  name: 'Aurora',
  shortName: 'AURORA',
  rpcUrl: 'https://mainnet.aurora.dev',
  explorerUrl: 'https://aurorascan.dev',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'aurora'
}

export const BASE: ChainConfig = {
  chainId: 8453,
  chainIdHex: '0x2105',
  name: 'Base',
  shortName: 'BASE',
  rpcUrl: 'https://mainnet.base.org',
  explorerUrl: 'https://basescan.org',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'base',
  safeTransactionService: 'https://safe-transaction-base.safe.global'
}

export const LINEA: ChainConfig = {
  chainId: 59144,
  chainIdHex: '0xe708',
  name: 'Linea',
  shortName: 'LINEA',
  rpcUrl: 'https://rpc.linea.build',
  explorerUrl: 'https://lineascan.build',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'linea'
}

export const ZKSYNC_ERA: ChainConfig = {
  chainId: 324,
  chainIdHex: '0x144',
  name: 'zkSync Era',
  shortName: 'ZKSYNC',
  rpcUrl: 'https://mainnet.era.zksync.io',
  explorerUrl: 'https://explorer.zksync.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'zksync',
  safeContracts: ZKSYNC_SAFE_CONTRACTS
}

export const SCROLL: ChainConfig = {
  chainId: 534352,
  chainIdHex: '0x82750',
  name: 'Scroll',
  shortName: 'SCROLL',
  rpcUrl: 'https://rpc.scroll.io',
  explorerUrl: 'https://scrollscan.com',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'scr'
}

export const MANTLE: ChainConfig = {
  chainId: 5000,
  chainIdHex: '0x1388',
  name: 'Mantle',
  shortName: 'MNT',
  rpcUrl: 'https://rpc.mantle.xyz',
  explorerUrl: 'https://explorer.mantle.xyz',
  nativeCurrency: { name: 'MNT', symbol: 'MNT', decimals: 18 },
  safeUrlPrefix: 'mnt'
}

export const POLYGON_ZKEVM: ChainConfig = {
  chainId: 1101,
  chainIdHex: '0x44d',
  name: 'Polygon zkEVM',
  shortName: 'zkEVM',
  rpcUrl: 'https://zkevm-rpc.com',
  explorerUrl: 'https://zkevm.polygonscan.com',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'zkevm'
}

// 测试网
export const SEPOLIA: ChainConfig = {
  chainId: 11155111,
  chainIdHex: '0xaa36a7',
  name: 'Sepolia Testnet',
  shortName: 'SEP',
  rpcUrl: 'https://rpc.sepolia.org',
  explorerUrl: 'https://sepolia.etherscan.io',
  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'sep',
  safeTransactionService: 'https://safe-transaction-sepolia.safe.global',
  isTestnet: true
}

export const BSC_TESTNET: ChainConfig = {
  chainId: 97,
  chainIdHex: '0x61',
  name: 'BSC Testnet',
  shortName: 'tBSC',
  rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545/',
  explorerUrl: 'https://testnet.bscscan.com',
  nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
  safeUrlPrefix: 'bnb-testnet',
  safeTransactionService: 'https://safe-transaction-bsc-testnet.safe.global',
  isTestnet: true
}

export const BASE_SEPOLIA: ChainConfig = {
  chainId: 84532,
  chainIdHex: '0x14a34',
  name: 'Base Sepolia',
  shortName: 'tBASE',
  rpcUrl: 'https://sepolia.base.org',
  explorerUrl: 'https://sepolia.basescan.org',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'basesep',
  isTestnet: true
}

export const ARBITRUM_SEPOLIA: ChainConfig = {
  chainId: 421614,
  chainIdHex: '0x66eee',
  name: 'Arbitrum Sepolia',
  shortName: 'tARB',
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorerUrl: 'https://sepolia.arbiscan.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'arb-sep',
  isTestnet: true
}

export const OPTIMISM_SEPOLIA: ChainConfig = {
  chainId: 11155420,
  chainIdHex: '0xaa37dc',
  name: 'Optimism Sepolia',
  shortName: 'tOP',
  rpcUrl: 'https://sepolia.optimism.io',
  explorerUrl: 'https://sepolia-optimism.etherscan.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  safeUrlPrefix: 'opsep',
  isTestnet: true
}

export const POLYGON_AMOY: ChainConfig = {
  chainId: 80002,
  chainIdHex: '0x13882',
  name: 'Polygon Amoy',
  shortName: 'tPOL',
  rpcUrl: 'https://rpc-amoy.polygon.technology',
  explorerUrl: 'https://amoy.polygonscan.com',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  safeUrlPrefix: 'matic-amoy',
  isTestnet: true
}

export const AVALANCHE_FUJI: ChainConfig = {
  chainId: 43113,
  chainIdHex: '0xa869',
  name: 'Avalanche Fuji',
  shortName: 'tAVAX',
  rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
  explorerUrl: 'https://testnet.snowtrace.io',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  safeUrlPrefix: 'fuji',
  isTestnet: true
}

export const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  // 主网
  [ETHEREUM.chainId]: ETHEREUM,
  [BSC_MAINNET.chainId]: BSC_MAINNET,
  [POLYGON.chainId]: POLYGON,
  [ARBITRUM.chainId]: ARBITRUM,
  [OPTIMISM.chainId]: OPTIMISM,
  [AVALANCHE.chainId]: AVALANCHE,
  [GNOSIS_CHAIN.chainId]: GNOSIS_CHAIN,
  [FANTOM.chainId]: FANTOM,
  [CELO.chainId]: CELO,
  [AURORA.chainId]: AURORA,
  [BASE.chainId]: BASE,
  [LINEA.chainId]: LINEA,
  [ZKSYNC_ERA.chainId]: ZKSYNC_ERA,
  [SCROLL.chainId]: SCROLL,
  [MANTLE.chainId]: MANTLE,
  [POLYGON_ZKEVM.chainId]: POLYGON_ZKEVM,
  // 测试网
  [SEPOLIA.chainId]: SEPOLIA,
  [BSC_TESTNET.chainId]: BSC_TESTNET,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
  [ARBITRUM_SEPOLIA.chainId]: ARBITRUM_SEPOLIA,
  [OPTIMISM_SEPOLIA.chainId]: OPTIMISM_SEPOLIA,
  [POLYGON_AMOY.chainId]: POLYGON_AMOY,
  [AVALANCHE_FUJI.chainId]: AVALANCHE_FUJI
}

// 主网链列表（用于UI分组）
export const MAINNET_CHAINS: ChainConfig[] = [
  ETHEREUM,
  BSC_MAINNET,
  POLYGON,
  ARBITRUM,
  OPTIMISM,
  AVALANCHE,
  BASE,
  GNOSIS_CHAIN,
  FANTOM,
  CELO,
  LINEA,
  ZKSYNC_ERA,
  SCROLL,
  MANTLE,
  AURORA,
  POLYGON_ZKEVM
]

// 测试网链列表
export const TESTNET_CHAINS: ChainConfig[] = [
  SEPOLIA,
  BSC_TESTNET,
  BASE_SEPOLIA,
  ARBITRUM_SEPOLIA,
  OPTIMISM_SEPOLIA,
  POLYGON_AMOY,
  AVALANCHE_FUJI
]

export function getSafeContracts(chainId: number) {
  const chain = SUPPORTED_CHAINS[chainId]
  if (chain?.safeContracts) {
    return chain.safeContracts
  }
  return {
    singleton: DEFAULT_SAFE_SINGLETON,
    proxyFactory: DEFAULT_SAFE_PROXY_FACTORY,
    fallbackHandler: DEFAULT_SAFE_FALLBACK_HANDLER
  }
}
