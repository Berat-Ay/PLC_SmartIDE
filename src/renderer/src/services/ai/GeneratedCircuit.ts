/** Cleans the networks and tags a model generated before they reach the project */

import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import {
  LadderNode,
  LadderSeriesNode,
  LadderNetwork,
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
  ComparatorType
} from '@shared/types/ladder'
import { AddressMove, AiCircuitSynthesisPayload } from './aiTypes'

export const RESERVED_BYTE_OCCUPANT = 'CPU system or clock memory'

export function hasEmptyNetwork(networks: AiCircuitSynthesisPayload['networks']): boolean {
  return networks.some((n) => !n.isSclNetwork && (n.nodes || []).length === 0)
}

export function normalizeAiGeneratedNetworks(rawNetworks: any[]): LadderNetwork[] {
  if (!Array.isArray(rawNetworks)) return []

  let nodeCounter = 1

  const normalizeNode = (raw: any): LadderSeriesNode => {
    if (!raw || typeof raw !== 'object') {
      return {
        id: `node_${nodeCounter++}`,
        kind: 'contact',
        contactType: 'NO_CONTACT',
        operand: 'UNDEFINED'
      } as LadderContactNode
    }

    const rawKind = (raw.kind || raw.type || '').toString().toUpperCase()

    // 1. Parallel Branch
    if (
      rawKind === 'PARALLEL' ||
      rawKind === 'PARALLEL_BRANCH' ||
      rawKind === 'OR_BRANCH' ||
      Array.isArray(raw.branches)
    ) {
      const branches = (raw.branches || []).map((branch: any) =>
        Array.isArray(branch) ? branch.map(normalizeNode) : []
      )
      return {
        id: raw.id || `parallel_${nodeCounter++}`,
        kind: 'parallel',
        branches
      } as LadderParallelBranchNode
    }

    // 2. Timer: TON, TOF, TP
    if (
      rawKind === 'TON' ||
      rawKind === 'TOF' ||
      rawKind === 'TP' ||
      rawKind === 'TIMER' ||
      raw.kind === 'timer'
    ) {
      const timerType: TimerType =
        raw.timerType?.toUpperCase() === 'TOF' || rawKind === 'TOF'
          ? 'TOF'
          : raw.timerType?.toUpperCase() === 'TP' || rawKind === 'TP'
            ? 'TP'
            : 'TON'

      const instName = (
        raw.instanceDb ||
        raw.instanceName ||
        raw.timerName ||
        raw.name ||
        `T${nodeCounter}`
      ).toString().trim().replace(/^"|"$/g, '')

      let ptVal = raw.ptOperand ?? raw.pt ?? raw.presetTime ?? raw.preset ?? 'T#10s'
      if (typeof ptVal === 'number') {
        ptVal = `T#${ptVal}ms`
      } else {
        ptVal = String(ptVal).trim()
        if (/^\d+$/.test(ptVal)) {
          ptVal = `T#${ptVal}ms`
        }
      }

      return {
        id: raw.id || `timer_${nodeCounter++}`,
        kind: 'timer',
        timerType,
        instanceDb: instName,
        inOperand: raw.inOperand || '',
        ptOperand: ptVal,
        qOperand: raw.qOperand || `${instName}.Q`,
        etOperand: raw.etOperand || `${instName}.ET`,
        comment: raw.comment
      } as LadderTimerNode
    }

    // 3. Counter: CTU, CTD, CTUD
    if (
      rawKind === 'CTU' ||
      rawKind === 'CTD' ||
      rawKind === 'CTUD' ||
      rawKind === 'COUNTER' ||
      raw.kind === 'counter'
    ) {
      let counterType: CounterType = 'CTUD'
      if (raw.counterType) {
        const ctUpper = raw.counterType.toUpperCase()
        if (ctUpper === 'CTU' || ctUpper === 'CTD' || ctUpper === 'CTUD') {
          counterType = ctUpper as CounterType
        }
      } else if (rawKind === 'CTU') {
        counterType = 'CTU'
      } else if (rawKind === 'CTD') {
        counterType = 'CTD'
      }

      const instName = (
        raw.instanceDb ||
        raw.instanceName ||
        raw.counterName ||
        raw.name ||
        `C${nodeCounter}`
      ).toString().trim().replace(/^"|"$/g, '')

      const pvVal = String(raw.pvOperand ?? raw.pv ?? raw.preset ?? raw.presetValue ?? 10).trim()
      const cu = raw.cuOperand || raw.cu || raw.countUp || undefined
      const cd = raw.cdOperand || raw.cd || raw.countDown || undefined
      const rLd = raw.rLdOperand || raw.r || raw.reset || raw.load || ''

      return {
        id: raw.id || `counter_${nodeCounter++}`,
        kind: 'counter',
        counterType,
        instanceDb: instName,
        cuCdOperand: cu || cd || raw.cuCdOperand || '',
        cuOperand: cu,
        cdOperand: cd,
        rLdOperand: rLd,
        pvOperand: pvVal,
        qOperand: raw.qOperand || `${instName}.${counterType === 'CTD' ? 'QD' : 'QU'}`,
        quOperand: raw.quOperand || `${instName}.QU`,
        qdOperand: raw.qdOperand || `${instName}.QD`,
        cvOperand: raw.cvOperand || `${instName}.CV`,
        comment: raw.comment
      } as LadderCounterNode
    }

    // 4. Comparator: CMP, COMPARATOR, CMP_LT, LESS_THAN, etc.
    const isCmp =
      rawKind === 'CMP' ||
      rawKind === 'COMPARATOR' ||
      rawKind.startsWith('CMP_') ||
      rawKind === 'LESS_THAN' ||
      rawKind === 'GREATER_THAN' ||
      rawKind === 'EQUAL' ||
      rawKind === 'GREATER_EQUAL' ||
      rawKind === 'LESS_EQUAL' ||
      raw.kind === 'comparator'

    if (isCmp) {
      const typeStr = (raw.comparatorType || raw.operator || rawKind).toString().toUpperCase()
      let comparatorType: ComparatorType = 'CMP_EQ'
      if (typeStr === 'CMP_LT' || typeStr === 'LESS_THAN' || typeStr === '<' || typeStr === 'LT') {
        comparatorType = 'CMP_LT'
      } else if (typeStr === 'CMP_LE' || typeStr === 'LESS_EQUAL' || typeStr === '<=' || typeStr === 'LE') {
        comparatorType = 'CMP_LE'
      } else if (typeStr === 'CMP_GT' || typeStr === 'GREATER_THAN' || typeStr === '>' || typeStr === 'GT') {
        comparatorType = 'CMP_GT'
      } else if (typeStr === 'CMP_GE' || typeStr === 'GREATER_EQUAL' || typeStr === '>=' || typeStr === 'GE') {
        comparatorType = 'CMP_GE'
      } else if (typeStr === 'CMP_NE' || typeStr === 'NOT_EQUAL' || typeStr === '<>' || typeStr === '!=' || typeStr === 'NE') {
        comparatorType = 'CMP_NE'
      } else {
        comparatorType = 'CMP_EQ'
      }

      const op1 = String(raw.op1 ?? raw.in1 ?? raw.left ?? raw.input1 ?? '0').trim()
      const op2 = String(raw.op2 ?? raw.in2 ?? raw.right ?? raw.input2 ?? '0').trim()
      let dataType: 'INT' | 'DINT' | 'REAL' | 'TIME' = 'INT'
      if (raw.dataType && ['INT', 'DINT', 'REAL', 'TIME'].includes(raw.dataType.toUpperCase())) {
        dataType = raw.dataType.toUpperCase()
      }

      return {
        id: raw.id || `cmp_${nodeCounter++}`,
        kind: 'comparator',
        comparatorType,
        op1,
        op2,
        dataType,
        comment: raw.comment
      } as LadderComparatorNode
    }

    // 5. Coils
    const isCoil =
      rawKind === 'COIL' ||
      rawKind === 'OUTPUT_COIL' ||
      rawKind === 'NEGATED_COIL' ||
      rawKind === 'NEG_COIL' ||
      rawKind === 'SET_COIL' ||
      rawKind === 'SET' ||
      rawKind === 'RESET_COIL' ||
      rawKind === 'RESET' ||
      raw.kind === 'coil'

    if (isCoil) {
      const typeStr = (raw.coilType || rawKind).toString().toUpperCase()
      let coilType: CoilType = 'OUTPUT_COIL'
      if (typeStr === 'NEGATED_COIL' || typeStr === 'NEG_COIL') {
        coilType = 'NEGATED_COIL'
      } else if (typeStr === 'SET_COIL' || typeStr === 'SET') {
        coilType = 'SET_COIL'
      } else if (typeStr === 'RESET_COIL' || typeStr === 'RESET') {
        coilType = 'RESET_COIL'
      }

      const operand = String(raw.operand || raw.address || raw.symbolName || 'UNDEFINED').trim()
      return {
        id: raw.id || `coil_${nodeCounter++}`,
        kind: 'coil',
        coilType,
        operand,
        address: raw.address,
        symbolName: raw.symbolName || operand,
        comment: raw.comment
      } as LadderCoilNode
    }

    // 6. Math
    if (raw.kind === 'math' || ['ADD', 'SUB', 'MUL', 'DIV', 'MOVE', 'NORM_X', 'SCALE_X'].includes(rawKind)) {
      return {
        id: raw.id || `math_${nodeCounter++}`,
        kind: 'math',
        boxType: (raw.boxType || rawKind) as any,
        in1: raw.in1,
        in2: raw.in2,
        out: raw.out,
        min: raw.min,
        max: raw.max,
        value: raw.value,
        dataType: raw.dataType,
        comment: raw.comment
      } as LadderMathNode
    }

    // 7. Contacts (Default)
    const typeStr = (raw.contactType || rawKind).toString().toUpperCase()
    let contactType: ContactType = 'NO_CONTACT'
    if (typeStr === 'NC_CONTACT' || typeStr === 'NC') {
      contactType = 'NC_CONTACT'
    } else if (typeStr === 'P_TRIG') {
      contactType = 'P_TRIG'
    } else if (typeStr === 'N_TRIG') {
      contactType = 'N_TRIG'
    }

    const operand = String(raw.operand || raw.address || raw.symbolName || 'UNDEFINED').trim()
    return {
      id: raw.id || `contact_${nodeCounter++}`,
      kind: 'contact',
      contactType,
      operand,
      address: raw.address,
      symbolName: raw.symbolName || operand,
      edgeTag: raw.edgeTag,
      comment: raw.comment
    } as LadderContactNode
  }

  return rawNetworks.map((net, idx) => {
    const rawNodes = Array.isArray(net.nodes) ? net.nodes : Array.isArray(net.elements) ? net.elements : []
    const normalizedNodes = rawNodes.map(normalizeNode)
    return {
      id: net.id || `nw_${idx + 1}`,
      networkNumber: net.networkNumber || idx + 1,
      title: net.title || `Network ${idx + 1}`,
      comment: net.comment || '',
      isSclNetwork: !!net.isSclNetwork,
      sclCode: net.sclCode,
      nodes: normalizedNodes
    }
  })
}

