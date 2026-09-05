import { useState, useEffect, useMemo } from 'react';
import { X, Copy, ExternalLink, RefreshCw, Wallet, LogOut, Loader2, ShieldAlert, Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/store/uiStore.js';
import { useWalletStore } from '@/store/walletStore.js';
import { EXPLORER_URL } from '@/config/index.js';
import { formatBalance } from '@/utils/index.js';
import { decimalsById, resolveTokenById } from '@/utils/tokens.js';
import useTheme from '@/hooks/useTheme.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';

const WALLETS = [
  { id: 'okx', name: 'OKX Wallet', icon: '/img/wallets/okx.png', recommended: true },
  { id: 'metamask', name: 'MetaMask', icon: '/img/wallets/metamask.png' },
  { id: 'binance', name: 'Binance Wallet', icon: '/img/wallets/binance.png' },
];

function getTokenDecimals(id, customTokens = null) {
  return decimalsById(id, customTokens, useWalletStore.getState().decimalsOverride);
}

function shortAddr(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch { return false; }
}

export default function WalletModal() {
  const { t } = useTranslation();
  const { toggleTheme, isLight } = useTheme();
  const closeModal = () => useUiStore.getState().closeWalletModal();
  const showToast = useUiStore((s) => s.showToast);
  const walletModalOpen = useUiStore((s) => s.walletModalOpen);

  const connectWallet = useWalletStore((s) => s.connectWallet);
  const connecting = useWalletStore((s) => s.connecting);
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const chainName = useWalletStore((s) => s.chainName);
  const bnbBalance = useWalletStore((s) => s.bnbBalance);
  const cfoBalance = useWalletStore((s) => s.cfoBalance);
  const tokenBalances = useWalletStore((s) => s.tokenBalances || {});
  const customTokens = useWalletStore((s) => s.customTokens || {});
  const recentTokens = useWalletStore((s) => s.recentTokens || []);
  const loadingBalances = useWalletStore((s) => s.loadingBalances);
  const loadingPrices = useWalletStore((s) => s.loadingPrices);
  const tokenPrices = useWalletStore((s) => s.tokenPrices || {});
  const lastBalancesUpdateAt = useWalletStore((s) => s.lastBalancesUpdateAt);
  const refreshBalances = useWalletStore((s) => s.refreshBalances);
  const maybeSilentRefresh = useWalletStore((s) => s.maybeSilentRefresh);
  const disconnectWallet = useWalletStore((s) => s.disconnectWallet);

  const [connectingWallet, setConnectingWallet] = useState(null);
  const [copyOk, setCopyOk] = useState(false);
  const [manuallyRefreshing, setManuallyRefreshing] = useState(false);

  // When modal opens, silent refresh (if cache exists, no loading shown, update in background)
  useEffect(() => {
    if (walletModalOpen && connected && address) {
      maybeSilentRefresh();
    }
  }, [walletModalOpen, connected, address, maybeSilentRefresh]);

  const handleConnect = async (walletId) => {
    setConnectingWallet(walletId);
    try {
      await connectWallet(walletId);
    } finally {
      setConnectingWallet(null);
    }
  };

  const handleCopyAddr = async () => {
    if (!address) return;
    const ok = await copyText(address);
    if (ok) {
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
      try { showToast && showToast('success', 'copied_to_clipboard'); } catch {}
    }
  };

  const handleRefresh = async () => {
    if (manuallyRefreshing || loadingBalances) return;
    setManuallyRefreshing(true);
    try {
      await refreshBalances?.();
      try { showToast && showToast('success', 'balances_refreshed'); } catch {}
    } catch (e) {
      try { showToast && showToast('warning', 'balances_refresh_fail'); } catch {}
    } finally {
      setManuallyRefreshing(false);
    }
  };

  const hasCacheData = useMemo(() => {
    // Determine if cached data exists for direct display (used to decide whether to show skeleton)
    if (lastBalancesUpdateAt > 0) return true;
    if (parseFloat(bnbBalance || '0') > 0) return true;
    if (parseFloat(cfoBalance || '0') > 0) return true;
    for (const v of Object.values(tokenBalances || {})) {
      if (parseFloat(v || '0') > 0) return true;
    }
    return false;
  }, [lastBalancesUpdateAt, bnbBalance, cfoBalance, tokenBalances]);

  const assetsList = useMemo(() => {
    // Ids: built-in symbol ('BNB'/'USDT'/...) or custom lowercase address
    const needShow = new Set(['BNB', 'CFO']);
    Object.keys(customTokens || {}).forEach((id) => { if (id) needShow.add(id); });
    (recentTokens || []).forEach((id) => { if (id && id !== 'BNB' && id !== 'CFO') needShow.add(id); });
    Object.keys(tokenBalances || {}).forEach((id) => { if (id) needShow.add(id); });

    const all = Array.from(needShow).map((id) => ({
      id,
      bal: id === 'BNB'
        ? (bnbBalance || '0')
        : id === 'CFO'
          ? (cfoBalance || '0')
          : (tokenBalances?.[id] || '0'),
    }));

    const uniq = [];
    for (const a of all) {
      const tok = resolveTokenById(a.id, customTokens);
      if (!tok && parseFloat(a.bal || '0') <= 0) continue;
      const balF = parseFloat(a.bal || '0');
      uniq.push({
        sym: a.id,
        symbol: tok?.symbol || a.id,
        bal: a.bal || '0',
        balF,
        name: tok?.name || a.id,
        decimals: getTokenDecimals(a.id, customTokens),
        logoURI: tok?.logoURI || '',
        address: tok?.address || '',
        isImported: !!customTokens?.[String(tok?.address || '').toLowerCase()] || !!customTokens?.[a.id],
        isRecent: !!(recentTokens || []).includes(a.id) && !customTokens?.[a.id],
      });
    }
    uniq.sort((a, b) => {
      if (a.balF > 0 && b.balF <= 0) return -1;
      if (a.balF <= 0 && b.balF > 0) return 1;
      if (a.balF > 0 || b.balF > 0) return b.balF - a.balF;
      return a.sym.localeCompare(b.sym);
    });
    return uniq;
  }, [bnbBalance, cfoBalance, tokenBalances, customTokens, recentTokens]);

  const totalAssetsUsd = useMemo(() => {
    let sum = 0;
    let hasAny = false;
    for (const a of assetsList) {
      const p = tokenPrices[a.sym];
      if (typeof p === 'number' && p > 0) {
        sum += (a.balF || 0) * p;
        hasAny = true;
      }
    }
    return hasAny ? sum : null;
  }, [assetsList, tokenPrices]);

  // Whether to show skeleton: first load no cache + currently loading
  const showSkeleton = loadingBalances && !hasCacheData;
  // Whether to show refresh animation: manual refresh in progress
  const showSpin = manuallyRefreshing || (loadingBalances && hasCacheData);

  if (!connected) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn"
        onClick={(e) => {
          e.stopPropagation();
          closeModal();
        }}
      >
        <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
        <div
          className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: 'var(--gradient-surface)',
            border: '1px solid var(--color-border-default)',
            boxShadow: 'var(--modal-card-shadow)',
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); closeModal(); }}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            style={{
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <X size={18} />
          </button>
          <div className="mb-6">
            <h2 className="text-xl font-bold mb-1.5" style={{ color: 'var(--color-text-primary)' }}>
              {t('wallet_connect_title')}
            </h2>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {t('wallet_connect_desc')}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-6">
            {WALLETS.map((w) => {
              const isConnecting = connecting && connectingWallet === w.id;
              return (
                <button
                  key={w.id}
                  onClick={() => handleConnect(w.id)}
                  disabled={connecting}
                  className="relative group p-4 rounded-xl flex flex-col items-center gap-2.5 transition-colors duration-200"
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid #E2E8F0',
                    boxShadow: 'none',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#F5F7FB';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = '#FFFFFF';
                  }}
                >
                  {w.recommended && (
                    <span className="absolute top-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={{ background: 'var(--color-primary-500)', color: 'var(--color-text-inverse)' }}
                    >{t('recommended')}</span>
                  )}
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center overflow-hidden"
                    style={{ background: '#F1F5F9' }}>
                    <img src={w.icon} alt={w.name} className="w-9 h-9 object-contain" />
                  </div>
                  <span className="text-sm font-medium" style={{ color: '#0F172A' }}>{w.name}</span>
                  {isConnecting && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-xl"
                      style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(4px)', opacity: 0.85 }}
                    >
                      <div className="w-6 h-6 border-2 rounded-full animate-spin"
                        style={{
                          borderColor: 'var(--color-border-default)',
                          borderTopColor: 'var(--color-primary-400)',
                        }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <div className="text-center text-xs leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('agree_terms')}{' '}
            <span style={{ color: 'var(--color-primary-500)' }}>{t('terms_of_service')}</span>{' '}
            {t('and')}{' '}
            <span style={{ color: 'var(--color-primary-500)' }}>{t('privacy_policy')}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn"
      onClick={(e) => { e.stopPropagation(); closeModal(); }}
    >
      <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
      <div
        className="relative w-full max-w-md rounded-xl p-5 animate-fadeIn flex flex-col max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--gradient-surface)',
          border: '1px solid var(--color-border-default)',
          boxShadow: 'var(--modal-card-shadow)',
        }}
      >
        <div className="grid grid-cols-3 items-center mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 justify-self-start" style={{ color: 'var(--color-text-primary)' }}>
            <Wallet size={18} style={{ color: 'var(--color-primary-500)' }} />
            {t('my_assets') || 'My Assets'}
          </h2>
          <div className="justify-self-center">
            <button
              onClick={(e) => { e.stopPropagation(); toggleTheme(); }}
              aria-label={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
              title={isLight ? t('switch_dark_mode') : t('switch_light_mode')}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
              style={{
                color: 'var(--color-text-secondary)',
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              {isLight ? <Moon size={15} /> : <Sun size={15} />}
            </button>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); closeModal(); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors justify-self-end"
            style={{
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {chainName && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium"
              style={{ background: 'var(--color-primary-50)', color: 'var(--color-primary-700)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-primary-500)' }} />
              {chainName}
            </span>
          )}
          <button
            onClick={handleCopyAddr}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium font-numeric transition-colors"
            style={{
              background: copyOk ? 'var(--state-success-bg)' : 'var(--color-bg-tertiary)',
              color: copyOk ? 'var(--state-success)' : 'var(--color-text-secondary)',
              border: '1px solid var(--color-border-subtle)',
            }}
            title={address}
          >
            <Copy size={12} />
            <span>{shortAddr(address)}</span>
            {copyOk && <span className="text-[10px]">✓</span>}
          </button>
          {EXPLORER_URL && address && (
            <a
              href={`${EXPLORER_URL}/address/${address}`}
              target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
              style={{
                background: 'var(--color-bg-tertiary)',
                color: 'var(--color-primary-500)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              <ExternalLink size={12} />
              <span className="hidden sm:inline">{t('view_explorer')}</span>
            </a>
          )}
          <button
            onClick={handleRefresh}
            disabled={manuallyRefreshing || loadingBalances}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ml-auto"
            style={{
              background: 'var(--state-info-bg)',
              color: 'var(--state-info)',
              border: '1px solid var(--color-border-subtle)',
              opacity: (manuallyRefreshing || loadingBalances) ? 0.7 : 1,
            }}
          >
            <RefreshCw size={12} className={showSpin ? 'animate-spin' : ''} />
          </button>
        </div>

        <div
          className="mb-4 p-4 rounded-xl"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary-50) 0%, var(--state-info-bg) 100%)',
            border: '1px solid var(--color-primary-100)',
          }}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {t('total_assets_est') || 'Estimated Total'}
            </p>
            {loadingPrices && manuallyRefreshing && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-text-tertiary)' }} />}
          </div>
          <p className="text-2xl font-bold font-numeric" style={{ color: 'var(--color-text-primary)' }}>
            {totalAssetsUsd === null ? (
              hasCacheData ? '--' : '...'
            ) : (
              `$${formatBalance(String(totalAssetsUsd), 2)}`
            )}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('onchain_price_est')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar -mx-1 px-1">
          <div className="space-y-1">
            {showSkeleton ? (
              [...Array(4)].map((_, i) => (
                <div key={i} className="animate-pulse flex items-center gap-3 p-3 rounded-xl"
                  style={{ background: 'var(--color-bg-secondary)' }}
                >
                  <div className="w-10 h-10 rounded-xl" style={{ background: 'var(--color-bg-tertiary)' }} />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-20 rounded" style={{ background: 'var(--color-bg-tertiary)' }} />
                    <div className="h-2.5 w-12 rounded" style={{ background: 'var(--color-bg-tertiary)' }} />
                  </div>
                  <div className="h-3 w-16 rounded" style={{ background: 'var(--color-bg-tertiary)' }} />
                </div>
              ))
            ) : assetsList.length === 0 ? (
              <div className="py-12 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                <ShieldAlert size={28} className="mx-auto mb-2 opacity-60" />
                <p>{t('no_assets_found') || 'No assets yet'}</p>
              </div>
            ) : (
              assetsList.map((a) => {
                const zero = a.balF <= 0;
                return (
                  <div
                    key={a.sym}
                    className="flex items-center gap-3 p-3 rounded-xl transition-colors"
                    style={{
                      background: zero ? 'transparent' : 'var(--color-bg-secondary)',
                      border: zero ? '1px solid transparent' : '1px solid var(--color-border-default)',
                      opacity: zero ? 0.6 : 1,
                    }}
                  >
                    <div
                      className="w-8 h-8 flex items-center justify-center overflow-hidden flex-shrink-0"
                    >
                      {a.logoURI ? (
                        <TokenIcon src={a.logoURI} symbol={a.symbol} size={32} />
                      ) : (
                        <span className="text-[11px] font-bold" style={{ color: 'var(--color-text-secondary)' }}>
                          {a.symbol.slice(0, 3).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>
                          {a.symbol}
                        </span>
                        {a.isImported && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                            style={{ background: 'var(--state-warning-bg)', color: 'var(--state-warning)' }}
                          >
                            {t('import_badge')}
                          </span>
                        )}
                        {!a.isImported && a.isRecent && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                            style={{ background: 'var(--state-info-bg)', color: 'var(--state-info)' }}
                          >
                            {t('recent_badge')}
                          </span>
                        )}
                        {zero && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                            style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }}
                          >
                            0
                          </span>
                        )}
                      </div>
                      <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>{a.name}</p>
                    </div>
                    <div className="text-right flex-shrink-0 min-w-[100px]">
                      <p className="text-sm font-semibold font-numeric truncate"
                        style={{ color: 'var(--color-text-primary)' }}
                      >
                        {formatBalance(a.bal, 6)}
                      </p>
                      {a.address && (
                        <a
                          href={`${EXPLORER_URL}/token/${a.address}`}
                          target="_blank" rel="noopener noreferrer"
                          className="text-[10px] font-numeric truncate block"
                          style={{ color: 'var(--color-text-tertiary)' }}
                        >
                          {shortAddr(a.address)}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-border-default)' }}>
          <button
            onClick={() => {
              try { disconnectWallet(); } catch (e) { console.warn('[WalletModal] disconnect err:', e); }
              closeModal();
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            style={{
              background: 'var(--state-error-bg)',
              color: 'var(--state-error)',
              border: '1px solid var(--color-border-subtle)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--state-error)';
              e.currentTarget.style.color = 'var(--color-text-inverse)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--state-error-bg)';
              e.currentTarget.style.color = 'var(--state-error)';
            }}
          >
            <LogOut size={16} />
            {t('disconnect') || 'Disconnect Wallet'}
          </button>
        </div>
      </div>
    </div>
  );
}
