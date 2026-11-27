import React from 'react'
import { BlockInterface } from '@shared/types/blocks'
import { TagAutocompleteCombobox } from './TagAutocompleteCombobox'
import {
  ARITHMETIC_MATH_OPTIONS,
  COMPARATOR_OPERATOR_OPTIONS,
  ComparatorPinKey,
  MathPinKey
} from '../../../utils/ladderBoxEdits'
import type { TimerPropType } from './LadderNodeRenderers'

export interface EditingOperandState {
  netIdx: number
  nodeId: string
  currentOperand: string
  pos: { x: number; y: number }
}

export interface EditingAddressState {
  netIdx: number
  nodeId: string
  currentOperand: string
  currentAddress: string
  pos: { x: number; y: number }
}

export interface EditingTimerPropState {
  netIdx: number
  nodeId: string
  propType: TimerPropType
  currentVal: string
  pos: { x: number; y: number }
}

export interface EditingBoxPinState {
  netIdx: number
  nodeId: string
  kind: 'comparator' | 'math'
  pin: ComparatorPinKey | MathPinKey
  label: string
  currentValue: string
  pos: { x: number; y: number }
}

export interface EditingBoxOpState {
  netIdx: number
  nodeId: string
  kind: 'comparator' | 'math'
  currentOp: string
  pos: { x: number; y: number }
}

interface LadderInlinePopoversProps {
  blockInterface: BlockInterface
  editingNode: EditingOperandState | null
  onSelectOperand: (val: string) => void
  onCloseOperand: () => void
  editingAddressNode: EditingAddressState | null
  addressInputValue: string
  addressError: string | null
  onAddressInputChange: (val: string) => void
  onSubmitAddress: (val: string) => void
  onCloseAddress: () => void
  editingTimerProp: EditingTimerPropState | null
  timerPropInputValue: string
  onTimerPropInputChange: (val: string) => void
  onSubmitTimerProp: (val: string) => void
  onCloseTimerProp: () => void
  editingBoxPin: EditingBoxPinState | null
  onSelectBoxPin: (val: string) => void
  onCloseBoxPin: () => void
  editingBoxOp: EditingBoxOpState | null
  onSelectBoxOp: (op: string) => void
  onCloseBoxOp: () => void
}

function timerPropHeading(propType: TimerPropType): string {
  switch (propType) {
    case 'instance':
      return 'Instance Name (e.g. T1, C1)'
    case 'preset':
      return 'Preset Value (e.g. T#10s, 5)'
    case 'reset':
      return 'Reset Input Tag / Bit (R)'
    case 'cd':
      return 'Count Down Input Tag / Bit (CD)'
    case 'ld':
      return 'Load Input Tag / Bit (LD)'
  }
}

