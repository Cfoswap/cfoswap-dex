import { Link, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import WalletButton from '@/components/common/WalletButton'
import LanguageSwitcher from '@/components/common/LanguageSwitcher'

function MainLayout() {
  const { t } = useTranslation()

  return (
    <div className="min-h-screen bg-gray-50 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08)_0%,transparent_60%),radial-gradient(ellipse_at_bottom_right,rgba(5,150,105,0.06)_0%,transparent_50%)]">
      <header className="sticky top-0 z-50 backdrop-blur-lg bg-white/80 border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16 gap-2">
            <Link to="/" className="flex items-center gap-3 flex-shrink-0">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-600 text-white font-black text-lg flex items-center justify-center shadow-lg shadow-primary-500/25">
                🚀
              </div>
              <div className="hidden sm:block">
                <h1 className="text-lg font-extrabold text-gray-900 leading-tight">{t('common.appName')}</h1>
                <p className="text-xs text-gray-500 leading-tight">{t('common.appSubtitle')}</p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <WalletButton />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <Outlet />
      </main>

      <footer className="max-w-5xl mx-auto px-4 sm:px-6 py-8 text-center">
        <p className="text-xs text-gray-400">
          {t('footer')}
        </p>
      </footer>
    </div>
  )
}

export default MainLayout
