import React, { useState, useRef, useEffect } from 'react'
import {
  Play,
  Square,
  Save,
  CheckCircle2,
  FolderOpen,
  FilePlus,
  Columns,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelBottomClose,
  PanelBottomOpen,
  Sparkles,
  Cpu,
  Eye,
  RotateCcw,
  Share2,
  Bug,
  Hammer,
  Settings,
  X,
  Plus,
  Trash2,
  Zap,
  Terminal,
  FileText
} from 'lucide-react'
import { useProjectStore } from '../../stores/useProjectStore'
import { useUIStore } from '../../stores/useUIStore'
import { useTagStore } from '../../stores/useTagStore'
import { useRuntimeStore } from '../../stores/useRuntimeStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { DoubleCoilDetector } from '../../services/DoubleCoilDetector'
import { TiaExportModal } from './TiaExportModal'
import { LiveGuiDebuggerModal } from '../debug/LiveGuiDebuggerModal'

type MenuKey = 'file' | 'edit' | 'view' | 'plc' | 'tools' | null

export const TopAppBar: React.FC = () => {
  const [activeMenu, setActiveMenu] = useState<MenuKey>(null)
  const [isExportModalOpen, setExportModalOpen] = useState(false)
  const [isGuiDebuggerOpen, setGuiDebuggerOpen] = useState(false)
  const menuBarRef = useRef<HTMLDivElement>(null)

  const {
    metadata,
    isDirty,
    saveProjectToDisk,
    compileProject,
    loadDemoProject,
    closeProject
  } = useProjectStore()

  const { totalCollisions } = useTagStore()
  const {
    state: runtimeState,
    metrics,
    isMonitoring,
    start,
    stop,
    reset,
    toggleMonitoring
  } = useRuntimeStore()

  const {
    leftDockCollapsed,
    rightDockCollapsed,
    bottomDockCollapsed,
    isSplitView,
    toggleLeftDock,
    toggleRightDock,
    toggleBottomDock,
    toggleSplitView,
    setBottomActiveTab,
    setPortalViewOpen,
    tabs,
    activeTabId
  } = useUIStore()

  const { ladBlocks, updateLadBlock } = useBlockStore()

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleOpenProject = async () => {
    setActiveMenu(null)
    if (window.electronApi) {
      const selected = await window.electronApi.selectProjectDirectory()
      if (selected) {
        const payload = await window.electronApi.openProject(selected)
        useProjectStore.getState().setProject(payload)
      }
    } else {
      loadDemoProject()
    }
  }

  const handleCompile = () => {
    setActiveMenu(null)
    compileProject()
    setBottomActiveTab('compile')
  }

  const handleAutoMergeAllCoils = () => {
    setActiveMenu(null)
    const activeLad = ladBlocks[0]
    if (!activeLad) return
    const conflicts = DoubleCoilDetector.detectConflicts(activeLad)
    if (conflicts.length > 0) {
      const refactored = DoubleCoilDetector.autoRefactorBlock(activeLad, conflicts[0].operand)
      updateLadBlock(activeLad.fileName, refactored)
    }
  }

  return (
    <header className="flex flex-col bg-[#111214] border-b border-[#27272a] select-none z-40 shrink-0">
      {/* =========================================================================
          ROW 1: Native-Style Desktop Engineering Menu Bar (Height: 24px)
          ========================================================================= */}
      <div
        ref={menuBarRef}
        className="h-6 bg-[#111214] border-b border-[#23252a] px-2 flex items-center justify-between text-xs font-sans text-industrial-300 relative"
      >
        <div className="flex items-center gap-0.5">
          {/* S7 Badge */}
          <div className="flex items-center gap-1.5 px-2 py-0.5 mr-2 font-mono font-bold text-[11px] text-[#00a3a6] border-r border-[#27272a]">
            <Cpu className="w-3.5 h-3.5 text-[#00a3a6]" />
            <span>S7-IDE</span>
          </div>

          {/* FILE MENU */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'file' ? null : 'file')}
              className={`px-2 py-0.5 text-[11px] hover:text-white transition-colors ${
                activeMenu === 'file' ? 'bg-[#27272a] text-white' : 'hover:bg-[#1c1e22]'
              }`}
            >
              File
            </button>
            {activeMenu === 'file' && (
              <div className="absolute top-6 left-0 w-60 bg-[#181a1f] border border-[#27272a] shadow-2xl py-1 z-50 text-[11px] font-sans">
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    setPortalViewOpen(true)
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <FilePlus className="w-3.5 h-3.5 text-[#00a3a6]" />
                    <span>New Project Wizard...</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Ctrl+N</span>
                </button>
                <button
                  onClick={handleOpenProject}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-industrial-400" />
                    <span>Open Project...</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Ctrl+O</span>
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    saveProjectToDisk()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Save className="w-3.5 h-3.5 text-industrial-400" />
                    <span>Save All</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Ctrl+S</span>
                </button>
                <div className="my-1 border-t border-[#27272a]" />
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    closeProject()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-300 hover:text-amber-300 hover:bg-[#27272a] flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <X className="w-3.5 h-3.5" />
                    <span>Close Project (Portal View)</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* EDIT MENU */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'edit' ? null : 'edit')}
              className={`px-2 py-0.5 text-[11px] hover:text-white transition-colors ${
                activeMenu === 'edit' ? 'bg-[#27272a] text-white' : 'hover:bg-[#1c1e22]'
              }`}
            >
              Edit
            </button>
            {activeMenu === 'edit' && (
              <div className="absolute top-6 left-0 w-64 bg-[#181a1f] border border-[#27272a] shadow-2xl py-1 z-50 text-[11px] font-sans">
                <button
                  onClick={handleAutoMergeAllCoils}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>Auto-Merge Double Coils</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* VIEW MENU */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'view' ? null : 'view')}
              className={`px-2 py-0.5 text-[11px] hover:text-white transition-colors ${
                activeMenu === 'view' ? 'bg-[#27272a] text-white' : 'hover:bg-[#1c1e22]'
              }`}
            >
              View
            </button>
            {activeMenu === 'view' && (
              <div className="absolute top-6 left-0 w-60 bg-[#181a1f] border border-[#27272a] shadow-2xl py-1 z-50 text-[11px] font-sans">
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    toggleLeftDock()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <PanelLeftClose className="w-3.5 h-3.5 text-industrial-400" />
                    <span>Toggle Project Tree</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Alt+1</span>
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    toggleRightDock()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <PanelRightClose className="w-3.5 h-3.5 text-purple-400" />
                    <span>Toggle AI Panel</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Alt+2</span>
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    toggleBottomDock()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <PanelBottomClose className="w-3.5 h-3.5 text-industrial-400" />
                    <span>Toggle Inspector</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Alt+3</span>
                </button>
                <div className="my-1 border-t border-[#27272a]" />
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    toggleSplitView()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Columns className="w-3.5 h-3.5 text-industrial-400" />
                    <span>Split Editor Side-by-Side</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Alt+S</span>
                </button>
              </div>
            )}
          </div>

          {/* PLC MENU */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'plc' ? null : 'plc')}
              className={`px-2 py-0.5 text-[11px] hover:text-white transition-colors ${
                activeMenu === 'plc' ? 'bg-[#27272a] text-white' : 'hover:bg-[#1c1e22]'
              }`}
            >
              PLC
            </button>
            {activeMenu === 'plc' && (
              <div className="absolute top-6 left-0 w-64 bg-[#181a1f] border border-[#27272a] shadow-2xl py-1 z-50 text-[11px] font-sans">
                <button
                  onClick={handleCompile}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Hammer className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Compile All Blocks</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">F7</span>
                </button>
                <div className="my-1 border-t border-[#27272a]" />
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    start()
                  }}
                  className="w-full px-3 py-1.5 text-left text-emerald-300 hover:text-white hover:bg-emerald-950 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Start CPU [RUN]</span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    stop()
                  }}
                  className="w-full px-3 py-1.5 text-left text-amber-300 hover:text-white hover:bg-amber-950 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop CPU [STOP]</span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    reset()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-300 hover:text-white hover:bg-[#27272a] flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Memory Reset [MRES]</span>
                  </span>
                </button>
                <div className="my-1 border-t border-[#27272a]" />
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    toggleMonitoring()
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Eye className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Online Monitoring</span>
                  </span>
                  <span className="text-[10px] text-industrial-500 font-mono">Ctrl+M</span>
                </button>
              </div>
            )}
          </div>

          {/* TOOLS MENU */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'tools' ? null : 'tools')}
              className={`px-2 py-0.5 text-[11px] hover:text-white transition-colors ${
                activeMenu === 'tools' ? 'bg-[#27272a] text-white' : 'hover:bg-[#1c1e22]'
              }`}
            >
              Tools
            </button>
            {activeMenu === 'tools' && (
              <div className="absolute top-6 left-0 w-64 bg-[#181a1f] border border-[#27272a] shadow-2xl py-1 z-50 text-[11px] font-sans">
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    setExportModalOpen(true)
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center gap-2"
                >
                  <Share2 className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Export to Siemens TIA Portal...</span>
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    setGuiDebuggerOpen(true)
                  }}
                  className="w-full px-3 py-1.5 text-left text-industrial-200 hover:text-white hover:bg-[#00a3a6]/20 flex items-center gap-2"
                >
                  <Bug className="w-3.5 h-3.5 text-purple-400" />
                  <span>Run Live GUI Debugger HUD...</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Info: Project Status */}
        <div className="flex items-center gap-2 font-mono text-[10px] text-industrial-400">
          <span>{metadata ? metadata.targetCpu : 'No Target CPU'}</span>
          <span className="text-[#27272a]">|</span>
          <span className="text-industrial-300">{metadata ? metadata.firmwareVersion : 'V4.6'}</span>
        </div>
      </div>

      {/* =========================================================================
          ROW 2: Single-Row Compact Engineering Command Bar (Height: 32px)
          ========================================================================= */}
      <div className="h-8 bg-[#18191c] px-2 flex items-center justify-between text-xs whitespace-nowrap overflow-x-auto gap-2">
        {/* Left: Project Badge & CPU Controls */}
        <div className="flex items-center gap-1.5">
          {/* Project Title Badge */}
          <div className="flex items-center gap-1.5 pr-2 border-r border-[#27272a] text-xs font-mono">
            <span className="text-industrial-400">Project:</span>
            <span className="font-bold text-industrial-100 truncate max-w-[140px]">
              {metadata ? metadata.name : 'Untitled'}
            </span>
            {isDirty && (
              <span className="text-[10px] text-amber-400 px-1 py-0.2 bg-amber-950/60 border border-amber-800">
                Modified*
              </span>
            )}
          </div>

          {/* CPU RUN / STOP / MRES Cluster */}
          <div className="flex items-center bg-[#111215] border border-[#27272a] p-0.5">
            <button
              data-testid="topbar-run-button"
              onClick={start}
              title="CPU RUN Mode (Starts SoftPLC execution loop)"
              className={`h-6 px-2.5 flex items-center gap-1 text-[11px] font-mono font-bold transition-all ${
                runtimeState === 'RUN'
                  ? 'bg-emerald-500 text-white shadow-xs border border-emerald-400 animate-pulse'
                  : 'text-industrial-400 hover:text-industrial-200 hover:bg-[#1f2228]'
              }`}
            >
              <Play className="w-3 h-3 fill-current" />
              <span>RUN</span>
            </button>

            <button
              data-testid="topbar-stop-button"
              onClick={stop}
              title="CPU STOP Mode (Outputs de-energized, cyclic scan frozen)"
              className={`h-6 px-2.5 flex items-center gap-1 text-[11px] font-mono font-bold transition-all ${
                runtimeState === 'STOP'
                  ? 'bg-amber-600 text-white shadow-xs border border-amber-500'
                  : 'text-industrial-400 hover:text-industrial-200 hover:bg-[#1f2228]'
              }`}
            >
              <Square className="w-3 h-3 fill-current" />
              <span>STOP</span>
            </button>

            <button
              onClick={reset}
              title="MRES / Reset CPU Memory"
              className="h-6 px-2 flex items-center gap-1 text-[11px] font-mono text-industrial-400 hover:text-industrial-200 hover:bg-[#1f2228] transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>MRES</span>
            </button>
          </div>

          {/* Online Monitoring Toggle */}
          <button
            data-testid="topbar-monitor-button"
            onClick={toggleMonitoring}
            title={isMonitoring ? 'Disable Online Monitoring' : 'Enable Online Monitoring & Live Power Glow'}
            className={`h-6 px-2.5 flex items-center gap-1.5 text-[11px] font-mono font-bold border transition-all ${
              isMonitoring
                ? 'bg-emerald-600 text-white border-emerald-400 shadow-xs'
                : 'bg-[#14161b] hover:bg-[#1e222a] text-industrial-300 hover:text-white border-[#27272a]'
            }`}
          >
            <Eye className="w-3 h-3" />
            <span>{isMonitoring ? 'Monitor ON' : 'Monitor OFF'}</span>
          </button>

          <div className="h-4 w-[1px] bg-[#27272a] mx-0.5" />

          {/* Persistent Scan Metric Pill */}
          <div
            data-testid="topbar-scan-metrics"
            className={`h-6 flex items-center gap-2 px-2 font-mono text-[11px] border transition-all ${
              runtimeState === 'RUN'
                ? 'bg-[#0f1115] border-emerald-700/60 text-cyan-300'
                : 'bg-[#0f1115] border-[#27272a] text-industrial-400'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 ${
                runtimeState === 'RUN' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-500'
              }`}
            />
            <span>{runtimeState === 'RUN' ? `${metrics.lastCycleDurationMs.toFixed(1)}ms` : 'STOPPED'}</span>
            <span className="text-[#3f3f46]">|</span>
            <span data-testid="topbar-cycle-counter">Cycle #{metrics.cycleNumber.toLocaleString()}</span>
            {runtimeState === 'RUN' && (
              <>
                <span className="text-[#3f3f46]">|</span>
                <span className="text-purple-300">{metrics.activeObs} OB</span>
              </>
            )}
          </div>
        </div>

        {/* Center/Right: Engineering Quick Commands */}
        <div className="flex items-center gap-1.5">
          <button
            data-testid="topbar-compile-btn"
            onClick={handleCompile}
            title="Compile & Consistency Check (F7 / Ctrl+B)"
            className="h-6 px-2 flex items-center gap-1 text-[11px] font-mono text-cyan-300 hover:text-white bg-[#141d24] hover:bg-[#1a2935] border border-[#1d3546] transition-colors cursor-pointer"
          >
            <Hammer className="w-3 h-3 text-cyan-400" />
            <span>Compile</span>
            {totalCollisions > 0 && (
              <span className="bg-red-600 text-white text-[9px] px-1 font-bold">
                {totalCollisions}
              </span>
            )}
          </button>

          <button
            data-testid="topbar-load-demo"
            onClick={loadDemoProject}
            title="Load Reference Chemical Plant Demo"
            className="h-6 px-2 flex items-center gap-1 text-[11px] font-mono text-emerald-300 hover:text-white bg-[#132219] hover:bg-[#1a3023] border border-[#1e442d] transition-colors"
          >
            <Sparkles className="w-3 h-3 text-emerald-400" />
            <span>Load Demo</span>
          </button>

          <button
            data-testid="topbar-export-button"
            onClick={() => setExportModalOpen(true)}
            title="Export SCL blocks, DBs, UDTs and tag tables for TIA Portal"
            className="h-6 px-2 flex items-center gap-1 text-[11px] font-mono text-cyan-200 hover:text-white bg-[#141f2b] hover:bg-[#1b2b3d] border border-[#1e3c5a] transition-colors font-medium"
          >
            <Share2 className="w-3 h-3 text-cyan-400" />
            <span>Export TIA</span>
          </button>

          <button
            data-testid="topbar-auto-debug-button"
            onClick={() => setGuiDebuggerOpen(true)}
            title="Autonomous Real-Window GUI Debugger & Chaos Tester HUD"
            className="h-6 px-2 flex items-center gap-1 text-[11px] font-mono text-purple-200 hover:text-white bg-[#22182d] hover:bg-[#302240] border border-[#3f2958] transition-colors font-semibold"
          >
            <Bug className="w-3 h-3 text-purple-400" />
            <span>Auto-Debug GUI</span>
          </button>

          <button
            data-testid="btn-topbar-debug-log"
            onClick={() => useUIStore.getState().setDebugLogModalOpen(true)}
            title="Black-Box Telemetry Flight Recorder (Live traces, AST injections, LLM responses)"
            className="h-6 px-2 flex items-center gap-1 text-[11px] font-mono text-cyan-200 hover:text-white bg-[#11242e] hover:bg-[#183444] border border-[#1e465e] transition-colors font-medium rounded-none cursor-pointer"
          >
            <FileText className="w-3 h-3 text-cyan-400" />
            <span>Flight Log</span>
          </button>

          <div className="h-4 w-[1px] bg-[#27272a] mx-0.5" />

          {/* Dock Layout Controls */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={toggleLeftDock}
              title={leftDockCollapsed ? 'Show Project Tree' : 'Hide Project Tree'}
              className={`h-6 w-6 flex items-center justify-center border transition-colors ${
                !leftDockCollapsed ? 'text-[#00a3a6] bg-[#1a232f] border-[#20394f]' : 'text-industrial-400 hover:text-white bg-[#14161b] border-[#27272a]'
              }`}
            >
              {leftDockCollapsed ? <PanelLeftOpen className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
            </button>

            <button
              onClick={toggleSplitView}
              title={isSplitView ? 'Close Split View' : 'Split Editor Side-by-Side'}
              className={`h-6 w-6 flex items-center justify-center border transition-colors ${
                isSplitView ? 'text-[#00a3a6] bg-[#1a232f] border-[#20394f]' : 'text-industrial-400 hover:text-white bg-[#14161b] border-[#27272a]'
              }`}
            >
              <Columns className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={toggleBottomDock}
              title={bottomDockCollapsed ? 'Show Inspector' : 'Hide Inspector'}
              className={`h-6 w-6 flex items-center justify-center border transition-colors ${
                !bottomDockCollapsed ? 'text-[#00a3a6] bg-[#1a232f] border-[#20394f]' : 'text-industrial-400 hover:text-white bg-[#14161b] border-[#27272a]'
              }`}
            >
              {bottomDockCollapsed ? <PanelBottomOpen className="w-3.5 h-3.5" /> : <PanelBottomClose className="w-3.5 h-3.5" />}
            </button>

            <button
              onClick={toggleRightDock}
              title={rightDockCollapsed ? 'Show AI Engineering Agent' : 'Hide AI Engineering Agent'}
              className={`h-6 w-6 flex items-center justify-center border transition-colors ${
                !rightDockCollapsed ? 'text-purple-400 bg-[#251933] border-[#442c5e]' : 'text-industrial-400 hover:text-white bg-[#14161b] border-[#27272a]'
              }`}
            >
              {rightDockCollapsed ? <PanelRightOpen className="w-3.5 h-3.5" /> : <PanelRightClose className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* TIA Portal Export Bridge Modal */}
      <TiaExportModal isOpen={isExportModalOpen} onClose={() => setExportModalOpen(false)} />

      {/* Autonomous Real-Window GUI Debugger & Chaos Monkey Modal */}
      <LiveGuiDebuggerModal isOpen={isGuiDebuggerOpen} onClose={() => setGuiDebuggerOpen(false)} />
    </header>
  )
}
