import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TX_DEADLINE_MINUTES, DEFAULT_SLIPPAGE } from '@/config/index.js';

// ========== Hard safety bounds — tamper-proof clamp layer for localStorage / UI bypass ==========
//   Slippage 0%  → attacker can sandwich without any price movement tolerance; 100% → minOut = 0, drainable
//   Deadline <2min → too short, user reverts due to slow signing; >60min → huge MEV searcher window
const MIN_SLIPPAGE_BPS = 1;
const MAX_SLIPPAGE_BPS = 5000;
const MIN_TX_DEADLINE_MIN = 2;
const MAX_TX_DEADLINE_MIN = 60;
const _clampSlippageBps = (raw) => {
  const n = Number(raw);
  const v = isNaN(n) ? DEFAULT_SLIPPAGE : n;
  return Math.min(Math.max(MIN_SLIPPAGE_BPS, Math.round(v)), MAX_SLIPPAGE_BPS);
};
const _clampDeadlineMin = (raw) => {
  const n = Number(raw);
  const v = isNaN(n) ? TX_DEADLINE_MINUTES : n;
  return Math.min(Math.max(MIN_TX_DEADLINE_MIN, Math.round(v)), MAX_TX_DEADLINE_MIN);
};

let toastIdCounter = 0;

// Strict whitelist: only persist these 3 fields, preventing stale values from old localStorage from causing modals to open by default
const PERSIST_WHITELIST = new Set(['slippageBps', 'txDeadlineMinutes', 'language']);

