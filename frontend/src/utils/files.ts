// Browser-only: trigger a JSON object download without touching the filesystem.
export function downloadJsonAsFile<T>(suggestedFilename: string, payload: T): void {
  const text = JSON.stringify(payload, null, 2)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedFilename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Release blob memory ~1 minute later so slow-start downloads still have a chance.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

export function currentUtcDateString(): string {
  const d = new Date()
  const iso = d.toISOString().slice(0, 10) // yyyy-mm-dd
  return iso
}

export function formatBpsToPercent(bps: number | string): string {
  const n = Number(String(bps).replace(/[^\d.-]/g, ''))
  if (!Number.isFinite(n)) return '0%'
  return `${(n / 100).toFixed(2)}%`
}
