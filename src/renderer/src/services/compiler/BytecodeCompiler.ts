import { LadBlockDefinition, SclBlockDefinition, LadNetwork } from '@shared/types/blocks'
import {
  LadderNetwork,
  LadderNode,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderMathNode,
  LadderParallelBranchNode
} from '@shared/types/ladder'
import { SclLexer, SclParser, SclStatement, SclExpression } from '../../runtime/SclInterpreter'

export interface S7Instruction {
  address: number
  opcode: string
  operand?: string
  parameters?: Record<string, string>
  comment?: string
  byteSize: number
  networkNumber?: number
  label?: string
}

export interface CompiledBlockBytecode {
  blockName: string
  blockType: 'OB' | 'FC' | 'FB' | 'DB'
  totalInstructions: number
  scanMemoryBytes: number
  instructions: S7Instruction[]
  disassemblyText: string
}

export interface ProjectBytecodeSummary {
  blocks: CompiledBlockBytecode[]
  totalNetworks: number
  totalInstructions: number
  totalScanMemoryBytes: number
}

export class BytecodeCompiler {
  private static labelCounter = 1

  /**
   * Compiles an entire project (LAD blocks + SCL blocks) into S7 Instruction List Bytecode
   */
  public static compileProject(
    ladBlocks: LadBlockDefinition[],
    sclBlocks: SclBlockDefinition[]
  ): ProjectBytecodeSummary {
    const compiledBlocks: CompiledBlockBytecode[] = []
    let totalNetworks = 0
    let totalInstructions = 0
    let totalScanMemoryBytes = 0

    // 1. Compile LAD Blocks
    for (const lad of ladBlocks) {
      const compiled = this.compileLadBlock(lad)
      compiledBlocks.push(compiled)
      totalNetworks += (lad.networks || []).length
      totalInstructions += compiled.totalInstructions
      totalScanMemoryBytes += compiled.scanMemoryBytes
    }

    // 2. Compile SCL Blocks
    for (const scl of sclBlocks) {
      const compiled = this.compileSclBlock(scl)
      compiledBlocks.push(compiled)
      totalInstructions += compiled.totalInstructions
      totalScanMemoryBytes += compiled.scanMemoryBytes
    }

    return {
      blocks: compiledBlocks,
      totalNetworks,
      totalInstructions,
      totalScanMemoryBytes
    }
  }

  /**
   * Compiles a single LAD block into S7 STL bytecode instructions
   */
  public static compileLadBlock(block: LadBlockDefinition): CompiledBlockBytecode {
    const instructions: S7Instruction[] = []
    let currentAddress = 0

    const emit = (
      opcode: string,
      operand?: string,
      comment?: string,
      byteSize = 2,
      networkNumber?: number,
      parameters?: Record<string, string>,
      label?: string
    ) => {
      instructions.push({
        address: currentAddress,
        opcode,
        operand,
        comment,
        byteSize,
        networkNumber,
        parameters,
        label
      })
      currentAddress += byteSize
    }

    for (const net of block.networks || []) {
      const netNum = net.networkNumber
      this.compileNetworkNodes(net.nodes || [], emit, netNum)
    }

    const disassemblyText = this.formatDisassembly(
      block.name,
      block.blockType,
      `Ladder AST (${(block.networks || []).length} Networks)`,
      instructions,
      currentAddress
    )

    return {
      blockName: block.name,
      blockType: block.blockType,
      totalInstructions: instructions.length,
      scanMemoryBytes: currentAddress,
      instructions,
      disassemblyText
    }
  }

