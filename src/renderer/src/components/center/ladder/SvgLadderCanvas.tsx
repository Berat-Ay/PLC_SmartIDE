import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  CoilType,
  ComparatorType,
  ContactType,
  LadderCoilNode,
  LadderContactNode,
  LadderCounterNode,
  LadderNode,
  LadderTimerNode,
  MathBoxType,
  TimerType
} from '@shared/types/ladder'
import { LadBlockDefinition, LadNetwork } from '@shared/types/blocks'
import type { TagDefinition } from '@shared/types/tags'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { useTagStore } from '../../../stores/useTagStore'
import { useUIStore } from '../../../stores/useUIStore'
import { useProjectStore } from '../../../stores/useProjectStore'
import { DoubleCoilConflict } from '../../../services/DoubleCoilDetector'
import { LadderGridLayoutEngine, LADDER_MIN_WIDTH } from '../../../services/layout/LadderGridLayoutEngine'
import { InstructionRibbon } from './InstructionRibbon'
import { isEditableElement } from '../../../utils/keyboardShortcuts'
import {
  ArithmeticMathBoxType,
  ComparatorOperatorType,
  ComparatorPinKey,
  MathPinKey,
  updateComparatorOperator,
  updateComparatorPin,
  updateMathBoxType,
  updateMathPin
} from '../../../utils/ladderBoxEdits'
import {
  addParallelBranchTier,
  BranchTarget,
  clearNetworkAt,
  countOperandReferences,
  createInstructionNode,
  deleteNetworkAt,
  deleteNodeById,
  deleteParallelBranchLeg,
  DropZoneTarget,
  findNodeInNetworks,
  getTargetLocation,
  insertNetworkAt,
  insertNodeAtZone,
  insertNodeInNetwork,
  moveNetwork,
  moveNodeToZone,
  updateNodeById,
  wrapNodeInParallelBranch
} from './ladderAstOps'
import { LadderRenderContext, renderLadderNodes, TimerPropType } from './LadderNodeRenderers'
import {
  EditingAddressState,
  EditingBoxOpState,
  EditingBoxPinState,
  EditingOperandState,
  EditingTimerPropState,
  LadderInlinePopovers
} from './LadderInlinePopovers'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react'

export type { DropZoneTarget }

interface SvgLadderCanvasProps {
  block: LadBlockDefinition
  conflicts: DoubleCoilConflict[]
  onUpdateBlock: (updated: LadBlockDefinition) => void
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
  isActivePane?: boolean
  panePrefix?: string
}

const WIRE_Y = LadderGridLayoutEngine.TOP_PADDING
const POWER_RAIL_X = 30

