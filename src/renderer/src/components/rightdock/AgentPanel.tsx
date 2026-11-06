import React, { useState, useEffect, useRef } from 'react'
import {
  Sparkles,
  Bot,
  Send,
  Zap,
  CheckCheck,
  Split,
  Cpu,
  FileCode,
  AlertTriangle,
  Settings,
  RotateCcw,
  Star,
  ShieldCheck,
  Check,
  PanelRightClose,
  X,
  BookOpen,
  FileText
} from 'lucide-react'
import { useUIStore } from '../../stores/useUIStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { AiModelRouter, sanitizeUserPrompt } from '../../services/ai/AiModelRouter'
import { PlcAgentTools, StagedFileChange } from '../../services/ai/PlcAgentTools'
import { CoilDiagnosticEngine, CoilDiagnosticReport } from '../../services/ai/CoilDiagnosticEngine'
import { RagKnowledgeEngine } from '../../services/ai/RagKnowledgeEngine'
import { AiSettingsModal } from './AiSettingsModal'
import { DiffViewerModal } from './DiffViewerModal'
import { PlcBookTrainerModal } from './PlcBookTrainerModal'

const MarkdownMessageRenderer: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n')
  return (
    <div className="space-y-1 font-sans text-xs leading-relaxed">
      {lines.map((line, idx) => {
        const trimmed = line.trim()
        if (!trimmed) {
          return <div key={idx} className="h-1.5" />
        }

        // Heading
        if (trimmed.startsWith('### ')) {
          return (
            <div key={idx} className="font-bold text-white text-[12px] mt-2 mb-0.5">
              {renderInlineMarkdown(trimmed.substring(4))}
            </div>
          )
        }
        if (trimmed.startsWith('## ')) {
          return (
            <div key={idx} className="font-bold text-cyan-200 text-[13px] mt-2 mb-1">
              {renderInlineMarkdown(trimmed.substring(3))}
            </div>
          )
        }

        // Numbered list: 1. Item
        const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/)
        if (numMatch) {
          return (
            <div key={idx} className="flex items-start gap-1.5 pl-1 my-0.5">
              <span className="text-purple-400 font-mono font-bold shrink-0">{numMatch[1]}.</span>
              <div className="flex-1">{renderInlineMarkdown(numMatch[2])}</div>
            </div>
          )
        }

        // Bullet list: - Item or * Item
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return (
            <div key={idx} className="flex items-start gap-1.5 pl-1 my-0.5">
              <span className="text-cyan-400 font-mono shrink-0">•</span>
              <div className="flex-1">{renderInlineMarkdown(trimmed.substring(2))}</div>
            </div>
          )
        }

        // Regular line
        return (
          <div key={idx}>
            {renderInlineMarkdown(line)}
          </div>
        )
      })}
    </div>
  )
}

function renderInlineMarkdown(str: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let remaining = str
  let keyIdx = 0

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^(.*?)\*\*(.*?)\*\*(.*)$/)
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)$/)

    if (boldMatch && (!codeMatch || (boldMatch.index ?? 0) <= (codeMatch.index ?? 0))) {
      if (boldMatch[1]) parts.push(<span key={keyIdx++}>{boldMatch[1]}</span>)
      parts.push(<strong key={keyIdx++} className="font-bold text-white">{boldMatch[2]}</strong>)
      remaining = boldMatch[3]
    } else if (codeMatch) {
      if (codeMatch[1]) parts.push(<span key={keyIdx++}>{codeMatch[1]}</span>)
      parts.push(
        <code key={keyIdx++} className="px-1 py-0.5 bg-[#1a1c22] border border-[#2e323b] text-cyan-300 font-mono text-[11px] rounded-none">
          {codeMatch[2]}
        </code>
      )
      remaining = codeMatch[3]
    } else {
      parts.push(<span key={keyIdx++}>{remaining}</span>)
      break
    }
  }

  return parts.length > 0 ? parts : str
}

