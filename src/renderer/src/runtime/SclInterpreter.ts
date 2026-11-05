// Siemens IEC 61131-3 Structured Control Language (SCL) Recursive-Descent Lexer, AST Parser & Runtime Engine

export interface SclExecutionContext {
  getVar: (symbol: string) => unknown
  setVar: (symbol: string, value: unknown) => void
  callFunction?: (name: string, args: Record<string, unknown>) => unknown
  lineValues?: Record<number, string | number> // lineNumber -> display value for online monitoring
}

export type SclTokenType =
  | 'KEYWORD'
  | 'IDENTIFIER'
  | 'NUMBER'
  | 'REAL'
  | 'STRING'
  | 'TIME'
  | 'OPERATOR'
  | 'PUNCTUATION'
  | 'EOF'

export interface SclToken {
  type: SclTokenType
  value: string
  line: number
  col: number
}

// -----------------------------------------------------------------------------
// AST Node Interfaces
// -----------------------------------------------------------------------------

export type SclStatement =
  | SclAssignStatement
  | SclIfStatement
  | SclCaseStatement
  | SclForStatement
  | SclWhileStatement
  | SclRepeatStatement
  | SclCallStatement
  | SclReturnStatement
  | SclExitStatement

export interface SclAssignStatement {
  kind: 'assign'
  line: number
  target: string
  expression: SclExpression
}

export interface SclIfStatement {
  kind: 'if'
  line: number
  condition: SclExpression
  thenStatements: SclStatement[]
  elsifBranches: Array<{ condition: SclExpression; statements: SclStatement[]; line: number }>
  elseStatements?: SclStatement[]
}

export interface SclCaseStatement {
  kind: 'case'
  line: number
  selector: SclExpression
  cases: Array<{ values: Array<number | { from: number; to: number }>; statements: SclStatement[]; line: number }>
  elseStatements?: SclStatement[]
}

export interface SclForStatement {
  kind: 'for'
  line: number
  iterVar: string
  startExpr: SclExpression
  endExpr: SclExpression
  stepExpr?: SclExpression
  body: SclStatement[]
}

export interface SclWhileStatement {
  kind: 'while'
  line: number
  condition: SclExpression
  body: SclStatement[]
}

export interface SclRepeatStatement {
  kind: 'repeat'
  line: number
  condition: SclExpression
  body: SclStatement[]
}

export interface SclCallStatement {
  kind: 'call'
  line: number
  callee: string
  args: Record<string, SclExpression>
}

export interface SclReturnStatement {
  kind: 'return'
  line: number
}

export interface SclExitStatement {
  kind: 'exit'
  line: number
}

// Expressions
export type SclExpression =
  | SclLiteralExpr
  | SclVariableExpr
  | SclUnaryExpr
  | SclBinaryExpr
  | SclCallExpr

export interface SclLiteralExpr {
  kind: 'literal'
  value: unknown
  raw: string
  line: number
}

export interface SclVariableExpr {
  kind: 'variable'
  name: string
  line: number
}

export interface SclUnaryExpr {
  kind: 'unary'
  op: 'NOT' | '-' | '+'
  expr: SclExpression
  line: number
}

export interface SclBinaryExpr {
  kind: 'binary'
  op: string
  left: SclExpression
  right: SclExpression
  line: number
}

export interface SclCallExpr {
  kind: 'call_expr'
  callee: string
  args: Record<string, SclExpression>
  line: number
}

// -----------------------------------------------------------------------------
// SCL Lexer (Tokenizer)
// -----------------------------------------------------------------------------