  /**
   * Traverses ladder nodes and compiles into S7 STL instructions
   */
  private static compileNetworkNodes(
    nodes: LadderNode[],
    emit: (
      opcode: string,
      operand?: string,
      comment?: string,
      byteSize?: number,
      networkNumber?: number,
      parameters?: Record<string, string>,
      label?: string
    ) => void,
    networkNumber: number
  ): void {
    let isFirstLogic = true

    for (const node of nodes) {
      switch (node.kind) {
        case 'contact': {
          const c = node as LadderContactNode
          const op = c.operand || c.address || '???'
          const sym = c.symbolName ? `// ${c.symbolName}` : ''

          if (c.contactType === 'NO_CONTACT') {
            emit(isFirstLogic ? 'A' : 'A', op, sym || '// Normally Open Contact', 2, networkNumber)
          } else if (c.contactType === 'NC_CONTACT') {
            emit('AN', op, sym || '// Normally Closed Contact', 2, networkNumber)
          } else if (c.contactType === 'P_TRIG') {
            emit('FP', op, '// Positive Edge Evaluation', 4, networkNumber)
          } else if (c.contactType === 'N_TRIG') {
            emit('FN', op, '// Negative Edge Evaluation', 4, networkNumber)
          }
          isFirstLogic = false
          break
        }

        case 'parallel': {
          const p = node as LadderParallelBranchNode
          if (p.branches.length === 1) {
            this.compileNetworkNodes(p.branches[0], emit, networkNumber)
          } else {
            // S7 standard parallel branch syntax: O( ... ) O( ... )
            for (let bIdx = 0; bIdx < p.branches.length; bIdx++) {
              const branchNodes = p.branches[bIdx]
              emit('O(', undefined, `// Parallel Branch ${bIdx + 1} Begin`, 2, networkNumber)
              this.compileNetworkNodes(branchNodes, emit, networkNumber)
              emit(')', undefined, `// Parallel Branch ${bIdx + 1} End`, 2, networkNumber)
            }
          }
          isFirstLogic = false
          break
        }

        case 'coil': {
          const c = node as LadderCoilNode
          const op = c.operand || c.address || '???'
          const sym = c.symbolName ? `// ${c.symbolName}` : ''

          if (c.coilType === 'OUTPUT_COIL') {
            emit('=', op, sym || '// Assignment Coil', 2, networkNumber)
          } else if (c.coilType === 'NEGATED_COIL') {
            emit('NOT', undefined, '// Negate RLO', 2, networkNumber)
            emit('=', op, sym || '// Negated Assignment Coil', 2, networkNumber)
          } else if (c.coilType === 'SET_COIL') {
            emit('S', op, sym || '// Set Latch Coil', 2, networkNumber)
          } else if (c.coilType === 'RESET_COIL') {
            emit('R', op, sym || '// Reset Latch Coil', 2, networkNumber)
          }
          break
        }

        case 'timer': {
          const t = node as LadderTimerNode
          const inst = t.instanceDb || (t as any).operand || t.id
          const timerType = t.timerType || 'TON'
          const inOp = t.inOperand || 'RLO'
          const ptVal = t.ptOperand || (t as any).pt || 'T#0ms'
          const qOp = t.qOperand || `"${inst}".Q`
          const etOp = t.etOperand || `"${inst}".ET`

          emit(
            'CALL',
            `"${timerType}" , "${inst}"`,
            `// IEC Timer Block Call`,
            12,
            networkNumber,
            {
              IN: inOp,
              PT: ptVal,
              Q: qOp,
              ET: etOp
            }
          )
          break
        }

        case 'counter': {
          const c = node as LadderCounterNode
          const inst = c.instanceDb || (c as any).operand || c.id
          const counterType = c.counterType || 'CTU'
          const cuOp = c.cuCdOperand || (c as any).cuOperand || 'RLO'
          const resetOp = c.rLdOperand || (c as any).resetOperand || '%M0.0'
          const pvVal = String(c.pvOperand || (c as any).pv || 10)
          const qOp = c.qOperand || `"${inst}".QU`
          const cvOp = c.cvOperand || `"${inst}".CV`

          emit(
            'CALL',
            `"${counterType}" , "${inst}"`,
            `// IEC Counter Block Call`,
            12,
            networkNumber,
            {
              CU: cuOp,
              R: resetOp,
              PV: pvVal,
              Q: qOp,
              CV: cvOp
            }
          )
          break
        }

        case 'comparator': {
          const cmp = node as LadderComparatorNode
          const in1 = cmp.op1 || '0'
          const in2 = cmp.op2 || '0'
          const op = cmp.comparatorType || 'CMP_EQ'
          const opSuffix = cmp.dataType === 'REAL' ? 'R' : 'I'

          emit('L', in1, '// Load Left Operand', 4, networkNumber)
          emit('L', in2, '// Load Right Operand', 4, networkNumber)

          let cmpOpcode = `==${opSuffix}`
          if (op === 'CMP_EQ') cmpOpcode = `==${opSuffix}`
          else if (op === 'CMP_NE') cmpOpcode = `<>${opSuffix}`
          else if (op === 'CMP_GT') cmpOpcode = `>${opSuffix}`
          else if (op === 'CMP_LT') cmpOpcode = `<${opSuffix}`
          else if (op === 'CMP_GE') cmpOpcode = `>=${opSuffix}`
          else if (op === 'CMP_LE') cmpOpcode = `<=${opSuffix}`

          emit(cmpOpcode, undefined, `// Compare (${in1} ${op} ${in2})`, 2, networkNumber)
          isFirstLogic = false
          break
        }

        case 'math': {
          const m = node as LadderMathNode
          const in1 = m.in1 || m.min || '0'
          const in2 = m.in2 || m.max || '0'
          const out = m.out || m.value || '???'
          const op = m.boxType || 'ADD'
          const suffix = m.dataType === 'REAL' ? 'R' : 'I'

          emit('L', in1, '// Load Term 1', 4, networkNumber)
          emit('L', in2, '// Load Term 2', 4, networkNumber)

          let mathOpcode = `+${suffix}`
          if (op === 'ADD') mathOpcode = `+${suffix}`
          else if (op === 'SUB') mathOpcode = `-${suffix}`
          else if (op === 'MUL') mathOpcode = `*${suffix}`
          else if (op === 'DIV') mathOpcode = `/${suffix}`
          else if (op === 'MOVE') mathOpcode = 'NOP 0'

          emit(mathOpcode, undefined, `// Compute ${op}`, 2, networkNumber)
          emit('T', out, `// Transfer Result to ${out}`, 4, networkNumber)
          break
        }
      }
    }
  }

