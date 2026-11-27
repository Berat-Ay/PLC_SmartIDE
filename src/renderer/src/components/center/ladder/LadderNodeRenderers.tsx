import React from 'react'
import {
  CoilType,
  ContactType,
  LadderCoilNode,
  LadderComparatorNode,
  LadderContactNode,
  LadderCounterNode,
  LadderEmptyBoxNode,
  LadderMathNode,
  LadderNode,
  LadderParallelBranchNode,
  LadderTimerNode
} from '@shared/types/ladder'
import type { TagDefinition } from '@shared/types/tags'
import { ComparatorPinKey, MathPinKey } from '../../../utils/ladderBoxEdits'
import { BranchTarget, DropZoneTarget, getInstructionBoxDimensions, getNodeRenderWidth } from './ladderAstOps'

export type TimerPropType = 'instance' | 'preset' | 'reset' | 'cd' | 'ld'

export interface NodePowerState {
  powered: boolean
  rloIn?: boolean
  isConducting?: boolean
  bitValue?: boolean
  liveValues?: Record<string, string | number>
}

export interface LadderRenderContext {
  netIdx: number
  networkNumber: number
  isMonitoring: boolean
  powerStates: Record<string, NodePowerState>
  conflictingOperands: Set<string>
  selectedNodeId: string | null
  selectedBranchTarget: BranchTarget | null
  blockingNodeId: string | null
  tagByName: Map<string, TagDefinition>
  tagByAddress: Map<string, TagDefinition>
  isDraggingInstruction: boolean
  hoveredDropZone: DropZoneTarget | null
  layoutMetrics: { svgWidth: number; coilX: number; rightRailX: number }
  filterIds: { emerald: string; amber: string; crimson: string }
  onSelectNode: (id: string) => void
  onOpenEdit: (operand: string, id: string, e: React.MouseEvent) => void
  onOpenBitEdit: (operand: string, id: string, address: string, e: React.MouseEvent) => void
  onDeleteNode: (id: string) => void
  onSelectBranchTarget: (branchId: string, branchIndex: number) => void
  setHoveredDropZone: (target: DropZoneTarget | null) => void
  handleDropOnZone: (e: React.DragEvent, target: DropZoneTarget) => void
  setIsDraggingInstruction: (dragging: boolean) => void
  onAddBranchTier: (branchId: string) => void
  onDeleteBranchLeg: (branchId: string, branchIndex: number) => void
  onOpenTimerProp: (
    netIdx: number,
    nodeId: string,
    propType: TimerPropType,
    currentVal: string,
    e: React.MouseEvent
  ) => void
  onUpdateContactType: (nodeId: string, newType: ContactType) => void
  onWrapNodeInBranch: (nodeId: string) => void
  onUpdateCoilType: (nodeId: string, newType: CoilType) => void
  onOpenBoxPinEdit: (
    netIdx: number,
    nodeId: string,
    kind: 'comparator' | 'math',
    pin: ComparatorPinKey | MathPinKey,
    label: string,
    currentValue: string,
    e: React.MouseEvent
  ) => void
  onOpenBoxOpEdit: (
    netIdx: number,
    nodeId: string,
    kind: 'comparator' | 'math',
    currentOp: string,
    e: React.MouseEvent
  ) => void
}

const TOOLBAR_MIN_X = 38
const POWER_RAIL_X = 30

function formatOperand(op: string): string {
  if (!op) return ''
  return op.length > 19 ? op.slice(0, 18) + '…' : op
}

