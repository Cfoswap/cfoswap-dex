import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Navbar from '@/components/layout/Navbar.jsx';
import MobileTabBar from '@/components/layout/MobileTabBar.jsx';
import WalletModal from '@/components/common/WalletModal.jsx';
import SlippageDrawer from '@/components/common/SlippageDrawer.jsx';
import BoostModal from '@/components/common/BoostModal.jsx';
import TokenSelectModal from '@/components/common/TokenSelectModal.jsx';
import Toast from '@/components/common/Toast.jsx';
import { useUiStore } from '@/store/uiStore.js';
import { useWalletStore } from '@/store/walletStore.js';
import { useReferrerCapture } from '@/hooks/useReferrerCapture.js';

export default function MainLayout() {
  const { t } = useTranslation();
  const walletModalOpen = useUiStore((s) => s.walletModalOpen);
  const slippageDrawerOpen = useUiStore((s) => s.slippageDrawerOpen);
  const boostModalOpen = useUiStore((s) => s.boostModalOpen);
  const tokenSelectModalOpen = useUiStore((s) => s.tokenSelectModalOpen);
  const reconnectOnRefresh = useWalletStore((s) => s.reconnectOnRefresh);

  // Globally capture referral links ?ref= (takes effect on landing on any page)
  useReferrerCapture();

  // On page mount: if persist restored connected state but provider is lost (after page refresh), auto-reconnect
  useEffect(() => {
    reconnectOnRefresh?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Layer 1: Base color gradient (--bg-layer-base: light gray-blue in day / deep dark blue at night) */}
      <div
        className="fixed inset-0 -z-10"
        style={{ background: 'var(--bg-layer-base)' }}
      />
      {/* Layer 2: Blue-violet-cyan light spots (different opacity for day/night) */}
      <div
        className="fixed inset-0 -z-10 opacity-60"
        style={{ background: 'var(--bg-layer-halo)' }}
      />
      {/* Layer 3: Grid pattern (dark blue thin lines in day / white thin lines at night) */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          backgroundImage: 'var(--bg-layer-grid)',
          backgroundSize: 'var(--bg-grid-size)',
          opacity: 'var(--bg-grid-opacity)',
        }}
      />

      <Navbar />

      <main className="flex-1 pt-[88px] px-4 md:px-6 w-full max-w-[1152px] mx-auto relative z-10 pb-[calc(64px+env(safe-area-inset-bottom,0px)+24px)] md:pb-10">
        <Outlet />
      </main>

      <footer className="relative z-10 py-6 text-center text-xs border-t hidden md:block"
        style={{
          borderColor: 'var(--footer-border-color)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        <p>{t('footer_copyright')}</p>
      </footer>

      {walletModalOpen && <WalletModal />}
      {slippageDrawerOpen && <SlippageDrawer />}
      {boostModalOpen && <BoostModal />}
      {tokenSelectModalOpen && <TokenSelectModal />}
      <MobileTabBar />
      <Toast />
    </div>
  );
}
