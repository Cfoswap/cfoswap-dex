import { http, createConfig } from 'wagmi'
import { bsc } from 'wagmi/chains'
import { injected, metaMask } from 'wagmi/connectors'
import { RPC_URLS } from '@/config'

export const config = createConfig({
  chains: [bsc],
  connectors: [
    metaMask(),
    injected({ target: 'okxWallet' }),
  ],
  transports: {
    [bsc.id]: http(RPC_URLS[0], {
      batch: true,
      retryCount: 3,
      retryDelay: 1000,
      fallback: RPC_URLS.slice(1).map(url => http(url, { batch: true })),
    }),
  },
})
