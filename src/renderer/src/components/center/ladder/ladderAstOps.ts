import {
  CoilType,
  ComparatorType,
  ContactType,
  CounterType,
  LadderCoilNode,
  LadderContactNode,
  LadderCounterNode,
  LadderMathNode,
  LadderNode,
  LadderParallelBranchNode,
  LadderTimerNode,
  MathBoxType,
  TimerType
} from '@shared/types/ladder'
import { LadNetwork } from '@shared/types/blocks'
import type { DropZoneTarget } from '../../../services/layout/LadderGridLayoutEngine'
import { generateId } from '../../../utils/id'

export type { DropZoneTarget }

export interface BranchTarget {
  branchId: string
  branchIndex: number
}

export function createInstructionNode(
  kind: string,
  subType?: string,
  title?: string
): LadderNode {
  if (kind === 'contact') {
    const contactType: ContactType = (subType as ContactType) || 'NO_CONTACT'
    return {
      id: generateId('node_contact'),
      kind: 'contact',
      contactType,
      operand: '???'
    }
  }
  if (kind === 'coil') {
    const coilType: CoilType = (subType as CoilType) || 'OUTPUT_COIL'
    return {
      id: generateId('node_coil'),
      kind: 'coil',
      coilType,
      operand: '???'
    }
  }
  if (kind === 'timer') {
    const timerType: TimerType = (subType as TimerType) || 'TON'
    const id = generateId('node_timer')
    const shortNum = id.split('_').pop() || '1'
    return {
      id,
      kind: 'timer',
      timerType,
      instanceDb: `DB_${timerType}_${shortNum}`,
      inOperand: 'IN',
      ptOperand: 'T#5s',
      ...(timerType === 'TONR' ? { rOperand: '???' } : {}),
      qOperand: 'Q',
      etOperand: 'ET'
    }
  }
  if (kind === 'counter') {
    const counterType: CounterType = (subType as CounterType) || 'CTU'
    const id = generateId('node_counter')
    const shortNum = id.split('_').pop() || '1'
    return {
      id,
      kind: 'counter',
      counterType,
      instanceDb: `DB_${counterType}_${shortNum}`,
      cuCdOperand: 'CU',
      rLdOperand: counterType === 'CTUD' ? '???' : 'R',
      ...(counterType === 'CTUD' ? { cdOperand: '???', ldOperand: '???' } : counterType === 'CTD' ? { ldOperand: '???' } : {}),
      pvOperand: '10',
      qOperand: 'Q',
      cvOperand: 'CV'
    }
  }
  if (kind === 'comparator') {
    const comparatorType: ComparatorType = (subType as ComparatorType) || 'CMP_EQ'
    return {
      id: generateId('node_cmp'),
      kind: 'comparator',
      comparatorType,
      op1: 'TankLevel_Raw',
      op2: '20000',
      dataType: 'INT'
    }
  }
  if (kind === 'math') {
    const boxType: MathBoxType = (subType as MathBoxType) || 'ADD'
    return {
      id: generateId('node_math'),
      kind: 'math',
      boxType,
      in1: '13824',
      in2: '27648',
      out: 'Scaled_Result'
    }
  }
  if (kind === 'parallel') {
    return {
      id: generateId('node_parallel'),
      kind: 'parallel',
      branches: [[], []]
    }
  }
  return {
    id: generateId('node_box'),
    kind: 'emptyBox',
    instruction: title || subType || '???'
  }
}

export function getInstructionBoxDimensions(n: LadderNode): { width: number; height: number } {
  if (n.kind === 'timer' && (n as LadderTimerNode).timerType === 'TONR') {
    return { width: 165, height: 90 }
  }
  if (n.kind === 'counter' && (n as LadderCounterNode).counterType === 'CTUD') {
    return { width: 165, height: 90 }
  }
  if (n.kind === 'comparator') {
    return { width: 176, height: 76 }
  }
  if (n.kind === 'math') {
    const boxType = (n as LadderMathNode).boxType
    if (boxType === 'NORM_X' || boxType === 'SCALE_X') {
      return { width: 190, height: 96 }
    }
    if (boxType === 'ADD' || boxType === 'SUB' || boxType === 'MUL' || boxType === 'DIV') {
      return { width: 186, height: 84 }
    }
    return { width: 176, height: 74 }
  }
  return { width: 150, height: 74 }
}

