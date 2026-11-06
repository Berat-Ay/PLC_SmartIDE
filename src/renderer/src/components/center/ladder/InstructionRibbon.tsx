import React, { useState, useEffect } from 'react'
import { Plus, Minus, Code } from 'lucide-react'
import { ContactType, CoilType, TimerType, ComparatorType, MathBoxType } from '@shared/types/ladder'
import { useUIStore } from '../../../stores/useUIStore'

interface InstructionRibbonProps {
  onInsertContact: (type: ContactType) => void
  onInsertCoil: (type: CoilType) => void
  onInsertEmptyBox?: () => void
  onInsertParallelBranch: () => void
  onCloseParallelBranch?: () => void
  onInsertTimer?: (type: TimerType) => void
  onInsertComparator?: (type: ComparatorType) => void
  onInsertMath?: (type: MathBoxType) => void
  onAddNetwork: () => void
  onInsertSclNetwork: () => void
  selectedNodeId: string | null
}

export interface CustomFavoriteItem {
  id: string
  title: string
  kind: 'contact' | 'coil' | 'timer' | 'counter' | 'comparator' | 'math' | 'parallel' | 'emptyBox'
  subType?: string
}

const DEFAULT_PINNED_STORAGE_KEY = 's7_ladder_custom_favorites'

