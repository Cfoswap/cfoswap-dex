import { lazy, Suspense } from 'react';
import { createHashRouter, Navigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout.jsx';

const SwapPage = lazy(() => import('@/pages/swap/page.jsx'));
const LiquidityPage = lazy(() => import('@/pages/liquidity/page.jsx'));
const MiningPage = lazy(() => import('@/pages/mining/page.jsx'));
const PoolsPage = lazy(() => import('@/pages/pools/page.jsx'));
const PoolDetailPage = lazy(() => import('@/pages/pools-detail/page.jsx'));
const CreatePoolPage = lazy(() => import('@/pages/pools-create/page.jsx'));

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="animate-spin w-8 h-8 border-4 rounded-full"
        style={{
          borderColor: 'var(--color-border-default)',
          borderTopColor: 'var(--color-primary-500)',
        }}
      />
    </div>
  );
}

function withSuspense(Component) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Component />
    </Suspense>
  );
}

const router = createHashRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      { index: true, element: <Navigate to="/swap" replace /> },
      { path: 'swap', element: withSuspense(SwapPage) },
      { path: 'liquidity', element: withSuspense(LiquidityPage) },
      { path: 'mining', element: withSuspense(MiningPage) },
      { path: 'pools', element: withSuspense(PoolsPage) },
      { path: 'pools/create', element: withSuspense(CreatePoolPage) },
      { path: 'pools/:poolAddress', element: withSuspense(PoolDetailPage) },
      { path: '*', element: <Navigate to="/swap" replace /> },
    ],
  },
]);

export default router;
