import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Droplets, Sprout, Building2 } from 'lucide-react';

const TAB_ITEMS = [
  { path: '/swap', labelKey: 'nav_swap', Icon: ArrowLeftRight },
  { path: '/liquidity', labelKey: 'nav_liquidity', Icon: Droplets },
  { path: '/mining', labelKey: 'nav_mining', Icon: Sprout },
  { path: '/pools', labelKey: 'nav_pools', Icon: Building2 },
];

export default function MobileTabBar() {
  const { t } = useTranslation();

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around px-2 pb-[env(safe-area-inset-bottom)]"
      style={{
        height: '64px',
        boxSizing: 'content-box',
        background: 'var(--color-bg-glass)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-border-default)',
      }}
    >
      {TAB_ITEMS.map(({ path, labelKey, Icon }) => (
        <NavLink
          key={path}
          to={path}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full py-1 transition-colors"
        >
          {({ isActive }) => (
            <>
              <Icon
                size={22}
                strokeWidth={isActive ? 2.5 : 2}
                style={{
                  color: isActive ? 'var(--color-primary-500)' : 'var(--color-text-tertiary)',
                  transition: 'color 0.2s',
                }}
              />
              <span
                className="text-[10px] font-medium"
                style={{
                  color: isActive ? 'var(--color-primary-500)' : 'var(--color-text-tertiary)',
                  transition: 'color 0.2s',
                }}
              >
                {t(labelKey)}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
