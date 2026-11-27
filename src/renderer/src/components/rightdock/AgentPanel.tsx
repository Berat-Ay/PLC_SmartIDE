import React, { useState, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Sparkles,
  Bot,
  Send,
  Zap,
  CheckCheck,
  Split,
  Cpu,
  AlertTriangle,
  Settings,
  RotateCcw,
  Star,
  PanelRightClose,
  X,
  BookOpen,
  FileText
} from 'lucide-react'
import { useUIStore } from '../../stores/useUIStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { formatCpuChipLabel } from '../../utils/cpuChipLabel'
import { parseInlineMarkdownTokens } from '../../utils/inlineMarkdown'
import { AiModelRouter, AgentExecutionResponse, AiProvider, sanitizeUserPrompt } from '../../services/ai/AiModelRouter'
import { isAgentAbortError } from '../../services/ai/aiTypes'
import { resolveOllamaModel } from '../../services/ai/OllamaClient'
import { PlcAgentTools, StagedFileChange } from '../../services/ai/PlcAgentTools'
import { CoilDiagnosticEngine, CoilDiagnosticReport } from '../../services/ai/CoilDiagnosticEngine'
import { RagKnowledgeEngine } from '../../services/ai/RagKnowledgeEngine'
import { AiSettingsModal } from './AiSettingsModal'
import { formatAcceptanceLine } from '../../services/scenarios/ScenarioAcceptance'
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
  const tokens = parseInlineMarkdownTokens(str)
  if (tokens.length === 0) return str
  return tokens.map((tok, idx) => {
    if (tok.type === 'bold') {
      return (
        <strong key={idx} className="font-bold text-white">
          {tok.value}
        </strong>
      )
    }
    if (tok.type === 'code') {
      return (
        <code key={idx} className="px-1 py-0.5 bg-[#1a1c22] border border-[#2e323b] text-cyan-300 font-mono text-[11px] rounded-none">
          {tok.value}
        </code>
      )
    }
    return <span key={idx}>{tok.value}</span>
  })
}

