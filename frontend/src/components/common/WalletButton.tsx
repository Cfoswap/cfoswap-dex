import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@/hooks/useWallet'
import { shortenAddress } from '@/utils/address'
import { getChainIconUrl } from '@/utils/chains'
import { SUPPORTED_CHAINS, MAINNET_CHAINS } from '@/config'

function WalletButton() {
  const { t } = useTranslation()
  const { isConnected, account, chainId, connectWallet, switchChain, disconnect } = useWallet()
  const [showChainSelector, setShowChainSelector] = useState(false)

  if (!isConnected || !account) {
    return (
      <button
        onClick={connectWallet}
        className="bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-400 hover:to-primary-500 text-white font-bold text-sm px-5 py-2.5 rounded-xl shadow-lg shadow-primary-500/25 transition-transform hover:scale-105 flex items-center gap-2 whitespace-nowrap"
      >
        {t('common.connectWallet')}
      </button>
    )
  }

  const currentChain = chainId ? SUPPORTED_CHAINS[chainId] : null

  return (
    <div className="flex items-center gap-2 relative">
      <button
        onClick={() => setShowChainSelector(!showChainSelector)}
        className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border transition-colors whitespace-nowrap"
        style={currentChain ? {
          backgroundColor: currentChain.isTestnet ? 'rgb(243 232 255)' : 'rgb(236 253 245)',
          color: currentChain.isTestnet ? 'rgb(126 34 206)' : 'rgb(4 120 87)',
          borderColor: currentChain.isTestnet ? 'rgb(233 213 255)' : 'rgb(209 250 229)'
        } : {
          backgroundColor: 'rgb(255 251 235)',
          color: 'rgb(180 83 9)',
          borderColor: 'rgb(254 243 199)'
        }}
      >
        {currentChain && (
          <img
            src={getChainIconUrl(chainId!)}
            alt={currentChain.shortName}
            className="w-4 h-4 rounded-full object-contain flex-shrink-0"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
        <span className="hidden sm:inline">{currentChain ? currentChain.shortName : t('common.unsupportedChain')}</span>
        <span className="sm:hidden">{currentChain ? currentChain.shortName.slice(0, 3) : '?'}</span>
      </button>

      {showChainSelector && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowChainSelector(false)}
          />
          <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-gray-200 z-50 p-2 max-h-80 overflow-y-auto">
            <div className="text-xs font-bold text-gray-400 px-2 py-1">{t('create.mainnet')}</div>
            {MAINNET_CHAINS.map((chain) => (
              <button
                key={chain.chainId}
                onClick={() => {
                  switchChain(chain.chainId)
                  setShowChainSelector(false)
                }}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-left transition-colors ${
                  chainId === chain.chainId ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-gray-50 text-gray-700'
                }`}
              >
                <img
                  src={getChainIconUrl(chain.chainId)}
                  alt={chain.shortName}
                  className="w-5 h-5 rounded-full object-contain flex-shrink-0"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
                <span className="truncate">{chain.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <button
        onClick={disconnect}
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-800 font-semibold text-sm px-3 sm:px-4 py-2.5 rounded-xl shadow-sm flex items-center gap-2 transition-colors whitespace-nowrap"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></span>
        <span className="hidden sm:inline">{shortenAddress(account)}</span>
        <span className="sm:hidden font-mono text-xs">{shortenAddress(account, 3)}</span>
      </button>
    </div>
  )
}

export default WalletButton
