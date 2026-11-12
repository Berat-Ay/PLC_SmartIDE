// SCL runtime interpreter. Lexing and parsing live in src/shared/scl.
import { SclLexer } from '@shared/scl/lexer'
import { SclParser } from '@shared/scl/parser'
import { SclStatement, SclExpression } from '@shared/scl/ast'
import { parseS7Time } from '@shared/s7/time'
import { roundHalfEven } from '@shared/s7/typeLayout'

export * from '@shared/scl/ast'
export { SclLexer, SclParser }

export interface SclBlockCall {
  name: string
  quoted: boolean
  /** Parameters passed with :=, already evaluated. */
  inputs: Record<string, unknown>
  /** Parameters passed with => or as a plain variable with :=, for outputs and in-outs. */
  writers: Record<string, (value: unknown) => void>
}

export interface SclExecutionContext {
  getVar: (symbol: string, quoted?: boolean) => unknown
  setVar: (symbol: string, value: unknown, quoted?: boolean) => void
  /** Declared S7 type of a symbol, used to tell integer division from REAL division. */
  typeOf?: (symbol: string, quoted?: boolean) => string | undefined
  /** Runs a user block or an instance call. handled=false falls through to built-in functions. */
  callBlock?: (call: SclBlockCall) => { handled: boolean; returnValue?: unknown }
  /** True when callBlock would run this name. Arguments are only evaluated once it is known. */
  canCall?: (name: string, quoted: boolean) => boolean
  hasSymbol?: (symbol: string, quoted?: boolean) => boolean
  /** Prefix that keeps edge memory of one FB instance apart from another. */
  instancePrefix?: () => string
  callFunction?: (name: string, args: Record<string, unknown>) => unknown
  /** Key of a timer or counter instance within the running block. */
  resolveInstanceKey?: (name: string, quoted: boolean) => string
  lineValues?: Record<number, string | number> // lineNumber -> display value for online monitoring
  onError?: (message: string) => void
}

/** Same effect as a watchdog timeout on a real CPU: the program never finished. */
const MAX_LOOP_ITERATIONS = 1_000_000
const PARSE_CACHE_LIMIT = 2000

type ExecResult = 'NORMAL' | 'EXIT' | 'CONTINUE' | 'RETURN'
type StaticType = 'real' | 'int' | 'bool' | undefined

interface ParsedProgram {
  statements: SclStatement[]
  error?: string
}

const INTEGER_RANGES: Record<string, [number, number]> = {
  SINT: [-128, 127],
  INT: [-32768, 32767],
  DINT: [-2147483648, 2147483647],
  USINT: [0, 255],
  BYTE: [0, 255],
  UINT: [0, 65535],
  WORD: [0, 65535],
  UDINT: [0, 4294967295],
  DWORD: [0, 4294967295]
}

const BIT_WIDTHS: Record<string, number> = { BYTE: 8, USINT: 8, SINT: 8, WORD: 16, UINT: 16, INT: 16, DWORD: 32, UDINT: 32, DINT: 32 }

function wrapInteger(value: number, target: string): number {
  const range = INTEGER_RANGES[target]
  if (!range) return value
  const span = range[1] - range[0] + 1
  const wrapped = ((value - range[0]) % span + span) % span
  return wrapped + range[0]
}

function isFalsy(value: unknown): boolean {
  return !value
}

export class SclInterpreter {
  private static edgeTriggerStates = new Map<string, { prevClk: boolean }>()
  private static programCache = new Map<string, ParsedProgram>()
  private static expressionCache = new Map<string, SclExpression | null>()

  public static resetEdgeStates(): void {
    this.edgeTriggerStates.clear()
  }

  /** Keeps the current edge state aside and returns how to bring it back. */
  public static saveEdgeStates(): () => void {
    const edgeTriggerStates = this.edgeTriggerStates
    this.edgeTriggerStates = new Map()
    return () => {
      this.edgeTriggerStates = edgeTriggerStates
    }
  }

