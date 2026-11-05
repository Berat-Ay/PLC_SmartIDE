// Generates a human-readable STL listing from LAD and SCL blocks.
// This is documentation for the engineer. It is not machine code, it is never loaded to a CPU and the
// simulator does not execute it: blocks run through LadderEvaluator and SclInterpreter.
import { LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import {
  LadderNode,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderMathNode,
  LadderParallelBranchNode
} from '@shared/types/ladder'
import { SclLexer } from '@shared/scl/lexer'
import { SclParser } from '@shared/scl/parser'
import { SclExpression, SclStatement } from '@shared/scl/ast'
import { parseSourceBlock } from '@shared/scl/sourceBlock'

export interface StlInstruction {
  line: number
  opcode: string
  operand?: string
  parameters?: Record<string, string>
  comment?: string
  networkNumber?: number
  label?: string
}

export interface BlockListing {
  blockName: string
  blockType: 'OB' | 'FC' | 'FB' | 'DB'
  totalInstructions: number
  instructions: StlInstruction[]
  listingText: string
}

export interface ProjectListingSummary {
  blocks: BlockListing[]
  totalNetworks: number
  totalInstructions: number
}

const COMPARE_OPCODES: Record<string, string> = {
  '=': '==',
  '<>': '<>',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>='
}

const LOGIC_OPS = ['AND', 'OR', 'XOR']
const COMPARE_OPS = ['=', '<>', '<', '>', '<=', '>=']

/** Builds one block's listing. Labels are numbered per block so the output is deterministic. */
class ListingBuilder {
  public readonly instructions: StlInstruction[] = []
  private lineNumber = 1
  private labelCounter = 1
  private loops: { start: string; end: string }[] = []
  private network?: number

  public setNetwork(networkNumber: number | undefined): void {
    this.network = networkNumber
  }

  public emit(opcode: string, operand?: string, comment?: string, parameters?: Record<string, string>): void {
    this.instructions.push({
      line: this.lineNumber++,
      opcode,
      operand,
      comment,
      parameters,
      networkNumber: this.network
    })
  }

  private placeLabel(label: string): void {
    this.instructions.push({ line: 0, opcode: `${label}:`, label, networkNumber: this.network })
  }

  private nextId(): number {
    return this.labelCounter++
  }

  // ---------------------------------------------------------------------------
  // LAD
  // ---------------------------------------------------------------------------

  public ladNodes(nodes: LadderNode[]): void {
    nodes.forEach((node, index) => this.ladNode(node, index < nodes.length - 1))
  }

  private ladNode(node: LadderNode, hasSuccessor: boolean): void {
    switch (node.kind) {
      case 'contact': {
        const c = node as LadderContactNode
        const op = c.operand || c.address || '???'
        const comment = c.symbolName ? `// ${c.symbolName}` : undefined
        if (c.contactType === 'NC_CONTACT') {
          this.emit('AN', op, comment || '// Normally closed contact')
        } else {
          this.emit('A', op, comment || '// Normally open contact')
          if (c.contactType === 'P_TRIG') this.emit('FP', c.edgeTag || '<edge bit>', '// Rising edge')
          if (c.contactType === 'N_TRIG') this.emit('FN', c.edgeTag || '<edge bit>', '// Falling edge')
        }
        return
      }

      case 'parallel': {
        const p = node as LadderParallelBranchNode
        if (p.branches.length === 1) {
          this.ladNodes(p.branches[0])
          return
        }
        this.emit('A(', undefined, '// Parallel branches')
        p.branches.forEach((branch, index) => {
          this.emit('O(', undefined, `// Branch ${index + 1}`)
          this.ladNodes(branch)
          this.emit(')')
        })
        this.emit(')')
        return
      }

      case 'coil': {
        const c = node as LadderCoilNode
        const op = c.operand || c.address || '???'
        const comment = c.symbolName ? `// ${c.symbolName}` : undefined
        if (c.coilType === 'NEGATED_COIL') {
          this.emit('NOT', undefined, '// Negate RLO')
          this.emit('=', op, comment || '// Negated coil')
        } else if (c.coilType === 'SET_COIL') {
          this.emit('S', op, comment || '// Set')
        } else if (c.coilType === 'RESET_COIL') {
          this.emit('R', op, comment || '// Reset')
        } else {
          this.emit('=', op, comment || '// Coil')
        }
        return
      }

      case 'timer': {
        const t = node as LadderTimerNode
        const inst = t.instanceDb || t.id
        this.emit('CALL', `"${t.timerType || 'TON'}" , "${inst}"`, '// IEC timer', {
          IN: t.inOperand || 'RLO',
          PT: t.ptOperand || 'T#0ms',
          Q: t.qOperand || `"${inst}".Q`,
          ET: t.etOperand || `"${inst}".ET`
        })
        if (hasSuccessor) this.emit('A', `"${inst}".Q`, '// Timer output continues the rung')
        return
      }

      case 'counter': {
        const c = node as LadderCounterNode
        const inst = c.instanceDb || c.id
        const type = c.counterType || 'CTU'
        const params: Record<string, string> = {}
        if (type !== 'CTD') params.CU = c.cuOperand || 'RLO'
        if (type !== 'CTU') params.CD = c.cdOperand || (type === 'CTD' ? 'RLO' : 'FALSE')
        params[type === 'CTD' ? 'LD' : 'R'] = c.rLdOperand || 'FALSE'
        params.PV = String(c.pvOperand ?? 10)
        params.Q = c.qOperand || `"${inst}".${type === 'CTD' ? 'QD' : 'QU'}`
        params.CV = c.cvOperand || `"${inst}".CV`
        this.emit('CALL', `"${type}" , "${inst}"`, '// IEC counter', params)
        if (hasSuccessor) this.emit('A', params.Q, '// Counter output continues the rung')
        return
      }

      case 'comparator': {
        const cmp = node as LadderComparatorNode
        const suffix = cmp.dataType === 'REAL' ? 'R' : cmp.dataType === 'DINT' ? 'D' : 'I'
        const opcode: Record<string, string> = {
          CMP_EQ: '==',
          CMP_NE: '<>',
          CMP_GT: '>',
          CMP_LT: '<',
          CMP_GE: '>=',
          CMP_LE: '<='
        }
        this.emit('A(')
        this.emit('L', cmp.op1 || '0')
        this.emit('L', cmp.op2 || '0')
        this.emit(`${opcode[cmp.comparatorType] || '=='}${suffix}`)
        this.emit(')')
        return
      }

      case 'math': {
        const m = node as LadderMathNode
        const skip = `_SKIP_${this.nextId()}`
        const out = m.out || '???'
        const suffix = m.dataType === 'REAL' ? 'R' : m.dataType === 'DINT' ? 'D' : 'I'
        this.emit('JNB', skip, '// Box runs only when EN is true')
        if (m.boxType === 'MOVE') {
          this.emit('L', m.in1 || '0')
          this.emit('T', out)
        } else if (m.boxType === 'NORM_X' || m.boxType === 'SCALE_X') {
          this.emit('CALL', `"${m.boxType}"`, undefined, {
            MIN: m.min || '0',
            VALUE: m.value || m.in1 || '0',
            MAX: m.max || m.in2 || '0',
            OUT: out
          })
        } else {
          const opcode: Record<string, string> = { ADD: '+', SUB: '-', MUL: '*', DIV: '/' }
          this.emit('L', m.in1 || '0')
          this.emit('L', m.in2 || '0')
          this.emit(`${opcode[m.boxType] || '+'}${suffix}`)
          this.emit('T', out)
        }
        this.placeLabel(skip)
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SCL
  // ---------------------------------------------------------------------------

  public sclStatements(statements: SclStatement[]): void {
    for (const stmt of statements) this.sclStatement(stmt)
  }

  private sclStatement(stmt: SclStatement): void {
    switch (stmt.kind) {
      case 'assign':
        if (this.isBoolExpression(stmt.expression)) {
          this.boolExpression(stmt.expression)
          this.emit('=', stmt.target)
        } else {
          this.valueExpression(stmt.expression)
          this.emit('T', stmt.target)
        }
        return

      case 'if':
        this.sclIf(stmt)
        return

      case 'case':
        this.sclCase(stmt)
        return

      case 'for': {
        const id = this.nextId()
        const start = `_FOR_START_${id}`
        const next = `_FOR_NEXT_${id}`
        const end = `_FOR_END_${id}`
        const stepExpr: SclExpression = stmt.stepExpr || { kind: 'literal', value: 1, raw: '1', line: stmt.line }
        const descending =
          stepExpr.kind === 'unary' && stepExpr.op === '-'
            ? true
            : stepExpr.kind === 'literal' && typeof stepExpr.value === 'number' && stepExpr.value < 0

        this.valueExpression(stmt.startExpr)
        this.emit('T', stmt.iterVar, '// Loop start value')
        this.placeLabel(start)
        this.emit('L', stmt.iterVar)
        this.valueExpression(stmt.endExpr)
        this.emit(descending ? '>=I' : '<=I', undefined, '// Loop bound')
        this.emit('JCN', end)
        this.loops.push({ start: next, end })
        this.sclStatements(stmt.body)
        this.loops.pop()
        this.placeLabel(next)
        this.emit('L', stmt.iterVar)
        this.valueExpression(stepExpr)
        this.emit('+I')
        this.emit('T', stmt.iterVar)
        this.emit('JU', start)
        this.placeLabel(end)
        return
      }

      case 'while': {
        const id = this.nextId()
        const start = `_WHILE_START_${id}`
        const end = `_WHILE_END_${id}`
        this.placeLabel(start)
        this.boolExpression(stmt.condition)
        this.emit('JCN', end)
        this.loops.push({ start, end })
        this.sclStatements(stmt.body)
        this.loops.pop()
        this.emit('JU', start)
        this.placeLabel(end)
        return
      }

      case 'repeat': {
        const id = this.nextId()
        const start = `_REPEAT_START_${id}`
        const check = `_REPEAT_CHECK_${id}`
        const end = `_REPEAT_END_${id}`
        this.placeLabel(start)
        this.loops.push({ start: check, end })
        this.sclStatements(stmt.body)
        this.loops.pop()
        this.placeLabel(check)
        this.boolExpression(stmt.condition)
        this.emit('JCN', start, '// Repeat until the condition is true')
        this.placeLabel(end)
        return
      }

      case 'call':
        this.emit('CALL', stmt.callee, undefined, this.describeArgs(stmt.args))
        return

      case 'return':
        this.emit('BEU', undefined, '// RETURN')
        return

      case 'exit': {
        const loop = this.loops[this.loops.length - 1]
        this.emit('JU', loop ? loop.end : '<no loop>', '// EXIT')
        return
      }

      case 'continue': {
        const loop = this.loops[this.loops.length - 1]
        this.emit('JU', loop ? loop.start : '<no loop>', '// CONTINUE')
        return
      }
    }
  }

  private sclIf(stmt: Extract<SclStatement, { kind: 'if' }>): void {
    const id = this.nextId()
    const end = `_END_IF_${id}`
    const hasMoreBranches = stmt.elsifBranches.length > 0 || !!stmt.elseStatements
    const branchLabel = (index: number): string =>
      index < stmt.elsifBranches.length ? `_ELSIF_${id}_${index}` : stmt.elseStatements ? `_ELSE_${id}` : end

    this.boolExpression(stmt.condition)
    this.emit('JCN', branchLabel(0), '// Skip when the condition is false')
    this.sclStatements(stmt.thenStatements)
    if (hasMoreBranches) this.emit('JU', end)

    stmt.elsifBranches.forEach((branch, index) => {
      this.placeLabel(branchLabel(index))
      this.boolExpression(branch.condition)
      this.emit('JCN', branchLabel(index + 1))
      this.sclStatements(branch.statements)
      this.emit('JU', end)
    })

    if (stmt.elseStatements) {
      this.placeLabel(`_ELSE_${id}`)
      this.sclStatements(stmt.elseStatements)
    }
    this.placeLabel(end)
  }

  private sclCase(stmt: Extract<SclStatement, { kind: 'case' }>): void {
    const id = this.nextId()
    const end = `_END_CASE_${id}`
    const elseLabel = `_CASE_ELSE_${id}`

    stmt.cases.forEach((entry, index) => {
      const label = `_CASE_${id}_${index}`
      for (const value of entry.values) {
        if (typeof value === 'number') {
          this.valueExpression(stmt.selector)
          this.emit('L', String(value))
          this.emit('==I')
        } else {
          this.emit('A(')
          this.valueExpression(stmt.selector)
          this.emit('L', String(value.from))
          this.emit('>=I')
          this.emit(')')
          this.emit('A(')
          this.valueExpression(stmt.selector)
          this.emit('L', String(value.to))
          this.emit('<=I')
          this.emit(')')
        }
        this.emit('JC', label)
      }
    })
    this.emit('JU', stmt.elseStatements ? elseLabel : end)

    stmt.cases.forEach((entry, index) => {
      this.placeLabel(`_CASE_${id}_${index}`)
      this.sclStatements(entry.statements)
      this.emit('JU', end)
    })
    if (stmt.elseStatements) {
      this.placeLabel(elseLabel)
      this.sclStatements(stmt.elseStatements)
    }
    this.placeLabel(end)
  }

  private describeArgs(args: Record<string, SclExpression>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(args)) out[key] = this.describe(value)
    return out
  }

  private describe(expr: SclExpression): string {
    switch (expr.kind) {
      case 'literal':
        return expr.raw
      case 'variable':
        return expr.quoted ? `"${expr.name}"` : expr.name
      case 'unary':
        return `${expr.op} ${this.describe(expr.expr)}`
      case 'binary':
        return `${this.describe(expr.left)} ${expr.op} ${this.describe(expr.right)}`
      case 'call_expr':
        return `${expr.callee}(...)`
    }
  }

  private isBoolExpression(expr: SclExpression): boolean {
    if (expr.kind === 'literal') return typeof expr.value === 'boolean'
    if (expr.kind === 'unary') return expr.op === 'NOT'
    if (expr.kind === 'binary') {
      const op = expr.op.toUpperCase()
      return COMPARE_OPS.includes(op) || LOGIC_OPS.includes(op)
    }
    return false
  }

  /** Numeric instructions use the R suffix when the expression visibly involves a REAL literal. */
  private usesReal(expr: SclExpression): boolean {
    if (expr.kind === 'literal') return typeof expr.value === 'number' && /[.eE]/.test(expr.raw)
    if (expr.kind === 'unary') return this.usesReal(expr.expr)
    if (expr.kind === 'binary') return this.usesReal(expr.left) || this.usesReal(expr.right)
    return false
  }

  /** Leaves the expression's result in the RLO. */
  private boolExpression(expr: SclExpression): void {
    if (expr.kind === 'literal' && typeof expr.value === 'boolean') {
      this.emit(expr.value ? 'SET' : 'CLR')
      return
    }
    if (expr.kind === 'variable') {
      this.emit('A', expr.quoted ? `"${expr.name}"` : expr.name)
      return
    }
    if (expr.kind === 'unary' && expr.op === 'NOT') {
      this.boolExpression(expr.expr)
      this.emit('NOT')
      return
    }
    if (expr.kind === 'binary') {
      const op = expr.op.toUpperCase()
      if (LOGIC_OPS.includes(op)) {
        const opener = op === 'AND' ? 'A(' : op === 'OR' ? 'O(' : 'X('
        this.boolExpression(expr.left)
        this.emit(opener)
        this.boolExpression(expr.right)
        this.emit(')')
        return
      }
      if (COMPARE_OPS.includes(op)) {
        this.valueExpression(expr.left)
        this.valueExpression(expr.right)
        const suffix = this.usesReal(expr) ? 'R' : 'I'
        this.emit(`${COMPARE_OPCODES[op]}${suffix}`)
        return
      }
    }
    this.valueExpression(expr)
    this.emit('L', '0')
    this.emit('<>I', undefined, '// Numeric value used as a condition')
  }

  /** Leaves the expression's result in ACCU1. */
  private valueExpression(expr: SclExpression): void {
    switch (expr.kind) {
      case 'literal':
        this.emit('L', expr.raw)
        return
      case 'variable':
        this.emit('L', expr.quoted ? `"${expr.name}"` : expr.name)
        return
      case 'unary':
        this.valueExpression(expr.expr)
        if (expr.op === '-') this.emit(this.usesReal(expr.expr) ? 'NEGR' : 'NEGI')
        if (expr.op === 'NOT') this.emit('INVI')
        return
      case 'binary': {
        const op = expr.op.toUpperCase()
        if (COMPARE_OPS.includes(op) || LOGIC_OPS.includes(op)) {
          this.boolExpression(expr)
          return
        }
        this.valueExpression(expr.left)
        this.valueExpression(expr.right)
        const suffix = this.usesReal(expr) ? 'R' : 'I'
        if (op === 'MOD') this.emit('MOD')
        else if (op === '**') this.emit('CALL', '"EXPT"')
        else this.emit(`${op}${suffix}`)
        return
      }
      case 'call_expr':
        this.emit('CALL', expr.callee, undefined, this.describeArgs(expr.args))
        return
    }
  }
}

function formatListing(
  blockName: string,
  blockType: string,
  sourceDesc: string,
  instructions: StlInstruction[]
): string {
  const count = instructions.filter((i) => !i.label).length
  const lines: string[] = [
    '// =========================================================================',
    `// Block: ${blockName} (${blockType})`,
    `// Source: ${sourceDesc}`,
    '// STL listing for reading only. It is not MC7 code and is not loaded to a CPU.',
    `// ${count} STL instructions`,
    '// =========================================================================',
    ''
  ]

  let currentNet: number | undefined
  for (const inst of instructions) {
    if (inst.networkNumber !== undefined && inst.networkNumber !== currentNet) {
      currentNet = inst.networkNumber
      lines.push('', `// Network ${currentNet}:`)
    }
    if (inst.label) {
      lines.push(`${inst.label}:`)
      continue
    }
    const number = String(inst.line).padStart(4, '0')
    const text = `${number}    ${inst.opcode.padEnd(8, ' ')} ${inst.operand || ''}`
    lines.push(inst.comment ? `${text.padEnd(44, ' ')} ${inst.comment}` : text.trimEnd())
    for (const [key, value] of Object.entries(inst.parameters || {})) {
      lines.push(`          ${key.padEnd(6, ' ')}:= ${value}`)
    }
  }
  return lines.join('\n')
}

export class StlListingGenerator {
  public static forProject(ladBlocks: LadBlockDefinition[], sclBlocks: SclBlockDefinition[]): ProjectListingSummary {
    const blocks = [...ladBlocks.map((b) => this.forLadBlock(b)), ...sclBlocks.map((b) => this.forSclBlock(b))]
    return {
      blocks,
      totalNetworks: ladBlocks.reduce((sum, b) => sum + (b.networks || []).length, 0),
      totalInstructions: blocks.reduce((sum, b) => sum + b.totalInstructions, 0)
    }
  }

  public static forLadBlock(block: LadBlockDefinition): BlockListing {
    const builder = new ListingBuilder()
    for (const net of block.networks || []) {
      builder.setNetwork(net.networkNumber)
      if (net.isSclNetwork && net.sclCode) {
        builder.sclStatements(this.parseStatements(net.sclCode))
      } else {
        builder.ladNodes((net.nodes || []) as LadderNode[])
      }
    }
    return this.finish(block.name, block.blockType, `LAD (${(block.networks || []).length} networks)`, builder)
  }

  public static forSclBlock(block: SclBlockDefinition): BlockListing {
    const builder = new ListingBuilder()
    const code = block.code || ''
    builder.sclStatements(this.parseStatements(parseSourceBlock(code).body))
    if (builder.instructions.length === 0) builder.emit('BE', undefined, '// No executable statements')
    return this.finish(block.name, block.blockType, `SCL (${code.split('\n').length} lines)`, builder)
  }

  private static parseStatements(code: string): SclStatement[] {
    const { tokens, errors } = SclLexer.tokenize(code)
    if (errors.length > 0) return []
    const parser = new SclParser(tokens)
    const statements = parser.parseProgram()
    return parser.errors.length > 0 ? [] : statements
  }

  private static finish(name: string, type: BlockListing['blockType'], source: string, builder: ListingBuilder): BlockListing {
    const instructions = builder.instructions
    return {
      blockName: name,
      blockType: type,
      totalInstructions: instructions.filter((i) => !i.label).length,
      instructions,
      listingText: formatListing(name, type, source, instructions)
    }
  }
}
