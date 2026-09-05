import type { ethers } from 'ethers'
import { SUPPORTED_CHAINS } from '@/config'

// TrustWallet 官方图标库（GitHub Raw）
// 参考：https://github.com/trustwallet/assets/tree/master/blockchains
export function getChainIconUrl(chainId: number): string {
  const chain = SUPPORTED_CHAINS[chainId]
  const trustWalletNameMap: Record<number, string> = {
    // 主网
    1: 'ethereum',
    56: 'smartchain',
    137: 'polygon',
    42161: 'arbitrum',
    10: 'optimism',
    43114: 'avalanchec',
    100: 'xdai',
    250: 'fantom',
    42220: 'celo',
    1313161554: 'aurora',
    8453: 'base',
    59144: 'linea',
    324: 'zksync',
    534352: 'scroll',
    5000: 'mantle',
    1101: 'polygonzkevm',
    // 测试网（使用主网图标）
    11155111: 'ethereum',
    97: 'smartchain',
    84532: 'base',
    421614: 'arbitrum',
    11155420: 'optimism',
    80002: 'polygon',
    43113: 'avalanchec'
  }
  const name = trustWalletNameMap[chainId] || chain?.shortName.toLowerCase() || 'ethereum'
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${name}/info/logo.png`
}

export type Web3Provider = ethers.providers.Web3Provider
export type Web3Signer = ethers.Signer
