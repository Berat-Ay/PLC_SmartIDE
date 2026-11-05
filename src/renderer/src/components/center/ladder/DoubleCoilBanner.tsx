import React from 'react'
import { AlertTriangle, Zap, CheckCircle2 } from 'lucide-react'
import { DoubleCoilConflict, DoubleCoilDetector } from '../../../services/DoubleCoilDetector'
import { useBlockStore } from '../../../stores/useBlockStore'
import { useProjectStore } from '../../../stores/useProjectStore'
import { LadBlockDefinition } from '@shared/types/blocks'

interface DoubleCoilBannerProps {
  block: LadBlockDefinition
  conflicts: DoubleCoilConflict[]
}

export const DoubleCoilBanner: React.FC<DoubleCoilBannerProps> = ({ block, conflicts }) => {
  const { updateLadBlock } = useBlockStore()
  const { markDirty } = useProjectStore()

  if (conflicts.length === 0) return null

  const handleAutoMerge = (operand: string) => {
    const refactored = DoubleCoilDetector.autoRefactorBlock(block, operand)
    updateLadBlock(block.fileName, refactored)
    markDirty(true)
  }

  return (
    <div className="bg-amber-950/80 border-b border-amber-600 px-4 py-2 text-xs flex flex-col gap-1.5 select-none animate-in fade-in duration-200">
      {conflicts.map((c) => (
        <div key={c.normalizedOperand} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 animate-pulse" />
            <span>
              <strong>Double Coil Syndrome Detected:</strong> Standard assignment coil on operand{' '}
              <span className="font-mono font-bold text-white bg-amber-900/60 px-1.5 py-0.5 rounded border border-amber-700">
                "{c.operand}"
              </span>{' '}
              is driven in Networks{' '}
              <strong className="text-white">{c.networkNumbers.join(' & ')}</strong>. The cyclic scan will overwrite earlier logic!
            </span>
          </div>

          <button
            onClick={() => handleAutoMerge(c.operand)}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold text-white bg-amber-600 hover:bg-amber-500 shadow-md shadow-amber-950 transition-all shrink-0 cursor-pointer hover:scale-105 active:scale-95"
            title="Automatically generate intermediate booleans and an OR-mapped output network"
          >
            <Zap className="w-3.5 h-3.5 fill-current" />
            <span>1-Click Auto-Merge Coils</span>
          </button>
        </div>
      ))}
    </div>
  )
}