export const AgentPanel: React.FC = () => {
  const {
    toggleRightDock,
    agentMode,
    agentTier,
    agentMessages,
    setAgentMode,
    setAgentTier,
    tabs,
    activeTabId,
    isBookTrainerOpen,
    setBookTrainerOpen,
    pendingCoilDiagnostic,
    setPendingCoilDiagnostic
  } = useUIStore(
    useShallow((s) => ({
      toggleRightDock: s.toggleRightDock,
      agentMode: s.agentMode,
      agentTier: s.agentTier,
      agentMessages: s.agentMessages,
      setAgentMode: s.setAgentMode,
      setAgentTier: s.setAgentTier,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      isBookTrainerOpen: s.isBookTrainerOpen,
      setBookTrainerOpen: s.setBookTrainerOpen,
      pendingCoilDiagnostic: s.pendingCoilDiagnostic,
      setPendingCoilDiagnostic: s.setPendingCoilDiagnostic
    }))
  )
  const metadata = useProjectStore((s) => s.metadata)
  const cpuState = useProjectStore((s) => s.cpuState)
  const totalCollisions = useTagStore((s) => s.totalCollisions)
  const ladBlocks = useBlockStore((s) => s.ladBlocks)
  const sclBlocks = useBlockStore((s) => s.sclBlocks)
  const hardwareConfig = useHardwareStore((s) => s.config)
  const cpuChipLabel = formatCpuChipLabel(hardwareConfig, metadata?.targetCpu)

  const [inputPrompt, setInputPrompt] = useState('')
  const [isSettingsOpen, setSettingsOpen] = useState(false)
  const [isDiffModalOpen, setDiffModalOpen] = useState(false)
  const [pendingChangeset, setPendingChangeset] = useState<StagedFileChange[]>([])
  const [activeDiagnostic, setActiveDiagnostic] = useState<CoilDiagnosticReport | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [savedStandardNotice, setSavedStandardNotice] = useState<string | null>(null)
  const initialCfg = AiModelRouter.getInstance().getConfig()
  const [provider, setProvider] = useState<AiProvider>(initialCfg.provider)
  const [currentModelId, setCurrentModelId] = useState(
    initialCfg.selectedModelId || 'gemini-2.5-flash'
  )
  const [availableModels, setAvailableModels] = useState(
    initialCfg.availableModels || []
  )
  const [ollamaModel, setOllamaModel] = useState(resolveOllamaModel(initialCfg))
  const [ollamaModels, setOllamaModels] = useState(initialCfg.ollamaModels || [])
  const [openaiModel, setOpenaiModel] = useState(initialCfg.openaiModel || '')
  const [openaiModels, setOpenaiModels] = useState(initialCfg.openaiModels || [])
  const activeTurnIdRef = useRef(0)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const promptInputRef = useRef<HTMLInputElement | null>(null)
  const diagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (diagTimerRef.current) clearTimeout(diagTimerRef.current)
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [agentMessages.length])

  useEffect(() => {
    if (!isSettingsOpen) {
      const cfg = AiModelRouter.getInstance().getConfig()
      setProvider(cfg.provider)
      setCurrentModelId(cfg.selectedModelId)
      setAvailableModels(cfg.availableModels || [])
      setOllamaModel(resolveOllamaModel(cfg))
      setOllamaModels(cfg.ollamaModels || [])
      setOpenaiModel(cfg.openaiModel || '')
      setOpenaiModels(cfg.openaiModels || [])
    }
  }, [isSettingsOpen])

  // Consume Live Diagnostic requests triggered from Ladder Canvas (via App.tsx pendingCoilDiagnostic)
  useEffect(() => {
    if (!pendingCoilDiagnostic) return
    const detail = pendingCoilDiagnostic
    setPendingCoilDiagnostic(null)

    const { tabs: curTabs, activeTabId: curActiveTabId } = useUIStore.getState()
    const currentTab = curTabs.find((t) => t.id === curActiveTabId)
    const currentLadBlocks = useBlockStore.getState().ladBlocks
    const activeLad = currentLadBlocks.find((b) => b.fileName === currentTab?.targetId) || currentLadBlocks[0]
    if (!activeLad) return

    const report = CoilDiagnosticEngine.diagnoseCoil(activeLad, detail.networkNumber, detail.operand)
    setActiveDiagnostic(report)

    if (report.blockingContact?.nodeId) {
      window.dispatchEvent(
        new CustomEvent('plc:highlight-blocking-node', {
          detail: { nodeId: report.blockingContact.nodeId }
        })
      )
    }

    useUIStore.getState().sendAgentMessage(`Diagnostic request: Why is coil '${detail.operand}' OFF?`, 'user')
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current)
    diagTimerRef.current = setTimeout(() => {
      useUIStore.getState().sendAgentMessage(report.explanationEn || report.explanationTr, 'agent')
    }, 300)
  }, [pendingCoilDiagnostic, setPendingCoilDiagnostic])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  const abortControllerRef = useRef<AbortController | null>(null)

  const handleCancelExecution = () => {
    if (!isExecuting || isCancelling) return
    setIsCancelling(true)
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputPrompt.trim() || isExecuting) return

    const promptText = sanitizeUserPrompt(inputPrompt)
    if (!promptText) return
    setInputPrompt('')
    // Log user message
    useUIStore.getState().sendAgentMessage(promptText, 'user')
    await runAgent((signal) => AiModelRouter.getInstance().executePrompt(promptText, agentTier, agentMode, signal))
  }

  // Test first: the circuit is written only after the user approves the test
  const [testAwaitingApproval, setTestAwaitingApproval] = useState(false)

  const handleApproveTest = async () => {
    if (isExecuting) return
    useUIStore.getState().sendAgentMessage('Testi onaylıyorum, devreyi yaz.', 'user')
    await runAgent((signal) => AiModelRouter.getInstance().approvePendingTest(agentMode, signal))
  }

  const handleDiscardTest = () => {
    AiModelRouter.getInstance().cancelPendingTest()
    setTestAwaitingApproval(false)
    useUIStore.getState().sendAgentMessage('Test reddedildi. Yeni bir istek yazabilirsiniz.', 'agent')
  }

  const runAgent = async (call: (signal: AbortSignal) => Promise<AgentExecutionResponse>) => {
    const turnId = ++activeTurnIdRef.current
    setIsExecuting(true)
    setIsCancelling(false)
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const response = await call(controller.signal)
      if (turnId !== activeTurnIdRef.current) return

      // Diff-view stages every change. In auto-apply a circuit that failed its test is staged for review instead
      if (response.stagedChangeset && response.stagedChangeset.length > 0) {
        setPendingChangeset(response.stagedChangeset as StagedFileChange[])
        setDiffModalOpen(true)
      }

      useUIStore.getState().sendAgentMessage(response.replyText, 'agent', response.ragRulesConsulted, {
        snippet: response.rawTraceSnippet,
        rawJson: response.rawJson,
        isError: response.isError,
        errorDetails: response.errorDetails,
        acceptanceReport: response.acceptanceReport
      })
    } catch (err: unknown) {
      if (turnId !== activeTurnIdRef.current) return
      if (isAgentAbortError(err, controller.signal)) {
        useUIStore.getState().sendAgentMessage('Generation cancelled by user.', 'agent')
      } else {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errStack = err instanceof Error ? err.stack : undefined
        useUIStore.getState().sendAgentMessage(`Agent Error: ${errMsg}`, 'agent', undefined, {
          isError: true,
          errorDetails: errStack || errMsg,
          snippet: errMsg
        })
      }
    } finally {
      if (turnId === activeTurnIdRef.current) {
        setIsExecuting(false)
        setIsCancelling(false)
        abortControllerRef.current = null
        setTestAwaitingApproval(AiModelRouter.getInstance().hasPendingTest())
      }
    }
  }

  const handleModelQuickChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value
    if (isExecuting) {
      handleCancelExecution()
    }
    if (provider === 'ollama') {
      setOllamaModel(newId)
      AiModelRouter.getInstance().updateConfig({ ollamaModel: newId })
    } else if (provider === 'openai') {
      setOpenaiModel(newId)
      AiModelRouter.getInstance().updateConfig({ openaiModel: newId })
    } else {
      setCurrentModelId(newId)
      AiModelRouter.getInstance().updateConfig({ selectedModelId: newId })
    }
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
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(() => setSavedStandardNotice(null), 2500)
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
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(() => setSavedStandardNotice(null), 2500)
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
            title="Circuit patterns and your notes"
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
            value={provider === 'ollama' ? ollamaModel : provider === 'openai' ? openaiModel : currentModelId}
            onChange={handleModelQuickChange}
            className="flex-1 min-w-0 bg-industrial-950 border border-industrial-700 text-industrial-200 text-[10px] font-mono px-1 py-0.5 rounded-none focus:outline-hidden truncate"
          >
            {(provider === 'ollama'
              ? ollamaModels.length > 0
                ? ollamaModels
                : [{ id: ollamaModel, displayName: ollamaModel }]
              : provider === 'openai'
                ? openaiModels.length > 0
                  ? openaiModels
                  : [{ id: openaiModel || 'gpt-4o', displayName: openaiModel || 'gpt-4o' }]
                : availableModels
            ).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || m.id}
              </option>
            ))}
          </select>
        </div>

        {/* Live Context Chips & Actions */}
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className="flex flex-wrap gap-1">
            <span
              data-testid="agent-cpu-chip"
              title={`Active Target CPU: ${cpuChipLabel}`}
              className="px-1.5 py-0.5 rounded-none text-[10px] font-mono bg-industrial-900 border border-industrial-800 text-industrial-300 flex items-center gap-1"
            >
              <Cpu className="w-2.5 h-2.5 text-cyan-400" />
              <span>{cpuChipLabel}</span>
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
            Blocking Element: <strong className="text-white">{activeDiagnostic.blockingContact.operand}</strong> ({activeDiagnostic.blockingContact.address}) is evaluated as{' '}
            <strong className="text-rose-400">{activeDiagnostic.blockingContact.evaluatedValue ? 'TRUE' : 'FALSE'}</strong>.
          </div>

          <button
            data-testid="btn-force-blocking-bit"
            onClick={() => {
              if (activeDiagnostic.blockingContact) {
                CoilDiagnosticEngine.forceBlockingBit(
                  activeDiagnostic.blockingContact.address,
                  activeDiagnostic.blockingContact.recommendedForceValue
                )
                setActiveDiagnostic(null)
                window.dispatchEvent(new CustomEvent('plc:clear-blocking-highlight'))
              }
            }}
            className="w-full flex items-center justify-center gap-1.5 py-1 px-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-[11px] rounded-none shadow-sm transition-all"
          >
            <Zap className="w-3 h-3" />
            <span>
              Force {activeDiagnostic.blockingContact.operand} {activeDiagnostic.blockingContact.recommendedForceValue ? 'TRUE' : 'FALSE'} for Test
            </span>
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
              {msg.acceptanceReport && (
                <div
                  data-testid="agent-acceptance-badge"
                  title={`${msg.acceptanceReport.scenarioTitle}. ${
                    msg.acceptanceReport.gate === 'enforce'
                      ? 'Spec failures were sent to the model (enforce): an upper bound, not the model\'s own result.'
                      : 'Shown only to you; not sent to the model.'
                  }`}
                  className={`mt-2 inline-flex flex-wrap items-center gap-1.5 px-1.5 py-0.5 border font-mono text-[10px] ${
                    msg.acceptanceReport.specPassed === msg.acceptanceReport.specTotal
                      ? 'bg-emerald-950/50 border-emerald-800 text-emerald-300'
                      : 'bg-amber-950/50 border-amber-800 text-amber-300'
                  }`}
                >
                  <span className="font-bold">Kabul · {msg.acceptanceReport.scenarioId}</span>
                  <span>{formatAcceptanceLine(msg.acceptanceReport)}</span>
                  {msg.acceptanceReport.gate === 'enforce' && <span className="text-industrial-400">[enforce]</span>}
                </div>
              )}
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
                        navigator.clipboard?.writeText(msg.errorDetails || msg.text).catch(() => {})
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
              disabled={isCancelling}
              onClick={handleCancelExecution}
              className="px-2 py-0.5 bg-red-900/60 hover:bg-red-800 disabled:opacity-50 text-red-200 border border-red-700 text-[10px] font-bold cursor-pointer rounded-none uppercase transition-all"
            >
              {isCancelling ? '[Cancelling...]' : '[■ Cancel]'}
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Test first: approve the test, or write a correction in the input box */}
      {testAwaitingApproval && !isExecuting && (
        <div className="px-2.5 pt-2 bg-[#0e0f12] border-t border-[#27272a] shrink-0 flex items-center gap-2 text-[11px]">
          <button
            data-testid="btn-approve-test"
            type="button"
            onClick={handleApproveTest}
            className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-none cursor-pointer"
          >
            Testi onayla ve devreyi yaz
          </button>
          <button
            data-testid="btn-discard-test"
            type="button"
            onClick={handleDiscardTest}
            className="px-2 py-1 bg-[#1c1f26] hover:bg-[#27272a] text-gray-300 border border-[#27272a] rounded-none cursor-pointer"
          >
            Vazgeç
          </button>
          <span className="text-gray-500">ya da düzeltmeyi aşağıya yazın</span>
        </div>
      )}

      {/* Input Prompt Box */}
      <form onSubmit={handleSubmit} className="p-2.5 bg-[#0e0f12] border-t border-[#27272a] shrink-0">
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault()
              promptInputRef.current?.focus()
            }
          }}
          className="flex items-stretch bg-[#14161b] border border-[#27272a] focus-within:border-purple-500"
        >
          <input
            ref={promptInputRef}
            data-testid="agent-input-prompt"
            type="text"
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            placeholder="Ask agent to synthesize, refactor, or debug..."
            className="flex-1 min-w-0 bg-transparent rounded-none pl-3 py-2 text-xs text-industrial-100 placeholder-industrial-500 select-text focus:outline-none"
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
          useUIStore.getState().sendAgentMessage(`[Approved & Applied] ${report}`, 'agent')
        }}
      />
    </div>
  )
}
