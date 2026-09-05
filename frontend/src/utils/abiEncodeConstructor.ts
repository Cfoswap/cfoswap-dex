import { ethers } from 'ethers'

export interface AbiEncodedConstructorResult {
  readonly encoded: string // 0x-prefixed hex. Without 0x bytecode prefix, it is just the encoded args.
  readonly argTypes: readonly string[]
  readonly valuesAsPrintable: readonly unknown[]
}

export function abiEncodeConstructorArgs(
  argTypes: readonly string[],
  values: readonly unknown[]
): AbiEncodedConstructorResult {
  if (argTypes.length !== values.length) {
    throw new RangeError(
      `abiEncodeConstructorArgs: types length (${argTypes.length}) != values length (${values.length})`
    )
  }
  const normalized = values.map((v, i) => normalizeArgForAbiCoder(argTypes[i], v))
  const encoded = ethers.utils.defaultAbiCoder.encode(Array.from(argTypes), normalized)
  const printable = normalized.map((v) => printableForJson(v))
  return { encoded, argTypes: Array.from(argTypes), valuesAsPrintable: printable }
}

function printableForJson(value: unknown): unknown {
  // ethers.BigNumber → string decimal
  if (typeof value === 'object' && value !== null && (value as { _isBigNumber?: boolean })._isBigNumber) {
    return (value as ethers.BigNumber).toString()
  }
  if (Array.isArray(value)) return value.map((v) => printableForJson(v))
  if (typeof value === 'bigint') return value.toString()
  return value
}

function normalizeArgForAbiCoder(type: string, raw: unknown): unknown {
  // address → checksum (if looks like address)
  if (type === 'address') {
    if (raw == null || raw === '') {
      throw new TypeError(`address arg must not be empty`)
    }
    if (typeof raw !== 'string') throw new TypeError(`address arg must be a string`)
    return ethers.utils.getAddress(raw.toLowerCase() === '0x0' ? '0x' + '0'.repeat(40) : raw)
  }
  // bytes, bytesN
  if (type === 'bytes' || /^bytes\d+$/.test(type)) {
    if (typeof raw !== 'string') throw new TypeError('bytes arg must be 0x hex string')
    return raw.startsWith('0x') ? raw : `0x${raw}`
  }
  // uint / int (including uint8..uint256, intN)
  if (/^(u)?int(\d+)?$/.test(type)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
      return ethers.BigNumber.from(typeof raw === 'bigint' ? raw.toString() : raw)
    }
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { _isBigNumber?: boolean })._isBigNumber
    ) {
      return raw
    }
    throw new TypeError(`uint arg bad type ${typeof raw}`)
  }
  // bool
  if (type === 'bool') {
    return Boolean(raw)
  }
  // string
  if (type === 'string') {
    if (raw == null) throw new TypeError('string arg must not be null')
    return String(raw)
  }
  // uint256[N] / address[N] / etc fixed-length arrays
  const fixed = type.match(/^(.*)\[(\d+)\]$/)
  if (fixed) {
    const innerType = fixed[1]
    const size = Number(fixed[2])
    if (!Array.isArray(raw) || raw.length !== size) {
      throw new RangeError(`expected ${type} array length=${size}, got ${Array.isArray(raw) ? raw.length : typeof raw}`)
    }
    return raw.map((v) => normalizeArgForAbiCoder(innerType, v))
  }
  // uint256[] dynamic → recursively apply numeric norm
  const dyn = type.match(/^(.*)\[\]$/)
  if (dyn) {
    const innerType = dyn[1]
    if (!Array.isArray(raw)) {
      throw new TypeError(`expected ${type} dynamic array`)
    }
    return raw.map((v) => normalizeArgForAbiCoder(innerType, v))
  }
  // Fallback: return raw as-is (e.g. tuples). Users should pass pre-normalized objects.
  return raw
}

// Convert string of bps (0..10000) to a bignumber, validating range.
export function validateAndCastBp(raw: number | string | bigint | ethers.BigNumber, max: number): ethers.BigNumber {
  const bn = ethers.BigNumber.from(
    typeof raw === 'bigint' ? raw.toString() : typeof raw === 'string' ? raw : raw.toString()
  )
  if (bn.lt(0) || bn.gt(max)) {
    throw new RangeError(`bps out of range: ${bn.toString()} must be within [0, ${max}]`)
  }
  return bn
}

// Helper: parse a decimals-aware value like "1 ether" style into ethers BigNumber.
export function parseDecimalUnits(value: string | number | bigint, decimals: number): ethers.BigNumber {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('parseDecimalUnits: non-finite number')
    // Use fixed point math via string to avoid IEEE 754 drift at extremes.
    return ethers.utils.parseUnits(Number(value).toFixed(decimals), decimals)
  }
  if (typeof value === 'bigint') {
    value = value.toString()
  }
  return ethers.utils.parseUnits(value, decimals)
}

export function formatDecimalUnits(value: ethers.BigNumber | string | bigint, decimals: number): string {
  const bn = ethers.BigNumber.from(
    typeof value === 'bigint' ? value.toString() : (value as ethers.BigNumberish)
  )
  return ethers.utils.formatUnits(bn, decimals)
}

export function isChecksumOrRawAddress(candidate: unknown, allowZero = false): candidate is string {
  if (typeof candidate !== 'string') return false
  if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) return false
  if (!allowZero && candidate.toLowerCase() === `0x${'0'.repeat(40)}`) return false
  try {
    ethers.utils.getAddress(candidate)
    return true
  } catch {
    return false
  }
}