function truncPin(val: string | undefined, max = 10): string {
  const s = (val ?? '').trim() || '??'
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function resolveTagFromMaps(
  operand: string,
  tagByName: Map<string, TagDefinition>,
  tagByAddress: Map<string, TagDefinition>
) {
  if (!operand || operand === '???') {
    return { symbol: '???', address: '%??.?', isUnassigned: true }
  }
  const cleanOp = operand.trim()
  const upperOp = cleanOp.toUpperCase()
  if (/^[A-Za-z0-9_]+\.(Q|IN|ET|PT|R)$/i.test(upperOp) || /^T\d+$/i.test(upperOp)) {
    const formatted = upperOp.includes('.') ? upperOp : `${upperOp}.Q`
    return { symbol: formatted, address: formatted, isUnassigned: false }
  }
  if (/^[A-Za-z0-9_]+\.(QU|QD|CV|PV|CU|CD|R|LD)$/i.test(upperOp) || /^C\d+$/i.test(upperOp)) {
    const formatted = upperOp.includes('.') ? upperOp : `${upperOp}.QU`
    return { symbol: formatted, address: formatted, isUnassigned: false }
  }

  const byName = tagByName.get(cleanOp.toLowerCase())
  if (byName) return { symbol: byName.name, address: byName.address, isUnassigned: false }

  const byAddress = tagByAddress.get(upperOp)
  if (byAddress) return { symbol: byAddress.name, address: byAddress.address, isUnassigned: false }

  if (cleanOp.startsWith('%')) {
    return { symbol: '???', address: cleanOp, isUnassigned: false }
  }
  return { symbol: cleanOp, address: '%??.?', isUnassigned: false }
}

function renderDropTargetSquare(
  ctx: LadderRenderContext,
  x: number,
  yCoord: number,
  target: DropZoneTarget,
  key: string
): React.ReactNode {
  if (ctx.isMonitoring || !ctx.isDraggingInstruction) return null
  const isHovered =
    ctx.hoveredDropZone &&
    ctx.hoveredDropZone.netIdx === target.netIdx &&
    ctx.hoveredDropZone.branchId === target.branchId &&
    ctx.hoveredDropZone.branchIndex === target.branchIndex &&
    ctx.hoveredDropZone.insertIndex === target.insertIndex

  return (
    <g
      key={key}
      data-testid="ladder-drop-target"
      className="cursor-pointer"
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        ctx.setHoveredDropZone(target)
      }}
      onDragLeave={(e) => {
        e.stopPropagation()
        ctx.setHoveredDropZone(null)
      }}
      onDrop={(e) => ctx.handleDropOnZone(e, target)}
      onClick={(e) => {
        e.stopPropagation()
        ctx.onSelectNode('')
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
        filter={isHovered ? `url(#${ctx.filterIds.emerald})` : undefined}
        opacity={isHovered ? 1 : ctx.isDraggingInstruction ? 0.9 : 0.35}
        className="transition-all"
      >
        <title>Insert instruction here</title>
      </rect>
    </g>
  )
}

function renderContactNode(
  ctx: LadderRenderContext,
  c: LadderContactNode,
  curX: number,
  y: number,
  currentRlo: boolean,
  isSelected: boolean,
  state?: NodePowerState
): { element: React.ReactNode; nextX: number; nextRlo: boolean } {
  const width = 175
  const midX = curX + width / 2
  const tagInfo = resolveTagFromMaps(c.operand, ctx.tagByName, ctx.tagByAddress)
  const isUnassigned = tagInfo.isUnassigned || tagInfo.symbol === '???'

  const bitVal = state?.bitValue !== undefined ? state.bitValue : state?.liveValues?.val === 'TRUE'
  const isConducting =
    state?.isConducting !== undefined
      ? state.isConducting
      : c.contactType === 'NC_CONTACT'
      ? !bitVal
      : bitVal
  const incomingRlo = ctx.isMonitoring ? (state?.rloIn !== undefined ? state.rloIn : currentRlo) : false
  const outgoingRlo = ctx.isMonitoring
    ? state?.powered !== undefined
      ? state.powered
      : incomingRlo && isConducting
    : false
  const isPowered = ctx.isMonitoring && !!state?.powered

  let contactColor = isSelected ? '#38bdf8' : '#cbd5e1'
  if (ctx.isMonitoring) {
    if (c.contactType === 'NC_CONTACT' && bitVal) contactColor = '#ef4444'
    else if (isConducting && incomingRlo) contactColor = '#10b981'
    else if (isConducting && !incomingRlo) contactColor = '#94a3b8'
    else contactColor = '#64748b'
  }

  const element = (
    <g
      key={c.id}
      data-node-kind="contact"
      data-testid="ladder-contact-node"
      className="cursor-pointer group select-none"
      onClick={(e) => {
        e.stopPropagation()
        ctx.onSelectNode(c.id)
      }}
    >
      <rect x={midX - 25} y={y - 25} width={50} height={50} fill="transparent" pointerEvents="all" />
      <line x1={curX} y1={y} x2={midX - 16} y2={y} stroke={incomingRlo ? '#10b981' : '#475569'} strokeWidth="2.5" />
      <line x1={midX - 16} y1={y - 20} x2={midX - 16} y2={y + 20} stroke={contactColor} strokeWidth="3.5" />
      <line x1={midX + 16} y1={y - 20} x2={midX + 16} y2={y + 20} stroke={contactColor} strokeWidth="3.5" />
      {c.contactType === 'NC_CONTACT' && (
        <line x1={midX - 18} y1={y + 22} x2={midX + 18} y2={y - 22} stroke={contactColor} strokeWidth="2.5" />
      )}
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
      <line
        x1={midX + 16}
        y1={y}
        x2={curX + width}
        y2={y}
        stroke={outgoingRlo ? '#10b981' : '#475569'}
        strokeWidth="2.5"
      />
      <g
        className="ladder-operand-badge cursor-pointer"
        data-ladder-node-id={c.id}
        data-ladder-operand={c.operand}
        data-ladder-node-kind="contact"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenEdit(c.operand, c.id, e)
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          ctx.onOpenEdit(c.operand, c.id, e)
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
      <g
        data-testid="contact-bottom-address"
        data-node-id={c.id}
        data-address={tagInfo.address}
        className="cursor-pointer group/addr"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenBitEdit(c.operand, c.id, tagInfo.address, e)
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

      {ctx.blockingNodeId === c.id && (
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
          <g
            data-testid="contact-selection-toolbar"
            className="select-none cursor-pointer"
            transform={`translate(${Math.max(TOOLBAR_MIN_X, midX - 100)}, ${y - 84})`}
          >
            <rect x="0" y="0" width="200" height="22" fill="#0b0f17" stroke="#38bdf8" strokeWidth="1" />
            {(
              [
                { id: 'btn-toolbar-no', type: 'NO_CONTACT' as ContactType, x: 2, label: 'NO', tip: 'Convert to Normally Open Contact' },
                { id: 'btn-toolbar-nc', type: 'NC_CONTACT' as ContactType, x: 28, label: 'NC', tip: 'Convert to Normally Closed Contact' },
                { id: 'btn-toolbar-ptrig', type: 'P_TRIG' as ContactType, x: 54, label: '|P|', tip: 'Convert to Positive Edge Contact (P_TRIG)' },
                { id: 'btn-toolbar-ntrig', type: 'N_TRIG' as ContactType, x: 80, label: '|N|', tip: 'Convert to Negative Edge Contact (N_TRIG)' }
              ]
            ).map((btn) => (
              <g
                key={btn.id}
                data-testid={btn.id}
                onClick={(e) => {
                  e.stopPropagation()
                  ctx.onUpdateContactType(c.id, btn.type)
                }}
              >
                <rect x={btn.x} y="2" width="24" height="18" fill={c.contactType === btn.type ? '#0369a1' : '#1e293b'} />
                <text
                  x={btn.x + 12}
                  y="14"
                  fill={c.contactType === btn.type ? '#ffffff' : '#94a3b8'}
                  fontSize="9"
                  fontWeight="bold"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  {btn.label}
                </text>
                <title>{btn.tip}</title>
              </g>
            ))}
            <line x1="108" y1="3" x2="108" y2="19" stroke="#334155" strokeWidth="1" />
            <g
              data-testid="btn-toolbar-wrap-branch"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onWrapNodeInBranch(c.id)
              }}
            >
              <rect x="112" y="2" width="46" height="18" fill="#1e293b" />
              <text x="135" y="14" fill="#38bdf8" fontSize="8.5" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                +Branch
              </text>
              <title>Wrap into Parallel Branch</title>
            </g>
            <g
              data-testid="btn-toolbar-delete"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onDeleteNode(c.id)
              }}
            >
              <rect x="160" y="2" width="38" height="18" fill="#450a0a" />
              <text x="179" y="14" fill="#f87171" fontSize="8.5" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                Del
              </text>
              <title>Delete Element (Del)</title>
            </g>
          </g>
        </g>
      )}

      {ctx.isMonitoring && (
        <g data-testid={`contact-status-${c.id}`}>
          {c.contactType === 'NC_CONTACT' ? (
            bitVal ? (
              <g data-testid="contact-blocking-badge">
                <rect x={midX - 64} y={y + 24} width={128} height={16} fill="#450a0a" stroke="#ef4444" strokeWidth="1" />
                <text x={midX} y={y + 36} fill="#f87171" fontSize="9" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                  1 (OPEN — BLOCKING)
                </text>
              </g>
            ) : (
              <g data-testid="contact-closed-badge">
                <rect x={midX - 42} y={y + 24} width={84} height={16} fill="#064e3b" stroke="#10b981" strokeWidth="1" />
                <text x={midX} y={y + 36} fill="#34d399" fontSize="9" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                  0 (CLOSED)
                </text>
              </g>
            )
          ) : bitVal ? (
            <g data-testid="contact-closed-badge">
              <rect x={midX - 42} y={y + 24} width={84} height={16} fill="#064e3b" stroke="#10b981" strokeWidth="1" />
              <text x={midX} y={y + 36} fill="#34d399" fontSize="9" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                1 (CLOSED)
              </text>
            </g>
          ) : (
            <g data-testid="contact-open-badge">
              <rect x={midX - 35} y={y + 24} width={70} height={16} fill="#0f172a" stroke="#475569" strokeWidth="1" />
              <text x={midX} y={y + 36} fill="#94a3b8" fontSize="9" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                0 (OPEN)
              </text>
            </g>
          )}
        </g>
      )}
    </g>
  )

  return { element, nextX: curX + width, nextRlo: outgoingRlo }
}

