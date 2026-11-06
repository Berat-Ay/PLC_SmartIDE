import React, { useState, useEffect } from 'react'
import {
  LadderNode,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderMathNode,
  LadderParallelBranchNode,
  LadderEmptyBoxNode,
  ContactType,
  CoilType,
  TimerType,
  CounterType,
  ComparatorType,
  MathBoxType
} from '@shared/types/ladder'
import { LadBlockDefinition, LadNetwork } from '@shared/types/blocks'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { useTagStore } from '../../../stores/useTagStore'
import { useUIStore } from '../../../stores/useUIStore'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { DoubleCoilConflict } from '../../../services/DoubleCoilDetector'
import { LadderGridLayoutEngine, LADDER_MIN_WIDTH } from '../../../services/layout/LadderGridLayoutEngine'
import { TagAutocompleteCombobox } from './TagAutocompleteCombobox'
import { InstructionRibbon } from './InstructionRibbon'
import {
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  RotateCcw
} from 'lucide-react'

interface SvgLadderCanvasProps {
  block: LadBlockDefinition
  conflicts: DoubleCoilConflict[]
  onUpdateBlock: (updated: LadBlockDefinition) => void
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
}

export interface DropZoneTarget {
  netIdx: number
  branchId?: string
  branchIndex?: number
  insertIndex: number
}