  private static parseCached(sclCode: string): ParsedProgram {
    const cached = this.programCache.get(sclCode)
    if (cached) return cached

    const { tokens, errors: lexErrors } = SclLexer.tokenize(sclCode)
    let program: ParsedProgram
    if (lexErrors.length > 0) {
      program = { statements: [], error: lexErrors.join('; ') }
    } else {
      const parser = new SclParser(tokens)
      const statements = parser.parseProgram()
      program = parser.errors.length > 0 ? { statements: [], error: parser.errors.join('; ') } : { statements }
    }
    if (this.programCache.size >= PARSE_CACHE_LIMIT) this.programCache.clear()
    this.programCache.set(sclCode, program)
    return program
  }

  /**
   * Executes SCL source code within the provided PLC execution context
   */
  public static execute(
    sclCode: string,
    context: SclExecutionContext
  ): { success: boolean; error?: string } {
    try {
      const program = this.parseCached(sclCode)
      if (program.error) return { success: false, error: program.error }

      const guard = { count: 0 }
      for (const stmt of program.statements) {
        const res = this.executeNode(stmt, context, guard)
        if (res === 'RETURN') break
      }
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message }
    }
  }

  private static runList(list: SclStatement[], context: SclExecutionContext, guard: { count: number }): ExecResult {
    for (const s of list) {
      const res = this.executeNode(s, context, guard)
      if (res !== 'NORMAL') return res
    }
    return 'NORMAL'
  }

  private static countIteration(guard: { count: number }, line: number): void {
    guard.count++
    if (guard.count > MAX_LOOP_ITERATIONS) {
      throw new Error(`Line ${line}: Loop exceeded ${MAX_LOOP_ITERATIONS} iterations and would trip the cycle watchdog`)
    }
  }

  private static executeNode(stmt: SclStatement, context: SclExecutionContext, guard: { count: number }): ExecResult {
    switch (stmt.kind) {
      case 'assign': {
        const val = this.evaluateNode(stmt.expression, context)
        context.setVar(this.expandIndices(stmt.target, context), val, stmt.targetQuoted)
        if (context.lineValues) {
          context.lineValues[stmt.line] = typeof val === 'number' ? Math.round(val * 100) / 100 : String(val)
        }
        return 'NORMAL'
      }

      case 'if': {
        const condVal = !!this.evaluateNode(stmt.condition, context)
        if (context.lineValues) context.lineValues[stmt.line] = condVal ? 'TRUE' : 'FALSE'
        if (condVal) return this.runList(stmt.thenStatements, context, guard)

        for (const branch of stmt.elsifBranches) {
          const elsifCond = !!this.evaluateNode(branch.condition, context)
          if (context.lineValues) context.lineValues[branch.line] = elsifCond ? 'TRUE' : 'FALSE'
          if (elsifCond) return this.runList(branch.statements, context, guard)
        }
        return stmt.elseStatements ? this.runList(stmt.elseStatements, context, guard) : 'NORMAL'
      }

      case 'case': {
        const selVal = Number(this.evaluateNode(stmt.selector, context)) || 0
        if (context.lineValues) context.lineValues[stmt.line] = selVal

        for (const c of stmt.cases) {
          const isMatch = c.values.some((v) => (typeof v === 'number' ? v === selVal : selVal >= v.from && selVal <= v.to))
          if (isMatch) return this.runList(c.statements, context, guard)
        }
        return stmt.elseStatements ? this.runList(stmt.elseStatements, context, guard) : 'NORMAL'
      }

      case 'for': {
        const start = Number(this.evaluateNode(stmt.startExpr, context)) || 0
        const end = Number(this.evaluateNode(stmt.endExpr, context)) || 0
        const step = stmt.stepExpr ? Number(this.evaluateNode(stmt.stepExpr, context)) || 1 : 1

        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
          this.countIteration(guard, stmt.line)
          context.setVar(stmt.iterVar, i)
          const res = this.runList(stmt.body, context, guard)
          if (res === 'EXIT') return 'NORMAL'
          if (res === 'RETURN') return 'RETURN'
        }
        return 'NORMAL'
      }

      case 'while': {
        while (this.evaluateNode(stmt.condition, context)) {
          this.countIteration(guard, stmt.line)
          const res = this.runList(stmt.body, context, guard)
          if (res === 'EXIT') return 'NORMAL'
          if (res === 'RETURN') return 'RETURN'
        }
        return 'NORMAL'
      }

      case 'repeat': {
        do {
          this.countIteration(guard, stmt.line)
          const res = this.runList(stmt.body, context, guard)
          if (res === 'EXIT') return 'NORMAL'
          if (res === 'RETURN') return 'RETURN'
        } while (isFalsy(this.evaluateNode(stmt.condition, context)))
        return 'NORMAL'
      }

      case 'call':
        this.executeCall(stmt.callee, !!stmt.calleeQuoted, stmt.args, stmt.outputArgs || [], stmt.line, context)
        return 'NORMAL'

      case 'return':
        return 'RETURN'

      case 'exit':
        return 'EXIT'

      case 'continue':
        return 'CONTINUE'
    }
  }

  /** Replaces index expressions in a name: arr[#i + 1] becomes arr[3]. */
  private static expandIndices(name: string, context: SclExecutionContext): string {
    if (!name.includes('[')) return name
    let out = ''
    let i = 0
    while (i < name.length) {
      if (name[i] !== '[') {
        out += name[i++]
        continue
      }
      let depth = 1
      let j = i + 1
      const parts: string[] = []
      let cur = ''
      for (; j < name.length && depth > 0; j++) {
        const c = name[j]
        if (c === '[') depth++
        if (c === ']') {
          depth--
          if (depth === 0) break
        }
        if (c === ',' && depth === 1) {
          parts.push(cur)
          cur = ''
        } else {
          cur += c
        }
      }
      parts.push(cur)
      const values = parts.map((p) => {
        const trimmed = p.trim()
        return /^-?\d+$/.test(trimmed) ? trimmed : String(Math.trunc(Number(this.evaluateExpression(trimmed, context)) || 0))
      })
      out += `[${values.join(',')}]`
      i = j + 1
    }
    return out
  }

  private static staticType(expr: SclExpression, context: SclExecutionContext): StaticType {
    switch (expr.kind) {
      case 'literal':
        if (typeof expr.value === 'boolean') return 'bool'
        if (expr.isTime) return 'int'
        if (typeof expr.value !== 'number') return undefined
        return /[.eE]/.test(expr.raw) ? 'real' : 'int'
      case 'variable': {
        const t = context.typeOf?.(expr.name, expr.quoted)?.toUpperCase()
        if (!t) return undefined
        if (t === 'REAL' || t === 'LREAL') return 'real'
        return t === 'BOOL' ? 'bool' : 'int'
      }
      case 'unary':
        return this.staticType(expr.expr, context)
      case 'binary': {
        if (['AND', 'OR', 'XOR'].includes(expr.op.toUpperCase())) return this.staticType(expr.left, context)
        if (['=', '<>', '<', '>', '<=', '>='].includes(expr.op)) return 'bool'
        const l = this.staticType(expr.left, context)
        const r = this.staticType(expr.right, context)
        if (l === 'real' || r === 'real') return 'real'
        return l === 'int' && r === 'int' ? 'int' : undefined
      }
      case 'call_expr': {
        const upper = expr.callee.toUpperCase()
        const conv = upper.match(/_TO_([A-Z]+)$/)
        if (conv) return conv[1] === 'REAL' || conv[1] === 'LREAL' ? 'real' : conv[1] === 'BOOL' ? 'bool' : 'int'
        if (['ROUND', 'TRUNC', 'CEIL', 'FLOOR'].includes(upper)) return 'int'
        if (['SQRT', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'EXP', 'LN', 'NORM_X', 'SQR'].includes(upper)) return 'real'
        return undefined
      }
    }
  }

  private static evaluateNode(expr: SclExpression, context: SclExecutionContext): unknown {
    switch (expr.kind) {
      case 'literal': {
        if (expr.isTime) return parseS7Time(String(expr.value)) ?? 0
        return expr.value
      }

      case 'variable':
        return context.getVar(this.expandIndices(expr.name, context), expr.quoted)

      case 'unary': {
        const val = this.evaluateNode(expr.expr, context)
        if (expr.op === 'NOT') {
          if (typeof val === 'number' && this.staticType(expr.expr, context) === 'int') return ~val
          return !val
        }
        if (expr.op === '-') return -(Number(val) || 0)
        return Number(val) || 0
      }

      case 'binary':
        return this.evaluateBinary(expr, context)

      case 'call_expr':
        return this.evaluateFunctionCall(expr.callee, !!expr.calleeQuoted, expr.args, expr.line, context)
    }
  }

  private static evaluateBinary(expr: Extract<SclExpression, { kind: 'binary' }>, context: SclExecutionContext): unknown {
    const left = this.evaluateNode(expr.left, context)
    const right = this.evaluateNode(expr.right, context)
    const op = expr.op.toUpperCase()

    switch (op) {
      case 'AND':
      case 'OR':
      case 'XOR': {
        // Bit operations on words stay numeric; anything else is logic
        if (typeof left === 'number' && typeof right === 'number' && this.staticType(expr.left, context) === 'int') {
          if (op === 'AND') return (left & right) >>> 0
          if (op === 'OR') return (left | right) >>> 0
          return (left ^ right) >>> 0
        }
        if (op === 'AND') return !!left && !!right
        if (op === 'OR') return !!left || !!right
        return !!left !== !!right
      }
      case '=':
        return this.comparable(left) === this.comparable(right)
      case '<>':
        return this.comparable(left) !== this.comparable(right)
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
      case '**':
        return Math.pow(Number(left) || 0, Number(right) || 0)
      case '/': {
        const l = Number(left) || 0
        const r = Number(right) || 0
        const lt = this.staticType(expr.left, context)
        const rt = this.staticType(expr.right, context)
        if (lt === 'int' && rt === 'int') return r !== 0 ? Math.trunc(l / r) : 0
        if (lt === 'real' || rt === 'real') return l / r
        return r !== 0 ? l / r : 0
      }
      case 'MOD': {
        const r = Number(right) || 0
        return r !== 0 ? (Number(left) || 0) % r : 0
      }
      default:
        throw new Error(`Line ${expr.line}: Unknown operator '${expr.op}'`)
    }
  }

  private static comparable(value: unknown): unknown {
    if (typeof value === 'boolean') return value ? 1 : 0
    return value === undefined ? 0 : value
  }

  private static argExpr(args: Record<string, SclExpression>, name: string, position: number): SclExpression | undefined {
    if (args[name]) return args[name]
    const key = Object.keys(args).find((k) => k.toUpperCase() === name)
    return key ? args[key] : args[`arg_${position}`]
  }

  private static numArg(
    args: Record<string, SclExpression>,
    name: string,
    position: number,
    fallback: number,
    context: SclExecutionContext
  ): number {
    const expr = this.argExpr(args, name, position)
    if (!expr) return fallback
    return Number(this.evaluateNode(expr, context)) || 0
  }

  private static tryBlockCall(
    funcName: string,
    quoted: boolean,
    args: Record<string, SclExpression>,
    outputArgs: string[],
    context: SclExecutionContext
  ): { handled: boolean; returnValue?: unknown } {
    if (!context.callBlock) return { handled: false }
    if (context.canCall && !context.canCall(funcName, quoted)) return { handled: false }

    const inputs: Record<string, unknown> = {}
    const writers: Record<string, (value: unknown) => void> = {}
    for (const [param, expr] of Object.entries(args)) {
      const isOutput = outputArgs.includes(param)
      if (!isOutput) inputs[param] = this.evaluateNode(expr, context)
      if (expr.kind === 'variable') {
        const targetName = this.expandIndices(expr.name, context)
        const targetQuoted = expr.quoted
        writers[param] = (value) => context.setVar(targetName, value, targetQuoted)
      }
    }
    return context.callBlock({ name: funcName, quoted, inputs, writers })
  }

  private static executeCall(
    funcName: string,
    quoted: boolean,
    args: Record<string, SclExpression>,
    outputArgs: string[],
    line: number,
    context: SclExecutionContext
  ): void {
    const name = this.expandIndices(funcName, context)
    const result = this.tryBlockCall(name, quoted, args, outputArgs, context)
    if (result.handled) return

    const upper = name.toUpperCase()

    if (upper === 'R_TRIG' || upper === 'F_TRIG') {
      // Without an instance the state belongs to this call site: this line of this block, or of this FB instance
      const clk = !!this.evaluateNode(this.argExpr(args, 'CLK', 0) as SclExpression, context)
      const key = `${context.instancePrefix?.() || ''}${upper}@${line}`
      const state = this.edgeTriggerStates.get(key) || { prevClk: false }
      const q = upper === 'R_TRIG' ? clk && !state.prevClk : !clk && state.prevClk
      state.prevClk = clk
      this.edgeTriggerStates.set(key, state)
      const qVar = this.argExpr(args, 'Q', 1)
      if (qVar && qVar.kind === 'variable') context.setVar(qVar.name, q, qVar.quoted)
      return
    }

    if (upper === 'NORM_X' || upper === 'SCALE_X') {
      const out = this.evaluateFunctionCall(name, quoted, args, line, context)
      const outVar = this.argExpr(args, 'OUT', 3)
      if (outVar && outVar.kind === 'variable') context.setVar(outVar.name, out, outVar.quoted)
      return
    }

    if (this.hasBuiltin(upper)) {
      this.evaluateFunctionCall(name, quoted, args, line, context)
      return
    }

    if (context.callFunction) {
      const evaluatedArgs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args)) evaluatedArgs[k] = this.evaluateNode(v, context)
      context.callFunction(name, evaluatedArgs)
      return
    }

    throw new Error(`Line ${line}: Unknown block or function '${name}'`)
  }

  private static hasBuiltin(upper: string): boolean {
    return (
      /_TO_/.test(upper) ||
      [
        'ABS', 'SQRT', 'SQR', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX', 'NORM_X', 'SCALE_X', 'ROUND', 'TRUNC', 'CEIL',
        'FLOOR', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'EXP', 'LN', 'SHL', 'SHR', 'ROL', 'ROR'
      ].includes(upper)
    )
  }

  private static evaluateFunctionCall(
    funcName: string,
    quoted: boolean,
    args: Record<string, SclExpression>,
    line: number,
    context: SclExecutionContext
  ): unknown {
    const name = this.expandIndices(funcName, context)
    const blockResult = this.tryBlockCall(name, quoted, args, [], context)
    if (blockResult.handled) return blockResult.returnValue

    const upper = name.toUpperCase()
    const num = (argName: string, position: number, fallback = 0): number =>
      this.numArg(args, argName, position, fallback, context)
    const single = (): number => num('IN', 0)

    const conversion = upper.match(/^([A-Z]+)_TO_([A-Z]+)$/)
    if (conversion) {
      const inExpr = this.argExpr(args, 'IN', 0)
      const raw = inExpr ? this.evaluateNode(inExpr, context) : 0
      const target = conversion[2]
      if (target === 'BOOL') return typeof raw === 'number' ? (raw & 1) !== 0 : !!raw
      const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw) || 0
      if (target === 'REAL' || target === 'LREAL') return value
      const isRealSource = conversion[1] === 'REAL' || conversion[1] === 'LREAL'
      return wrapInteger(isRealSource ? roundHalfEven(value) : Math.trunc(value), target)
    }

    switch (upper) {
      case 'ABS':
        return Math.abs(single())
      case 'SQRT':
        return Math.sqrt(Math.max(0, single()))
      case 'SQR':
        return single() * single()
      case 'SIN':
        return Math.sin(single())
      case 'COS':
        return Math.cos(single())
      case 'TAN':
        return Math.tan(single())
      case 'ASIN':
        return Math.asin(single())
      case 'ACOS':
        return Math.acos(single())
      case 'ATAN':
        return Math.atan(single())
      case 'EXP':
        return Math.exp(single())
      case 'LN':
        return Math.log(single())
      case 'ROUND':
        return roundHalfEven(single())
      case 'TRUNC':
        return Math.trunc(single())
      case 'CEIL':
        return Math.ceil(single())
      case 'FLOOR':
        return Math.floor(single())
      case 'MIN':
      case 'MAX': {
        const values = Object.keys(args).map((k) => Number(this.evaluateNode(args[k], context)) || 0)
        if (values.length === 0) return 0
        return upper === 'MIN' ? Math.min(...values) : Math.max(...values)
      }
      case 'LIMIT': {
        const mn = num('MN', 0)
        const inVal = num('IN', 1)
        const mx = num('MX', 2)
        return Math.min(Math.max(inVal, mn), mx)
      }
      case 'SEL': {
        const g = this.argExpr(args, 'G', 0)
        const chosen = g && this.evaluateNode(g, context) ? this.argExpr(args, 'IN1', 2) : this.argExpr(args, 'IN0', 1)
        return chosen ? this.evaluateNode(chosen, context) : 0
      }
      case 'MUX': {
        const k = num('K', 0)
        const chosen = this.argExpr(args, `IN${k}`, k + 1)
        return chosen ? this.evaluateNode(chosen, context) : 0
      }
      case 'NORM_X': {
        const min = num('MIN', 0)
        const max = num('MAX', 1, 27648)
        const val = num('VALUE', 2)
        return max !== min ? (val - min) / (max - min) : 0
      }
      case 'SCALE_X': {
        const min = num('MIN', 0)
        const max = num('MAX', 1, 100)
        const val = num('VALUE', 2)
        return min + val * (max - min)
      }
      case 'SHL':
      case 'SHR':
      case 'ROL':
      case 'ROR': {
        const inExpr = this.argExpr(args, 'IN', 0)
        const declared = inExpr?.kind === 'variable' ? context.typeOf?.(inExpr.name, inExpr.quoted)?.toUpperCase() : undefined
        const width = BIT_WIDTHS[declared || ''] || 32
        const mask = width === 32 ? 0xffffffff : (1 << width) - 1
        const n = num('N', 1)
        const value = (num('IN', 0) & mask) >>> 0
        if (upper === 'SHL') return n >= width ? 0 : ((value << n) & mask) >>> 0
        if (upper === 'SHR') return n >= width ? 0 : (value >>> n) >>> 0
        const s = n % width
        if (s === 0) return value
        const left = upper === 'ROL' ? s : width - s
        return (((value << left) | (value >>> (width - left))) & mask) >>> 0
      }
    }

    if (context.callFunction) {
      const evaluatedArgs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args)) evaluatedArgs[k] = this.evaluateNode(v, context)
      return context.callFunction(name, evaluatedArgs)
    }

    throw new Error(`Line ${line}: Unknown block or function '${name}'`)
  }

  /**
   * Evaluates a standalone SCL expression string
   */
  public static evaluateExpression(exprStr: string, context: SclExecutionContext): unknown {
    if (!exprStr || !exprStr.trim()) return 0
    let expr = this.expressionCache.get(exprStr)
    if (expr === undefined) {
      const { tokens, errors } = SclLexer.tokenize(exprStr)
      if (errors.length > 0) {
        expr = null
      } else {
        const parser = new SclParser(tokens)
        expr = parser.parseExpression()
        if (parser.errors.length > 0) expr = null
      }
      if (this.expressionCache.size >= PARSE_CACHE_LIMIT) this.expressionCache.clear()
      this.expressionCache.set(exprStr, expr)
    }
    return expr ? this.evaluateNode(expr, context) : 0
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
