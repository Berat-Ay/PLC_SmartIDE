// S7 TIME / LTIME literal parsing. Single implementation used by the runtime, compiler and SCL interpreter.

const UNIT_MS: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 1e-3, ns: 1e-6 }
const UNIT_NS: Record<string, bigint> = {
  d: 86_400_000_000_000n,
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n
}

const LTIME_MIN_NS = -9223372036854775808n
const LTIME_MAX_NS = 9223372036854775807n

/**
 * Parses T#1h30m, TIME#500ms, T#1.5s, T#500us, T#1D_2H or a bare 10s into milliseconds.
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

  const token = /(\d+(?:\.\d+)?)_?(ms|us|ns|d|h|m|s)_?/iy
  let total = 0
  let matched = false
  while (token.lastIndex < s.length) {
    const m = token.exec(s)
    if (!m) return null
    total += parseFloat(m[1]) * UNIT_MS[m[2].toLowerCase()]
    matched = true
  }
  if (!matched || !Number.isFinite(total)) return null
  // Eliminate binary float drift while preserving sub-millisecond resolution (us/ns)
  return Math.round(sign * total * 1e6) / 1e6
}

/**
 * Parses LTIME#... / LT#... / TIME#... / T#... into signed 64-bit nanoseconds.
 * Clamps to S7 LTIME signed 64-bit range. Returns null when invalid.
 */
export function parseS7LTimeNs(raw: string): bigint | null {
  let s = raw.trim().replace(/^["']|["']$/g, '').trim()
  s = s.replace(/^(LTIME|TIME|LT|T)#/i, '')
  if (!s) return null

  let sign = 1n
  if (s.startsWith('-')) {
    sign = -1n
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }

  const token = /(\d+(?:\.\d+)?)_?(ms|us|ns|d|h|m|s)_?/iy
  let total = 0n
  let matched = false
  while (token.lastIndex < s.length) {
    const m = token.exec(s)
    if (!m) return null
    const unitNs = UNIT_NS[m[2].toLowerCase()]
    const numStr = m[1]
    const dotIdx = numStr.indexOf('.')
    if (dotIdx === -1) {
      total += BigInt(numStr) * unitNs
    } else {
      const whole = BigInt(numStr.slice(0, dotIdx) || '0')
      const fracStr = numStr.slice(dotIdx + 1).slice(0, 15).padEnd(15, '0')
      const scale = 1_000_000_000_000_000n
      const fracNs = (BigInt(fracStr) * unitNs + scale / 2n) / scale
      total += whole * unitNs + fracNs
    }
    matched = true
  }
  if (!matched) return null
  const signed = sign * total
  if (signed < LTIME_MIN_NS) return LTIME_MIN_NS
  if (signed > LTIME_MAX_NS) return LTIME_MAX_NS
  return signed
}
