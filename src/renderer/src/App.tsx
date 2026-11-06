import React, { useEffect, useState, useRef } from 'react'
import { TopAppBar } from './components/topbar/TopAppBar'
import { ProjectTree } from './components/leftdock/ProjectTree'
import { EditorWorkspace } from './components/center/EditorWorkspace'
import { BottomInspector } from './components/bottomdock/BottomInspector'
import { AgentPanel } from './components/rightdock/AgentPanel'
import { InstructionsTreePanel } from './components/ladder/InstructionsTreePanel'
import { AddBlockModal } from './components/leftdock/AddBlockModal'
import { DebugLogModal } from './components/debug/DebugLogModal'
import { ProjectStartupWizard } from './components/wizard/ProjectStartupWizard'
import { useProjectStore } from './stores/useProjectStore'
import { useUIStore } from './stores/useUIStore'
import { useTagStore } from './stores/useTagStore'
import { useCrossRefStore } from './stores/useCrossRefStore'
import { useRuntimeStore } from './stores/useRuntimeStore'
import { useBlockStore } from './stores/useBlockStore'
import { BlackBoxLogger } from './services/diagnostics/BlackBoxLogger'
import { Bot, Layers } from 'lucide-react'
import { AiModelRouter } from './services/ai/AiModelRouter'

const EXTERNAL_WRITE_QUIET_MS = 2000
// The docks may not take so much of the window that the editor cannot show a toolbar
const LEFT_DOCK_MAX_SHARE = 0.22
const RIGHT_DOCK_MAX_SHARE = 0.28

if (typeof window !== 'undefined') {
  ;(window as any).useProjectStore = useProjectStore
  ;(window as any).useUIStore = useUIStore
  ;(window as any).useTagStore = useTagStore
  ;(window as any).useCrossRefStore = useCrossRefStore
  ;(window as any).useRuntimeStore = useRuntimeStore
  ;(window as any).useBlockStore = useBlockStore
  ;(window as any).BlackBoxLogger = BlackBoxLogger.getInstance()
  if (!(window as any).plcTestContext) {
    ;(window as any).plcTestContext = {}
  }
  ;(window as any).plcTestContext.BlackBoxLogger = BlackBoxLogger.getInstance()
  ;(window as any).plcTestContext.useTagStore = useTagStore
}