function renderTimerBoxContent(
  ctx: LadderRenderContext,
  t: LadderTimerNode,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  state?: NodePowerState
): React.ReactNode {
  const isTonr = t.timerType === 'TONR'
  return (
    <>
      <text x={boxX + 8} y={boxY + 34} fill="#94a3b8" fontSize="9" fontFamily="monospace">
        IN
      </text>
      <g
        data-testid="timer-pt-badge"
        className="cursor-pointer"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenTimerProp(ctx.netIdx, t.id, 'preset', t.ptOperand, e)
        }}
      >
        <text x={boxX + 8} y={boxY + (isTonr ? 50 : 54)} fill="#38bdf8" fontSize="9" fontFamily="monospace">
          PT: {t.ptOperand}
        </text>
      </g>
      {isTonr && (
        <g
          data-testid="timer-reset-badge"
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            ctx.onOpenTimerProp(ctx.netIdx, t.id, 'reset', t.rOperand || '', e)
          }}
        >
          <text x={boxX + 8} y={boxY + 68} fill="#38bdf8" fontSize="9" fontFamily="monospace">
            R: {truncPin(t.rOperand, 12)}
          </text>
        </g>
      )}
      <text x={boxX + boxWidth - 14} y={boxY + 34} fill="#94a3b8" fontSize="9" textAnchor="end" fontFamily="monospace">
        Q
      </text>
      {ctx.isMonitoring && state?.liveValues && (
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
  )
}

