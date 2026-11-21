import { parseS7Time } from './time'

export type OnlineValueParseResult =
  | { ok: true; value: string | number | boolean }
  | { ok: false; error: string }

function parseIntegerLiteral(raw: string): number | null {
  const s = raw.trim().replace(/_/g, '')
  if (!s) return null

  const s7Radix = s.match(/^(?:[A-Z]+#)?(16|8|2)#([0-9A-Fa-f]+)$/i)
  if (s7Radix) {
    const base = parseInt(s7Radix[1], 10)
    const digits = s7Radix[2]
    const validRe = base === 16 ? /^[0-9A-Fa-f]+$/ : base === 8 ? /^[0-7]+$/ : /^[01]+$/
    if (!validRe.test(digits)) return null
    return parseInt(digits, base)
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

/** Parses and validates user input for modifying an online tag or DB variable value. */
export function parseOnlineValue(rawInput: string, dataType: string): OnlineValueParseResult {
  const type = (dataType || '').trim().toUpperCase()
  const trimmed = rawInput.trim()

  if (type === 'STRING') {
    if (rawInput.length > 254) {
      return { ok: false, error: 'STRING exceeds maximum length of 254 characters.' }
    }
    return { ok: true, value: rawInput }
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

  if (type === 'INT' || type === 'DINT' || type === 'BYTE' || type === 'WORD' || type === 'DWORD') {
    const num = parseIntegerLiteral(trimmed)
    if (num === null) {
      return { ok: false, error: `Invalid ${type} integer value.` }
    }
    const ranges: Record<string, [number, number]> = {
      BYTE: [0, 255],
      WORD: [0, 65535],
      DWORD: [0, 4294967295],
      INT: [-32768, 32767],
      DINT: [-2147483648, 2147483647]
    }
    const [min, max] = ranges[type]
    if (num < min || num > max) {
      return { ok: false, error: `${type} value must be between ${min} and ${max}.` }
    }
    return { ok: true, value: num }
  }

  if (type === 'REAL' || type === 'LREAL') {
    const num = Number(trimmed)
    if (!Number.isFinite(num)) {
      return { ok: false, error: `Invalid ${type} floating-point number.` }
    }
    return { ok: true, value: num }
  }

  if (type === 'TIME') {
    if (/^[+-]?\d+$/.test(trimmed)) {
      const ms = Number(trimmed)
      if (!Number.isSafeInteger(ms) || ms < -2147483648 || ms > 2147483647) {
        return { ok: false, error: 'TIME millisecond value out of 32-bit range.' }
      }
      return { ok: true, value: ms }
    }
    const ms = parseS7Time(trimmed)
    if (ms === null) {
      return { ok: false, error: 'Invalid TIME literal. Use e.g. T#5s, TIME#500ms, or milliseconds.' }
    }
    return { ok: true, value: ms }
  }

  return { ok: true, value: trimmed }
}

/** Returns an input placeholder hint appropriate for the given S7 data type. */
export function getOnlineValuePlaceholder(dataType: string): string {
  switch ((dataType || '').trim().toUpperCase()) {
    case 'BOOL':
      return 'TRUE / FALSE'
    case 'BYTE':
      return 'e.g. 0..255 or 16#FF'
    case 'WORD':
      return 'e.g. 0..65535 or 16#00FF'
    case 'DWORD':
      return 'e.g. 0..4294967295 or 16#0000FFFF'
    case 'INT':
      return 'e.g. -100..32767'
    case 'DINT':
      return 'e.g. -2147483648..2147483647'
    case 'REAL':
    case 'LREAL':
      return 'e.g. 3.14'
    case 'TIME':
      return 'e.g. T#5s or 5000'
    case 'STRING':
      return 'Enter text...'
    default:
      return 'Enter value...'
  }
}
