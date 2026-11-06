import React, { useState } from 'react'
import {
  FileCode2,
  Code,
  Brackets,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Eye,
  Zap,
  Binary,
  Copy
} from 'lucide-react'
import { useBlockStore } from '../../../stores/useBlockStore'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { BlockInterfaceStrip } from '../BlockInterfaceStrip'
import { SvgLadderCanvas } from '../ladder/SvgLadderCanvas'
import { DoubleCoilBanner } from '../ladder/DoubleCoilBanner'
import { DoubleCoilDetector } from '../../../services/DoubleCoilDetector'
import { QuickForceBar } from '../ladder/QuickForceBar'
import { TimeTravelScrubber } from '../ladder/TimeTravelScrubber'
import { SclInterpreter } from '../../../runtime/SclInterpreter'
import { StlListingGenerator } from '../../../services/compiler/StlListingGenerator'

interface BlockCodeEditorProps {
  fileName: string
  isLad: boolean
}

export const BlockCodeEditor: React.FC<BlockCodeEditorProps> = ({ fileName, isLad }) => {
  const { ladBlocks, sclBlocks, updateLadBlock, updateSclBlock } = useBlockStore()
  const { markDirty } = useProjectStore()
  const { isMonitoring, currentSnapshot, scrubbedSnapshot, timeTravelActive } = useRuntimeStore()

  const [showRawJson, setShowRawJson] = useState(false)
  const [showBytecode, setShowBytecode] = useState(false)
  const [copiedBytecode, setCopiedBytecode] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showQuickForce, setShowQuickForce] = useState(false)

  const activeSnapshot = timeTravelActive ? scrubbedSnapshot : currentSnapshot

  const ladBlock = isLad ? ladBlocks.find((b) => b.fileName === fileName) : undefined
  const sclBlock = !isLad ? sclBlocks.find((b) => b.fileName === fileName) : undefined

  if (isLad && !ladBlock) {
    return (
      <div className="h-full flex items-center justify-center text-industrial-500 italic text-xs">
        Ladder Block not found: {fileName}
      </div>
    )
  }

  if (!isLad && !sclBlock) {
    return (
      <div className="h-full flex items-center justify-center text-industrial-500 italic text-xs">
        SCL Block not found: {fileName}
      </div>
    )
  }

  const currentBlock = isLad ? ladBlock! : sclBlock!
  const conflicts = isLad && ladBlock ? DoubleCoilDetector.detectConflicts(ladBlock) : []
  const sclSyntax = !isLad && sclBlock ? SclInterpreter.validateSyntax(sclBlock.code) : null
  const compiledBytecode = showBytecode
    ? isLad && ladBlock
      ? StlListingGenerator.forLadBlock(ladBlock)
      : sclBlock
      ? StlListingGenerator.forSclBlock(sclBlock)
      : null
    : null

  return (
    <div className="cq h-full flex flex-col bg-industrial-900 select-none text-xs overflow-hidden">
      {/* Block Header Banner */}
      <div className="h-10 px-4 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between gap-3 shrink-0 whitespace-nowrap overflow-hidden">
        <div className="flex items-center gap-2 min-w-0">
          {isLad ? (
            <FileCode2 className="w-4 h-4 text-purple-400 shrink-0" />
          ) : (
            <Code className="w-4 h-4 text-blue-400 shrink-0" />
          )}
          <span className="font-semibold text-industrial-100 font-mono text-sm truncate" title={currentBlock.name}>
            {currentBlock.name}
          </span>
          <span className="under-600:hidden text-[11px] text-industrial-300 bg-industrial-850 px-2 py-0.5 rounded border border-industrial-750 font-mono">
            {currentBlock.blockType}{currentBlock.blockNumber} [{isLad ? 'LAD AST' : 'SCL'}]
          </span>
          <span className="under-720:hidden text-[10px] text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
            {currentBlock.optimizedAccess ? 'Optimized Access' : 'Standard Access'}
          </span>
          {isMonitoring && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-700 font-mono animate-pulse font-bold">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="under-900:hidden">ONLINE MONITORING</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* SCL Syntax indicator */}
          {!isLad && sclSyntax && (
            <div
              className={`flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${
                sclSyntax.valid
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
                  : 'bg-red-950/80 text-red-300 border-red-800'
              }`}
            >
              {sclSyntax.valid ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  <span className="under-720:hidden">Syntax Valid</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-3 h-3 text-red-400" />
                  <span title={sclSyntax.errors.join('; ')}>Syntax Error ({sclSyntax.errors.length})</span>
                </>
              )}
            </div>
          )}

          {/* Quick Force bar toggle */}
          <button
            onClick={() => setShowQuickForce(!showQuickForce)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-colors ${
              showQuickForce || isMonitoring
                ? 'bg-amber-950 text-amber-300 border border-amber-800'
                : 'text-industrial-400 hover:text-industrial-200 hover:bg-industrial-850'
            }`}
            title="Toggle Quick I/O Forcing Bar"
          >
            <Zap className="w-3.5 h-3.5" />
            <span className="under-600:hidden">Force I/O</span>
          </button>

          {isLad && (
            <button
              onClick={() => {
                setShowRawJson(!showRawJson)
                if (!showRawJson) setShowBytecode(false)
              }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-colors ${
                showRawJson
                  ? 'bg-industrial-750 text-white border border-industrial-600'
                  : 'text-industrial-400 hover:text-industrial-200 hover:bg-industrial-850'
              }`}
              title={showRawJson ? 'View SVG Ladder' : 'View AST JSON'}
            >
              <Brackets className="w-3.5 h-3.5" />
              <span className="under-600:hidden">{showRawJson ? 'View SVG Ladder' : 'View AST JSON'}</span>
            </button>
          )}

          {/* STL listing toggle */}
          <button
            data-testid="toggle-bytecode-view"
            onClick={() => {
              setShowBytecode(!showBytecode)
              if (!showBytecode) setShowRawJson(false)
            }}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${
              showBytecode
                ? 'bg-cyan-950 text-cyan-300 border border-cyan-700 font-semibold'
                : 'text-industrial-400 hover:text-industrial-200 hover:bg-industrial-850'
            }`}
            title="View STL listing"
          >
            <Binary className="w-3.5 h-3.5" />
            <span className="under-600:hidden">{showBytecode ? 'Close Listing' : 'View STL Listing'}</span>
          </button>
        </div>
      </div>

      {/* Double Coil Conflict Warning Banner */}
      {isLad && ladBlock && (
        <DoubleCoilBanner block={ladBlock} conflicts={conflicts} />
      )}

      {/* Quick Force Bar */}
      {(showQuickForce || isMonitoring) && <QuickForceBar />}

      {/* Collapsible Block Variable Interface Strip */}
      <BlockInterfaceStrip
        fileName={fileName}
        blockType={currentBlock.blockType}
        blockInterface={currentBlock.interface}
      />

      {/* Main Block Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {showBytecode && compiledBytecode ? (
          <div data-testid="bytecode-disassembly-view" className="flex-1 flex flex-col overflow-hidden bg-industrial-950 p-4">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-industrial-800 shrink-0">
              <div className="flex items-center gap-2">
                <Binary className="w-4 h-4 text-cyan-400" />
                <span className="font-bold text-industrial-100 font-mono text-xs">
                  STL Listing (reading aid, not loaded to a CPU)
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono text-industrial-300">
                  {compiledBytecode.totalInstructions} Instructions
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(compiledBytecode.listingText)
                    setCopiedBytecode(true)
                    setTimeout(() => setCopiedBytecode(false), 2000)
                  }}
                  data-testid="copy-bytecode-btn"
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono bg-industrial-800 hover:bg-industrial-700 text-industrial-200 hover:text-white border border-industrial-600 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedBytecode ? 'Copied!' : 'Copy STL'}</span>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-industrial-900 border border-industrial-800 p-3 font-mono text-xs leading-relaxed">
              <pre className="text-industrial-200 select-text whitespace-pre">
                {compiledBytecode.listingText}
              </pre>
            </div>
          </div>
        ) : (
          <>
            {/* LAD Content */}
            {isLad && ladBlock && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {showRawJson ? (
                  <div className="flex-1 overflow-auto p-4">
                    <div className="rounded bg-industrial-950 border border-industrial-800 p-3">
                      <div className="text-[11px] text-industrial-400 font-mono mb-2 pb-1 border-b border-industrial-850">
                        Ladder JSON (/blocks/{ladBlock.fileName})
                      </div>
                      <pre className="text-industrial-200 font-mono text-[11px] overflow-auto max-h-[600px]">
                        {JSON.stringify(ladBlock, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <SvgLadderCanvas
                    block={ladBlock}
                    conflicts={conflicts}
                    onUpdateBlock={(updated) => {
                      updateLadBlock(fileName, updated)
                      markDirty(true)
                    }}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                  />
                )}
              </div>
            )}

            {/* SCL Content */}
            {!isLad && sclBlock && (
              <div className="flex-1 flex flex-col overflow-hidden p-4 space-y-3">
                <div className="p-2.5 bg-gradient-to-r from-industrial-950 to-industrial-900 border border-blue-900/60 rounded-lg flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded bg-blue-950/80 border border-blue-700/80 flex items-center justify-center">
                      <Code className="w-3.5 h-3.5 text-blue-300" />
                    </div>
                    <div>
                      <div className="font-semibold text-industrial-100 text-xs">
                        Structured Control Language (SCL) Editor
                      </div>
                      <div className="text-industrial-400 text-[11px]">
                        SCL source of this block
                      </div>
                    </div>
                  </div>
                  <span className="under-600:hidden text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800 font-bold">
                    SCL
                  </span>
                </div>

                {/* SCL Code Area with Line Numbers & Live Badges */}
                <div className="flex-1 rounded-lg bg-industrial-950 border border-industrial-800 overflow-hidden flex flex-col">
                  <div className="px-3 py-1.5 bg-industrial-900/60 border-b border-industrial-850 flex items-center justify-between text-industrial-400 font-mono text-[10px]">
                    <span className="truncate">Source File: /blocks/{sclBlock.fileName}</span>
                    <span className="shrink-0 ml-3">Lines: {sclBlock.code.split('\n').length}</span>
                  </div>

                  <div className="flex-1 flex overflow-hidden">
                    {/* Textarea for code editing */}
                    <textarea
                      value={sclBlock.code}
                      onChange={(e) => {
                        updateSclBlock(fileName, { code: e.target.value })
                        markDirty(true)
                      }}
                      className="flex-1 bg-industrial-950 text-industrial-100 font-mono text-xs p-3 focus:outline-hidden resize-none leading-relaxed overflow-auto border-r border-industrial-850"
                      spellCheck={false}
                    />

                    {/* Online Monitoring Values Panel */}
                    {isMonitoring && (
                      <div className="w-64 bg-industrial-900/60 border-l border-industrial-850 p-2 overflow-y-auto space-y-1 select-none">
                        <div className="text-[10px] uppercase font-bold text-emerald-400 px-1 pb-1 border-b border-industrial-800 flex items-center gap-1">
                          <Eye className="w-3 h-3" />
                          <span>Live Line Values</span>
                        </div>
                        {Object.entries(activeSnapshot?.sclLineValues?.[currentBlock.fileName] || {}).map(([lineStr, val]) => (
                          <div
                            key={lineStr}
                            className="flex items-center justify-between p-1.5 rounded bg-industrial-950 border border-industrial-800 font-mono text-[11px]"
                          >
                            <span className="text-industrial-400">Line {lineStr}:</span>
                            <span className="font-bold text-emerald-400">{String(val)}</span>
                          </div>
                        ))}
                        {Object.keys(activeSnapshot?.sclLineValues?.[currentBlock.fileName] || {}).length === 0 && (
                          <div className="text-[11px] text-industrial-500 italic p-2 text-center">
                            Scan cycle active. Monitoring local variables...
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Time-Travel Debugger Scrubber Bar at Bottom */}
      <TimeTravelScrubber />
    </div>
  )
}
