import { parseS7LTimeNs, parseS7Time } from './time'

export type OnlineValueParseResult =
  | { ok: true; value: string | number | boolean }
  | { ok: false; error: string }

function parseIntegerLiteral(raw: string): number | null {
  const s = raw.trim().replace(/_/g, '')
  if (!s) return null

  const s7Radix = s.match(/^(?:[A-Z0-9_]+#)?([+-]?)(16|8|2)#([0-9A-Fa-f]+)$/i)
  if (s7Radix) {
    const sign = s7Radix[1] === '-' ? -1 : 1
    const base = parseInt(s7Radix[2], 10)
    const digits = s7Radix[3]
    const validRe = base === 16 ? /^[0-9A-Fa-f]+$/ : base === 8 ? /^[0-7]+$/ : /^[01]+$/
    if (!validRe.test(digits)) return null
    return sign * parseInt(digits, base)
  }

  if (/^0x[0-9A-Fa-f]+$/i.test(s)) {
    return parseInt(s.slice(2), 16)
  }

  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s)
    return Number.isSafeInteger(n) ? n : null
  }

  return null
}

function parseBigIntLiteral(raw: string): bigint | null {
  const s = raw.trim().replace(/_/g, '')
  if (!s) return null

  const s7Radix = s.match(/^(?:[A-Z0-9_]+#)?([+-]?)(16|8|2)#([0-9A-Fa-f]+)$/i)
  if (s7Radix) {
    const sign = s7Radix[1] === '-' ? -1n : 1n
    const base = parseInt(s7Radix[2], 10)
    const digits = s7Radix[3]
    const validRe = base === 16 ? /^[0-9A-Fa-f]+$/ : base === 8 ? /^[0-7]+$/ : /^[01]+$/
    if (!validRe.test(digits)) return null
    const prefix = base === 16 ? '0x' : base === 8 ? '0o' : '0b'
    return sign * BigInt(prefix + digits)
  }

  if (/^0x[0-9A-Fa-f]+$/i.test(s)) return BigInt(s)
  if (/^[+-]?\d+$/.test(s)) return BigInt(s)
  return null
}

const SINT32_MIN = -2147483648
const SINT32_MAX = 2147483647
const INT64_MIN = -9223372036854775808n
const INT64_MAX = 9223372036854775807n
const UINT64_MAX = 18446744073709551615n

/** Parses and validates user input for modifying an online tag or DB variable value. */
export function parseOnlineValue(rawInput: string, dataType: string): OnlineValueParseResult {
  const type = (dataType || '').trim().toUpperCase()
  const trimmed = rawInput.trim()

  const stringMatch = type.match(/^STRING(?:\s*\[\s*(\d+)\s*\])?$/)
  if (stringMatch) {
    const maxLen = stringMatch[1] ? Math.max(1, Math.min(254, parseInt(stringMatch[1], 10))) : 254
    const unquoted =
      rawInput.length >= 2 && rawInput.startsWith("'") && rawInput.endsWith("'")
        ? rawInput.slice(1, -1)
        : rawInput
    if (unquoted.length > maxLen) {
      return { ok: false, error: `STRING[${maxLen}] exceeds maximum length of ${maxLen} characters.` }
    }
    return { ok: true, value: unquoted }
  }

  if (!trimmed) {
    return { ok: false, error: `Please enter a valid ${type || 'value'}.` }
  }

  if (type === 'BOOL') {
    const upper = trimmed.toUpperCase()
    if (upper === 'TRUE' || upper === '1') return { ok: true, value: true }
    if (upper === 'FALSE' || upper === '0') return { ok: true, value: false }
    return { ok: false, error: 'BOOL value must be TRUE, FALSE, 1, or 0.' }
  }

  if (type === 'CHAR' || type === 'WCHAR') {
    const maxCode = type === 'CHAR' ? 255 : 65535
    if (/^'.'$/.test(trimmed)) {
      const code = trimmed.charCodeAt(1)
      if (code <= maxCode) return { ok: true, value: code }
    }
    const num = parseIntegerLiteral(trimmed)
    if (num !== null && num >= 0 && num <= maxCode) {
      return { ok: true, value: num }
    }
    return { ok: false, error: `${type} value must be a single character (e.g. 'A') or integer 0..${maxCode}.` }
  }

  const intRanges: Record<string, [number, number]> = {
    SINT: [-128, 127],
    USINT: [0, 255],
    BYTE: [0, 255],
    WORD: [0, 65535],
    UINT: [0, 65535],
    INT: [-32768, 32767],
    DWORD: [0, 4294967295],
    UDINT: [0, 4294967295],
    DINT: [-2147483648, 2147483647]
  }
  if (type in intRanges) {
    const num = parseIntegerLiteral(trimmed)
    if (num === null) {
      return { ok: false, error: `Invalid ${type} integer value.` }
    }
    const [min, max] = intRanges[type]
    if (num < min || num > max) {
      return { ok: false, error: `${type} value must be between ${min} and ${max}.` }
    }
    return { ok: true, value: num }
  }

  if (type === 'LINT' || type === 'ULINT' || type === 'LWORD') {
    const big = parseBigIntLiteral(trimmed)
    if (big === null) {
      return { ok: false, error: `Invalid ${type} 64-bit integer value.` }
    }
    if (type === 'LINT') {
      if (big < INT64_MIN || big > INT64_MAX) {
        return { ok: false, error: 'LINT value is out of signed 64-bit range.' }
      }
    } else if (big < 0n || big > UINT64_MAX) {
      return { ok: false, error: `${type} value is out of unsigned 64-bit range.` }
    }
    return { ok: true, value: Number(big) }
  }

  if (type === 'REAL' || type === 'LREAL') {
    const num = Number(trimmed.replace(/_/g, ''))
    if (!Number.isFinite(num)) {
      return { ok: false, error: `Invalid ${type} floating-point number.` }
    }
    return { ok: true, value: num }
  }

  if (type === 'TIME') {
    const ms = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : parseS7Time(trimmed)
    if (ms === null || !Number.isFinite(ms)) {
      return { ok: false, error: 'Invalid TIME literal. Use e.g. T#5s, TIME#500ms, or milliseconds.' }
    }
    if (ms < SINT32_MIN || ms > SINT32_MAX) {
      return { ok: false, error: 'TIME millisecond value out of 32-bit range.' }
    }
    return { ok: true, value: ms }
  }

  if (type === 'LTIME') {
    if (/^[+-]?\d+$/.test(trimmed)) {
      const ns = BigInt(trimmed)
      if (ns < INT64_MIN || ns > INT64_MAX) {
        return { ok: false, error: 'LTIME nanosecond value out of 64-bit range.' }
      }
      return { ok: true, value: Number(ns) }
    }
    const ns = parseS7LTimeNs(trimmed)
    if (ns === null) {
      return { ok: false, error: 'Invalid LTIME literal. Use e.g. LTIME#5s, LTIME#100us, or nanoseconds.' }
    }
    return { ok: true, value: Number(ns) }
  }

  return { ok: true, value: trimmed }
}

/** Returns an input placeholder hint appropriate for the given S7 data type. */
export function getOnlineValuePlaceholder(dataType: string): string {
  const upper = (dataType || '').trim().toUpperCase()
  if (/^STRING(?:\[\d+\])?$/.test(upper)) return 'Enter text...'
  switch (upper) {
    case 'BOOL':
      return 'TRUE / FALSE'
    case 'SINT':
      return 'e.g. -128..127'
    case 'USINT':
    case 'BYTE':
      return 'e.g. 0..255 or 16#FF'
    case 'WORD':
    case 'UINT':
      return 'e.g. 0..65535 or 16#00FF'
    case 'DWORD':
    case 'UDINT':
      return 'e.g. 0..4294967295 or 16#0000FFFF'
    case 'INT':
      return 'e.g. -100..32767'
    case 'DINT':
      return 'e.g. -2147483648..2147483647'
    case 'LINT':
    case 'ULINT':
    case 'LWORD':
      return 'e.g. 64-bit integer or 16#...'
    case 'CHAR':
    case 'WCHAR':
      return "e.g. 'A' or 65"
    case 'REAL':
    case 'LREAL':
      return 'e.g. 3.14'
    case 'TIME':
      return 'e.g. T#5s or 5000'
    case 'LTIME':
      return 'e.g. LTIME#5s or 5000000000'
    default:
      return 'Enter value...'
  }
}