function renderCounterBoxContent(
  ctx: LadderRenderContext,
  cnt: LadderCounterNode,
  boxX: number,
  boxY: number,
  boxWidth: number,
  state?: NodePowerState
): React.ReactNode {
  if (cnt.counterType === 'CTUD') {
    return (
      <g data-testid={`counter-ctud-${cnt.id}`}>
        <text x={boxX + 8} y={boxY + 33} fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
          CU
        </text>
        <g
          data-testid="counter-cd-badge"
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            ctx.onOpenTimerProp(ctx.netIdx, cnt.id, 'cd', cnt.cdOperand || '', e)
          }}
        >
          <text x={boxX + 8} y={boxY + 48} fill="#38bdf8" fontSize="8.5" fontFamily="monospace">
            CD: {truncPin(cnt.cdOperand, 12)}
          </text>
        </g>
        <g
          data-testid="counter-reset-badge"
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            ctx.onOpenTimerProp(ctx.netIdx, cnt.id, 'reset', cnt.rLdOperand || '', e)
          }}
        >
          <text x={boxX + 8} y={boxY + 63} fill="#38bdf8" fontSize="8.5" fontFamily="monospace">
            R: {truncPin(cnt.rLdOperand, 12)}
          </text>
        </g>
        <g
          data-testid="counter-pv-badge"
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            ctx.onOpenTimerProp(ctx.netIdx, cnt.id, 'preset', cnt.pvOperand, e)
          }}
        >
          <text x={boxX + 8} y={boxY + 79} fill="#38bdf8" fontSize="8.5" fontFamily="monospace">
            PV: {cnt.pvOperand}
          </text>
        </g>
        <text x={boxX + boxWidth - 8} y={boxY + 33} fill="#94a3b8" fontSize="8.5" textAnchor="end" fontFamily="monospace">
          QU
        </text>
        <text x={boxX + boxWidth - 8} y={boxY + 48} fill="#94a3b8" fontSize="8.5" textAnchor="end" fontFamily="monospace">
          QD
        </text>
        <text
          data-testid="counter-live-cv"
          x={boxX + boxWidth - 8}
          y={boxY + 70}
          fill={ctx.isMonitoring ? '#10b981' : '#38bdf8'}
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
          ctx.onOpenTimerProp(ctx.netIdx, cnt.id, 'preset', cnt.pvOperand, e)
        }}
      >
        <text x={boxX + 8} y={boxY + 52} fill="#38bdf8" fontSize="9" fontFamily="monospace">
          PV: {cnt.pvOperand}
        </text>
      </g>
      {cnt.counterType === 'CTD' && (
        <g
          data-testid="counter-ld-badge"
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            ctx.onOpenTimerProp(ctx.netIdx, cnt.id, 'ld', cnt.ldOperand || cnt.rLdOperand || '', e)
          }}
        >
          <text x={boxX + 8} y={boxY + 67} fill="#38bdf8" fontSize="8.5" fontFamily="monospace">
            LD: {truncPin(cnt.ldOperand || cnt.rLdOperand, 10)}
          </text>
        </g>
      )}
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
}

function renderComparatorBoxContent(
  ctx: LadderRenderContext,
  cmp: LadderComparatorNode,
  boxX: number,
  boxY: number,
  boxWidth: number,
  isPowered: boolean,
  state?: NodePowerState
): React.ReactNode {
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
      <g
        data-testid={`comparator-op1-${cmp.id}`}
        className="cursor-pointer group/pin"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenBoxPinEdit(ctx.netIdx, cmp.id, 'comparator', 'op1', 'IN1', cmp.op1, e)
        }}
      >
        <title>IN1: {cmp.op1} (Click to edit)</title>
        <rect
          x={boxX + 4}
          y={boxY + 23}
          width={80}
          height={15}
          fill="#0b0f17"
          stroke="#1e293b"
          strokeWidth="1"
          className="group-hover/pin:stroke-[#38bdf8] transition-colors"
        />
        <text
          x={boxX + 8}
          y={boxY + 34}
          fill="#e2e8f0"
          fontSize="8.5"
          fontFamily="monospace"
          className="group-hover/pin:fill-cyan-200 transition-colors"
        >
          IN1:{truncPin(cmp.op1, 7)}
        </text>
      </g>
      <g
        data-testid={`comparator-op2-${cmp.id}`}
        className="cursor-pointer group/pin"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenBoxPinEdit(ctx.netIdx, cmp.id, 'comparator', 'op2', 'IN2', cmp.op2, e)
        }}
      >
        <title>IN2: {cmp.op2} (Click to edit)</title>
        <rect
          x={boxX + boxWidth - 84}
          y={boxY + 23}
          width={80}
          height={15}
          fill="#0b0f17"
          stroke="#1e293b"
          strokeWidth="1"
          className="group-hover/pin:stroke-[#38bdf8] transition-colors"
        />
        <text
          x={boxX + boxWidth - 8}
          y={boxY + 34}
          fill="#e2e8f0"
          fontSize="8.5"
          textAnchor="end"
          fontFamily="monospace"
          className="group-hover/pin:fill-cyan-200 transition-colors"
        >
          IN2:{truncPin(cmp.op2, 7)}
        </text>
      </g>
      <g
        data-testid={`comparator-op-${cmp.id}`}
        className="cursor-pointer group/op"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenBoxOpEdit(ctx.netIdx, cmp.id, 'comparator', cmp.comparatorType, e)
        }}
      >
        <title>Click to change operator ({opSymbol})</title>
        <rect
          x={boxX + boxWidth / 2 - 28}
          y={boxY + 42}
          width={56}
          height={16}
          fill="#0f172a"
          stroke="#334155"
          strokeWidth="1"
          className="group-hover/op:stroke-[#38bdf8] transition-colors"
        />
        <text
          x={boxX + boxWidth / 2}
          y={boxY + 53}
          fill="#38bdf8"
          fontSize="10.5"
          fontWeight="bold"
          textAnchor="middle"
          fontFamily="monospace"
          className="group-hover/op:fill-cyan-200 transition-colors"
        >
          [ {opSymbol} ]
        </text>
      </g>
      {ctx.isMonitoring && (
        <text
          x={boxX + boxWidth / 2}
          y={boxY + 69}
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
}

function renderMathBoxContent(
  ctx: LadderRenderContext,
  m: LadderMathNode,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  state?: NodePowerState
): React.ReactNode {
  const renderMathPin = (
    pinKey: MathPinKey,
    label: string,
    rawVal: string | undefined,
    rowY: number,
    alignRight = false
  ) => {
    const displayVal = rawVal ?? '??'
    const pillW = alignRight ? 82 : 94
    const pillX = alignRight ? boxX + boxWidth - pillW - 4 : boxX + 4
    const textX = alignRight ? pillX + pillW - 4 : pillX + 4
    return (
      <g
        key={pinKey}
        data-testid={`math-pin-${pinKey}-${m.id}`}
        className="cursor-pointer group/pin"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenBoxPinEdit(ctx.netIdx, m.id, 'math', pinKey, label, rawVal ?? '', e)
        }}
      >
        <title>
          {label}: {displayVal} (Click to edit)
        </title>
        <rect
          x={pillX}
          y={rowY - 10}
          width={pillW}
          height={14}
          fill="#0b0f17"
          stroke="#1e293b"
          strokeWidth="1"
          className="group-hover/pin:stroke-[#38bdf8] transition-colors"
        />
        <text
          x={textX}
          y={rowY}
          fill="#e2e8f0"
          fontSize="8.5"
          textAnchor={alignRight ? 'end' : 'start'}
          fontFamily="monospace"
          className="group-hover/pin:fill-cyan-200 transition-colors"
        >
          {label}:{truncPin(displayVal, alignRight ? 7 : 8)}
        </text>
      </g>
    )
  }

  const isScaling = m.boxType === 'NORM_X' || m.boxType === 'SCALE_X'
  const isArithmetic =
    m.boxType === 'ADD' || m.boxType === 'SUB' || m.boxType === 'MUL' || m.boxType === 'DIV'

  return (
    <g data-testid={`math-${m.id}`}>
      {isScaling ? (
        <>
          {renderMathPin('min', 'MIN', m.min ?? '0', boxY + 34)}
          {renderMathPin('value', 'VAL', m.value ?? m.in1 ?? '??', boxY + 52)}
          {renderMathPin('max', 'MAX', m.max ?? m.in2 ?? '100', boxY + 70)}
          {renderMathPin('out', 'OUT', m.out ?? '??', boxY + 34, true)}
        </>
      ) : isArithmetic ? (
        <>
          {renderMathPin('in1', 'IN1', m.in1 ?? '??', boxY + 34)}
          {renderMathPin('in2', 'IN2', m.in2 ?? '??', boxY + 54)}
          {renderMathPin('out', 'OUT', m.out ?? '??', boxY + 34, true)}
        </>
      ) : (
        <>
          {renderMathPin('in1', 'IN', m.in1 ?? '??', boxY + 34)}
          {renderMathPin('out', 'OUT', m.out ?? '??', boxY + 34, true)}
        </>
      )}

      {ctx.isMonitoring && state?.liveValues?.out !== undefined && (
        <text
          x={boxX + boxWidth - 8}
          y={boxY + boxHeight - 8}
          fill="#10b981"
          fontSize="9"
          fontWeight="bold"
          textAnchor="end"
          fontFamily="monospace"
        >
          {String(state.liveValues.out)}
        </text>
      )}
    </g>
  )
}