export function getNodeRenderWidth(n: LadderNode): number {
  if (n.kind === 'contact' || n.kind === 'coil') return 175
  if (n.kind === 'emptyBox') return 130
  if (n.kind === 'timer' || n.kind === 'counter' || n.kind === 'comparator' || n.kind === 'math') {
    return getInstructionBoxDimensions(n).width + 30
  }
  if (n.kind === 'parallel') {
    const p = n as LadderParallelBranchNode
    let maxBWidth = 160
    for (const b of p.branches) {
      const bW = (b || []).reduce((sum, child) => sum + getNodeRenderWidth(child), 0)
      maxBWidth = Math.max(maxBWidth, bW + 40)
    }
    return maxBWidth
  }
  return 175
}

export function findNodeById(nodes: readonly LadderNode[] | undefined, nodeId: string): LadderNode | null {
  if (!nodes) return null
  for (const n of nodes) {
    if (n.id === nodeId) return n
    if (n.kind === 'parallel') {
      for (const leg of (n as LadderParallelBranchNode).branches) {
        const hit = findNodeById(leg, nodeId)
        if (hit) return hit
      }
    }
  }
  return null
}

export function findNodeInNetworks(networks: readonly LadNetwork[], nodeId: string): LadderNode | null {
  for (const net of networks) {
    const hit = findNodeById(net.nodes, nodeId)
    if (hit) return hit
  }
  return null
}

export function getTargetLocation(
  networks: readonly LadNetwork[],
  selectedNodeId: string | null,
  selectedNetworkNumber: number
): { targetNetIdx: number; afterNodeIdx: number } {
  if (selectedNodeId) {
    for (let netIdx = 0; netIdx < networks.length; netIdx++) {
      const net = networks[netIdx]
      if (!net.nodes) continue
      const nodeIdx = net.nodes.findIndex((n) => n.id === selectedNodeId)
      if (nodeIdx !== -1) {
        return { targetNetIdx: netIdx, afterNodeIdx: nodeIdx }
      }
      if (findNodeById(net.nodes, selectedNodeId)) {
        return { targetNetIdx: netIdx, afterNodeIdx: -1 }
      }
    }
  }
  const curIdx = networks.findIndex((n) => n.networkNumber === selectedNetworkNumber)
  if (curIdx !== -1) {
    return { targetNetIdx: curIdx, afterNodeIdx: -1 }
  }
  return { targetNetIdx: Math.max(0, networks.length - 1), afterNodeIdx: -1 }
}

function insertIntoSeries(nodes: readonly LadderNode[], newNode: LadderNode, insertIndex?: number): LadderNode[] {
  const copy = [...nodes]
  if (insertIndex !== undefined) {
    if (newNode.kind === 'coil' && insertIndex >= copy.length) {
      copy.push(newNode)
      return copy
    }
    const coilIdx = copy.findIndex((n) => n.kind === 'coil')
    if (newNode.kind !== 'coil' && coilIdx !== -1 && insertIndex >= coilIdx) {
      copy.splice(coilIdx, 0, newNode)
    } else {
      copy.splice(Math.max(0, Math.min(insertIndex, copy.length)), 0, newNode)
    }
    return copy
  }
  if (newNode.kind === 'coil') {
    copy.push(newNode)
    return copy
  }
  const coilIdx = copy.findIndex((n) => n.kind === 'coil')
  if (coilIdx !== -1) {
    copy.splice(coilIdx, 0, newNode)
  } else {
    copy.push(newNode)
  }
  return copy
}

