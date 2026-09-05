import { useState, useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe, Wallet, Sun, Moon, ChevronDown } from 'lucide-react';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import useTheme from '@/hooks/useTheme.js';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'ru', label: 'Русский' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
];

const NAV_ITEMS = [
  { path: '/swap', labelKey: 'nav_swap' },
  { path: '/liquidity', labelKey: 'nav_liquidity' },
  { path: '/mining', labelKey: 'nav_mining' },
  { path: '/pools', labelKey: 'nav_pools' },
];

export default function Navbar() {
  const { t, i18n } = useTranslation();
  const [langOpen, setLangOpen] = useState(false);
  const [walletBtnHover, setWalletBtnHover] = useState(false);
  const langRef = useRef(null);
  const { toggleTheme, isLight } = useTheme();

  const { connected, shortAddress } = useWalletStore();
  const openWalletModal = useUiStore((s) => s.openWalletModal);
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);

  useEffect(() => {
    const handler = (e) => {
      if (langRef.current && !langRef.current.contains(e.target)) setLangOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const currentLang = LANGUAGES.find((l) => l.code === language) || LANGUAGES[0];

  const handleLangChange = (code) => {
    setLanguage(code);
    i18n.changeLanguage(code);
    setLangOpen(false);
  };

  const handleWalletClick = () => {
    // ===== When connected, clicking wallet button: directly open WalletModal (shows "My Assets" + disconnect button), no longer shows dropdown with only Disconnect =====
    openWalletModal();
  };

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 h-[72px] flex items-center"
      style={{
        background: 'var(--color-bg-glass)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--color-border-default)',
      }}
    >
      <div className="w-full max-w-[1152px] mx-auto px-4 md:px-6 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <NavLink to="/swap" className="flex items-center gap-2.5 group">
            <img
              src="/img/logo.png?v=6"
              alt="cfoswap"
              className="w-10 h-10 rounded-lg transition-transform group-hover:scale-105"
              style={{
                boxShadow: 'var(--logo-shadow)',
              }}
            />
            <span
              className="text-xl font-bold tracking-wide"
              style={{
                background: 'var(--logo-gradient)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              cfoswap
            </span>
          </NavLink>

          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                    isActive ? '' : ''
                  }`
                }
                style={({ isActive }) => ({
                  color: 'var(--color-text-primary)',
                  opacity: isActive ? 1 : 0.7,
                  background: isActive
                    ? 'var(--nav-active-bg)'
                    : 'transparent',
                  boxShadow: isActive
                    ? 'inset 0 1px 0 var(--surface-highlight-strong)'
                    : 'none',
                  border: isActive
                    ? '1px solid var(--border-soft-primary)'
                    : '1px solid transparent',
                })}
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {/* Theme toggle button (day/night) - hidden on mobile to avoid obstruction */}
          <button
            onClick={toggleTheme}
            aria-label={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
            title={isLight ? t('switch_dark_mode') : t('switch_light_mode')}
            className="hidden sm:flex items-center justify-center w-10 h-10 rounded-xl transition-all hover:scale-[1.06] active:scale-[0.96]"
            style={{
              background: 'var(--color-bg-glass)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            {isLight ? <Moon size={17} /> : <Sun size={17} />}
          </button>

          <div className="relative" ref={langRef}>
            <button
              onClick={() => setLangOpen((o) => !o)}
              className="flex items-center justify-center sm:justify-start gap-1.5 w-10 h-10 sm:w-auto sm:h-auto sm:px-3 sm:py-2.5 rounded-xl text-sm transition-all hover:scale-[1.06] active:scale-[0.96]"
              style={{
                background: 'var(--color-bg-glass)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-default)',
              }}
            >
              <Globe size={16} className="opacity-80" />
              <span className="hidden sm:inline">{currentLang.label}</span>
              <ChevronDown
                size={14}
                className={`hidden sm:block transition-transform duration-200 ${langOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {langOpen && (
              <div
                className="absolute right-0 mt-2 w-40 rounded-xl p-1.5 z-50 animate-ddIn"
                style={{
                  background: 'var(--color-bg-elevated)',
                  backdropFilter: 'blur(16px)',
                  WebkitBackdropFilter: 'blur(16px)',
                  border: '1px solid var(--color-border-default)',
                  boxShadow: 'var(--shadow-lg)',
                }}
              >
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => handleLangChange(lang.code)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm transition-all"
                    style={{
                      color:
                        language === lang.code
                          ? 'var(--color-primary-500)'
                          : 'var(--color-text-secondary)',
                      background:
                        language === lang.code
                          ? 'var(--state-info-bg)'
                          : 'transparent',
                    }}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ========== Top wallet button (both connected/disconnected click to open WalletModal Modal, connected shows asset list) ========== */}
          <button
            onClick={handleWalletClick}
            onMouseEnter={() => !connected && setWalletBtnHover(true)}
            onMouseLeave={() => setWalletBtnHover(false)}
            className="flex items-center justify-center gap-2 px-3 md:px-4 h-10 rounded-xl text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98] shrink-0 whitespace-nowrap"
            style={{
              minWidth: connected ? 'auto' : '120px',
              background: connected
                ? 'var(--color-bg-glass)'
                : walletBtnHover
                  ? 'linear-gradient(to right, #F59E0B, #EA580C)'
                  : 'linear-gradient(to right, #FBBF24, #F97316)',
              color: connected
                ? 'var(--color-text-primary)'
                : '#ffffff',
              border: connected
                ? '1px solid var(--color-border-default)'
                : '1px solid transparent',
              boxShadow: connected
                ? 'inset 0 1px 0 var(--surface-highlight)'
                : '0 2px 6px rgba(249, 115, 22, 0.25)',
            }}
          >
            <Wallet size={16} className="shrink-0" />
            {connected ? (
              <>
                <span className="font-numeric">{shortAddress}</span>
                {/* Connected status dot, green indicates normal connection, no balance displayed (view balance by opening wallet card) */}
                <span
                  className="w-2 h-2 rounded-full ml-0.5 flex-shrink-0"
                  style={{ background: '#10b981', boxShadow: '0 0 0 2px rgba(16,185,129,0.2)' }}
                />
              </>
            ) : (
              <span className="truncate">{t('connect_wallet')}</span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
