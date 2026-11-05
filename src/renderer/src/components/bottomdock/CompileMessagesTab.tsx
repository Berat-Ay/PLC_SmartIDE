import React from 'react'
import {
  AlertTriangle,
  AlertCircle,
  Info,
  Wand2,
  CheckCircle2,
  ExternalLink
} from 'lucide-react'
import { useTagStore } from '../../stores/useTagStore'
import { useUIStore } from '../../stores/useUIStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { DoubleCoilDetector } from '../../services/DoubleCoilDetector'
import { CompileMessage } from '../../services/CompileEngine'

export const CompileMessagesTab: React.FC = () => {
  const { diagnostics: tagDiagnostics, autoAssignSafeAddress, resolveAllOverlaps } = useTagStore()
  const { lastCompileResult, compileProject } = useProjectStore()
  const { ladBlocks, updateLadBlock } = useBlockStore()
  const { openTab } = useUIStore()

  // Use the full compiler diagnostics if compilation has run, else fall back to tag diagnostics
  const effectiveDiagnostics: CompileMessage[] = lastCompileResult
    ? lastCompileResult.diagnostics
    : tagDiagnostics.map((d) => ({
        id: d.id,
        severity: d.severity,
        code: d.code,
        source: d.source,
        message: d.message,
        location: { tagName: d.targetSymbol, tagAddress: d.targetAddress },
        targetId: d.targetId,
        targetSymbol: d.targetSymbol,
        targetAddress: d.targetAddress,
        autoFixable: d.autoFixable,
        fixAction: d.fixAction,
        fixLabel: d.fixLabel,
        timestamp: d.timestamp
      }))

  const errors = effectiveDiagnostics.filter((d) => d.severity === 'Error')
  const warnings = effectiveDiagnostics.filter((d) => d.severity === 'Warning')
  const infos = effectiveDiagnostics.filter((d) => d.severity === 'Info')

  const handleFix = (targetId?: string, fixAction?: string, diag?: CompileMessage) => {
    if (fixAction === 'AUTO_ASSIGN_ADDRESS' && targetId) {
      autoAssignSafeAddress(targetId)
      compileProject()
    } else if (fixAction === 'AUTO_MERGE_COILS') {
      const operand = diag?.targetSymbol || targetId
      const blockFileName = diag?.location?.blockFileName || ladBlocks[0]?.fileName
      const block = ladBlocks.find((b) => b.fileName === blockFileName) || ladBlocks[0]
      if (block && operand) {
        const refactored = DoubleCoilDetector.autoRefactorBlock(block, operand)
        updateLadBlock(block.fileName, refactored)
        compileProject()
      }
    } else if (fixAction === 'GO_TO_RUNG' && diag) {
      handleNavigate(diag)
    }
  }

  const handleNavigate = (diag: CompileMessage) => {
    if (diag.location?.blockFileName) {
      const isScl = diag.location.blockFileName.toLowerCase().endsWith('.scl')
      openTab({
        id: `tab_${diag.location.blockFileName}`,
        title: diag.location.blockName || diag.location.blockFileName,
        type: isScl ? 'scl' : 'lad',
        targetId: diag.location.blockFileName
      })
    } else {
      // Default to All Tags
      openTab({
        id: 'tab_all_tags',
        title: 'All PLC Tags',
        type: 'allTags'
      })
    }
  }

  return (
    <div id="compile-messages-tab" className="h-full flex flex-col bg-industrial-900 select-none text-xs">
      {/* Real-time Compilation Status Banner */}
      {lastCompileResult && (
        <div
          data-testid="compile-status-banner"
          className={`h-7 px-3 border-b flex items-center justify-between font-mono text-[11px] font-bold ${
            lastCompileResult.errorsCount === 0 && lastCompileResult.warningsCount === 0
              ? 'bg-emerald-950/90 border-emerald-700/80 text-emerald-300'
              : lastCompileResult.errorsCount > 0
              ? 'bg-red-950/90 border-red-700/80 text-red-200'
              : 'bg-amber-950/90 border-amber-700/80 text-amber-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {lastCompileResult.errorsCount === 0 && lastCompileResult.warningsCount === 0 ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : lastCompileResult.errorsCount > 0 ? (
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            )}
            <span data-testid="compile-banner-text">{lastCompileResult.bannerMessage}</span>
            {lastCompileResult.metricSummary && (
              <span data-testid="compile-metrics-text" className="text-[10px] text-industrial-400 font-mono font-normal">
                • {lastCompileResult.metricSummary}
              </span>
            )}
          </div>
          <button
            onClick={() => compileProject()}
            data-testid="recompile-btn"
            className="px-2 py-0.5 text-[10px] uppercase font-sans font-semibold bg-industrial-800 hover:bg-industrial-700 text-industrial-200 hover:text-white border border-industrial-600 rounded-none cursor-pointer"
          >
            Re-Compile
          </button>
        </div>
      )}

      {/* Summary Header */}
      <div className="h-8 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
        <div className="flex items-center gap-4 text-[11px]">
          <div className="flex items-center gap-1.5 text-red-400 font-semibold">
            <AlertCircle className="w-3.5 h-3.5" />
            <span data-testid="compile-errors-count">{errors.length} Error(s)</span>
          </div>
          <div className="flex items-center gap-1.5 text-amber-400 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span data-testid="compile-warnings-count">{warnings.length} Warning(s)</span>
          </div>
          <div className="flex items-center gap-1.5 text-cyan-400">
            <Info className="w-3.5 h-3.5" />
            <span>{infos.length} Information</span>
          </div>
        </div>

        {errors.some((e) => e.code === 'ERR_MEMORY_OVERLAP') && (
          <button
            onClick={() => {
              resolveAllOverlaps()
              compileProject()
            }}
            className="flex items-center gap-1 px-2.5 py-0.5 rounded-none text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-500 shadow transition-colors cursor-pointer"
          >
            <Wand2 className="w-3 h-3" />
            <span>Auto-Resolve All Overlaps</span>
          </button>
        )}
      </div>

      {/* Messages List */}
      <div className="flex-1 overflow-auto">
        {effectiveDiagnostics.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-4 text-industrial-500 text-xs gap-1">
            <CheckCircle2 className="w-6 h-6 text-emerald-500/60" />
            <span>0 consistency errors. All S7 tags, blocks, memory addresses, and ASTs are fully valid.</span>
          </div>
        ) : (
          <table className="w-full text-left font-mono">
            <thead className="bg-industrial-950 text-industrial-400 sticky top-0 border-b border-industrial-850 uppercase text-[10px]">
              <tr>
                <th className="py-1.5 px-3 w-10 text-center">Sev</th>
                <th className="py-1.5 px-3 w-36">Code</th>
                <th className="py-1.5 px-3 w-40">Source</th>
                <th className="py-1.5 px-3">Message</th>
                <th className="py-1.5 px-3 w-44">Location</th>
                <th className="py-1.5 px-3 w-44 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-industrial-850 text-industrial-200">
              {effectiveDiagnostics.map((diag) => {
                const locStr = diag.location?.blockName
                  ? `${diag.location.blockName}${diag.location.networkNumber ? ` (NW ${diag.location.networkNumber})` : ''}`
                  : diag.location?.tagName
                  ? `Tag: ${diag.location.tagName}`
                  : 'Project Root'

                return (
                  <tr
                    key={diag.id}
                    data-testid="compile-message-item"
                    onClick={() => handleNavigate(diag)}
                    className="hover:bg-industrial-850 cursor-pointer group transition-colors"
                  >
                    <td className="py-1.5 px-3 text-center">
                      {diag.severity === 'Error' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 mx-auto" />
                      ) : diag.severity === 'Warning' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mx-auto" />
                      ) : (
                        <Info className="w-3.5 h-3.5 text-cyan-400 mx-auto" />
                      )}
                    </td>
                    <td className="py-1.5 px-3 text-red-300 font-bold text-[11px]">
                      {diag.iecCode ? `[${diag.iecCode}] ${diag.code}` : diag.code}
                    </td>
                    <td className="py-1.5 px-3 text-industrial-400 text-[11px]">{diag.source}</td>
                    <td className="py-1.5 px-3 text-industrial-100 font-sans text-xs">{diag.message}</td>
                    <td className="py-1.5 px-3 text-cyan-300 font-mono text-[11px] truncate" title={locStr}>
                      {locStr}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleNavigate(diag)
                          }}
                          data-testid="go-to-location-btn"
                          title="Navigate to block or tag"
                          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-sans font-medium text-cyan-300 hover:text-white bg-industrial-800 hover:bg-industrial-700 rounded-none border border-industrial-700 cursor-pointer"
                        >
                          <ExternalLink className="w-2.5 h-2.5" />
                          <span>Go to</span>
                        </button>

                        {diag.autoFixable && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleFix(diag.targetId, diag.fixAction, diag)
                            }}
                            data-testid="compile-auto-fix-btn"
                            className="px-2 py-0.5 text-[10px] font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-none transition-colors cursor-pointer"
                          >
                            {diag.fixLabel || 'Fix'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