function appendToBranchRecursive(
  nodes: readonly LadderNode[],
  branchId: string,
  branchIndex: number,
  newNode: LadderNode,
  insertIndex?: number
): { nodes: LadderNode[]; inserted: boolean } {
  let inserted = false
  const nextNodes = nodes.map((n) => {
    if (inserted || n.kind !== 'parallel') return n
    const b = n as LadderParallelBranchNode
    if (b.id === branchId) {
      const branches = b.branches.map((leg) => [...leg])
      while (branches.length <= branchIndex) branches.push([])
      const leg = branches[branchIndex]
      if (insertIndex === undefined) {
        leg.push(newNode)
      } else {
        leg.splice(Math.max(0, Math.min(insertIndex, leg.length)), 0, newNode)
      }
      branches[branchIndex] = leg
      inserted = true
      return { ...b, branches }
    }
    const updatedBranches = b.branches.map((leg) => {
      if (inserted) return leg
      const res = appendToBranchRecursive(leg || [], branchId, branchIndex, newNode, insertIndex)
      if (res.inserted) {
        inserted = true
        return res.nodes
      }
      return leg
    })
    return inserted ? { ...b, branches: updatedBranches } : b
  })
  return { nodes: nextNodes, inserted }
}

function insertAfterNodeRecursive(
  nodes: readonly LadderNode[],
  selectedNodeId: string,
  newNode: LadderNode
): { nodes: LadderNode[]; inserted: boolean } {
  const directIdx = nodes.findIndex((n) => n.id === selectedNodeId)
  if (directIdx !== -1) {
    const sel = nodes[directIdx]
    const copy = [...nodes]
    const pos = sel.kind === 'coil' && newNode.kind !== 'coil' ? directIdx : directIdx + 1
    copy.splice(pos, 0, newNode)
    return { nodes: copy, inserted: true }
  }
  let inserted = false
  const nextNodes = nodes.map((n) => {
    if (inserted || n.kind !== 'parallel') return n
    const b = n as LadderParallelBranchNode
    const updatedBranches = b.branches.map((leg) => {
      if (inserted) return leg
      const res = insertAfterNodeRecursive(leg || [], selectedNodeId, newNode)
      if (res.inserted) {
        inserted = true
        return res.nodes
      }
      return leg
    })
    return inserted ? { ...b, branches: updatedBranches } : b
  })
  return { nodes: nextNodes, inserted }
}

export function insertNodeInNetwork(
  networks: readonly LadNetwork[],
  newNode: LadderNode,
  options: {
    selectedNodeId: string | null
    selectedNetworkNumber: number
    selectedBranchTarget: BranchTarget | null
  }
): { networks: LadNetwork[]; selectedNetworkNumber?: number; clearBranchTarget: boolean } {
  const { selectedNodeId, selectedNetworkNumber, selectedBranchTarget } = options

  if (selectedBranchTarget) {
    let done = false
    const nextNetworks = networks.map((net) => {
      if (done || !net.nodes) return net
      const res = appendToBranchRecursive(
        net.nodes,
        selectedBranchTarget.branchId,
        selectedBranchTarget.branchIndex,
        newNode
      )
      if (res.inserted) {
        done = true
        return { ...net, nodes: res.nodes }
      }
      return net
    })
    if (done) {
      return { networks: nextNetworks, clearBranchTarget: true }
    }
  }

  if (selectedNodeId) {
    let done = false
    let netNum: number | undefined
    const nextNetworks = networks.map((net) => {
      if (done || !net.nodes) return net
      const res = insertAfterNodeRecursive(net.nodes, selectedNodeId, newNode)
      if (res.inserted) {
        done = true
        netNum = net.networkNumber
        return { ...net, nodes: res.nodes }
      }
      return net
    })
    if (done) {
      return { networks: nextNetworks, selectedNetworkNumber: netNum, clearBranchTarget: false }
    }
  }

  const { targetNetIdx } = getTargetLocation(networks, null, selectedNetworkNumber)
  if (targetNetIdx < 0 || targetNetIdx >= networks.length) {
    return { networks: [...networks], clearBranchTarget: false }
  }
  const targetNet = networks[targetNetIdx]
  const nextNodes = insertIntoSeries(targetNet.nodes || [], newNode)
  const nextNetworks = networks.map((net, idx) =>
    idx === targetNetIdx ? { ...net, nodes: nextNodes } : net
  )
  return {
    networks: nextNetworks,
    selectedNetworkNumber: targetNet.networkNumber,
    clearBranchTarget: false
  }
}