export class SclLexer {
  private static readonly KEYWORDS = new Set([
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_STAT', 'END_VAR',
    'BEGIN', 'ORGANIZATION_BLOCK', 'FUNCTION_BLOCK', 'FUNCTION',
    'END_ORGANIZATION_BLOCK', 'END_FUNCTION_BLOCK', 'END_FUNCTION',
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
      if ([':=', '<=', '>=', '<>', '..', '=>'].includes(two)) {
        tokens.push({ type: 'OPERATOR', value: two, line: startLine, col: startCol })
        advance()
        advance()
        continue
      }

      // Single-character operators & punctuation
      if ([';', ':', ',', '(', ')', '[', ']', '.', '+', '-', '*', '/', '=', '<', '>'].includes(ch)) {
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
          tokens.push({ type: 'IDENTIFIER', value: str, line: startLine, col: startCol })
        } else {
          errors.push(`Line ${startLine}: Unclosed string literal '"'`)
        }
        continue
      }

      // Single-quoted character strings e.g. 'Pump Active'
      if (ch === "'") {
        advance()
        let str = ''
        while (i < code.length && code[i] !== "'") {
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

      // Time literal e.g. T#5s, T#500ms, TIME#1m
      if (
        (ch === 'T' || ch === 't') &&
        (code.substring(i, i + 2).toUpperCase() === 'T#' || code.substring(i, i + 5).toUpperCase() === 'TIME#')
      ) {
        let timeStr = ''
        while (i < code.length && /[A-Za-z0-9_#]/.test(code[i])) {
          timeStr += code[i]
          advance()
        }
        tokens.push({ type: 'TIME', value: timeStr, line: startLine, col: startCol })
        continue
      }

      // Number literal (Integer or Real float)
      if (/[0-9]/.test(ch)) {
        let numStr = ''
        let hasDot = false
        while (i < code.length && (/[0-9]/.test(code[i]) || (code[i] === '.' && code[i + 1] !== '.'))) {
          if (code[i] === '.') {
            if (hasDot) break
            hasDot = true
          }
          numStr += code[i]
          advance()
        }
        tokens.push({
          type: hasDot ? 'REAL' : 'NUMBER',
          value: numStr,
          line: startLine,
          col: startCol
        })
        continue
      }

      // Identifiers & Keywords (allows leading #, %, letters, underscores)
      if (/[a-zA-Z_#%]/.test(ch)) {
        let idStr = ''
        while (i < code.length && /[a-zA-Z0-9_#%.]/.test(code[i])) {
          // If dot is part of range '..' stop
          if (code[i] === '.' && code[i + 1] === '.') break
          idStr += code[i]
          advance()
        }
        const upper = idStr.toUpperCase()
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

// -----------------------------------------------------------------------------
// SCL Parser (Recursive-Descent)
// -----------------------------------------------------------------------------

export class SclParser {
  private tokens: SclToken[] = []
  private pos = 0
  public errors: string[] = []

  constructor(tokens: SclToken[]) {
    this.tokens = tokens
  }

  private current(): SclToken {
    return this.tokens[this.pos] || { type: 'EOF', value: '', line: 0, col: 0 }
  }

  private peek(): SclToken {
    return this.tokens[this.pos + 1] || { type: 'EOF', value: '', line: 0, col: 0 }
  }

  private advance(): SclToken {
    const t = this.current()
    if (this.pos < this.tokens.length - 1) this.pos++
    return t
  }

  private matchKeyword(kw: string): boolean {
    const cur = this.current()
    if (cur.type === 'KEYWORD' && cur.value.toUpperCase() === kw.toUpperCase()) {
      this.advance()
      return true
    }
    return false
  }

  private matchOperator(op: string): boolean {
    const cur = this.current()
    if ((cur.type === 'OPERATOR' || cur.type === 'PUNCTUATION') && cur.value === op) {
      this.advance()
      return true
    }
    return false
  }

  private expect(expected: string): boolean {
    const cur = this.current()
    if (cur.value.toUpperCase() === expected.toUpperCase()) {
      this.advance()
      return true
    }
    this.errors.push(`Line ${cur.line}: Expected '${expected}', found '${cur.value}'`)
    return false
  }

  private parseQualifiedIdentifier(): string {
    let name = this.current().value
    this.advance()

    while (this.current().value === '.' || this.current().value === '[') {
      if (this.current().value === '.') {
        this.advance() // consume '.'
        if (
          this.current().type === 'IDENTIFIER' ||
          this.current().type === 'KEYWORD' ||
          this.current().type === 'NUMBER'
        ) {
          name += '.' + this.current().value
          this.advance()
        } else {
          this.errors.push(`Line ${this.current().line}: Expected identifier after '.'`)
          break
        }
      } else if (this.current().value === '[') {
        this.advance() // consume '['
        let idx = ''
        while (this.current().type !== 'EOF' && this.current().value !== ']') {
          idx += this.current().value
          this.advance()
        }
        if (this.current().value === ']') this.advance()
        name += `[${idx}]`
      }
    }
    return name
  }

  public parseProgram(): SclStatement[] {
    const statements: SclStatement[] = []
    let inHeader = false

    while (this.current().type !== 'EOF') {
      const cur = this.current()

      // Skip Block Headers: ORGANIZATION_BLOCK ... BEGIN ... END_ORGANIZATION_BLOCK
      if (
        cur.type === 'KEYWORD' &&
        ['ORGANIZATION_BLOCK', 'FUNCTION_BLOCK', 'FUNCTION'].includes(cur.value)
      ) {
        this.advance()
        // Skip block name and header tokens until BEGIN or VAR
        while (this.current().type !== 'EOF' && !['BEGIN', 'VAR', 'VAR_INPUT', 'VAR_TEMP'].includes(this.current().value)) {
          this.advance()
        }
        continue
      }

      if (cur.type === 'KEYWORD' && cur.value.startsWith('VAR')) {
        inHeader = true
        this.advance()
        continue
      }

      if (cur.type === 'KEYWORD' && cur.value === 'END_VAR') {
        inHeader = false
        this.advance()
        continue
      }

      if (inHeader) {
        this.advance()
        continue
      }

      if (cur.type === 'KEYWORD' && cur.value === 'BEGIN') {
        this.advance()
        continue
      }

      if (
        cur.type === 'KEYWORD' &&
        ['END_ORGANIZATION_BLOCK', 'END_FUNCTION_BLOCK', 'END_FUNCTION'].includes(cur.value)
      ) {
        this.advance()
        break
      }

      const stmt = this.parseStatement()
      if (stmt) {
        statements.push(stmt)
      } else {
        // Skip to next semicolon to synchronize parser
        while (this.current().type !== 'EOF' && this.current().value !== ';') {
          this.advance()
        }
        if (this.current().value === ';') this.advance()
      }
    }

    return statements
  }

  public parseStatement(): SclStatement | null {
    const cur = this.current()

    // 1. IF statement
    if (this.matchKeyword('IF')) {
      const startLine = cur.line
      const cond = this.parseExpression()
      this.expect('THEN')

      const thenStmts: SclStatement[] = []
      const elsifBranches: SclIfStatement['elsifBranches'] = []
      let elseStmts: SclStatement[] | undefined = undefined

      while (
        this.current().type !== 'EOF' &&
        !['ELSIF', 'ELSE', 'END_IF'].includes(this.current().value)
      ) {
        const s = this.parseStatement()
        if (s) thenStmts.push(s)
      }

      while (this.matchKeyword('ELSIF')) {
        const branchLine = this.current().line
        const elsifCond = this.parseExpression()
        this.expect('THEN')
        const branchStmts: SclStatement[] = []
        while (
          this.current().type !== 'EOF' &&
          !['ELSIF', 'ELSE', 'END_IF'].includes(this.current().value)
        ) {
          const s = this.parseStatement()
          if (s) branchStmts.push(s)
        }
        elsifBranches.push({ condition: elsifCond, statements: branchStmts, line: branchLine })
      }

      if (this.matchKeyword('ELSE')) {
        elseStmts = []
        while (this.current().type !== 'EOF' && this.current().value !== 'END_IF') {
          const s = this.parseStatement()
          if (s) elseStmts.push(s)
        }
      }

      this.expect('END_IF')
      if (this.current().value === ';') this.advance()

      return {
        kind: 'if',
        line: startLine,
        condition: cond,
        thenStatements: thenStmts,
        elsifBranches,
        elseStatements: elseStmts
      }
    }

    // 2. CASE statement
    if (this.matchKeyword('CASE')) {
      const startLine = cur.line
      const selector = this.parseExpression()
      this.expect('OF')

      const cases: SclCaseStatement['cases'] = []
      let elseStmts: SclStatement[] | undefined = undefined

      while (this.current().type !== 'EOF' && !['ELSE', 'END_CASE'].includes(this.current().value)) {
        const caseLine = this.current().line
        const vals: Array<number | { from: number; to: number }> = []

        // Parse case values e.g. 1: or 2, 3: or 10..20:
        while (this.current().type !== 'EOF' && this.current().value !== ':') {
          const v = Number(this.current().value) || 0
          this.advance()

          if (this.current().value === '..') {
            this.advance()
            const vTo = Number(this.current().value) || v
            this.advance()
            vals.push({ from: v, to: vTo })
          } else {
            vals.push(v)
          }

          if (this.current().value === ',') this.advance()
        }
        this.expect(':')

        const caseStmts: SclStatement[] = []
        while (
          this.current().type !== 'EOF' &&
          !['ELSE', 'END_CASE'].includes(this.current().value) &&
          !(this.current().type === 'NUMBER' && (this.peek().value === ':' || this.peek().value === ',' || this.peek().value === '..'))
        ) {
          const s = this.parseStatement()
          if (s) caseStmts.push(s)
        }

        cases.push({ values: vals, statements: caseStmts, line: caseLine })
      }

      if (this.matchKeyword('ELSE')) {
        elseStmts = []
        while (this.current().type !== 'EOF' && this.current().value !== 'END_CASE') {
          const s = this.parseStatement()
          if (s) elseStmts.push(s)
        }
      }

      this.expect('END_CASE')
      if (this.current().value === ';') this.advance()

      return {
        kind: 'case',
        line: startLine,
        selector,
        cases,
        elseStatements: elseStmts
      }
    }

    // 3. FOR loop
    if (this.matchKeyword('FOR')) {
      const startLine = cur.line
      const iterVar = this.current().value
      this.advance()
      this.expect(':=')
      const startExpr = this.parseExpression()
      this.expect('TO')
      const endExpr = this.parseExpression()
      let stepExpr: SclExpression | undefined = undefined
      if (this.matchKeyword('BY')) {
        stepExpr = this.parseExpression()
      }
      this.expect('DO')

      const body: SclStatement[] = []
      while (this.current().type !== 'EOF' && this.current().value !== 'END_FOR') {
        const s = this.parseStatement()
        if (s) body.push(s)
      }
      this.expect('END_FOR')
      if (this.current().value === ';') this.advance()

      return {
        kind: 'for',
        line: startLine,
        iterVar,
        startExpr,
        endExpr,
        stepExpr,
        body
      }
    }

    // 4. WHILE loop
    if (this.matchKeyword('WHILE')) {
      const startLine = cur.line
      const cond = this.parseExpression()
      this.expect('DO')

      const body: SclStatement[] = []
      while (this.current().type !== 'EOF' && this.current().value !== 'END_WHILE') {
        const s = this.parseStatement()
        if (s) body.push(s)
      }
      this.expect('END_WHILE')
      if (this.current().value === ';') this.advance()

      return {
        kind: 'while',
        line: startLine,
        condition: cond,
        body
      }
    }

    // 5. REPEAT loop
    if (this.matchKeyword('REPEAT')) {
      const startLine = cur.line
      const body: SclStatement[] = []
      while (this.current().type !== 'EOF' && this.current().value !== 'UNTIL') {
        const s = this.parseStatement()
        if (s) body.push(s)
      }
      this.expect('UNTIL')
      const cond = this.parseExpression()
      this.expect('END_REPEAT')
      if (this.current().value === ';') this.advance()

      return {
        kind: 'repeat',
        line: startLine,
        condition: cond,
        body
      }
    }

    // 6. RETURN / EXIT
    if (this.matchKeyword('RETURN')) {
      if (this.current().value === ';') this.advance()
      return { kind: 'return', line: cur.line }
    }
    if (this.matchKeyword('EXIT')) {
      if (this.current().value === ';') this.advance()
      return { kind: 'exit', line: cur.line }
    }

    // 7. Assignment or Function Call
    if (cur.type === 'IDENTIFIER') {
      const startLine = cur.line
      const name = this.parseQualifiedIdentifier()

      // Assignment: target := expression;
      if (this.matchOperator(':=')) {
        const expr = this.parseExpression()
        if (this.current().value === ';') this.advance()
        return {
          kind: 'assign',
          line: startLine,
          target: name,
          expression: expr
        }
      }

      // Function Call statement: CallName(a := 1, b => 2);
      if (this.matchOperator('(')) {
        const args: Record<string, SclExpression> = {}
        while (this.current().type !== 'EOF' && this.current().value !== ')') {
          let paramName = ''
          if (this.peek().value === ':=' || this.peek().value === '=>') {
            paramName = this.current().value
            this.advance()
            this.advance() // skip := or =>
          } else {
            paramName = `arg_${Object.keys(args).length}`
          }
          const valExpr = this.parseExpression()
          args[paramName] = valExpr
          if (this.current().value === ',') this.advance()
        }
        this.expect(')')
        if (this.current().value === ';') this.advance()

        return {
          kind: 'call',
          line: startLine,
          callee: name,
          args
        }
      }
    }

    // Bare semicolon
    if (this.current().value === ';') {
      this.advance()
      return null
    }

    this.advance()
    return null
  }

  // Expression Parsing with Operator Precedence
  public parseExpression(): SclExpression {
    return this.parseLogicalOr()
  }

  private parseLogicalOr(): SclExpression {
    let left = this.parseLogicalXor()
    while (this.current().type === 'KEYWORD' && this.current().value === 'OR') {
      const opLine = this.current().line
      this.advance()
      const right = this.parseLogicalXor()
      left = { kind: 'binary', op: 'OR', left, right, line: opLine }
    }
    return left
  }

  private parseLogicalXor(): SclExpression {
    let left = this.parseLogicalAnd()
    while (this.current().type === 'KEYWORD' && this.current().value === 'XOR') {
      const opLine = this.current().line
      this.advance()
      const right = this.parseLogicalAnd()
      left = { kind: 'binary', op: 'XOR', left, right, line: opLine }
    }
    return left
  }

  private parseLogicalAnd(): SclExpression {
    let left = this.parseComparison()
    while (
      (this.current().type === 'KEYWORD' && this.current().value === 'AND') ||
      this.current().value === '&'
    ) {
      const opLine = this.current().line
      this.advance()
      const right = this.parseComparison()
      left = { kind: 'binary', op: 'AND', left, right, line: opLine }
    }
    return left
  }

  private parseComparison(): SclExpression {
    let left = this.parseAdditive()
    const compOps = ['=', '<>', '<', '>', '<=', '>=']
    while (compOps.includes(this.current().value)) {
      const op = this.current().value
      const opLine = this.current().line
      this.advance()
      const right = this.parseAdditive()
      left = { kind: 'binary', op, left, right, line: opLine }
    }
    return left
  }

  private parseAdditive(): SclExpression {
    let left = this.parseMultiplicative()
    while (['+', '-'].includes(this.current().value)) {
      const op = this.current().value
      const opLine = this.current().line
      this.advance()
      const right = this.parseMultiplicative()
      left = { kind: 'binary', op, left, right, line: opLine }
    }
    return left
  }

  private parseMultiplicative(): SclExpression {
    let left = this.parseUnary()
    while (
      ['*', '/'].includes(this.current().value) ||
      (this.current().type === 'KEYWORD' && this.current().value === 'MOD')
    ) {
      const op = this.current().value
      const opLine = this.current().line
      this.advance()
      const right = this.parseUnary()
      left = { kind: 'binary', op, left, right, line: opLine }
    }
    return left
  }

  private parseUnary(): SclExpression {
    const cur = this.current()
    if (cur.type === 'KEYWORD' && cur.value === 'NOT') {
      this.advance()
      return { kind: 'unary', op: 'NOT', expr: this.parseUnary(), line: cur.line }
    }
    if (cur.value === '-' || cur.value === '+') {
      this.advance()
      return { kind: 'unary', op: cur.value as '-' | '+', expr: this.parseUnary(), line: cur.line }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): SclExpression {
    const cur = this.current()

    // Parentheses
    if (this.matchOperator('(')) {
      const expr = this.parseExpression()
      this.expect(')')
      return expr
    }

    // Literals
    if (cur.type === 'NUMBER') {
      this.advance()
      return { kind: 'literal', value: Number(cur.value), raw: cur.value, line: cur.line }
    }
    if (cur.type === 'REAL') {
      this.advance()
      return { kind: 'literal', value: parseFloat(cur.value), raw: cur.value, line: cur.line }
    }
    if (cur.type === 'TIME') {
      this.advance()
      return { kind: 'literal', value: cur.value, raw: cur.value, line: cur.line }
    }
    if (cur.type === 'STRING') {
      this.advance()
      return { kind: 'literal', value: cur.value, raw: cur.value, line: cur.line }
    }
    if (cur.type === 'KEYWORD' && (cur.value === 'TRUE' || cur.value === 'FALSE')) {
      this.advance()
      return { kind: 'literal', value: cur.value === 'TRUE', raw: cur.value, line: cur.line }
    }

    // Function Call or Variable Identifier
    if (cur.type === 'IDENTIFIER') {
      const name = this.parseQualifiedIdentifier()

      if (this.current().value === '(') {
        this.advance()
        const args: Record<string, SclExpression> = {}
        while (this.current().type !== 'EOF' && this.current().value !== ')') {
          let paramName = ''
          if (this.peek().value === ':=' || this.peek().value === '=>') {
            paramName = this.current().value
            this.advance()
            this.advance()
          } else {
            paramName = `arg_${Object.keys(args).length}`
          }
          const valExpr = this.parseExpression()
          args[paramName] = valExpr
          if (this.current().value === ',') this.advance()
        }
        this.expect(')')
        return { kind: 'call_expr', callee: name, args, line: cur.line }
      }

      return { kind: 'variable', name, line: cur.line }
    }

    this.advance()
    return { kind: 'literal', value: 0, raw: '0', line: cur.line }
  }
}

// -----------------------------------------------------------------------------
// SclInterpreter Main Facade & Runtime Evaluator
// -----------------------------------------------------------------------------

export class SclInterpreter {
  // Edge trigger instance memory (R_TRIG / F_TRIG instances)
  private static edgeTriggerStates = new Map<string, { prevClk: boolean }>()

  public static resetEdgeStates(): void {
    this.edgeTriggerStates.clear()
  }

  /**
   * Executes SCL source code within the provided PLC execution context
   */
  public static execute(
    sclCode: string,
    context: SclExecutionContext
  ): { success: boolean; error?: string } {
    try {
      const { tokens, errors: lexErrors } = SclLexer.tokenize(sclCode)
      if (lexErrors.length > 0) {
        return { success: false, error: lexErrors.join('; ') }
      }

      const parser = new SclParser(tokens)
      const statements = parser.parseProgram()
      if (parser.errors.length > 0) {
        return { success: false, error: parser.errors.join('; ') }
      }

      for (const stmt of statements) {
        this.executeNode(stmt, context)
      }

      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message }
    }
  }

  private static executeNode(
    stmt: SclStatement,
    context: SclExecutionContext,
    loopGuard = { count: 0 }
  ): 'NORMAL' | 'EXIT' | 'RETURN' {
    switch (stmt.kind) {
      case 'assign': {
        const val = this.evaluateNode(stmt.expression, context)
        context.setVar(stmt.target, val)
        if (context.lineValues) {
          context.lineValues[stmt.line] =
            typeof val === 'number' ? Math.round(val * 100) / 100 : String(val)
        }
        return 'NORMAL'
      }

      case 'if': {
        const condVal = !!this.evaluateNode(stmt.condition, context)
        if (context.lineValues) {
          context.lineValues[stmt.line] = condVal ? 'TRUE' : 'FALSE'
        }

        if (condVal) {
          for (const s of stmt.thenStatements) {
            const res = this.executeNode(s, context, loopGuard)
            if (res !== 'NORMAL') return res
          }
          return 'NORMAL'
        }

        // ELSIF branches
        for (const branch of stmt.elsifBranches) {
          const elsifCond = !!this.evaluateNode(branch.condition, context)
          if (context.lineValues) {
            context.lineValues[branch.line] = elsifCond ? 'TRUE' : 'FALSE'
          }
          if (elsifCond) {
            for (const s of branch.statements) {
              const res = this.executeNode(s, context, loopGuard)
              if (res !== 'NORMAL') return res
            }
            return 'NORMAL'
          }
        }

        // ELSE branch
        if (stmt.elseStatements) {
          for (const s of stmt.elseStatements) {
            const res = this.executeNode(s, context, loopGuard)
            if (res !== 'NORMAL') return res
          }
        }
        return 'NORMAL'
      }

      case 'case': {
        const selVal = Number(this.evaluateNode(stmt.selector, context)) || 0
        if (context.lineValues) {
          context.lineValues[stmt.line] = selVal
        }

        let matched = false
        for (const c of stmt.cases) {
          const isMatch = c.values.some((v) => {
            if (typeof v === 'number') return v === selVal
            return selVal >= v.from && selVal <= v.to
          })
          if (isMatch) {
            matched = true
            for (const s of c.statements) {
              const res = this.executeNode(s, context, loopGuard)
              if (res !== 'NORMAL') return res
            }
            break
          }
        }

        if (!matched && stmt.elseStatements) {
          for (const s of stmt.elseStatements) {
            const res = this.executeNode(s, context, loopGuard)
            if (res !== 'NORMAL') return res
          }
        }
        return 'NORMAL'
      }

      case 'for': {
        const start = Number(this.evaluateNode(stmt.startExpr, context)) || 0
        const end = Number(this.evaluateNode(stmt.endExpr, context)) || 0
        const step = stmt.stepExpr ? Number(this.evaluateNode(stmt.stepExpr, context)) || 1 : 1
        const MAX_LOOPS = 10000

        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
          loopGuard.count++
          if (loopGuard.count > MAX_LOOPS) break

          context.setVar(stmt.iterVar, i)
          for (const s of stmt.body) {
            const res = this.executeNode(s, context, loopGuard)
            if (res === 'EXIT') return 'NORMAL'
            if (res === 'RETURN') return 'RETURN'
          }
        }
        return 'NORMAL'
      }

      case 'while': {
        const MAX_LOOPS = 10000
        while (!!this.evaluateNode(stmt.condition, context)) {
          loopGuard.count++
          if (loopGuard.count > MAX_LOOPS) break

          for (const s of stmt.body) {
            const res = this.executeNode(s, context, loopGuard)
            if (res === 'EXIT') return 'NORMAL'
            if (res === 'RETURN') return 'RETURN'
          }
        }
        return 'NORMAL'
      }

      case 'repeat': {
        const MAX_LOOPS = 10000
        do {
          loopGuard.count++
          if (loopGuard.count > MAX_LOOPS) break

          for (const s of stmt.body) {
            const res = this.executeNode(s, context, loopGuard)
            if (res === 'EXIT') return 'NORMAL'
            if (res === 'RETURN') return 'RETURN'
          }
        } while (!this.evaluateNode(stmt.condition, context))
        return 'NORMAL'
      }

      case 'call': {
        this.executeCall(stmt.callee, stmt.args, context)
        return 'NORMAL'
      }

      case 'return':
        return 'RETURN'

      case 'exit':
        return 'EXIT'
    }
  }

  private static evaluateNode(expr: SclExpression, context: SclExecutionContext): unknown {
    switch (expr.kind) {
      case 'literal': {
        if (typeof expr.value === 'string' && expr.value.toUpperCase().startsWith('T#')) {
          return this.parseTimeLiteral(expr.value)
        }
        return expr.value
      }

      case 'variable': {
        const clean = expr.name.replace(/^"|"$/g, '')
        return context.getVar(clean)
      }

      case 'unary': {
        const val = this.evaluateNode(expr.expr, context)
        if (expr.op === 'NOT') return !val
        if (expr.op === '-') return -(Number(val) || 0)
        return Number(val) || 0
      }

      case 'binary': {
        const left = this.evaluateNode(expr.left, context)
        const right = this.evaluateNode(expr.right, context)

        switch (expr.op.toUpperCase()) {
          case 'AND':
            return !!left && !!right
          case 'OR':
            return !!left || !!right
          case 'XOR':
            return (!!left && !right) || (!left && !!right)
          case '=':
            return left === right
          case '<>':
            return left !== right
          case '<':
            return Number(left) < Number(right)
          case '>':
            return Number(left) > Number(right)
          case '<=':
            return Number(left) <= Number(right)
          case '>=':
            return Number(left) >= Number(right)
          case '+':
            return (Number(left) || 0) + (Number(right) || 0)
          case '-':
            return (Number(left) || 0) - (Number(right) || 0)
          case '*':
            return (Number(left) || 0) * (Number(right) || 0)
          case '/': {
            const r = Number(right) || 0
            return r !== 0 ? (Number(left) || 0) / r : 0
          }
          case 'MOD': {
            const r = Number(right) || 0
            return r !== 0 ? (Number(left) || 0) % r : 0
          }
          default:
            return 0
        }
      }

      case 'call_expr': {
        return this.evaluateFunctionCall(expr.callee, expr.args, context)
      }
    }
  }

  private static parseTimeLiteral(s: string): number {
    const timeMatch = s.match(/T#(?:(\d+)h)?(?:(\d+)m(?:(?!s))?)?(?:(\d+)s)?(?:(\d+)ms)?/i)
    if (!timeMatch) return 0
    const h = parseInt(timeMatch[1] || '0', 10) * 3600000
    const m = parseInt(timeMatch[2] || '0', 10) * 60000
    const sec = parseInt(timeMatch[3] || '0', 10) * 1000
    const ms = parseInt(timeMatch[4] || '0', 10)
    return h + m + sec + ms
  }

  private static executeCall(
    funcName: string,
    args: Record<string, SclExpression>,
    context: SclExecutionContext
  ): void {
    const upper = funcName.toUpperCase()

    // 1. NORM_X
    if (upper === 'NORM_X') {
      const min = Number(this.evaluateNode(args['MIN'] || args['arg_0'], context)) || 0
      const max = Number(this.evaluateNode(args['MAX'] || args['arg_1'], context)) || 27648
      const val = Number(this.evaluateNode(args['VALUE'] || args['arg_2'], context)) || 0
      const out = max !== min ? (val - min) / (max - min) : 0
      const outVar = args['OUT'] || args['arg_3']
      if (outVar && outVar.kind === 'variable') {
        context.setVar(outVar.name, out)
      }
      return
    }

    // 2. SCALE_X
    if (upper === 'SCALE_X') {
      const min = Number(this.evaluateNode(args['MIN'] || args['arg_0'], context)) || 0
      const max = Number(this.evaluateNode(args['MAX'] || args['arg_1'], context)) || 100
      const val = Number(this.evaluateNode(args['VALUE'] || args['arg_2'], context)) || 0
      const out = min + val * (max - min)
      const outVar = args['OUT'] || args['arg_3']
      if (outVar && outVar.kind === 'variable') {
        context.setVar(outVar.name, out)
      }
      return
    }

    // 3. Edge triggers: R_TRIG and F_TRIG
    if (upper === 'R_TRIG' || upper === 'F_TRIG') {
      const clk = !!this.evaluateNode(args['CLK'] || args['arg_0'], context)
      const instKey = funcName
      const state = this.edgeTriggerStates.get(instKey) || { prevClk: false }
      const q = upper === 'R_TRIG' ? clk && !state.prevClk : !clk && state.prevClk
      state.prevClk = clk
      this.edgeTriggerStates.set(instKey, state)

      const qVar = args['Q'] || args['arg_1']
      if (qVar && qVar.kind === 'variable') {
        context.setVar(qVar.name, q)
      }
      return
    }

    // Delegate to context.callFunction if registered
    if (context.callFunction) {
      const evaluatedArgs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args)) {
        evaluatedArgs[k] = this.evaluateNode(v, context)
      }
      context.callFunction(funcName, evaluatedArgs)
    }
  }

  private static evaluateFunctionCall(
    funcName: string,
    args: Record<string, SclExpression>,
    context: SclExecutionContext
  ): unknown {
    const upper = funcName.toUpperCase()

    if (upper === 'ABS') {
      return Math.abs(Number(this.evaluateNode(args['IN'] || args['arg_0'], context)) || 0)
    }
    if (upper === 'SQRT') {
      return Math.sqrt(Math.max(0, Number(this.evaluateNode(args['IN'] || args['arg_0'], context)) || 0))
    }
    if (upper === 'MIN') {
      const a = Number(this.evaluateNode(args['IN1'] || args['arg_0'], context)) || 0
      const b = Number(this.evaluateNode(args['IN2'] || args['arg_1'], context)) || 0
      return Math.min(a, b)
    }
    if (upper === 'MAX') {
      const a = Number(this.evaluateNode(args['IN1'] || args['arg_0'], context)) || 0
      const b = Number(this.evaluateNode(args['IN2'] || args['arg_1'], context)) || 0
      return Math.max(a, b)
    }

    return 0
  }

  /**
   * Evaluates a standalone SCL expression string
   */
  public static evaluateExpression(exprStr: string, context: SclExecutionContext): unknown {
    if (!exprStr || !exprStr.trim()) return 0
    const { tokens, errors } = SclLexer.tokenize(exprStr)
    if (errors.length > 0) return 0
    const parser = new SclParser(tokens)
    const expr = parser.parseExpression()
    return this.evaluateNode(expr, context)
  }

  /**
   * Validates SCL syntax and block balancing, returning precise line numbers
   */
  public static validateSyntax(code: string): { valid: boolean; errors: string[] } {
    const { tokens, errors: lexErrors } = SclLexer.tokenize(code)
    if (lexErrors.length > 0) {
      return { valid: false, errors: lexErrors }
    }

    const parser = new SclParser(tokens)
    parser.parseProgram()

    // Structural block balancing checks
    const blockErrors: string[] = []
    let ifCount = 0
    let caseCount = 0
    let forCount = 0
    let whileCount = 0

    for (const t of tokens) {
      if (t.type === 'KEYWORD') {
        if (t.value === 'IF') ifCount++
        else if (t.value === 'END_IF') ifCount--
        else if (t.value === 'CASE') caseCount++
        else if (t.value === 'END_CASE') caseCount--
        else if (t.value === 'FOR') forCount++
        else if (t.value === 'END_FOR') forCount--
        else if (t.value === 'WHILE') whileCount++
        else if (t.value === 'END_WHILE') whileCount--
      }
    }

    if (ifCount > 0) blockErrors.push(`Missing 'END_IF' for ${ifCount} open IF block(s)`)
    if (caseCount > 0) blockErrors.push(`Missing 'END_CASE' for ${caseCount} open CASE block(s)`)
    if (forCount > 0) blockErrors.push(`Missing 'END_FOR' for ${forCount} open FOR loop(s)`)
    if (whileCount > 0) blockErrors.push(`Missing 'END_WHILE' for ${whileCount} open WHILE loop(s)`)

    const allErrors = [...parser.errors, ...blockErrors]
    return {
      valid: allErrors.length === 0,
      errors: allErrors
    }
  }
}
