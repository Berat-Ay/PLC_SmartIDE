import React, { useState } from 'react'
import { X, Check, Trash2, Split, FileCode2, ArrowRight } from 'lucide-react'
import { StagedFileChange, PlcAgentTools } from '../../services/ai/PlcAgentTools'

interface DiffViewerModalProps {
  isOpen: boolean
  changeset: StagedFileChange[]
  onClose: () => void
  onApproved: (reportMessage: string) => void
}

export const DiffViewerModal: React.FC<DiffViewerModalProps> = ({
  isOpen,
  changeset,
  onClose,
  onApproved
}) => {
  const [selectedIdx, setSelectedIdx] = useState(0)

  if (!isOpen || changeset.length === 0) return null

  const activeChange = changeset[selectedIdx] || changeset[0]

  const handleApprove = () => {
    const tools = PlcAgentTools.getInstance()
    const res = tools.applyStagedChangeset(changeset)
    onApproved(res.compilerReport?.message || 'Changes applied and compiler verified.')
    onClose()
  }

  return (
    <div data-testid="diff-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs select-none">
      <div className="bg-industrial-900 border border-industrial-750 rounded-none shadow-2xl w-[90vw] max-w-5xl h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-none bg-blue-950 border border-blue-700 flex items-center justify-center text-blue-400">
              <Split className="w-4 h-4" />
            </div>
            <div>
              <div className="text-sm font-bold text-industrial-100 flex items-center gap-2">
                <span>AI Proposed Changeset</span>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-none bg-blue-950 text-blue-300 border border-blue-800">
                  {changeset.length} File(s) Staged for Review
                </span>
              </div>
              <p className="text-[11px] text-industrial-400">
                Review proposed code changes before applying to the project memory and AST stores
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-none text-industrial-400 hover:text-industrial-200 hover:bg-industrial-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body: Left File List + Right Side-by-Side Diff */}
        <div className="flex-1 flex overflow-hidden">
          {/* File Selector Sidebar */}
          <div className="w-64 bg-industrial-950/70 border-r border-industrial-800 flex flex-col overflow-y-auto">
            <div className="p-2.5 text-[10px] uppercase font-bold text-industrial-400 tracking-wider">
              Modified Files
            </div>
            <div className="flex-1 p-2 space-y-1">
              {changeset.map((change, idx) => (
                <button
                  key={change.path}
                  data-testid="diff-file-item"
                  onClick={() => setSelectedIdx(idx)}
                  className={`w-full text-left p-2 rounded-none text-xs flex items-center gap-2 transition-colors ${
                    selectedIdx === idx
                      ? 'bg-industrial-800 text-white border border-blue-500/50 shadow-xs'
                      : 'text-industrial-300 hover:bg-industrial-900 hover:text-white'
                  }`}
                >
                  <FileCode2 className="w-4 h-4 text-cyan-400 shrink-0" />
                  <div className="truncate flex-1">
                    <div className="font-semibold truncate">{change.title}</div>
                    <div className="text-[10px] text-industrial-500 font-mono truncate">{change.path}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Diff Viewer Area */}
          <div className="flex-1 flex flex-col bg-industrial-900 overflow-hidden">
            {/* Diff Header */}
            <div className="px-4 py-2 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between text-xs font-mono">
              <span className="text-industrial-200 font-semibold">{activeChange.path}</span>
              <div className="flex items-center gap-4 text-[11px]">
                <span className="flex items-center gap-1 text-rose-400">
                  <span className="w-2 h-2 rounded-none bg-rose-500"></span> Before (Original)
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-industrial-500" />
                <span className="flex items-center gap-1 text-emerald-400">
                  <span className="w-2 h-2 rounded-none bg-emerald-500"></span> After (Proposed by Agent)
                </span>
              </div>
            </div>

            {/* Side-by-Side Comparison */}
            <div className="flex-1 grid grid-cols-2 divide-x divide-industrial-800 overflow-hidden font-mono text-xs">
              {/* Before Column */}
              <div className="flex flex-col overflow-hidden bg-rose-950/5">
                <div className="px-3 py-1 bg-rose-950/30 border-b border-rose-900/40 text-[10px] font-bold text-rose-300 uppercase tracking-wider">
                  Current Version
                </div>
                <pre className="flex-1 p-3 overflow-auto text-industrial-300 text-[11px] leading-relaxed select-text">
                  {activeChange.beforeContent}
                </pre>
              </div>

              {/* After Column */}
              <div className="flex flex-col overflow-hidden bg-emerald-950/5">
                <div className="px-3 py-1 bg-emerald-950/30 border-b border-emerald-900/40 text-[10px] font-bold text-emerald-300 uppercase tracking-wider">
                  Proposed Changes
                </div>
                <pre className="flex-1 p-3 overflow-auto text-emerald-100 text-[11px] leading-relaxed select-text">
                  {activeChange.afterContent}
                </pre>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3 bg-industrial-950 border-t border-industrial-800 flex items-center justify-between">
          <div className="text-xs text-industrial-400">
            Clicking <strong className="text-industrial-200">Approve & Apply</strong> triggers Compiler-in-the-Loop verification automatically.
          </div>

          <div className="flex items-center gap-3">
            <button
              data-testid="diff-reject-all-button"
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-rose-400 hover:text-white hover:bg-rose-950/60 rounded-none border border-rose-900/50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Reject All</span>
            </button>

            <button
              data-testid="diff-approve-all-button"
              onClick={handleApprove}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-none shadow-md transition-all active:scale-95"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Approve & Apply Changes ({changeset.length})</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