export function insertNodeAtZone(
  networks: readonly LadNetwork[],
  newNode: LadderNode,
  target: DropZoneTarget
): { networks: LadNetwork[]; selectedNetworkNumber?: number } {
  if (target.netIdx < 0 || target.netIdx >= networks.length) {
    return { networks: [...networks] }
  }
  const targetNet = networks[target.netIdx]
  let updatedNodes: LadderNode[]
  if (target.branchId) {
    const res = appendToBranchRecursive(
      targetNet.nodes || [],
      target.branchId,
      target.branchIndex || 0,
      newNode,
      target.insertIndex
    )
    updatedNodes = res.nodes
  } else {
    updatedNodes = insertIntoSeries(targetNet.nodes || [], newNode, target.insertIndex)
  }
  return {
    networks: networks.map((net, idx) => (idx === target.netIdx ? { ...net, nodes: updatedNodes } : net)),
    selectedNetworkNumber: targetNet.networkNumber
  }
}

function removeNodeWithMeta(
  nodes: readonly LadderNode[],
  nodeId: string,
  branchId?: string,
  branchIndex?: number
): { nodes: LadderNode[]; removed: LadderNode | null; removedIdx: number; fromBranchId?: string; fromBranchIndex?: number } {
  const directIdx = nodes.findIndex((n) => n.id === nodeId)
  if (directIdx !== -1) {
    const removed = nodes[directIdx]
    const next = [...nodes.slice(0, directIdx), ...nodes.slice(directIdx + 1)]
    return { nodes: next, removed, removedIdx: directIdx, fromBranchId: branchId, fromBranchIndex: branchIndex }
  }
  let found: { removed: LadderNode | null; removedIdx: number; fromBranchId?: string; fromBranchIndex?: number } = {
    removed: null,
    removedIdx: -1
  }
  const nextNodes = nodes.map((n) => {
    if (found.removed || n.kind !== 'parallel') return n
    const b = n as LadderParallelBranchNode
    const branches = b.branches.map((leg, bIdx) => {
      if (found.removed) return leg
      const res = removeNodeWithMeta(leg || [], nodeId, b.id, bIdx)
      if (res.removed) {
        found = {
          removed: res.removed,
          removedIdx: res.removedIdx,
          fromBranchId: res.fromBranchId,
          fromBranchIndex: res.fromBranchIndex
        }
        return res.nodes
      }
      return leg
    })
    return found.removed ? { ...b, branches } : b
  })
  return { nodes: nextNodes, ...found }
}

export function moveNodeToZone(
  networks: readonly LadNetwork[],
  nodeId: string,
  target: DropZoneTarget
): { networks: LadNetwork[]; movedNode: LadderNode | null; selectedNetworkNumber?: number } {
  let removedNode: LadderNode | null = null
  let fromNetIdx = -1
  let removedIdx = -1
  let fromBranchId: string | undefined
  let fromBranchIndex: number | undefined

  const strippedNetworks = networks.map((net, idx) => {
    if (removedNode || !net.nodes) return net
    const res = removeNodeWithMeta(net.nodes, nodeId)
    if (res.removed) {
      removedNode = res.removed
      fromNetIdx = idx
      removedIdx = res.removedIdx
      fromBranchId = res.fromBranchId
      fromBranchIndex = res.fromBranchIndex
      return { ...net, nodes: res.nodes }
    }
    return net
  })

  if (!removedNode || target.netIdx < 0 || target.netIdx >= strippedNetworks.length) {
    return { networks: [...networks], movedNode: null }
  }

  let adjustedIndex = target.insertIndex
  const sameContainer =
    fromNetIdx === target.netIdx &&
    fromBranchId === target.branchId &&
    (target.branchId ? fromBranchIndex === (target.branchIndex || 0) : true)
  if (sameContainer && removedIdx !== -1 && removedIdx < adjustedIndex) {
    adjustedIndex = Math.max(0, adjustedIndex - 1)
  }

  const inserted = insertNodeAtZone(strippedNetworks, removedNode, {
    ...target,
    insertIndex: adjustedIndex
  })
  return {
    networks: inserted.networks,
    movedNode: removedNode,
    selectedNetworkNumber: inserted.selectedNetworkNumber
  }
}

