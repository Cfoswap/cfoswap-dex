import { useState } from 'react';
import { X, AlertCircle, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/store/uiStore.js';
import { TX_DEADLINE_MINUTES } from '@/config/index.js';
import { sanitizeSlippageInput, blockInvalidNumericKeys, sanitizeIntegerInput, blockInvalidIntegerKeys } from '@/utils/index.js';

const PRESET_SLIPPAGES_BPS = [10, 50, 100, 300]; // 0.1%, 0.5%, 1%, 3%

export default function SlippageDrawer() {
  const { t } = useTranslation();
  const closeModal = () => useUiStore.getState().closeSlippageDrawer();
  const slippageBps = useUiStore((s) => s.slippageBps);
  const setSlippageBps = (v) => useUiStore.getState().setSlippageBps(v);
  const txDeadline = useUiStore((s) => s.txDeadline);
  const setTxDeadline = (v) => useUiStore.getState().setTxDeadline(v);

  // Current slippage percentage
  const currentSlippagePct = slippageBps / 100;
  // Whether it is a preset slippage
  const isPreset = PRESET_SLIPPAGES_BPS.includes(slippageBps);

  const [customSlippage, setCustomSlippage] = useState(
    isPreset ? '' : String(currentSlippagePct)
  );

  const handlePresetClick = (bpsVal) => {
    setSlippageBps(bpsVal);
    setCustomSlippage('');
  };

  const handleCustomChange = (e) => {
    const val = sanitizeSlippageInput(e.target.value);
    setCustomSlippage(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0 && num <= 50) {
      setSlippageBps(Math.round(num * 100));
    }
  };

  const showWarning = currentSlippagePct > 5 || currentSlippagePct < 0.1;

  return (
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 animate-fadeIn"
        style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(4px)' }}
        onClick={(e) => {
          e.stopPropagation();
          closeModal();
        }}
      />

      <div
        className="absolute top-0 right-0 h-full w-full max-w-sm animate-slideInRight"
        style={{
          background: 'var(--gradient-surface)',
          borderLeft: '1px solid var(--color-border-default)',
          boxShadow: 'var(--drawer-shadow)',
        }}
      >
        <div className="h-full flex flex-col p-6">
          <div className="flex items-center justify-between mb-6">
            <h2
              className="text-lg font-bold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {t('tx_settings')}
            </h2>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeModal();
              }}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
              style={{
                color: 'var(--color-text-secondary)',
                background: 'var(--color-bg-tertiary)',
              }}
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-6 flex-1 overflow-y-auto custom-scrollbar pr-1">
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                  {t('slippage_tolerance')}
                </label>
              </div>

              <div className="grid grid-cols-4 gap-2 mb-3">
                {PRESET_SLIPPAGES_BPS.map((bpsVal) => {
                  const pct = bpsVal / 100;
                  const isActive = !customSlippage && slippageBps === bpsVal;
                  return (
                    <button
                      key={bpsVal}
                      onClick={() => handlePresetClick(bpsVal)}
                      className="py-2 rounded-lg text-sm font-medium transition-colors"
                      style={{
                        background: isActive
                          ? 'var(--state-info-bg)'
                          : 'var(--color-bg-tertiary)',
                        color: isActive ? 'var(--color-text-inverse)' : 'var(--color-text-secondary)',
                        border: isActive
                          ? '1px solid var(--color-border-strong)'
                          : '1px solid var(--color-border-subtle)',
                      }}
                    >
                      {pct}%
                    </button>
                  );
                })}
              </div>

              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={customSlippage}
                  onChange={handleCustomChange}
                  onKeyDown={blockInvalidNumericKeys}
                  placeholder={t('custom')}
                  className="w-full px-4 py-2.5 pr-10 rounded-lg text-sm outline-none transition-colors"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    color: 'var(--color-text-primary)',
                    border: customSlippage
                      ? '1px solid var(--color-border-strong)'
                      : '1px solid var(--color-border-default)',
                  }}
                />
                <span
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-sm"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  %
                </span>
              </div>

              {showWarning && currentSlippagePct > 0 && (
                <div
                  className="mt-3 flex items-start gap-2 p-3 rounded-lg text-xs"
                  style={{
                    background: currentSlippagePct > 5 ? 'var(--state-error-bg)' : 'var(--state-warning-bg)',
                    border: `1px solid ${currentSlippagePct > 5 ? 'var(--state-error)' : 'var(--state-warning)'}`,
                    color: currentSlippagePct > 5 ? 'var(--state-error)' : 'var(--state-warning)',
                  }}
                >
                  <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    {currentSlippagePct > 5 ? t('slippage_tip2') : t('slippage_tip1')}
                  </span>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-medium flex items-center gap-1.5" style={{ color: 'var(--color-text-primary)' }}>
                  <Clock size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                  {t('tx_deadline')}
                </label>
              </div>
              <div className="relative">
                <input
                  type="text"
                  inputMode="numeric"
                  value={txDeadline}
                  onChange={(e) => {
                    const val = sanitizeIntegerInput(e.target.value);
                    if (val === '') {
                      setTxDeadline(TX_DEADLINE_MINUTES);
                      return;
                    }
                    const v = parseInt(val, 10);
                    if (!isNaN(v) && v > 0 && v <= 60) setTxDeadline(v);
                  }}
                  onKeyDown={blockInvalidIntegerKeys}
                  className="w-full px-4 py-2.5 pr-16 rounded-lg text-sm outline-none transition-colors"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    color: 'var(--color-text-primary)',
                    border: '1px solid var(--color-border-default)',
                  }}
                />
                <span
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-sm"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  {t('minutes')}
                </span>
              </div>
              <p
                className="mt-2 text-xs leading-relaxed"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                {t('deadline_tip')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
