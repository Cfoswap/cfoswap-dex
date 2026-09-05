import { Component } from 'react';
import i18n from '@/config/i18n.js';
import { REFERRAL_STORAGE_KEY } from '@/utils/referral.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidMount() {
    // Bridge: window-level error listeners in App.jsx dispatch this event; ErrorBoundary can only catch render-phase errors natively
    if (typeof window !== 'undefined' && window.addEventListener) {
      this._onFatalError = (evt) => {
        // setState will trigger getDerivedStateFromError flow and render the fallback UI
        const detail = evt?.detail;
        const realErr = detail instanceof Error
          ? detail
          : (detail ? new Error(String(detail?.message || detail)) : null);
        this.setState((prev) => {
          if (prev.hasError && prev.error && prev.error.message && String(prev.error.message) !== 'Global runtime error (window.onerror/unhandledrejection)') return prev;
          return {
            hasError: true,
            error: prev.error && prev.error.message && String(prev.error.message) !== 'Global runtime error (window.onerror/unhandledrejection)'
              ? prev.error
              : (realErr || new Error('Global runtime error (window.onerror/unhandledrejection)')),
          };
        });
      };
      window.addEventListener('app:fatal-error', this._onFatalError);
    }
  }

  componentWillUnmount() {
    if (typeof window !== 'undefined' && window.removeEventListener && this._onFatalError) {
      window.removeEventListener('app:fatal-error', this._onFatalError);
      this._onFatalError = null;
    }
  }

  componentDidCatch(error, errorInfo) {
    // SAFETY: never throw in this hook, would trigger infinite render loop
    try {
      if (import.meta.env.DEV) {
        console.error('[ErrorBoundary] caught:', error, errorInfo);
      }
    } catch (_) { /* noop */ }
  }

  handleReload = () => {
    try {
      // Clean zustand persist caches that may contain corrupted data from old versions
      const preserve = new Set([
        'cfoswap_lang',
        'cfoswap-theme',
        'cfoswap_liquidity_tab',
        REFERRAL_STORAGE_KEY,
        'cfoswap-deployed-tokens',
      ]);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && !preserve.has(key) && key.startsWith('cfoswap')) {
          try { localStorage.removeItem(key); } catch (_) {}
        }
      }
    } catch (_) { /* noop */ }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'linear-gradient(135deg,#0a0a18 0%,#111827 100%)',
        color: '#e5e7eb',
        fontFamily: 'system-ui,-apple-system,sans-serif',
      }}>
        <div style={{
          maxWidth: 480,
          width: '100%',
          padding: '32px',
          borderRadius: 16,
          background: 'rgba(17,24,39,0.85)',
          border: '1px solid rgba(239,68,68,0.3)',
          boxShadow: '0 20px 60px rgba(239,68,68,0.15)',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
            fontSize: 24,
          }}>⚠</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 600, color: '#fff' }}>
            {i18n.t('err_boundary_title')}
          </h2>
          <p style={{ margin: '0 0 24px', fontSize: 14, lineHeight: 1.6, color: '#9ca3af' }}>
            {i18n.t('err_boundary_desc')}
          </p>
          {import.meta.env.DEV && this.state.error?.message && (
            <div style={{
              padding: '12px 14px',
              marginBottom: 24,
              borderRadius: 8,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.06)',
              fontFamily: 'ui-monospace,monospace',
              fontSize: 12,
              color: '#f87171',
              wordBreak: 'break-all',
              textAlign: 'left',
              whiteSpace: 'pre-wrap',
            }}>
              <div><strong style={{ color: '#fca5a5' }}>ERROR:</strong> {String(this.state.error.message).slice(0, 600)}</div>
              {this.state.error?.stack && (
                <div style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '1px dashed rgba(248,113,113,0.25)',
                  color: '#fda4af',
                  fontSize: 11,
                  lineHeight: 1.5,
                }}>
                  <div><strong style={{ color: '#fca5a5' }}>STACK:</strong></div>
                  {String(this.state.error.stack).slice(0, 1500)}
                </div>
              )}
            </div>
          )}
          <button
            onClick={this.handleReload}
            style={{
              width: '100%',
              padding: '14px 20px',
              borderRadius: 12,
              border: 'none',
              background: 'linear-gradient(135deg,#ef4444 0%,#dc2626 100%)',
              color: '#fff',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'transform .15s ease',
            }}
            onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
            onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            {i18n.t('err_boundary_refresh')}
          </button>
        </div>
      </div>
    );
  }
}