export const App: React.FC = () => {
  const { isLoaded, metadata } = useProjectStore()
  const {
    isPortalViewOpen,
    leftDockCollapsed,
    leftDockWidth,
    setLeftDockWidth,
    rightDockCollapsed,
    rightDockWidth,
    setRightDockWidth,
    toggleRightDock,
    rightActiveTab,
    setRightActiveTab,
    setBottomActiveTab
  } = useUIStore()

  // Resizing state for Left Dock
  const [isResizingLeft, setIsResizingLeft] = useState(false)
  const startXLeftRef = useRef(0)
  const startWidthLeftRef = useRef(leftDockWidth)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingLeft) return
      const delta = e.clientX - startXLeftRef.current
      const limit = Math.min(420, window.innerWidth * LEFT_DOCK_MAX_SHARE)
      const newWidth = Math.min(limit, Math.max(180, startWidthLeftRef.current + delta))
      setLeftDockWidth(newWidth)
    }

    const handleMouseUp = () => setIsResizingLeft(false)

    if (isResizingLeft) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingLeft, setLeftDockWidth])

  // Resizing state for Right Dock
  const [isResizingRight, setIsResizingRight] = useState(false)
  const startXRightRef = useRef(0)
  const startWidthRightRef = useRef(rightDockWidth)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRight) return
      const delta = startXRightRef.current - e.clientX
      const limit = Math.min(540, window.innerWidth * RIGHT_DOCK_MAX_SHARE)
      const newWidth = Math.min(limit, Math.max(260, startWidthRightRef.current + delta))
      setRightDockWidth(newWidth)
    }

    const handleMouseUp = () => setIsResizingRight(false)

    if (isResizingRight) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingRight, setRightDockWidth])

  // Global keyboard shortcuts: F11 (Cross-Reference), F7 & Ctrl+B (Compile Project)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        setBottomActiveTab('crossref')
      } else if (e.key === 'F7' || ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B'))) {
        e.preventDefault()
        useProjectStore.getState().compileProject()
        setBottomActiveTab('compile')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setBottomActiveTab])

  useEffect(() => {
    AiModelRouter.getInstance().hydrateSecrets().catch((err) => console.warn('Could not load stored API keys:', err))
  }, [])

  // Bi-directional IPC Hot-reload listener from main process
  useEffect(() => {
    if (window.electronApi) {
      let reloadTimer: ReturnType<typeof setTimeout> | null = null
      const unsubscribe = window.electronApi.onFileChanged((payload) => {
        const project = useProjectStore.getState()
        if (payload.projectPath !== project.projectPath) return
        // This app's own saves come back through the watcher too
        if (Date.now() - project.lastLocalWriteAt < EXTERNAL_WRITE_QUIET_MS) return
        if (project.isDirty) {
          console.warn(`[File Watcher] ${payload.relativePath} changed on disk; keeping unsaved edits`)
          return
        }
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(async () => {
          const reloaded = await window.electronApi.openProject(payload.projectPath)
          useProjectStore.getState().setProject(reloaded)
        }, 300)
      })
      return () => {
        if (reloadTimer) clearTimeout(reloadTimer)
        unsubscribe()
      }
    }
    return undefined
  }, [])

  // If no project is loaded or user requested Portal View: render Startup Wizard!
  if (!isLoaded || !metadata || isPortalViewOpen) {
    return <ProjectStartupWizard />
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0b0d10] text-industrial-100 font-sans overflow-hidden select-none">
      {/* Top Application Bar (Menu Bar + Single-Row Command Bar) */}
      <TopAppBar />

      {/* Main 3-Column Industrial Workbench */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Dock: Project Tree with Drag Resizer */}
        {!leftDockCollapsed && (
          <aside
            style={{ width: `min(${leftDockWidth}px, ${LEFT_DOCK_MAX_SHARE * 100}vw)` }}
            className="h-full shrink-0 flex overflow-hidden"
          >
            <div className="flex-1 min-w-0 h-full overflow-hidden">
              <ProjectTree />
            </div>
            {/* Splitter resize handle on right border */}
            <div
              onMouseDown={(e) => {
                startXLeftRef.current = e.clientX
                startWidthLeftRef.current = leftDockWidth
                setIsResizingLeft(true)
              }}
              className="w-1 h-full bg-[#27272a] hover:bg-[#00a3a6] cursor-col-resize shrink-0 transition-colors"
            />
          </aside>
        )}

        {/* Center Workspace: Multi-tab & Split-view Editors */}
        <main className="flex-1 min-w-0 h-full overflow-hidden">
          <EditorWorkspace />
        </main>

        {/* Right Dock: Authentic TIA Task Cards (Instructions & AI Agent) with Drag Resizer & 28px Collapsed Rail */}
        {rightDockCollapsed ? (
          <aside
            data-testid="ai-dock-collapsed-rail"
            onClick={toggleRightDock}
            title="Expand Instructions & AI Agent (Alt+2)"
            className="w-7 h-full bg-[#111215] border-l border-[#27272a] flex flex-col items-center py-3 gap-4 cursor-pointer hover:bg-[#181a1f] shrink-0 transition-colors"
          >
            <div className="flex flex-col items-center gap-1 cursor-pointer">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <div className="[writing-mode:vertical-lr] text-[9px] font-mono font-bold tracking-widest text-cyan-300 uppercase select-none">
                INSTRUCTIONS
              </div>
            </div>
            <div className="w-4 h-px bg-[#27272a]" />
            <div className="flex flex-col items-center gap-1 cursor-pointer">
              <Bot className="w-3.5 h-3.5 text-purple-400" />
              <div className="[writing-mode:vertical-lr] text-[9px] font-mono font-bold tracking-widest text-purple-300 uppercase select-none">
                AI AGENT
              </div>
            </div>
          </aside>
        ) : (
          <aside
            data-testid="right-dock-container"
            style={{ width: `min(${rightDockWidth}px, ${RIGHT_DOCK_MAX_SHARE * 100}vw)` }}
            className="h-full shrink-0 flex overflow-hidden flex-col bg-[#111215]"
          >
            {/* Splitter resize handle on left border */}
            <div className="flex-1 flex overflow-hidden">
              <div
                onMouseDown={(e) => {
                  startXRightRef.current = e.clientX
                  startWidthRightRef.current = rightDockWidth
                  setIsResizingRight(true)
                }}
                className="w-1 h-full bg-[#27272a] hover:bg-cyan-500 cursor-col-resize shrink-0 transition-colors"
              />
              <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
                {/* TIA Portal Task Card Tabs Header */}
                <div className="h-7 bg-[#14161b] border-b border-[#27272a] flex items-center px-1 gap-1 shrink-0">
                  <button
                    data-testid="right-dock-tab-instructions"
                    onClick={() => setRightActiveTab('instructions')}
                    className={`h-6 px-2.5 flex items-center gap-1.5 text-[11px] font-mono font-semibold transition-colors rounded-none ${
                      rightActiveTab === 'instructions'
                        ? 'bg-[#1e2229] border border-[#00a3a6] text-cyan-300'
                        : 'border border-transparent text-industrial-400 hover:text-industrial-200 hover:bg-[#181a1f]'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>Instructions</span>
                  </button>
                  <button
                    data-testid="right-dock-tab-agent"
                    onClick={() => setRightActiveTab('agent')}
                    className={`h-6 px-2.5 flex items-center gap-1.5 text-[11px] font-mono font-semibold transition-colors rounded-none ${
                      rightActiveTab === 'agent'
                        ? 'bg-[#1e2229] border border-purple-500 text-purple-300'
                        : 'border border-transparent text-industrial-400 hover:text-industrial-200 hover:bg-[#181a1f]'
                    }`}
                  >
                    <Bot className="w-3.5 h-3.5" />
                    <span>AI Agent</span>
                  </button>
                </div>

                {/* Active Panel View */}
                <div className="flex-1 overflow-hidden">
                  {rightActiveTab === 'instructions' ? (
                    <InstructionsTreePanel />
                  ) : (
                    <AgentPanel />
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Bottom Dock: Engineering Inspector */}
      <BottomInspector />

      {/* Modals */}
      <AddBlockModal />
      <DebugLogModal />
    </div>
  )
}

export default App
