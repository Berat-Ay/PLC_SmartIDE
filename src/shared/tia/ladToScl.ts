// Transpiles Ladder Logic (LAD) blocks and their networks into standard Siemens S7 SCL blocks
// and synthesized IEC Timer / Counter / Edge Instance DBs for TIA Portal External Source export.
import { renderBlockHeader } from '../scl/sourceBlock'
import {
  BlockInterface,
  BlockVariable,
  DataBlockDefinition,
  LadBlockDefinition,
  SclBlockDefinition
} from '../types/blocks'
import type {
  ComparatorType,
  LadderCoilNode,
  LadderComparatorNode,
  LadderContactNode,
  LadderCounterNode,
  LadderMathNode,
  LadderNode,
  LadderParallelBranchNode,
  LadderTimerNode
} from '../types/ladder'

export interface LadToSclOptions {
  /** Lower-case names of existing DBs in the project so synthesized instance DBs never duplicate them. */
  existingDbNames?: Set<string>
  /** Starting block number for synthesized timer/counter/edge Instance DBs. */
  nextDbNumber?: number
}

export interface LadToSclResult {
  sclBlock: SclBlockDefinition
  synthesizedDbs: DataBlockDefinition[]
  warnings: string[]
}

const CMP_OP_MAP: Record<ComparatorType, string> = {
  CMP_EQ: '=',
  CMP_NE: '<>',
  CMP_GT: '>',
  CMP_LT: '<',
  CMP_GE: '>=',
  CMP_LE: '<='
}

const RESERVED_LITERALS = new Set(['TRUE', 'FALSE'])

function cloneInterface(iface?: BlockInterface): BlockInterface {
  const copyList = (list?: BlockVariable[]): BlockVariable[] =>
    (list || []).map((v) => ({
      ...v,
      members: v.members ? copyList(v.members) : undefined
    }))
  return {
    input: copyList(iface?.input),
    output: copyList(iface?.output),
    inOut: copyList(iface?.inOut),
    static: copyList(iface?.static),
    temp: copyList(iface?.temp),
    constant: copyList(iface?.constant)
  }
}

function collectLocalNames(iface: BlockInterface): Set<string> {
  const names = new Set<string>()
  for (const section of [
    iface.input,
    iface.output,
    iface.inOut,
    iface.static,
    iface.temp,
    iface.constant
  ]) {
    for (const v of section || []) {
      if (v.name) names.add(v.name.toLowerCase())
    }
  }
  return names
}

function needsParensForOr(expr: string): boolean {
  let depth = 0
  let inSingle = false
  let inDouble = false
  const upper = expr.toUpperCase()
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    if (inSingle || inDouble) continue
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (
      depth === 0 &&
      upper.startsWith(' OR ', i)
    ) {
      return true
    }
  }
  return false
}

function andExpr(left: string, right: string): string {
  if (left === 'TRUE') return right
  if (right === 'TRUE') return left
  const l = needsParensForOr(left) ? `(${left})` : left
  const r = needsParensForOr(right) ? `(${right})` : right
  return `${l} AND ${r}`
}

function isPureBooleanNode(node: LadderNode): boolean {
  if (node.kind === 'contact') {
    const c = node as LadderContactNode
    return c.contactType === 'NO_CONTACT' || c.contactType === 'NC_CONTACT'
  }
  if (node.kind === 'comparator') return true
  if (node.kind === 'parallel') {
    const p = node as LadderParallelBranchNode
    return p.branches.every((b) => (b || []).every(isPureBooleanNode))
  }
  return false
}

function quoteIfSimple(ident: string): string {
  const clean = ident.replace(/^"|"$/g, '').trim()
  return `"${clean}"`
}

/**
 * Transpiles a structured Ladder Logic block into an equivalent Siemens S7 SCL block
 * plus any auto-synthesized global Instance DBs required for IEC timers/counters/edges.
 */