export const InstructionRibbon: React.FC<InstructionRibbonProps> = ({
  onInsertContact,
  onInsertCoil,
  onInsertEmptyBox,
  onInsertParallelBranch,
  onCloseParallelBranch,
  onAddNetwork,
  onInsertSclNetwork,
  selectedNodeId: _selectedNodeId
}) => {
  const { canvasZoom, setCanvasZoom } = useUIStore()
  const [customFavorites, setCustomFavorites] = useState<CustomFavoriteItem[]>([])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DEFAULT_PINNED_STORAGE_KEY)
      if (stored) {
        setCustomFavorites(JSON.parse(stored))
      }
    } catch {
      // ignore JSON parse error
    }

    const handleAddFav = (e: Event) => {
      const detail = (e as CustomEvent<CustomFavoriteItem>).detail
      if (!detail || !detail.id) return
      setCustomFavorites((prev) => {
        if (prev.some((f) => f.id === detail.id)) return prev
        const updated = [...prev, detail]
        try {
          localStorage.setItem(DEFAULT_PINNED_STORAGE_KEY, JSON.stringify(updated))
        } catch {
          // ignore
        }
        return updated
      })
    }

    window.addEventListener('plc:add-favorite-instruction', handleAddFav)
    return () => window.removeEventListener('plc:add-favorite-instruction', handleAddFav)
  }, [])

  const handleRemoveCustomFavorite = (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    setCustomFavorites((prev) => {
      const updated = prev.filter((f) => f.id !== id)
      try {
        localStorage.setItem(DEFAULT_PINNED_STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // ignore
      }
      return updated
    })
  }

  const handleDragStart = (
    e: React.DragEvent,
    kind: string,
    subType?: string,
    title?: string
  ) => {
    const payload = JSON.stringify({
      instructionType: kind,
      subType,
      title: title || kind
    })
    e.dataTransfer.setData('application/plc-instruction', payload)
    e.dataTransfer.effectAllowed = 'copy'
    window.dispatchEvent(
      new CustomEvent('plc:drag-instruction-start', {
        detail: { instructionType: kind, subType, title }
      })
    )
  }

  const handleDragEnd = () => {
    window.dispatchEvent(new CustomEvent('plc:drag-instruction-end'))
  }

  const handleCustomFavClick = (item: CustomFavoriteItem) => {
    if (item.kind === 'contact') {
      onInsertContact((item.subType as ContactType) || 'NO_CONTACT')
    } else if (item.kind === 'coil') {
      onInsertCoil((item.subType as CoilType) || 'OUTPUT_COIL')
    } else if (item.kind === 'emptyBox' && onInsertEmptyBox) {
      onInsertEmptyBox()
    } else if (item.kind === 'parallel') {
      onInsertParallelBranch()
    } else {
      window.dispatchEvent(
        new CustomEvent('plc:insert-custom-instruction', {
          detail: { kind: item.kind, subType: item.subType, title: item.title }
        })
      )
    }
  }

  return (
    <div
      data-testid="instruction-favorites-ribbon"
      className="h-9 bg-[#111215] border-b border-[#27272a] flex items-center justify-between px-2 text-xs select-none gap-2 shrink-0 z-30 overflow-hidden"
    >
      {/* 6 Core TIA Portal Favorites + Pinned Custom Instructions */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none py-1 min-w-0">
        <span className="under-720:hidden text-[10px] font-mono font-bold text-industrial-400 uppercase tracking-wider px-1 border-r border-[#27272a] mr-1">
          Fav
        </span>

        {/* 1. Normally Open Contact (NO) */}
        <button
          data-testid="ribbon-contact-no"
          draggable={true}
          onDragStart={(e) => handleDragStart(e, 'contact', 'NO_CONTACT', 'NO Contact')}
          onDragEnd={handleDragEnd}
          onClick={() => onInsertContact('NO_CONTACT')}
          title="Normally Open Contact (NO) - Drag or Shift+F2"
          className="h-7 px-2 flex items-center gap-1.5 bg-[#181a1f] hover:bg-[#22252c] border border-[#27272a] hover:border-cyan-500/80 text-cyan-300 hover:text-white transition-colors cursor-grab active:cursor-grabbing rounded-none shrink-0"
        >
          <svg width="28" height="20" viewBox="0 0 28 20" className="stroke-cyan-400 fill-none" strokeWidth="1.5">
            <line x1="2" y1="10" x2="10" y2="10" />
            <line x1="10" y1="4" x2="10" y2="16" />
            <line x1="18" y1="4" x2="18" y2="16" />
            <line x1="18" y1="10" x2="26" y2="10" />
          </svg>
          <span className="under-800:hidden text-[10px] font-mono font-bold text-industrial-300">NO</span>
        </button>

        {/* 2. Normally Closed Contact (NC) */}
        <button
          data-testid="ribbon-contact-nc"
          draggable={true}
          onDragStart={(e) => handleDragStart(e, 'contact', 'NC_CONTACT', 'NC Contact')}
          onDragEnd={handleDragEnd}
          onClick={() => onInsertContact('NC_CONTACT')}
          title="Normally Closed Contact (NC) - Drag or Shift+F3"
          className="h-7 px-2 flex items-center gap-1.5 bg-[#181a1f] hover:bg-[#22252c] border border-[#27272a] hover:border-cyan-500/80 text-cyan-300 hover:text-white transition-colors cursor-grab active:cursor-grabbing rounded-none shrink-0"
        >
          <svg width="28" height="20" viewBox="0 0 28 20" className="stroke-cyan-400 fill-none" strokeWidth="1.5">
            <line x1="2" y1="10" x2="10" y2="10" />
            <line x1="10" y1="4" x2="10" y2="16" />
            <line x1="8" y1="16" x2="20" y2="4" strokeWidth="1.5" />
            <line x1="18" y1="4" x2="18" y2="16" />
            <line x1="18" y1="10" x2="26" y2="10" />
          </svg>
          <span className="under-800:hidden text-[10px] font-mono font-bold text-industrial-300">NC</span>
        </button>

        {/* 3. Output Coil (Coil) */}
        <button
          data-testid="ribbon-coil"
          draggable={true}
          onDragStart={(e) => handleDragStart(e, 'coil', 'OUTPUT_COIL', 'Output Coil')}
          onDragEnd={handleDragEnd}
          onClick={() => onInsertCoil('OUTPUT_COIL')}
          title="Output Coil (Coil) - Drag or F7"
          className="h-7 px-2 flex items-center gap-1.5 bg-[#181a1f] hover:bg-[#22252c] border border-[#27272a] hover:border-emerald-500/80 text-emerald-400 hover:text-white transition-colors cursor-grab active:cursor-grabbing rounded-none shrink-0"
        >
          <svg width="28" height="20" viewBox="0 0 28 20" className="stroke-emerald-400 fill-none" strokeWidth="1.5">
            <line x1="2" y1="10" x2="8" y2="10" />
            <path d="M 10 4 A 8 8 0 0 0 10 16" />
            <path d="M 18 4 A 8 8 0 0 1 18 16" />
            <line x1="20" y1="10" x2="26" y2="10" />
          </svg>
          <span className="under-800:hidden text-[10px] font-mono font-bold text-industrial-300">Coil</span>
        </button>

        {/* 4. Empty Instruction Box ([??]) */}
        <button
          data-testid="ribbon-box"
          draggable={true}
          onDragStart={(e) => handleDragStart(e, 'emptyBox', 'EMPTY_BOX', 'Instruction Box')}
          onDragEnd={handleDragEnd}
          onClick={() => (onInsertEmptyBox ? onInsertEmptyBox() : onInsertContact('NO_CONTACT'))}
          title="Empty Instruction Box ([??]) - Drag or type instruction name"
          className="h-7 px-2 flex items-center gap-1.5 bg-[#181a1f] hover:bg-[#22252c] border border-[#27272a] hover:border-amber-500/80 text-amber-400 hover:text-white transition-colors cursor-grab active:cursor-grabbing rounded-none shrink-0"
        >
          <svg width="28" height="20" viewBox="0 0 28 20" className="stroke-amber-400 fill-none" strokeWidth="1.5">
            <line x1="2" y1="10" x2="6" y2="10" />
            <rect x="6" y="3" width="16" height="14" fill="#14161b" stroke="#f59e0b" strokeWidth="1.5" />
            <text x="14" y="13" fill="#f59e0b" fontSize="8" fontWeight="bold" textAnchor="middle" fontFamily="monospace" stroke="none">
              ??
            </text>
            <line x1="22" y1="10" x2="26" y2="10" />
          </svg>
          <span className="under-800:hidden text-[10px] font-mono font-bold text-industrial-300">[??]</span>
        </button>

        {/* 5. Open Parallel Branch */}
        <button
          data-testid="ribbon-branch"
          draggable={true}
          onDragStart={(e) => handleDragStart(e, 'parallel', 'OPEN_BRANCH', 'Open Branch')}
          onDragEnd={handleDragEnd}
          onClick={onInsertParallelBranch}
          title="Open Parallel Branch - Drag or Ctrl+B"
          className="h-7 px-2 flex items-center gap-1.5 bg-[#181a1f] hover:bg-[#22252c] border border-[#27272a] hover:border-indigo-500/80 text-indigo-300 hover:text-white transition-colors cursor-grab active:cursor-grabbing rounded-none shrink-0"
        >
          <svg width="28" height="20" viewBox="0 0 28 20" className="stroke-indigo-400 fill-none" strokeWidth="1.5">
            <line x1="2" y1="5" x2="26" y2="5" />
            <path d="M 10 5 L 10 15 L 26 15" />
          </svg>
          <span className="under-800:hidden text-[10px] font-mono font-bold text-industrial-300">Open</span>
        </button>

        {/* 6. Close Parallel Branch */}
        <button
          data-testid="ribbon-branch-close"
          onClick={() => (onCloseParallelBranch ? onCloseParallelBranch() : undefined)}
          title="Close Parallel Branch (Merges branch leg)"
          className="h-7 px-2 flex items-center gap-1.5 bg-[#181a1f] hover:bg-[#22252c] border border-[#27272a] hover:border-indigo-500/80 text-indigo-300 hover:text-white transition-colors rounded-none shrink-0"
        >
          <svg width="28" height="20" viewBox="0 0 28 20" className="stroke-indigo-400 fill-none" strokeWidth="1.5">
            <line x1="2" y1="5" x2="26" y2="5" />
            <path d="M 2 15 L 18 15 L 18 5" />
          </svg>
          <span className="under-800:hidden text-[10px] font-mono font-bold text-industrial-300">Close</span>
        </button>

        {/* Pinned Custom Favorites */}
        {customFavorites.map((fav) => (
          <button
            key={fav.id}
            data-testid={`ribbon-custom-${fav.id}`}
            draggable={true}
            onDragStart={(e) => handleDragStart(e, fav.kind, fav.subType, fav.title)}
            onDragEnd={handleDragEnd}
            onClick={() => handleCustomFavClick(fav)}
            onContextMenu={(e) => handleRemoveCustomFavorite(fav.id, e)}
            title={`${fav.title} (Right-click to remove from Favorites)`}
            className="h-7 px-2 flex items-center gap-1 bg-[#181a1f] hover:bg-[#22252c] border border-[#3b4252] text-industrial-200 hover:text-white transition-colors cursor-grab active:cursor-grabbing rounded-none shrink-0"
          >
            <span className="text-[10px] font-mono font-bold text-purple-300">{fav.title}</span>
          </button>
        ))}
      </div>

      {/* Right Controls: Zoom Toolbar + Add Network / Insert SCL Network */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Canvas Zoom Controls: [ - ] [50%] [75%] [100%] [125%] [ + ] [Fit] */}
        <div data-testid="ladder-zoom-toolbar" className="flex items-center bg-[#14161b] border border-[#27272a] h-7 px-0.5 gap-0.5">
          <button
            data-testid="btn-zoom-out"
            onClick={() => setCanvasZoom(canvasZoom - 0.25)}
            title="Zoom Out (Ctrl+Minus)"
            className="h-6 w-5 flex items-center justify-center hover:bg-[#27272a] text-industrial-400 hover:text-white transition-colors"
          >
            <Minus className="w-3 h-3" />
          </button>
          <button
            data-testid="btn-zoom-50"
            onClick={() => setCanvasZoom(0.5)}
            title="Zoom to 50%"
            className={`under-600:hidden px-1 h-6 flex items-center text-[9.5px] font-mono font-bold transition-colors ${Math.abs(canvasZoom - 0.5) < 0.05 ? 'bg-[#1f242d] text-cyan-400' : 'text-industrial-400 hover:text-white'
              }`}
          >
            50%
          </button>
          <button
            data-testid="btn-zoom-75"
            onClick={() => setCanvasZoom(0.75)}
            title="Zoom to 75%"
            className={`under-600:hidden px-1 h-6 flex items-center text-[9.5px] font-mono font-bold transition-colors ${Math.abs(canvasZoom - 0.75) < 0.05 ? 'bg-[#1f242d] text-cyan-400' : 'text-industrial-400 hover:text-white'
              }`}
          >
            75%
          </button>
          <button
            data-testid="btn-zoom-reset"
            onClick={() => setCanvasZoom(1.0)}
            title="Zoom to 100% (Reset)"
            className={`px-1 h-6 flex items-center text-[9.5px] font-mono font-bold transition-colors ${Math.abs(canvasZoom - 1.0) < 0.05 ? 'bg-[#1f242d] text-cyan-400' : 'text-industrial-400 hover:text-white'
              }`}
          >
            100%
          </button>
          <button
            data-testid="btn-zoom-125"
            onClick={() => setCanvasZoom(1.25)}
            title="Zoom to 125%"
            className={`under-600:hidden px-1 h-6 flex items-center text-[9.5px] font-mono font-bold transition-colors ${Math.abs(canvasZoom - 1.25) < 0.05 ? 'bg-[#1f242d] text-cyan-400' : 'text-industrial-400 hover:text-white'
              }`}
          >
            125%
          </button>
          <button
            data-testid="btn-zoom-in"
            onClick={() => setCanvasZoom(canvasZoom + 0.25)}
            title="Zoom In (Ctrl+Plus)"
            className="h-6 w-5 flex items-center justify-center hover:bg-[#27272a] text-industrial-400 hover:text-white transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
          <div className="w-px h-3.5 bg-[#27272a] mx-0.5" />
          <button
            data-testid="btn-zoom-fit"
            onClick={() => setCanvasZoom(0.75)}
            title="Fit Rung to Viewport Width"
            className="px-1.5 h-6 flex items-center text-[9.5px] font-mono font-bold text-industrial-300 hover:text-white transition-colors"
          >
            Fit
          </button>
        </div>

        <button
          data-testid="ribbon-add-network"
          onClick={onAddNetwork}
          title="Add New Ladder Network Below (Ctrl+R)"
          className="h-7 px-2.5 flex items-center gap-1 text-[11px] font-mono font-semibold bg-[#181a1f] hover:bg-[#242730] border border-[#27272a] text-[#00a3a6] hover:text-white transition-colors rounded-none"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="under-900:hidden">Network</span>
        </button>
        <button
          data-testid="ribbon-add-scl-network"
          onClick={onInsertSclNetwork}
          title="Insert SCL Network (Hybrid S7 Block)"
          className="h-7 px-2.5 flex items-center gap-1 text-[11px] font-mono font-semibold bg-[#181a1f] hover:bg-[#242730] border border-[#27272a] text-blue-400 hover:text-white transition-colors rounded-none"
        >
          <Code className="w-3.5 h-3.5" />
          <span className="under-900:hidden">SCL</span>
        </button>
      </div>
    </div>
  )
}