/**
 * Removes a plain %M coil that only copies a timer's or counter's Q, and reads the instance bit instead.
 * Other coil types stay: a SET coil latches and a negated coil inverts, so they are not the same as Q.
 */
export function optimizeAndCleanGeneratedAst(payload: AiCircuitSynthesisPayload): AiCircuitSynthesisPayload {
  if (!payload.networks || payload.networks.length === 0) return payload

  const strippedCoilMap = new Map<string, string>() // dummyOperandLower -> replacement e.g. "T1.Q"

  // 1. Traverse networks and inspect for trailing dummy coils after timers/counters
  const cleanedNetworks = payload.networks.map((net) => {
    const originalNodes = net.nodes || []
    const newNodes: LadderNode[] = []

    for (let i = 0; i < originalNodes.length; i++) {
      const current = originalNodes[i]
      const next = originalNodes[i + 1]

      if (
        (current.kind === 'timer' || current.kind === 'counter') &&
        next?.kind === 'coil' &&
        (next as LadderCoilNode).coilType === 'OUTPUT_COIL'
      ) {
        const t = current as LadderTimerNode | LadderCounterNode
        const c = next as LadderCoilNode
        const declared = (payload.tagsToUpsert || []).find((tag) => tag.name.toLowerCase() === c.operand.toLowerCase())
        if (/^%?[IQ]/i.test(c.address || declared?.address || '')) {
          newNodes.push(current)
          continue
        }
        const instName = t.instanceDb || (current.kind === 'timer' ? 'T1' : 'C1')
        const countsDown = current.kind === 'counter' && (current as LadderCounterNode).counterType === 'CTD'
        const nativeBit = current.kind === 'timer' ? `${instName}.Q` : `${instName}.${countsDown ? 'QD' : 'QU'}`

        strippedCoilMap.set(c.operand.toLowerCase(), nativeBit)
        if (c.address) strippedCoilMap.set(c.address.toLowerCase(), nativeBit)
        if (c.symbolName) strippedCoilMap.set(c.symbolName.toLowerCase(), nativeBit)

        const updatedTimerOrCounter = {
          ...t,
          qOperand: nativeBit
        }
        newNodes.push(updatedTimerOrCounter)
        i++ // Strip the trailing dummy coil!
        continue
      }

      newNodes.push(current)
    }

    return {
      ...net,
      nodes: newNodes
    }
  })

  // 2. Rewrite any contact that referenced the stripped dummy coil
  const rewireContacts = (nodes: LadderNode[]): LadderNode[] => {
    return nodes.map((n) => {
      if (n.kind === 'contact') {
        const ct = n as LadderContactNode
        const match =
          strippedCoilMap.get(ct.operand.toLowerCase()) ||
          (ct.address ? strippedCoilMap.get(ct.address.toLowerCase()) : undefined) ||
          (ct.symbolName ? strippedCoilMap.get(ct.symbolName.toLowerCase()) : undefined)

        if (match) {
          return {
            ...ct,
            operand: match,
            address: match,
            symbolName: match
          }
        }
      } else if (n.kind === 'parallel') {
        const p = n as LadderParallelBranchNode
        return {
          ...p,
          branches: p.branches.map(rewireContacts)
        }
      }
      return n
    })
  }

  const rewiredNetworks = cleanedNetworks.map((net) => ({
    ...net,
    nodes: rewireContacts(net.nodes)
  }))

  // 3. Drop the tags of the coils removed above
  const cleanedTags = (payload.tagsToUpsert || []).filter(
    (tag) => !strippedCoilMap.has(tag.name.toLowerCase()) && !strippedCoilMap.has(tag.address.toLowerCase())
  )

  return {
    ...payload,
    networks: rewiredNetworks,
    tagsToUpsert: cleanedTags
  }
}