function createInstructionNode(
  kind: string,
  subType?: string,
  title?: string
): LadderNode {
  const idSuffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`
  if (kind === 'contact') {
    const contactType: ContactType = (subType as ContactType) || 'NO_CONTACT'
    return {
      id: `node_contact_${idSuffix}`,
      kind: 'contact',
      contactType,
      operand: '???'
    }
  } else if (kind === 'coil') {
    const coilType: CoilType = (subType as CoilType) || 'OUTPUT_COIL'
    return {
      id: `node_coil_${idSuffix}`,
      kind: 'coil',
      coilType,
      operand: '???'
    }
  } else if (kind === 'timer') {
    const timerType: TimerType = (subType as TimerType) || 'TON'
    return {
      id: `node_timer_${idSuffix}`,
      kind: 'timer',
      timerType,
      instanceDb: `DB_${timerType}_${idSuffix.slice(-3)}`,
      inOperand: 'IN',
      ptOperand: 'T#5s',
      qOperand: 'Q',
      etOperand: 'ET'
    }
  } else if (kind === 'counter') {
    const counterType: CounterType = (subType as CounterType) || 'CTU'
    return {
      id: `node_counter_${idSuffix}`,
      kind: 'counter',
      counterType,
      instanceDb: `DB_${counterType}_${idSuffix.slice(-3)}`,
      cuCdOperand: 'CU',
      rLdOperand: 'R',
      pvOperand: '10',
      qOperand: 'Q',
      cvOperand: 'CV'
    }
  } else if (kind === 'comparator') {
    const comparatorType: ComparatorType = (subType as ComparatorType) || 'CMP_EQ'
    return {
      id: `node_cmp_${idSuffix}`,
      kind: 'comparator',
      comparatorType,
      op1: 'TankLevel_Raw',
      op2: '20000',
      dataType: 'INT'
    }
  } else if (kind === 'math') {
    const boxType: MathBoxType = (subType as MathBoxType) || 'ADD'
    return {
      id: `node_math_${idSuffix}`,
      kind: 'math',
      boxType,
      in1: '13824',
      in2: '27648',
      out: 'Scaled_Result'
    }
  } else if (kind === 'parallel') {
    return {
      id: `node_parallel_${idSuffix}`,
      kind: 'parallel',
      branches: [[], []]
    }
  } else {
    return {
      id: `node_box_${idSuffix}`,
      kind: 'emptyBox',
      instruction: title || subType || '???'
    }
  }
}

function getNodeWidth(n: LadderNode): number {
  if (n.kind === 'contact') return 175
  if (n.kind === 'coil') return 175
  if (n.kind === 'emptyBox') return 130
  if (['timer', 'counter', 'comparator', 'math'].includes(n.kind)) return 150
  if (n.kind === 'parallel') {
    const p = n as LadderParallelBranchNode
    let maxBWidth = 160
    for (const b of p.branches) {
      const bW = (b || []).reduce((sum, child) => sum + getNodeWidth(child), 0)
      maxBWidth = Math.max(maxBWidth, bW + 40)
    }
    return maxBWidth
  }
  return 175
}

function getMaxHorizontalNodes(nodeList: LadderNode[]): number {
  let count = 0
  for (const n of nodeList) {
    if (n.kind === 'parallel') {
      const p = n as LadderParallelBranchNode
      let maxBranchNodes = 0
      for (const branch of p.branches) {
        maxBranchNodes = Math.max(maxBranchNodes, getMaxHorizontalNodes(branch || []))
      }
      count += Math.max(1, maxBranchNodes)
    } else {
      count += 1
    }
  }
  return count
}

interface DropCandidate {
  x: number
  y: number
  target: DropZoneTarget
}

const WIRE_Y = LadderGridLayoutEngine.TOP_PADDING
// A selection toolbar starts right of the left power rail instead of covering it
const TOOLBAR_MIN_X = 38
const POWER_RAIL_X = 30

function getNetworkDropCandidates(net: LadNetwork, netIdx: number): DropCandidate[] {
  const candidates: DropCandidate[] = []
  const nodes = net.nodes || []

  if (nodes.length === 0) {
    candidates.push({ x: LADDER_MIN_WIDTH / 2, y: WIRE_Y, target: { netIdx, insertIndex: 0 } })
    return candidates
  }

  const maxH = getMaxHorizontalNodes(net.nodes || [])
  const contentW = 48 + Math.max(1, maxH) * 175 + 220 + 60
  const svgW = Math.max(LADDER_MIN_WIDTH, contentW)
  const targetCoilX = svgW - 60 - 70
  const rightRailX = svgW - 60

  const collectCandidates = (
    nodeList: LadderNode[],
    startX: number,
    y: number,
    branchCtx?: { branchId: string; branchIndex: number }
  ) => {
    let curX = startX
    candidates.push({
      x: curX + 10,
      y,
      target: {
        netIdx,
        branchId: branchCtx?.branchId,
        branchIndex: branchCtx?.branchIndex,
        insertIndex: 0
      }
    })

    nodeList.forEach((node, idx) => {
      const isLastNode = idx === nodeList.length - 1
      if (node.kind === 'contact') {
        curX += 175
        candidates.push({
          x: curX - 10,
          y,
          target: {
            netIdx,
            branchId: branchCtx?.branchId,
            branchIndex: branchCtx?.branchIndex,
            insertIndex: idx + 1
          }
        })
      } else if (node.kind === 'coil') {
        if (!branchCtx && isLastNode) {
          const coilX = Math.max(curX + 40, targetCoilX)
          candidates.push({
            x: coilX - 18,
            y,
            target: { netIdx, insertIndex: idx }
          })
          curX = rightRailX
        } else {
          curX += 175
          candidates.push({
            x: curX - 10,
            y,
            target: {
              netIdx,
              branchId: branchCtx?.branchId,
              branchIndex: branchCtx?.branchIndex,
              insertIndex: idx + 1
            }
          })
        }
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        const dropY = 120
        const branchWidth = getNodeWidth(p)

        p.branches.forEach((bNodes, bIdx) => {
          const branchY = y + bIdx * dropY
          if (!bNodes || bNodes.length === 0) {
            candidates.push({
              x: curX + 80,
              y: branchY,
              target: {
                netIdx,
                branchId: p.id,
                branchIndex: bIdx,
                insertIndex: 0
              }
            })
          } else {
            collectCandidates(bNodes, curX + 20, branchY, {
              branchId: p.id,
              branchIndex: bIdx
            })
          }
        })

        curX += branchWidth
        candidates.push({
          x: curX - 10,
          y,
          target: {
            netIdx,
            branchId: branchCtx?.branchId,
            branchIndex: branchCtx?.branchIndex,
            insertIndex: idx + 1
          }
        })
      } else {
        const width = node.kind === 'emptyBox' ? 130 : 150
        curX += width
        candidates.push({
          x: curX - 10,
          y,
          target: {
            netIdx,
            branchId: branchCtx?.branchId,
            branchIndex: branchCtx?.branchIndex,
            insertIndex: idx + 1
          }
        })
      }
    })
  }

  collectCandidates(nodes, 30, WIRE_Y)
  return candidates
}

export const SvgLadderCanvas: React.FC<SvgLadderCanvasProps> = ({
  block,
  conflicts,
  onUpdateBlock,
  selectedNodeId,
  onSelectNode
}) => {
  const { isMonitoring, currentSnapshot, scrubbedSnapshot, timeTravelActive, state: cpuStatus } = useRuntimeStore()
  const isMonitoringActive = isMonitoring && cpuStatus === 'RUN'
  const { tagTables, updateTag, addTag } = useTagStore()
  const { canvasZoom, setCanvasZoom } = useUIStore()
  const allTags = tagTables.flatMap((t) => t.tags)

  // Active snapshot for live power glow
  const activeSnapshot = timeTravelActive ? scrubbedSnapshot : currentSnapshot
  const powerStates = isMonitoringActive ? (activeSnapshot?.ladPowerState || {}) : {}

  // Autocomplete editing state (Symbolic Name editor)
  const [editingNode, setEditingNode] = useState<{
    netIdx: number
    nodeId: string
    currentOperand: string
    pos: { x: number; y: number }
  } | null>(null)

  // In-place Bit Address editing state (Physical Address editor)
  const [editingAddressNode, setEditingAddressNode] = useState<{
    netIdx: number
    nodeId: string
    currentOperand: string
    currentAddress: string
    pos: { x: number; y: number }
  } | null>(null)
  const [addressInputValue, setAddressInputValue] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)

  // Direct In-Place Timer / Counter Instance Name & Preset editing state
  const [editingTimerProp, setEditingTimerProp] = useState<{
    netIdx: number
    nodeId: string
    propType: 'instance' | 'preset'
    currentVal: string
    pos: { x: number; y: number }
  } | null>(null)
  const [timerPropInputValue, setTimerPropInputValue] = useState('')

  // Drag and drop state
  const [isDraggingInstruction, setIsDraggingInstruction] = useState(false)
  const [hoveredDropZone, setHoveredDropZone] = useState<DropZoneTarget | null>(null)
  const [magneticSnapPos, setMagneticSnapPos] = useState<{
    netIdx: number
    x: number
    y: number
    target: DropZoneTarget
  } | null>(null)

  // Active network selection tracking
  const [selectedNetworkNumber, setSelectedNetworkNumber] = useState<number>(
    block.networks[0]?.networkNumber || 1
  )

  // Track parallel branch target selection for interactive insertion
  const [selectedBranchTarget, setSelectedBranchTarget] = useState<{
    branchId: string
    branchIndex: number
  } | null>(null)

  // Track blocking contact diagnosed by AI
  const [blockingNodeId, setBlockingNodeId] = useState<string | null>(null)

  // Listen for AI Diagnostic highlights
  useEffect(() => {
    const handleHighlight = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string }>).detail
      if (detail?.nodeId) {
        setBlockingNodeId(detail.nodeId)
      }
    }
    const handleClear = () => setBlockingNodeId(null)
    window.addEventListener('plc:highlight-blocking-node', handleHighlight)
    window.addEventListener('plc:clear-blocking-highlight', handleClear)
    return () => {
      window.removeEventListener('plc:highlight-blocking-node', handleHighlight)
      window.removeEventListener('plc:clear-blocking-highlight', handleClear)
    }
  }, [])

  // Listen for drag start/end & instruction tree insertions
  useEffect(() => {
    const handleDragStart = () => {
      if (!isMonitoring) setIsDraggingInstruction(true)
    }
    const handleDragEnd = () => {
      setIsDraggingInstruction(false)
      setHoveredDropZone(null)
      setMagneticSnapPos(null)
    }
    const handleInsertCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: string; subType?: string; title?: string }>).detail
      if (!detail) return
      const newNode = createInstructionNode(detail.kind, detail.subType, detail.title)
      const { targetNetIdx, afterNodeIdx } = getTargetLocation()
      insertNodeAtZone(newNode, { netIdx: targetNetIdx, insertIndex: afterNodeIdx + 1 })
    }

    window.addEventListener('plc:drag-instruction-start', handleDragStart)
    window.addEventListener('plc:drag-instruction-end', handleDragEnd)
    window.addEventListener('plc:insert-custom-instruction', handleInsertCustom)
    window.addEventListener('dragend', handleDragEnd)
    window.addEventListener('drop', handleDragEnd)
    window.addEventListener('mouseup', handleDragEnd)

    return () => {
      window.removeEventListener('plc:drag-instruction-start', handleDragStart)
      window.removeEventListener('plc:drag-instruction-end', handleDragEnd)
      window.removeEventListener('plc:insert-custom-instruction', handleInsertCustom)
      window.removeEventListener('dragend', handleDragEnd)
      window.removeEventListener('drop', handleDragEnd)
      window.removeEventListener('mouseup', handleDragEnd)
    }
  }, [block, selectedNetworkNumber, selectedNodeId, isMonitoring])

  // Sync selectedNetworkNumber if block networks change and selection becomes invalid
  useEffect(() => {
    if (!block.networks.some((n: LadNetwork) => n.networkNumber === selectedNetworkNumber)) {
      if (block.networks.length > 0) {
        setSelectedNetworkNumber(block.networks[0].networkNumber)
      }
    }
  }, [block.networks, selectedNetworkNumber])

  // Helper to resolve insertion location (after selected node, or into selected network)
  const getTargetLocation = (): { targetNetIdx: number; afterNodeIdx: number } => {
    if (selectedNodeId) {
      for (let netIdx = 0; netIdx < block.networks.length; netIdx++) {
        const net = block.networks[netIdx]
        if (!net.nodes) continue
        const nodeIdx = net.nodes.findIndex((n: LadderNode) => n.id === selectedNodeId)
        if (nodeIdx !== -1) {
          return { targetNetIdx: netIdx, afterNodeIdx: nodeIdx }
        }
      }
    }
    const curIdx = block.networks.findIndex((n: LadNetwork) => n.networkNumber === selectedNetworkNumber)
    if (curIdx !== -1) {
      return { targetNetIdx: curIdx, afterNodeIdx: -1 }
    }
    return { targetNetIdx: Math.max(0, block.networks.length - 1), afterNodeIdx: -1 }
  }

  // Double coil operand set for quick highlight lookup
  const conflictingOperands = new Set(conflicts.map((c) => c.normalizedOperand))

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (editingNode || editingAddressNode) return

      // Shift+Delete: Delete selected network
      if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        const curIdx = block.networks.findIndex((n: LadNetwork) => n.networkNumber === selectedNetworkNumber)
        if (curIdx !== -1) {
          deleteNetwork(curIdx)
        }
        return
      }

      // Normal Delete/Backspace: Delete selected node or empty branch leg
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId) {
          e.preventDefault()
          deleteNode(selectedNodeId)
        } else if (selectedBranchTarget) {
          e.preventDefault()
          deleteBranchLeg(selectedBranchTarget.branchId, selectedBranchTarget.branchIndex)
        }
      } else if (e.shiftKey && e.key === 'F2') {
        e.preventDefault()
        insertContact('NO_CONTACT')
      } else if (e.shiftKey && e.key === 'F3') {
        e.preventDefault()
        insertContact('NC_CONTACT')
      } else if (e.key === 'F7') {
        e.preventDefault()
        insertCoil('OUTPUT_COIL')
      } else if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        insertParallelBranch()
      } else if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        addNewNetwork()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedBranchTarget, editingNode, editingAddressNode, block, selectedNetworkNumber])

  // Insertion handlers (Default operand is '???')
  const insertContact = (type: ContactType) => {
    const updatedNetworks = [...block.networks]
    const newContact: LadderContactNode = {
      id: `node_contact_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      kind: 'contact',
      contactType: type,
      operand: '???'
    }

    // 1. If user clicked a parallel branch drop-zone (+ Add Contact Here)
    if (selectedBranchTarget) {
      for (const net of updatedNetworks) {
        if (!net.nodes) continue
        const insertInBranch = (nodes: LadderNode[]): boolean => {
          for (const n of nodes) {
            if (n.kind === 'parallel' && n.id === selectedBranchTarget.branchId) {
              const b = n as LadderParallelBranchNode
              const branchIdx = selectedBranchTarget.branchIndex
              if (!b.branches[branchIdx]) b.branches[branchIdx] = []
              b.branches[branchIdx] = [...b.branches[branchIdx], newContact]
              return true
            } else if (n.kind === 'parallel') {
              const b = n as LadderParallelBranchNode
              for (let bi = 0; bi < b.branches.length; bi++) {
                if (insertInBranch(b.branches[bi] || [])) return true
              }
            }
          }
          return false
        }
        if (insertInBranch(net.nodes)) {
          onUpdateBlock({ ...block, networks: updatedNetworks })
          onSelectNode(newContact.id)
          setSelectedBranchTarget(null)
          return
        }
      }
    }

    // 2. If selectedNodeId is inside a parallel branch
    if (selectedNodeId) {
      for (const net of updatedNetworks) {
        if (!net.nodes) continue
        const insertAfterInBranch = (nodes: LadderNode[]): boolean => {
          for (const n of nodes) {
            if (n.kind === 'parallel') {
              const b = n as LadderParallelBranchNode
              for (let bi = 0; bi < b.branches.length; bi++) {
                const idx = b.branches[bi].findIndex((node) => node.id === selectedNodeId)
                if (idx !== -1) {
                  b.branches[bi].splice(idx + 1, 0, newContact)
                  return true
                }
              }
              if (insertAfterInBranch(b.branches[0] || []) || insertAfterInBranch(b.branches[1] || [])) return true
            }
          }
          return false
        }
        if (insertAfterInBranch(net.nodes)) {
          onUpdateBlock({ ...block, networks: updatedNetworks })
          onSelectNode(newContact.id)
          return
        }
      }
    }

    // 3. Otherwise insert into main network series nodes
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return
    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []

    if (afterNodeIdx !== -1) {
      const selNode = nodes[afterNodeIdx]
      if (selNode.kind === 'coil') {
        nodes.splice(afterNodeIdx, 0, newContact)
      } else {
        nodes.splice(afterNodeIdx + 1, 0, newContact)
      }
    } else {
      const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
      if (coilIdx !== -1) {
        nodes.splice(coilIdx, 0, newContact)
      } else {
        nodes.push(newContact)
      }
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newContact.id)
  }

  const insertCoil = (type: CoilType) => {
    const updatedNetworks = [...block.networks]
    const newCoil: LadderCoilNode = {
      id: `node_coil_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      kind: 'coil',
      coilType: type,
      operand: '???'
    }

    // 1. If user targeted a parallel branch drop-zone (+ Add Instruction)
    if (selectedBranchTarget) {
      for (const net of updatedNetworks) {
        if (!net.nodes) continue
        const insertInBranch = (nodes: LadderNode[]): boolean => {
          for (const n of nodes) {
            if (n.kind === 'parallel' && n.id === selectedBranchTarget.branchId) {
              const b = n as LadderParallelBranchNode
              const branchIdx = selectedBranchTarget.branchIndex
              if (!b.branches[branchIdx]) b.branches[branchIdx] = []
              b.branches[branchIdx] = [...b.branches[branchIdx], newCoil]
              return true
            } else if (n.kind === 'parallel') {
              const b = n as LadderParallelBranchNode
              for (let bi = 0; bi < b.branches.length; bi++) {
                if (insertInBranch(b.branches[bi] || [])) return true
              }
            }
          }
          return false
        }
        if (insertInBranch(net.nodes)) {
          onUpdateBlock({ ...block, networks: updatedNetworks })
          onSelectNode(newCoil.id)
          setSelectedBranchTarget(null)
          return
        }
      }
    }

    // 2. If selectedNodeId is inside a parallel branch
    if (selectedNodeId) {
      for (const net of updatedNetworks) {
        if (!net.nodes) continue
        const insertAfterInBranch = (nodes: LadderNode[]): boolean => {
          for (const n of nodes) {
            if (n.kind === 'parallel') {
              const b = n as LadderParallelBranchNode
              for (let bi = 0; bi < b.branches.length; bi++) {
                const idx = b.branches[bi].findIndex((node) => node.id === selectedNodeId)
                if (idx !== -1) {
                  b.branches[bi].splice(idx + 1, 0, newCoil)
                  return true
                }
              }
              for (let bi = 0; bi < b.branches.length; bi++) {
                if (insertAfterInBranch(b.branches[bi] || [])) return true
              }
            }
          }
          return false
        }
        if (insertAfterInBranch(net.nodes)) {
          onUpdateBlock({ ...block, networks: updatedNetworks })
          onSelectNode(newCoil.id)
          return
        }
      }
    }

    // 3. Otherwise insert into main network series nodes
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return
    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []

    if (afterNodeIdx !== -1) {
      nodes.splice(afterNodeIdx + 1, 0, newCoil)
    } else {
      nodes.push(newCoil)
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newCoil.id)
  }

  const insertEmptyBox = (instruction: string = '???') => {
    const updatedNetworks = [...block.networks]
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return

    const newBox: LadderEmptyBoxNode = {
      id: `node_box_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      kind: 'emptyBox',
      instruction
    }

    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []
    const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
    if (afterNodeIdx !== -1 && nodes[afterNodeIdx].kind !== 'coil') {
      nodes.splice(afterNodeIdx + 1, 0, newBox)
    } else if (coilIdx !== -1) {
      nodes.splice(coilIdx, 0, newBox)
    } else {
      nodes.push(newBox)
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newBox.id)
  }

  const addBranchTier = (branchId: string) => {
    let newTierIndex = 2
    const updatedNetworks = block.networks.map((net: LadNetwork) => {
      const addRecursive = (nodes: LadderNode[]): LadderNode[] => {
        return nodes.map((n) => {
          if (n.kind === 'parallel' && n.id === branchId) {
            const b = n as LadderParallelBranchNode
            const branches = [...b.branches, []]
            newTierIndex = branches.length - 1
            return {
              ...b,
              branches
            }
          } else if (n.kind === 'parallel') {
            const b = n as LadderParallelBranchNode
            return {
              ...b,
              branches: b.branches.map(addRecursive)
            }
          }
          return n
        })
      }
      return {
        ...net,
        nodes: net.nodes ? addRecursive(net.nodes) : []
      }
    })

    onUpdateBlock({ ...block, networks: updatedNetworks })
    onSelectNode(branchId)
    setSelectedBranchTarget({ branchId, branchIndex: newTierIndex })
  }

  const deleteBranchLeg = (branchId: string, branchIndex: number) => {
    const updatedNetworks = block.networks.map((net: LadNetwork) => {
      const healRecursive = (nodes: LadderNode[]): LadderNode[] => {
        const result: LadderNode[] = []
        for (const n of nodes) {
          if (n.kind === 'parallel' && n.id === branchId) {
            const b = n as LadderParallelBranchNode
            const newBranches = b.branches.filter((_, idx) => idx !== branchIndex)
            if (newBranches.length <= 1) {
              // Unpack remaining branch into parent series list, healing the circuit!
              const remainingNodes = newBranches[0] || []
              result.push(...healRecursive(remainingNodes))
            } else {
              result.push({
                ...b,
                branches: newBranches.map(healRecursive)
              })
            }
          } else if (n.kind === 'parallel') {
            const b = n as LadderParallelBranchNode
            result.push({
              ...b,
              branches: b.branches.map(healRecursive)
            })
          } else {
            result.push(n)
          }
        }
        return result
      }
      return {
        ...net,
        nodes: net.nodes ? healRecursive(net.nodes) : []
      }
    })

    onUpdateBlock({ ...block, networks: updatedNetworks })
    onSelectNode(null)
    setSelectedBranchTarget(null)
  }

  const insertParallelBranch = () => {
    const updatedNetworks = [...block.networks]

    // 1. If a parallel branch or branch tier is already targeted, add a tier to it!
    const targetBranchId =
      selectedBranchTarget?.branchId ||
      (selectedNodeId && selectedNodeId.startsWith('node_parallel_') ? selectedNodeId : null)

    if (targetBranchId) {
      addBranchTier(targetBranchId)
      return
    }

    // 2. Otherwise insert a new parallel branch into current network
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return

    const newBranch: LadderParallelBranchNode = {
      id: `node_parallel_${Date.now()}`,
      kind: 'parallel',
      branches: [[], []]
    }

    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []

    if (afterNodeIdx !== -1) {
      const selNode = nodes[afterNodeIdx]
      if (selNode.kind === 'coil') {
        nodes.splice(afterNodeIdx, 0, newBranch)
      } else {
        nodes.splice(afterNodeIdx + 1, 0, newBranch)
      }
    } else {
      const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
      if (coilIdx !== -1) {
        nodes.splice(coilIdx, 0, newBranch)
      } else {
        nodes.push(newBranch)
      }
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newBranch.id)
    setSelectedBranchTarget({ branchId: newBranch.id, branchIndex: 0 })
  }

  const insertTimer = (type: TimerType) => {
    const updatedNetworks = [...block.networks]
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return

    const newTimer: LadderTimerNode = {
      id: `node_timer_${Date.now()}`,
      kind: 'timer',
      timerType: type,
      instanceDb: `DB_TON_${Date.now() % 1000}`,
      inOperand: 'IN',
      ptOperand: 'T#5s',
      qOperand: 'Q',
      etOperand: 'ET'
    }

    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []
    const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
    if (afterNodeIdx !== -1 && nodes[afterNodeIdx].kind !== 'coil') {
      nodes.splice(afterNodeIdx + 1, 0, newTimer)
    } else if (coilIdx !== -1) {
      nodes.splice(coilIdx, 0, newTimer)
    } else {
      nodes.push(newTimer)
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newTimer.id)
  }

  const insertComparator = (type: ComparatorType) => {
    const updatedNetworks = [...block.networks]
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return

    const newCmp: LadderComparatorNode = {
      id: `node_cmp_${Date.now()}`,
      kind: 'comparator',
      comparatorType: type,
      op1: 'TankLevel_Raw',
      op2: '20000',
      dataType: 'INT'
    }

    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []
    const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
    if (afterNodeIdx !== -1 && nodes[afterNodeIdx].kind !== 'coil') {
      nodes.splice(afterNodeIdx + 1, 0, newCmp)
    } else if (coilIdx !== -1) {
      nodes.splice(coilIdx, 0, newCmp)
    } else {
      nodes.push(newCmp)
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newCmp.id)
  }

  const insertMath = (type: MathBoxType) => {
    const updatedNetworks = [...block.networks]
    const { targetNetIdx, afterNodeIdx } = getTargetLocation()
    if (targetNetIdx < 0 || targetNetIdx >= updatedNetworks.length) return

    const newMath: LadderMathNode = {
      id: `node_math_${Date.now()}`,
      kind: 'math',
      boxType: type,
      in1: '13824',
      in2: '27648',
      out: 'Scaled_Result'
    }

    const net = updatedNetworks[targetNetIdx]
    const nodes = net.nodes ? [...net.nodes] : []
    const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
    if (afterNodeIdx !== -1 && nodes[afterNodeIdx].kind !== 'coil') {
      nodes.splice(afterNodeIdx + 1, 0, newMath)
    } else if (coilIdx !== -1) {
      nodes.splice(coilIdx, 0, newMath)
    } else {
      nodes.push(newMath)
    }

    updatedNetworks[targetNetIdx] = { ...net, nodes }
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newMath.id)
  }

  const insertSclNetwork = () => {
    const updatedNetworks = [...block.networks]
    const curNetIdx = updatedNetworks.findIndex((n) => n.networkNumber === selectedNetworkNumber)
    const targetIdx = curNetIdx !== -1 ? curNetIdx + 1 : updatedNetworks.length

    const newSclNet: LadNetwork = {
      id: `net_scl_${Date.now()}`,
      networkNumber: targetIdx + 1,
      title: `Network ${targetIdx + 1} (Hybrid SCL)`,
      isSclNetwork: true,
      sclCode: `// Hybrid SCL Calculation\n#CycleTemp := #CycleTemp + 1;\nIF "TankLevel_Raw" > 20000 THEN\n    "TankHeater_Enable" := TRUE;\nEND_IF;`,
      nodes: []
    }
    updatedNetworks.splice(targetIdx, 0, newSclNet)
    updatedNetworks.forEach((n, idx) => {
      n.networkNumber = idx + 1
    })
    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(targetIdx + 1)
  }

  const addNewNetwork = () => {
    const updatedNetworks = [...block.networks]
    const curNetIdx = updatedNetworks.findIndex((n) => n.networkNumber === selectedNetworkNumber)
    const targetIdx = curNetIdx !== -1 ? curNetIdx + 1 : updatedNetworks.length

    const newNet: LadNetwork = {
      id: `net_${Date.now()}`,
      networkNumber: targetIdx + 1,
      title: `Network ${targetIdx + 1}`,
      nodes: []
    }
    updatedNetworks.splice(targetIdx, 0, newNet)
    updatedNetworks.forEach((n, idx) => {
      n.networkNumber = idx + 1
    })

    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(targetIdx + 1)

    setTimeout(() => {
      document.getElementById(`network-card-${targetIdx + 1}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      })
    }, 50)
  }

  // Network CRUD Functions
  const moveNetworkUp = (netIdx: number) => {
    if (netIdx <= 0) return
    const updated = [...block.networks]
    const temp = updated[netIdx]
    updated[netIdx] = updated[netIdx - 1]
    updated[netIdx - 1] = temp
    updated.forEach((n, i) => {
      n.networkNumber = i + 1
    })
    onUpdateBlock({ ...block, networks: updated })
    setSelectedNetworkNumber(netIdx)
  }

  const moveNetworkDown = (netIdx: number) => {
    if (netIdx >= block.networks.length - 1) return
    const updated = [...block.networks]
    const temp = updated[netIdx]
    updated[netIdx] = updated[netIdx + 1]
    updated[netIdx + 1] = temp
    updated.forEach((n, i) => {
      n.networkNumber = i + 1
    })
    onUpdateBlock({ ...block, networks: updated })
    setSelectedNetworkNumber(netIdx + 2)
  }

  const insertRungBelow = (netIdx: number) => {
    const updated = [...block.networks]
    const targetIdx = netIdx + 1
    const newNet: LadNetwork = {
      id: `net_${Date.now()}`,
      networkNumber: targetIdx + 1,
      title: `Network ${targetIdx + 1}`,
      nodes: []
    }
    updated.splice(targetIdx, 0, newNet)
    updated.forEach((n, i) => {
      n.networkNumber = i + 1
    })
    onUpdateBlock({ ...block, networks: updated })
    setSelectedNetworkNumber(targetIdx + 1)
  }

  const clearNetwork = (netIdx: number) => {
    const updated = [...block.networks]
    updated[netIdx] = {
      ...updated[netIdx],
      nodes: []
    }
    onUpdateBlock({ ...block, networks: updated })
  }

  const deleteNetwork = (netIdx: number) => {
    if (block.networks.length <= 1) {
      const updated: LadNetwork[] = [
        {
          id: `net_${Date.now()}`,
          networkNumber: 1,
          title: 'Network 1',
          nodes: []
        }
      ]
      onUpdateBlock({ ...block, networks: updated })
      setSelectedNetworkNumber(1)
      return
    }

    const updated = block.networks.filter((_: LadNetwork, i: number) => i !== netIdx)
    updated.forEach((n: LadNetwork, i: number) => {
      n.networkNumber = i + 1
    })
    onUpdateBlock({ ...block, networks: updated })
    const nextSelected = Math.min(netIdx + 1, updated.length)
    setSelectedNetworkNumber(nextSelected)
  }

  const deleteNode = (nodeId: string) => {
    const updatedNetworks = block.networks.map((net: LadNetwork) => {
      const removeRecursive = (nodes: LadderNode[]): LadderNode[] => {
        return nodes
          .filter((n) => n.id !== nodeId)
          .map((n) => {
            if (n.kind === 'parallel') {
              const b = n as LadderParallelBranchNode
              return {
                ...b,
                branches: b.branches.map(removeRecursive)
              }
            }
            return n
          })
      }
      return {
        ...net,
        nodes: net.nodes ? removeRecursive(net.nodes) : []
      }
    })

    onUpdateBlock({ ...block, networks: updatedNetworks })
    onSelectNode(null)
    setSelectedBranchTarget(null)
  }

  const handleOperandChange = (newOperand: string) => {
    if (!editingNode) return
    const { nodeId, currentOperand } = editingNode
    const cleanNew = newOperand.trim()
    if (!cleanNew) {
      setEditingNode(null)
      return
    }

    const currentAllTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
    const existingTagWithOldName = currentAllTags.find(
      (t) => t.name.toLowerCase() === currentOperand.toLowerCase()
    )
    const existingTagWithNewName = currentAllTags.find(
      (t) => t.name.toLowerCase() === cleanNew.toLowerCase()
    )

    if (existingTagWithOldName && currentOperand !== '???' && !existingTagWithNewName) {
      // User is renaming the existing tag in-place: update tag name, keeping its physical address intact!
      const table = useTagStore.getState().tagTables.find((t) =>
        t.tags.some((tag) => tag.id === existingTagWithOldName.id)
      )
      if (table) {
        useTagStore.getState().updateTag(table.id, existingTagWithOldName.id, {
          name: cleanNew
        })
      }
    }

    updateNodeOperand(nodeId, cleanNew)
    setEditingNode(null)
  }

  // Update operand for a node across all networks
  const updateNodeOperand = (nodeId: string, newOperand: string) => {
    const updateRecursive = (nodes: LadderNode[]): LadderNode[] => {
      return nodes.map((n) => {
        if (n.id === nodeId) {
          if (n.kind === 'contact' || n.kind === 'coil') {
            return { ...n, operand: newOperand }
          }
        } else if (n.kind === 'parallel') {
          const b = n as LadderParallelBranchNode
          return {
            ...b,
            branches: b.branches.map(updateRecursive)
          }
        }
        return n
      })
    }

    const updatedNetworks = block.networks.map((net) => ({
      ...net,
      nodes: net.nodes ? updateRecursive(net.nodes) : []
    }))

    onUpdateBlock({ ...block, networks: updatedNetworks })
  }

  // Direct In-Place Bit Address Submission
  const handleBitAddressSubmit = (rawInput: string) => {
    if (!editingAddressNode) return
    const trimmed = rawInput.trim()
    if (!trimmed) {
      setEditingAddressNode(null)
      return
    }

    const norm = normalizeS7Address(trimmed)
    if (!norm.isValid || !norm.address) {
      setAddressError(norm.error || 'Invalid S7 bit address (must be 0..7)')
      return
    }

    const normalizedAddress = norm.address // e.g. "%Q0.5"
    const { nodeId, currentOperand } = editingAddressNode
    const currentAllTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)

    // Scenario B: Editing bottom address
    if (currentOperand !== '???') {
      // Case 1: Contact has an assigned symbol: update the tag's address without changing its symbolic name!
      const existingTag = currentAllTags.find(
        (t) => t.name.toLowerCase() === currentOperand.toLowerCase()
      )

      if (existingTag) {
        const table = useTagStore.getState().tagTables.find((t) =>
          t.tags.some((tag) => tag.id === existingTag.id)
        )
        if (table) {
          useTagStore.getState().updateTag(table.id, existingTag.id, {
            address: normalizedAddress,
            dataType: norm.inferredDataType || existingTag.dataType
          })
        }
      } else {
        // Tag wasn't in table yet: create it with currentOperand as name
        const tables = useTagStore.getState().tagTables
        const targetTable = tables[0]
        const defaultTableId = targetTable?.id || 'table_default'
        useTagStore.getState().addTag(defaultTableId, {
          name: currentOperand,
          address: normalizedAddress,
          dataType: norm.inferredDataType || 'BOOL',
          comment: `Created via in-place bit editor for ${currentOperand}`
        })
      }
      // Note: currentOperand stays intact on the node!
    } else {
      // Case 2: Unassigned ("???")
      const tagWithAddress = currentAllTags.find(
        (t) => t.address.toUpperCase() === normalizedAddress.toUpperCase()
      )
      if (tagWithAddress) {
        // Bind to existing tag name
        updateNodeOperand(nodeId, tagWithAddress.name)
      } else {
        // Create new tag in first table
        const tables = useTagStore.getState().tagTables
        const targetTable = tables[0]
        const defaultTableId = targetTable?.id || 'table_default'
        const cleanAddrName = normalizedAddress.replace('%', '').replace('.', '_')
        const newTagName = `Tag_${cleanAddrName}`
        useTagStore.getState().addTag(defaultTableId, {
          name: newTagName,
          address: normalizedAddress,
          dataType: norm.inferredDataType || 'BOOL',
          comment: `Created via in-place bit editor for ${normalizedAddress}`
        })
        updateNodeOperand(nodeId, newTagName)
      }
    }

    setEditingAddressNode(null)
    setAddressError(null)
  }

  // Direct In-Place Timer / Counter Instance & Preset Submission
  const handleTimerPropSubmit = (rawInput: string) => {
    if (!editingTimerProp) return
    const trimmed = rawInput.trim()
    if (!trimmed) {
      setEditingTimerProp(null)
      return
    }

    const { nodeId, propType } = editingTimerProp
    const updateRecursive = (nodes: LadderNode[]): LadderNode[] => {
      return nodes.map((n) => {
        if (n.id === nodeId) {
          if (n.kind === 'timer') {
            const t = n as LadderTimerNode
            if (propType === 'instance') {
              return { ...t, instanceDb: trimmed, qOperand: `${trimmed}.Q`, etOperand: `${trimmed}.ET` }
            } else {
              return { ...t, ptOperand: trimmed }
            }
          } else if (n.kind === 'counter') {
            const c = n as LadderCounterNode
            if (propType === 'instance') {
              return { ...c, instanceDb: trimmed, qOperand: `${trimmed}.QU`, cvOperand: `${trimmed}.CV` }
            } else {
              return { ...c, pvOperand: trimmed }
            }
          }
        } else if (n.kind === 'parallel') {
          const b = n as LadderParallelBranchNode
          return {
            ...b,
            branches: b.branches.map(updateRecursive)
          }
        }
        return n
      })
    }

    const updatedNetworks = block.networks.map((net) => ({
      ...net,
      nodes: net.nodes ? updateRecursive(net.nodes) : []
    }))

    onUpdateBlock({ ...block, networks: updatedNetworks })
    setEditingTimerProp(null)
  }

  const updateContactType = (nodeId: string, newType: ContactType) => {
    const updatedNetworks = block.networks.map((net: LadNetwork) => {
      const updateRecursive = (nodes: LadderNode[]): LadderNode[] => {
        return nodes.map((n) => {
          if (n.id === nodeId && n.kind === 'contact') {
            return { ...(n as LadderContactNode), contactType: newType }
          } else if (n.kind === 'parallel') {
            const p = n as LadderParallelBranchNode
            return {
              ...p,
              branches: p.branches.map(updateRecursive)
            }
          }
          return n
        })
      }
      return { ...net, nodes: net.nodes ? updateRecursive(net.nodes) : [] }
    })
    onUpdateBlock({ ...block, networks: updatedNetworks })
  }

  const updateCoilType = (nodeId: string, newType: CoilType) => {
    const updatedNetworks = block.networks.map((net: LadNetwork) => {
      const updateRecursive = (nodes: LadderNode[]): LadderNode[] => {
        return nodes.map((n) => {
          if (n.id === nodeId && n.kind === 'coil') {
            return { ...(n as LadderCoilNode), coilType: newType }
          } else if (n.kind === 'parallel') {
            const p = n as LadderParallelBranchNode
            return {
              ...p,
              branches: p.branches.map(updateRecursive)
            }
          }
          return n
        })
      }
      return { ...net, nodes: net.nodes ? updateRecursive(net.nodes) : [] }
    })
    onUpdateBlock({ ...block, networks: updatedNetworks })
  }

  const wrapNodeInBranch = (nodeId: string) => {
    const updatedNetworks = block.networks.map((net: LadNetwork) => {
      const wrapRecursive = (nodes: LadderNode[]): LadderNode[] => {
        const result: LadderNode[] = []
        for (const n of nodes) {
          if (n.id === nodeId) {
            const idSuffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`
            const newParallel: LadderParallelBranchNode = {
              id: `parallel_${idSuffix}`,
              kind: 'parallel',
              branches: [
                [n],
                [
                  {
                    id: `node_contact_${idSuffix}_b`,
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
            result.push({
              ...p,
              branches: p.branches.map(wrapRecursive)
            })
          } else {
            result.push(n)
          }
        }
        return result
      }
      return { ...net, nodes: net.nodes ? wrapRecursive(net.nodes) : [] }
    })
    onUpdateBlock({ ...block, networks: updatedNetworks })
  }

  // Drop and Reorder Handlers
  const insertNodeAtZone = (newNode: LadderNode, target: DropZoneTarget) => {
    const updatedNetworks = [...block.networks]
    if (target.netIdx < 0 || target.netIdx >= updatedNetworks.length) return
    const net = updatedNetworks[target.netIdx]

    if (target.branchId) {
      const insertInBranch = (nodes: LadderNode[]): boolean => {
        for (const n of nodes) {
          if (n.kind === 'parallel' && n.id === target.branchId) {
            const b = n as LadderParallelBranchNode
            const branchIdx = target.branchIndex || 0
            if (!b.branches[branchIdx]) b.branches[branchIdx] = []
            const branchList = [...b.branches[branchIdx]]
            branchList.splice(target.insertIndex, 0, newNode)
            b.branches[branchIdx] = branchList
            return true
          } else if (n.kind === 'parallel') {
            const b = n as LadderParallelBranchNode
            for (let bi = 0; bi < b.branches.length; bi++) {
              if (insertInBranch(b.branches[bi] || [])) return true
            }
          }
        }
        return false
      }
      insertInBranch(net.nodes || [])
    } else {
      const nodes = net.nodes ? [...net.nodes] : []
      if (newNode.kind === 'coil') {
        nodes.push(newNode)
      } else {
        const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
        if (coilIdx !== -1 && target.insertIndex >= coilIdx) {
          nodes.splice(coilIdx, 0, newNode)
        } else {
          nodes.splice(Math.min(target.insertIndex, nodes.length), 0, newNode)
        }
      }
      updatedNetworks[target.netIdx] = { ...net, nodes }
    }

    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(net.networkNumber)
    onSelectNode(newNode.id)
  }

  const moveNodeToZone = (nodeId: string, target: DropZoneTarget) => {
    let removedNode: LadderNode | null = null
    const updatedNetworks = block.networks.map((net) => {
      const removeRecursive = (nodes: LadderNode[]): LadderNode[] => {
        const result: LadderNode[] = []
        for (const n of nodes) {
          if (n.id === nodeId) {
            removedNode = n
          } else if (n.kind === 'parallel') {
            const b = n as LadderParallelBranchNode
            result.push({
              ...b,
              branches: b.branches.map(removeRecursive)
            })
          } else {
            result.push(n)
          }
        }
        return result
      }
      return { ...net, nodes: net.nodes ? removeRecursive(net.nodes) : [] }
    })

    if (!removedNode) return

    const targetNet = updatedNetworks[target.netIdx]
    if (!targetNet) return

    if (target.branchId) {
      const insertInBranch = (nodes: LadderNode[]): boolean => {
        for (const n of nodes) {
          if (n.kind === 'parallel' && n.id === target.branchId) {
            const b = n as LadderParallelBranchNode
            const branchIdx = target.branchIndex || 0
            if (!b.branches[branchIdx]) b.branches[branchIdx] = []
            const branchList = [...b.branches[branchIdx]]
            branchList.splice(target.insertIndex, 0, removedNode!)
            b.branches[branchIdx] = branchList
            return true
          } else if (n.kind === 'parallel') {
            const b = n as LadderParallelBranchNode
            for (let bi = 0; bi < b.branches.length; bi++) {
              if (insertInBranch(b.branches[bi] || [])) return true
            }
          }
        }
        return false
      }
      insertInBranch(targetNet.nodes || [])
    } else {
      const nodes = targetNet.nodes ? [...targetNet.nodes] : []
      if ((removedNode as LadderNode).kind === 'coil') {
        nodes.push(removedNode)
      } else {
        const coilIdx = nodes.findIndex((n) => n.kind === 'coil')
        if (coilIdx !== -1 && target.insertIndex >= coilIdx) {
          nodes.splice(coilIdx, 0, removedNode)
        } else {
          nodes.splice(Math.min(target.insertIndex, nodes.length), 0, removedNode)
        }
      }
      updatedNetworks[target.netIdx] = { ...targetNet, nodes }
    }

    onUpdateBlock({ ...block, networks: updatedNetworks })
    setSelectedNetworkNumber(targetNet.networkNumber)
    onSelectNode((removedNode as LadderNode).id)
  }

  const handleDropOnZone = (e: React.DragEvent, target: DropZoneTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setHoveredDropZone(null)
    setIsDraggingInstruction(false)

    if (!e.dataTransfer) return

    // Check reorder payload
    const reorderData = e.dataTransfer.getData('application/plc-reorder-node')
    if (reorderData) {
      try {
        const { nodeId } = JSON.parse(reorderData)
        if (nodeId) {
          moveNodeToZone(nodeId, target)
          return
        }
      } catch {
        // ignore
      }
    }

    // Check instruction payload
    const instrData = e.dataTransfer.getData('application/plc-instruction')
    if (instrData) {
      try {
        const data = JSON.parse(instrData)
        const newNode = createInstructionNode(data.instructionType, data.subType, data.title)
        insertNodeAtZone(newNode, target)
        return
      } catch {
        // ignore
      }
    }
  }

  // Magnetic Wire Drag Handlers
  const handleSvgDragOver = (e: React.DragEvent<SVGSVGElement>, netIdx: number) => {
    e.preventDefault()
    if (isMonitoringActive) {
      if (magneticSnapPos) setMagneticSnapPos(null)
      if (hoveredDropZone) setHoveredDropZone(null)
      return
    }
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
    setIsDraggingInstruction(true)

    const svgElem = e.currentTarget
    const rect = svgElem.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const vb = svgElem.viewBox.baseVal
    const vbWidth = vb.width || 1100
    const vbHeight = vb.height || 145

    const mouseX = ((e.clientX - rect.left) / rect.width) * vbWidth
    const mouseY = ((e.clientY - rect.top) / rect.height) * vbHeight

    const net = block.networks[netIdx]
    if (!net) return

    const layout = LadderGridLayoutEngine.layoutNetwork(net, netIdx)
    const closest = LadderGridLayoutEngine.findNearestDropTarget(layout.dropZones, mouseX, mouseY, 60)

    if (closest) {
      setMagneticSnapPos({
        netIdx,
        x: closest.x,
        y: closest.y,
        target: closest.target
      })
      setHoveredDropZone(closest.target)
    } else {
      if (magneticSnapPos?.netIdx === netIdx) {
        setMagneticSnapPos(null)
        setHoveredDropZone(null)
      }
    }
  }

  const handleSvgDragLeave = (e: React.DragEvent<SVGSVGElement>, netIdx: number) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      if (magneticSnapPos?.netIdx === netIdx) {
        setMagneticSnapPos(null)
        setHoveredDropZone(null)
      }
    }
  }

  const handleSvgDrop = (e: React.DragEvent<SVGSVGElement>, netIdx: number) => {
    e.preventDefault()
    e.stopPropagation()

    const snap = magneticSnapPos
    setMagneticSnapPos(null)
    setHoveredDropZone(null)
    setIsDraggingInstruction(false)

    if (snap && snap.netIdx === netIdx) {
      handleDropOnZone(e, snap.target)
    }
  }

  return (
    <div
      onMouseMove={(e) => {
        if (e.buttons === 0 && (isDraggingInstruction || magneticSnapPos || hoveredDropZone)) {
          setIsDraggingInstruction(false)
          setHoveredDropZone(null)
          setMagneticSnapPos(null)
        }
      }}
      onWheel={(e) => {
        if (e.ctrlKey) {
          e.preventDefault()
          const delta = e.deltaY < 0 ? 0.1 : -0.1
          setCanvasZoom(canvasZoom + delta)
        }
      }}
      className="flex-1 flex flex-col overflow-hidden bg-[#0c0d10] select-none"
    >
      {/* Instruction Ribbon */}
      <InstructionRibbon
        onInsertContact={insertContact}
        onInsertCoil={insertCoil}
        onInsertEmptyBox={() => insertEmptyBox('???')}
        onInsertParallelBranch={insertParallelBranch}
        onInsertTimer={insertTimer}
        onInsertComparator={insertComparator}
        onInsertMath={insertMath}
        onAddNetwork={addNewNetwork}
        onInsertSclNetwork={insertSclNetwork}
        selectedNodeId={selectedNodeId}
      />

      {/* Networks Canvas Container: Joined Steel Rung Grid (Flush Stacked, No Floating Cards) */}
      <div
        data-testid="ladder-networks-scroll"
        className="flex-1 overflow-auto bg-[#0c0d10] divide-y divide-[#27272a]"
        onClick={() => {
          // Elements stop their own clicks, so only empty space gets here
          onSelectNode(null)
          setSelectedBranchTarget(null)
        }}
      >
        {block.networks.map((net: LadNetwork, netIdx: number) => {
          const isNetSelected = selectedNetworkNumber === net.networkNumber

          if (net.isSclNetwork) {
            // Inline SCL Network
            return (
              <div
                key={net.id || net.networkNumber}
                id={`network-card-${net.networkNumber}`}
                onClick={() => setSelectedNetworkNumber(net.networkNumber)}
                className={`flex flex-row transition-all duration-100 ${
                  isNetSelected ? 'bg-[#12151c]' : 'bg-[#0e1014] hover:bg-[#111317]'
                }`}
              >
                {/* Left Steel Gutter */}
                <div
                  className={`w-12 border-r border-[#27272a] flex flex-col items-center justify-start py-2.5 font-mono text-[11px] font-bold select-none shrink-0 ${
                    isNetSelected
                      ? 'bg-[#151922] text-[#38bdf8] border-r-2 border-r-[#00a3a6]'
                      : 'bg-[#101216] text-industrial-400'
                  }`}
                >
                  <span>NW {net.networkNumber}</span>
                </div>

                {/* Right Content */}
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="h-7 px-3 bg-[#16181d] border-b border-[#27272a] flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="font-mono text-[10px] text-blue-400 font-bold shrink-0">
                        [SCL]
                      </span>
                      <input
                        type="text"
                        value={net.title || ''}
                        onChange={(e) => {
                          const updated = [...block.networks]
                          updated[netIdx] = { ...net, title: e.target.value }
                          onUpdateBlock({ ...block, networks: updated })
                        }}
                        placeholder={`Network ${net.networkNumber} title...`}
                        className="bg-transparent text-[11px] font-mono font-semibold text-industrial-200 border-none focus:outline-hidden hover:bg-[#1a1d24] px-1 flex-1 min-w-0"
                      />
                    </div>

                    {/* Network Action Buttons */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          moveNetworkUp(netIdx)
                        }}
                        disabled={netIdx === 0}
                        title="Move Network Up"
                        className="h-5 px-1 text-industrial-400 hover:text-white hover:bg-[#27272a] disabled:opacity-20 transition-colors"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          moveNetworkDown(netIdx)
                        }}
                        disabled={netIdx === block.networks.length - 1}
                        title="Move Network Down"
                        className="h-5 px-1 text-industrial-400 hover:text-white hover:bg-[#27272a] disabled:opacity-20 transition-colors"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                      <button
                        data-testid="network-insert-below"
                        onClick={(e) => {
                          e.stopPropagation()
                          insertRungBelow(netIdx)
                        }}
                        title="Insert Rung Below"
                        className="h-5 px-1.5 text-cyan-400 hover:text-white hover:bg-[#27272a] transition-colors flex items-center gap-0.5 text-[10px]"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                      <button
                        data-testid="network-delete-button"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteNetwork(netIdx)
                        }}
                        title="Delete Network (Shift+Del)"
                        className="h-5 px-1.5 text-red-400 hover:text-white hover:bg-red-950 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={net.sclCode || ''}
                    onChange={(e) => {
                      const updated = [...block.networks]
                      updated[netIdx] = { ...net, sclCode: e.target.value }
                      onUpdateBlock({ ...block, networks: updated })
                    }}
                    className="w-full h-24 bg-[#0a0b0d] text-industrial-100 font-mono text-xs p-3 focus:outline-hidden resize-none leading-relaxed"
                    spellCheck={false}
                  />
                </div>
              </div>
            )
          }

          // Standard Visual SVG Ladder Network
          const nodes = net.nodes || []

          // Deterministic 2D Cellular Matrix Layout Engine (Grid[Row][Col])
          const layout = LadderGridLayoutEngine.layoutNetwork(net, netIdx, LADDER_MIN_WIDTH)
          const svgWidth = layout.svgWidth
          const netSvgHeight = layout.svgHeight
          const coilX = layout.coilX
          const rightRailX = layout.rightRailX

          const isEmptyHovered =
            hoveredDropZone?.netIdx === netIdx &&
            hoveredDropZone?.insertIndex === 0 &&
            !hoveredDropZone.branchId

          return (
            <div
              key={net.id || net.networkNumber}
              id={`network-card-${net.networkNumber}`}
              onClick={() => setSelectedNetworkNumber(net.networkNumber)}
              className={`flex flex-row transition-all duration-100 ${
                isNetSelected ? 'bg-[#101217]' : 'bg-[#0c0d10] hover:bg-[#0f1115]'
              }`}
            >
              {/* Left Steel Gutter Bar showing NW Number */}
              <div
                className={`w-12 border-r border-[#27272a] flex flex-col items-center justify-start py-2.5 font-mono text-[11px] font-bold select-none shrink-0 ${
                  isNetSelected
                    ? 'bg-[#151922] text-[#38bdf8] border-r-2 border-r-[#00a3a6]'
                    : 'bg-[#101216] text-industrial-400'
                }`}
              >
                <span>NW {net.networkNumber}</span>
              </div>

              {/* Right Content Area: Header Strip + Canvas */}
              <div className="flex-1 flex flex-col min-w-0">
                {/* Compact Full-Width Steel Header Strip */}
                <div className="h-7 px-3 bg-[#16181d] border-b border-[#27272a] flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="font-mono text-[10px] text-industrial-400 shrink-0">
                      //
                    </span>
                    <input
                      type="text"
                      value={net.title || ''}
                      onChange={(e) => {
                        const updated = [...block.networks]
                        updated[netIdx] = { ...net, title: e.target.value }
                        onUpdateBlock({ ...block, networks: updated })
                      }}
                      placeholder={`Network ${net.networkNumber} title...`}
                      className="bg-transparent text-[11px] font-mono font-semibold text-industrial-200 border-none focus:outline-hidden hover:bg-[#1a1d24] px-1 flex-1 min-w-0"
                    />
                  </div>

                  {/* Right Action Buttons */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        moveNetworkUp(netIdx)
                      }}
                      disabled={netIdx === 0}
                      title="Move Network Up"
                      className="h-5 px-1 text-industrial-400 hover:text-white hover:bg-[#27272a] disabled:opacity-20 transition-colors"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        moveNetworkDown(netIdx)
                      }}
                      disabled={netIdx === block.networks.length - 1}
                      title="Move Network Down"
                      className="h-5 px-1 text-industrial-400 hover:text-white hover:bg-[#27272a] disabled:opacity-20 transition-colors"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button
                      data-testid="network-insert-below"
                      onClick={(e) => {
                        e.stopPropagation()
                        insertRungBelow(netIdx)
                      }}
                      title="Insert Rung Below"
                      className="h-5 px-1.5 text-cyan-400 hover:text-white hover:bg-[#27272a] transition-colors flex items-center gap-0.5 text-[10px]"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                    <button
                      data-testid="network-clear-rung"
                      onClick={(e) => {
                        e.stopPropagation()
                        clearNetwork(netIdx)
                      }}
                      title="Clear Rung Nodes"
                      className="h-5 px-1 text-amber-400 hover:text-white hover:bg-[#27272a] transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                    <button
                      data-testid="network-delete-button"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteNetwork(netIdx)
                      }}
                      title="Delete Network (Shift+Del)"
                      className="h-5 px-1.5 text-red-400 hover:text-white hover:bg-red-950 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* SVG Ladder Canvas Scroll Container with Dynamic Width & Sizing */}
                <div
                  data-testid="ladder-scroll-container"
                  className="p-2 bg-[#090a0d] overflow-x-auto overflow-y-visible flex items-center custom-ladder-scroll"
                  style={{ overflowX: 'auto', overflowY: 'visible' }}
                >
                  <svg
                    data-testid="ladder-network-svg"
                    width={Math.round(svgWidth * canvasZoom)}
                    height={Math.round(netSvgHeight * canvasZoom)}
                    viewBox={`0 0 ${svgWidth} ${netSvgHeight}`}
                    style={{
                      minWidth: `${Math.round(svgWidth * canvasZoom)}px`,
                      height: `${Math.round(netSvgHeight * canvasZoom)}px`
                    }}
                    className="overflow-visible"
                    onDragOver={(e) => handleSvgDragOver(e, netIdx)}
                    onDragLeave={(e) => handleSvgDragLeave(e, netIdx)}
                    onDrop={(e) => handleSvgDrop(e, netIdx)}
                  >
                    <defs>
                      <filter id="emeraldGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="3.5" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                      <filter id="amberGlow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="3" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                      <filter id="crimsonGlow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                    </defs>

                    {/* Rung Logic or Empty Wire Drop-zone */}
                    {nodes.length === 0 ? (
                      <g className="select-none">
                        {/* Clean horizontal wire */}
                        <line
                          x1="30"
                          y1={WIRE_Y}
                          x2={rightRailX}
                          y2={WIRE_Y}
                          stroke="#334155"
                          strokeWidth="2"
                        />
                        {/* Right terminal bar -| */}
                        <line
                          data-testid="rung-terminal-bar"
                          x1={rightRailX}
                          y1={WIRE_Y - 14}
                          x2={rightRailX}
                          y2={WIRE_Y + 14}
                          stroke="#475569"
                          strokeWidth="3"
                        />
                        {/* Centered subtle drop hint text */}
                        <text
                          x={Math.round(svgWidth / 2)}
                          y={WIRE_Y - 19}
                          fill="#64748b"
                          fontSize="11"
                          fontWeight="bold"
                          textAnchor="middle"
                          fontFamily="monospace"
                          className="select-none pointer-events-none"
                        >
                          Drag instruction here or double-click to insert
                        </text>
                        {/* Green drop target square (ONLY during instruction drag and not monitoring) */}
                        {isDraggingInstruction && !isMonitoringActive && (
                          <g
                            data-testid="rung-dropzone-green"
                            className="cursor-pointer"
                            onDragOver={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              e.dataTransfer.dropEffect = 'copy'
                              setHoveredDropZone({ netIdx, insertIndex: 0 })
                            }}
                            onDragLeave={(e) => {
                              e.stopPropagation()
                              setHoveredDropZone(null)
                            }}
                            onDrop={(e) => handleDropOnZone(e, { netIdx, insertIndex: 0 })}
                            onClick={() => insertContact('NO_CONTACT')}
                            onDoubleClick={() => insertContact('NO_CONTACT')}
                          >
                            <rect
                              x={isEmptyHovered ? Math.round(svgWidth / 2) - 8 : Math.round(svgWidth / 2) - 5}
                              y={isEmptyHovered ? WIRE_Y - 8 : WIRE_Y - 5}
                              width={isEmptyHovered ? 16 : 10}
                              height={isEmptyHovered ? 16 : 10}
                              fill="#10b981"
                              stroke="#34d399"
                              strokeWidth={isEmptyHovered ? 2 : 1}
                              filter={isEmptyHovered ? 'url(#emeraldGlow)' : undefined}
                              opacity={isEmptyHovered ? 1 : 0.95}
                              className="transition-all"
                            >
                              <title>Drag instruction here or double-click to insert</title>
                            </rect>
                          </g>
                        )}
                      </g>
                    ) : (
                      renderNodes(
                        nodes,
                        30,
                        WIRE_Y,
                        netIdx,
                        isMonitoringActive,
                        powerStates,
                        conflictingOperands,
                        selectedNodeId,
                        onSelectNode,
                        (operand, id, e) => {
                          const rect = (e.target as Element).getBoundingClientRect()
                          setEditingNode({
                            netIdx,
                            nodeId: id,
                            currentOperand: operand,
                            pos: { x: rect.left, y: rect.bottom + 4 }
                          })
                        },
                        (operand, id, address, e) => {
                          const rect = (e.currentTarget as Element).getBoundingClientRect()
                          setEditingAddressNode({
                            netIdx,
                            nodeId: id,
                            currentOperand: operand,
                            currentAddress: address,
                            pos: { x: rect.left, y: rect.bottom + 4 }
                          })
                          setAddressInputValue(address.includes('?') ? '' : address)
                          setAddressError(null)
                        },
                        deleteNode,
                        (branchId, branchIndex) => {
                          setSelectedBranchTarget({ branchId, branchIndex })
                        },
                        selectedBranchTarget,
                        blockingNodeId,
                        allTags,
                        isDraggingInstruction,
                        hoveredDropZone,
                        setHoveredDropZone,
                        handleDropOnZone,
                        setIsDraggingInstruction,
                        addBranchTier,
                        deleteBranchLeg,
                        undefined,
                        { svgWidth, coilX, rightRailX },
                        (netIndex, nodeId, propType, currentVal, e) => {
                          const rect = (e.currentTarget as Element).getBoundingClientRect()
                          setEditingTimerProp({
                            netIdx: netIndex,
                            nodeId,
                            propType,
                            currentVal,
                            pos: { x: rect.left, y: rect.bottom + 4 }
                          })
                          setTimerPropInputValue(currentVal)
                        },
                        updateContactType,
                        wrapNodeInBranch,
                        updateCoilType
                      )
                    )}

                    {/* Magnetic Wire Snap Preview (ONLY during instruction drag and not monitoring) */}
                    {isDraggingInstruction && !isMonitoringActive && magneticSnapPos && magneticSnapPos.netIdx === netIdx && (
                      <g data-testid="magnetic-snap-preview" pointerEvents="none">
                        <circle
                          cx={magneticSnapPos.x}
                          cy={magneticSnapPos.y}
                          r="14"
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2"
                          filter="url(#emeraldGlow)"
                          strokeDasharray="3 2"
                        >
                          <animate attributeName="r" values="10;18;10" dur="1s" repeatCount="indefinite" />
                          <animate attributeName="stroke-opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite" />
                        </circle>
                        <circle
                          cx={magneticSnapPos.x}
                          cy={magneticSnapPos.y}
                          r="5"
                          fill="#34d399"
                        />
                      </g>
                    )}
                    {/* Left Power Rail, on top of the wires that leave it */}
                    <line
                      data-testid="ladder-power-rail"
                      x1={POWER_RAIL_X}
                      y1="0"
                      x2={POWER_RAIL_X}
                      y2={netSvgHeight}
                      stroke={isMonitoringActive ? '#10b981' : '#38bdf8'}
                      strokeWidth="5"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Autocomplete Combobox Popover (Symbolic Name) */}
      {editingNode && (
        <TagAutocompleteCombobox
          currentValue={editingNode.currentOperand}
          blockInterface={block.interface}
          position={editingNode.pos}
          onSelect={handleOperandChange}
          onClose={() => setEditingNode(null)}
        />
      )}

      {/* Direct In-Place Bit Address Input Popover (Physical Address) */}
      {editingAddressNode && (
        <div
          style={{
            position: 'fixed',
            left: editingAddressNode.pos.x,
            top: editingAddressNode.pos.y,
            zIndex: 60
          }}
          className="bg-[#111317] border border-[#00a3a6] p-1.5 shadow-2xl flex flex-col gap-1 min-w-[150px] rounded-none select-none"
        >
          <div className="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">
            Direct S7 Bit Address
          </div>
          <input
            data-testid="inline-bit-address-input"
            type="text"
            autoFocus
            value={addressInputValue}
            onChange={(e) => {
              setAddressInputValue(e.target.value)
              setAddressError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const val = (e.target as HTMLInputElement).value || addressInputValue
                handleBitAddressSubmit(val)
              } else if (e.key === 'Escape') {
                setEditingAddressNode(null)
              }
            }}
            onBlur={(e) => {
              const val = (e.target as HTMLInputElement).value || addressInputValue
              if (val.trim()) {
                handleBitAddressSubmit(val)
              } else {
                setEditingAddressNode(null)
              }
            }}
            placeholder="%Q0.5 or q0.5"
            className="h-6 px-1.5 py-0.5 bg-[#09090b] text-[#38bdf8] border border-[#38bdf8] font-mono text-xs rounded-none outline-none focus:ring-1 focus:ring-[#38bdf8]"
          />
          {addressError && (
            <div className="text-[10px] text-red-400 font-mono">
              {addressError}
            </div>
          )}
          <div className="text-[9px] font-mono text-industrial-500">
            Auto-normalizes e.g. q0.5, i0.1, e0.0, a0.5
          </div>
        </div>
      )}

      {/* Direct In-Place Timer / Counter Instance & Preset Input Popover */}
      {editingTimerProp && (
        <div
          style={{
            position: 'fixed',
            left: editingTimerProp.pos.x,
            top: editingTimerProp.pos.y,
            zIndex: 60
          }}
          className="bg-[#111317] border border-[#00a3a6] p-1.5 shadow-2xl flex flex-col gap-1 min-w-[150px] rounded-none select-none"
        >
          <div className="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">
            {editingTimerProp.propType === 'instance' ? 'Instance Name (e.g. T1, C1)' : 'Preset Value (e.g. T#10s, 5)'}
          </div>
          <input
            data-testid="inline-timer-prop-input"
            type="text"
            autoFocus
            value={timerPropInputValue}
            onChange={(e) => setTimerPropInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const val = (e.target as HTMLInputElement).value || timerPropInputValue
                handleTimerPropSubmit(val)
              } else if (e.key === 'Escape') {
                setEditingTimerProp(null)
              }
            }}
            onBlur={(e) => {
              const val = (e.target as HTMLInputElement).value || timerPropInputValue
              if (val.trim()) {
                handleTimerPropSubmit(val)
              } else {
                setEditingTimerProp(null)
              }
            }}
            placeholder={editingTimerProp.propType === 'instance' ? 'T1' : 'T#10s'}
            className="h-6 px-1.5 py-0.5 bg-[#09090b] text-[#38bdf8] border border-[#38bdf8] font-mono text-xs rounded-none outline-none focus:ring-1 focus:ring-[#38bdf8]"
          />
          <div className="text-[9px] font-mono text-industrial-500">
            {editingTimerProp.propType === 'instance' ? 'Unique S7 Timer/Counter DB Instance' : 'Time or count preset (T#10s, 10)'}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Recursive SVG Node Renderer
 */
