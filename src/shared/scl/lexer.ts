// SCL lexer: converts source text to tokens. No parsing or execution lives here.
import { SclToken } from './ast'

export class SclLexer {
  private static readonly KEYWORDS = new Set([
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_STAT', 'VAR_CONSTANT', 'END_VAR',
    'BEGIN', 'ORGANIZATION_BLOCK', 'FUNCTION_BLOCK', 'FUNCTION',
    'END_ORGANIZATION_BLOCK', 'END_FUNCTION_BLOCK', 'END_FUNCTION',
    'REGION', 'END_REGION',
    'RETURN', 'EXIT', 'CONTINUE',
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    'TRUE', 'FALSE'
  ])

  public static tokenize(code: string): { tokens: SclToken[]; errors: string[] } {
    const tokens: SclToken[] = []
    const errors: string[] = []
    let i = 0
    let line = 1
    let col = 1

    const advance = () => {
      if (code[i] === '\n') {
        line++
        col = 1
      } else {
        col++
      }
      i++
    }

    while (i < code.length) {
      const ch = code[i]

      // Whitespace
      if (/\s/.test(ch)) {
        advance()
        continue
      }

      // Line comments: // ...
      if (ch === '/' && code[i + 1] === '/') {
        while (i < code.length && code[i] !== '\n') advance()
        continue
      }

      // Block comments: (* ... *)
      if (ch === '(' && code[i + 1] === '*') {
        advance()
        advance()
        while (i < code.length && !(code[i] === '*' && code[i + 1] === ')')) {
          advance()
        }
        if (i < code.length) {
          advance()
          advance()
        } else {
          errors.push(`Line ${line}: Unclosed block comment '(*'`)
        }
        continue
      }

      // Pragmas & Block Attributes: { S7_Optimized_Access := 'TRUE' }
      if (ch === '{') {
        advance()
        while (i < code.length && code[i] !== '}') {
          advance()
        }
        if (i < code.length && code[i] === '}') {
          advance()
        } else {
          errors.push(`Line ${line}: Unclosed pragma '{'`)
        }
        continue
      }

      const startLine = line
      const startCol = col

      // Two-character punctuation & operators: :=, <=, >=, <>, .., =>
      const two = code.substring(i, i + 2)
      if ([':=', '<=', '>=', '<>', '..', '=>', '**'].includes(two)) {
        tokens.push({ type: 'OPERATOR', value: two, line: startLine, col: startCol })
        advance()
        advance()
        continue
      }

      // Single-character operators & punctuation
      if ([';', ':', ',', '(', ')', '[', ']', '.', '+', '-', '*', '/', '=', '<', '>', '&'].includes(ch)) {
        const type = [';', ':', ',', '(', ')', '[', ']', '.'].includes(ch) ? 'PUNCTUATION' : 'OPERATOR'
        tokens.push({ type, value: ch, line: startLine, col: startCol })
        advance()
        continue
      }

      // Double-quoted strings / identifiers e.g. "TankLevel_Raw"
      if (ch === '"') {
        advance()
        let str = ''
        while (i < code.length && code[i] !== '"') {
          str += code[i]
          advance()
        }
        if (i < code.length && code[i] === '"') {
          advance()
          tokens.push({ type: 'IDENTIFIER', value: str, line: startLine, col: startCol, quoted: true })
        } else {
          errors.push(`Line ${startLine}: Unclosed string literal '"'`)
        }
        continue
      }

      // Single-quoted character strings with S7 $ escape sequences e.g. 'Pump$'s $N'
      if (ch === "'") {
        advance()
        let str = ''
        while (i < code.length && code[i] !== "'") {
          if (code[i] === '$' && i + 1 < code.length) {
            const esc = code[i + 1]
            if (esc === "'" || esc === '$') {
              str += esc
              advance()
              advance()
              continue
            }
            const upperEsc = esc.toUpperCase()
            if (upperEsc === 'L' || upperEsc === 'N') {
              str += '\n'
              advance()
              advance()
              continue
            }
            if (upperEsc === 'R') {
              str += '\r'
              advance()
              advance()
              continue
            }
            if (upperEsc === 'T') {
              str += '\t'
              advance()
              advance()
              continue
            }
            if (upperEsc === 'P') {
              str += '\f'
              advance()
              advance()
              continue
            }
            const hex = code.substring(i + 1, i + 3)
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
              str += String.fromCharCode(parseInt(hex, 16))
              advance()
              advance()
              advance()
              continue
            }
          }
          str += code[i]
          advance()
        }
        if (i < code.length && code[i] === "'") {
          advance()
          tokens.push({ type: 'STRING', value: str, line: startLine, col: startCol })
        } else {
          errors.push(`Line ${startLine}: Unclosed string literal '\''`)
        }
        continue
      }

      // Time literal e.g. T#5s, T#-5s, T#500ms, TIME#1m, LTIME#1s
      const timePrefixMatch = code.substring(i).match(/^(LTIME|TIME|LT|T)#/i)
      if (timePrefixMatch) {
        let timeStr = ''
        for (let k = 0; k < timePrefixMatch[0].length; k++) {
          timeStr += code[i]
          advance()
        }
        if (i < code.length && (code[i] === '-' || code[i] === '+')) {
          timeStr += code[i]
          advance()
        }
        while (i < code.length && (/[A-Za-z0-9_#]/.test(code[i]) || (code[i] === '.' && /[0-9]/.test(code[i + 1] || '')))) {
          timeStr += code[i]
          advance()
        }
        tokens.push({ type: 'TIME', value: timeStr, line: startLine, col: startCol })
        continue
      }

      // Number literal (Integer or Real float)
      if (/[0-9]/.test(ch)) {
        // Radix literals: 16#FF, 8#17, 2#1010
        const radixLiteral = code.substring(i).match(/^(16|8|2)#([0-9A-Za-z_]+)/)
        if (radixLiteral) {
          const base = parseInt(radixLiteral[1], 10)
          const digits = radixLiteral[2].replace(/_/g, '')
          const validRe = base === 16 ? /^[0-9A-Fa-f]+$/ : base === 8 ? /^[0-7]+$/ : /^[01]+$/
          for (let n = 0; n < radixLiteral[0].length; n++) advance()
          if (!validRe.test(digits)) {
            errors.push(`Line ${startLine}: Invalid base-${base} digit in literal '${radixLiteral[0]}'`)
          } else {
            tokens.push({
              type: 'NUMBER',
              value: String(parseInt(digits, base)),
              line: startLine,
              col: startCol
            })
          }
          continue
        }

        let numStr = ''
        let hasDot = false
        while (i < code.length && (/[0-9_]/.test(code[i]) || (code[i] === '.' && code[i + 1] !== '.'))) {
          if (code[i] === '.') {
            if (hasDot) break
            hasDot = true
          }
          numStr += code[i]
          advance()
        }
        // Exponent: 1.5E3, 2E-1
        const exponent = code.substring(i).match(/^[eE][+-]?[0-9_]+/)
        if (exponent) {
          numStr += exponent[0]
          hasDot = true
          for (let n = 0; n < exponent[0].length; n++) advance()
        }
        tokens.push({
          type: hasDot ? 'REAL' : 'NUMBER',
          value: numStr.replace(/_/g, ''),
          line: startLine,
          col: startCol
        })
        continue
      }

      // Identifiers & Keywords (allows leading #, %, letters, underscores)
      if (/[a-zA-Z_#%]/.test(ch)) {
        let idStr = ''
        while (i < code.length) {
          const curChar = code[i]
          if (curChar === '.' && code[i + 1] === '.') break
          if (/[a-zA-Z0-9_#%.]/.test(curChar)) {
            idStr += curChar
            advance()
            continue
          }
          if (!idStr.startsWith('#') && idStr.endsWith('#') && (curChar === '+' || curChar === '-')) {
            idStr += curChar
            advance()
            continue
          }
          if (!idStr.startsWith('#') && idStr.includes('#') && /[eE]$/.test(idStr) && (curChar === '+' || curChar === '-')) {
            idStr += curChar
            advance()
            continue
          }
          break
        }
        const upper = idStr.toUpperCase()

        // Typed literals: INT#-5, REAL#1.5, WORD#16#FF_00, BOOL#1. The '#' prefix of a local is not a type.
        const typed = !idStr.startsWith('#') && idStr.match(/^[A-Za-z_][A-Za-z0-9_]*#(.+)$/)
        if (typed && /^(D|DATE|TOD|TIME_OF_DAY|DT|DATE_AND_TIME|DTL|S5T|S5TIME)#/.test(upper)) {
          errors.push(`Line ${startLine}: Literal '${idStr}' is not supported by the simulator yet`)
          continue
        }
        if (typed) {
          const payload = typed[1]
          const radix = payload.match(/^([+-]?)(16|8|2)#([0-9A-Za-z_]+)$/)
          if (radix) {
            const sign = radix[1] === '-' ? -1 : 1
            const base = parseInt(radix[2], 10)
            const digits = radix[3].replace(/_/g, '')
            const validRe = base === 16 ? /^[0-9A-Fa-f]+$/ : base === 8 ? /^[0-7]+$/ : /^[01]+$/
            if (!validRe.test(digits)) {
              errors.push(`Line ${startLine}: Invalid base-${base} digit in literal '${idStr}'`)
              continue
            }
            tokens.push({ type: 'NUMBER', value: String(sign * parseInt(digits, base)), line: startLine, col: startCol })
            continue
          }
          const numeric = payload.replace(/_/g, '')
          if (upper.startsWith('BOOL#')) {
            const isTrue = numeric === '1' || numeric.toUpperCase() === 'TRUE'
            tokens.push({ type: 'KEYWORD', value: isTrue ? 'TRUE' : 'FALSE', line: startLine, col: startCol })
          } else {
            tokens.push({ type: /[.eE]/.test(numeric) ? 'REAL' : 'NUMBER', value: numeric, line: startLine, col: startCol })
          }
          continue
        }

        if (SclLexer.KEYWORDS.has(upper)) {
          tokens.push({ type: 'KEYWORD', value: upper, line: startLine, col: startCol })
        } else {
          tokens.push({ type: 'IDENTIFIER', value: idStr, line: startLine, col: startCol })
        }
        continue
      }

      // Unknown character fallback
      errors.push(`Line ${line}, col ${col}: Unexpected character '${ch}'`)
      advance()
    }

    tokens.push({ type: 'EOF', value: '', line, col })
    return { tokens, errors }
  }
}