/**
 * Deterministic Unique Address Allocator & Network Rewirer
 * Ensures that tags generated or modified by AI never have duplicate addresses (e.g. Start_Btn %I0.1 & Stop_Btn %I0.1).
 * Automatically re-maps colliding tags to sequential safe addresses (%I0.0, %I0.1, %Q0.0, %Q0.1, etc.)
 * and updates corresponding node operands and addresses in Ladder Networks.
 */
export function sanitizeAndAllocateUniqueAddresses(
  tagsToUpsert: Array<{ name: string; dataType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME'; address: string; comment?: string }>,
  networks: LadderNetwork[] = [],
  existingTags: Array<{ id: string; name: string; address: string; dataType: string }> = [],
  reservedMerkerBytes: number[] = []
): {
  tags: Array<{ name: string; dataType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME'; address: string; comment?: string }>
  networks: LadderNetwork[]
  moved: AddressMove[]
} {
  const moved: AddressMove[] = []
  const usedAddresses = new Map<string, string>() // normalizedAddr -> tagName
  const addressRewrites = new Map<string, string>() // oldNormalizedAddr -> newNormalizedAddr
  const nameToAddressMap = new Map<string, string>() // tagName.toLowerCase() -> newNormalizedAddr

  for (const byte of reservedMerkerBytes) {
    for (let bit = 0; bit < 8; bit++) usedAddresses.set(`%M${byte}.${bit}`, RESERVED_BYTE_OCCUPANT)
  }

  // Register existing tags that are not being replaced by name
  const newTagNames = new Set(tagsToUpsert.map((t) => t.name.trim().toLowerCase()))
  for (const ex of existingTags) {
    if (!newTagNames.has(ex.name.trim().toLowerCase()) && ex.address) {
      const norm = normalizeS7Address(ex.address)
      if (norm.isValid) {
        usedAddresses.set(norm.formatted.toUpperCase(), ex.name)
      }
    }
  }

  const allocateNextFree = (area: 'I' | 'Q' | 'M', isBit: boolean): string => {
    for (let byte = 0; byte < 1000; byte++) {
      if (isBit) {
        for (let bit = 0; bit < 8; bit++) {
          const candidate = `%${area}${byte}.${bit}`
          if (!usedAddresses.has(candidate.toUpperCase())) {
            return candidate
          }
        }
      } else {
        const candidate = `%${area}W${byte * 2}`
        if (!usedAddresses.has(candidate.toUpperCase())) {
          return candidate
        }
      }
    }
    return `%${area}0.0`
  }

  const sanitizedTags = tagsToUpsert.map((tag) => {
    const norm = normalizeS7Address(tag.address)
    let formattedAddr = norm.isValid ? norm.formatted.toUpperCase() : tag.address.trim().toUpperCase()
    const area = (formattedAddr.startsWith('%I') ? 'I' : formattedAddr.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
    const isBit = tag.dataType === 'BOOL' || !formattedAddr.includes('W')

    // Check if this address is already taken by a different tag
    const existingOccupant = usedAddresses.get(formattedAddr)
    if (existingOccupant && existingOccupant.toLowerCase() !== tag.name.toLowerCase()) {
      // Collision detected! Allocate next free safe address
      const safeAddr = allocateNextFree(area, isBit)
      moved.push({ name: tag.name, from: formattedAddr, to: safeAddr, takenBy: existingOccupant })
      addressRewrites.set(formattedAddr, safeAddr)
      formattedAddr = safeAddr
    }

    usedAddresses.set(formattedAddr, tag.name)
    nameToAddressMap.set(tag.name.toLowerCase(), formattedAddr)

    return {
      ...tag,
      address: formattedAddr
    }
  })

  // Rewire nodes in networks
  const rewireNode = (node: LadderNode): LadderNode => {
    if (node.kind === 'contact') {
      const c = node as LadderContactNode
      const newAddr =
        (c.symbolName && nameToAddressMap.get(c.symbolName.toLowerCase())) ||
        (c.operand && nameToAddressMap.get(c.operand.toLowerCase())) ||
        (c.address && addressRewrites.get(c.address.toUpperCase()))
      if (newAddr) {
        return { ...c, address: newAddr }
      }
    } else if (node.kind === 'coil') {
      const c = node as LadderCoilNode
      const newAddr =
        (c.symbolName && nameToAddressMap.get(c.symbolName.toLowerCase())) ||
        (c.operand && nameToAddressMap.get(c.operand.toLowerCase())) ||
        (c.address && addressRewrites.get(c.address.toUpperCase()))
      if (newAddr) {
        return { ...c, address: newAddr }
      }
    } else if (node.kind === 'parallel') {
      const p = node as LadderParallelBranchNode
      return {
        ...p,
        branches: p.branches.map((branch) => branch.map(rewireNode))
      }
    }
    return node
  }

  const rewiredNetworks = networks.map((net) => ({
    ...net,
    nodes: (net.nodes || []).map(rewireNode)
  }))

  return {
    tags: sanitizedTags,
    networks: rewiredNetworks,
    moved
  }
}