export function transpileLadToScl(
  block: LadBlockDefinition,
  options: LadToSclOptions = {}
): LadToSclResult {
  const iface = cloneInterface(block.interface)
  const localNames = collectLocalNames(iface)
  const existingDbs = new Set<string>(
    [...(options.existingDbNames || [])].map((n) => n.toLowerCase())
  )
  let nextDbNumber = options.nextDbNumber ?? 100
  const synthesizedDbs: DataBlockDefinition[] = []
  const warnings: string[] = []

  let tempCounter = 0
  let edgeCounter = 0
  let branchCounter = 0

  const ensureTempBool = (baseName: string): string => {
    let candidate = baseName
    while (localNames.has(candidate.toLowerCase())) {
      tempCounter++
      candidate = `${baseName}_${tempCounter}`
    }
    localNames.add(candidate.toLowerCase())
    iface.temp.push({
      id: `lad_tmp_${candidate}`,
      name: candidate,
      dataType: 'Bool',
      retain: false,
      accessibleFromHMI: false
    })
    return `#${candidate}`
  }

  const ensureStaticInstance = (
    baseName: string,
    kind: 'R_TRIG' | 'F_TRIG'
  ): string => {
    let candidate = baseName
    let suffix = 0
    while (localNames.has(candidate.toLowerCase())) {
      suffix++
      candidate = `${baseName}_${suffix}`
    }
    localNames.add(candidate.toLowerCase())
    iface.static.push({
      id: `lad_stat_${candidate}`,
      name: candidate,
      dataType: kind,
      retain: false,
      accessibleFromHMI: false
    })
    return `#${candidate}`
  }

  const ensureGlobalInstanceDb = (
    rawName: string,
    kind: 'TON' | 'TOF' | 'TP' | 'TONR' | 'CTU' | 'CTD' | 'CTUD' | 'R_TRIG' | 'F_TRIG'
  ): string => {
    const clean = rawName.replace(/^["']|["']$/g, '').trim() || 'T1'
    if (localNames.has(clean.toLowerCase())) {
      return `#${clean}`
    }
    if (!existingDbs.has(clean.toLowerCase())) {
      existingDbs.add(clean.toLowerCase())
      synthesizedDbs.push({
        blockType: 'DB',
        blockNumber: nextDbNumber++,
        name: clean,
        fileName: `${clean}.db.json`,
        dbType: 'Instance',
        parentFbName: kind,
        optimizedAccess: true,
        variables: [],
        comment: `Auto-generated ${kind} instance DB for LAD block ${block.name}`
      })
    }
    return quoteIfSimple(clean)
  }

  const formatOperand = (raw: string | undefined, netNum: number): string => {
    const trimmed = (raw || '').trim()
    if (!trimmed || trimmed === '???' || trimmed.includes('???')) {
      warnings.push(
        `${block.name} (NW ${netNum}): unassigned operand '${raw || ''}' exported as FALSE.`
      )
      return 'FALSE'
    }

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
    if (RESERVED_LITERALS.has(trimmed.toUpperCase())) return trimmed.toUpperCase()
    if (/^(LTIME|TIME|LT|T|INT|DINT|SINT|USINT|UINT|UDINT|REAL|LREAL|BYTE|WORD|DWORD|S5TIME|CHAR|WCHAR|16|8|2)#/i.test(trimmed)) {
      return trimmed
    }
    if (trimmed.startsWith('%') || trimmed.startsWith('"') || trimmed.startsWith('#')) {
      return trimmed
    }

    const dotIdx = trimmed.indexOf('.')
    if (dotIdx > 0) {
      const root = trimmed.slice(0, dotIdx).trim()
      const rest = trimmed.slice(dotIdx + 1).trim()
      if (localNames.has(root.toLowerCase())) {
        return `#${root}.${rest}`
      }
      return `"${root}".${rest}`
    }

    if (localNames.has(trimmed.toLowerCase())) {
      return `#${trimmed}`
    }
    return `"${trimmed}"`
  }

  const formatTimePreset = (
    raw: string | number | undefined,
    netNum: number
  ): string => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return 'T#10s'
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return `T#${Math.max(0, Math.round(raw))}ms`
    }
    const clean = String(raw).replace(/^["']|["']$/g, '').trim()
    if (!clean) return 'T#10s'
    if (/^(LTIME|TIME|LT|T)#/i.test(clean)) return clean
    if (/^\d+$/.test(clean)) return `T#${clean}ms`
    return formatOperand(clean, netNum)
  }

  const buildPureExpr = (nodes: LadderNode[], netNum: number): string => {
    let acc = 'TRUE'
    for (const n of nodes) {
      if (n.kind === 'contact') {
        const c = n as LadderContactNode
        const op = formatOperand(c.operand, netNum)
        const term = c.contactType === 'NC_CONTACT' ? `NOT ${op}` : op
        acc = andExpr(acc, term)
      } else if (n.kind === 'comparator') {
        const cmp = n as LadderComparatorNode
        const cmpOp = CMP_OP_MAP[cmp.comparatorType] || '='
        const expr = `(${formatOperand(cmp.op1, netNum)} ${cmpOp} ${formatOperand(cmp.op2, netNum)})`
        acc = andExpr(acc, expr)
      } else if (n.kind === 'parallel') {
        const p = n as LadderParallelBranchNode
        const branchExprs = p.branches
          .map((b) => (b && b.length > 0 ? buildPureExpr(b, netNum) : 'TRUE'))
          .filter(Boolean)
        const combined =
          branchExprs.length === 0
            ? 'TRUE'
            : branchExprs.length === 1
              ? branchExprs[0]
              : `(${branchExprs.join(' OR ')})`
        acc = andExpr(acc, combined)
      }
    }
    return acc
  }

  const isSimpleTempRef = (expr: string): boolean => /^#[A-Za-z_][A-Za-z0-9_]*$/.test(expr)

  const emitSeries = (
    nodes: LadderNode[],
    incomingRlo: string,
    statements: string[],
    netNum: number,
    indent: string
  ): string => {
    let rlo = incomingRlo

    for (let idx = 0; idx < nodes.length; idx++) {
      const node = nodes[idx]

      if (node.kind === 'contact') {
        const c = node as LadderContactNode
        const op = formatOperand(c.operand, netNum)
        if (c.contactType === 'NO_CONTACT') {
          rlo = andExpr(rlo, op)
        } else if (c.contactType === 'NC_CONTACT') {
          rlo = andExpr(rlo, `NOT ${op}`)
        } else {
          // Rising or falling edge detection (P_TRIG / N_TRIG)
          edgeCounter++
          const edgeOutTemp = ensureTempBool(`_edge_${edgeCounter}`)
          if (c.edgeTag && c.edgeTag.trim()) {
            const memBit = formatOperand(c.edgeTag.trim(), netNum)
            if (c.contactType === 'P_TRIG') {
              statements.push(`${indent}${edgeOutTemp} := ${op} AND NOT ${memBit};`)
            } else {
              statements.push(`${indent}${edgeOutTemp} := (NOT ${op}) AND ${memBit};`)
            }
            statements.push(`${indent}${memBit} := ${op};`)
            rlo = andExpr(rlo, edgeOutTemp)
          } else {
            const trigKind: 'R_TRIG' | 'F_TRIG' =
              c.contactType === 'P_TRIG' ? 'R_TRIG' : 'F_TRIG'
            if (block.blockType === 'FB') {
              const instRef = ensureStaticInstance(`_lad_edge_${edgeCounter}`, trigKind)
              statements.push(`${indent}${instRef}(CLK := ${op});`)
              rlo = andExpr(rlo, `${instRef}.Q`)
            } else {
              const safeBlk = block.name.replace(/[^A-Za-z0-9_]/g, '_')
              let instDbName = `DB_${safeBlk}_Edge${edgeCounter}`
              let edgeSuffix = 2
              while (existingDbs.has(instDbName.toLowerCase())) {
                instDbName = `DB_${safeBlk}_Edge${edgeCounter}_${edgeSuffix++}`
              }
              const instRef = ensureGlobalInstanceDb(instDbName, trigKind)
              statements.push(`${indent}${instRef}(CLK := ${op});`)
              rlo = andExpr(rlo, `${instRef}.Q`)
            }
          }
        }
      } else if (node.kind === 'comparator') {
        const cmp = node as LadderComparatorNode
        const cmpOp = CMP_OP_MAP[cmp.comparatorType] || '='
        const expr = `(${formatOperand(cmp.op1, netNum)} ${cmpOp} ${formatOperand(cmp.op2, netNum)})`
        rlo = andExpr(rlo, expr)
      } else if (node.kind === 'coil') {
        const c = node as LadderCoilNode
        const hasMoreNodes = idx < nodes.length - 1
        if (hasMoreNodes && rlo !== 'TRUE' && !isSimpleTempRef(rlo)) {
          tempCounter++
          const latchedRlo = ensureTempBool(`_rlo_${tempCounter}`)
          statements.push(`${indent}${latchedRlo} := ${rlo};`)
          rlo = latchedRlo
        }

        const target = formatOperand(c.operand, netNum)
        if (c.coilType === 'OUTPUT_COIL') {
          statements.push(`${indent}${target} := ${rlo};`)
        } else if (c.coilType === 'NEGATED_COIL') {
          statements.push(`${indent}${target} := NOT (${rlo});`)
        } else if (c.coilType === 'SET_COIL') {
          if (rlo === 'TRUE') {
            statements.push(`${indent}${target} := TRUE;`)
          } else {
            statements.push(`${indent}IF ${rlo} THEN`)
            statements.push(`${indent}   ${target} := TRUE;`)
            statements.push(`${indent}END_IF;`)
          }
        } else if (c.coilType === 'RESET_COIL') {
          if (rlo === 'TRUE') {
            statements.push(`${indent}${target} := FALSE;`)
          } else {
            statements.push(`${indent}IF ${rlo} THEN`)
            statements.push(`${indent}   ${target} := FALSE;`)
            statements.push(`${indent}END_IF;`)
          }
        }
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        if (isPureBooleanNode(p)) {
          rlo = andExpr(rlo, buildPureExpr([p], netNum))
        } else {
          branchCounter++
          const brIdx = branchCounter
          const inTemp = ensureTempBool(`_rlo_in_${brIdx}`)
          const outTemp = ensureTempBool(`_br_${brIdx}`)
          statements.push(`${indent}${inTemp} := ${rlo};`)
          statements.push(`${indent}${outTemp} := FALSE;`)
          for (const branch of p.branches) {
            const branchOut = emitSeries(branch || [], inTemp, statements, netNum, indent)
            statements.push(`${indent}${outTemp} := ${outTemp} OR ${branchOut};`)
          }
          rlo = outTemp
        }
      } else if (node.kind === 'timer') {
        const t = node as LadderTimerNode
        const rawInst = (t.instanceDb || 'T1').replace(/"/g, '').trim()
        const instRef = ensureGlobalInstanceDb(rawInst, t.timerType)
        const callTarget = instRef.startsWith('#') ? instRef : `${instRef}.${t.timerType}`
        const ptExpr = formatTimePreset(t.ptOperand, netNum)

        const args = [`IN := ${rlo}`]
        if (t.timerType === 'TONR') {
          args.push(`R := ${t.rOperand && t.rOperand.trim() ? formatOperand(t.rOperand, netNum) : 'FALSE'}`)
        }
        args.push(`PT := ${ptExpr}`)
        const isPinPlaceholder = (op: string, namesRe: RegExp): boolean =>
          namesRe.test(op) && !localNames.has(op.replace(/"/g, '').toLowerCase())

        const qOp = (t.qOperand || '').trim()
        if (qOp && !isPinPlaceholder(qOp, /^(Q|ET)$/i)) {
          args.push(`Q => ${formatOperand(qOp, netNum)}`)
        }
        const etOp = (t.etOperand || '').trim()
        if (etOp && !isPinPlaceholder(etOp, /^(Q|ET)$/i) && !/^(LTIME|TIME|LT|T)#/i.test(etOp)) {
          args.push(`ET => ${formatOperand(etOp, netNum)}`)
        }
        statements.push(`${indent}${callTarget}(${args.join(', ')});`)
        rlo = `${instRef}.Q`
      } else if (node.kind === 'counter') {
        const c = node as LadderCounterNode
        const rawInst = (c.instanceDb || 'C1').replace(/"/g, '').trim()
        const instRef = ensureGlobalInstanceDb(rawInst, c.counterType)
        const callTarget = instRef.startsWith('#') ? instRef : `${instRef}.${c.counterType}`

        const isCounterPlaceholder = (op: string): boolean =>
          /^(Q|QU|QD|CV)$/i.test(op) && !localNames.has(op.replace(/"/g, '').toLowerCase())

        const pvRaw = c.pvOperand !== undefined ? String(c.pvOperand).trim() : ''
        const pvExpr = pvRaw !== '' ? formatOperand(pvRaw, netNum) : '10'
        const rExpr = c.rLdOperand && c.rLdOperand.trim() ? formatOperand(c.rLdOperand, netNum) : 'FALSE'
        const ldExpr = c.ldOperand && c.ldOperand.trim() ? formatOperand(c.ldOperand, netNum) : 'FALSE'
        const cuExpr =
          c.cuOperand && c.cuOperand.trim()
            ? andExpr(rlo, formatOperand(c.cuOperand, netNum))
            : rlo
        const cdExpr =
          c.counterType === 'CTD'
            ? c.cdOperand && c.cdOperand.trim()
              ? andExpr(rlo, formatOperand(c.cdOperand, netNum))
              : rlo
            : c.cdOperand && c.cdOperand.trim()
              ? formatOperand(c.cdOperand, netNum)
              : 'FALSE'

        const args: string[] = []
        if (c.counterType === 'CTU') {
          args.push(`CU := ${cuExpr}`, `R := ${rExpr}`, `PV := ${pvExpr}`)
          const qOp = (c.qOperand || '').trim()
          if (qOp && !isCounterPlaceholder(qOp)) {
            args.push(`Q => ${formatOperand(qOp, netNum)}`)
          }
          const cvOp = (c.cvOperand || '').trim()
          if (cvOp && !isCounterPlaceholder(cvOp)) {
            args.push(`CV => ${formatOperand(cvOp, netNum)}`)
          }
          statements.push(`${indent}${callTarget}(${args.join(', ')});`)
          rlo = `${instRef}.Q`
        } else if (c.counterType === 'CTD') {
          const ctdLdExpr = c.ldOperand && c.ldOperand.trim() ? formatOperand(c.ldOperand, netNum) : rExpr
          args.push(`CD := ${cdExpr}`, `LD := ${ctdLdExpr}`, `PV := ${pvExpr}`)
          const qOp = (c.qOperand || '').trim()
          if (qOp && !isCounterPlaceholder(qOp)) {
            args.push(`Q => ${formatOperand(qOp, netNum)}`)
          }
          const cvOp = (c.cvOperand || '').trim()
          if (cvOp && !isCounterPlaceholder(cvOp)) {
            args.push(`CV => ${formatOperand(cvOp, netNum)}`)
          }
          statements.push(`${indent}${callTarget}(${args.join(', ')});`)
          rlo = `${instRef}.QD`
        } else {
          args.push(
            `CU := ${cuExpr}`,
            `CD := ${cdExpr}`,
            `R := ${rExpr}`,
            `LD := ${ldExpr}`,
            `PV := ${pvExpr}`
          )
          const quOp = (c.quOperand || c.qOperand || '').trim()
          if (quOp && !isCounterPlaceholder(quOp)) {
            args.push(`QU => ${formatOperand(quOp, netNum)}`)
          }
          const qdOp = (c.qdOperand || '').trim()
          if (qdOp && !isCounterPlaceholder(qdOp)) {
            args.push(`QD => ${formatOperand(qdOp, netNum)}`)
          }
          const cvOp = (c.cvOperand || '').trim()
          if (cvOp && !isCounterPlaceholder(cvOp)) {
            args.push(`CV => ${formatOperand(cvOp, netNum)}`)
          }
          statements.push(`${indent}${callTarget}(${args.join(', ')});`)
          rlo = `${instRef}.QU`
        }
      } else if (node.kind === 'math') {
        const m = node as LadderMathNode
        const outRaw = (m.out || '').trim()
        if (!outRaw) {
          warnings.push(
            `${block.name} (NW ${netNum}): ${m.boxType} instruction has no OUT operand.`
          )
          continue
        }
        const outOp = formatOperand(outRaw, netNum)
        const mathStmts: string[] = []

        if (m.boxType === 'MOVE') {
          mathStmts.push(`${outOp} := ${formatOperand(m.in1 || '0', netNum)};`)
        } else if (m.boxType === 'ADD' || m.boxType === 'SUB' || m.boxType === 'MUL') {
          const sym = m.boxType === 'ADD' ? '+' : m.boxType === 'SUB' ? '-' : '*'
          mathStmts.push(
            `${outOp} := ${formatOperand(m.in1 || '0', netNum)} ${sym} ${formatOperand(m.in2 || '0', netNum)};`
          )
        } else if (m.boxType === 'DIV') {
          const in1 = formatOperand(m.in1 || '0', netNum)
          const in2 = formatOperand(m.in2 || '1', netNum)
          if (/^-?\d+(\.\d+)?$/.test(in2) && Number(in2) !== 0) {
            mathStmts.push(`${outOp} := ${in1} / ${in2};`)
          } else {
            mathStmts.push(`IF (${in2}) <> 0 THEN`)
            mathStmts.push(`   ${outOp} := ${in1} / ${in2};`)
            mathStmts.push('ELSE')
            mathStmts.push(`   ${outOp} := 0;`)
            mathStmts.push('END_IF;')
          }
        } else if (m.boxType === 'NORM_X') {
          const min = m.min !== undefined && m.min.trim() !== '' ? formatOperand(m.min, netNum) : '0'
          const maxRaw = m.max !== undefined && m.max.trim() !== '' ? m.max : m.in2
          const valRaw = m.value !== undefined && m.value.trim() !== '' ? m.value : m.in1
          const max =
            maxRaw !== undefined && maxRaw.trim() !== '' ? formatOperand(maxRaw, netNum) : '27648'
          const val =
            valRaw !== undefined && valRaw.trim() !== '' ? formatOperand(valRaw, netNum) : '0'
          mathStmts.push(`${outOp} := NORM_X(MIN := ${min}, VALUE := ${val}, MAX := ${max});`)
        } else if (m.boxType === 'SCALE_X') {
          const min =
            m.min !== undefined && m.min.trim() !== '' ? formatOperand(m.min, netNum) : '0.0'
          const maxRaw = m.max !== undefined && m.max.trim() !== '' ? m.max : m.in2
          const valRaw = m.value !== undefined && m.value.trim() !== '' ? m.value : m.in1
          const max =
            maxRaw !== undefined && maxRaw.trim() !== '' ? formatOperand(maxRaw, netNum) : '10.0'
          const val =
            valRaw !== undefined && valRaw.trim() !== '' ? formatOperand(valRaw, netNum) : '0.0'
          mathStmts.push(`${outOp} := SCALE_X(MIN := ${min}, VALUE := ${val}, MAX := ${max});`)
        }

        if (rlo === 'TRUE') {
          for (const line of mathStmts) statements.push(`${indent}${line}`)
        } else {
          statements.push(`${indent}IF ${rlo} THEN`)
          for (const line of mathStmts) statements.push(`${indent}   ${line}`)
          statements.push(`${indent}END_IF;`)
        }
      } else if (node.kind === 'emptyBox') {
        const inst = node.instruction || '???'
        warnings.push(
          `${block.name} (NW ${netNum}): empty box '${inst}' could not be transpiled to SCL.`
        )
        statements.push(`${indent}// Skipped empty box: ${inst}`)
      }
    }

    return rlo
  }

  const bodyLines: string[] = []
  for (const net of block.networks || []) {
    if (bodyLines.length > 0) bodyLines.push('')
    const titleSuffix = net.title ? `: ${net.title}` : ''
    bodyLines.push(`// Network ${net.networkNumber}${titleSuffix}`)

    if (net.isSclNetwork && net.sclCode) {
      for (const rawLine of net.sclCode.trim().split(/\r?\n/)) {
        bodyLines.push(rawLine)
      }
    } else if (net.nodes && net.nodes.length > 0) {
      emitSeries(net.nodes, 'TRUE', bodyLines, net.networkNumber, '')
    } else {
      bodyLines.push('// (Empty network)')
    }
  }

  const header = renderBlockHeader({
    kind: block.blockType,
    name: block.name,
    returnType: block.blockType === 'FC' ? 'Void' : undefined,
    optimizedAccess: block.optimizedAccess,
    iface
  })
  const keyword = { OB: 'ORGANIZATION_BLOCK', FB: 'FUNCTION_BLOCK', FC: 'FUNCTION' }[
    block.blockType
  ]
  const fullCode = [
    ...header,
    ...bodyLines.map((l) => (l ? `   ${l}` : l)),
    `END_${keyword}`,
    ''
  ].join('\n')

  const sclBlock: SclBlockDefinition = {
    blockType: block.blockType,
    blockNumber: block.blockNumber,
    name: block.name,
    fileName: `${block.name}.scl`,
    optimizedAccess: block.optimizedAccess,
    interface: iface,
    code: fullCode
  }

  return { sclBlock, synthesizedDbs, warnings }
}
