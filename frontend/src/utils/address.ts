import { SUPPORTED_CHAINS } from '@/config'

export function shortenAddress(address: string, chars = 4): string {
  if (!address) return ''
  const parsed = address.toLowerCase()
  return `${parsed.slice(0, chars + 2)}...${parsed.slice(-chars)}`
}

export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

export const isAddress = isValidAddress

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textArea = document.createElement('textarea')
    textArea.value = text
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
    return true
  }
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const chain = SUPPORTED_CHAINS[chainId]
  const base = chain ? chain.explorerUrl : 'https://bscscan.com'
  return `${base}/tx/${txHash}`
}

export function getExplorerAddressUrl(chainId: number, address: string): string {
  const chain = SUPPORTED_CHAINS[chainId]
  const base = chain ? chain.explorerUrl : 'https://bscscan.com'
  return `${base}/address/${address}`
}

export function getSafeAppUrl(chainId: number, safeAddress: string): string {
  const chain = SUPPORTED_CHAINS[chainId]
  const prefix = chain ? chain.safeUrlPrefix : 'bnb'
  return `https://app.safe.global/home?safe=${prefix}:${safeAddress}`
}

