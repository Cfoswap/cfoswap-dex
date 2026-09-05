import { ethers } from 'ethers'
import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useWalletStore } from '@/store'
import { SUPPORTED_CHAINS } from '@/config'

export function useWallet() {
  const { t } = useTranslation()
  const {
    isConnected,
    account,
    chainId,
    provider,
    signer,
    setConnected,
    setAccount,
    setChainId,
    setProvider,
    setSigner,
    addLog,
    disconnect
  } = useWalletStore()

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      addLog('err', t('common.noMetamask'))
      return false
    }

    try {
      // ethers v5 ExternalProvider expects (request:{method,params?},callback) send() interface,
      // which is stricter than our Eip1193 typing. Cast via unknown explicitly.
      const extProvider = window.ethereum as unknown as ethers.providers.ExternalProvider
      const web3Provider = new ethers.providers.Web3Provider(extProvider, 'any')
      await web3Provider.send('eth_requestAccounts', [])
      const web3Signer = web3Provider.getSigner()
      const address = await web3Signer.getAddress()
      const network = await web3Provider.getNetwork()

      setProvider(web3Provider)
      setSigner(web3Signer)
      setAccount(address)
      setChainId(network.chainId)
      setConnected(true)
      addLog('ok', t('common.walletConnected', { address }))
      return true
    } catch (error) {
      const err = error as { message?: string } | undefined
      addLog('err', t('common.connectFailed', { error: err?.message || String(error) }))
      return false
    }
  }, [addLog, setAccount, setChainId, setConnected, setProvider, setSigner, t])

  const switchChain = useCallback(
    async (targetChainId: number) => {
      if (!provider) return false
      const chain = SUPPORTED_CHAINS[targetChainId]
      if (!chain) return false

      try {
        await provider.send('wallet_switchEthereumChain', [{ chainId: chain.chainIdHex }])
        setChainId(targetChainId)
        addLog('ok', t('common.switchedToChain', { chain: chain.name }))
        return true
      } catch (error) {
        if ((error as { code?: number })?.code === 4902) {
          try {
            await provider.send('wallet_addEthereumChain', [
              {
                chainId: chain.chainIdHex,
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: [chain.rpcUrl],
                blockExplorerUrls: [chain.explorerUrl]
              }
            ])
            setChainId(targetChainId)
            addLog('ok', t('common.addedAndSwitched', { chain: chain.name }))
            return true
          } catch (addError) {
            const err = addError as { message?: string } | undefined
            addLog('err', t('common.addNetworkFailed', { error: err?.message || String(addError) }))
            return false
          }
        }
        const err = error as { message?: string } | undefined
        addLog('err', t('common.switchNetworkFailed', { error: err?.message || String(error) }))
        return false
      }
    },
    [provider, addLog, setChainId, t]
  )

  useEffect(() => {
    if (window.ethereum) {
      const handleAccountsChanged = (...args: unknown[]) => {
        const accounts = args[0] as string[] | undefined
        if (!accounts || accounts.length === 0) {
          disconnect()
        } else {
          setAccount(accounts[0])
          if (signer && provider) {
            const newSigner = provider.getSigner()
            setSigner(newSigner)
          }
        }
      }

      const handleChainChanged = (...args: unknown[]) => {
        const chainIdHex = args[0] as string | undefined
        if (chainIdHex) {
          setChainId(parseInt(chainIdHex, 16))
          window.location.reload()
        }
      }

      const ethereumProvider = window.ethereum as
        | {
            readonly on?: (event: string, listener: (...args: unknown[]) => void) => void
            readonly removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
          }
        | undefined

      if (ethereumProvider?.on && ethereumProvider?.removeListener) {
        ethereumProvider.on('accountsChanged', handleAccountsChanged)
        ethereumProvider.on('chainChanged', handleChainChanged)

        return () => {
          ethereumProvider.removeListener?.('accountsChanged', handleAccountsChanged)
          ethereumProvider.removeListener?.('chainChanged', handleChainChanged)
        }
      }
      return undefined
    }
  }, [disconnect, provider, setAccount, setChainId, setSigner, signer])

  return {
    isConnected,
    account,
    chainId,
    provider,
    signer,
    connectWallet,
    switchChain,
    disconnect
  }
}