export const AgentPanel: React.FC = () => {
  const {
    rightDockCollapsed,
    toggleRightDock,
    agentMode,
    agentTier,
    agentMessages,
    setAgentMode,
    setAgentTier,
    tabs,
    activeTabId,
    isBookTrainerOpen,
    setBookTrainerOpen
  } = useUIStore()
  const { metadata, cpuState } = useProjectStore()
  const { totalCollisions } = useTagStore()
  const { ladBlocks, sclBlocks } = useBlockStore()

  const [inputPrompt, setInputPrompt] = useState('')
  const [isSettingsOpen, setSettingsOpen] = useState(false)
  const [isDiffModalOpen, setDiffModalOpen] = useState(false)
  const [pendingChangeset, setPendingChangeset] = useState<StagedFileChange[]>([])
  const [activeDiagnostic, setActiveDiagnostic] = useState<CoilDiagnosticReport | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [savedStandardNotice, setSavedStandardNotice] = useState<string | null>(null)
  const [currentModelId, setCurrentModelId] = useState(
    AiModelRouter.getInstance().getConfig().selectedModelId || 'gemini-2.5-flash'
  )
  const [availableModels, setAvailableModels] = useState(
    AiModelRouter.getInstance().getConfig().availableModels || []
  )

  useEffect(() => {
    if (!isSettingsOpen) {
      const cfg = AiModelRouter.getInstance().getConfig()
      setCurrentModelId(cfg.selectedModelId)
      setAvailableModels(cfg.availableModels || [])
    }
  }, [isSettingsOpen])

  // Listen for Live Diagnostic events triggered directly from Ladder Canvas
  useEffect(() => {
    const handleDiagnoseEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ operand: string; networkNumber: number }>).detail
      if (!detail) return

      if (rightDockCollapsed) {
        toggleRightDock()
      }
      useUIStore.getState().setRightActiveTab('agent')

      const { tabs, activeTabId } = useUIStore.getState()
      const currentTab = tabs.find((t) => t.id === activeTabId)
      const currentLadBlocks = useBlockStore.getState().ladBlocks
      const activeLad = currentLadBlocks.find((b) => b.fileName === currentTab?.targetId) || currentLadBlocks[0]
      if (activeLad) {
        const report = CoilDiagnosticEngine.diagnoseCoil(activeLad, detail.networkNumber, detail.operand)
        setActiveDiagnostic(report)

        if (report.blockingContact?.nodeId) {
          window.dispatchEvent(
            new CustomEvent('plc:highlight-blocking-node', {
              detail: { nodeId: report.blockingContact.nodeId }
            })
          )
        }

        useUIStore.getState().sendAgentMessage(`Diagnostic request: Why is coil '${detail.operand}' OFF?`)
        setTimeout(() => {
          useUIStore.getState().sendAgentMessage(report.explanationEn || report.explanationTr)
        }, 300)
      }
    }

    window.addEventListener('plc:diagnose-coil', handleDiagnoseEvent)
    return () => window.removeEventListener('plc:diagnose-coil', handleDiagnoseEvent)
  }, [ladBlocks, rightDockCollapsed, toggleRightDock])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  const abortControllerRef = useRef<AbortController | null>(null)

  const handleCancelExecution = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsExecuting(false)
    useUIStore.getState().sendAgentMessage('Generation cancelled by user.', 'agent')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputPrompt.trim() || isExecuting) return

    const promptText = sanitizeUserPrompt(inputPrompt)
    if (!promptText) return
    setInputPrompt('')
    setIsExecuting(true)

    const controller = new AbortController()
    abortControllerRef.current = controller

    // Log user message
    useUIStore.getState().sendAgentMessage(promptText, 'user')

    try {
      const router = AiModelRouter.getInstance()
      const response = await router.executePrompt(promptText, agentTier, agentMode, controller.signal)

      if (agentMode === 'diff-view' && response.stagedChangeset && response.stagedChangeset.length > 0) {
        setPendingChangeset(response.stagedChangeset as StagedFileChange[])
        setDiffModalOpen(true)
      }

      useUIStore.getState().sendAgentMessage(response.replyText, 'agent', response.ragRulesConsulted, {
        snippet: response.rawTraceSnippet,
        rawJson: response.rawJson,
        isError: response.isError,
        errorDetails: response.errorDetails
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errStack = err instanceof Error ? err.stack : undefined
      useUIStore.getState().sendAgentMessage(`Agent Error: ${errMsg}`, 'agent', undefined, {
        isError: true,
        errorDetails: errStack || errMsg,
        snippet: errMsg
      })
    } finally {
      setIsExecuting(false)
      abortControllerRef.current = null
    }
  }

  const handleModelQuickChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value
    if (isExecuting) {
      handleCancelExecution()
    }
    setCurrentModelId(newId)
    AiModelRouter.getInstance().updateConfig({ selectedModelId: newId })
  }

  const handleUndoTurn = () => {
    const tools = PlcAgentTools.getInstance()
    const res = tools.revertLastTurn()
    useUIStore.getState().sendAgentMessage(res.message, 'agent')
  }

  const handleSaveActiveBlockToRag = () => {
    if (!activeTab) return
    const rag = RagKnowledgeEngine.getInstance()

    if (activeTab.type === 'lad') {
      const lad = ladBlocks.find((b) => b.fileName === activeTab.targetId || b.name === activeTab.title)
      if (lad) {
        rag.saveStandardBlock({
          name: lad.name,
          category: 'sequencing',
          description: `Company Standard LAD block: ${lad.name}`,
          blockType: 'LAD',
          contentJson: JSON.stringify(lad, null, 2)
        })
        setSavedStandardNotice(`Saved ${lad.name} to AI Standard Library!`)
        setTimeout(() => setSavedStandardNotice(null), 2500)
      }
    } else if (activeTab.type === 'scl') {
      const scl = sclBlocks.find((b) => b.fileName === activeTab.targetId || b.name === activeTab.title)
      if (scl) {
        rag.saveStandardBlock({
          name: scl.name,
          category: 'analog',
          description: `Company Standard SCL block: ${scl.name}`,
          blockType: 'SCL',
          contentJson: scl.code
        })
        setSavedStandardNotice(`Saved ${scl.name} to AI Standard Library!`)
        setTimeout(() => setSavedStandardNotice(null), 2500)
      }
    }
  }

  return (
    <div
      data-testid="agent-panel"
      className="cq w-full h-full bg-[#111215] border-l border-[#27272a] flex flex-col select-none text-xs overflow-hidden"
    >
      {/* Header */}
      <div className="h-10 shrink-0 px-3 bg-[#0e0f12] border-b border-[#27272a] flex items-center justify-between gap-2 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-[#7c3aed] flex items-center justify-center text-white font-mono font-bold text-xs">
            <Bot className="w-3.5 h-3.5" />
          </div>
          <span className="font-mono font-bold text-industrial-100 tracking-wide uppercase text-xs">
            Rungline <span className="text-purple-400">Agent</span>
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            data-testid="btn-open-debug-log"
            onClick={() => useUIStore.getState().setDebugLogModalOpen(true)}
            className="flex items-center gap-1 text-industrial-400 hover:text-cyan-400 p-1 hover:bg-[#1f2228] transition-colors rounded-none"
            title="Black-Box Flight Recorder & Telemetry Logs"
          >
            <FileText className="w-3.5 h-3.5 text-cyan-400" />
            <span className="under-600:hidden font-mono text-[10px] text-cyan-300">Logs</span>
          </button>
          <button
            data-testid="btn-open-book-trainer"
            onClick={() => setBookTrainerOpen(true)}
            className="flex items-center gap-1 text-industrial-400 hover:text-amber-400 p-1 hover:bg-[#1f2228] transition-colors rounded-none"
            title="MEB Automation Rulebook & Curriculum Trainer"
          >
            <BookOpen className="w-3.5 h-3.5 text-amber-400" />
            <span className="under-600:hidden font-mono text-[10px] text-amber-300">Rules</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-industrial-400 hover:text-industrial-200 p-1 hover:bg-[#1f2228] transition-colors"
            title="AI Model & Provider Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          <button
            data-testid="ai-dock-collapse-button"
            onClick={toggleRightDock}
            className="text-industrial-400 hover:text-white p-1 hover:bg-[#1f2228] transition-colors"
            title="Collapse AI Panel"
          >
            <PanelRightClose className="w-4 h-4 text-purple-400" />
          </button>
        </div>
      </div>

      {/* Mode & Model Tier Switch */}
      <div className="p-2 bg-[#14161b] border-b border-[#27272a] space-y-1.5 shrink-0">
        {/* Auto-Apply vs Diff-View Approval Toggle */}
        <div className="flex items-center justify-between bg-[#0c0d10] p-1 border border-[#27272a] rounded-none">
          <button
            data-testid="agent-mode-auto-apply"
            onClick={() => setAgentMode('auto-apply')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 text-[11px] font-medium rounded-none transition-all ${
              agentMode === 'auto-apply'
                ? 'bg-purple-950 text-purple-200 border border-purple-700 shadow-xs'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            <CheckCheck className="w-3 h-3 text-purple-400" />
            <span>Auto-Apply</span>
          </button>

          <button
            data-testid="agent-mode-diff-view"
            onClick={() => setAgentMode('diff-view')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 text-[11px] font-medium rounded-none transition-all ${
              agentMode === 'diff-view'
                ? 'bg-blue-950 text-blue-200 border border-blue-700 shadow-xs'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            <Split className="w-3 h-3 text-blue-400" />
            <span>Diff-View Approval</span>
          </button>
        </div>

        {/* Model Tier Selector */}
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-1 shrink-0">
            <button
              data-testid="agent-tier-fast-flash"
              onClick={() => setAgentTier('fast-flash')}
              className={`px-2 py-0.5 font-mono text-[10px] rounded-none transition-colors flex items-center gap-1 ${
                agentTier === 'fast-flash'
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-800 font-bold'
                  : 'text-industrial-400 hover:text-industrial-200'
              }`}
            >
              <Zap className="w-2.5 h-2.5" />
              <span>Fast Flash</span>
            </button>
            <button
              data-testid="agent-tier-deep-pro"
              onClick={() => setAgentTier('deep-pro')}
              className={`px-2 py-0.5 font-mono text-[10px] rounded-none transition-colors flex items-center gap-1 ${
                agentTier === 'deep-pro'
                  ? 'bg-indigo-950 text-indigo-300 border border-indigo-800 font-bold'
                  : 'text-industrial-400 hover:text-industrial-200'
              }`}
            >
              <Bot className="w-2.5 h-2.5" />
              <span>Deep Pro</span>
            </button>
          </div>

          {/* Quick Model Selector Dropdown */}
          <select
            title="Model"
            data-testid="agent-model-quick-select"
            value={currentModelId}
            onChange={handleModelQuickChange}
            className="flex-1 min-w-0 bg-industrial-950 border border-industrial-700 text-industrial-200 text-[10px] font-mono px-1 py-0.5 rounded-none focus:outline-hidden truncate"
          >
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.id}
              </option>
            ))}
          </select>
        </div>

        {/* Live Context Chips & Actions */}
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className="flex flex-wrap gap-1">
            <span className="px-1.5 py-0.5 rounded-none text-[10px] font-mono bg-industrial-900 border border-industrial-800 text-industrial-300 flex items-center gap-1">
              <Cpu className="w-2.5 h-2.5 text-cyan-400" />
              <span>{metadata?.targetCpu ? 'S7-1200' : 'Virtual S7'}</span>
            </span>
            <span className="px-1.5 py-0.5 rounded-none text-[10px] font-mono bg-industrial-900 border border-industrial-800 text-industrial-300">
              CPU: {cpuState}
            </span>
            {totalCollisions > 0 && (
              <span className="px-1.5 py-0.5 rounded-none text-[10px] font-mono bg-red-950 border border-red-800 text-red-300 flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" />
                <span>{totalCollisions} Overlaps</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* Save to RAG Standard Library Button */}
            {activeTab && (activeTab.type === 'lad' || activeTab.type === 'scl') && (
              <button
                data-testid="btn-save-rag-standard"
                onClick={handleSaveActiveBlockToRag}
                title={`Save ${activeTab.title} to AI Standard Library`}
                className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-950/40 hover:bg-amber-950/80 border border-amber-800/60 text-amber-300 text-[10px] font-semibold rounded-none transition-colors"
              >
                <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400/20" />
                <span>Save</span>
              </button>
            )}
            <button
              onClick={handleUndoTurn}
              title="Undo last agent mutation turn"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-none text-[10px] text-industrial-400 hover:text-white bg-industrial-850 hover:bg-industrial-800 border border-industrial-750 transition-colors"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              <span>Undo Turn</span>
            </button>
          </div>
        </div>
        {savedStandardNotice && (
          <div className="text-[10px] text-emerald-400 text-center font-mono">{savedStandardNotice}</div>
        )}
      </div>

      {/* Live Diagnostic Card (if active) */}
      {activeDiagnostic && !activeDiagnostic.isEnergized && activeDiagnostic.blockingContact && (
        <div data-testid="coil-diagnostic-card" className="p-3 bg-rose-950/40 border-b border-rose-800/80 space-y-2 rounded-none">
          <div className="flex items-center justify-between text-rose-300 font-bold text-xs">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-rose-500 animate-ping rounded-none" />
              <span>Coil Diagnostic: {activeDiagnostic.operand}</span>
            </div>
            <button
              onClick={() => {
                setActiveDiagnostic(null)
                window.dispatchEvent(new CustomEvent('plc:clear-blocking-highlight'))
              }}
              className="text-industrial-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="text-[11px] text-industrial-200 leading-snug">
            Blocking Contact: <strong className="text-white">{activeDiagnostic.blockingContact.operand}</strong> ({activeDiagnostic.blockingContact.address}) is evaluated as <strong className="text-rose-400">FALSE</strong>.
          </div>

          <button
            data-testid="btn-force-blocking-bit"
            onClick={() => {
              if (activeDiagnostic.blockingContact) {
                CoilDiagnosticEngine.forceBlockingBitTrue(activeDiagnostic.blockingContact.address)
                setActiveDiagnostic(null)
                window.dispatchEvent(new CustomEvent('plc:clear-blocking-highlight'))
              }
            }}
            className="w-full flex items-center justify-center gap-1.5 py-1 px-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-[11px] rounded-none shadow-sm transition-all"
          >
            <Zap className="w-3 h-3" />
            <span>Force {activeDiagnostic.blockingContact.operand} TRUE for Test</span>
          </button>
        </div>
      )}

      {/* Chat Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-3">
        {agentMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col space-y-1 ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div className="flex items-center gap-1 text-[10px] text-industrial-500 font-mono">
              {msg.sender === 'agent' ? (
                <>
                  <Bot className="w-3 h-3 text-purple-400" />
                  <span>Rungline Agent</span>
                </>
              ) : (
                <span>Engineer</span>
              )}
            </div>

            <div
              className={`p-2.5 max-w-[90%] min-w-0 text-xs leading-relaxed font-sans select-text border [overflow-wrap:anywhere] ${
                msg.sender === 'user'
                  ? 'bg-cyan-950/40 border-cyan-700/60 text-cyan-100'
                  : 'bg-[#0f1115] border-[#27272a] text-industrial-200'
              }`}
            >
              <MarkdownMessageRenderer text={msg.text} />
              {msg.isError && (
                <div
                  data-testid="agent-error-card"
                  className="mt-2 p-2 bg-red-950/60 border border-red-800 text-red-200 font-mono text-[11px] space-y-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-1 font-bold text-red-400 border-b border-red-900/60 pb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      <span>SYNTHESIS FAILED — NO LADDER MODIFICATIONS</span>
                    </div>
                    <button
                      data-testid="btn-copy-error-trace"
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(msg.errorDetails || msg.text)
                      }}
                      className="px-1.5 py-0.5 bg-red-900 hover:bg-red-800 text-white text-[10px] font-bold rounded-none cursor-pointer border border-red-700"
                    >
                      [Copy Error Trace]
                    </button>
                  </div>
                  <div className="text-[10px] text-red-300 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                    {msg.errorDetails || msg.text}
                  </div>
                </div>
              )}
              {(msg.rawTraceSnippet || msg.rawJson) && (
                <div className="mt-2 pt-1 border-t border-[#27272a]">
                  <details className="text-[10px] font-mono group">
                    <summary
                      data-testid="btn-toggle-raw-trace"
                      className="cursor-pointer text-purple-400 hover:text-purple-300 select-none py-0.5 flex items-center gap-1"
                    >
                      <span>[+] View Raw AI Trace & JSON</span>
                    </summary>
                    <div className="mt-1 p-2 bg-[#090a0d] border border-[#27272a] text-industrial-300 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
                      {msg.rawTraceSnippet && (
                        <div className="mb-2">
                          <span className="text-purple-400 font-bold block mb-0.5">Prompt & Model Snippet:</span>
                          {msg.rawTraceSnippet}
                        </div>
                      )}
                      {msg.rawJson && (
                        <div>
                          <span className="text-cyan-400 font-bold block mb-0.5">Payload / AST JSON:</span>
                          {msg.rawJson}
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              )}
              {msg.ragRulesConsulted && msg.ragRulesConsulted.length > 0 && (
                <div
                  data-testid="rag-consulted-badge"
                  className="mt-2 pt-1.5 border-t border-[#27272a] flex flex-wrap items-center gap-1 font-mono text-[10px] text-amber-300"
                >
                  <span className="font-bold flex items-center gap-1 text-amber-400">
                    <BookOpen className="w-3 h-3 text-amber-400" />
                    RAG Context:
                  </span>
                  {msg.ragRulesConsulted.map((ruleName) => (
                    <span
                      key={ruleName}
                      className="px-1.5 py-0.5 bg-amber-950/80 border border-amber-800/80 text-amber-200"
                    >
                      {ruleName}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {isExecuting && (
          <div className="flex items-center justify-between gap-2 p-1.5 bg-red-950/20 border border-red-900/40 text-red-400 text-[11px] font-mono">
            <div className="flex items-center gap-2 animate-pulse">
              <Sparkles className="w-3 h-3 text-purple-400" />
              <span className="text-purple-300">Synthesizing industrial logic & verifying AST...</span>
            </div>
            <button
              data-testid="btn-cancel-synthesis"
              type="button"
              onClick={handleCancelExecution}
              className="px-2 py-0.5 bg-red-900/60 hover:bg-red-800 text-red-200 border border-red-700 text-[10px] font-bold cursor-pointer rounded-none uppercase transition-all"
            >
              [■ Cancel]
            </button>
          </div>
        )}
      </div>

      {/* Input Prompt Box */}
      <form onSubmit={handleSubmit} className="p-2.5 bg-[#0e0f12] border-t border-[#27272a] shrink-0">
        <div className="flex items-stretch bg-[#14161b] border border-[#27272a] focus-within:border-purple-500">
          <input
            data-testid="agent-input-prompt"
            type="text"
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            placeholder="Ask agent to synthesize, refactor, or debug..."
            className="flex-1 min-w-0 bg-transparent rounded-none pl-3 py-2 text-xs text-industrial-100 placeholder-industrial-500 focus:outline-hidden"
          />
          <button
            data-testid="agent-submit-prompt"
            type="submit"
            className="shrink-0 px-2 text-purple-400 hover:text-purple-300 disabled:opacity-40 cursor-pointer rounded-none"
            disabled={!inputPrompt.trim() || isExecuting}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>

      {/* Modals */}
      <AiSettingsModal isOpen={isSettingsOpen} onClose={() => setSettingsOpen(false)} />
      <PlcBookTrainerModal isOpen={isBookTrainerOpen} onClose={() => setBookTrainerOpen(false)} />
      <DiffViewerModal
        isOpen={isDiffModalOpen}
        changeset={pendingChangeset}
        onClose={() => setDiffModalOpen(false)}
        onApproved={(report) => {
          useUIStore.getState().sendAgentMessage(`[Approved & Applied] ${report}`)
        }}
      />
    </div>
  )
}