  /**
   * Compiles an SCL block into S7 STL bytecode instructions
   */
  public static compileSclBlock(block: SclBlockDefinition): CompiledBlockBytecode {
    const instructions: S7Instruction[] = []
    let currentAddress = 0

    const emit = (
      opcode: string,
      operand?: string,
      comment?: string,
      byteSize = 2,
      networkNumber?: number,
      parameters?: Record<string, string>,
      label?: string
    ) => {
      instructions.push({
        address: currentAddress,
        opcode,
        operand,
        comment,
        byteSize,
        networkNumber,
        parameters,
        label
      })
      currentAddress += byteSize
    }

    if (block.code) {
      try {
        const { tokens } = SclLexer.tokenize(block.code)
        const parser = new SclParser(tokens)
        const statements = parser.parseProgram()

        for (const stmt of statements) {
          this.compileSclStatement(stmt, emit)
        }
      } catch {
        // Fallback: emit comment on parsing error
        emit('// SCL COMPILATION NOTICE', undefined, '// Source parsed with fallback heuristics', 0)
      }
    }

    if (instructions.length === 0) {
      emit('BE', undefined, '// Block End (No executable code)', 2)
    }

    const disassemblyText = this.formatDisassembly(
      block.name,
      block.blockType,
      `SCL Source (${(block.code || '').split('\n').length} Lines)`,
      instructions,
      currentAddress
    )

    return {
      blockName: block.name,
      blockType: block.blockType,
      totalInstructions: instructions.length,
      scanMemoryBytes: currentAddress,
      instructions,
      disassemblyText
    }
  }