export const SvgLadderCanvas: React.FC<SvgLadderCanvasProps> = ({
  block,
  conflicts,
  onUpdateBlock,
  selectedNodeId,
  onSelectNode,
  isActivePane = true,
  panePrefix = ''
}) => {
  const isMonitoring = useRuntimeStore((s) => s.isMonitoring)
  const cpuStatus = useRuntimeStore((s) => s.state)
  const currentSnapshot = useRuntimeStore((s) => s.currentSnapshot)
  const scrubbedSnapshot = useRuntimeStore((s) => s.scrubbedSnapshot)
  const timeTravelActive = useRuntimeStore((s) => s.timeTravelActive)
  const tagTables = useTagStore((s) => s.tagTables)
  const canvasZoom = useUIStore((s) => s.canvasZoom)
  const setCanvasZoom = useUIStore((s) => s.setCanvasZoom)

  const isMonitoringActive = isMonitoring && cpuStatus === 'RUN'
  const activeSnapshot = timeTravelActive ? scrubbedSnapshot : currentSnapshot
  const powerStates = isMonitoringActive ? (activeSnapshot?.ladPowerState || {}) : {}

  const rawInstanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const filterIds = useMemo(
    () => ({
      emerald: `emeraldGlow_${rawInstanceId}`,
      amber: `amberGlow_${rawInstanceId}`,
      crimson: `crimsonGlow_${rawInstanceId}`
    }),
    [rawInstanceId]
  )

  const { tagByName, tagByAddress } = useMemo(() => {
    const byName = new Map<string, TagDefinition>()
    const byAddr = new Map<string, TagDefinition>()
    for (const table of tagTables) {
      for (const tag of table.tags) {
        if (tag.name) byName.set(tag.name.toLowerCase(), tag)
        if (tag.address) byAddr.set(tag.address.toUpperCase(), tag)
      }
    }
    return { tagByName: byName, tagByAddress: byAddr }
  }, [tagTables])

  const networkLayouts = useMemo(
    () =>
      block.networks.map((net, idx) =>
        net.isSclNetwork ? null : LadderGridLayoutEngine.layoutNetwork(net, idx, LADDER_MIN_WIDTH)
      ),
    [block.networks]
  )

  const conflictingOperands = useMemo(
    () => new Set(conflicts.map((c) => c.normalizedOperand)),
    [conflicts]
  )

  const [editingNode, setEditingNode] = useState<EditingOperandState | null>(null)
  const [editingAddressNode, setEditingAddressNode] = useState<EditingAddressState | null>(null)
  const [addressInputValue, setAddressInputValue] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [editingTimerProp, setEditingTimerProp] = useState<EditingTimerPropState | null>(null)
  const [timerPropInputValue, setTimerPropInputValue] = useState('')
  const [editingBoxPin, setEditingBoxPin] = useState<EditingBoxPinState | null>(null)
  const [editingBoxOp, setEditingBoxOp] = useState<EditingBoxOpState | null>(null)

  const [isDraggingInstruction, setIsDraggingInstruction] = useState(false)
  const [hoveredDropZone, setHoveredDropZone] = useState<DropZoneTarget | null>(null)
  const [magneticSnapPos, setMagneticSnapPos] = useState<{
    netIdx: number
    x: number
    y: number
    target: DropZoneTarget
  } | null>(null)

  const [selectedNetworkNumber, setSelectedNetworkNumber] = useState<number>(
    block.networks[0]?.networkNumber || 1
  )
  const [selectedBranchTarget, setSelectedBranchTarget] = useState<BranchTarget | null>(null)
  const [blockingNodeId, setBlockingNodeId] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDraggingRef = useRef(false)
  isDraggingRef.current = isDraggingInstruction

  const stateRef = useRef({
    block,
    selectedNodeId,
    selectedNetworkNumber,
    selectedBranchTarget,
    isMonitoring,
    isActivePane,
    onUpdateBlock,
    onSelectNode
  })
  stateRef.current = {
    block,
    selectedNodeId,
    selectedNetworkNumber,
    selectedBranchTarget,
    isMonitoring,
    isActivePane,
    onUpdateBlock,
    onSelectNode
  }

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    }
  }, [])

  // Non-passive wheel listener so Ctrl+Wheel zoom prevents browser pinch zoom cleanly
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault()
        const delta = e.deltaY < 0 ? 0.1 : -0.1
        setCanvasZoom(useUIStore.getState().canvasZoom + delta)
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [setCanvasZoom])

  // Listen for AI Diagnostic highlights
  useEffect(() => {
    const handleHighlight = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string }>).detail
      if (detail?.nodeId) setBlockingNodeId(detail.nodeId)
    }
    const handleClear = () => setBlockingNodeId(null)
    window.addEventListener('plc:highlight-blocking-node', handleHighlight)
    window.addEventListener('plc:clear-blocking-highlight', handleClear)
    return () => {
      window.removeEventListener('plc:highlight-blocking-node', handleHighlight)
      window.removeEventListener('plc:clear-blocking-highlight', handleClear)
    }
  }, [])

  // Sync selectedNetworkNumber when networks change
  useEffect(() => {
    if (!block.networks.some((n: LadNetwork) => n.networkNumber === selectedNetworkNumber)) {
      if (block.networks.length > 0) {
        setSelectedNetworkNumber(block.networks[0].networkNumber)
      }
    }
  }, [block.networks, selectedNetworkNumber])

  const insertCreatedNode = (newNode: LadderNode) => {
    const cur = stateRef.current
    const res = insertNodeInNetwork(cur.block.networks, newNode, {
      selectedNodeId: cur.selectedNodeId,
      selectedNetworkNumber: cur.selectedNetworkNumber,
      selectedBranchTarget: cur.selectedBranchTarget
    })
    cur.onUpdateBlock({ ...cur.block, networks: res.networks })
    if (res.selectedNetworkNumber !== undefined) setSelectedNetworkNumber(res.selectedNetworkNumber)
    if (res.clearBranchTarget) setSelectedBranchTarget(null)
    cur.onSelectNode(newNode.id)
  }

  // Drag start/end + InstructionsTree / Favorites custom insert
  useEffect(() => {
    const handleDragStart = () => {
      if (!stateRef.current.isMonitoring) setIsDraggingInstruction(true)
    }
    const handleDragEnd = () => {
      if (!isDraggingRef.current) return
      setIsDraggingInstruction(false)
      setHoveredDropZone(null)
      setMagneticSnapPos(null)
    }
    const handleInsertCustom = (e: Event) => {
      if (!stateRef.current.isActivePane) return
      const detail = (e as CustomEvent<{ kind: string; subType?: string; title?: string }>).detail
      if (!detail) return
      const newNode = createInstructionNode(detail.kind, detail.subType, detail.title)
      insertCreatedNode(newNode)
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
  }, [])

  const insertContact = (type: ContactType) => insertCreatedNode(createInstructionNode('contact', type))
  const insertCoil = (type: CoilType) => insertCreatedNode(createInstructionNode('coil', type))
  const insertEmptyBox = (instruction: string = '???') =>
    insertCreatedNode(createInstructionNode('emptyBox', instruction, instruction))
  const insertTimer = (type: TimerType) => insertCreatedNode(createInstructionNode('timer', type))
  const insertComparator = (type: ComparatorType) => insertCreatedNode(createInstructionNode('comparator', type))
  const insertMath = (type: MathBoxType) => insertCreatedNode(createInstructionNode('math', type))

  const addBranchTier = (branchId: string) => {
    const res = addParallelBranchTier(block.networks, branchId)
    onUpdateBlock({ ...block, networks: res.networks })
    onSelectNode(branchId)
    setSelectedBranchTarget({ branchId, branchIndex: res.newTierIndex })
  }

  const deleteBranchLeg = (branchId: string, branchIndex: number) => {
    onUpdateBlock({ ...block, networks: deleteParallelBranchLeg(block.networks, branchId, branchIndex) })
    onSelectNode(null)
    setSelectedBranchTarget(null)
  }

  const insertParallelBranch = () => {
    const selectedNode = selectedNodeId ? findNodeInNetworks(block.networks, selectedNodeId) : null
    const targetBranchId =
      selectedBranchTarget?.branchId || (selectedNode?.kind === 'parallel' ? selectedNode.id : null)

    if (targetBranchId) {
      addBranchTier(targetBranchId)
      return
    }

    const newBranch = createInstructionNode('parallel')
    const { targetNetIdx } = getTargetLocation(block.networks, selectedNodeId, selectedNetworkNumber)
    if (targetNetIdx < 0 || targetNetIdx >= block.networks.length) return
    insertCreatedNode(newBranch)
    setSelectedBranchTarget({ branchId: newBranch.id, branchIndex: 0 })
  }

  const insertSclNetwork = () => {
    const curNetIdx = block.networks.findIndex((n) => n.networkNumber === selectedNetworkNumber)
    const targetIdx = curNetIdx !== -1 ? curNetIdx + 1 : block.networks.length
    const res = insertNetworkAt(block.networks, targetIdx, true)
    onUpdateBlock({ ...block, networks: res.networks })
    setSelectedNetworkNumber(res.selectedNetworkNumber)
  }

  const addNewNetwork = () => {
    const curNetIdx = block.networks.findIndex((n) => n.networkNumber === selectedNetworkNumber)
    const targetIdx = curNetIdx !== -1 ? curNetIdx + 1 : block.networks.length
    const res = insertNetworkAt(block.networks, targetIdx, false)
    onUpdateBlock({ ...block, networks: res.networks })
    setSelectedNetworkNumber(res.selectedNetworkNumber)
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = setTimeout(() => {
      const cardId = panePrefix
        ? `${panePrefix}network-card-${res.selectedNetworkNumber}`
        : `network-card-${res.selectedNetworkNumber}`
      document.getElementById(cardId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  const moveNetworkUp = (netIdx: number) => {
    const res = moveNetwork(block.networks, netIdx, netIdx - 1)
    if (!res) return
    onUpdateBlock({ ...block, networks: res.networks })
    setSelectedNetworkNumber(res.selectedNetworkNumber)
  }

  const moveNetworkDown = (netIdx: number) => {
    const res = moveNetwork(block.networks, netIdx, netIdx + 1)
    if (!res) return
    onUpdateBlock({ ...block, networks: res.networks })
    setSelectedNetworkNumber(res.selectedNetworkNumber)
  }

  const insertRungBelow = (netIdx: number) => {
    const res = insertNetworkAt(block.networks, netIdx + 1, false)
    onUpdateBlock({ ...block, networks: res.networks })
    setSelectedNetworkNumber(res.selectedNetworkNumber)
  }

  const clearNetwork = (netIdx: number) => {
    onUpdateBlock({ ...block, networks: clearNetworkAt(block.networks, netIdx) })
  }

  const deleteNetwork = (netIdx: number) => {
    const res = deleteNetworkAt(block.networks, netIdx)
    onUpdateBlock({ ...block, networks: res.networks })
    setSelectedNetworkNumber(res.selectedNetworkNumber)
  }

  const deleteNode = (nodeId: string) => {
    onUpdateBlock({ ...block, networks: deleteNodeById(block.networks, nodeId) })
    onSelectNode(null)
    setSelectedBranchTarget(null)
  }

  const updateNodeOperand = (nodeId: string, newOperand: string) => {
    const updated = updateNodeById(block.networks, nodeId, (n) =>
      n.kind === 'contact' || n.kind === 'coil' ? { ...n, operand: newOperand } : n
    )
    onUpdateBlock({ ...block, networks: updated })
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
    const existingTagWithOldName = currentAllTags.find((t) => t.name.toLowerCase() === currentOperand.toLowerCase())
    const existingTagWithNewName = currentAllTags.find((t) => t.name.toLowerCase() === cleanNew.toLowerCase())

    // Only rename tag in-place when no other node in this block references the old symbol
    if (
      existingTagWithOldName &&
      currentOperand !== '???' &&
      !existingTagWithNewName &&
      countOperandReferences(block.networks, currentOperand, nodeId) === 0
    ) {
      const table = useTagStore.getState().tagTables.find((t) =>
        t.tags.some((tag) => tag.id === existingTagWithOldName.id)
      )
      if (table) {
        useTagStore.getState().updateTag(table.id, existingTagWithOldName.id, { name: cleanNew })
      }
    }

    updateNodeOperand(nodeId, cleanNew)
    useProjectStore.getState().markDirty(true)
    setEditingNode(null)
  }

  const handleBoxPinSelect = (newValue: string) => {
    if (!editingBoxPin) return
    const updated =
      editingBoxPin.kind === 'comparator'
        ? updateComparatorPin(block, editingBoxPin.netIdx, editingBoxPin.nodeId, editingBoxPin.pin as ComparatorPinKey, newValue)
        : updateMathPin(block, editingBoxPin.netIdx, editingBoxPin.nodeId, editingBoxPin.pin as MathPinKey, newValue)
    onUpdateBlock(updated)
    useProjectStore.getState().markDirty(true)
    setEditingBoxPin(null)
  }

  const handleBoxOpSelect = (newOp: string) => {
    if (!editingBoxOp) return
    const updated =
      editingBoxOp.kind === 'comparator'
        ? updateComparatorOperator(block, editingBoxOp.netIdx, editingBoxOp.nodeId, newOp as ComparatorOperatorType)
        : updateMathBoxType(block, editingBoxOp.netIdx, editingBoxOp.nodeId, newOp as ArithmeticMathBoxType)
    onUpdateBlock(updated)
    useProjectStore.getState().markDirty(true)
    setEditingBoxOp(null)
  }

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

    const normalizedAddress = norm.address
    const { nodeId, currentOperand } = editingAddressNode
    const currentAllTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)

    if (currentOperand !== '???') {
      const existingTag = currentAllTags.find((t) => t.name.toLowerCase() === currentOperand.toLowerCase())
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
        const tables = useTagStore.getState().tagTables
        const defaultTableId = tables[0]?.id || 'table_default'
        useTagStore.getState().addTag(defaultTableId, {
          name: currentOperand,
          address: normalizedAddress,
          dataType: norm.inferredDataType || 'BOOL',
          comment: `Created via in-place bit editor for ${currentOperand}`
        })
      }
    } else {
      const tagWithAddress = currentAllTags.find((t) => t.address.toUpperCase() === normalizedAddress.toUpperCase())
      if (tagWithAddress) {
        updateNodeOperand(nodeId, tagWithAddress.name)
      } else {
        const tables = useTagStore.getState().tagTables
        const defaultTableId = tables[0]?.id || 'table_default'
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

    useProjectStore.getState().markDirty(true)
    setEditingAddressNode(null)
    setAddressError(null)
  }

  const handleTimerPropSubmit = (rawInput: string) => {
    if (!editingTimerProp) return
    const trimmed = rawInput.trim()
    if (!trimmed) {
      setEditingTimerProp(null)
      return
    }

    const { nodeId, propType } = editingTimerProp
    const updated = updateNodeById(block.networks, nodeId, (n) => {
      if (n.kind === 'timer') {
        const t = n as LadderTimerNode
        if (propType === 'instance') return { ...t, instanceDb: trimmed, qOperand: `${trimmed}.Q`, etOperand: `${trimmed}.ET` }
        if (propType === 'preset') return { ...t, ptOperand: trimmed }
        if (propType === 'reset') return { ...t, rOperand: trimmed }
      } else if (n.kind === 'counter') {
        const c = n as LadderCounterNode
        if (propType === 'instance') return { ...c, instanceDb: trimmed, qOperand: `${trimmed}.QU`, cvOperand: `${trimmed}.CV` }
        if (propType === 'preset') return { ...c, pvOperand: trimmed }
        if (propType === 'reset') return { ...c, rLdOperand: trimmed }
        if (propType === 'cd') return { ...c, cdOperand: trimmed }
        if (propType === 'ld') return { ...c, ldOperand: trimmed, rLdOperand: trimmed }
      }
      return n
    })

    onUpdateBlock({ ...block, networks: updated })
    useProjectStore.getState().markDirty(true)
    setEditingTimerProp(null)
  }

  const updateContactType = (nodeId: string, newType: ContactType) => {
    const updated = updateNodeById(block.networks, nodeId, (n) =>
      n.kind === 'contact' ? { ...(n as LadderContactNode), contactType: newType } : n
    )
    onUpdateBlock({ ...block, networks: updated })
  }

  const updateCoilType = (nodeId: string, newType: CoilType) => {
    const updated = updateNodeById(block.networks, nodeId, (n) =>
      n.kind === 'coil' ? { ...(n as LadderCoilNode), coilType: newType } : n
    )
    onUpdateBlock({ ...block, networks: updated })
  }

  const wrapNodeInBranch = (nodeId: string) => {
    onUpdateBlock({ ...block, networks: wrapNodeInParallelBranch(block.networks, nodeId) })
  }

  const insertNodeAt = (newNode: LadderNode, target: DropZoneTarget) => {
    const res = insertNodeAtZone(block.networks, newNode, target)
    onUpdateBlock({ ...block, networks: res.networks })
    if (res.selectedNetworkNumber !== undefined) setSelectedNetworkNumber(res.selectedNetworkNumber)
    onSelectNode(newNode.id)
  }

  const moveNodeTo = (nodeId: string, target: DropZoneTarget) => {
    const res = moveNodeToZone(block.networks, nodeId, target)
    if (!res.movedNode) return
    onUpdateBlock({ ...block, networks: res.networks })
    if (res.selectedNetworkNumber !== undefined) setSelectedNetworkNumber(res.selectedNetworkNumber)
    onSelectNode(res.movedNode.id)
  }

  const handleDropOnZone = (e: React.DragEvent, target: DropZoneTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setHoveredDropZone(null)
    setIsDraggingInstruction(false)
    if (!e.dataTransfer) return

    const reorderData = e.dataTransfer.getData('application/plc-reorder-node')
    if (reorderData) {
      try {
        const { nodeId } = JSON.parse(reorderData)
        if (nodeId) {
          moveNodeTo(nodeId, target)
          return
        }
      } catch {
        // ignore invalid payload
      }
    }

    const instrData = e.dataTransfer.getData('application/plc-instruction')
    if (instrData) {
      try {
        const data = JSON.parse(instrData)
        const newNode = createInstructionNode(data.instructionType, data.subType, data.title)
        insertNodeAt(newNode, target)
      } catch {
        // ignore invalid payload
      }
    }
  }

  // Scoped keyboard shortcuts for active LAD pane
  useEffect(() => {
    if (!isActivePane) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        isEditableElement(e.target) ||
        editingNode ||
        editingAddressNode ||
        editingTimerProp ||
        editingBoxPin ||
        editingBoxOp
      ) {
        return
      }
      if (document.querySelector('[role="dialog"], [data-testid="tia-modal"], [data-testid="ai-settings-modal"]')) {
        return
      }
      const activeEl = document.activeElement
      if (
        activeEl &&
        activeEl !== document.body &&
        rootRef.current &&
        !rootRef.current.contains(activeEl) &&
        activeEl.closest('aside, [data-testid="bottom-inspector"]')
      ) {
        return
      }

      if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        const curIdx = block.networks.findIndex((n: LadNetwork) => n.networkNumber === selectedNetworkNumber)
        if (curIdx !== -1) deleteNetwork(curIdx)
        return
      }

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
      } else if (e.shiftKey && e.key === 'F7') {
        e.preventDefault()
        insertCoil('OUTPUT_COIL')
      } else if (
        (e.shiftKey && e.key === 'F8') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'b' || e.key === 'B'))
      ) {
        e.preventDefault()
        insertParallelBranch()
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        addNewNetwork()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isActivePane,
    selectedNodeId,
    selectedBranchTarget,
    editingNode,
    editingAddressNode,
    editingTimerProp,
    editingBoxPin,
    editingBoxOp,
    block,
    selectedNetworkNumber
  ])

  const handleSvgDragOver = (e: React.DragEvent<SVGSVGElement>, netIdx: number) => {
    e.preventDefault()
    if (isMonitoringActive) {
      if (magneticSnapPos) setMagneticSnapPos(null)
      if (hoveredDropZone) setHoveredDropZone(null)
      return
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (!isDraggingInstruction) setIsDraggingInstruction(true)

    const svgElem = e.currentTarget
    const rect = svgElem.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const vb = svgElem.viewBox.baseVal
    const mouseX = ((e.clientX - rect.left) / rect.width) * (vb.width || 1100)
    const mouseY = ((e.clientY - rect.top) / rect.height) * (vb.height || 145)
    const layout = networkLayouts[netIdx]
    if (!layout) return

    const closest = LadderGridLayoutEngine.findNearestDropTarget(layout.dropZones, mouseX, mouseY, 60)
    if (closest) {
      setMagneticSnapPos({ netIdx, x: closest.x, y: closest.y, target: closest.target })
      setHoveredDropZone(closest.target)
    } else if (magneticSnapPos?.netIdx === netIdx) {
      setMagneticSnapPos(null)
      setHoveredDropZone(null)
    }
  }

  const handleSvgDragLeave = (e: React.DragEvent<SVGSVGElement>, netIdx: number) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node) && magneticSnapPos?.netIdx === netIdx) {
      setMagneticSnapPos(null)
      setHoveredDropZone(null)
    }
  }

  const handleSvgDrop = (e: React.DragEvent<SVGSVGElement>, netIdx: number) => {
    e.preventDefault()
    e.stopPropagation()
    const snap = magneticSnapPos
    setMagneticSnapPos(null)
    setHoveredDropZone(null)
    setIsDraggingInstruction(false)
    if (snap && snap.netIdx === netIdx) handleDropOnZone(e, snap.target)
  }

  const openOperandEdit = (operand: string, id: string, e: React.MouseEvent, netIdx: number) => {
    const rect = (e.target as Element).getBoundingClientRect()
    setEditingNode({ netIdx, nodeId: id, currentOperand: operand, pos: { x: rect.left, y: rect.bottom + 4 } })
  }

  const openBitEdit = (operand: string, id: string, address: string, e: React.MouseEvent, netIdx: number) => {
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
  }

  const openTimerProp = (
    netIdx: number,
    nodeId: string,
    propType: TimerPropType,
    currentVal: string,
    e: React.MouseEvent
  ) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    setEditingTimerProp({ netIdx, nodeId, propType, currentVal, pos: { x: rect.left, y: rect.bottom + 4 } })
    setTimerPropInputValue(currentVal)
  }

  const openBoxPinEdit = (
    netIdx: number,
    nodeId: string,
    kind: 'comparator' | 'math',
    pin: ComparatorPinKey | MathPinKey,
    label: string,
    currentValue: string,
    e: React.MouseEvent
  ) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    setEditingNode(null)
    setEditingAddressNode(null)
    setEditingTimerProp(null)
    setEditingBoxOp(null)
    setEditingBoxPin({
      netIdx,
      nodeId,
      kind,
      pin,
      label,
      currentValue,
      pos: {
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
        y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 280))
      }
    })
  }

  const openBoxOpEdit = (
    netIdx: number,
    nodeId: string,
    kind: 'comparator' | 'math',
    currentOp: string,
    e: React.MouseEvent
  ) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    setEditingNode(null)
    setEditingAddressNode(null)
    setEditingTimerProp(null)
    setEditingBoxPin(null)
    setEditingBoxOp({
      netIdx,
      nodeId,
      kind,
      currentOp,
      pos: {
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
        y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 120))
      }
    })
  }

  return (
    <div
      ref={rootRef}
      onMouseMove={(e) => {
        if (e.buttons === 0 && (isDraggingInstruction || magneticSnapPos || hoveredDropZone)) {
          setIsDraggingInstruction(false)
          setHoveredDropZone(null)
          setMagneticSnapPos(null)
        }
      }}
      className="flex-1 flex flex-col overflow-hidden bg-[#0c0d10] select-none"
    >
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

      <div
        data-testid="ladder-networks-scroll"
        className="flex-1 overflow-auto bg-[#0c0d10] divide-y divide-[#27272a]"
        onClick={() => {
          onSelectNode(null)
          setSelectedBranchTarget(null)
        }}
      >
        {block.networks.map((net: LadNetwork, netIdx: number) => {
          const isNetSelected = selectedNetworkNumber === net.networkNumber
          const cardId = panePrefix ? `${panePrefix}network-card-${net.networkNumber}` : `network-card-${net.networkNumber}`

          if (net.isSclNetwork) {
            return (
              <div
                key={net.id || net.networkNumber}
                id={cardId}
                onClick={() => setSelectedNetworkNumber(net.networkNumber)}
                className={`flex flex-row transition-all duration-100 ${
                  isNetSelected ? 'bg-[#12151c]' : 'bg-[#0e1014] hover:bg-[#111317]'
                }`}
              >
                <div
                  className={`w-12 border-r border-[#27272a] flex flex-col items-center justify-start py-2.5 font-mono text-[11px] font-bold select-none shrink-0 ${
                    isNetSelected ? 'bg-[#151922] text-[#38bdf8] border-r-2 border-r-[#00a3a6]' : 'bg-[#101216] text-industrial-400'
                  }`}
                >
                  <span>NW {net.networkNumber}</span>
                </div>
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="h-7 px-3 bg-[#16181d] border-b border-[#27272a] flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="font-mono text-[10px] text-blue-400 font-bold shrink-0">[SCL]</span>
                      <input
                        type="text"
                        value={net.title || ''}
                        onChange={(e) => {
                          const updated = block.networks.map((n, i) => (i === netIdx ? { ...n, title: e.target.value } : n))
                          onUpdateBlock({ ...block, networks: updated })
                        }}
                        placeholder={`Network ${net.networkNumber} title...`}
                        className="bg-transparent text-[11px] font-mono font-semibold text-industrial-200 border-none focus:outline-hidden hover:bg-[#1a1d24] px-1 flex-1 min-w-0"
                      />
                    </div>
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
                      const updated = block.networks.map((n, i) => (i === netIdx ? { ...n, sclCode: e.target.value } : n))
                      onUpdateBlock({ ...block, networks: updated })
                    }}
                    className="w-full h-24 bg-[#0a0b0d] text-industrial-100 font-mono text-xs p-3 focus:outline-hidden resize-none leading-relaxed"
                    spellCheck={false}
                  />
                </div>
              </div>
            )
          }

          const nodes = net.nodes || []
          const layout = networkLayouts[netIdx] || LadderGridLayoutEngine.layoutNetwork(net, netIdx, LADDER_MIN_WIDTH)
          const { svgWidth, svgHeight: netSvgHeight, coilX, rightRailX } = layout
          const isEmptyHovered =
            hoveredDropZone?.netIdx === netIdx && hoveredDropZone?.insertIndex === 0 && !hoveredDropZone.branchId

          const renderCtx: LadderRenderContext = {
            netIdx,
            networkNumber: net.networkNumber,
            isMonitoring: isMonitoringActive,
            powerStates,
            conflictingOperands,
            selectedNodeId,
            selectedBranchTarget,
            blockingNodeId,
            tagByName,
            tagByAddress,
            isDraggingInstruction,
            hoveredDropZone,
            layoutMetrics: { svgWidth, coilX, rightRailX },
            filterIds,
            onSelectNode,
            onOpenEdit: (op, id, e) => openOperandEdit(op, id, e, netIdx),
            onOpenBitEdit: (op, id, addr, e) => openBitEdit(op, id, addr, e, netIdx),
            onDeleteNode: deleteNode,
            onSelectBranchTarget: (branchId, branchIndex) => setSelectedBranchTarget({ branchId, branchIndex }),
            setHoveredDropZone,
            handleDropOnZone,
            setIsDraggingInstruction,
            onAddBranchTier: addBranchTier,
            onDeleteBranchLeg: deleteBranchLeg,
            onOpenTimerProp: openTimerProp,
            onUpdateContactType: updateContactType,
            onWrapNodeInBranch: wrapNodeInBranch,
            onUpdateCoilType: updateCoilType,
            onOpenBoxPinEdit: openBoxPinEdit,
            onOpenBoxOpEdit: openBoxOpEdit
          }

          return (
            <div
              key={net.id || net.networkNumber}
              id={cardId}
              onClick={() => setSelectedNetworkNumber(net.networkNumber)}
              className={`flex flex-row transition-all duration-100 ${
                isNetSelected ? 'bg-[#101217]' : 'bg-[#0c0d10] hover:bg-[#0f1115]'
              }`}
            >
              <div
                className={`w-12 border-r border-[#27272a] flex flex-col items-center justify-start py-2.5 font-mono text-[11px] font-bold select-none shrink-0 ${
                  isNetSelected ? 'bg-[#151922] text-[#38bdf8] border-r-2 border-r-[#00a3a6]' : 'bg-[#101216] text-industrial-400'
                }`}
              >
                <span>NW {net.networkNumber}</span>
              </div>

              <div className="flex-1 flex flex-col min-w-0">
                <div className="h-7 px-3 bg-[#16181d] border-b border-[#27272a] flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="font-mono text-[10px] text-industrial-400 shrink-0">//</span>
                    <input
                      type="text"
                      value={net.title || ''}
                      onChange={(e) => {
                        const updated = block.networks.map((n, i) => (i === netIdx ? { ...n, title: e.target.value } : n))
                        onUpdateBlock({ ...block, networks: updated })
                      }}
                      placeholder={`Network ${net.networkNumber} title...`}
                      className="bg-transparent text-[11px] font-mono font-semibold text-industrial-200 border-none focus:outline-hidden hover:bg-[#1a1d24] px-1 flex-1 min-w-0"
                    />
                  </div>
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
                      <filter id={filterIds.emerald} x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="3.5" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                      <filter id={filterIds.amber} x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="3" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                      <filter id={filterIds.crimson} x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                    </defs>

                    {nodes.length === 0 ? (
                      <g className="select-none">
                        <line x1="30" y1={WIRE_Y} x2={rightRailX} y2={WIRE_Y} stroke="#334155" strokeWidth="2" />
                        <line
                          data-testid="rung-terminal-bar"
                          x1={rightRailX}
                          y1={WIRE_Y - 14}
                          x2={rightRailX}
                          y2={WIRE_Y + 14}
                          stroke="#475569"
                          strokeWidth="3"
                        />
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
                              filter={isEmptyHovered ? `url(#${filterIds.emerald})` : undefined}
                              opacity={isEmptyHovered ? 1 : 0.95}
                              className="transition-all"
                            >
                              <title>Drag instruction here or double-click to insert</title>
                            </rect>
                          </g>
                        )}
                      </g>
                    ) : (
                      renderLadderNodes(nodes, 30, WIRE_Y, renderCtx)
                    )}

                    {isDraggingInstruction && !isMonitoringActive && magneticSnapPos && magneticSnapPos.netIdx === netIdx && (
                      <g data-testid="magnetic-snap-preview" pointerEvents="none">
                        <circle
                          cx={magneticSnapPos.x}
                          cy={magneticSnapPos.y}
                          r="14"
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2"
                          filter={`url(#${filterIds.emerald})`}
                          strokeDasharray="3 2"
                        >
                          <animate attributeName="r" values="10;18;10" dur="1s" repeatCount="indefinite" />
                          <animate attributeName="stroke-opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite" />
                        </circle>
                        <circle cx={magneticSnapPos.x} cy={magneticSnapPos.y} r="5" fill="#34d399" />
                      </g>
                    )}

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

      <LadderInlinePopovers
        blockInterface={block.interface}
        editingNode={editingNode}
        onSelectOperand={handleOperandChange}
        onCloseOperand={() => setEditingNode(null)}
        editingAddressNode={editingAddressNode}
        addressInputValue={addressInputValue}
        addressError={addressError}
        onAddressInputChange={(val) => {
          setAddressInputValue(val)
          setAddressError(null)
        }}
        onSubmitAddress={handleBitAddressSubmit}
        onCloseAddress={() => setEditingAddressNode(null)}
        editingTimerProp={editingTimerProp}
        timerPropInputValue={timerPropInputValue}
        onTimerPropInputChange={setTimerPropInputValue}
        onSubmitTimerProp={handleTimerPropSubmit}
        onCloseTimerProp={() => setEditingTimerProp(null)}
        editingBoxPin={editingBoxPin}
        onSelectBoxPin={handleBoxPinSelect}
        onCloseBoxPin={() => setEditingBoxPin(null)}
        editingBoxOp={editingBoxOp}
        onSelectBoxOp={handleBoxOpSelect}
        onCloseBoxOp={() => setEditingBoxOp(null)}
      />
    </div>
  )
}
