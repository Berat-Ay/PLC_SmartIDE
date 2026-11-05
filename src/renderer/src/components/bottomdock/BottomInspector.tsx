import React, { useState, useRef, useEffect } from 'react'
import {
  AlertCircle,
  Search,
  Grid,
  ChevronDown,
  ChevronUp,
  X,
  Activity
} from 'lucide-react'
import { useUIStore } from '../../stores/useUIStore'
import { useTagStore } from '../../stores/useTagStore'
import { CompileMessagesTab } from './CompileMessagesTab'
import { CrossReferenceTab } from './CrossReferenceTab'
import { MemoryMapVisualizer } from './MemoryMapVisualizer'
import { TraceOscilloscope } from '../simulation/TraceOscilloscope'

export const BottomInspector: React.FC = () => {
  const {
    bottomDockCollapsed,
    bottomDockHeight,
    bottomActiveTab,
    setBottomActiveTab,
    toggleBottomDock,
    setBottomDockHeight
  } = useUIStore()
  const { totalCollisions } = useTagStore()

  const [isResizing, setIsResizing] = useState(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(bottomDockHeight)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const delta = startYRef.current - e.clientY
      const newHeight = Math.min(600, Math.max(120, startHeightRef.current + delta))
      setBottomDockHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, setBottomDockHeight])

  if (bottomDockCollapsed) {
    return (
      <div className="h-7 bg-industrial-950 border-t border-industrial-800 flex items-center justify-between px-3 select-none text-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              toggleBottomDock()
              setBottomActiveTab('compile')
            }}
            className="flex items-center gap-1.5 text-industrial-400 hover:text-industrial-200 transition-colors"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>Messages</span>
            {totalCollisions > 0 && (
              <span className="bg-red-600 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {totalCollisions}
              </span>
            )}
          </button>

          <button
            onClick={() => {
              toggleBottomDock()
              setBottomActiveTab('crossref')
            }}
            className="flex items-center gap-1.5 text-industrial-400 hover:text-industrial-200 transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Cross-Reference (F11)</span>
          </button>

          <button
            onClick={() => {
              toggleBottomDock()
              setBottomActiveTab('memoryMap')
            }}
            className="flex items-center gap-1.5 text-industrial-400 hover:text-industrial-200 transition-colors"
          >
            <Grid className="w-3.5 h-3.5" />
            <span>Memory Map Visualizer</span>
          </button>

          <button
            onClick={() => {
              toggleBottomDock()
              setBottomActiveTab('trace')
            }}
            className="flex items-center gap-1.5 text-industrial-400 hover:text-industrial-200 transition-colors"
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span>Trace Oscilloscope</span>
          </button>
        </div>

        <button
          onClick={toggleBottomDock}
          className="text-industrial-400 hover:text-industrial-200 p-0.5 rounded"
          title="Expand Engineering Inspector"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>
    )
  }

  return (
    <div
      style={{ height: `${bottomDockHeight}px` }}
      className="bg-industrial-900 border-t border-industrial-800 flex flex-col relative select-none"
    >
      {/* Resizer Handle */}
      <div
        onMouseDown={(e) => {
          setIsResizing(true)
          startYRef.current = e.clientY
          startHeightRef.current = bottomDockHeight
        }}
        className="h-1 w-full bg-industrial-800 hover:bg-cyan-500 cursor-ns-resize transition-colors absolute top-0 z-20"
      />

      {/* Dock Header Tabs */}
      <div className="h-8 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between px-2 text-xs">
        <div className="flex items-center gap-1 h-full">
          <button
            data-testid="bottom-tab-compile"
            onClick={() => setBottomActiveTab('compile')}
            className={`h-full flex items-center gap-1.5 px-3 border-t-2 transition-colors ${
              bottomActiveTab === 'compile'
                ? 'bg-industrial-900 text-industrial-100 border-t-siemens-cyan font-semibold'
                : 'text-industrial-400 hover:text-industrial-200 border-t-transparent'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5 text-cyan-400" />
            <span>Compile & Consistency Messages</span>
            {totalCollisions > 0 && (
              <span className="bg-red-600 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {totalCollisions}
              </span>
            )}
          </button>

          <button
            data-testid="bottom-tab-crossref"
            onClick={() => setBottomActiveTab('crossref')}
            className={`h-full flex items-center gap-1.5 px-3 border-t-2 transition-colors ${
              bottomActiveTab === 'crossref'
                ? 'bg-industrial-900 text-industrial-100 border-t-siemens-cyan font-semibold'
                : 'text-industrial-400 hover:text-industrial-200 border-t-transparent'
            }`}
          >
            <Search className="w-3.5 h-3.5 text-blue-400" />
            <span>Cross-Reference (F11)</span>
          </button>

          <button
            data-testid="bottom-tab-memorymap"
            onClick={() => setBottomActiveTab('memoryMap')}
            className={`h-full flex items-center gap-1.5 px-3 border-t-2 transition-colors ${
              bottomActiveTab === 'memoryMap'
                ? 'bg-industrial-900 text-industrial-100 border-t-siemens-cyan font-semibold'
                : 'text-industrial-400 hover:text-industrial-200 border-t-transparent'
            }`}
          >
            <Grid className="w-3.5 h-3.5 text-purple-400" />
            <span>Memory Map Visualizer</span>
          </button>

          <button
            data-testid="bottom-tab-trace"
            onClick={() => setBottomActiveTab('trace')}
            className={`h-full flex items-center gap-1.5 px-3 border-t-2 transition-colors ${
              bottomActiveTab === 'trace'
                ? 'bg-industrial-900 text-industrial-100 border-t-siemens-cyan font-semibold'
                : 'text-industrial-400 hover:text-industrial-200 border-t-transparent'
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span>Trace Oscilloscope</span>
          </button>
        </div>

        <button
          onClick={toggleBottomDock}
          className="text-industrial-400 hover:text-industrial-200 p-1 rounded hover:bg-industrial-800"
          title="Collapse Engineering Inspector"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>

      {/* Dock Content */}
      <div className="flex-1 overflow-hidden">
        {bottomActiveTab === 'compile' && <CompileMessagesTab />}
        {bottomActiveTab === 'crossref' && <CrossReferenceTab />}
        {bottomActiveTab === 'memoryMap' && <MemoryMapVisualizer />}
        {bottomActiveTab === 'trace' && <TraceOscilloscope />}
      </div>
    </div>
  )
}