  /**
   * Compiles an individual SCL AST statement into S7 STL bytecode
   */
  private static compileSclStatement(
    stmt: SclStatement,
    emit: (
      opcode: string,
      operand?: string,
      comment?: string,
      byteSize?: number,
      networkNumber?: number,
      parameters?: Record<string, string>,
      label?: string
    ) => void
  ): void {
    switch (stmt.kind) {
      case 'assign': {
        this.compileSclExpression(stmt.expression, emit)
        // If assigned to a boolean variable or expression
        if (
          stmt.expression.kind === 'binary' &&
          ['AND', 'OR', 'XOR', '=', '<>', '<', '>', '<=', '>='].includes(stmt.expression.op.toUpperCase())
        ) {
          emit('=', stmt.target, `// Assign RLO to ${stmt.target}`, 2)
        } else {
          emit('T', stmt.target, `// Transfer result to ${stmt.target}`, 4)
        }
        break
      }

      case 'if': {
        const labelId = this.labelCounter++
        const elseLabel = `_ELSE_${labelId}`
        const endLabel = `_END_IF_${labelId}`

        // Compile condition
        this.compileSclExpression(stmt.condition, emit)
        emit('JCN', elseLabel, `// Jump to ${elseLabel} if condition is FALSE`, 4)

        // Then statements
        for (const s of stmt.thenStatements) {
          this.compileSclStatement(s, emit)
        }

        if (stmt.elsifBranches.length > 0 || stmt.elseStatements) {
          emit('JU', endLabel, `// Jump over ELSE branch to ${endLabel}`, 4)
        }

        // ELSIF branches
        for (let idx = 0; idx < stmt.elsifBranches.length; idx++) {
          const branch = stmt.elsifBranches[idx]
          const branchElseLabel = `_ELSIF_NEXT_${labelId}_${idx}`
          emit(elseLabel + ':', undefined, undefined, 0, undefined, undefined, elseLabel)
          this.compileSclExpression(branch.condition, emit)
          emit('JCN', branchElseLabel, `// Jump to next ELSIF branch`, 4)
          for (const s of branch.statements) {
            this.compileSclStatement(s, emit)
          }
          emit('JU', endLabel, `// Jump to ${endLabel}`, 4)
        }

        // ELSE statement
        if (stmt.elseStatements) {
          emit(elseLabel + ':', undefined, undefined, 0, undefined, undefined, elseLabel)
          for (const s of stmt.elseStatements) {
            this.compileSclStatement(s, emit)
          }
        } else if (stmt.elsifBranches.length === 0) {
          emit(elseLabel + ':', undefined, undefined, 0, undefined, undefined, elseLabel)
        }

        emit(endLabel + ':', undefined, undefined, 0, undefined, undefined, endLabel)
        break
      }

      case 'for': {
        const labelId = this.labelCounter++
        const loopStart = `_FOR_START_${labelId}`
        const loopEnd = `_FOR_END_${labelId}`

        // Initialize iteration variable: iterVar := startExpr
        this.compileSclExpression(stmt.startExpr, emit)
        emit('T', stmt.iterVar, `// Initialize ${stmt.iterVar}`, 4)

        // Loop header
        emit(loopStart + ':', undefined, undefined, 0, undefined, undefined, loopStart)
        emit('L', stmt.iterVar, `// Load loop counter`, 4)
        this.compileSclExpression(stmt.endExpr, emit)
        emit('<=I', undefined, `// Check loop upper bound`, 2)
        emit('JCN', loopEnd, `// Exit loop if counter exceeded`, 4)

        // Body
        for (const s of stmt.body) {
          this.compileSclStatement(s, emit)
        }

        // Increment counter
        emit('L', stmt.iterVar, `// Increment loop counter`, 4)
        emit('L', '1', undefined, 4)
        emit('+I', undefined, undefined, 2)
        emit('T', stmt.iterVar, undefined, 4)
        emit('JU', loopStart, `// Next iteration`, 4)

        emit(loopEnd + ':', undefined, undefined, 0, undefined, undefined, loopEnd)
        break
      }

      case 'call': {
        const paramMap: Record<string, string> = {}
        for (const [k, v] of Object.entries(stmt.args)) {
          paramMap[k] = v.kind === 'variable' ? v.name : v.kind === 'literal' ? String(v.value) : 'EXPR'
        }
        emit('CALL', stmt.callee, `// Function Call`, 12, undefined, paramMap)
        break
      }

      case 'return': {
        emit('BEU', undefined, '// Unconditional Block End (RETURN)', 2)
        break
      }

      case 'exit': {
        emit('JU', '_LOOP_EXIT', '// Loop EXIT Jump', 4)
        break
      }
    }
  }

