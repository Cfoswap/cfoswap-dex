import { useState, useEffect } from 'react';

/**
 * Generic token icon component
 * Uses a rounded frame (theme surface color background) to cover the white corners around the icon,
 * avoiding white background/whitespace issues in dark mode.
 *
 * Props:
 *   src    - Token icon URL (optional)
 *   symbol - Token symbol (used as placeholder text on load failure)
 *   size   - Size (number, unit px), default 24
 *   className - Additional CSS class
 *   style  - Additional inline styles
 */
export default function TokenIcon({ src, symbol, size = 24, className = '', style }) {
  const [failed, setFailed] = useState(false);

  // Core fix: When switching tokens, src changes, force reset failed state to prevent previous token's load failure from affecting next token's display
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const px = typeof size === 'number' ? size : 24;

  return (
    <div
      className={`rounded-full flex items-center justify-center overflow-hidden flex-shrink-0 ${className}`}
      style={{
        width: px,
        height: px,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-default)',
        ...style,
      }}
    >
      {!failed && src ? (
        <img
          src={src}
          alt={symbol || ''}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="font-bold select-none"
          style={{ fontSize: Math.max(9, Math.round(px * 0.35)), color: 'var(--color-text-secondary)' }}
        >
          {(symbol || '?').slice(0, 3).toUpperCase()}
        </span>
      )}
    </div>
  );
}