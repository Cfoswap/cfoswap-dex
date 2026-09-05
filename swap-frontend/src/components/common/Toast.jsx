import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { useUiStore } from '@/store/uiStore.js';

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLORS = {
  success: 'var(--state-success)',
  error: 'var(--state-error)',
  warning: 'var(--state-warning)',
  info: 'var(--state-info)',
};

export default function Toast() {
  const { t } = useTranslation();
  const toasts = useUiStore((s) => s.toasts);

  return (
    <div
      className="fixed top-5 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 px-4 pointer-events-none"
      style={{ maxWidth: 'min(92vw, 420px)' }}
    >
      {toasts.map((toast) => {
        const Icon = ICONS[toast.type] || Info;
        const color = COLORS[toast.type] || COLORS.info;
        return (
          <div
            key={toast.id}
            className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg animate-[toastIn_0.3s_cubic-bezier(0.16,1,0.3,1)_forwards]"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
              color: 'var(--color-text-primary)',
              pointerEvents: 'auto',
            }}
          >
            <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} />
            <span>{t(toast.message) || toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}