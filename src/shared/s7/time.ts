// S7 TIME literal parsing. Single implementation used by the runtime, compiler and SCL interpreter.

const UNIT_MS: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }

/**
 * Parses T#1h30m, TIME#500ms, T#1.5s, T#1D_2H or a bare 10s into milliseconds.
 * Returns null when the text is not a valid time literal, so callers can report it.
 */
export function parseS7Time(raw: string): number | null {
  let s = raw.trim().replace(/^["']|["']$/g, '').trim()
  s = s.replace(/^(LTIME|TIME|LT|T)#/i, '')
  if (!s) return null

  let sign = 1
  if (s.startsWith('-')) {
    sign = -1
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }

  const token = /(\d+(?:\.\d+)?)_?(ms|d|h|m|s)_?/iy
  let total = 0
  let matched = false
  while (token.lastIndex < s.length) {
    const m = token.exec(s)
    if (!m) return null
    total += parseFloat(m[1]) * UNIT_MS[m[2].toLowerCase()]
    matched = true
  }
  return matched ? Math.round(sign * total) : null
}

/** True when the text is written as a time literal and should therefore parse. */
export function looksLikeTimeLiteral(raw: string): boolean {
  const s = raw.trim().replace(/^["']|["']$/g, '').trim()
  return /^(LTIME|TIME|LT|T)#/i.test(s) || /^\d+(\.\d+)?_?(ms|d|h|m|s)\b/i.test(s)
}
