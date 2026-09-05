import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { formatUnits as viemFormatUnits, formatEther as viemFormatEther, parseEther, parseUnits as viemParseUnits, getAddress } from 'viem';
import { TOKENS, BSC_CHAIN_ID, BSC_CHAIN_ID_HEX, BSC_NETWORK, CFO_TOKEN_ADDRESS, WALLET_OPTIONS, PANCAKE_SWAP_ROUTER_V2, PANCAKE_ROUTER_ABI, WBNB_ADDRESS, USDT_ADDRESS, USDC_ADDRESS } from '@/config/index.js';
import { viemGetBalance, viemGetERC20Balance, viemFetchDecimals, viemReadContract } from '@/utils/index.js';
import { migrateCustomTokens, isStaticTokenAddress, resolveTokenById } from '@/utils/tokens.js';
import { useUiStore } from './uiStore.js';
import { usePoolsStore } from './poolsStore.js';
import { useLiquidityStore } from './liquidityStore.js';
import { useMiningStore } from './miningStore.js';

const shortAddr = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');

// Price lookup path configuration (module-level constants, initialized only once)
const _ROUTER_ADDR = getAddress(PANCAKE_SWAP_ROUTER_V2);
const _WBNB = getAddress(WBNB_ADDRESS);
const _USDT = getAddress(USDT_ADDRESS);
const _USDC = getAddress(USDC_ADDRESS);
const _CFO = getAddress(CFO_TOKEN_ADDRESS);
const _ONE_ETHER = parseEther('1');
const BALANCE_CACHE_TTL = 60_000; // Balance cache 60s, silently refresh when wallet opens after expiry
const PRICE_CACHE_TTL = 30_000;   // Price cache 30s

const getInjectedProvider = (walletId) => {
  if (typeof window === 'undefined') return null;
  const wallet = WALLET_OPTIONS.find((w) => w.id === walletId);
  if (!wallet) return null;
  if (wallet.injectedName && window[wallet.injectedName]) {
    return window[wallet.injectedName];
  }
  if (wallet.id === 'metamask' && window.ethereum) {
    if (window.ethereum.providers?.length) {
      return window.ethereum.providers.find((p) => p.isMetaMask) || window.ethereum;
    }
    return window.ethereum.isMetaMask ? window.ethereum : null;
  }
  if (wallet.id === 'binance' && window.BinanceChain) {
    return window.BinanceChain;
  }
  if (wallet.id === 'trustwallet' && window.ethereum?.isTrust) {
    return window.ethereum;
  }
  return null;
};

