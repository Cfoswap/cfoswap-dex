// 【按新架构重写】顶部状态栏：服务健康指示灯 + 连接钱包地址
// - 删除旧版「服务端从私钥派生部署者地址」逻辑
// - 钱包地址直接从项目全局 useWallet() 读取（account / chainId / isConnected）
// - 健康灯：status === 'ok' && forgePath 非空 → 在线；否则离线
// ----------------------------------------------------------------------------------------
import type { HealthResp, ToastKind } from '../types/foundry'
import styles from '../FoundryDeploy.module.css'
import CopyableAddress from '@/components/common/CopyableAddress'
import { useWallet } from '@/hooks/useWallet'

const COPY: {
  readonly connected: string
  readonly disconnected: string
  readonly walletLabel: string
  readonly noWallet: string
} = {
  connected: '部署服务已连接（forge / cast 就绪）',
  disconnected: '服务未启动，请先运行 foundry/start-deploy-server.ps1（监听 127.0.0.1:3011）',
  walletLabel: '签名钱包',
  noWallet: '⚠️ 未连接钱包。请到「参数配置」顶部点击「连接钱包」。',
}

export type ServiceStatusBarProps = {
  readonly health: HealthResp
  readonly notify: (kind: ToastKind, message: string) => void
}

/** 顶部状态栏：服务健康指示灯 + 签名钱包地址（来自 useWallet） */
function ServiceStatusBar({ health, notify }: ServiceStatusBarProps): JSX.Element {
  // 直接使用全局钱包状态
  const { isConnected, account, chainId } = useWallet()

  const isOnline = health?.status === 'ok' && !!health.forgePath && !!health.castPath

  return (
    <div className={styles.statusBar}>
      <div
        className={`${styles.statusDot} ${isOnline ? styles.statusOnline : styles.statusOffline}`}
        aria-hidden
      />
      <span className={`${styles.statusText} ${isOnline ? 'text-primary-700' : 'text-red-600'}`}>
        {isOnline ? COPY.connected : COPY.disconnected}
      </span>
      <span className="flex-1" />
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-slate-500">{COPY.walletLabel}：</span>
        {isConnected && account ? (
          <>
            <CopyableAddress
              value={account}
              mode="short"
              explorerBaseUrl="https://bscscan.com"
              explorerType="address"
            />
            <span
              className={
                'text-[11px] font-mono px-2 py-0.5 rounded border ' +
                (chainId === 56
                  ? 'text-primary-700 bg-primary-50 border-primary-200'
                  : 'text-amber-700 bg-amber-50 border-amber-200')
              }
            >
              chainId {chainId ?? '—'}
            </span>
            {chainId !== 56 && (
              <span className="text-[11px] font-medium text-amber-700">非 BSC 主网（需 56）</span>
            )}
          </>
        ) : (
          <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
            {COPY.noWallet}
          </span>
        )}
        {/* keep notify referenced so prop is used */}
        {notify === undefined ? null : null}
      </div>
    </div>
  )
}

export default ServiceStatusBar