function renderCoilNode(
  ctx: LadderRenderContext,
  c: LadderCoilNode,
  curX: number,
  y: number,
  idx: number,
  totalNodes: number,
  currentRlo: boolean,
  isSelected: boolean,
  branchContext?: { branchId: string; branchIndex: number; incomingRlo?: boolean },
  state?: NodePowerState
): { element: React.ReactNode; dropAfter: React.ReactNode | null; nextX: number } {
  const isInsideBranch = !!branchContext
  const isLastNode = idx === totalNodes - 1
  const coilWidth = 175
  const midX = isInsideBranch
    ? curX + coilWidth / 2
    : isLastNode
    ? Math.max(curX + 60, ctx.layoutMetrics.coilX)
    : curX + coilWidth / 2
  const coilX = midX - 20
  const isDoubleCoil = ctx.conflictingOperands.has(c.operand.toLowerCase())
  const tagInfo = resolveTagFromMaps(c.operand, ctx.tagByName, ctx.tagByAddress)
  const isUnassigned = tagInfo.isUnassigned || tagInfo.symbol === '???'
  const incomingRlo = ctx.isMonitoring ? (state?.rloIn !== undefined ? state.rloIn : currentRlo) : false
  const isEnergized = ctx.isMonitoring && (state?.powered !== undefined ? state.powered : incomingRlo)
  const rightRailX = ctx.layoutMetrics.rightRailX

  const element = (
    <g
      key={c.id}
      data-node-kind="coil"
      data-testid="ladder-coil-node"
      className="cursor-pointer select-none"
      onClick={(e) => {
        e.stopPropagation()
        ctx.onSelectNode(c.id)
      }}
    >
      <rect x={coilX - 10} y={y - 25} width={60} height={50} fill="transparent" pointerEvents="all" />
      <path
        d={`M ${coilX + 12} ${y - 18} A 22 22 0 0 0 ${coilX + 12} ${y + 18}`}
        fill="none"
        stroke={isEnergized ? '#10b981' : isSelected ? '#38bdf8' : '#cbd5e1'}
        strokeWidth="3.5"
      />
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
      <path
        d={`M ${coilX + 28} ${y - 18} A 22 22 0 0 1 ${coilX + 28} ${y + 18}`}
        fill="none"
        stroke={isEnergized ? '#10b981' : isSelected ? '#38bdf8' : '#cbd5e1'}
        strokeWidth="3.5"
      />
      {isInsideBranch || !isLastNode ? (
        <line
          x1={coilX + 36}
          y1={y}
          x2={curX + coilWidth}
          y2={y}
          stroke={isEnergized ? '#10b981' : '#475569'}
          strokeWidth="2.5"
        />
      ) : (
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
      )}

      <g
        className="ladder-operand-badge cursor-pointer"
        data-ladder-node-id={c.id}
        data-ladder-operand={c.operand}
        data-ladder-node-kind="coil"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenEdit(c.operand, c.id, e)
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          ctx.onOpenEdit(c.operand, c.id, e)
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

      <g
        data-testid="coil-bottom-address"
        data-node-id={c.id}
        data-address={tagInfo.address}
        className="cursor-pointer group/addr"
        onClick={(e) => {
          e.stopPropagation()
          ctx.onOpenBitEdit(c.operand, c.id, tagInfo.address, e)
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

      {ctx.isMonitoring && isEnergized && (
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

      {ctx.isMonitoring && !isEnergized && (
        <g
          data-testid="btn-diagnose-coil"
          transform={`translate(${midX - 70}, ${y + (isDoubleCoil ? 44 : 36)})`}
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            window.dispatchEvent(
              new CustomEvent('plc:diagnose-coil', {
                detail: { operand: c.operand, networkNumber: ctx.networkNumber }
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
          <g
            data-testid="coil-selection-toolbar"
            className="select-none cursor-pointer"
            transform={`translate(${Math.max(TOOLBAR_MIN_X, midX - 90)}, ${y - 84})`}
          >
            <rect x="0" y="0" width="180" height="22" fill="#0b0f17" stroke="#38bdf8" strokeWidth="1" />
            {(
              [
                { id: 'btn-toolbar-coil-out', type: 'OUTPUT_COIL' as CoilType, x: 2, label: '( )', tip: 'Convert to Normal Output Coil' },
                { id: 'btn-toolbar-coil-neg', type: 'NEGATED_COIL' as CoilType, x: 32, label: '(/)', tip: 'Convert to Negated Output Coil' },
                { id: 'btn-toolbar-coil-set', type: 'SET_COIL' as CoilType, x: 62, label: '(S)', tip: 'Convert to Set Latch Coil' },
                { id: 'btn-toolbar-coil-reset', type: 'RESET_COIL' as CoilType, x: 92, label: '(R)', tip: 'Convert to Reset Unlatch Coil' }
              ]
            ).map((btn) => (
              <g
                key={btn.id}
                data-testid={btn.id}
                onClick={(e) => {
                  e.stopPropagation()
                  ctx.onUpdateCoilType(c.id, btn.type)
                }}
              >
                <rect x={btn.x} y="2" width="28" height="18" fill={c.coilType === btn.type ? '#0369a1' : '#1e293b'} />
                <text
                  x={btn.x + 14}
                  y="14"
                  fill={c.coilType === btn.type ? '#ffffff' : '#94a3b8'}
                  fontSize="9"
                  fontWeight="bold"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  {btn.label}
                </text>
                <title>{btn.tip}</title>
              </g>
            ))}
            <line x1="124" y1="3" x2="124" y2="19" stroke="#334155" strokeWidth="1" />
            <g
              data-testid="btn-toolbar-coil-delete"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onDeleteNode(c.id)
              }}
            >
              <rect x="130" y="2" width="46" height="18" fill="#450a0a" />
              <text x="153" y="14" fill="#f87171" fontSize="8.5" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                Delete
              </text>
              <title>Delete Coil (Del)</title>
            </g>
          </g>
        </g>
      )}

      {isDoubleCoil && (
        <text x={midX} y={y + 34} fill="#f59e0b" fontSize="9" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
          Double Coil!
        </text>
      )}
    </g>
  )

  const wireIntoCoil = (
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
  const dropBeforeCoil = renderDropTargetSquare(
    ctx,
    coilX - 18,
    y,
    {
      netIdx: ctx.netIdx,
      branchId: branchContext?.branchId,
      branchIndex: branchContext?.branchIndex,
      insertIndex: idx
    },
    `drop_before_coil_${c.id}`
  )

  let nextX = rightRailX
  let dropAfter: React.ReactNode | null = null
  if (isInsideBranch) {
    nextX = curX + coilWidth
  } else if (!isLastNode) {
    nextX = curX + coilWidth
    dropAfter = renderDropTargetSquare(
      ctx,
      nextX - 10,
      y,
      { netIdx: ctx.netIdx, insertIndex: idx + 1 },
      `drop_after_coil_${idx}_${c.id}`
    )
  }

  return {
    element: (
      <React.Fragment key={`coil_wrap_${c.id}`}>
        {dropBeforeCoil}
        {wireIntoCoil}
        {element}
      </React.Fragment>
    ),
    dropAfter,
    nextX
  }
}

export function renderLadderNodes(
  nodes: LadderNode[],
  startX: number,
  y: number,
  ctx: LadderRenderContext,
  branchContext?: { branchId: string; branchIndex: number; incomingRlo?: boolean }
): React.ReactNode {
  let curX = startX
  let currentRlo = branchContext?.incomingRlo !== undefined ? branchContext.incomingRlo : true
  const elements: React.ReactNode[] = []
  const rightRailX = ctx.layoutMetrics.rightRailX

  elements.push(
    renderDropTargetSquare(
      ctx,
      curX + 10,
      y,
      {
        netIdx: ctx.netIdx,
        branchId: branchContext?.branchId,
        branchIndex: branchContext?.branchIndex,
        insertIndex: 0
      },
      `drop_before_first_${curX}_${y}`
    )
  )

  nodes.forEach((node, idx) => {
    const isSelected = ctx.selectedNodeId === node.id
    const state = ctx.powerStates[node.id]
    const isPowered = ctx.isMonitoring && !!state?.powered

    if (node.kind === 'contact') {
      const res = renderContactNode(ctx, node as LadderContactNode, curX, y, currentRlo, isSelected, state)
      elements.push(res.element)
      curX = res.nextX
      currentRlo = res.nextRlo
      elements.push(
        renderDropTargetSquare(
          ctx,
          curX - 10,
          y,
          {
            netIdx: ctx.netIdx,
            branchId: branchContext?.branchId,
            branchIndex: branchContext?.branchIndex,
            insertIndex: idx + 1
          },
          `drop_after_contact_${idx}_${node.id}`
        )
      )
    } else if (node.kind === 'parallel') {
      const p = node as LadderParallelBranchNode
      const dropY = 120
      const branchWidth = getNodeRenderWidth(p)
      const lastBranchY = y + (p.branches.length - 1) * dropY
      const startsAtRail = curX <= POWER_RAIL_X
      const incomingRlo = ctx.isMonitoring ? (state?.rloIn !== undefined ? state.rloIn : currentRlo) : false
      const isBranchPowered = ctx.isMonitoring && !!state?.powered
      currentRlo = ctx.isMonitoring ? isBranchPowered : false

      elements.push(
        <g key={p.id}>
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

          {p.branches.map((bNodes, bIdx) => {
            const branchY = y + bIdx * dropY
            const bNodesWidth = (bNodes || []).reduce((sum, n) => sum + getNodeRenderWidth(n), 0)
            const isBranchTargetSelected =
              ctx.selectedBranchTarget?.branchId === p.id && ctx.selectedBranchTarget?.branchIndex === bIdx

            return (
              <g key={`branch_${p.id}_${bIdx}`}>
                <line
                  x1={curX}
                  y1={branchY}
                  x2={curX + 20}
                  y2={branchY}
                  stroke={incomingRlo ? '#10b981' : '#475569'}
                  strokeWidth="2.5"
                />
                {!bNodes || bNodes.length === 0 ? (
                  <g
                    data-testid={`branch-dropzone-${bIdx === 0 ? 'top' : bIdx === 1 ? 'bottom' : bIdx}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      ctx.onSelectBranchTarget(p.id, bIdx)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      e.dataTransfer.dropEffect = 'copy'
                      ctx.setHoveredDropZone({ netIdx: ctx.netIdx, branchId: p.id, branchIndex: bIdx, insertIndex: 0 })
                    }}
                    onDragLeave={(e) => {
                      e.stopPropagation()
                      ctx.setHoveredDropZone(null)
                    }}
                    onDrop={(e) =>
                      ctx.handleDropOnZone(e, { netIdx: ctx.netIdx, branchId: p.id, branchIndex: bIdx, insertIndex: 0 })
                    }
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
                    <g
                      data-testid={`branch-delete-leg-${bIdx}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        ctx.onDeleteBranchLeg(p.id, bIdx)
                      }}
                      className="hover:opacity-100 opacity-60 transition-opacity"
                    >
                      <rect x={curX + 145} y={branchY - 8} width={16} height={16} fill="#1e1e24" stroke="#ef4444" strokeWidth="1" />
                      <text x={curX + 153} y={branchY + 4} fill="#ef4444" fontSize="11" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                        x
                      </text>
                      <title>Delete Branch Tier (Heals Circuit)</title>
                    </g>
                  </g>
                ) : (
                  renderLadderNodes(bNodes, curX + 20, branchY, ctx, {
                    branchId: p.id,
                    branchIndex: bIdx,
                    incomingRlo
                  })
                )}

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

          <line
            x1={curX + branchWidth}
            y1={y}
            x2={curX + branchWidth}
            y2={lastBranchY}
            stroke={isBranchPowered ? '#10b981' : '#475569'}
            strokeWidth="2.5"
          />

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
                  ctx.onAddBranchTier(p.id)
                }}
              >
                <rect x={curX + branchWidth / 2 - 45} y={lastBranchY + 14} width="90" height="18" fill="#1e293b" stroke="#38bdf8" strokeWidth="1" />
                <text x={curX + branchWidth / 2} y={lastBranchY + 26} fill="#38bdf8" fontSize="9.5" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                  + Add Tier
                </text>
                <title>Add parallel branch tier (N &gt;= 3)</title>
              </g>
            </g>
          )}
        </g>
      )
      curX += branchWidth
      elements.push(
        renderDropTargetSquare(
          ctx,
          curX - 10,
          y,
          {
            netIdx: ctx.netIdx,
            branchId: branchContext?.branchId,
            branchIndex: branchContext?.branchIndex,
            insertIndex: idx + 1
          },
          `drop_after_branch_${idx}_${p.id}`
        )
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
          onClick={(e) => {
            e.stopPropagation()
            ctx.onSelectNode(b.id)
          }}
        >
          <line x1={curX} y1={y} x2={boxX} y2={y} stroke={isPowered ? '#10b981' : '#475569'} strokeWidth="2.5" />
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
          <rect x={boxX} y={boxY} width={boxWidth} height="18" fill="#1f2937" />
          <text x={boxX + boxWidth / 2} y={boxY + 13} fill="#f59e0b" fontSize="10" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
            {b.instruction || '???'}
          </text>
          {isSelected && (
            <rect x={boxX - 4} y={boxY - 4} width={boxWidth + 8} height={boxHeight + 8} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="4 2" />
          )}
          <line x1={boxX + boxWidth} y1={y} x2={curX + boxWidth + 30} y2={y} stroke={isPowered ? '#10b981' : '#475569'} strokeWidth="2.5" />
        </g>
      )
      curX += boxWidth + 30
      currentRlo = ctx.isMonitoring ? (state?.powered !== undefined ? state.powered : false) : false
      elements.push(
        renderDropTargetSquare(
          ctx,
          curX - 10,
          y,
          {
            netIdx: ctx.netIdx,
            branchId: branchContext?.branchId,
            branchIndex: branchContext?.branchIndex,
            insertIndex: idx + 1
          },
          `drop_after_box_${idx}_${b.id}`
        )
      )
    } else if (node.kind === 'timer' || node.kind === 'counter' || node.kind === 'comparator' || node.kind === 'math') {
      const { width: boxWidth, height: boxHeight } = getInstructionBoxDimensions(node)
      const isArithMath = node.kind === 'math' && ['ADD', 'SUB', 'MUL', 'DIV'].includes((node as LadderMathNode).boxType)
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
          onClick={(e) => {
            e.stopPropagation()
            ctx.onSelectNode(node.id)
          }}
        >
          <line x1={curX} y1={y} x2={boxX} y2={y} stroke={isPowered ? '#10b981' : '#475569'} strokeWidth="2.5" />
          <rect
            x={boxX}
            y={boxY}
            width={boxWidth}
            height={boxHeight}
            fill="#111827"
            stroke={isPowered ? '#10b981' : isSelected ? '#38bdf8' : '#374151'}
            strokeWidth={isSelected ? '2' : '1.5'}
          />

          {(node.kind === 'timer' || node.kind === 'counter') &&
            (() => {
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
                    ctx.onOpenTimerProp(ctx.netIdx, node.id, 'instance', instName, e)
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
                  <text x={boxX + boxWidth / 2} y={boxY - 4} fill="#38bdf8" fontSize="9.5" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                    {instName}
                  </text>
                </g>
              )
            })()}

          {isArithMath ? (
            <g
              data-testid={`math-op-${node.id}`}
              className="cursor-pointer group/mathhead"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onOpenBoxOpEdit(ctx.netIdx, node.id, 'math', title, e)
              }}
            >
              <title>Click to change math operation (ADD / SUB / MUL / DIV)</title>
              <rect x={boxX} y={boxY} width={boxWidth} height="18" fill="#1f2937" className="group-hover/mathhead:fill-[#283548] transition-colors" />
              <text
                x={boxX + boxWidth / 2}
                y={boxY + 13}
                fill="#38bdf8"
                fontSize="10"
                fontWeight="bold"
                textAnchor="middle"
                fontFamily="monospace"
                className="group-hover/mathhead:fill-cyan-200 transition-colors"
              >
                {title} v
              </text>
            </g>
          ) : (
            <>
              <rect x={boxX} y={boxY} width={boxWidth} height="18" fill="#1f2937" />
              <text x={boxX + boxWidth / 2} y={boxY + 13} fill="#38bdf8" fontSize="10" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                {title}
              </text>
            </>
          )}

          {node.kind === 'timer' &&
            renderTimerBoxContent(ctx, node as LadderTimerNode, boxX, boxY, boxWidth, boxHeight, state)}
          {node.kind === 'counter' &&
            renderCounterBoxContent(ctx, node as LadderCounterNode, boxX, boxY, boxWidth, state)}
          {node.kind === 'comparator' &&
            renderComparatorBoxContent(ctx, node as LadderComparatorNode, boxX, boxY, boxWidth, isPowered, state)}
          {node.kind === 'math' &&
            renderMathBoxContent(ctx, node as LadderMathNode, boxX, boxY, boxWidth, boxHeight, state)}

          {isSelected && (
            <rect x={boxX - 4} y={boxY - 4} width={boxWidth + 8} height={boxHeight + 8} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="4 2" />
          )}

          {idx === nodes.length - 1 && !branchContext ? (
            <>
              <line x1={boxX + boxWidth} y1={y} x2={rightRailX} y2={y} stroke={isPowered ? '#10b981' : '#475569'} strokeWidth="2.5" />
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
            <line x1={boxX + boxWidth} y1={y} x2={curX + boxWidth + 30} y2={y} stroke={isPowered ? '#10b981' : '#475569'} strokeWidth="2.5" />
          )}
        </g>
      )
      curX += boxWidth + 30
      currentRlo = ctx.isMonitoring ? (state?.powered !== undefined ? state.powered : false) : false
      elements.push(
        renderDropTargetSquare(
          ctx,
          curX - 10,
          y,
          {
            netIdx: ctx.netIdx,
            branchId: branchContext?.branchId,
            branchIndex: branchContext?.branchIndex,
            insertIndex: idx + 1
          },
          `drop_after_instr_${idx}_${node.id}`
        )
      )
    } else if (node.kind === 'coil') {
      const res = renderCoilNode(
        ctx,
        node as LadderCoilNode,
        curX,
        y,
        idx,
        nodes.length,
        currentRlo,
        isSelected,
        branchContext,
        state
      )
      elements.push(res.element)
      curX = res.nextX
      if (res.dropAfter) elements.push(res.dropAfter)
    }
  })

  if (!branchContext && curX < rightRailX) {
    const isRungPowered = ctx.isMonitoring ? currentRlo : false
    elements.push(
      <g key={`main_terminal_${ctx.netIdx}`} className="select-none">
        <line x1={curX} y1={y} x2={rightRailX} y2={y} stroke={isRungPowered ? '#10b981' : '#475569'} strokeWidth="2.5" />
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
