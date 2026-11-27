import React, { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Cpu,
  Tag,
  Database,
  FileCode2,
  Sparkles,
  ArrowRight,
  Flame
} from 'lucide-react'
import { useUIStore, EditorTab } from '../../stores/useUIStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { makeTabId } from '../../utils/tabIds'
import { TabBar } from './TabBar'
import { TagTableEditor } from './editors/TagTableEditor'
import { DataBlockEditor } from './editors/DataBlockEditor'
import { UdtEditor } from './editors/UdtEditor'
import { HardwareConfigEditor } from './editors/HardwareConfigEditor'
import { BlockCodeEditor } from './editors/BlockCodeEditor'
import { VirtualIORackPanel } from '../simulation/VirtualIORackPanel'
import { TraceOscilloscope } from '../simulation/TraceOscilloscope'
import { ErrorBoundary } from '../common/ErrorBoundary'

export const EditorWorkspace: React.FC = () => {
  const [focusedPane, setFocusedPane] = useState<'primary' | 'split'>('primary')
  const { tabs, activeTabId, splitTabId, isSplitView, setActiveTab, openTab } = useUIStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      splitTabId: s.splitTabId,
      isSplitView: s.isSplitView,
      setActiveTab: s.setActiveTab,
      openTab: s.openTab
    }))
  )
  const loadDemoProject = useProjectStore((s) => s.loadDemoProject)
  const firstDb = useBlockStore((s) => s.dataBlocks[0])
  const firstLad = useBlockStore((s) => s.ladBlocks[0])
  const firstScl = useBlockStore((s) => s.sclBlocks[0])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const rawSplitTab = isSplitView ? tabs.find((t) => t.id === splitTabId) : undefined
  const splitTab = rawSplitTab && rawSplitTab.id !== activeTab?.id ? rawSplitTab : undefined

  const renderTabContent = (tab: EditorTab, isSplitPane: boolean) => {
    const isActivePane = !splitTab || (isSplitPane ? focusedPane === 'split' : focusedPane === 'primary')
    const panePrefix = isSplitPane ? 'split-' : ''
    switch (tab.type) {
      case 'hardware':
        return <HardwareConfigEditor />
      case 'tagTable':
        return <TagTableEditor tableId={tab.targetId} />
      case 'allTags':
        return <TagTableEditor />
      case 'db':
        return <DataBlockEditor fileName={tab.targetId!} />
      case 'udt':
        return <UdtEditor udtId={tab.targetId!} />
      case 'lad':
        return <BlockCodeEditor fileName={tab.targetId!} isLad={true} isActivePane={isActivePane} panePrefix={panePrefix} />
      case 'scl':
        return <BlockCodeEditor fileName={tab.targetId!} isLad={false} isActivePane={isActivePane} panePrefix={panePrefix} />
      case 'simulation':
        return <VirtualIORackPanel />
      case 'trace':
        return <TraceOscilloscope />
      default:
        return null
    }
  }

  // Welcome screen when no tabs are open
  if (tabs.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-industrial-900 select-none">
        <div className="max-w-xl w-full text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-siemens-cyan to-teal-800 flex items-center justify-center mx-auto shadow-lg shadow-cyan-950/50">
            <Cpu className="w-8 h-8 text-white" />
          </div>

          <div>
            <h2 className="text-xl font-bold text-industrial-100">
              Rungline
            </h2>
            <p className="text-xs text-industrial-400 mt-1">
              AI-First Siemens TIA Portal Architecture • Everything-as-Code • Real-Time S7 Memory Overlap Guard
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-left">
            <button
              onClick={() => openTab({ id: makeTabId('hardware'), title: 'Device Configuration', type: 'hardware' })}
              className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-cyan-500 hover:bg-industrial-850 transition-all group flex items-start gap-3"
            >
              <Cpu className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                  Device Configuration
                </div>
                <div className="text-[11px] text-industrial-400 mt-0.5">
                  CPU Watchdog, Clock/System bytes, DI/AI parameters.
                </div>
              </div>
            </button>

            <button
              onClick={() => openTab({ id: makeTabId('allTags'), title: 'All PLC Tags', type: 'allTags' })}
              className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-cyan-500 hover:bg-industrial-850 transition-all group flex items-start gap-3"
            >
              <Tag className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                  PLC Tag Tables
                </div>
                <div className="text-[11px] text-industrial-400 mt-0.5">
                  Live bit-coordinate memory overlap guard & auto-resolve.
                </div>
              </div>
            </button>

            {firstDb && (
              <button
                onClick={() => openTab({ id: makeTabId('db', firstDb.fileName), title: firstDb.name, type: 'db', targetId: firstDb.fileName })}
                className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-amber-500 hover:bg-industrial-850 transition-all group flex items-start gap-3"
              >
                <Database className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                    {firstDb.name}
                  </div>
                  <div className="text-[11px] text-industrial-400 mt-0.5">
                    Global DB with S7 Standard Access Byte.Bit offsets.
                  </div>
                </div>
              </button>
            )}

            {(firstLad || firstScl) && (
              <button
                onClick={() => {
                  if (firstLad) {
                    openTab({ id: makeTabId('lad', firstLad.fileName), title: firstLad.name, type: 'lad', targetId: firstLad.fileName })
                  } else if (firstScl) {
                    openTab({ id: makeTabId('scl', firstScl.fileName), title: firstScl.name, type: 'scl', targetId: firstScl.fileName })
                  }
                }}
                className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-purple-500 hover:bg-industrial-850 transition-all group flex items-start gap-3"
              >
                <FileCode2 className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                    {firstLad ? `${firstLad.name} (LAD)` : `${firstScl!.name} (SCL)`}
                  </div>
                  <div className="text-[11px] text-industrial-400 mt-0.5">
                    {firstLad ? 'Ladder logic AST with variable interface strip.' : 'Structured Control Language source block.'}
                  </div>
                </div>
              </button>
            )}

            <button
              onClick={() => openTab({ id: makeTabId('simulation'), title: 'Simulation & Fault Panel', type: 'simulation' })}
              className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-amber-500 hover:bg-industrial-850 transition-all group flex items-start gap-3 col-span-2"
            >
              <Flame className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                  Simulation Workbench & Fault-Injection Rack
                </div>
                <div className="text-[11px] text-industrial-400 mt-0.5">
                  Virtual I/O rack (%IB0/%QB0), 2D chemical tank mimic, closed-loop plant physics, and oscilloscope.
                </div>
              </div>
            </button>
          </div>

          <div className="pt-2">
            <button
              onClick={loadDemoProject}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-siemens-cyan to-teal-600 hover:from-cyan-500 hover:to-teal-500 shadow-md shadow-cyan-950/40 transition-all"
            >
              <Sparkles className="w-4 h-4" />
              <span>Reset & Reload Industrial Demo Plant</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-industrial-900 overflow-hidden">
      {/* Top Tab Bar */}
      <TabBar
        currentActiveTabId={activeTabId}
        onSelectTab={(id) => setActiveTab(id)}
      />

      {/* Editor Content Area (Single or Side-by-Side Split View) */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left / Primary Pane */}
        <div
          onMouseDownCapture={() => setFocusedPane('primary')}
          className={`h-full overflow-hidden ${isSplitView && splitTab ? 'w-1/2 border-r border-industrial-800' : 'w-full'}`}
        >
          {activeTab ? (
            <ErrorBoundary key={activeTab.id} label={activeTab.title}>
              {renderTabContent(activeTab, false)}
            </ErrorBoundary>
          ) : null}
        </div>

        {/* Right Split Pane */}
        {isSplitView && splitTab && (
          <div
            onMouseDownCapture={() => setFocusedPane('split')}
            className="h-full w-1/2 overflow-hidden flex flex-col"
          >
            <div className="h-7 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between text-[11px] text-industrial-300">
              <span className="font-semibold text-cyan-300 font-mono truncate">
                Split View: {splitTab.title}
              </span>
              <span className="text-[10px] text-industrial-500 uppercase">
                {splitTab.type}
              </span>
            </div>
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary key={`split_${splitTab.id}`} label={splitTab.title}>
                {renderTabContent(splitTab, true)}
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
