// SCL recursive-descent parser: converts tokens to an AST. No execution lives here.
import { SclToken, SclStatement, SclExpression, SclIfStatement, SclCaseStatement } from './ast'

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
        let depth = 0
        while (this.current().type !== 'EOF' && (depth > 0 || this.current().value !== ']')) {
          if (this.current().value === '[') depth++
          if (this.current().value === ']') depth--
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
        while (this.current().type !== 'EOF' && !this.current().value.startsWith('VAR') && this.current().value !== 'BEGIN') {
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

    if (this.matchKeyword('CONTINUE')) {
      if (this.current().value === ';') this.advance()
      return { kind: 'continue', line: cur.line }
    }

    // 7. Assignment or Function Call
    if (cur.type === 'IDENTIFIER') {
      const startLine = cur.line
      const quoted = !!cur.quoted
      const name = this.parseQualifiedIdentifier()

      // Assignment: target := expression;
      if (this.matchOperator(':=')) {
        const expr = this.parseExpression()
        if (this.current().value === ';') this.advance()
        return {
          kind: 'assign',
          line: startLine,
          target: name,
          targetQuoted: quoted,
          expression: expr
        }
      }

      // Function Call statement: CallName(a := 1, b => 2);
      if (this.matchOperator('(')) {
        const args: Record<string, SclExpression> = {}
        const outputArgs: string[] = []
        while (this.current().type !== 'EOF' && this.current().value !== ')') {
          let paramName = ''
          if (this.peek().value === ':=' || this.peek().value === '=>') {
            paramName = this.current().value
            if (this.peek().value === '=>') outputArgs.push(paramName)
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
          calleeQuoted: quoted,
          args,
          outputArgs
        }
      }

      this.errors.push(`Line ${startLine}: Statement '${name}' has no effect`)
      if (this.current().value === ';') this.advance()
      return null
    }

    // Bare semicolon
    if (this.current().value === ';') {
      this.advance()
      return null
    }

    if (cur.type !== 'EOF') {
      this.errors.push(`Line ${cur.line}: Unexpected '${cur.value}'`)
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
    const base = this.parsePrimary()
    if (this.current().value === '**') {
      const line = this.current().line
      this.advance()
      return { kind: 'binary', op: '**', left: base, right: this.parseUnary(), line }
    }
    return base
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
      return { kind: 'literal', value: cur.value, raw: cur.value, isTime: true, line: cur.line }
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
      const quoted = !!cur.quoted
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
        return { kind: 'call_expr', callee: name, calleeQuoted: quoted, args, line: cur.line }
      }

      return { kind: 'variable', name, quoted, line: cur.line }
    }

    this.errors.push(`Line ${cur.line}: Expected a value, found '${cur.value}'`)
    this.advance()
    return { kind: 'literal', value: 0, raw: '0', line: cur.line }
  }
}
