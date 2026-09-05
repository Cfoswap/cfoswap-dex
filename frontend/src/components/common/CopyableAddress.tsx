import { useState, useCallback } from 'react'

export interface CopyableAddressProps {
  /** 需要展示的完整地址（或任意字符串） */
  readonly value: string
  /** 展示模式：full=完整显示（默认），short=0x前6后4截断；txHash默认不截断用 full */
  readonly mode?: 'full' | 'short'
  /** 是否展示 explorer 链接（传入 base URL，不含末尾 /） */
  readonly explorerBaseUrl?: string
  /** explorer 链接类型：address 或 tx */
  readonly explorerType?: 'address' | 'tx'
  /** 自定义 class */
  readonly className?: string
}

/**
 * 通用可复制字符串组件。
 * 默认规则：
 *  - 完整显示 42 字符地址（不截断）
 *  - 右侧小按钮一键复制，成功后临时变 ✅ 字样
 *  - 可选 explorer 外链跳转
 *  严格禁 any；全部显式类型收窄。
 */
export function CopyableAddress({
  value,
  mode = 'full',
  explorerBaseUrl,
  explorerType = 'address',
  className,
}: CopyableAddressProps): JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(value)
      } else {
        // Fallback：不支持 Clipboard API 时用临时 textarea
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* 忽略复制失败（避免抛错阻塞 UI） */
    }
  }, [value])

  const display =
    mode === 'short' && value.length >= 10
      ? `${value.slice(0, 6)}…${value.slice(-4)}`
      : value

  const href = explorerBaseUrl ? `${explorerBaseUrl}/${explorerType}/${value}` : undefined

  const baseWrap =
    'inline-flex items-center gap-1.5 align-middle font-mono text-slate-700 bg-slate-50 border border-slate-200 rounded px-2 py-0.5'

  return (
    <span className={`${baseWrap} ${className ?? ''}`}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[11px] text-primary-700 hover:text-primary-900 hover:underline break-all"
          title={`在浏览器打开：${value}`}
        >
          {display}
        </a>
      ) : (
        <span className="text-[11px] break-all" title={value}>
          {display}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void handleCopy()
        }}
        title={copied ? '已复制' : `复制：${value}`}
        aria-label="复制到剪贴板"
        className="flex-none inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-slate-500 hover:text-primary-700 hover:bg-primary-100 border border-slate-200 hover:border-primary-300 transition-colors"
      >
        {copied ? '✅' : '📋'}
      </button>
    </span>
  )
}

export default CopyableAddress
