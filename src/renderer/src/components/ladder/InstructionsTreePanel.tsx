import React, { useState } from 'react'
import {
  Search,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Pin,
  Binary,
  Clock,
  Calculator,
  GitCompare,
  ArrowRightLeft,
  Cpu
} from 'lucide-react'

export interface InstructionDef {
  id: string
  name: string
  title: string
  description: string
  kind: 'contact' | 'coil' | 'timer' | 'counter' | 'comparator' | 'math' | 'parallel' | 'emptyBox'
  subType?: string
  icon?: string
}

export interface InstructionCategory {
  id: string
  name: string
  icon: React.ComponentType<{ className?: string }>
  instructions: InstructionDef[]
}

const INSTRUCTION_CATEGORIES: InstructionCategory[] = [
  {
    id: 'bit_logic',
    name: 'Bit logic operations',
    icon: Binary,
    instructions: [
      { id: 'no_contact', name: 'NO', title: 'Normally Open Contact', description: 'Scans for signal state 1 (ON)', kind: 'contact', subType: 'NO_CONTACT' },
      { id: 'nc_contact', name: 'NC', title: 'Normally Closed Contact', description: 'Scans for signal state 0 (OFF)', kind: 'contact', subType: 'NC_CONTACT' },
      { id: 'not_contact', name: 'NOT', title: 'Invert RLO', description: 'Inverts current Result of Logic Operation', kind: 'contact', subType: 'NC_CONTACT' },
      { id: 'coil_assignment', name: 'Coil', title: 'Assignment Output Coil', description: 'Assigns RLO to memory address', kind: 'coil', subType: 'OUTPUT_COIL' },
      { id: 'coil_negated', name: 'Negated Coil', title: 'Negated Output Coil --(/ )--', description: 'Assigns inverted RLO to address', kind: 'coil', subType: 'NEGATED_COIL' },
      { id: 'coil_set', name: 'Set Coil', title: 'Set Latch Coil --(S)--', description: 'Latches bit to 1 when RLO is 1', kind: 'coil', subType: 'SET_COIL' },
      { id: 'coil_reset', name: 'Reset Coil', title: 'Reset Unlatch Coil --(R)--', description: 'Unlatches bit to 0 when RLO is 1', kind: 'coil', subType: 'RESET_COIL' },
      { id: 'sr_flipflop', name: 'SR', title: 'Set-Reset Flip-Flop Box', description: 'Bistable latch with Set priority', kind: 'emptyBox', subType: 'SR' },
      { id: 'rs_flipflop', name: 'RS', title: 'Reset-Set Flip-Flop Box', description: 'Bistable latch with Reset priority', kind: 'emptyBox', subType: 'RS' },
      { id: 'p_trig', name: 'P_TRIG', title: 'Positive Signal Edge Contact', description: 'Detects rising edge (0 -> 1)', kind: 'contact', subType: 'P_TRIG' },
      { id: 'n_trig', name: 'N_TRIG', title: 'Negative Signal Edge Contact', description: 'Detects falling edge (1 -> 0)', kind: 'contact', subType: 'N_TRIG' }
    ]
  },
  {
    id: 'timer_operations',
    name: 'Timer operations',
    icon: Clock,
    instructions: [
      { id: 'timer_tp', name: 'TP', title: 'Generate Pulse Timer', description: 'Generates output pulse of preset duration', kind: 'timer', subType: 'TP' },
      { id: 'timer_ton', name: 'TON', title: 'Generate On-Delay Timer', description: 'Delays setting output by preset time', kind: 'timer', subType: 'TON' },
      { id: 'timer_tof', name: 'TOF', title: 'Generate Off-Delay Timer', description: 'Delays resetting output by preset time', kind: 'timer', subType: 'TOF' },
      { id: 'timer_tonr', name: 'TONR', title: 'Time Accumulator / Retentive Timer', description: 'Accumulates time over multiple runs', kind: 'timer', subType: 'TON' },
      { id: 'timer_rt', name: 'RT', title: 'Reset Timer', description: 'Resets timer elapsed time to 0', kind: 'emptyBox', subType: 'RT' }
    ]
  },
  {
    id: 'counter_operations',
    name: 'Counter operations',
    icon: Calculator,
    instructions: [
      { id: 'counter_ctu', name: 'CTU', title: 'Count Up', description: 'Increments counter on rising edge', kind: 'counter', subType: 'CTU' },
      { id: 'counter_ctd', name: 'CTD', title: 'Count Down', description: 'Decrements counter on rising edge', kind: 'counter', subType: 'CTD' },
      { id: 'counter_ctud', name: 'CTUD', title: 'Count Up and Down', description: 'Bidirectional pulse counter', kind: 'counter', subType: 'CTU' }
    ]
  },
  {
    id: 'comparator_operations',
    name: 'Comparator operations',
    icon: GitCompare,
    instructions: [
      { id: 'cmp_eq', name: 'CMP ==', title: 'Equal', description: 'Checks if IN1 is equal to IN2', kind: 'comparator', subType: 'CMP_EQ' },
      { id: 'cmp_ne', name: 'CMP <>', title: 'Not Equal', description: 'Checks if IN1 is not equal to IN2', kind: 'comparator', subType: 'CMP_NE' },
      { id: 'cmp_ge', name: 'CMP >=', title: 'Greater or Equal', description: 'Checks if IN1 >= IN2', kind: 'comparator', subType: 'CMP_GE' },
      { id: 'cmp_le', name: 'CMP <=', title: 'Less or Equal', description: 'Checks if IN1 <= IN2', kind: 'comparator', subType: 'CMP_LE' },
      { id: 'cmp_gt', name: 'CMP >', title: 'Greater Than', description: 'Checks if IN1 > IN2', kind: 'comparator', subType: 'CMP_GT' },
      { id: 'cmp_lt', name: 'CMP <', title: 'Less Than', description: 'Checks if IN1 < IN2', kind: 'comparator', subType: 'CMP_LT' },
      { id: 'cmp_in_range', name: 'IN_RANGE', title: 'Value Within Range', description: 'Checks if MIN <= VAL <= MAX', kind: 'comparator', subType: 'CMP_GE' },
      { id: 'cmp_out_range', name: 'OUT_RANGE', title: 'Value Outside Range', description: 'Checks if VAL < MIN or VAL > MAX', kind: 'comparator', subType: 'CMP_LT' }
    ]
  },
  {
    id: 'math_functions',
    name: 'Math functions',
    icon: Calculator,
    instructions: [
      { id: 'math_add', name: 'ADD', title: 'Add', description: 'Calculates OUT := IN1 + IN2', kind: 'math', subType: 'ADD' },
      { id: 'math_sub', name: 'SUB', title: 'Subtract', description: 'Calculates OUT := IN1 - IN2', kind: 'math', subType: 'SUB' },
      { id: 'math_mul', name: 'MUL', title: 'Multiply', description: 'Calculates OUT := IN1 * IN2', kind: 'math', subType: 'MUL' },
      { id: 'math_div', name: 'DIV', title: 'Divide', description: 'Calculates OUT := IN1 / IN2', kind: 'math', subType: 'DIV' },
      { id: 'math_mod', name: 'MOD', title: 'Return Remainder', description: 'Calculates OUT := IN1 MOD IN2', kind: 'math', subType: 'DIV' },
      { id: 'math_abs', name: 'ABS', title: 'Absolute Value', description: 'Calculates absolute value of input', kind: 'math', subType: 'MOVE' },
      { id: 'math_min', name: 'MIN', title: 'Get Minimum', description: 'Returns smaller of two inputs', kind: 'math', subType: 'MOVE' },
      { id: 'math_max', name: 'MAX', title: 'Get Maximum', description: 'Returns larger of two inputs', kind: 'math', subType: 'MOVE' },
      { id: 'math_limit', name: 'LIMIT', title: 'Set Limit', description: 'Clamps input between MIN and MAX', kind: 'math', subType: 'MOVE' }
    ]
  },
  {
    id: 'move_convert',
    name: 'Move & Conversion operations',
    icon: ArrowRightLeft,
    instructions: [
      { id: 'move_val', name: 'MOVE', title: 'Move Value', description: 'Copies content of IN to OUT', kind: 'math', subType: 'MOVE' },
      { id: 'norm_x', name: 'NORM_X', title: 'Normalize', description: 'Normalizes raw count 0..27648 to 0.0..1.0', kind: 'math', subType: 'NORM_X' },
      { id: 'scale_x', name: 'SCALE_X', title: 'Scale', description: 'Scales normalized 0.0..1.0 to engineering units', kind: 'math', subType: 'SCALE_X' },
      { id: 'convert_type', name: 'CONVERT', title: 'Convert Data Type', description: 'Converts data types (e.g. INT to REAL)', kind: 'math', subType: 'MOVE' }
    ]
  },
  {
    id: 'program_control',
    name: 'Program control operations',
    icon: Cpu,
    instructions: [
      { id: 'block_call', name: 'Block Call (FB/FC)', title: 'Call Project Block', description: 'Calls FB or FC with parameter interface', kind: 'emptyBox', subType: 'CALL' },
      { id: 'ret_inst', name: 'RET', title: 'Return from Block', description: 'Exits execution of current block', kind: 'emptyBox', subType: 'RET' }
    ]
  }
]

