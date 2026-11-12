import React, { useState } from 'react'
import {
  History,
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  Search
} from 'lucide-react'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { useTagStore } from '../../../stores/useTagStore'

export const TimeTravelScrubber: React.FC = () => {
  const {
    state,
    isMonitoring,
    metrics,
    timeTravelActive,
    scrubbedSnapshot,
    scrubbedIndex,
    freezeScan,
    resumeLive,
    stepCycle,
    scrubToCycle,
    jumpToLastEdge,
    engine
  } = useRuntimeStore()
  const { tagTables } = useTagStore()

  const [selectedTagForEdge, setSelectedTagForEdge] = useState('MainConveyor_Run')

  if (!isMonitoring) return null

  const history = engine.getHistory()
  const historyLen = history.length

  const allTags: string[] = []
  for (const tbl of tagTables) {
    for (const t of tbl.tags) {
      allTags.push(t.name)
    }
  }

  const currentDisplayCycle = timeTravelActive
    ? scrubbedSnapshot?.cycleNumber || 0
    : metrics.cycleNumber

  const cyclesBehind = timeTravelActive && scrubbedSnapshot
    ? metrics.cycleNumber - scrubbedSnapshot.cycleNumber
    : 0

  return (
    <div className="h-11 bg-industrial-950 border-t border-industrial-800 px-4 flex items-center justify-between text-xs select-none gap-4 z-20">
      {/* Left: Playback & Freeze Controls */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5 pr-3 border-r border-industrial-800">
          <History className="w-4 h-4 text-cyan-400" />
          <span className="font-semibold text-industrial-100 font-mono text-[11px] uppercase tracking-wide">
            1,000-Cycle Time-Travel
          </span>
        </div>

        {timeTravelActive ? (
          <button
            onClick={resumeLive}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors shadow-sm animate-pulse"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Resume Live</span>
          </button>
        ) : (
          <button
            onClick={freezeScan}
            disabled={state !== 'RUN' && historyLen === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-industrial-800 hover:bg-industrial-750 text-industrial-200 hover:text-white text-xs transition-colors border border-industrial-700"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>Freeze History</span>
          </button>
        )}

        {/* Step Buttons */}
        <div className="flex items-center gap-0.5 bg-industrial-900 border border-industrial-800 rounded p-0.5">
          <button
            onClick={() => stepCycle(-1)}
            disabled={historyLen === 0}
            title="Step Back 1 Scan Cycle (-1 Cycle)"
            className="p-1 rounded text-industrial-400 hover:text-white hover:bg-industrial-800 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => stepCycle(1)}
            disabled={historyLen === 0}
            title="Step Forward 1 Scan Cycle (+1 Cycle)"
            className="p-1 rounded text-industrial-400 hover:text-white hover:bg-industrial-800 disabled:opacity-40"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Center: Timeline Scrubber Slider */}
      <div className="flex-1 flex items-center gap-3 max-w-xl">
        <span className="text-[10px] text-industrial-500 font-mono shrink-0">
          -{Math.min(1000, historyLen)}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(0, historyLen - 1)}
          value={timeTravelActive ? scrubbedIndex : Math.max(0, historyLen - 1)}
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10)
            if (history[idx]) {
              scrubToCycle(history[idx].cycleNumber)
            }
          }}
          className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-industrial-800 rounded-lg"
        />

        <div className="shrink-0 flex items-center gap-2 font-mono">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
              timeTravelActive
                ? 'bg-amber-950 text-amber-300 border border-amber-800'
                : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
            }`}
          >
            {timeTravelActive ? `Cycle #${currentDisplayCycle} (-${cyclesBehind})` : `LIVE Cycle #${metrics.cycleNumber}`}
          </span>
        </div>
      </div>

      {/* Right: Jump to Last Edge Filter */}
      <div className="flex items-center gap-2 shrink-0">
        <select
          value={selectedTagForEdge}
          onChange={(e) => setSelectedTagForEdge(e.target.value)}
          className="bg-industrial-900 border border-industrial-700 rounded px-2 py-1 text-cyan-300 font-mono text-xs focus:outline-hidden cursor-pointer"
        >
          {allTags.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <button
          onClick={() => jumpToLastEdge(selectedTagForEdge)}
          title="Rewind history to the exact scan cycle where this bit transitioned"
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-industrial-850 hover:bg-industrial-800 border border-industrial-700 text-industrial-200 hover:text-white text-xs font-medium transition-colors"
        >
          <Search className="w-3 h-3 text-cyan-400" />
          <span>Jump to Edge</span>
        </button>
      </div>
    </div>
  )
}

