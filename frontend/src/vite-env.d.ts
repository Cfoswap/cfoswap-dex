/// <reference types="vite/client" />

interface Eip1193Provider {
  readonly request?: (args: { readonly method: string; readonly params?: readonly unknown[] }) => Promise<unknown>
  readonly send?: (method: string, params: readonly unknown[]) => Promise<unknown>
  readonly on?: (event: string, listener: (...args: unknown[]) => void) => void
  readonly removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
  readonly isMetaMask?: boolean
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.module.scss' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.json' {
  const value: unknown
  export default value
}

export {}