export const InstructionsTreePanel: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({
    bit_logic: false,
    timer_operations: false,
    counter_operations: false,
    comparator_operations: false,
    math_functions: false,
    move_convert: false,
    program_control: false
  })
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    instruction: InstructionDef
  } | null>(null)

  const toggleFolder = (folderId: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [folderId]: !prev[folderId] }))
  }

  const handleDragStart = (e: React.DragEvent, item: InstructionDef) => {
    const payload = JSON.stringify({
      instructionType: item.kind,
      subType: item.subType,
      title: item.name
    })
    e.dataTransfer.setData('application/plc-instruction', payload)
    e.dataTransfer.effectAllowed = 'copy'
    window.dispatchEvent(
      new CustomEvent('plc:drag-instruction-start', {
        detail: { instructionType: item.kind, subType: item.subType, title: item.name }
      })
    )
  }

  const handleDragEnd = () => {
    window.dispatchEvent(new CustomEvent('plc:drag-instruction-end'))
  }

  const handleInsertClick = (item: InstructionDef) => {
    window.dispatchEvent(
      new CustomEvent('plc:insert-custom-instruction', {
        detail: { kind: item.kind, subType: item.subType, title: item.name }
      })
    )
  }

  const handleContextMenu = (e: React.MouseEvent, item: InstructionDef) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      instruction: item
    })
  }

  const handlePinToFavorites = (item: InstructionDef) => {
    window.dispatchEvent(
      new CustomEvent('plc:add-favorite-instruction', {
        detail: {
          id: item.id,
          title: item.name,
          kind: item.kind,
          subType: item.subType
        }
      })
    )
    setContextMenu(null)
  }

  const filterQuery = searchQuery.trim().toLowerCase()

  return (
    <div
      data-testid="instructions-tree-panel"
      className="h-full flex flex-col bg-[#111215] text-industrial-100 font-sans select-none overflow-hidden"
      onClick={() => setContextMenu(null)}
    >
      {/* Top Search Input */}
      <div className="p-2 border-b border-[#27272a] bg-[#14161b] shrink-0">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 text-industrial-400 absolute left-2 pointer-events-none" />
          <input
            data-testid="instructions-search-input"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search instructions (e.g. TON, CTU, SCALE_X, SR)..."
            className="w-full h-7 pl-7 pr-2 bg-[#0c0d10] border border-[#27272a] hover:border-cyan-500/60 focus:border-cyan-400 text-[11px] font-mono text-industrial-100 placeholder:text-industrial-500 rounded-none focus:outline-hidden transition-colors"
          />
        </div>
      </div>

      {/* Instructions Tree View */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {INSTRUCTION_CATEGORIES.map((cat) => {
          const isOpen = !collapsedFolders[cat.id]
          const matchingInstructions = cat.instructions.filter(
            (inst) =>
              inst.name.toLowerCase().includes(filterQuery) ||
              inst.title.toLowerCase().includes(filterQuery) ||
              inst.description.toLowerCase().includes(filterQuery)
          )

          if (filterQuery && matchingInstructions.length === 0) {
            return null
          }

          const itemsToRender = filterQuery ? matchingInstructions : cat.instructions

          return (
            <div key={cat.id} className="border border-[#1e2025] bg-[#13151a]">
              {/* Folder Header */}
              <button
                data-testid={`instruction-folder-${cat.id}`}
                onClick={() => toggleFolder(cat.id)}
                className="w-full h-7 px-2 flex items-center justify-between text-left hover:bg-[#1c1e24] transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {isOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-industrial-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-industrial-400 shrink-0" />
                  )}
                  {isOpen ? (
                    <FolderOpen className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                  )}
                  <span className="text-xs font-semibold text-industrial-200 truncate">
                    {cat.name}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-industrial-500 px-1 bg-[#1a1d24]">
                  {itemsToRender.length}
                </span>
              </button>

              {/* Folder Items */}
              {isOpen && (
                <div className="divide-y divide-[#1e2025] border-t border-[#1e2025] bg-[#0e1014]">
                  {itemsToRender.map((item) => (
                    <div
                      key={item.id}
                      data-testid={`instruction-item-${item.id}`}
                      draggable={true}
                      onDragStart={(e) => handleDragStart(e, item)}
                      onDragEnd={handleDragEnd}
                      onClick={() => handleInsertClick(item)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      title={`${item.title}\n${item.description}\n(Drag onto Ladder wire or double-click to insert, Right-click to Add to Favorites)`}
                      className="relative px-3 py-1.5 flex items-center justify-between hover:bg-[#1a202c] cursor-grab active:cursor-grabbing group transition-colors select-none"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-xs font-bold text-cyan-300 w-24 shrink-0 truncate">
                          {item.name}
                        </span>
                        <span className="text-[11px] text-industrial-300 truncate">
                          {item.title}
                        </span>
                      </div>
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-[#1a202c]">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handlePinToFavorites(item)
                          }}
                          title="Pin to Favorites Ribbon"
                          className="p-1 hover:text-amber-300 text-industrial-400 transition-colors"
                        >
                          <Pin className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          data-testid="instruction-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed bg-[#181a20] border border-[#27272a] shadow-2xl py-1 z-50 text-xs min-w-[160px] font-sans"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handlePinToFavorites(contextMenu.instruction)}
            className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-cyan-600/30 flex items-center gap-2"
          >
            <Pin className="w-3.5 h-3.5 text-amber-400" />
            <span>Add to Favorites Ribbon</span>
          </button>
        </div>
      )}
    </div>
  )
}

