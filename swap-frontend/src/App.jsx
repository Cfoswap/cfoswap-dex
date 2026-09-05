import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import router from '@/router/index.jsx';
import { probeProviderAndRecover } from '@/utils/index.js';
import { useWalletStore } from '@/store/walletStore.js';
import ErrorBoundary from '@/components/common/ErrorBoundary.jsx';

export default function App() {
  useEffect(() => {
    // ---------- Global unhandled error listeners (prevent silent white-screen) ----------
    let globalErrorTimer = 0;
    const triggerFallbackUi = (err) => {
      // Debounce: avoid multiple rapid listeners causing double reload
      if (globalErrorTimer) return;
      globalErrorTimer = window.setTimeout(() => {
        globalErrorTimer = 0;
        try {
          // Render ErrorBoundary fallback by dispatching a synthetic error to a root listener
          const evt = new CustomEvent('app:fatal-error', { detail: err || null });
          window.dispatchEvent(evt);
        } catch (_) { /* noop */ }
      }, 100);
    };

    const onUnhandledRejection = (event) => {
      try {
        const reason = event?.reason;
        const msg = String(reason?.message || reason || '');
        // Ignore benign user / provider / network rejections that do not corrupt React state
        if (/user rejected|user cancelled|action rejected|cancelled by user|request reset|provider disconnected|chain not accepted|network error|fetch failed|failed to fetch/i.test(msg)) return;
        if (import.meta.env.DEV) {
          console.error('[App] unhandledrejection:', reason);
        }
        // Only trigger fallback for true code bugs (has Error object with stack), not random provider noise
        if (reason instanceof Error && reason.stack) {
          triggerFallbackUi(reason);
        }
      } catch (_) { /* noop */ }
    };

    const onError = (event) => {
      try {
        const errObj = event?.error;
        const msg = String(event?.message || '');
        if (import.meta.env.DEV) {
          console.error('[App] window.error:', errObj || msg);
        }
        // Resource load errors (img/css/script 404) are always non-fatal — skip
        const target = event?.target;
        if (target && (target.tagName === 'IMG' || target.tagName === 'LINK' || target.tagName === 'SCRIPT')) return;
        // Unknown errors with no Error object are almost always:
        //   - cross-origin script errors (browser hides details for security)
        //   - browser extension content-script exceptions
        //   - favicon / non-critical resource failures with null target
        //   - metamask / wallet provider injected scripts throwing noisy non-fatal
        // Do NOT trigger white-screen fallback for these — they don't break the app.
        if (!(errObj instanceof Error) || !errObj.stack) return;
        // Truly fatal JS exceptions with a real stack trace → activate fallback UI
        triggerFallbackUi(errObj);
      } catch (_) { /* noop */ }
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('error', onError, true);

    // ---------- Auto reconnect after page refresh ----------
    let unmounted = false;
    let reconnectTimer = 0;
    const tryReconnect = () => {
      if (unmounted) return;
      if (useWalletStore.persist?.hasHydrated?.()) {
        useWalletStore.getState().reconnectOnRefresh();
      } else {
        reconnectTimer = window.setTimeout(tryReconnect, 50);
      }
    };
    tryReconnect();

    let lastHiddenTime = 0;
    const VISIBILITY_REFRESH_THRESHOLD = 30000; // Only refresh when returning from background after 30s, avoid lag from frequent switching

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        const hiddenDuration = now - lastHiddenTime;
        // Background suspension exceeds threshold, check provider health
        if (hiddenDuration > VISIBILITY_REFRESH_THRESHOLD) {
          if (import.meta.env.DEV) {
            console.log(`[RPC] App resumed after ${Math.round(hiddenDuration / 1000)}s in background, probing provider...`);
          }
          // Probe liveness first, auto downgrade dead links
          await probeProviderAndRecover();
          // If wallet is connected, silently refresh balance (non-blocking UI, no loading indicator)
          const wallet = useWalletStore.getState();
          if (wallet.connected && wallet.chainId === 56) {
            wallet.maybeSilentRefresh();
          }
        }
      } else {
        lastHiddenTime = Date.now();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    // Also listen for pageshow (triggered when mobile Safari/OKX restores from cache)
    window.addEventListener('pageshow', handleVisibilityChange);
    return () => {
      unmounted = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (globalErrorTimer) window.clearTimeout(globalErrorTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('error', onError, true);
    };
  }, []);

  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}
