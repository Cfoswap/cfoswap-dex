import { create } from 'zustand'
import type { LogEntry } from '@/config'
import type { Web3Provider, Web3Signer } from '@/utils/chains'
import { ethers } from 'ethers'

interface WalletState {
  isConnected: boolean
  account: string | null
  chainId: number | null
  provider: Web3Provider | null
  signer: Web3Signer | null
  balance: string | null // native balance as decimals string, e.g. "1.23" BNB
  logs: LogEntry[]
  setConnected: (connected: boolean) => void
  setAccount: (account: string | null) => void
  setChainId: (chainId: number | null) => void
  setProvider: (provider: Web3Provider) => void
  setSigner: (signer: Web3Signer) => void
  setBalance: (balance: string | null) => void
  addLog: (type: LogEntry['type'], message: string) => void
  clearLogs: () => void
  connect: () => Promise<boolean>
  disconnect: () => void
}

export const useWalletStore = create<WalletState>((set, get) => ({
  isConnected: false,
  account: null,
  chainId: null,
  provider: null,
  signer: null,
  balance: null,
  logs: [],
  setConnected: (connected) => set({ isConnected: connected }),
  setAccount: (account) => set({ account }),
  setChainId: (chainId) => set({ chainId }),
  setProvider: (provider) => set({ provider }),
  setSigner: (signer) => set({ signer }),
  setBalance: (balance) => set({ balance }),
  addLog: (type, message) =>
    set((state) => ({
      logs: [
        ...state.logs,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type,
          message,
          timestamp: Date.now(),
        },
      ],
    })),
  clearLogs: () => set({ logs: [] }),
  connect: async (): Promise<boolean> => {
    const ethereum = (typeof window !== 'undefined' ? (window as unknown as { ethereum?: unknown }).ethereum : undefined) as
      | ethers.providers.ExternalProvider
      | undefined
    if (!ethereum) {
      get().addLog('err', '请先安装 MetaMask / 浏览器钱包。')
      return false
    }
    try {
      const web3Provider = new ethers.providers.Web3Provider(ethereum)
      await web3Provider.send('eth_requestAccounts', [])
      const web3Signer = web3Provider.getSigner()
      const address = await web3Signer.getAddress()
      const network = await web3Provider.getNetwork()
      const rawBal = await web3Provider.getBalance(address)
      const balanceStr = ethers.utils.formatEther(rawBal)

      set({
        isConnected: true,
        account: address,
        chainId: network.chainId,
        provider: web3Provider as never,
        signer: web3Signer as never,
        balance: balanceStr,
      })
      get().addLog('ok', `钱包已连接：${address}`)
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      get().addLog('err', `钱包连接失败：${msg}`)
      return false
    }
  },
  disconnect: () =>
    set({
      isConnected: false,
      account: null,
      chainId: null,
      provider: null,
      signer: null,
      balance: null,
    }),
}))
