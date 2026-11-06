/**
 * Ladder DSL (Domain-Specific Language) Lexer & Deterministic Compiler
 *
 * Implements a concise, token-efficient, deterministic text format for PLC Ladder Logic.
 * Compiles Ladder DSL into 100% compliant Siemens S7 LadderNetwork[] ASTs and TagDefinition[] tables,
 * with Conflict-Free Tag Address Allocation and bidirectional AST-to-DSL roundtripping.
 */

import {
  LadderNetwork,
  LadderSeriesNode,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderMathNode,
  LadderParallelBranchNode,
  ContactType,
  CoilType,
  TimerType,
  CounterType,
  ComparatorType,
  MathBoxType
} from '@shared/types/ladder'
import { TagDefinition } from '@shared/types/tags'
import { S7DataType } from '@shared/types/s7types'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'

export interface DslCompilationResult {
  success: boolean
  explanation?: string
  tags: TagDefinition[]
  networks: LadderNetwork[]
  errors: string[]
  rawDsl: string
}

export interface DslCompilerOptions {
  existingTags?: TagDefinition[]
  /** Tags that go away with this program unless it uses them. Usable by name, but their addresses are free. */
  releasedTags?: TagDefinition[]
  /**
   * Tags that stay when the program is replaced. A guessed address avoids them. A declared address is kept even
   * on top of one, because moving it would change the wiring unasked: the project compile reports the overlap.
   */
  keptTags?: TagDefinition[]
  defaultBlockName?: string
  /** Merker bytes the CPU writes itself, such as clock and system memory. Nothing is placed there. */
  reservedMerkerBytes?: number[]
}

/**
 * Splits a string by delimiter only at the top bracket/parenthesis level.
 * Ignores commas inside '...', "...", (...), [...], {...}.
 */
export function splitTopLevel(str: string, delimiter: string = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let inDoubleQuote = false
  let inSingleQuote = false
  let current = ''

  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    const prevChar = i > 0 ? str[i - 1] : ''

    if (char === '"' && prevChar !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }

    if (char === "'" && prevChar !== '\\' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }

    if (!inDoubleQuote && !inSingleQuote) {
      if (char === '(' || char === '[' || char === '{') {
        depth++
      } else if (char === ')' || char === ']' || char === '}') {
        if (depth > 0) depth--
      } else if (char === delimiter && depth === 0) {
        parts.push(current.trim())
        current = ''
        continue
      }
    }

    current += char
  }

  if (current.trim().length > 0) {
    parts.push(current.trim())
  }

  return parts
}

/**
 * Extracts function call name and inside argument string:
 * e.g. "SERIES( A, B )" -> { name: "SERIES", argsStr: " A, B " }
 */
export function parseFunctionCall(str: string): { name: string; argsStr: string } | null {
  const trimmed = str.trim()
  const parenIdx = trimmed.indexOf('(')
  if (parenIdx <= 0 || !trimmed.endsWith(')')) {
    return null
  }
  const name = trimmed.substring(0, parenIdx).trim().toUpperCase()
  const argsStr = trimmed.substring(parenIdx + 1, trimmed.length - 1)
  return { name, argsStr }
}

