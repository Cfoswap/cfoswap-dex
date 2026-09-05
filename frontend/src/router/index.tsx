/* eslint-disable react-refresh/only-export-components -- 路由配置文件导出非组件对象 router，属于合法场景 */
import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import MainLayout from '@/components/layout/MainLayout'
import Loading from '@/components/common/Loading'

const FoundryDeploy = lazy(() => import('@/pages/FoundryDeploy/FoundryDeploy'))

const lazyLoad = (Component: React.LazyExoticComponent<() => JSX.Element>) => (
  <Suspense fallback={<Loading />}>
    <Component />
  </Suspense>
)

const router = createBrowserRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      { index: true, element: <Navigate to="/foundry-deploy" replace /> },
      { path: 'foundry-deploy', element: lazyLoad(FoundryDeploy) },
      { path: '*', element: <Navigate to="/foundry-deploy" replace /> }
    ]
  }
])

export default router
