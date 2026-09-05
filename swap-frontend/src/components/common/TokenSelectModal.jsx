import { useState, useMemo, useEffect, useCallback } from 'react';
import { X, Search, Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAddress } from 'viem';
import { useUiStore } from '@/store/uiStore.js';
import { TOKENS, HOT_TOKENS } from '@/config/index.js';
import { useWalletStore } from '@/store/walletStore.js';
import { usePrefsStore } from '@/store/prefsStore.js';
import { formatBalance, viemReadContract, isValidAddress } from '@/utils/index.js';
import { tokenIdOf, hasSymbolConflict, shortAddress, isStaticTokenAddress, tokenIconSrc } from '@/utils/tokens.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';

const TABS = [
  { key: 'hot', labelKey: 'hot_tokens' },
  { key: 'my', labelKey: 'my_tokens' },
];

// Token B selection whitelist: stablecoins + WBNB (allowed as the base pairing token for designated-pair mining)
const STABLECOIN_SYMBOLS = ['USDT', 'USDC', 'DAI', 'WBNB'];

export default function TokenSelectModal() {
  const { t } = useTranslation();
  const closeModal = () => useUiStore.getState().closeTokenSelectModal();
  const callback = useUiStore((s) => s.tokenSelectCallback);
  const tokenSelectFilter = useUiStore((s) => s.tokenSelectFilter);
  const stableOnly = tokenSelectFilter?.stableOnly === true;
  const showToast = useUiStore((s) => s.showToast);
  const {
    bnbBalance,
    cfoBalance,
    connected,
    tokenBalances: myTokenBalancesRaw,
    customTokens,
    importCustomToken,
    removeCustomToken,
    addRecentToken,
  } = useWalletStore();

  const {
    recentPairs,
    searchHistory,
    setSwapPair,
    setLiqPair,
    addSearchHistory,
    clearSearchHistory,
    removeRecentPair,
  } = usePrefsStore();
  const tokenSelectSide = useUiStore((s) => s.tokenSelectModalSide);

  const [tab, setTab] = useState('hot');
  const [query, setQuery] = useState('');

  // ====== D. 0x address query state (dynamic import for unlisted tokens) ======
  const [importLoading, setImportLoading] = useState(false);
  const [searchedToken, setSearchedToken] = useState(null); // {symbol,name,address,decimals} candidate found but not yet imported
  const [searchedErr, setSearchedErr] = useState('');

  const customTokenList = useMemo(() => Object.values(customTokens || {}), [customTokens]);

  const isStablecoin = useCallback((tok) => {
    return STABLECOIN_SYMBOLS.includes(tok?.symbol);
  }, []);

  const hotTokenList = useMemo(() => {
    let fromHot = HOT_TOKENS.map((sym) => TOKENS[sym]).filter(Boolean);
    if (stableOnly) {
      fromHot = fromHot.filter(isStablecoin);
    }
    // Custom tokens are never built-in hot tokens (keyed by address in store)
    let customAdded = customTokenList.filter(c => !isStaticTokenAddress(c.address));
    if (stableOnly) {
      customAdded = customAdded.filter(isStablecoin);
    }
    // User-imported tokens go first
    return [...customAdded, ...fromHot];
  }, [customTokenList, stableOnly, isStablecoin]);
  const allTokenList = useMemo(() => {
    let base = Object.values(TOKENS).filter(Boolean);
    // Dedup by contract address: imports duplicating built-in tokens are dropped at store level
    const baseAddrSet = new Set(base.map(t => t.address?.toLowerCase()).filter(Boolean));
    let added = customTokenList.filter(c => c.address && !baseAddrSet.has(c.address.toLowerCase()));
    if (stableOnly) {
      base = base.filter(isStablecoin);
      added = added.filter(isStablecoin);
    }
    // User-imported tokens go first
    return [...added, ...base];
  }, [customTokenList, stableOnly, isStablecoin]);

  // ====== D. When input is valid 0x address → query on-chain ERC20 name/symbol/decimals to generate non-imported candidate card ======
  useEffect(() => {
    const q = query.trim();
    setSearchedToken(null);
    setSearchedErr('');
    if (!q || !/^0x[a-fA-F0-9]{40}$/.test(q) || !isValidAddress(q)) return;
    const sameKnown = allTokenList.find(x => x.address.toLowerCase() === q.toLowerCase());
    if (sameKnown) return; // Already listed (in static TOKENS or customTokens), no need to query on-chain
    let cancelled = false;
    setImportLoading(true);
    (async () => {
      try {
        const erc20Abi = [
          { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
          { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
          { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
        ];
        const tokenAddr = getAddress(q);
        const [name, symbol, decimals] = await Promise.all([
          viemReadContract({ address: tokenAddr, abi: erc20Abi, functionName: 'name' }).catch(() => ''),
          viemReadContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }).catch(() => ''),
          viemReadContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
        ]);
        if (cancelled) return;
        if (!symbol || !name) {
          setSearchedErr('not_erc20_addr');
          return;
        }
        const candidate = {
          symbol: String(symbol),
          name: String(name),
          address: q,
          decimals: Number(decimals || 18),
          logoURI: '',
          isNative: false,
          _duplicateSymbol: hasSymbolConflict({ symbol, address: q }, customTokens),
        };
        if (stableOnly && !STABLECOIN_SYMBOLS.includes(candidate.symbol)) {
          setSearchedErr('not_stablecoin');
          return;
        }
        setSearchedToken(candidate);
      } catch (e) {
        console.warn('[TokenSelect] query chain token err:', e?.message || String(e));
        if (cancelled) return;
        setSearchedErr('chain_query_fail');
      } finally {
        if (!cancelled) setImportLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [query, allTokenList, customTokens, stableOnly]);

  const handleImport = useCallback(() => {
    if (!searchedToken) return;
    const ok = importCustomToken(searchedToken);
    if (!ok) {
      showToast && showToast('warning', 'token_symbol_exists');
      return;
    }
    // Add to recent tokens after successful import (id = lowercase address)
    try { addRecentToken && addRecentToken(tokenIdOf(searchedToken)); } catch (e) {}
    showToast && showToast('success', 'token_imported');
    setSearchedToken(null);
    setQuery('');
  }, [searchedToken, importCustomToken, addRecentToken, showToast]);

  const handleRemoveImported = useCallback((token) => {
    removeCustomToken(token?.address);
    showToast && showToast('info', 'custom_token_removed');
  }, [removeCustomToken, showToast]);

  const filteredTokens = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = tab === 'hot' ? hotTokenList : allTokenList;
    if (q) {
      list = list.filter((token) => (
        token.symbol.toLowerCase().includes(q) ||
        token.name.toLowerCase().includes(q) ||
        token.address.toLowerCase().includes(q)
      ));
    }
    // 'my' tab: tokens with balance first, zero-balance last
    if (tab === 'my' && connected) {
      const getBal = (token) => {
        const id = tokenIdOf(token);
        if (id === 'BNB') return bnbBalance;
        if (id === 'CFO') return cfoBalance;
        return myTokenBalancesRaw?.[id] || '0';
      };
      const sortFn = (a, b) => {
        const aBal = parseFloat(getBal(a) || '0');
        const bBal = parseFloat(getBal(b) || '0');
        if (aBal > 0 && bBal <= 0) return -1;
        if (aBal <= 0 && bBal > 0) return 1;
        if (aBal === bBal) return 0;
        return aBal > bBal ? -1 : 1;
      };
      list = [...list].sort(sortFn);
    }
    return list;
  }, [tab, query, hotTokenList, allTokenList, connected, bnbBalance, cfoBalance, myTokenBalancesRaw]);

  const renderTokenBalance = (token) => {
    if (!connected) return '0.00';
    const id = tokenIdOf(token);
    let bal = '0';
    if (id === 'BNB') bal = bnbBalance;
    else if (id === 'CFO') bal = cfoBalance;
    else bal = myTokenBalancesRaw?.[id] || '0';
    return formatBalance(bal, 4);
  };

  const isImported = (tok) => {
    return !!customTokens?.[String(tok?.address || '').toLowerCase()];
  };

  const handleSelect = (token) => {
    const id = tokenIdOf(token);
    if (!id) return;
    // Auto-add to recent token list on selection, visible in wallet
    try { addRecentToken && addRecentToken(id); } catch (e) {}
    // Record search term for quick recall next time
    if (query.trim()) { try { addSearchHistory(query.trim()); } catch (e) {}
    }
    // Resolve with token id (built-in symbol / custom lowercase address), then close
    if (callback && typeof callback === 'function') {
      try { callback(id); } catch (e) { console.error('[TokenSelect] callback error:', e); }
    }
    closeModal();
  };

  // Determine whether the current modal is for swap or liquidity: side 'from'/'to' = swap, 'A'/'B' = liquidity
  const isSwapSide = tokenSelectSide === 'from' || tokenSelectSide === 'to';

  // Click recent pair: one-click restore combination
  const applyRecentPair = (pair) => {
    if (!pair?.from || !pair?.to) return;
    try {
      if (isSwapSide) setSwapPair(pair.from, pair.to);
      else setLiqPair(pair.from, pair.to);
    } catch (e) {}
    closeModal();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fadeIn"
      onClick={(e) => {
        e.stopPropagation();
        closeModal();
      }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }}
      />

      <div
        className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-xl overflow-hidden animate-slideUp sm:animate-fadeIn flex flex-col max-h-[92dvh] sm:max-h-[600px]"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--gradient-surface)',
          border: '1px solid var(--color-border-default)',
          boxShadow: 'var(--modal-card-shadow)',
        }}
      >
        {/* Mobile drag handle */}
        <div className="sm:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full" style={{ background: 'var(--color-border-strong)' }} />
        </div>

        <div className="px-5 pt-4 pb-3 sm:p-5 border-b" style={{ borderColor: 'var(--color-border-default)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2
              className="text-lg font-bold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {stableOnly ? t('select_stablecoin') : t('select_token')}
            </h2>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeModal();
              }}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
              style={{
                color: 'var(--color-text-primary)',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-default)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-bg-tertiary)';
                e.currentTarget.style.color = 'var(--state-error)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-bg-secondary)';
                e.currentTarget.style.color = 'var(--color-text-primary)';
              }}
            >
              <X size={18} />
            </button>
          </div>

          <div className="relative mb-4">
            <Search
              size={18}
              className="absolute left-3.5 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--color-text-secondary)' }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('search_token')}
              className="w-full pl-10 pr-4 py-2.5 rounded-lg text-sm outline-none transition-colors placeholder:text-[color:var(--color-text-tertiary)]"
              style={{
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-primary)',
                border: query
                  ? '1px solid var(--state-info)'
                  : '1px solid var(--color-border-default)',
                boxShadow: query ? '0 0 0 3px rgba(59,130,246,.15)' : 'none',
              }}
            />
          </div>

          <div className="flex gap-1 p-1 rounded-lg border"
            style={{
              background: 'var(--color-bg-tertiary)',
              borderColor: 'var(--color-border-default)',
            }}
          >
            {TABS.map((item) => {
              const active = tab === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className="flex-1 py-2 rounded-md text-sm font-semibold transition-all"
                  style={{
                    color: active ? 'var(--color-text-inverse)' : 'var(--color-text-secondary)',
                    background: active ? 'var(--state-info)' : 'transparent',
                    border: active ? '1px solid var(--state-info)' : '1px solid transparent',
                    boxShadow: active ? '0 0 0 1px rgba(59,130,246,.35), 0 2px 8px rgba(59,130,246,.18)' : 'none',
                  }}
                >
                  {t(item.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar sm:max-h-[380px]">
          {/* ===== Recent pairs: one-click restore combination ===== */}
          {recentPairs?.length > 0 && (
            <div className="mx-3 mt-3 mb-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('recent_pairs') || 'Recent Pairs'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {recentPairs.map((p, idx) => (
                  <div
                    key={`${p.from}-${p.to}-${idx}`}
                    className="relative group pl-2.5 pr-1 py-1 rounded-full text-xs font-medium transition-colors flex items-center gap-1"
                    style={{
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border-default)',
                    }}
                  >
                    <button
                      onClick={() => applyRecentPair(p)}
                      className="flex items-center transition-colors pr-1"
                      onMouseEnter={(e) => {
                        const wrap = e.currentTarget.parentElement;
                        if (wrap) {
                          wrap.style.background = 'var(--state-info-bg)';
                          wrap.style.color = 'var(--state-info)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        const wrap = e.currentTarget.parentElement;
                        if (wrap) {
                          wrap.style.background = 'var(--color-bg-tertiary)';
                          wrap.style.color = 'var(--color-text-secondary)';
                        }
                      }}
                    >
                      {p.from} / {p.to}
                    </button>
                    <button
                      type="button"
                      aria-label="remove recent pair"
                      title={t('remove')}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        try { removeRecentPair && removeRecentPair(p.from, p.to); } catch (e2) {}
                      }}
                      className="flex-shrink-0 w-4.5 h-4.5 rounded-full flex items-center justify-center transition-colors"
                      style={{ color: 'var(--color-text-tertiary)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--state-error)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                    >
                      <X size={12} strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===== Recent search history: click to fill search box quickly ===== */}
          {searchHistory?.length > 0 && (
            <div className="mx-3 mt-3 mb-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('recent_searches') || 'Recent Searches'}
                </span>
                <button
                  onClick={() => { try { clearSearchHistory(); } catch (e) {} }}
                  className="text-[11px] transition-colors"
                  style={{ color: 'var(--color-text-tertiary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--state-error)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                  {t('clear') || 'Clear'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {searchHistory.map((s, idx) => (
                  <button
                    key={`${s}-${idx}`}
                    onClick={() => setQuery(s)}
                    className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                    style={{
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-border-default)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--state-info-bg)';
                      e.currentTarget.style.color = 'var(--state-info)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-bg-tertiary)';
                      e.currentTarget.style.color = 'var(--color-text-secondary)';
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ===== D. Non-imported candidate card from on-chain ERC20 lookup via 0x address (shown at top, with risk warning + import button) ===== */}
          {importLoading && (
            <div className="mx-3 mt-3 mb-2 p-3 rounded-xl flex items-center gap-3"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px dashed var(--color-border-strong)',
              }}
            >
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--state-info)' }} />
              <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                {t('querying_chain_token') || 'Querying token info from chain...'}
              </span>
            </div>
          )}
          {!importLoading && searchedErr && (
            <div className="mx-3 mt-3 mb-2 p-3 rounded-xl"
              style={{
                background: 'var(--state-error-bg)',
                border: '1px solid var(--state-error)',
                color: 'var(--state-error)',
              }}
            >
              <p className="text-sm">
                {searchedErr === 'not_erc20_addr'
                  ? (t('not_erc20_addr') || 'This address is not a valid ERC20 token.')
                  : searchedErr === 'not_stablecoin'
                  ? 'Only USDT / USDC / DAI stablecoins are supported'
                  : (t('chain_query_fail') || 'Failed to query token info from chain.')}
              </p>
            </div>
          )}
          {!importLoading && searchedToken && (
            <div className="mx-3 mt-3 mb-2 p-3 rounded-xl"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-default)',
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 flex items-center justify-center overflow-hidden flex-shrink-0"
                >
                  <TokenIcon src={tokenIconSrc(searchedToken)} symbol={searchedToken.symbol} size={40} />
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                      {searchedToken.symbol}
                    </span>
                    {searchedToken._duplicateSymbol && (
                      <span
                        className="text-[10px] font-numeric truncate"
                        style={{ color: 'var(--state-warning)' }}
                        title={searchedToken.address}
                      >
                        {shortAddress(searchedToken.address)}
                      </span>
                    )}
                  </div>
                  <span className="text-xs truncate block" style={{ color: 'var(--color-text-tertiary)' }}>
                    {searchedToken.name}
                  </span>
                  <span className="text-[11px] truncate block font-numeric" style={{ color: 'var(--color-text-tertiary)' }}>
                    {searchedToken.address}
                  </span>
                </div>
                <button
                  onClick={handleImport}
                  className="flex-shrink-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                  style={{
                    background: 'var(--gradient-primary)',
                    color: 'white',
                  }}
                >
                  <Plus size={14} />
                  {t('import_token') || 'Import'}
                </button>
              </div>
            </div>
          )}

          {filteredTokens.length === 0 && !importLoading && !searchedToken ? (
            <div className="py-16 text-center" style={{ color: 'var(--color-text-tertiary)' }}>
              <p className="text-sm">{t('no_tokens_found')}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
                {t('paste_contract_addr_tip') || 'Paste a token contract address (0x...) to import it'}
              </p>
            </div>
          ) : (
            <div className="p-2">
              {filteredTokens.map((token) => {
                const tid = tokenIdOf(token);
                const conflict = hasSymbolConflict(token, customTokens);
                return (
                <div
                  key={token.address}
                  className="w-full flex items-center gap-3 p-3 rounded-xl transition-colors"
                  style={{ color: 'inherit' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--state-info-bg)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <button
                    onClick={() => handleSelect(token)}
                    className="flex-1 flex items-center gap-3 min-w-0 text-left"
                    style={{ color: 'inherit' }}
                  >
                    <div
                      className="w-8 h-8 flex items-center justify-center overflow-hidden flex-shrink-0"
                    >
                      <TokenIcon src={tokenIconSrc(token)} symbol={token.symbol} size={32} />
                    </div>
                    <div className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-semibold truncate text-sm"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {token.symbol}
                        </span>
                        {conflict && (
                          <span
                            className="text-[10px] font-numeric truncate"
                            style={{ color: 'var(--color-text-tertiary)' }}
                            title={token.address}
                          >
                            {shortAddress(token.address)}
                          </span>
                        )}
                        {HOT_TOKENS.includes(tid) && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                            style={{
                              background: 'var(--state-warning-bg)',
                              color: 'var(--state-warning)',
                            }}
                          >
                            {t('hot_label')}
                          </span>
                        )}
                        {isImported(token) && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                            style={{
                              background: 'var(--state-success-bg)',
                              color: 'var(--state-success)',
                            }}
                          >
                            {t('custom_label') || 'IMPORTED'}
                          </span>
                        )}
                      </div>
                      <span
                        className="text-sm truncate block"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {token.name}
                      </span>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <span
                        className="text-sm font-medium font-numeric"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {renderTokenBalance(token)}
                      </span>
                    </div>
                  </button>
                  {isImported(token) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveImported(token);
                      }}
                      className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                      style={{ color: 'var(--color-text-tertiary)' }}
                      title={t('remove_custom_token') || 'Remove this imported token'}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--state-error-bg)';
                        e.currentTarget.style.color = 'var(--state-error)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-tertiary)';
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