export class LadderDslCompiler {
  /**
   * Compiles Ladder DSL text into LadderNetwork[] and TagDefinition[] AST.
   */
  public static compileLadderDslToAst(
    dslText: string,
    options?: DslCompilerOptions
  ): DslCompilationResult {
    const errors: string[] = []
    const lines = dslText.split(/\r?\n/)

    const declaredTags: TagDefinition[] = []
    const networks: LadderNetwork[] = []
    let explanation: string | undefined = undefined

    // Address allocation state
    const usedBitCoordinates = new Set<string>() // e.g. "I:0:1", "Q:0:0", "M:0:0"
    const usedAddresses = new Map<string, string>() // formattedAddr -> tagName
    const addressRewrites = new Map<string, string>() // oldAddr -> newAddr
    const tagNameToTag = new Map<string, TagDefinition>()

    for (const byte of options?.reservedMerkerBytes || []) {
      for (let bit = 0; bit < 8; bit++) usedBitCoordinates.add(`M:${byte}:${bit}`)
    }

    // An existing tag keeps its address when the program uses it without declaring it again.
    // One declared again gives up its old address, so tags can swap addresses.
    const redeclared = new Set(
      Array.from(dslText.matchAll(/^\s*TAG\s+([A-Za-z0-9_]+)/gim)).map((m) => m[1].toLowerCase())
    )
    const knownTags = new Map<string, TagDefinition>()
    for (const released of options?.releasedTags || []) {
      if (released.address && !redeclared.has(released.name.toLowerCase())) {
        knownTags.set(released.name.toLowerCase(), released)
      }
    }
    const keptAddresses = new Set<string>()
    for (const kept of options?.keptTags || []) {
      const norm = normalizeS7Address(kept.address || '')
      if (!norm.isValid) continue
      const upper = norm.formatted.toUpperCase()
      keptAddresses.add(upper)
      usedAddresses.set(upper, kept.name)
      if (norm.area && norm.byteAddress !== undefined) {
        usedBitCoordinates.add(`${norm.area}:${norm.byteAddress}:${norm.bitAddress !== undefined ? norm.bitAddress : 0}`)
      }
      if (!redeclared.has(kept.name.toLowerCase())) knownTags.set(kept.name.toLowerCase(), kept)
    }

    // Register existing tags if provided
    if (options?.existingTags) {
      for (const ex of options.existingTags) {
        if (!ex.address || redeclared.has(ex.name.toLowerCase())) continue
        knownTags.set(ex.name.toLowerCase(), ex)
        const norm = normalizeS7Address(ex.address)
        if (norm.isValid) {
          const upper = norm.formatted.toUpperCase()
          usedAddresses.set(upper, ex.name)
          if (norm.area && norm.byteAddress !== undefined) {
            const bit = norm.bitAddress !== undefined ? norm.bitAddress : 0
            usedBitCoordinates.add(`${norm.area}:${norm.byteAddress}:${bit}`)
          }
        }
      }
    }

    const allocateNextFreeBit = (area: 'I' | 'Q' | 'M'): string => {
      for (let byte = 0; byte < 1000; byte++) {
        for (let bit = 0; bit < 8; bit++) {
          const coordKey = `${area}:${byte}:${bit}`
          const candidate = `%${area}${byte}.${bit}`
          if (!usedBitCoordinates.has(coordKey) && !usedAddresses.has(candidate)) {
            usedBitCoordinates.add(coordKey)
            return candidate
          }
        }
      }
      return `%${area}0.0`
    }

    // 1. First pass: Collect explanation and tags, group network definition lines
    let inExplanation = false
    const explanationLines: string[] = []
    const rawNetworkBlocks: Array<{ header: string; exprLines: string[] }> = []
    let currentNetBlock: { header: string; exprLines: string[] } | null = null

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const rawLine = lines[lineIndex]
      const trimmed = rawLine.trim()

      if (!trimmed) continue

      // Check for explanation block
      if (
        trimmed.toUpperCase().startsWith('# EXPLANATION') ||
        trimmed.toUpperCase().startsWith('// EXPLANATION')
      ) {
        inExplanation = true
        continue
      }

      if (inExplanation) {
        if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('NW ') || trimmed.startsWith('TAG ')) {
          if (!trimmed.startsWith('# ') && !trimmed.startsWith('// ')) {
            inExplanation = false
          } else {
            explanationLines.push(trimmed.replace(/^(#|\/\/)\s*/, ''))
            continue
          }
        } else {
          explanationLines.push(trimmed)
          continue
        }
      }

      // Skip general comment headers
      if (
        trimmed.toUpperCase().startsWith('# TAG DECLARATIONS') ||
        trimmed.toUpperCase().startsWith('// TAG DECLARATIONS') ||
        trimmed.toUpperCase().startsWith('# NETWORK DEFINITIONS') ||
        trimmed.toUpperCase().startsWith('// NETWORK DEFINITIONS') ||
        (trimmed.startsWith('#') && !trimmed.toUpperCase().startsWith('NW ')) ||
        (trimmed.startsWith('//') && !trimmed.toUpperCase().startsWith('NW '))
      ) {
        continue
      }

      // Check for TAG declaration:
      // TAG <Name> <Address> [DataType] ["<Comment>"]
      if (trimmed.toUpperCase().startsWith('TAG ')) {
        const tagMatch = trimmed.match(
          /^TAG\s+([A-Za-z0-9_]+)\s+([%A-Za-z0-9_.]+)(?:\s+([A-Za-z]+))?(?:\s+"([^"]*)"|\s+'([^']*)'|\s+(.*))?$/i
        )

        if (tagMatch) {
          const name = tagMatch[1].trim()
          let rawAddress = tagMatch[2].trim()
          const rawDataType = (tagMatch[3] || 'BOOL').trim().toUpperCase() as S7DataType
          const comment = (tagMatch[4] || tagMatch[5] || tagMatch[6] || '').trim()

          const norm = normalizeS7Address(rawAddress)
          let finalAddress = norm.isValid ? norm.formatted.toUpperCase() : rawAddress.toUpperCase()
          const area = (finalAddress.startsWith('%I') ? 'I' : finalAddress.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
          const isBit = rawDataType === 'BOOL' || !finalAddress.includes('W')

          let coordKey: string | null = null
          if (norm.isValid && norm.area && norm.byteAddress !== undefined) {
            const bit = norm.bitAddress !== undefined ? norm.bitAddress : 0
            coordKey = `${norm.area}:${norm.byteAddress}:${bit}`
          }

          // Conflict-Free Address Allocation Check:
          const existingOccupant = usedAddresses.get(finalAddress)
          const isColliding =
            !keptAddresses.has(finalAddress) &&
            ((existingOccupant && existingOccupant.toLowerCase() !== name.toLowerCase()) ||
              (coordKey && usedBitCoordinates.has(coordKey) && existingOccupant?.toLowerCase() !== name.toLowerCase()))

          if (isColliding) {
            // Allocate next free sequential bit in same area
            const safeAddr = allocateNextFreeBit(area)
            addressRewrites.set(finalAddress, safeAddr)
            finalAddress = safeAddr
            const safeNorm = normalizeS7Address(safeAddr)
            if (safeNorm.isValid && safeNorm.area && safeNorm.byteAddress !== undefined) {
              coordKey = `${safeNorm.area}:${safeNorm.byteAddress}:${safeNorm.bitAddress || 0}`
            }
          }

          usedAddresses.set(finalAddress, name)
          if (coordKey) {
            usedBitCoordinates.add(coordKey)
          }

          const tagDef: TagDefinition = {
            id: `tag_${name.toLowerCase()}`,
            name,
            dataType: rawDataType,
            address: finalAddress,
            comment: comment || undefined
          }

          declaredTags.push(tagDef)
          tagNameToTag.set(name.toLowerCase(), tagDef)
        } else {
          errors.push(`Invalid TAG declaration on line ${lineIndex + 1}: ${rawLine}`)
        }
        continue
      }

      // Check for Network start:
      // NW <num> "<Title>": <EXPR>
      const nwHeaderMatch = trimmed.match(/^NW\s*(\d+)?\s*(?:"([^"]*)"|'([^']*)'|([^:]*))?\s*:(.*)$/i)
      if (nwHeaderMatch) {
        if (currentNetBlock) {
          rawNetworkBlocks.push(currentNetBlock)
        }
        currentNetBlock = {
          header: trimmed,
          exprLines: [nwHeaderMatch[5].trim()]
        }
        continue
      }

      // If we are currently inside a network definition, append line
      if (currentNetBlock) {
        currentNetBlock.exprLines.push(trimmed)
      }
    }

    if (currentNetBlock) {
      rawNetworkBlocks.push(currentNetBlock)
    }

    if (explanationLines.length > 0) {
      explanation = explanationLines.join('\n').trim()
    }

    // Helper to auto-infer tags for undeclared operands
    let inferBitCounter = 0
    const resolveOrCreateTag = (operand: string, defaultKind?: 'contact' | 'coil'): { name: string; address: string } => {
      const cleanOp = operand.trim()
      const lower = cleanOp.toLowerCase()

      // If it's a sub-bit or sub-word like T1.Q, T1.ET, C1.QU, return as-is
      if (/^[A-Za-z0-9_]+\.(Q|IN|ET|PT|QU|QD|CV|PV)$/i.test(cleanOp)) {
        return { name: cleanOp, address: cleanOp }
      }

      // Check declared tags by name
      const existingByName = tagNameToTag.get(lower)
      if (existingByName) {
        return { name: existingByName.name, address: existingByName.address }
      }

      const known = knownTags.get(lower)
      if (known) {
        const tag = { ...known }
        declaredTags.push(tag)
        tagNameToTag.set(lower, tag)
        return { name: tag.name, address: tag.address }
      }

      // Check if cleanOp is an S7 address (e.g. %I0.0, %Q0.0)
      const norm = normalizeS7Address(cleanOp)
      if (norm.isValid) {
        const formatted = norm.formatted.toUpperCase()
        const rewritten = addressRewrites.get(formatted) || formatted
        // Check if an existing tag has this address
        for (const t of declaredTags) {
          if (t.address.toUpperCase() === rewritten) {
            return { name: t.name, address: rewritten }
          }
        }
        // Inferred tag name from address
        const autoName = `Tag_${rewritten.replace(/[^A-Za-z0-9]/g, '_')}`
        const newTag: TagDefinition = {
          id: `tag_${autoName.toLowerCase()}`,
          name: autoName,
          dataType: 'BOOL',
          address: rewritten
        }
        declaredTags.push(newTag)
        tagNameToTag.set(autoName.toLowerCase(), newTag)
        usedAddresses.set(rewritten, autoName)
        return { name: autoName, address: rewritten }
      }

      // Unresolved symbol name: auto-assign safe sequential address
      let targetArea: 'I' | 'Q' | 'M' = 'M'
      if (
        lower.startsWith('start') ||
        lower.startsWith('stop') ||
        lower.includes('btn') ||
        lower.includes('button') ||
        lower.includes('sensor') ||
        lower.includes('switch') ||
        lower.includes('buton') ||
        lower.includes('anahtar') ||
        lower.startsWith('in_')
      ) {
        targetArea = 'I'
      } else if (
        lower.includes('motor') ||
        lower.includes('pump') ||
        lower.includes('valve') ||
        lower.includes('led') ||
        lower.includes('lamp') ||
        lower.includes('lamba') ||
        lower.includes('isik') ||
        lower.includes('ışık') ||
        lower.includes('siren') ||
        lower.includes('valf') ||
        lower.includes('kontakt') ||
        lower.includes('coil') ||
        lower.startsWith('out_') ||
        defaultKind === 'coil'
      ) {
        targetArea = 'Q'
      }

      const safeAddr = allocateNextFreeBit(targetArea)
      const inferredTag: TagDefinition = {
        id: `tag_${lower}`,
        name: cleanOp,
        dataType: 'BOOL',
        address: safeAddr,
        comment: `Auto-inferred ${cleanOp}`
      }
      declaredTags.push(inferredTag)
      tagNameToTag.set(lower, inferredTag)
      usedAddresses.set(safeAddr, cleanOp)

      return { name: cleanOp, address: safeAddr }
    }

    // 2. Second pass: Parse Network Expressions into LadderSeriesNode[]
    let globalNodeCounter = 1

    const parseNodeOrBranch = (expr: string): LadderSeriesNode[] => {
      const trimmed = expr.trim()
      if (!trimmed) return []

      const call = parseFunctionCall(trimmed)
      if (!call) {
        // If it's a bare operand, default to NO contact
        const resolved = resolveOrCreateTag(trimmed, 'contact')
        return [
          {
            id: `node_${globalNodeCounter++}`,
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: resolved.name,
            symbolName: resolved.name,
            address: resolved.address
          } as LadderContactNode
        ]
      }

      const { name, argsStr } = call
      const subArgs = splitTopLevel(argsStr, ',')

      // SERIES( ... )
      if (name === 'SERIES') {
        const nodes: LadderSeriesNode[] = []
        for (const arg of subArgs) {
          nodes.push(...parseNodeOrBranch(arg))
        }
        return nodes
      }

      // PARALLEL( ... )
      if (name === 'PARALLEL') {
        const branches: LadderSeriesNode[][] = []
        for (const branchExpr of subArgs) {
          const branchNodes = parseNodeOrBranch(branchExpr)
          if (branchNodes.length > 0) {
            branches.push(branchNodes)
          }
        }
        if (branches.length === 0) return []
        const parallelNode: LadderParallelBranchNode = {
          id: `parallel_${globalNodeCounter++}`,
          kind: 'parallel',
          branches
        }
        return [parallelNode]
      }

      // Contacts: NO, NC, P_TRIG, N_TRIG
      if (name === 'NO' || name === 'NC' || name === 'P_TRIG' || name === 'N_TRIG') {
        const operandRaw = subArgs[0]?.trim() || 'UNDEFINED'
        const contactType: ContactType =
          name === 'NO'
            ? 'NO_CONTACT'
            : name === 'NC'
              ? 'NC_CONTACT'
              : (name as ContactType)

        const resolved = resolveOrCreateTag(operandRaw, 'contact')
        const contactNode: LadderContactNode = {
          id: `contact_${globalNodeCounter++}`,
          kind: 'contact',
          contactType,
          operand: resolved.name,
          symbolName: resolved.name,
          address: resolved.address
        }
        return [contactNode]
      }

      // Coils: COIL, NEG_COIL, SET, RESET
      if (name === 'COIL' || name === 'NEG_COIL' || name === 'SET' || name === 'RESET') {
        const operandRaw = subArgs[0]?.trim() || 'UNDEFINED'
        const coilType: CoilType =
          name === 'COIL'
            ? 'OUTPUT_COIL'
            : name === 'NEG_COIL'
              ? 'NEGATED_COIL'
              : name === 'SET'
                ? 'SET_COIL'
                : 'RESET_COIL'

        const resolved = resolveOrCreateTag(operandRaw, 'coil')
        const coilNode: LadderCoilNode = {
          id: `coil_${globalNodeCounter++}`,
          kind: 'coil',
          coilType,
          operand: resolved.name,
          symbolName: resolved.name,
          address: resolved.address
        }
        return [coilNode]
      }

      // Timers: TON, TOF, TP
      if (name === 'TON' || name === 'TOF' || name === 'TP') {
        const instName = subArgs[0]?.trim() || `T${globalNodeCounter}`
        let ptValue = 'T#10s'

        // Check for PT=... or second positional parameter
        if (subArgs.length > 1) {
          const second = subArgs[1].trim()
          if (second.toUpperCase().startsWith('PT=')) {
            ptValue = second.substring(3).trim().replace(/['"]/g, '')
          } else {
            ptValue = second.replace(/['"]/g, '')
          }
        }

        const timerType = name as TimerType
        const timerNode: LadderTimerNode = {
          id: `timer_${globalNodeCounter++}`,
          kind: 'timer',
          timerType,
          instanceDb: instName,
          inOperand: '',
          ptOperand: ptValue,
          qOperand: `${instName}.Q`,
          etOperand: `${instName}.ET`
        }
        return [timerNode]
      }

      // Counters: CTU, CTD, CTUD
      if (name === 'CTU' || name === 'CTD' || name === 'CTUD') {
        const instName = subArgs[0]?.trim() || `C${globalNodeCounter}`
        let pvValue = '10'
        let cuOp = ''
        let cdOp = ''
        let rLdOp = ''

        for (let i = 1; i < subArgs.length; i++) {
          const arg = subArgs[i].trim()
          const upperArg = arg.toUpperCase()
          if (upperArg.startsWith('PV=')) {
            pvValue = arg.substring(3).trim().replace(/['"]/g, '')
          } else if (upperArg.startsWith('CU=')) {
            cuOp = arg.substring(3).trim().replace(/['"]/g, '')
          } else if (upperArg.startsWith('CD=')) {
            cdOp = arg.substring(3).trim().replace(/['"]/g, '')
          } else if (upperArg.startsWith('R=') || upperArg.startsWith('RESET=')) {
            rLdOp = arg.split('=')[1].trim().replace(/['"]/g, '')
          } else if (i === 1 && !arg.includes('=')) {
            pvValue = arg.replace(/['"]/g, '')
          }
        }

        const counterType = name as CounterType
        const counterNode: LadderCounterNode = {
          id: `counter_${globalNodeCounter++}`,
          kind: 'counter',
          counterType,
          instanceDb: instName,
          cuCdOperand: cuOp || (counterType === 'CTD' ? cdOp : ''),
          cuOperand: cuOp || undefined,
          cdOperand: cdOp || undefined,
          rLdOperand: rLdOp,
          pvOperand: pvValue,
          qOperand: `${instName}.${counterType === 'CTD' ? 'QD' : 'QU'}`,
          quOperand: `${instName}.QU`,
          qdOperand: `${instName}.QD`,
          cvOperand: `${instName}.CV`
        }
        return [counterNode]
      }

      // Comparators: CMP_EQ, CMP_NE, CMP_GT, CMP_LT, CMP_GE, CMP_LE
      if (
        name === 'CMP_EQ' ||
        name === 'CMP_NE' ||
        name === 'CMP_GT' ||
        name === 'CMP_LT' ||
        name === 'CMP_GE' ||
        name === 'CMP_LE'
      ) {
        const op1 = subArgs[0]?.trim() || '0'
        const op2 = subArgs[1]?.trim() || '0'
        let dataType: 'INT' | 'DINT' | 'REAL' | 'TIME' = 'INT'

        if (subArgs.length > 2) {
          const dt = subArgs[2].trim().toUpperCase()
          if (dt === 'INT' || dt === 'DINT' || dt === 'REAL' || dt === 'TIME') {
            dataType = dt
          }
        }

        const comparatorNode: LadderComparatorNode = {
          id: `cmp_${globalNodeCounter++}`,
          kind: 'comparator',
          comparatorType: name as ComparatorType,
          op1,
          op2,
          dataType
        }
        return [comparatorNode]
      }

      // Math: ADD, SUB, MUL, DIV, MOVE, NORM_X, SCALE_X
      if (
        name === 'ADD' ||
        name === 'SUB' ||
        name === 'MUL' ||
        name === 'DIV' ||
        name === 'MOVE' ||
        name === 'NORM_X' ||
        name === 'SCALE_X'
      ) {
        const mathType = name as MathBoxType
        if (name === 'NORM_X' || name === 'SCALE_X') {
          const val = subArgs[0]?.trim() || ''
          const min = subArgs[1]?.trim() || ''
          const max = subArgs[2]?.trim() || ''
          const out = subArgs[3]?.trim() || ''
          const mathNode: LadderMathNode = {
            id: `math_${globalNodeCounter++}`,
            kind: 'math',
            boxType: mathType,
            value: val,
            min,
            max,
            out
          }
          return [mathNode]
        } else {
          const in1 = subArgs[0]?.trim() || ''
          const in2 = subArgs[1]?.trim() || ''
          const out = subArgs[2]?.trim() || ''
          const mathNode: LadderMathNode = {
            id: `math_${globalNodeCounter++}`,
            kind: 'math',
            boxType: mathType,
            in1,
            in2,
            out
          }
          return [mathNode]
        }
      }

      // Fallback: treated as NO contact with function name
      const resolved = resolveOrCreateTag(name, 'contact')
      return [
        {
          id: `contact_${globalNodeCounter++}`,
          kind: 'contact',
          contactType: 'NO_CONTACT',
          operand: resolved.name,
          symbolName: resolved.name,
          address: resolved.address
        } as LadderContactNode
      ]
    }

    for (let netIndex = 0; netIndex < rawNetworkBlocks.length; netIndex++) {
      const block = rawNetworkBlocks[netIndex]
      const headerMatch = block.header.match(/^NW\s*(\d+)?\s*(?:"([^"]*)"|'([^']*)'|([^:]*))?\s*:(.*)$/i)
      const netNumber = headerMatch && headerMatch[1] ? parseInt(headerMatch[1], 10) : netIndex + 1
      const title =
        (headerMatch && (headerMatch[2] || headerMatch[3] || headerMatch[4]))?.trim() ||
        `Network ${netNumber}`

      const fullExpr = block.exprLines.join(' ').trim()
      if (!fullExpr) continue

      const nodes = parseNodeOrBranch(fullExpr)
      networks.push({
        id: `net_${netNumber}`,
        networkNumber: netNumber,
        title,
        nodes
      })
    }

    return {
      success: errors.length === 0 && networks.length > 0,
      explanation,
      tags: declaredTags,
      networks,
      errors,
      rawDsl: dslText
    }
  }

  /**
   * Generates Ladder DSL code from existing LadderNetwork[] and TagDefinition[].
   */
  public static generateLadderDslFromAst(
    networks: LadderNetwork[],
    tags: TagDefinition[]
  ): string {
    const lines: string[] = []

    // 1. Tag Declarations
    if (tags && tags.length > 0) {
      lines.push('# TAG DECLARATIONS')
      for (const tag of tags) {
        const commentPart = tag.comment ? ` "${tag.comment}"` : ''
        lines.push(`TAG ${tag.name} ${tag.address} ${tag.dataType || 'BOOL'}${commentPart}`)
      }
      lines.push('')
    }

    // 2. Network Definitions
    if (networks && networks.length > 0) {
      lines.push('# NETWORK DEFINITIONS')

      const formatNode = (node: LadderSeriesNode): string => {
        if (!node) return ''

        if (node.kind === 'contact') {
          const c = node as LadderContactNode
          const op = c.symbolName || c.operand
          if (c.contactType === 'NO_CONTACT') return `NO(${op})`
          if (c.contactType === 'NC_CONTACT') return `NC(${op})`
          if (c.contactType === 'P_TRIG') return `P_TRIG(${op})`
          if (c.contactType === 'N_TRIG') return `N_TRIG(${op})`
          return `NO(${op})`
        }

        if (node.kind === 'coil') {
          const q = node as LadderCoilNode
          const op = q.symbolName || q.operand
          if (q.coilType === 'OUTPUT_COIL') return `COIL(${op})`
          if (q.coilType === 'NEGATED_COIL') return `NEG_COIL(${op})`
          if (q.coilType === 'SET_COIL') return `SET(${op})`
          if (q.coilType === 'RESET_COIL') return `RESET(${op})`
          return `COIL(${op})`
        }

        if (node.kind === 'timer') {
          const t = node as LadderTimerNode
          return `${t.timerType || 'TON'}(${t.instanceDb || 'T1'}, PT=${t.ptOperand || 'T#10s'})`
        }

        if (node.kind === 'counter') {
          const cnt = node as LadderCounterNode
          const extraParams: string[] = [`PV=${cnt.pvOperand || '10'}`]
          if (cnt.cuOperand) extraParams.push(`CU=${cnt.cuOperand}`)
          if (cnt.cdOperand) extraParams.push(`CD=${cnt.cdOperand}`)
          if (cnt.rLdOperand) extraParams.push(`R=${cnt.rLdOperand}`)
          return `${cnt.counterType || 'CTU'}(${cnt.instanceDb || 'C1'}, ${extraParams.join(', ')})`
        }

        if (node.kind === 'comparator') {
          const cmp = node as LadderComparatorNode
          return `${cmp.comparatorType || 'CMP_EQ'}(${cmp.op1}, ${cmp.op2}, ${cmp.dataType || 'INT'})`
        }

        if (node.kind === 'math') {
          const m = node as LadderMathNode
          if (m.boxType === 'NORM_X' || m.boxType === 'SCALE_X') {
            return `${m.boxType}(${m.value || ''}, ${m.min || ''}, ${m.max || ''}, ${m.out || ''})`
          }
          return `${m.boxType}(${m.in1 || ''}, ${m.in2 || ''}, ${m.out || ''})`
        }

        if (node.kind === 'parallel') {
          const p = node as LadderParallelBranchNode
          const branchStrs = (p.branches || []).map((b) => {
            if (b.length === 1) return formatNode(b[0])
            return `SERIES( ${b.map(formatNode).join(', ')} )`
          })
          return `PARALLEL( ${branchStrs.join(', ')} )`
        }

        return ''
      }

      for (const net of networks) {
        const nodeStrs = (net.nodes || []).map(formatNode).filter(Boolean)
        const expr = nodeStrs.length === 1 ? nodeStrs[0] : `SERIES( ${nodeStrs.join(', ')} )`
        lines.push(`NW ${net.networkNumber} "${net.title}": ${expr}`)
      }
    }

    return lines.join('\n')
  }
}