export const useUiStore = create(
  persist(
    (set, get) => ({
      // ========== Wallet Modal (two-field sync: Visible + Open) ==========
      walletModalVisible: false,
      walletModalOpen: false,
      showWalletModal: () => set({ walletModalVisible: true, walletModalOpen: true }),
      openWalletModal: () => set({ walletModalVisible: true, walletModalOpen: true }), // Alias for backward compatibility with Navbar/admin legacy code
      hideWalletModal: () => set({ walletModalVisible: false, walletModalOpen: false }),
      setWalletModalVisible: (v) => set({ walletModalVisible: !!v, walletModalOpen: !!v }),
      closeWalletModal: () => set({ walletModalVisible: false, walletModalOpen: false }),

      // ========== Slippage Drawer (Visible + Open, slippage/txDeadline compatible) ==========
      slippageDrawerVisible: false,
      slippageDrawerOpen: false,
      slippageBps: DEFAULT_SLIPPAGE,
      slippage: DEFAULT_SLIPPAGE,
      txDeadlineMinutes: TX_DEADLINE_MINUTES,
      txDeadline: TX_DEADLINE_MINUTES,
      showSlippageDrawer: () => set({ slippageDrawerVisible: true, slippageDrawerOpen: true }),
      hideSlippageDrawer: () => set({ slippageDrawerVisible: false, slippageDrawerOpen: false }),
      setSlippageDrawerVisible: (v) => set({ slippageDrawerVisible: !!v, slippageDrawerOpen: !!v }),
      closeSlippageDrawer: () => set({ slippageDrawerVisible: false, slippageDrawerOpen: false }),
      setSlippageBps: (bps) => {
        const v = _clampSlippageBps(bps);
        set({ slippageBps: v, slippage: v });
      },
      setSlippage: (bps) => {
        const v = _clampSlippageBps(bps);
        set({ slippageBps: v, slippage: v });
      },
      setTxDeadlineMinutes: (min) => {
        const v = _clampDeadlineMin(min);
        set({ txDeadlineMinutes: v, txDeadline: v });
      },
      setTxDeadline: (min) => {
        const v = _clampDeadlineMin(min);
        set({ txDeadlineMinutes: v, txDeadline: v });
      },

      // ========== Toast ==========
      toasts: [],
      showToast: (type = 'info', message, duration = 3500) => {
        const id = ++toastIdCounter;
        // Production security: never expose raw EVM revert reason / hex calldata to end user (info leak + confuse non-technical users)
        let safeMessage = message;
        if (type === 'error' && typeof message === 'string' && !import.meta.env.DEV) {
          const hasLongHex = /0x[0-9a-fA-F]{20,}/.test(message);
          const isTooLong = message.length > 150;
          const hasReverted = /reverted|execution reverted|out of gas|insufficient funds/i.test(message);
          if (hasLongHex || isTooLong || hasReverted) {
            safeMessage = 'tx_failed';
          }
        }
        const toast = { id, type, message: safeMessage, createdAt: Date.now() };
        set((state) => ({ toasts: [...state.toasts, toast] }));
        if (duration > 0) {
          setTimeout(() => {
            try { get().dismissToast(id); } catch (e) {}
          }, duration);
        }
        return id;
      },
      dismissToast: (id) => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      },
      clearToasts: () => set({ toasts: [] }),

      // ========== Boost Modal (dual fields + dual address aliases) ==========
      boostModalVisible: false,
      boostModalOpen: false,
      boostModalPoolAddress: '',
      boostPoolAddress: '',
      showBoostModal: (poolAddress = '') => set({
        boostModalVisible: true, boostModalOpen: true,
        boostModalPoolAddress: poolAddress, boostPoolAddress: poolAddress,
      }),
      hideBoostModal: () => set({
        boostModalVisible: false, boostModalOpen: false,
        boostModalPoolAddress: '', boostPoolAddress: '',
      }),
      setBoostModalVisible: (v, poolAddress = '') => set({
        boostModalVisible: !!v, boostModalOpen: !!v,
        boostModalPoolAddress: v ? poolAddress : '', boostPoolAddress: v ? poolAddress : '',
      }),
      closeBoostModal: () => set({
        boostModalVisible: false, boostModalOpen: false,
        boostModalPoolAddress: '', boostPoolAddress: '',
      }),

      // ========== Token Select Modal (dual fields + dual callback aliases) ==========
      tokenSelectModalVisible: false,
      tokenSelectModalOpen: false,
      tokenSelectModalSide: 'pay',
      tokenSelectModalCallback: null,
      tokenSelectCallback: null,
      tokenSelectFilter: null, // { stableOnly?: boolean }
      openTokenSelectModal: (side = 'pay', callback = null, filter = null) => set({
        tokenSelectModalVisible: true, tokenSelectModalOpen: true,
        tokenSelectModalSide: side,
        tokenSelectModalCallback: callback, tokenSelectCallback: callback,
        tokenSelectFilter: filter,
      }),
      closeTokenSelectModal: () => set({
        tokenSelectModalVisible: false, tokenSelectModalOpen: false,
        tokenSelectModalSide: 'pay',
        tokenSelectModalCallback: null, tokenSelectCallback: null,
        tokenSelectFilter: null,
      }),
      resolveTokenSelect: (token) => {
        const cb = get().tokenSelectModalCallback;
        if (typeof cb === 'function') {
          try { cb(token); } catch (e) { console.error('[UI] Token select callback error:', e); }
        }
        get().closeTokenSelectModal();
      },
      setTokenSelectModalVisible: (v, side = 'pay', callback = null, filter = null) => {
        if (v) {
          set({
            tokenSelectModalVisible: true, tokenSelectModalOpen: true,
            tokenSelectModalSide: side,
            tokenSelectModalCallback: callback, tokenSelectCallback: callback,
            tokenSelectFilter: filter,
          });
        } else {
          get().closeTokenSelectModal();
        }
      },

      // ========== Language ==========
      language: (typeof window !== 'undefined' ? localStorage.getItem('cfoswap_lang') : null) || 'zh-CN',
      setLanguage: (lang) => {
        try {
          if (typeof window !== 'undefined') localStorage.setItem('cfoswap_lang', lang);
        } catch (e) { /* In privacy mode / quota exceeded, the setting only takes effect in memory */ }
        set({ language: lang });
      },
    }),
    {
      name: 'cfoswap-ui',
      // Strict whitelist: do not store or restore anything except slippageBps / txDeadlineMinutes / language
      partialize: (state) => {
        const out = {};
        PERSIST_WHITELIST.forEach((k) => { if (k in state) out[k] = state[k]; });
        return out;
      },
      // Force reset all modal fields to false after rehydration (protects against old localStorage pollution)
      onRehydrateStorage: () => (restoredState) => {
        if (!restoredState) return;
        try {
          restoredState.walletModalVisible = false;
          restoredState.walletModalOpen = false;
          restoredState.slippageDrawerVisible = false;
          restoredState.slippageDrawerOpen = false;
          restoredState.boostModalVisible = false;
          restoredState.boostModalOpen = false;
          restoredState.tokenSelectModalVisible = false;
          restoredState.tokenSelectModalOpen = false;
          restoredState.boostModalPoolAddress = '';
          restoredState.boostPoolAddress = '';
          restoredState.tokenSelectModalCallback = null;
          restoredState.tokenSelectCallback = null;
          restoredState.toasts = [];
        } catch (e) { /* noop */ }
      },
      // Backward compatibility: filter out non-whitelist fields before merging to prevent stale values
      merge: (persistedState, currentState) => {
        const safe = {};
        if (persistedState && typeof persistedState === 'object') {
          PERSIST_WHITELIST.forEach((k) => {
            if (k in persistedState) safe[k] = persistedState[k];
          });
        }
        return { ...currentState, ...safe };
      },
      version: 2, // Bump version: old persisted cache is directly ignored
    }
  )
);