export const LadderInlinePopovers: React.FC<LadderInlinePopoversProps> = ({
  blockInterface,
  editingNode,
  onSelectOperand,
  onCloseOperand,
  editingAddressNode,
  addressInputValue,
  addressError,
  onAddressInputChange,
  onSubmitAddress,
  onCloseAddress,
  editingTimerProp,
  timerPropInputValue,
  onTimerPropInputChange,
  onSubmitTimerProp,
  onCloseTimerProp,
  editingBoxPin,
  onSelectBoxPin,
  onCloseBoxPin,
  editingBoxOp,
  onSelectBoxOp,
  onCloseBoxOp
}) => {
  return (
    <>
      {editingNode && (
        <TagAutocompleteCombobox
          currentValue={editingNode.currentOperand}
          blockInterface={blockInterface}
          position={editingNode.pos}
          onSelect={onSelectOperand}
          onClose={onCloseOperand}
        />
      )}

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
            onChange={(e) => onAddressInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const val = (e.target as HTMLInputElement).value || addressInputValue
                onSubmitAddress(val)
              } else if (e.key === 'Escape') {
                onCloseAddress()
              }
            }}
            onBlur={(e) => {
              const val = (e.target as HTMLInputElement).value || addressInputValue
              if (val.trim()) onSubmitAddress(val)
              else onCloseAddress()
            }}
            placeholder="%Q0.5 or q0.5"
            className="h-6 px-1.5 py-0.5 bg-[#09090b] text-[#38bdf8] border border-[#38bdf8] font-mono text-xs rounded-none outline-none focus:ring-1 focus:ring-[#38bdf8]"
          />
          {addressError && <div className="text-[10px] text-red-400 font-mono">{addressError}</div>}
          <div className="text-[9px] font-mono text-industrial-500">
            Auto-normalizes e.g. q0.5, i0.1, e0.0, a0.5
          </div>
        </div>
      )}

      {editingTimerProp && (
        <div
          style={{
            position: 'fixed',
            left: editingTimerProp.pos.x,
            top: editingTimerProp.pos.y,
            zIndex: 60
          }}
          className="bg-[#111317] border border-[#00a3a6] p-1.5 shadow-2xl flex flex-col gap-1 min-w-[165px] rounded-none select-none"
        >
          <div className="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">
            {timerPropHeading(editingTimerProp.propType)}
          </div>
          <input
            data-testid="inline-timer-prop-input"
            type="text"
            autoFocus
            value={timerPropInputValue}
            onChange={(e) => onTimerPropInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const val = (e.target as HTMLInputElement).value || timerPropInputValue
                onSubmitTimerProp(val)
              } else if (e.key === 'Escape') {
                onCloseTimerProp()
              }
            }}
            onBlur={(e) => {
              const val = (e.target as HTMLInputElement).value || timerPropInputValue
              if (val.trim()) onSubmitTimerProp(val)
              else onCloseTimerProp()
            }}
            placeholder={
              editingTimerProp.propType === 'instance'
                ? 'T1'
                : editingTimerProp.propType === 'preset'
                ? 'T#10s'
                : '%I0.1'
            }
            className="h-6 px-1.5 py-0.5 bg-[#09090b] text-[#38bdf8] border border-[#38bdf8] font-mono text-xs rounded-none outline-none focus:ring-1 focus:ring-[#38bdf8]"
          />
          <div className="text-[9px] font-mono text-industrial-500">
            {editingTimerProp.propType === 'instance'
              ? 'Unique S7 Timer/Counter DB Instance'
              : editingTimerProp.propType === 'preset'
              ? 'Time or count preset (T#10s, 10)'
              : 'Symbolic tag or S7 bit address'}
          </div>
        </div>
      )}

      {editingBoxPin && (
        <TagAutocompleteCombobox
          currentValue={editingBoxPin.currentValue}
          blockInterface={blockInterface}
          position={editingBoxPin.pos}
          allowLiterals={true}
          title={`Edit ${editingBoxPin.label} Pin`}
          placeholder="Tag, C1.CV, DB member, or literal (10, 8.0)..."
          onSelect={onSelectBoxPin}
          onClose={onCloseBoxPin}
        />
      )}

      {editingBoxOp && (
        <div
          data-testid="box-operator-popover"
          style={{
            position: 'fixed',
            left: editingBoxOp.pos.x,
            top: editingBoxOp.pos.y,
            zIndex: 60
          }}
          className="bg-[#111317] border border-[#00a3a6] p-1.5 shadow-2xl flex flex-col gap-1 min-w-[165px] rounded-none select-none"
        >
          <div className="flex items-center justify-between gap-2 text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">
            <span>{editingBoxOp.kind === 'comparator' ? 'Comparator Operator' : 'Math Operation'}</span>
            <button
              type="button"
              onClick={onCloseBoxOp}
              className="text-industrial-400 hover:text-white px-1 rounded-none"
              title="Close"
            >
              x
            </button>
          </div>
          <select
            data-testid="box-operator-select"
            autoFocus
            value={editingBoxOp.currentOp}
            onChange={(e) => onSelectBoxOp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCloseBoxOp()
            }}
            onBlur={onCloseBoxOp}
            className="h-6 px-1.5 py-0.5 bg-[#09090b] text-[#38bdf8] border border-[#38bdf8] font-mono text-xs rounded-none outline-none focus:ring-1 focus:ring-[#38bdf8]"
          >
            {editingBoxOp.kind === 'comparator'
              ? COMPARATOR_OPERATOR_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))
              : ARITHMETIC_MATH_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
          </select>
        </div>
      )}
    </>
  )
}