function renderNodes(
  nodes: LadderNode[],
  startX: number,
  y: number,
  netIdx: number,
  isMonitoring: boolean,
  powerStates: Record<
    string,
    {
      powered: boolean
      rloIn?: boolean
      isConducting?: boolean
      bitValue?: boolean
      liveValues?: Record<string, string | number>
    }
  >,
  conflictingOperands: Set<string>,
  selectedNodeId: string | null,
  onSelectNode: (id: string) => void,
  onOpenEdit: (operand: string, id: string, e: React.MouseEvent) => void,
  onOpenBitEdit: (operand: string, id: string, address: string, e: React.MouseEvent) => void,
  onDeleteNode: (id: string) => void,
  onSelectBranchTarget?: (branchId: string, branchIndex: number) => void,
  selectedBranchTarget?: { branchId: string; branchIndex: number } | null,
  blockingNodeId?: string | null,
  allTags: Array<{ id: string; name: string; address: string; dataType: string }> = [],
  isDraggingInstruction: boolean = false,
  hoveredDropZone: DropZoneTarget | null = null,
  setHoveredDropZone?: (target: DropZoneTarget | null) => void,
  handleDropOnZone?: (e: React.DragEvent, target: DropZoneTarget) => void,
  setIsDraggingInstruction?: (dragging: boolean) => void,
  onAddBranchTier?: (branchId: string) => void,
  onDeleteBranchLeg?: (branchId: string, branchIndex: number) => void,
  branchContext?: { branchId: string; branchIndex: number; incomingRlo?: boolean },
  layoutMetrics?: { svgWidth: number; coilX: number; rightRailX: number },
  onOpenTimerProp?: (netIdx: number, nodeId: string, propType: 'instance' | 'preset', currentVal: string, e: React.MouseEvent) => void,
  onUpdateContactType?: (nodeId: string, newType: ContactType) => void,
  onWrapNodeInBranch?: (nodeId: string) => void,
  onUpdateCoilType?: (nodeId: string, newType: CoilType) => void
): React.ReactNode {
  let curX = startX
  let currentRlo = branchContext?.incomingRlo !== undefined ? branchContext.incomingRlo : true
  const elements: React.ReactNode[] = []
  const rightRailX = layoutMetrics?.rightRailX || 1050
  const targetCoilX = layoutMetrics?.coilX || 950

  const formatOperand = (op: string) => {
    if (!op) return ''
    return op.length > 19 ? op.slice(0, 18) + '…' : op
  }

  // Resolve symbolic name and physical address for any operand
  const resolveTag = (operand: string) => {
    if (!operand || operand === '???') {
      return { symbol: '???', address: '%??.?', isUnassigned: true }
    }
    const cleanOp = operand.trim()

    // Native IEC Timer & Counter Sub-Bit Resolution (T1.Q, T1.IN, T1.ET, C1.QU, C1.CV)
    const upperOp = cleanOp.toUpperCase()
    if (/^[A-Za-z0-9_]+\.(Q|IN|ET|PT)$/i.test(upperOp) || /^T\d+$/i.test(upperOp)) {
      const formatted = upperOp.includes('.') ? upperOp : `${upperOp}.Q`
      return { symbol: formatted, address: formatted, isUnassigned: false, isTimerBit: true }
    }
    if (/^[A-Za-z0-9_]+\.(QU|QD|CV|PV|CU|CD|R|LD)$/i.test(upperOp) || /^C\d+$/i.test(upperOp)) {
      const formatted = upperOp.includes('.') ? upperOp : `${upperOp}.QU`
      return { symbol: formatted, address: formatted, isUnassigned: false, isCounterBit: true }
    }

    const liveTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
    const combinedTags = liveTags.length > 0 ? liveTags : allTags
    const byName = combinedTags.find((t) => t.name.toLowerCase() === cleanOp.toLowerCase())
    if (byName) {
      return { symbol: byName.name, address: byName.address, isUnassigned: false }
    }
    const byAddress = combinedTags.find((t) => t.address.toUpperCase() === cleanOp.toUpperCase())
    if (byAddress) {
      return { symbol: byAddress.name, address: byAddress.address, isUnassigned: false }
    }
    if (cleanOp.startsWith('%')) {
      return { symbol: '???', address: cleanOp, isUnassigned: false }
    }
    return { symbol: cleanOp, address: '%??.?', isUnassigned: false }
  }

  // Helper to render interactive green drop-target squares along the wire
  const renderDropTargetSquare = (
    x: number,
    yCoord: number,
    target: DropZoneTarget,
    key: string
  ) => {
    const isHovered =
      hoveredDropZone &&
      hoveredDropZone.netIdx === target.netIdx &&
      hoveredDropZone.branchId === target.branchId &&
      hoveredDropZone.branchIndex === target.branchIndex &&
      hoveredDropZone.insertIndex === target.insertIndex

    if (isMonitoring || !isDraggingInstruction) {
      return null
    }

    return (
      <g
        key={key}
        data-testid="ladder-drop-target"
        className="cursor-pointer"
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
          setHoveredDropZone?.(target)
        }}
        onDragLeave={(e) => {
          e.stopPropagation()
          setHoveredDropZone?.(null)
        }}
        onDrop={(e) => handleDropOnZone?.(e, target)}
        onClick={(e) => {
          e.stopPropagation()
          // Click can also select insertion target
          onSelectNode('')
        }}
      >
        <rect
          x={isHovered ? x - 8 : x - 5}
          y={isHovered ? yCoord - 8 : yCoord - 5}
          width={isHovered ? 16 : 10}
          height={isHovered ? 16 : 10}
          fill="#10b981"
          stroke="#34d399"
          strokeWidth={isHovered ? 2 : 1}
          filter={isHovered ? 'url(#emeraldGlow)' : undefined}
          opacity={isHovered ? 1 : isDraggingInstruction ? 0.9 : 0.35}
          className="transition-all"
        >
          <title>Insert instruction here</title>
        </rect>
      </g>
    )
  }

  // 1. Initial Drop Zone before first node if this is the start of a network or branch
  const firstDropTarget: DropZoneTarget = {
    netIdx,
    branchId: branchContext?.branchId,
    branchIndex: branchContext?.branchIndex,
    insertIndex: 0
  }
  elements.push(
    renderDropTargetSquare(curX + 10, y, firstDropTarget, `drop_before_first_${curX}_${y}`)
  )

  nodes.forEach((node, idx) => {
    const isSelected = selectedNodeId === node.id
    const state = powerStates[node.id]
    const isPowered = isMonitoring && !!state?.powered

    if (node.kind === 'contact') {
      const c = node as LadderContactNode
      const width = 175
      const midX = curX + width / 2
      const tagInfo = resolveTag(c.operand)
      const isUnassigned = tagInfo.isUnassigned || tagInfo.symbol === '???'

      const bitVal =
        state?.bitValue !== undefined
          ? state.bitValue
          : state?.liveValues?.val === 'TRUE'
      const isConducting =
        state?.isConducting !== undefined
          ? state.isConducting
          : c.contactType === 'NC_CONTACT'
          ? !bitVal
          : bitVal
      const incomingRlo = isMonitoring ? (state?.rloIn !== undefined ? state.rloIn : currentRlo) : false
      const outgoingRlo = isMonitoring ? (state?.powered !== undefined ? state.powered : incomingRlo && isConducting) : false
      currentRlo = outgoingRlo

      let contactColor = isSelected ? '#38bdf8' : '#cbd5e1'
      if (isMonitoring) {
        if (c.contactType === 'NC_CONTACT' && bitVal) {
          contactColor = '#ef4444' // NC contact OPEN because bit is 1 (BLOCKING)
        } else if (isConducting && incomingRlo) {
          contactColor = '#10b981'
        } else if (isConducting && !incomingRlo) {
          contactColor = '#94a3b8' // Closed but no power arriving
        } else {
          contactColor = '#64748b' // Open contact
        }
      }

      elements.push(
        <g
          key={c.id}
          data-node-kind="contact"
          data-testid="ladder-contact-node"
          className="cursor-pointer group select-none"
          {...({ draggable: true } as any)}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              'application/plc-reorder-node',
              JSON.stringify({ nodeId: c.id, netIdx })
            )
            e.dataTransfer.effectAllowed = 'move'
            setIsDraggingInstruction?.(true)
          }}
          onDragEnd={() => {
            setIsDraggingInstruction?.(false)
            setHoveredDropZone?.(null)
          }}
          onClick={(e) => {
            e.stopPropagation()
            onSelectNode(c.id)
          }}
        >
          {/* Transparent Hit Box for Industrial Click & Drag Snapping */}
          <rect
            x={midX - 25}
            y={y - 25}
            width={50}
            height={50}
            fill="transparent"
            pointerEvents="all"
          />
          {/* Wire lead in */}
          <line
            x1={curX}
            y1={y}
            x2={midX - 16}
            y2={y}
            stroke={incomingRlo ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />

          {/* Contact vertical bars */}
          <line
            x1={midX - 16}
            y1={y - 20}
            x2={midX - 16}
            y2={y + 20}
            stroke={contactColor}
            strokeWidth="3.5"
          />
          <line
            x1={midX + 16}
            y1={y - 20}
            x2={midX + 16}
            y2={y + 20}
            stroke={contactColor}
            strokeWidth="3.5"
          />

          {/* NC slash */}
          {c.contactType === 'NC_CONTACT' && (
            <line
              x1={midX - 18}
              y1={y + 22}
              x2={midX + 18}
              y2={y - 22}
              stroke={contactColor}
              strokeWidth="2.5"
            />
          )}

          {/* P / N indicator */}
          {(c.contactType === 'P_TRIG' || c.contactType === 'N_TRIG') && (
            <text
              x={midX}
              y={y + 5}
              fill={isPowered ? '#10b981' : '#38bdf8'}
              fontSize="12"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
            >
              {c.contactType === 'P_TRIG' ? 'P' : 'N'}
            </text>
          )}

          {/* Wire lead out */}
          <line
            x1={midX + 16}
            y1={y}
            x2={curX + width}
            y2={y}
            stroke={outgoingRlo ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />

          {/* DUAL-ROW LABELS (Top: Symbolic Name in quotes / Bottom: Physical Address) */}
          {/* Top Row: Symbolic Name */}
          <g
            className="ladder-operand-badge cursor-pointer"
            data-ladder-node-id={c.id}
            data-ladder-operand={c.operand}
            data-ladder-node-kind="contact"
            onClick={(e) => {
              e.stopPropagation()
              onOpenEdit(c.operand, c.id, e)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onOpenEdit(c.operand, c.id, e)
            }}
          >
            <title>{c.operand}</title>
            <rect
              className="ladder-badge-rect"
              x={midX - 65}
              y={y - 57}
              width={130}
              height={18}
              fill="#0f172a"
              stroke={isSelected ? '#38bdf8' : '#334155'}
              strokeWidth="1"
            />
            <text
              className="ladder-badge-text hover:fill-cyan-300 transition-colors"
              x={midX}
              y={y - 44}
              fill={isUnassigned ? '#f59e0b' : '#e2e8f0'}
              fontSize="10"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
            >
              {isUnassigned ? '"???"' : `"${formatOperand(tagInfo.symbol)}"`}
            </text>
          </g>

          {/* Bottom Row: Direct In-Place S7 Bit Address */}
          <g
            data-testid="contact-bottom-address"
            data-node-id={c.id}
            data-address={tagInfo.address}
            className="cursor-pointer group/addr"
            onClick={(e) => {
              e.stopPropagation()
              onOpenBitEdit(c.operand, c.id, tagInfo.address, e)
            }}
          >
            <rect
              x={midX - 45}
              y={y - 38}
              width={90}
              height={16}
              fill="#0b0f17"
              stroke="#1e293b"
              strokeWidth="1"
              className="group-hover/addr:stroke-[#38bdf8] transition-colors"
            />
            <text
              x={midX}
              y={y - 26}
              fill={tagInfo.address.includes('?') ? '#f59e0b' : '#38bdf8'}
              fontSize="9.5"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
              className="group-hover/addr:fill-cyan-200 transition-colors"
            >
              {tagInfo.address}
            </text>
          </g>

          {/* Blocking Contact Diagnostic Highlight */}
          {blockingNodeId === c.id && (
            <g data-testid="blocking-contact-highlight">
              <rect
                x={midX - 28}
                y={y - 40}
                width={56}
                height={80}
                fill="rgba(244, 63, 94, 0.15)"
                stroke="#f43f5e"
                strokeWidth="2.5"
                strokeDasharray="4 2"
              >
                <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite" />
              </rect>
            </g>
          )}

          {/* Clean 1px Technical Selection Frame (Zero Circular Icons) */}
          {isSelected && (
            <g data-testid="contact-selection-container">
              <rect
                x={midX - 67}
                y={y - 59}
                width={134}
                height={82}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />

              {/* TIA Portal v19 Floating Selection Toolbar: [NO] [NC] [|P|] [|N|] | [+Branch] [Del] */}
              <g
                data-testid="contact-selection-toolbar"
                className="select-none cursor-pointer"
                transform={`translate(${Math.max(TOOLBAR_MIN_X, midX - 100)}, ${y - 84})`}
              >
                <rect
                  x="0"
                  y="0"
                  width="200"
                  height="22"
                  fill="#0b0f17"
                  stroke="#38bdf8"
                  strokeWidth="1"
                />
                {/* [NO] */}
                <g
                  data-testid="btn-toolbar-no"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateContactType?.(c.id, 'NO_CONTACT')
                  }}
                >
                  <rect
                    x="2"
                    y="2"
                    width="24"
                    height="18"
                    fill={c.contactType === 'NO_CONTACT' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="14"
                    y="14"
                    fill={c.contactType === 'NO_CONTACT' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    NO
                  </text>
                  <title>Convert to Normally Open Contact</title>
                </g>
                {/* [NC] */}
                <g
                  data-testid="btn-toolbar-nc"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateContactType?.(c.id, 'NC_CONTACT')
                  }}
                >
                  <rect
                    x="28"
                    y="2"
                    width="24"
                    height="18"
                    fill={c.contactType === 'NC_CONTACT' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="40"
                    y="14"
                    fill={c.contactType === 'NC_CONTACT' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    NC
                  </text>
                  <title>Convert to Normally Closed Contact</title>
                </g>
                {/* [|P|] */}
                <g
                  data-testid="btn-toolbar-ptrig"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateContactType?.(c.id, 'P_TRIG')
                  }}
                >
                  <rect
                    x="54"
                    y="2"
                    width="24"
                    height="18"
                    fill={c.contactType === 'P_TRIG' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="66"
                    y="14"
                    fill={c.contactType === 'P_TRIG' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    |P|
                  </text>
                  <title>Convert to Positive Edge Contact (P_TRIG)</title>
                </g>
                {/* [|N|] */}
                <g
                  data-testid="btn-toolbar-ntrig"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateContactType?.(c.id, 'N_TRIG')
                  }}
                >
                  <rect
                    x="80"
                    y="2"
                    width="24"
                    height="18"
                    fill={c.contactType === 'N_TRIG' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="92"
                    y="14"
                    fill={c.contactType === 'N_TRIG' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    |N|
                  </text>
                  <title>Convert to Negative Edge Contact (N_TRIG)</title>
                </g>
                {/* Divider */}
                <line x1="108" y1="3" x2="108" y2="19" stroke="#334155" strokeWidth="1" />
                {/* [+ Branch] */}
                <g
                  data-testid="btn-toolbar-wrap-branch"
                  onClick={(e) => {
                    e.stopPropagation()
                    onWrapNodeInBranch?.(c.id)
                  }}
                >
                  <rect x="112" y="2" width="46" height="18" fill="#1e293b" />
                  <text
                    x="135"
                    y="14"
                    fill="#38bdf8"
                    fontSize="8.5"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    +Branch
                  </text>
                  <title>Wrap into Parallel Branch</title>
                </g>
                {/* [Delete] */}
                <g
                  data-testid="btn-toolbar-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteNode(c.id)
                  }}
                >
                  <rect x="160" y="2" width="38" height="18" fill="#450a0a" />
                  <text
                    x="179"
                    y="14"
                    fill="#f87171"
                    fontSize="8.5"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    Del
                  </text>
                  <title>Delete Element (Del)</title>
                </g>
              </g>
            </g>
          )}

          {/* Live value / Status badge if online */}
          {isMonitoring && (
            <g data-testid={`contact-status-${c.id}`}>
              {c.contactType === 'NC_CONTACT' ? (
                bitVal ? (
                  <g data-testid="contact-blocking-badge">
                    <rect
                      x={midX - 64}
                      y={y + 24}
                      width={128}
                      height={16}
                      fill="#450a0a"
                      stroke="#ef4444"
                      strokeWidth="1"
                    />
                    <text
                      x={midX}
                      y={y + 36}
                      fill="#f87171"
                      fontSize="9"
                      fontWeight="bold"
                      textAnchor="middle"
                      fontFamily="monospace"
                    >
                      1 (OPEN — BLOCKING)
                    </text>
                  </g>
                ) : (
                  <g data-testid="contact-closed-badge">
                    <rect
                      x={midX - 42}
                      y={y + 24}
                      width={84}
                      height={16}
                      fill="#064e3b"
                      stroke="#10b981"
                      strokeWidth="1"
                    />
                    <text
                      x={midX}
                      y={y + 36}
                      fill="#34d399"
                      fontSize="9"
                      fontWeight="bold"
                      textAnchor="middle"
                      fontFamily="monospace"
                    >
                      0 (CLOSED)
                    </text>
                  </g>
                )
              ) : bitVal ? (
                <g data-testid="contact-closed-badge">
                  <rect
                    x={midX - 42}
                    y={y + 24}
                    width={84}
                    height={16}
                    fill="#064e3b"
                    stroke="#10b981"
                    strokeWidth="1"
                  />
                  <text
                    x={midX}
                    y={y + 36}
                    fill="#34d399"
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    1 (CLOSED)
                  </text>
                </g>
              ) : (
                <g data-testid="contact-open-badge">
                  <rect
                    x={midX - 35}
                    y={y + 24}
                    width={70}
                    height={16}
                    fill="#0f172a"
                    stroke="#475569"
                    strokeWidth="1"
                  />
                  <text
                    x={midX}
                    y={y + 36}
                    fill="#94a3b8"
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    0 (OPEN)
                  </text>
                </g>
              )}
            </g>
          )}
        </g>
      )
      curX += width

      // Render drop target after this contact
      const afterDropTarget: DropZoneTarget = {
        netIdx,
        branchId: branchContext?.branchId,
        branchIndex: branchContext?.branchIndex,
        insertIndex: idx + 1
      }
      elements.push(
        renderDropTargetSquare(curX - 10, y, afterDropTarget, `drop_after_contact_${idx}_${c.id}`)
      )
    } else if (node.kind === 'parallel') {
      const p = node as LadderParallelBranchNode
      const dropY = 120
      const branchWidth = getNodeWidth(p)
      const lastBranchY = y + (p.branches.length - 1) * dropY
      const startsAtRail = curX <= POWER_RAIL_X
      const incomingRlo = isMonitoring ? (state?.rloIn !== undefined ? state.rloIn : currentRlo) : false
      const isBranchPowered = isMonitoring && !!state?.powered
      currentRlo = isMonitoring ? isBranchPowered : false

      elements.push(
        <g key={p.id}>
          {/* Vertical drop line on left connecting all tiers. At the power rail the rail itself does this */}
          {!startsAtRail && (
            <line
              data-testid="branch-fork-line"
              x1={curX}
              y1={y}
              x2={curX}
              y2={lastBranchY}
              stroke={incomingRlo ? '#10b981' : '#475569'}
              strokeWidth="2.5"
            />
          )}

          {/* Render all branch tiers */}
          {p.branches.map((bNodes, bIdx) => {
            const branchY = y + bIdx * dropY
            const bNodesWidth = (bNodes || []).reduce((sum, n) => sum + getNodeWidth(n), 0)
            const isBranchTargetSelected =
              selectedBranchTarget?.branchId === p.id && selectedBranchTarget?.branchIndex === bIdx

            return (
              <g key={`branch_${p.id}_${bIdx}`}>
                {/* Horizontal wire lead in */}
                <line
                  x1={curX}
                  y1={branchY}
                  x2={curX + 20}
                  y2={branchY}
                  stroke={incomingRlo ? '#10b981' : '#475569'}
                  strokeWidth="2.5"
                />

                {/* Nodes or clickable drop-zone */}
                {!bNodes || bNodes.length === 0 ? (
                  <g
                    data-testid={`branch-dropzone-${bIdx === 0 ? 'top' : bIdx === 1 ? 'bottom' : bIdx}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectBranchTarget?.(p.id, bIdx)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      e.dataTransfer.dropEffect = 'copy'
                      setHoveredDropZone?.({ netIdx, branchId: p.id, branchIndex: bIdx, insertIndex: 0 })
                    }}
                    onDragLeave={(e) => {
                      e.stopPropagation()
                      setHoveredDropZone?.(null)
                    }}
                    onDrop={(e) => handleDropOnZone?.(e, { netIdx, branchId: p.id, branchIndex: bIdx, insertIndex: 0 })}
                    className="cursor-pointer"
                  >
                    <rect
                      x={curX + 20}
                      y={branchY - 12}
                      width={120}
                      height={24}
                      fill="#14161b"
                      stroke={isBranchTargetSelected ? '#38bdf8' : '#0284c7'}
                      strokeDasharray="4 2"
                      strokeWidth="1.5"
                    />
                    <text
                      x={curX + 80}
                      y={branchY + 4}
                      fill={isBranchTargetSelected ? '#38bdf8' : '#0284c7'}
                      fontSize="10"
                      fontWeight="bold"
                      textAnchor="middle"
                      fontFamily="monospace"
                    >
                      + Add Contact
                    </text>
                    {/* Delete leg button (Heals circuit) */}
                    <g
                      data-testid={`branch-delete-leg-${bIdx}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteBranchLeg?.(p.id, bIdx)
                      }}
                      className="hover:opacity-100 opacity-60 transition-opacity"
                    >
                      <rect
                        x={curX + 145}
                        y={branchY - 8}
                        width={16}
                        height={16}
                        fill="#1e1e24"
                        stroke="#ef4444"
                        strokeWidth="1"
                      />
                      <text
                        x={curX + 153}
                        y={branchY + 4}
                        fill="#ef4444"
                        fontSize="11"
                        fontWeight="bold"
                        textAnchor="middle"
                        fontFamily="monospace"
                      >
                        x
                      </text>
                      <title>Delete Branch Tier (Heals Circuit)</title>
                    </g>
                  </g>
                ) : (
                  renderNodes(
                    bNodes,
                    curX + 20,
                    branchY,
                    netIdx,
                    isMonitoring,
                    powerStates,
                    conflictingOperands,
                    selectedNodeId,
                    onSelectNode,
                    onOpenEdit,
                    onOpenBitEdit,
                    onDeleteNode,
                    onSelectBranchTarget,
                    selectedBranchTarget,
                    blockingNodeId,
                    allTags,
                    isDraggingInstruction,
                    hoveredDropZone,
                    setHoveredDropZone,
                    handleDropOnZone,
                    setIsDraggingInstruction,
                    onAddBranchTier,
                    onDeleteBranchLeg,
                    { branchId: p.id, branchIndex: bIdx, incomingRlo },
                    layoutMetrics,
                    onOpenTimerProp,
                    onUpdateContactType,
                    onWrapNodeInBranch,
                    onUpdateCoilType
                  )
                )}

                {/* Wire from branch nodes to right merger */}
                <line
                  x1={curX + 20 + (!bNodes || bNodes.length === 0 ? 170 : bNodesWidth)}
                  y1={branchY}
                  x2={curX + branchWidth}
                  y2={branchY}
                  stroke={isBranchPowered ? '#10b981' : '#475569'}
                  strokeWidth="2.5"
                />
              </g>
            )
          })}

          {/* Right vertical merger rail */}
          <line
            x1={curX + branchWidth}
            y1={y}
            x2={curX + branchWidth}
            y2={lastBranchY}
            stroke={isBranchPowered ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />

          {/* Selection frame and Add Tier button */}
          {isSelected && (
            <g>
              <rect
                x={startsAtRail ? curX + 8 : curX - 4}
                y={y - 16}
                width={startsAtRail ? branchWidth - 4 : branchWidth + 8}
                height={(p.branches.length - 1) * dropY + 32}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />
              <g
                data-testid="branch-add-tier-button"
                className="cursor-pointer hover:opacity-100 opacity-80"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddBranchTier?.(p.id)
                }}
              >
                <rect
                  x={curX + branchWidth / 2 - 45}
                  y={lastBranchY + 14}
                  width="90"
                  height="18"
                  fill="#1e293b"
                  stroke="#38bdf8"
                  strokeWidth="1"
                />
                <text
                  x={curX + branchWidth / 2}
                  y={lastBranchY + 26}
                  fill="#38bdf8"
                  fontSize="9.5"
                  fontWeight="bold"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  + Add Tier
                </text>
                <title>Add parallel branch tier ($N \ge 3$)</title>
              </g>
            </g>
          )}
        </g>
      )
      curX += branchWidth

      // Drop target after branch
      const afterBranchTarget: DropZoneTarget = {
        netIdx,
        branchId: branchContext?.branchId,
        branchIndex: branchContext?.branchIndex,
        insertIndex: idx + 1
      }
      elements.push(
        renderDropTargetSquare(curX - 10, y, afterBranchTarget, `drop_after_branch_${idx}_${p.id}`)
      )
    } else if (node.kind === 'emptyBox') {
      const b = node as LadderEmptyBoxNode
      const boxWidth = 100
      const boxHeight = 50
      const boxX = curX + 15
      const boxY = y - boxHeight / 2

      elements.push(
        <g
          key={b.id}
          className="cursor-pointer select-none"
          {...({ draggable: true } as any)}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              'application/plc-reorder-node',
              JSON.stringify({ nodeId: b.id, netIdx })
            )
            e.dataTransfer.effectAllowed = 'move'
            setIsDraggingInstruction?.(true)
          }}
          onDragEnd={() => {
            setIsDraggingInstruction?.(false)
            setHoveredDropZone?.(null)
          }}
          onClick={(e) => {
            e.stopPropagation()
            onSelectNode(b.id)
          }}
        >
          {/* Wire lead in */}
          <line
            x1={curX}
            y1={y}
            x2={boxX}
            y2={y}
            stroke={isPowered ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />

          {/* Box Rect */}
          <rect
            x={boxX}
            y={boxY}
            width={boxWidth}
            height={boxHeight}
            fill="#111827"
            stroke={isSelected ? '#38bdf8' : '#f59e0b'}
            strokeWidth={isSelected ? '2' : '1.5'}
            strokeDasharray="4 2"
          />

          {/* Box Header */}
          <rect
            x={boxX}
            y={boxY}
            width={boxWidth}
            height="18"
            fill="#1f2937"
          />
          <text
            x={boxX + boxWidth / 2}
            y={boxY + 13}
            fill="#f59e0b"
            fontSize="10"
            fontWeight="bold"
            textAnchor="middle"
            fontFamily="monospace"
          >
            {b.instruction || '???'}
          </text>

          {/* Selection frame */}
          {isSelected && (
            <rect
              x={boxX - 4}
              y={boxY - 4}
              width={boxWidth + 8}
              height={boxHeight + 8}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
          )}

          {/* Wire lead out */}
          <line
            x1={boxX + boxWidth}
            y1={y}
            x2={curX + boxWidth + 30}
            y2={y}
            stroke={isPowered ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />
        </g>
      )
      curX += boxWidth + 30
      currentRlo = isMonitoring ? (state?.powered !== undefined ? state.powered : false) : false

      // Drop target after box
      const afterBoxTarget: DropZoneTarget = {
        netIdx,
        branchId: branchContext?.branchId,
        branchIndex: branchContext?.branchIndex,
        insertIndex: idx + 1
      }
      elements.push(
        renderDropTargetSquare(curX - 10, y, afterBoxTarget, `drop_after_box_${idx}_${b.id}`)
      )
    } else if (node.kind === 'timer' || node.kind === 'counter' || node.kind === 'comparator' || node.kind === 'math') {
      const isCtud = node.kind === 'counter' && (node as LadderCounterNode).counterType === 'CTUD'
      const isCmp = node.kind === 'comparator'
      const boxWidth = isCtud ? 165 : isCmp ? 145 : 150
      const boxHeight = isCtud ? 90 : isCmp ? 64 : 74
      const boxX = curX + 15
      const boxY = y - boxHeight / 2
      const title =
        node.kind === 'timer'
          ? (node as LadderTimerNode).timerType
          : node.kind === 'counter'
          ? (node as LadderCounterNode).counterType
          : node.kind === 'comparator'
          ? (node as LadderComparatorNode).comparatorType
          : (node as LadderMathNode).boxType

      elements.push(
        <g
          key={node.id}
          className="cursor-pointer select-none"
          {...({ draggable: true } as any)}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              'application/plc-reorder-node',
              JSON.stringify({ nodeId: node.id, netIdx })
            )
            e.dataTransfer.effectAllowed = 'move'
            setIsDraggingInstruction?.(true)
          }}
          onDragEnd={() => {
            setIsDraggingInstruction?.(false)
            setHoveredDropZone?.(null)
          }}
          onClick={(e) => {
            e.stopPropagation()
            onSelectNode(node.id)
          }}
        >
          {/* Wire lead in */}
          <line
            x1={curX}
            y1={y}
            x2={boxX}
            y2={y}
            stroke={isPowered ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />

          {/* Main Box Rect */}
          <rect
            x={boxX}
            y={boxY}
            width={boxWidth}
            height={boxHeight}
            fill="#111827"
            stroke={isPowered ? '#10b981' : isSelected ? '#38bdf8' : '#374151'}
            strokeWidth={isSelected ? '2' : '1.5'}
          />

          {/* Instance Name Badge above header (T1, C1, etc.) */}
          {(node.kind === 'timer' || node.kind === 'counter') && (() => {
            const instName =
              node.kind === 'timer'
                ? (node as LadderTimerNode).instanceDb || 'T1'
                : (node as LadderCounterNode).instanceDb || 'C1'
            const testId = node.kind === 'timer' ? 'timer-instance-badge' : 'counter-instance-badge'
            return (
              <g
                data-testid={testId}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTimerProp?.(netIdx, node.id, 'instance', instName, e)
                }}
              >
                <rect
                  x={boxX + boxWidth / 2 - Math.max(56, instName.length * 6 + 10) / 2}
                  y={boxY - 15}
                  width={Math.max(56, instName.length * 6 + 10)}
                  height="14"
                  fill="#0f172a"
                  stroke="#38bdf8"
                  strokeWidth="1"
                />
                <text
                  x={boxX + boxWidth / 2}
                  y={boxY - 4}
                  fill="#38bdf8"
                  fontSize="9.5"
                  fontWeight="bold"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  {instName}
                </text>
              </g>
            )
          })()}

          {/* Box Header */}
          <rect
            x={boxX}
            y={boxY}
            width={boxWidth}
            height="18"
            fill="#1f2937"
          />
          <text
            x={boxX + boxWidth / 2}
            y={boxY + 13}
            fill="#38bdf8"
            fontSize="10"
            fontWeight="bold"
            textAnchor="middle"
            fontFamily="monospace"
          >
            {title}
          </text>

          {/* Box Detail / Live Info */}
          {node.kind === 'timer' && (
            <>
              <text x={boxX + 8} y={boxY + 34} fill="#94a3b8" fontSize="9" fontFamily="monospace">IN</text>
              <g
                data-testid="timer-pt-badge"
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTimerProp?.(netIdx, node.id, 'preset', (node as LadderTimerNode).ptOperand, e)
                }}
              >
                <text x={boxX + 8} y={boxY + 54} fill="#38bdf8" fontSize="9" fontFamily="monospace">
                  PT: {(node as LadderTimerNode).ptOperand}
                </text>
              </g>
              <text x={boxX + boxWidth - 14} y={boxY + 34} fill="#94a3b8" fontSize="9" textAnchor="end" fontFamily="monospace">Q</text>
              {isMonitoring && state?.liveValues && (
                <g data-testid="timer-et-container" className="pointer-events-none select-none">
                  <text
                    data-testid="timer-live-et"
                    x={boxX + boxWidth - 8}
                    y={boxY + 54}
                    fill="#10b981"
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="end"
                    fontFamily="monospace"
                    className="pointer-events-none select-none"
                  >
                    ET: {state.liveValues.ET || (state.liveValues.display ? String(state.liveValues.display).split('/')[0].trim() : '0ms')}
                  </text>
                  <rect
                    data-testid="timer-progress-bar"
                    x={boxX + 2}
                    y={boxY + boxHeight - 4}
                    width={Math.round((boxWidth - 4) * Math.min(1, Math.max(0, Number(state.liveValues.progress || 0) / 100)))}
                    height="3"
                    fill="#10b981"
                    className="transition-all duration-75 pointer-events-none"
                  />
                </g>
              )}
            </>
          )}

          {node.kind === 'counter' && (() => {
            const cnt = node as LadderCounterNode
            if (cnt.counterType === 'CTUD') {
              return (
                <g data-testid={`counter-ctud-${cnt.id}`}>
                  {/* Left pins: CU, CD, R, PV */}
                  <text x={boxX + 8} y={boxY + 33} fill="#94a3b8" fontSize="8.5" fontFamily="monospace">CU</text>
                  <text x={boxX + 8} y={boxY + 48} fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                    CD: {cnt.cdOperand || '??'}
                  </text>
                  <text x={boxX + 8} y={boxY + 63} fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                    R: {cnt.rLdOperand || '??'}
                  </text>
                  <g
                    data-testid="counter-pv-badge"
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenTimerProp?.(netIdx, node.id, 'preset', cnt.pvOperand, e)
                    }}
                  >
                    <text x={boxX + 8} y={boxY + 79} fill="#38bdf8" fontSize="8.5" fontFamily="monospace">
                      PV: {cnt.pvOperand}
                    </text>
                  </g>

                  {/* Right pins: QU, QD, CV */}
                  <text x={boxX + boxWidth - 8} y={boxY + 33} fill="#94a3b8" fontSize="8.5" textAnchor="end" fontFamily="monospace">QU</text>
                  <text x={boxX + boxWidth - 8} y={boxY + 48} fill="#94a3b8" fontSize="8.5" textAnchor="end" fontFamily="monospace">QD</text>
                  <text
                    data-testid="counter-live-cv"
                    x={boxX + boxWidth - 8}
                    y={boxY + 70}
                    fill={isMonitoring ? '#10b981' : '#38bdf8'}
                    fontSize="9.5"
                    fontWeight="bold"
                    textAnchor="end"
                    fontFamily="monospace"
                  >
                    CV: {state?.liveValues?.CV !== undefined ? state.liveValues.CV : '0'}
                  </text>
                </g>
              )
            }
            return (
              <>
                <text x={boxX + 8} y={boxY + 34} fill="#94a3b8" fontSize="9" fontFamily="monospace">
                  {cnt.counterType === 'CTD' ? 'CD' : 'CU'}
                </text>
                <g
                  data-testid="counter-pv-badge"
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenTimerProp?.(netIdx, node.id, 'preset', cnt.pvOperand, e)
                  }}
                >
                  <text x={boxX + 8} y={boxY + 54} fill="#38bdf8" fontSize="9" fontFamily="monospace">
                    PV: {cnt.pvOperand}
                  </text>
                </g>
                <text x={boxX + boxWidth - 14} y={boxY + 34} fill="#94a3b8" fontSize="9" textAnchor="end" fontFamily="monospace">
                  {cnt.counterType === 'CTD' ? 'QD' : 'QU'}
                </text>
                {state?.liveValues?.CV !== undefined && (
                  <text
                    data-testid="counter-live-cv"
                    x={boxX + boxWidth - 8}
                    y={boxY + 54}
                    fill="#10b981"
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="end"
                    fontFamily="monospace"
                  >
                    CV: {state.liveValues.CV}
                  </text>
                )}
              </>
            )
          })()}

          {node.kind === 'comparator' && (() => {
            const cmp = node as LadderComparatorNode
            const opSymbol =
              cmp.comparatorType === 'CMP_LT'
                ? '<'
                : cmp.comparatorType === 'CMP_GE'
                ? '>='
                : cmp.comparatorType === 'CMP_EQ'
                ? '=='
                : cmp.comparatorType === 'CMP_GT'
                ? '>'
                : cmp.comparatorType === 'CMP_LE'
                ? '<='
                : '<>'
            const isCompTrue = state?.liveValues?.result === 'TRUE' || isPowered
            return (
              <g data-testid={`comparator-${cmp.id}`}>
                <text x={boxX + 8} y={boxY + 34} fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                  IN1: {cmp.op1}
                </text>
                <text
                  x={boxX + boxWidth / 2}
                  y={boxY + 48}
                  fill="#38bdf8"
                  fontSize="11"
                  fontWeight="bold"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  [ {opSymbol} ]
                </text>
                <text x={boxX + boxWidth - 8} y={boxY + 34} fill="#94a3b8" fontSize="8.5" textAnchor="end" fontFamily="monospace">
                  IN2: {cmp.op2}
                </text>
                {isMonitoring && (
                  <text
                    x={boxX + boxWidth / 2}
                    y={boxY + 59}
                    fill={isCompTrue ? '#10b981' : '#64748b'}
                    fontSize="8"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    {isCompTrue ? 'TRUE' : 'FALSE'}
                  </text>
                )}
              </g>
            )
          })()}

          {node.kind === 'math' && (
            <>
              <text x={boxX + 8} y={boxY + 34} fill="#94a3b8" fontSize="9" fontFamily="monospace">IN</text>
              <text x={boxX + boxWidth - 24} y={boxY + 34} fill="#94a3b8" fontSize="9" fontFamily="monospace">OUT</text>
              {isMonitoring && state?.liveValues?.out !== undefined && (
                <text
                  x={boxX + boxWidth / 2}
                  y={boxY + 54}
                  fill="#10b981"
                  fontSize="10"
                  fontWeight="bold"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  {String(state.liveValues.out)}
                </text>
              )}
            </>
          )}

          {/* Selection frame */}
          {isSelected && (
            <rect
              x={boxX - 4}
              y={boxY - 4}
              width={boxWidth + 8}
              height={boxHeight + 8}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
          )}

          {/* Wire lead out */}
          {idx === nodes.length - 1 && !branchContext ? (
            <>
              <line
                x1={boxX + boxWidth}
                y1={y}
                x2={rightRailX}
                y2={y}
                stroke={isPowered ? '#10b981' : '#475569'}
                strokeWidth="2.5"
              />
              <line
                data-testid="rung-terminal-bar"
                x1={rightRailX}
                y1={y - 14}
                x2={rightRailX}
                y2={y + 14}
                stroke={isPowered ? '#10b981' : '#64748b'}
                strokeWidth="3"
              />
            </>
          ) : (
            <line
              x1={boxX + boxWidth}
              y1={y}
              x2={curX + boxWidth + 30}
              y2={y}
              stroke={isPowered ? '#10b981' : '#475569'}
              strokeWidth="2.5"
            />
          )}
        </g>
      )
      curX += boxWidth + 30
      currentRlo = isMonitoring ? (state?.powered !== undefined ? state.powered : false) : false

      // Drop target after box
      const afterBoxTarget: DropZoneTarget = {
        netIdx,
        branchId: branchContext?.branchId,
        branchIndex: branchContext?.branchIndex,
        insertIndex: idx + 1
      }
      elements.push(
        renderDropTargetSquare(curX - 10, y, afterBoxTarget, `drop_after_instr_${idx}_${node.id}`)
      )
    } else if (node.kind === 'coil') {
      const c = node as LadderCoilNode
      const isInsideBranch = !!branchContext
      const isLastNode = idx === nodes.length - 1
      const coilWidth = 175
      const midX = isInsideBranch
        ? curX + coilWidth / 2
        : isLastNode
        ? Math.max(curX + 60, targetCoilX)
        : curX + coilWidth / 2
      const coilX = midX - 20
      const isDoubleCoil = conflictingOperands.has(c.operand.toLowerCase())
      const tagInfo = resolveTag(c.operand)
      const isUnassigned = tagInfo.isUnassigned || tagInfo.symbol === '???'
      const incomingRlo = isMonitoring ? (state?.rloIn !== undefined ? state.rloIn : currentRlo) : false
      const isEnergized = isMonitoring && (state?.powered !== undefined ? state.powered : incomingRlo)

      // Render drop target right before the coil
      const beforeCoilTarget: DropZoneTarget = {
        netIdx,
        branchId: branchContext?.branchId,
        branchIndex: branchContext?.branchIndex,
        insertIndex: idx
      }
      elements.push(
        renderDropTargetSquare(coilX - 18, y, beforeCoilTarget, `drop_before_coil_${c.id}`)
      )

      // Wire lead into coil - Rung wire rendered outside coil group so coil bounding box represents the coil element
      elements.push(
        <line
          key={`wire_into_coil_${c.id}`}
          x1={curX}
          y1={y}
          x2={coilX + 12}
          y2={y}
          stroke={incomingRlo ? '#10b981' : '#475569'}
          strokeWidth="2.5"
        />
      )

      elements.push(
        <g
          key={c.id}
          data-node-kind="coil"
          data-testid="ladder-coil-node"
          className="cursor-pointer select-none"
          {...({ draggable: true } as any)}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              'application/plc-reorder-node',
              JSON.stringify({ nodeId: c.id, netIdx })
            )
            e.dataTransfer.effectAllowed = 'move'
            setIsDraggingInstruction?.(true)
          }}
          onDragEnd={() => {
            setIsDraggingInstruction?.(false)
            setHoveredDropZone?.(null)
          }}
          onClick={(e) => {
            e.stopPropagation()
            onSelectNode(c.id)
          }}
        >
          {/* Transparent Hit Box for Industrial Click & Drag Snapping */}
          <rect
            x={coilX - 10}
            y={y - 25}
            width={60}
            height={50}
            fill="transparent"
            pointerEvents="all"
          />
          {/* Authentic Inward Parenthesis Left: ( */}
          <path
            d={`M ${coilX + 12} ${y - 18} A 22 22 0 0 0 ${coilX + 12} ${y + 18}`}
            fill="none"
            stroke={isEnergized ? '#10b981' : isSelected ? '#38bdf8' : '#cbd5e1'}
            strokeWidth="3.5"
          />

          {/* Negated slash if negated coil */}
          {c.coilType === 'NEGATED_COIL' && (
            <line
              x1={coilX + 10}
              y1={y + 13}
              x2={coilX + 30}
              y2={y - 13}
              stroke={isEnergized ? '#10b981' : isSelected ? '#38bdf8' : '#cbd5e1'}
              strokeWidth="2.5"
            />
          )}

          {/* Center Coil Type character (S or R) */}
          {(c.coilType === 'SET_COIL' || c.coilType === 'RESET_COIL') && (
            <text
              x={midX}
              y={y + 5}
              fill={isEnergized ? '#10b981' : isSelected ? '#38bdf8' : '#cbd5e1'}
              fontSize="12"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
            >
              {c.coilType === 'SET_COIL' ? 'S' : 'R'}
            </text>
          )}

          {/* Authentic Inward Parenthesis Right: ) */}
          <path
            d={`M ${coilX + 28} ${y - 18} A 22 22 0 0 1 ${coilX + 28} ${y + 18}`}
            fill="none"
            stroke={isEnergized ? '#10b981' : isSelected ? '#38bdf8' : '#cbd5e1'}
            strokeWidth="3.5"
          />

          {/* Wire lead out from coil */}
          {isInsideBranch ? (
            <line
              x1={coilX + 36}
              y1={y}
              x2={curX + coilWidth}
              y2={y}
              stroke={isEnergized ? '#10b981' : '#475569'}
              strokeWidth="2.5"
            />
          ) : isLastNode ? (
            <>
              <line
                x1={coilX + 36}
                y1={y}
                x2={rightRailX}
                y2={y}
                stroke={isEnergized ? '#10b981' : '#475569'}
                strokeWidth="2.5"
              />
              <line
                data-testid="rung-terminal-bar"
                x1={rightRailX}
                y1={y - 14}
                x2={rightRailX}
                y2={y + 14}
                stroke={isEnergized ? '#10b981' : '#64748b'}
                strokeWidth="3"
              />
            </>
          ) : (
            <line
              x1={coilX + 36}
              y1={y}
              x2={curX + coilWidth}
              y2={y}
              stroke={isEnergized ? '#10b981' : '#475569'}
              strokeWidth="2.5"
            />
          )}

          {/* DUAL-ROW LABELS (Top: Symbolic Name in quotes / Bottom: Physical Address) */}
          {/* Top Row: Symbolic Name */}
          <g
            className="ladder-operand-badge cursor-pointer"
            data-ladder-node-id={c.id}
            data-ladder-operand={c.operand}
            data-ladder-node-kind="coil"
            onClick={(e) => {
              e.stopPropagation()
              onOpenEdit(c.operand, c.id, e)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onOpenEdit(c.operand, c.id, e)
            }}
          >
            <title>{c.operand}</title>
            <rect
              className="ladder-badge-rect"
              x={midX - 65}
              y={y - 57}
              width={130}
              height={18}
              fill="#0f172a"
              stroke={isSelected ? '#38bdf8' : isDoubleCoil ? '#f59e0b' : '#334155'}
              strokeWidth="1"
            />
            <text
              className="ladder-badge-text hover:fill-cyan-300 transition-colors"
              x={midX}
              y={y - 44}
              fill={isDoubleCoil ? '#f59e0b' : isUnassigned ? '#f59e0b' : '#e2e8f0'}
              fontSize="10"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
            >
              {isUnassigned ? '"???"' : `"${formatOperand(tagInfo.symbol)}"`}
            </text>
          </g>

          {/* Bottom Row: Direct In-Place S7 Bit Address */}
          <g
            data-testid="coil-bottom-address"
            data-node-id={c.id}
            data-address={tagInfo.address}
            className="cursor-pointer group/addr"
            onClick={(e) => {
              e.stopPropagation()
              onOpenBitEdit(c.operand, c.id, tagInfo.address, e)
            }}
          >
            <rect
              x={midX - 45}
              y={y - 38}
              width={90}
              height={16}
              fill="#0b0f17"
              stroke={isDoubleCoil ? '#f59e0b' : '#1e293b'}
              strokeWidth="1"
              className="group-hover/addr:stroke-[#38bdf8] transition-colors"
            />
            <text
              x={midX}
              y={y - 26}
              fill={isDoubleCoil ? '#f59e0b' : tagInfo.address.includes('?') ? '#f59e0b' : '#38bdf8'}
              fontSize="9.5"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
              className="group-hover/addr:fill-cyan-200 transition-colors"
            >
              {tagInfo.address}
            </text>
          </g>

          {/* Energized Badge vs AI Diagnostic Button */}
          {isMonitoring && isEnergized && (
            <g data-testid="coil-energized-badge">
              <rect
                x={midX - 60}
                y={y + (isDoubleCoil ? 44 : 36)}
                width={120}
                height={18}
                fill="#064e3b"
                stroke="#10b981"
                strokeWidth="1"
              />
              <text
                x={midX}
                y={y + (isDoubleCoil ? 57 : 49)}
                fill="#34d399"
                fontSize="9.5"
                fontWeight="bold"
                textAnchor="middle"
                fontFamily="monospace"
              >
                ENERGIZED (TRUE)
              </text>
            </g>
          )}

          {/* AI Diagnostic Trigger: Why is this OFF? (Only visible during live monitoring) */}
          {isMonitoring && !isEnergized && (
            <g
              data-testid="btn-diagnose-coil"
              transform={`translate(${midX - 70}, ${y + (isDoubleCoil ? 44 : 36)})`}
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                window.dispatchEvent(
                  new CustomEvent('plc:diagnose-coil', {
                    detail: { operand: c.operand, networkNumber: netIdx + 1 }
                  })
                )
              }}
            >
              <rect x="0" y="0" width="140" height="18" fill="#831843" stroke="#f43f5e" strokeWidth="1" />
              <text x="70" y="12" fill="#fecdd3" fontSize="9" fontWeight="bold" textAnchor="middle" fontFamily="sans-serif">
                AI: Why is this OFF?
              </text>
              <title>Analyze unenergized coil condition with Rungline AI</title>
            </g>
          )}

          {/* Clean 1px Technical Selection Frame (Zero Circular Icons) */}
          {isSelected && (
            <g data-testid="contact-selection-container">
              <rect
                x={midX - 67}
                y={y - 59}
                width={134}
                height={82}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />

              {/* TIA Portal v19 Floating Selection Toolbar for Coil: [( )] [(/)] [(S)] [(R)] | [Del] */}
              <g
                data-testid="coil-selection-toolbar"
                className="select-none cursor-pointer"
                transform={`translate(${Math.max(TOOLBAR_MIN_X, midX - 90)}, ${y - 84})`}
              >
                <rect
                  x="0"
                  y="0"
                  width="180"
                  height="22"
                  fill="#0b0f17"
                  stroke="#38bdf8"
                  strokeWidth="1"
                />
                {/* [ ( ) ] Standard Output Coil */}
                <g
                  data-testid="btn-toolbar-coil-out"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateCoilType?.(c.id, 'OUTPUT_COIL')
                  }}
                >
                  <rect
                    x="2"
                    y="2"
                    width="28"
                    height="18"
                    fill={c.coilType === 'OUTPUT_COIL' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="16"
                    y="14"
                    fill={c.coilType === 'OUTPUT_COIL' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    ( )
                  </text>
                  <title>Convert to Normal Output Coil</title>
                </g>
                {/* [ (/) ] Negated Coil */}
                <g
                  data-testid="btn-toolbar-coil-neg"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateCoilType?.(c.id, 'NEGATED_COIL')
                  }}
                >
                  <rect
                    x="32"
                    y="2"
                    width="28"
                    height="18"
                    fill={c.coilType === 'NEGATED_COIL' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="46"
                    y="14"
                    fill={c.coilType === 'NEGATED_COIL' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    (/)
                  </text>
                  <title>Convert to Negated Output Coil</title>
                </g>
                {/* [ (S) ] Set Coil */}
                <g
                  data-testid="btn-toolbar-coil-set"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateCoilType?.(c.id, 'SET_COIL')
                  }}
                >
                  <rect
                    x="62"
                    y="2"
                    width="28"
                    height="18"
                    fill={c.coilType === 'SET_COIL' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="76"
                    y="14"
                    fill={c.coilType === 'SET_COIL' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    (S)
                  </text>
                  <title>Convert to Set Latch Coil</title>
                </g>
                {/* [ (R) ] Reset Coil */}
                <g
                  data-testid="btn-toolbar-coil-reset"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateCoilType?.(c.id, 'RESET_COIL')
                  }}
                >
                  <rect
                    x="92"
                    y="2"
                    width="28"
                    height="18"
                    fill={c.coilType === 'RESET_COIL' ? '#0369a1' : '#1e293b'}
                  />
                  <text
                    x="106"
                    y="14"
                    fill={c.coilType === 'RESET_COIL' ? '#ffffff' : '#94a3b8'}
                    fontSize="9"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    (R)
                  </text>
                  <title>Convert to Reset Unlatch Coil</title>
                </g>
                {/* Divider */}
                <line x1="124" y1="3" x2="124" y2="19" stroke="#334155" strokeWidth="1" />
                {/* [Delete] */}
                <g
                  data-testid="btn-toolbar-coil-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteNode(c.id)
                  }}
                >
                  <rect x="130" y="2" width="46" height="18" fill="#450a0a" />
                  <text
                    x="153"
                    y="14"
                    fill="#f87171"
                    fontSize="8.5"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    Delete
                  </text>
                  <title>Delete Coil (Del)</title>
                </g>
              </g>
            </g>
          )}

          {/* Double Coil Warning indicator */}
          {isDoubleCoil && (
            <text
              x={midX}
              y={y + 34}
              fill="#f59e0b"
              fontSize="9"
              fontWeight="bold"
              textAnchor="middle"
              fontFamily="monospace"
            >
              Double Coil!
            </text>
          )}
        </g>
      )

      if (isInsideBranch) {
        curX += coilWidth
      } else if (isLastNode) {
        curX = rightRailX
      } else {
        curX += coilWidth
        const afterCoilTarget: DropZoneTarget = {
          netIdx,
          branchId: undefined,
          branchIndex: undefined,
          insertIndex: idx + 1
        }
        elements.push(
          renderDropTargetSquare(curX - 10, y, afterCoilTarget, `drop_after_coil_${idx}_${c.id}`)
        )
      }
    }
  })

  // If main rung, ensure final connection to right terminal bar -|
  if (!branchContext && curX < rightRailX) {
    const isRungPowered = isMonitoring ? currentRlo : false
    elements.push(
      <g key={`main_terminal_${netIdx}`} className="select-none">
        <line
          x1={curX}
          y1={y}
          x2={rightRailX}
          y2={y}
          stroke={isRungPowered ? '#10b981' : '#475569'}
          strokeWidth="2.5"
        />
        <line
          data-testid="rung-terminal-bar"
          x1={rightRailX}
          y1={y - 14}
          x2={rightRailX}
          y2={y + 14}
          stroke={isRungPowered ? '#10b981' : '#64748b'}
          strokeWidth="3"
        />
      </g>
    )
  }

  return elements
}
