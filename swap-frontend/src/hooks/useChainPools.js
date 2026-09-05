import { useEffect } from 'react';
import { useWalletStore } from '@/store/walletStore.js';
import { usePoolsStore } from '@/store/poolsStore.js';

export function useChainPools() {
  const { address, connected } = useWalletStore();
  const pools = usePoolsStore((s) => s.pools);
  const loading = usePoolsStore((s) => s.loading);
  const loadingUserData = usePoolsStore((s) => s.loadingUserData);
  const error = usePoolsStore((s) => s.error);
  const maybeRefreshPools = usePoolsStore((s) => s.maybeRefreshPools);
  const refreshPools = usePoolsStore((s) => s.refreshPools);

  // Silently refresh when the page opens or wallet changes
  useEffect(() => {
    const userAddr = connected && address ? address : null;
    maybeRefreshPools(userAddr);
  }, [connected, address, maybeRefreshPools]);

  return {
    pools,
    loading,
    loadingUserData,
    error,
    reload: () => refreshPools(connected && address ? address : null),
  };
}
