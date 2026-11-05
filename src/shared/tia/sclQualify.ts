// Rewrites SCL statements to the explicit form TIA expects: locals as #name and globals as "name".
// The simulator accepts bare names, so sources written in the IDE may contain them.
import { BlockInterface } from '../types/blocks'

export interface SymbolContext {
  /** Lower-case names of tags, data blocks and code blocks. */
  globals: Set<string>
}

const RESERVED = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'RETURN', 'EXIT', 'CONTINUE', 'AND', 'OR', 'XOR',
  'NOT', 'MOD', 'TRUE', 'FALSE', 'GOTO', 'REGION', 'END_REGION'
])

function interfaceNames(iface: BlockInterface): Set<string> {
  const names = new Set<string>()
  for (const section of [iface.input, iface.output, iface.inOut, iface.static, iface.temp, iface.constant]) {
    for (const v of section || []) names.add(v.name.toLowerCase())
  }
  return names
}

/** Copies the text and only changes identifiers outside comments, strings and quoted names. */
export function qualifySclBody(body: string, iface: BlockInterface, blockName: string, symbols: SymbolContext): string {
  const locals = interfaceNames(iface)
  let out = ''
  let i = 0
  let parenDepth = 0
  let lastSignificant = ''

  const copyUntil = (end: string): void => {
    const close = body.indexOf(end, i + 1)
    const stop = close < 0 ? body.length : close + end.length
    out += body.slice(i, stop)
    i = stop
  }

  while (i < body.length) {
    const c = body[i]
    const next = body[i + 1]

    if (c === '/' && next === '/') {
      const newline = body.indexOf('\n', i)
      const stop = newline < 0 ? body.length : newline
      out += body.slice(i, stop)
      i = stop
      continue
    }
    if (c === '(' && next === '*') {
      copyUntil('*)')
      continue
    }
    if (c === '{') {
      copyUntil('}')
      continue
    }
    if (c === '"' || c === "'") {
      copyUntil(c)
      lastSignificant = c
      continue
    }
    if (/\s/.test(c)) {
      out += c
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      const literal = body.slice(i).match(/^[0-9][0-9A-Za-z_#.]*(?:[eE][+-]?[0-9]+)?/)
      let text = literal ? literal[0] : c
      if (text.includes('..')) text = text.slice(0, text.indexOf('..'))
      out += text
      i += text.length
      lastSignificant = '0'
      continue
    }

    if (/[A-Za-z_#%]/.test(c)) {
      const match = body.slice(i).match(/^[A-Za-z0-9_#%]+/)
      const word = match ? match[0] : c
      i += word.length

      const rest = body.slice(i)
      const following = rest.match(/^\s*(:=|=>|\(|\.)?/)?.[1]
      const isCallParameter = parenDepth > 0 && (following === ':=' || following === '=>')
      const isMember = lastSignificant === '.'
      const isLiteralOrPrefixed = word.includes('#') || word.startsWith('%')
      const lower = word.toLowerCase()

      if (isMember || isCallParameter || isLiteralOrPrefixed || RESERVED.has(word.toUpperCase())) {
        out += word
      } else if (lower === blockName.toLowerCase()) {
        out += `"${word}"`
      } else if (locals.has(lower)) {
        out += `#${word}`
      } else if (symbols.globals.has(lower)) {
        out += `"${word}"`
      } else {
        out += word
      }
      lastSignificant = word
      continue
    }

    if (c === '(') parenDepth++
    if (c === ')') parenDepth = Math.max(0, parenDepth - 1)
    out += c
    i++
    lastSignificant = c
  }
  return out
}