export const useWalletStore = create(
  persist(
    (set, get) => ({
      address: '',
      shortAddress: '',
      chainId: 0,
      chainName: '',
      connected: false,
      connecting: false,
      walletId: '',
      bnbBalance: '0',
      cfoBalance: '0',
      tokenBalances: {}, // { [tokenId]: formatted human-readable numeric string }, id = symbol for built-in tokens, lowercase address for custom tokens
      loadingBalances: false,
      // ====== Token USD price cache (cached in memory, not persisted to localStorage to avoid stale prices after restart) ======
      tokenPrices: {}, // { [tokenId]: usd price number }
      loadingPrices: false,
      lastBalancesUpdateAt: 0, // Last balance update timestamp (ms)
      lastPricesUpdateAt: 0,   // Last price update timestamp (ms)
      // ====== Custom imported tokens (user imports after searching 0x contract address from TokenSelectModal), permanently persisted (only public chain info stored) ======
      // Keyed by lowercase contract address so same-symbol contracts (e.g. redeployed CFO) coexist; see utils/tokens.js
      customTokens: {}, // { [addressLower]: { symbol, name, address, decimals, logoURI, isNative:false, importedAt:ts } }
      // ====== Recently selected/used tokens (auto-recorded when user selects on Swap/other pages), shown in wallet, persisted; entries are token ids ======
      recentTokens: ['WBNB', 'USDT'], // Two common tokens added by default, others auto-appended when user selects
      // ====== Runtime decimals read from chain (trust chain only, override config; keyed by lowercase address, persisted to avoid repeated queries) ======
      decimalsOverride: {}, // { [addressLower]: decimals }

      // ====== D. Import custom token (validate address + read name/symbol/decimals from chain then write to store) ======
      // Uniqueness is determined by contract address: same-symbol tokens at different addresses coexist.
      importCustomToken: (token) => {
        if (!token?.symbol || !token?.address) return false;
        const key = String(token.address).toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(key)) return false;
        if (isStaticTokenAddress(key)) return false; // Built-in token, no need to import
        const existing = get().customTokens || {};
        if (existing[key]) return false; // Same address already imported
        const clean = {
          symbol: String(token.symbol),
          name: String(token.name || token.symbol),
          address: String(token.address),
          decimals: Number(token.decimals || 18),
          logoURI: token.logoURI || '',
          isNative: false,
          importedAt: Date.now(),
        };
        set({ customTokens: { ...existing, [key]: clean } });
        // Silently refresh balances after successful import so new token balance is immediately visible on all pages
        (async () => {
          try { await get().loadBalances({ silent: true }); }
          catch (e) { console.warn('[importCustomToken] loadBalances err:', e); }
        })();
        return true;
      },

      // Remove custom token by contract address (or token id); unknown ids are ignored
      removeCustomToken: (id) => {
        if (!id) return;
        const existing = { ...(get().customTokens || {}) };
        const key = String(id).toLowerCase();
        if (existing[key]) {
          delete existing[key];
          set({ customTokens: existing });
          return;
        }
        // Tolerate legacy callers passing a symbol: remove every entry whose address matches
        let changed = false;
        for (const [k, t] of Object.entries(existing)) {
          if (String(t?.address || '').toLowerCase() === key) {
            delete existing[k];
            changed = true;
          }
        }
        if (changed) set({ customTokens: existing });
      },

      // ====== Write chain-read decimals (keyed by lowercase address, idempotent overwrite, persisted) ======
      setTokenDecimals: (address, decimals) => {
        if (!address || decimals == null) return;
        const val = Number(decimals);
        if (!Number.isFinite(val) || val < 0 || val > 30) return;
        const key = address.toLowerCase();
        const existing = get().decimalsOverride || {};
        if (existing[key] === val) return;
        set({ decimalsOverride: { ...existing, [key]: val } });
      },

      // ====== Record user-selected tokens, auto-add to wallet asset list (dedup, keep max 20, most recent first) ======
      addRecentToken: (sym) => {
        if (!sym || sym === 'BNB' || sym === 'CFO') return;
        const list = get().recentTokens || [];
        const filtered = list.filter((s) => s !== sym);
        const next = [sym, ...filtered].slice(0, 20);
        set({ recentTokens: next });
      },

      connectWallet: async (walletId) => {
        set({ connecting: true });
        try {
          const wallet = WALLET_OPTIONS.find((w) => w.id === walletId);
          if (!wallet) throw new Error('Unknown wallet');

          let injected;
          if (walletId === 'walletconnect') {
            console.warn('[Wallet] WalletConnect not implemented yet');
            throw new Error('WalletConnect not implemented');
          } else {
            injected = getInjectedProvider(walletId);
            if (!injected) {
              const errMap = {
                okx: 'install_okx',
                metamask: 'install_metamask',
                binance: 'install_binance_wallet',
                trustwallet: 'install_wallet_generic',
              };
              useUiStore.getState().showToast('error', errMap[walletId] || 'no_wallet_detected');
              throw new Error('Wallet not detected');
            }
          }

          // Use EIP-1193 provider directly, no ethers needed
          const accounts = await injected.request({ method: 'eth_requestAccounts' });
          const address = accounts[0];
          const chainIdHex = await injected.request({ method: 'eth_chainId' });
          const chainId = parseInt(chainIdHex, 16);

          set({
            address,
            shortAddress: shortAddr(address),
            chainId,
            chainName: chainId === BSC_CHAIN_ID ? 'BSC Mainnet' : `Chain ${chainId}`,
            connected: true,
            connecting: false,
            walletId,
          });

          if (chainId !== BSC_CHAIN_ID) {
            try {
              await get().switchNetwork();
            } catch (e) {
              useUiStore.getState().showToast('warning', 'switch_network_manually');
            }
          } else {
            await get().loadBalances();
          }

          useUiStore.getState().hideWalletModal();
          useUiStore.getState().showToast('success', 'wallet_connected');

          if (injected && typeof injected.on === 'function') {
            injected.on('accountsChanged', (accounts) => {
              if (!accounts || accounts.length === 0) {
                get().disconnectWallet();
              } else {
                const newAddr = accounts[0];
                set({
                  address: newAddr,
                  shortAddress: shortAddr(newAddr),
                });
                get().loadBalances();
              }
            });
            injected.on('chainChanged', (hexId) => {
              const newChainId = parseInt(hexId, 16);
              set({
                chainId: newChainId,
                chainName: newChainId === BSC_CHAIN_ID ? 'BSC Mainnet' : `Chain ${newChainId}`,
              });
              if (newChainId === BSC_CHAIN_ID) {
                get().loadBalances();
              }
            });
            injected.on('disconnect', () => {
              get().disconnectWallet();
            });
          }
        } catch (e) {
          console.error('[Wallet] Connect failed:', e);
          if (e?.code === 4001 || e?.message?.includes('rejected')) {
            useUiStore.getState().showToast('error', 'user_rejected_connect');
          } else if (e.message !== 'Wallet not detected') {
            useUiStore.getState().showToast('error', 'connect_failed');
          }
          set({ connecting: false });
        }
      },

      switchNetwork: async () => {
        const { walletId } = get();
        const injected = getInjectedProvider(walletId);
        if (!injected) throw new Error('No provider');
        try {
          await injected.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: BSC_CHAIN_ID_HEX }],
          });
          useUiStore.getState().showToast('success', 'network_switched');
          // Actively refresh balances after successful network switch (some wallets don't trigger chainChanged, fallback)
          setTimeout(() => {
            try { get().loadBalances(); } catch (e) { console.warn('[switchNetwork] loadBalances err:', e); }
          }, 500);
          return true;
        } catch (switchError) {
          if (switchError.code === 4902) {
            try {
              await injected.request({
                method: 'wallet_addEthereumChain',
                params: [BSC_NETWORK],
              });
              useUiStore.getState().showToast('success', 'network_switched');
              // Also refresh balances after successfully adding network
              setTimeout(() => {
                try { get().loadBalances(); } catch (e) { console.warn('[switchNetwork] loadBalances err:', e); }
              }, 500);
              return true;
            } catch (addError) {
              throw addError;
            }
          }
          throw switchError;
        }
      },

      loadBalances: async (options = {}) => {
        const { silent = false } = options;
        const { address, connected } = get();
        if (!address || !connected) return;
        if (!silent) set({ loadingBalances: true });
        try {
          const chainId = get().chainId;
          if (chainId !== BSC_CHAIN_ID) {
            if (!silent) set({ loadingBalances: false });
            return;
          }

          let bnbBal = 0n;
          let cfoBal = 0n;
          const { customTokens, decimalsOverride } = get();

          // BNB balance
          try {
            bnbBal = await viemGetBalance(address);
          } catch (e) {
            console.warn('[Wallet][viem] BNB balance failed:', e?.shortMessage || e?.message);
          }

          // CFO balance
          try {
            const rawCfo = await viemGetERC20Balance(CFO_TOKEN_ADDRESS, address);
            cfoBal = rawCfo;
          } catch (e) {
            console.warn('[Wallet][viem] CFO balance failed:', e?.shortMessage || e?.message);
          }

          // Other ERC20 tokens. Ids: built-in symbol or custom lowercase address;
          // BNB / CFO are handled above via dedicated balance reads.
          const mergedIds = new Set();
          Object.keys(TOKENS).forEach((s) => { if (s && s !== 'BNB' && s !== 'CFO') mergedIds.add(s); });
          Object.keys(customTokens || {}).forEach((id) => { if (id) mergedIds.add(id); });
          (get().recentTokens || []).forEach((id) => { if (id && id !== 'BNB' && id !== 'CFO') mergedIds.add(id); });
          const balancesDict = {};

          await Promise.all(
            Array.from(mergedIds).map(async (id) => {
              const tok = resolveTokenById(id, customTokens);
              if (!tok?.address || tok.isNative) return;
              try {
                let dec = decimalsOverride?.[tok.address.toLowerCase()];
                if (dec == null) {
                  dec = await viemFetchDecimals(tok.address);
                  get().setTokenDecimals(tok.address, dec);
                }
                const raw = await viemGetERC20Balance(tok.address, address);
                balancesDict[id] = viemFormatUnits(raw, dec);
              } catch (e) {
                balancesDict[id] = '0';
                console.warn(`[Wallet][viem] ERC20 ${id} balance failed:`, e?.message || String(e));
              }
            })
          );

          set({
            bnbBalance: viemFormatEther(bnbBal || 0n),
            cfoBalance: viemFormatEther(cfoBal || 0n),
            tokenBalances: balancesDict,
            loadingBalances: false,
            lastBalancesUpdateAt: Date.now(),
          });

          // Auto-refresh prices after balance update (silent)
          try {
            await get().fetchTokenPrices({ silent: true });
          } catch (_) {}
        } catch (e) {
          console.error('[Wallet][viem] Load balances failed:', e);
          if (!silent) set({ loadingBalances: false });
        }
      },

      // Contract read with timeout (internal method)
      _readContractWithTimeout: (params, timeoutMs = 8000) => {
        return Promise.race([
          viemReadContract(params),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
        ]);
      },

      // Fetch token USD prices
      fetchTokenPrices: async (options = {}) => {
        const { silent = false } = options;
        const s = get();
        if (!s.connected || !s.address) return s.tokenPrices || {};
        if (!silent) set({ loadingPrices: true });
        const result = { USDT: 1, USDC: 1, BUSD: 1, DAI: 1 };
        try {
          const { customTokens, bnbBalance, cfoBalance, tokenBalances } = s;

          // 1. Get BNB price (WBNB→USDT)
          let bnbUsd = 0;
          try {
            const amounts = await get()._readContractWithTimeout({
              address: _ROUTER_ADDR,
              abi: PANCAKE_ROUTER_ABI,
              functionName: 'getAmountsOut',
              args: [_ONE_ETHER, [_WBNB, _USDT]],
            });
            bnbUsd = parseFloat(viemFormatUnits(amounts[1], 18));
            if (!isNaN(bnbUsd) && bnbUsd > 0) {
              result['BNB'] = bnbUsd;
              result['WBNB'] = bnbUsd;
            }
          } catch (e) {
            console.warn('[Wallet] get BNB price failed:', e?.shortMessage || e?.message);
          }

          // 2. Collect list of tokens needing price lookup
          const needQuery = new Set();
          needQuery.add('CFO');
          needQuery.add('ETH');
          if (parseFloat(bnbBalance || '0') > 0) needQuery.add('BNB');
          Object.entries(tokenBalances || {}).forEach(([sym, b]) => {
            if (parseFloat(b || '0') > 0 && !['USDT', 'USDC', 'BUSD', 'DAI'].includes(sym)) needQuery.add(sym);
          });

          // 3. Query single token price (multi-path fallback)
          // id is a built-in symbol or a custom token's lowercased address
          const getDecimals = (id) => {
            if (id === 'CFO') return 18;
            const tok = resolveTokenById(id, customTokens);
            if (!tok?.address) return 18;
            const ov = s.decimalsOverride?.[tok.address.toLowerCase()];
            return ov != null ? Number(ov) : 18;
          };

          const getTokenAddr = (id) => {
            if (id === 'CFO') return _CFO;
            const tok = resolveTokenById(id, customTokens);
            if (!tok?.address) return null;
            return getAddress(tok.isNative ? WBNB_ADDRESS : tok.address);
          };

          async function getSinglePrice(sym) {
            if (result[sym] != null) return result[sym];
            try {
              const tokenAddr = getTokenAddr(sym);
              if (!tokenAddr) return null;
              const decimals = getDecimals(sym);
              const amountIn = viemParseUnits('1', decimals);

              const pathCandidates = [
                [tokenAddr, _USDT],
                [tokenAddr, _USDC],
                [tokenAddr, _WBNB, _USDT],
                [tokenAddr, _WBNB, _USDC],
              ];

              for (const path of pathCandidates) {
                try {
                  const amounts = await get()._readContractWithTimeout({
                    address: _ROUTER_ADDR,
                    abi: PANCAKE_ROUTER_ABI,
                    functionName: 'getAmountsOut',
                    args: [amountIn, path],
                  }, 6000);
                  const outAmt = amounts[amounts.length - 1];
                  const usdVal = parseFloat(viemFormatUnits(outAmt, 18));
                  if (!isNaN(usdVal) && usdVal > 0) return usdVal;
                } catch (_) {}
              }

              if (bnbUsd > 0) {
                try {
                  const amounts = await get()._readContractWithTimeout({
                    address: _ROUTER_ADDR,
                    abi: PANCAKE_ROUTER_ABI,
                    functionName: 'getAmountsOut',
                    args: [amountIn, [tokenAddr, _WBNB]],
                  }, 6000);
                  const bnbAmt = parseFloat(viemFormatUnits(amounts[1], 18));
                  if (!isNaN(bnbAmt) && bnbAmt > 0) return bnbAmt * bnbUsd;
                } catch (_) {}
              }
            } catch (e) {
              console.warn(`[Wallet] get ${sym} price failed:`, e?.shortMessage || e?.message);
            }
            return null;
          }

          const priceResults = await Promise.all(Array.from(needQuery).map(sym => getSinglePrice(sym)));
          Array.from(needQuery).forEach((sym, i) => {
            const p = priceResults[i];
            if (p != null && p > 0) result[sym] = p;
          });

          set({
            tokenPrices: result,
            loadingPrices: false,
            lastPricesUpdateAt: Date.now(),
          });
        } catch (e) {
          console.warn('[Wallet] fetch prices error:', e?.shortMessage || e?.message);
          if (!silent) set({ loadingPrices: false });
        }
        return result;
      },

      // User manual refresh (shows loading)
      refreshBalances: async () => {
        await get().loadBalances({ silent: false });
      },

      // Called when opening wallet: silently refresh in background if cache expired (no loading shown)
      maybeSilentRefresh: () => {
        const { connected, address, lastBalancesUpdateAt, lastPricesUpdateAt } = get();
        if (!connected || !address) return;
        const now = Date.now();
        const balanceExpired = now - lastBalancesUpdateAt > BALANCE_CACHE_TTL;
        const priceExpired = now - lastPricesUpdateAt > PRICE_CACHE_TTL;
        // If balances never loaded (lastBalancesUpdateAt=0), show loading; otherwise silently refresh if expired
        if (lastBalancesUpdateAt === 0 || balanceExpired) {
          get().loadBalances({ silent: lastBalancesUpdateAt > 0 });
        } else if (priceExpired) {
          // Balances are fresh but prices expired, only silently refresh prices
          get().fetchTokenPrices({ silent: true });
        }
      },

      disconnectWallet: () => {
        // Idempotency guard: don't repeat if already disconnected, avoid duplicate toast from double event trigger
        if (!get().connected) return;
        const { walletId } = get();
        const injected = getInjectedProvider(walletId);
        if (injected && typeof injected.removeListener === 'function') {
          try {
            injected.removeAllListeners?.('accountsChanged');
            injected.removeAllListeners?.('chainChanged');
            injected.removeAllListeners?.('disconnect');
          } catch (e) {}
        }
        set({
          address: '',
          shortAddress: '',
          chainId: 0,
          chainName: '',
          connected: false,
          connecting: false,
          walletId: '',
          bnbBalance: '0',
          cfoBalance: '0',
          tokenBalances: {},
          loadingBalances: false,
          tokenPrices: {},
          loadingPrices: false,
          lastBalancesUpdateAt: 0,
          lastPricesUpdateAt: 0,
        });
        // Clear user-related caches from other stores
        try { usePoolsStore.getState().clearPoolsUserData(); } catch (e) {}
        try { useLiquidityStore.getState().clearPositions(); } catch (e) {}
        try { useMiningStore.getState().clearUserData(); } catch (e) {}
        // Shared-device hardening: explicitly wipe persisted localStorage keys so next visitor on public PC sees no trace
        try {
          localStorage.removeItem('cfoswap-wallet');
          localStorage.removeItem('cfoswap-pools');
          localStorage.removeItem('cfoswap-liquidity');
          localStorage.removeItem('cfoswap-mining');
        } catch (e) {}
        useUiStore.getState().showToast('info', 'wallet_disconnected');
      },

      setAddress: (a) => set({ address: a, shortAddress: shortAddr(a) }),

      // ====== Auto-reconnect after page refresh: persist restored connected/address/walletId but provider instance lost, auto-recreate ======
      reconnectOnRefresh: async () => {
        const { connected, walletId, address } = get();
        if (!connected || !walletId || !address) return;
        try {
          const injected = getInjectedProvider(walletId);
          if (!injected) return;
          // Check if wallet still authorizes current account
          const accounts = await injected.request?.({ method: 'eth_accounts' }).catch(() => []);
          if (!accounts || !accounts.length || !accounts.map(a => a.toLowerCase()).includes(address.toLowerCase())) {
            // Wallet already disconnected/account switched, reset state
            get().disconnectWallet();
            return;
          }
          // Get current chain ID
          const chainIdHex = await injected.request({ method: 'eth_chainId' });
          const chainId = parseInt(chainIdHex, 16);
          set({
            chainId,
            chainName: chainId === BSC_CHAIN_ID ? 'BSC Mainnet' : `Chain ${chainId}`,
          });
          // Re-register event listeners
          if (typeof injected.on === 'function') {
            injected.on('accountsChanged', (accts) => {
              if (!accts || accts.length === 0) {
                get().disconnectWallet();
              } else {
                const newAddr = accts[0];
                set({ address: newAddr, shortAddress: shortAddr(newAddr) });
                get().loadBalances();
              }
            });
            injected.on('chainChanged', (hexId) => {
              const newChainId = parseInt(hexId, 16);
              set({
                chainId: newChainId,
                chainName: newChainId === BSC_CHAIN_ID ? 'BSC Mainnet' : `Chain ${newChainId}`,
              });
              if (newChainId === BSC_CHAIN_ID) get().loadBalances();
            });
            injected.on('disconnect', () => get().disconnectWallet());
          }
          // On BSC chain, silently refresh balances (prefer cache, only background refresh if expired)
          if (chainId === BSC_CHAIN_ID) {
            get().maybeSilentRefresh();
          }
        } catch (e) {
          console.warn('[Wallet] reconnectOnRefresh failed:', e?.message || String(e));
        }
      },

      // Backward compatible with old code, keep getSigner/getProvider but return null (no longer used)
      getSigner: () => null,
      getProvider: () => null,
    }),
    {
      name: 'cfoswap-wallet',
      // Legacy customTokens were keyed by symbol; migrate them uniformly to lowercased-address keys on rehydrate
      merge: (persistedState, currentState) => {
        const p = persistedState && typeof persistedState === 'object' ? persistedState : {};
        return {
          ...currentState,
          ...p,
          customTokens: migrateCustomTokens(p.customTokens),
        };
      },
      partialize: (s) => ({
        address: s.address,
        chainId: s.chainId,
        connected: s.connected,
        walletId: s.walletId,
        // Persist balances (show last data instantly after page refresh, background silently refresh latest values)
        bnbBalance: s.bnbBalance || '0',
        cfoBalance: s.cfoBalance || '0',
        tokenBalances: s.tokenBalances || {},
        lastBalancesUpdateAt: s.lastBalancesUpdateAt || 0,
        // Persist customTokens (permanently kept in localStorage, valid across refreshes)
        customTokens: s.customTokens || {},
        // Persist recently selected tokens (auto-shown in wallet)
        recentTokens: Array.isArray(s.recentTokens) && s.recentTokens.length ? s.recentTokens : ['WBNB', 'USDT'],
        // Persist chain-read decimals (valid across refreshes, avoid repeated queries)
        decimalsOverride: s.decimalsOverride || {},
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.address) state.shortAddress = shortAddr(state.address);
      },
    }
  )
);
