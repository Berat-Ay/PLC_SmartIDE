import React, { useState, useEffect } from 'react'
import { useUIStore } from '../../stores/useUIStore'
import { BlackBoxLogger, BlackBoxLogEntry, BlackBoxCategory } from '../../services/diagnostics/BlackBoxLogger'

export const DebugLogModal: React.FC = () => {
  const { isDebugLogModalOpen, setDebugLogModalOpen } = useUIStore()
  const [logs, setLogs] = useState<BlackBoxLogEntry[]>([])
  const [filterCategory, setFilterCategory] = useState<'ALL' | 'AI' | 'COMPILER' | 'RUNTIME' | 'ERRORS'>('ALL')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())
  const [copiedSuccess, setCopiedSuccess] = useState(false)

  const logger = BlackBoxLogger.getInstance()

  useEffect(() => {
    if (!isDebugLogModalOpen) return

    setLogs(logger.getLogs())
    const unsubscribe = logger.subscribe(() => {
      setLogs(logger.getLogs())
    })
    return () => unsubscribe()
  }, [isDebugLogModalOpen])

  if (!isDebugLogModalOpen) return null

  const handleCopyReport = async () => {
    const report = logger.exportDiagnosticReport()
    try {
      await navigator.clipboard.writeText(report)
      setCopiedSuccess(true)
      setTimeout(() => setCopiedSuccess(false), 2500)
    } catch {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = report
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopiedSuccess(true)
      setTimeout(() => setCopiedSuccess(false), 2500)
    }
  }

  const handleClearLogs = () => {
    logger.clearLogs()
    setLogs([])
    setExpandedLogIds(new Set())
  }

  const toggleExpand = (id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredLogs = logs.filter((l) => {
    if (filterCategory === 'AI') {
      if (!l.category.startsWith('AI_')) return false
    } else if (filterCategory === 'COMPILER') {
      if (l.category !== 'AST_COMPILE') return false
    } else if (filterCategory === 'RUNTIME') {
      if (!l.category.startsWith('RUNTIME_') && l.category !== 'TAG_SYNC') return false
    } else if (filterCategory === 'ERRORS') {
      if (l.category !== 'AI_ERROR' && l.category !== 'AI_PARSE_ERROR') return false
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      const inSummary = l.summary.toLowerCase().includes(q)
      const inCategory = l.category.toLowerCase().includes(q)
      const inDetails = l.details ? JSON.stringify(l.details).toLowerCase().includes(q) : false
      return inSummary || inCategory || inDetails
    }
    return true
  })

  const getCategoryBadgeClass = (category: BlackBoxCategory) => {
    switch (category) {
      case 'AI_REQUEST':
        return 'bg-cyan-950/80 text-cyan-400 border-cyan-800'
      case 'AI_RAW_RESPONSE':
        return 'bg-blue-950/80 text-blue-400 border-blue-800'
      case 'AI_FALLBACK_OR_RETRY':
        return 'bg-amber-950/80 text-amber-400 border-amber-800'
      case 'AI_PARSE_AND_AST_INJECTION':
        return 'bg-emerald-950/80 text-emerald-400 border-emerald-800'
      case 'AI_ERROR':
      case 'AI_PARSE_ERROR':
        return 'bg-rose-950/80 text-rose-400 border-rose-800'
      case 'AST_COMPILE':
        return 'bg-purple-950/80 text-purple-400 border-purple-800'
      case 'RUNTIME_STATE_SNAPSHOT':
      case 'RUNTIME_TICK':
      case 'TAG_SYNC':
        return 'bg-slate-900 text-slate-300 border-slate-700'
      default:
        return 'bg-zinc-900 text-zinc-400 border-zinc-700'
    }
  }

  return (
    <div
      data-testid="debug-log-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs select-none"
    >
      <div className="relative w-[92vw] max-w-5xl h-[85vh] bg-[#0c0d10] border border-industrial-700 flex flex-col rounded-none shadow-2xl font-mono text-xs">
        {/* Modal Header */}
        <div className="h-11 px-4 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 bg-cyan-500 rounded-none inline-block" />
            <h2 className="text-sm font-bold tracking-wider text-slate-100 uppercase">
              Black-Box Telemetry Flight Recorder
            </h2>
            <span className="text-[10px] text-industrial-500 font-mono">
              ({logs.length} events logged)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              data-testid="btn-copy-debug-report"
              onClick={handleCopyReport}
              className={`px-3 py-1 text-[11px] font-bold border transition-colors ${
                copiedSuccess
                  ? 'bg-emerald-950 text-emerald-400 border-emerald-600'
                  : 'bg-cyan-950/60 text-cyan-300 border-cyan-700 hover:bg-cyan-900/60'
              }`}
            >
              {copiedSuccess ? 'COPIED TO CLIPBOARD' : 'COPY FULL DIAGNOSTIC REPORT'}
            </button>
            <button
              data-testid="btn-clear-debug-logs"
              onClick={handleClearLogs}
              className="px-2.5 py-1 text-[11px] text-slate-400 border border-industrial-800 hover:bg-industrial-900 hover:text-slate-200 transition-colors"
            >
              CLEAR
            </button>
            <button
              data-testid="btn-close-debug-modal"
              onClick={() => setDebugLogModalOpen(false)}
              className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white hover:bg-industrial-800 border border-transparent transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="h-10 px-4 bg-industrial-900/60 border-b border-industrial-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-1">
            {(['ALL', 'AI', 'COMPILER', 'RUNTIME', 'ERRORS'] as const).map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-2.5 py-1 text-[10px] uppercase font-bold border transition-colors ${
                  filterCategory === cat
                    ? 'bg-cyan-600 text-white border-cyan-500'
                    : 'bg-industrial-950 text-slate-400 border-industrial-800 hover:text-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search telemetry summary or payload..."
              className="w-full h-7 px-2.5 bg-black border border-industrial-800 text-slate-200 text-[11px] placeholder:text-industrial-600 focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>

        {/* Log Entries Container */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5 bg-[#090a0d]">
          {filteredLogs.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-industrial-500 italic text-[11px]">
              No telemetry events recorded matching criteria.
            </div>
          ) : (
            filteredLogs.slice().reverse().map((entry) => {
              const isExpanded = expandedLogIds.has(entry.id)
              const hasDetails = entry.details !== undefined

              return (
                <div
                  key={entry.id}
                  data-testid="black-box-log-entry"
                  className="border border-industrial-850 bg-black/50 hover:border-industrial-700 transition-colors"
                >
                  <div
                    onClick={() => hasDetails && toggleExpand(entry.id)}
                    className={`p-2 flex items-center justify-between gap-3 ${
                      hasDetails ? 'cursor-pointer' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2.5 overflow-hidden">
                      <span className="text-[10px] text-industrial-500 shrink-0 font-mono">
                        {entry.timestamp.split('T')[1].replace('Z', '')} (+{entry.elapsedMs}ms)
                      </span>
                      <span
                        className={`px-1.5 py-0.5 text-[9.5px] font-bold border shrink-0 uppercase ${getCategoryBadgeClass(
                          entry.category
                        )}`}
                      >
                        {entry.category}
                      </span>
                      <span className="text-slate-200 text-[11px] truncate font-medium">
                        {entry.summary}
                      </span>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      {hasDetails && (
                        <span className="text-[10px] text-cyan-400 hover:underline">
                          {isExpanded ? 'COLLAPSE [-]' : 'EXPAND [+]'}
                        </span>
                      )}
                    </div>
                  </div>

                  {isExpanded && hasDetails && (
                    <div className="px-3 pb-2 pt-1 border-t border-industrial-850 bg-industrial-950/70">
                      <pre className="text-[10px] font-mono text-slate-300 overflow-x-auto p-2 bg-[#050608] border border-industrial-800 max-h-64 select-text">
                        {typeof entry.details === 'string'
                          ? entry.details
                          : JSON.stringify(entry.details, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Modal Footer */}
        <div className="h-8 px-4 bg-industrial-950 border-t border-industrial-800 flex items-center justify-between shrink-0 text-[10px] text-industrial-500">
          <div>
            Format: S7-1200 / S7-1500 Telemetry Vector Engine | Safe API Key Masking Enabled
          </div>
          <div>
            Buffer: {logs.length} / 500 events
          </div>
        </div>
      </div>
    </div>
  )
}

