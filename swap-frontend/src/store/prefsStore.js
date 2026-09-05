import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ====== User preferences persistence: remember current pair / search history / recent pairs, persist across pages and refreshes ======
const PREFS_KEY = 'cfoswap_prefs';
const MAX_RECENT_PAIRS = 8;
const MAX_SEARCH_HISTORY = 10;

export const usePrefsStore = create(
  persist(
    (set, get) => ({
      // Currently selected trading pair (swap page)
      swapPair: { from: 'BNB', to: 'USDT' },
      // Currently selected trading pair (liquidity page)
      liqPair: { tokenA: 'BNB', tokenB: 'USDT' },
      // List of recently selected pairs [{ from, to }]
      recentPairs: [],
      // Recent token search history (deduplicated string array)
      searchHistory: [],

      // ====== Set swap trading pair and write to recent list ======
      setSwapPair: (from, to) => {
        if (!from || !to || from === to) return;
        set({ swapPair: { from, to } });
        get().addRecentPair(from, to);
      },

      // ====== Set liquidity trading pair and write to recent list ======
      setLiqPair: (tokenA, tokenB) => {
        if (!tokenA || !tokenB || tokenA === tokenB) return;
        set({ liqPair: { tokenA, tokenB } });
        get().addRecentPair(tokenA, tokenB);
      },

      // ====== Record recent pairs (dedup, most recent first, keep max MAX_RECENT_PAIRS) ======
      addRecentPair: (from, to) => {
        if (!from || !to || from === to) return;
        const list = get().recentPairs || [];
        const filtered = list.filter((p) => !(p.from === from && p.to === to));
        const next = [{ from, to }, ...filtered].slice(0, MAX_RECENT_PAIRS);
        set({ recentPairs: next });
      },

      // ====== Remove recent pair (called when user clicks × button at card top-right) ======
      removeRecentPair: (from, to) => {
        if (!from && !to) return;
        const list = get().recentPairs || [];
        // Match rule symmetric to addRecentPair: only delete if from===from AND to===to
        const filtered = list.filter((p) => !(p.from === from && p.to === to));
        set({ recentPairs: filtered });
      },

      // ====== Record search history (dedup, most recent first, keep max MAX_SEARCH_HISTORY) ======
      addSearchHistory: (q) => {
        const word = String(q || '').trim();
        if (!word) return;
        const list = get().searchHistory || [];
        const filtered = list.filter((s) => s !== word);
        const next = [word, ...filtered].slice(0, MAX_SEARCH_HISTORY);
        set({ searchHistory: next });
      },

      // ====== Clear search history ======
      clearSearchHistory: () => set({ searchHistory: [] }),
    }),
    {
      name: PREFS_KEY,
      // Only persist data fields, ignore actions
      partialize: (state) => ({
        swapPair: state.swapPair,
        liqPair: state.liqPair,
        recentPairs: state.recentPairs,
        searchHistory: state.searchHistory,
      }),
    }
  )
);