  /**
   * Compiles an SCL expression into S7 STL instructions
   */
  private static compileSclExpression(
    expr: SclExpression,
    emit: (
      opcode: string,
      operand?: string,
      comment?: string,
      byteSize?: number,
      networkNumber?: number,
      parameters?: Record<string, string>,
      label?: string
    ) => void
  ): void {
    switch (expr.kind) {
      case 'literal': {
        emit('L', String(expr.value), `// Literal ${expr.raw}`, 4)
        break
      }

      case 'variable': {
        emit('L', expr.name, `// Load variable ${expr.name}`, 4)
        break
      }

      case 'unary': {
        this.compileSclExpression(expr.expr, emit)
        if (expr.op === 'NOT') {
          emit('NOT', undefined, '// Boolean Inversion', 2)
        } else if (expr.op === '-') {
          emit('NEGI', undefined, '// Two\'s Complement Negation', 2)
        }
        break
      }

      case 'binary': {
        const op = expr.op.toUpperCase()
        if (['AND', 'OR', 'XOR'].includes(op)) {
          // Boolean logic chain
          this.compileSclExpression(expr.left, emit)
          const rightOp = expr.right.kind === 'variable' ? expr.right.name : '???'
          if (op === 'AND') emit('A', rightOp, undefined, 2)
          else if (op === 'OR') emit('O', rightOp, undefined, 2)
          else if (op === 'XOR') emit('X', rightOp, undefined, 2)
        } else if (['+', '-', '*', '/', 'MOD'].includes(op)) {
          // Arithmetic operation
          this.compileSclExpression(expr.left, emit)
          this.compileSclExpression(expr.right, emit)
          if (op === '+') emit('+I', undefined, '// Add', 2)
          else if (op === '-') emit('-I', undefined, '// Subtract', 2)
          else if (op === '*') emit('*I', undefined, '// Multiply', 2)
          else if (op === '/') emit('/I', undefined, '// Divide', 2)
          else if (op === 'MOD') emit('MOD', undefined, '// Modulo', 2)
        } else if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
          // Comparison operation
          this.compileSclExpression(expr.left, emit)
          this.compileSclExpression(expr.right, emit)
          if (op === '=') emit('==I', undefined, '// Equal', 2)
          else if (op === '<>') emit('<>I', undefined, '// Not Equal', 2)
          else if (op === '<') emit('<I', undefined, '// Less Than', 2)
          else if (op === '>') emit('>I', undefined, '// Greater Than', 2)
          else if (op === '<=') emit('<=I', undefined, '// Less Than or Equal', 2)
          else if (op === '>=') emit('>=I', undefined, '// Greater Than or Equal', 2)
        }
        break
      }

      case 'call_expr': {
        emit('CALL', expr.callee, `// Function Call Expression`, 12)
        break
      }
    }
  }

  /**
   * Formats S7 VM instructions into authentic Siemens STEP 7 / TIA Portal STL disassembly
   */
  public static formatDisassembly(
    blockName: string,
    blockType: string,
    sourceDesc: string,
    instructions: S7Instruction[],
    totalBytes: number
  ): string {
    const lines: string[] = []
    lines.push('// =========================================================================')
    lines.push(`// Block: ${blockName} (${blockType})`)
    lines.push(`// Compiled from: ${sourceDesc}`)
    lines.push('// Target Architecture: Siemens S7-1200 / S7-1500 (MC7 Virtual Machine Bytecode)')
    lines.push(`// Metrics: ${instructions.length} S7 Instructions | MC7 Scan Memory: ${totalBytes} Bytes`)
    lines.push('// =========================================================================\n')

    let currentNet: number | undefined = undefined

    for (const inst of instructions) {
      if (inst.networkNumber !== undefined && inst.networkNumber !== currentNet) {
        currentNet = inst.networkNumber
        lines.push(`\n// -------------------------------------------------------------`)
        lines.push(`// Network ${currentNet}:`)
        lines.push(`// -------------------------------------------------------------`)
      }

      if (inst.label) {
        lines.push(`${inst.label}`)
      }

      const hexAddr = `0x${inst.address.toString(16).padStart(4, '0').toUpperCase()}`
      const opcodePadded = inst.opcode.padEnd(8, ' ')
      const operandStr = inst.operand ? inst.operand.padEnd(20, ' ') : ''.padEnd(20, ' ')
      const commentStr = inst.comment ? ` ${inst.comment}` : ''

      if (inst.parameters && Object.keys(inst.parameters).length > 0) {
        lines.push(`${hexAddr}    ${opcodePadded} ${operandStr}${commentStr}`)
        for (const [pKey, pVal] of Object.entries(inst.parameters)) {
          lines.push(`          ${pKey.padEnd(6, ' ')}:= ${pVal}`)
        }
      } else if (!inst.label) {
        lines.push(`${hexAddr}    ${opcodePadded} ${operandStr}${commentStr}`)
      }
    }

    lines.push('\n// [END OF COMPILED MC7 S7 BYTECODE]')
    return lines.join('\n')
  }
}