export function deleteNodeById(networks: readonly LadNetwork[], nodeId: string): LadNetwork[] {
  const removeRecursive = (nodes: readonly LadderNode[]): LadderNode[] =>
    nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => {
        if (n.kind !== 'parallel') return n
        const b = n as LadderParallelBranchNode
        return { ...b, branches: b.branches.map((leg) => removeRecursive(leg || [])) }
      })

  return networks.map((net) => ({
    ...net,
    nodes: net.nodes ? removeRecursive(net.nodes) : []
  }))
}

export function addParallelBranchTier(
  networks: readonly LadNetwork[],
  branchId: string
): { networks: LadNetwork[]; newTierIndex: number } {
  let newTierIndex = 2
  const addRecursive = (nodes: readonly LadderNode[]): LadderNode[] =>
    nodes.map((n) => {
      if (n.kind === 'parallel' && n.id === branchId) {
        const b = n as LadderParallelBranchNode
        const branches = [...b.branches.map((leg) => [...leg]), []]
        newTierIndex = branches.length - 1
        return { ...b, branches }
      }
      if (n.kind === 'parallel') {
        const b = n as LadderParallelBranchNode
        return { ...b, branches: b.branches.map((leg) => addRecursive(leg || [])) }
      }
      return n
    })

  return {
    networks: networks.map((net) => ({
      ...net,
      nodes: net.nodes ? addRecursive(net.nodes) : []
    })),
    newTierIndex
  }
}

export function deleteParallelBranchLeg(
  networks: readonly LadNetwork[],
  branchId: string,
  branchIndex: number
): LadNetwork[] {
  const healRecursive = (nodes: readonly LadderNode[]): LadderNode[] => {
    const result: LadderNode[] = []
    for (const n of nodes) {
      if (n.kind === 'parallel' && n.id === branchId) {
        const b = n as LadderParallelBranchNode
        const remaining = b.branches.filter((_, idx) => idx !== branchIndex)
        if (remaining.length <= 1) {
          result.push(...healRecursive(remaining[0] || []))
        } else {
          result.push({ ...b, branches: remaining.map((leg) => healRecursive(leg || [])) })
        }
      } else if (n.kind === 'parallel') {
        const b = n as LadderParallelBranchNode
        result.push({ ...b, branches: b.branches.map((leg) => healRecursive(leg || [])) })
      } else {
        result.push(n)
      }
    }
    return result
  }

  return networks.map((net) => ({
    ...net,
    nodes: net.nodes ? healRecursive(net.nodes) : []
  }))
}

export function wrapNodeInParallelBranch(networks: readonly LadNetwork[], nodeId: string): LadNetwork[] {
  const wrapRecursive = (nodes: readonly LadderNode[]): LadderNode[] => {
    const result: LadderNode[] = []
    for (const n of nodes) {
      if (n.id === nodeId) {
        const newParallel: LadderParallelBranchNode = {
          id: generateId('node_parallel'),
          kind: 'parallel',
          branches: [
            [n],
            [
              {
                id: generateId('node_contact'),
                kind: 'contact',
                contactType: 'NO_CONTACT',
                operand: '???'
              } as LadderContactNode
            ]
          ]
        }
        result.push(newParallel)
      } else if (n.kind === 'parallel') {
        const p = n as LadderParallelBranchNode
        result.push({ ...p, branches: p.branches.map((leg) => wrapRecursive(leg || [])) })
      } else {
        result.push(n)
      }
    }
    return result
  }

  return networks.map((net) => ({
    ...net,
    nodes: net.nodes ? wrapRecursive(net.nodes) : []
  }))
}

export function updateNodeById(
  networks: readonly LadNetwork[],
  nodeId: string,
  updater: (node: LadderNode) => LadderNode
): LadNetwork[] {
  const updateRecursive = (nodes: readonly LadderNode[]): LadderNode[] =>
    nodes.map((n) => {
      if (n.id === nodeId) return updater(n)
      if (n.kind === 'parallel') {
        const p = n as LadderParallelBranchNode
        return { ...p, branches: p.branches.map((leg) => updateRecursive(leg || [])) }
      }
      return n
    })

  return networks.map((net) => ({
    ...net,
    nodes: net.nodes ? updateRecursive(net.nodes) : []
  }))
}

export function renumberNetworks(networks: readonly LadNetwork[]): LadNetwork[] {
  return networks.map((n, idx) => (n.networkNumber === idx + 1 ? n : { ...n, networkNumber: idx + 1 }))
}

export function insertNetworkAt(
  networks: readonly LadNetwork[],
  insertIdx: number,
  isSclNetwork: boolean = false
): { networks: LadNetwork[]; selectedNetworkNumber: number } {
  const clampedIdx = Math.max(0, Math.min(insertIdx, networks.length))
  const newNet: LadNetwork = isSclNetwork
    ? {
        id: generateId('net_scl'),
        networkNumber: clampedIdx + 1,
        title: `Network ${clampedIdx + 1} (Hybrid SCL)`,
        isSclNetwork: true,
        sclCode: `// Hybrid SCL Calculation\n#CycleTemp := #CycleTemp + 1;\nIF "TankLevel_Raw" > 20000 THEN\n    "TankHeater_Enable" := TRUE;\nEND_IF;`,
        nodes: []
      }
    : {
        id: generateId('net'),
        networkNumber: clampedIdx + 1,
        title: `Network ${clampedIdx + 1}`,
        nodes: []
      }
  const next = [...networks]
  next.splice(clampedIdx, 0, newNet)
  return {
    networks: renumberNetworks(next),
    selectedNetworkNumber: clampedIdx + 1
  }
}

export function moveNetwork(
  networks: readonly LadNetwork[],
  fromIdx: number,
  toIdx: number
): { networks: LadNetwork[]; selectedNetworkNumber: number } | null {
  if (fromIdx < 0 || fromIdx >= networks.length || toIdx < 0 || toIdx >= networks.length || fromIdx === toIdx) {
    return null
  }
  const next = [...networks]
  const [moved] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, moved)
  return {
    networks: renumberNetworks(next),
    selectedNetworkNumber: toIdx + 1
  }
}

export function clearNetworkAt(networks: readonly LadNetwork[], netIdx: number): LadNetwork[] {
  return networks.map((n, idx) => (idx === netIdx ? { ...n, nodes: [] } : n))
}

export function deleteNetworkAt(
  networks: readonly LadNetwork[],
  netIdx: number
): { networks: LadNetwork[]; selectedNetworkNumber: number } {
  if (networks.length <= 1) {
    return {
      networks: [
        {
          id: generateId('net'),
          networkNumber: 1,
          title: 'Network 1',
          nodes: []
        }
      ],
      selectedNetworkNumber: 1
    }
  }
  const next = renumberNetworks(networks.filter((_, idx) => idx !== netIdx))
  return {
    networks: next,
    selectedNetworkNumber: Math.min(netIdx + 1, next.length)
  }
}

export function countOperandReferences(
  networks: readonly LadNetwork[],
  operand: string,
  excludeNodeId?: string
): number {
  const lower = operand.trim().toLowerCase()
  if (!lower || lower === '???') return 0
  let count = 0
  const walk = (nodes: readonly LadderNode[] | undefined): void => {
    if (!nodes) return
    for (const n of nodes) {
      if ((n.kind === 'contact' || n.kind === 'coil') && n.id !== excludeNodeId) {
        if ((n as LadderContactNode | LadderCoilNode).operand.trim().toLowerCase() === lower) {
          count++
        }
      } else if (n.kind === 'parallel') {
        for (const leg of (n as LadderParallelBranchNode).branches) {
          walk(leg)
        }
      }
    }
  }
  for (const net of networks) {
    walk(net.nodes)
  }
  return count
}
