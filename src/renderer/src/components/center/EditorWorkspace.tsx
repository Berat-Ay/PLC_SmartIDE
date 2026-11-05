import React from 'react'
import {
  Cpu,
  Tag,
  Boxes,
  Database,
  FileCode2,
  Sparkles,
  Layers,
  ArrowRight,
  Flame
} from 'lucide-react'
import { useUIStore, EditorTab } from '../../stores/useUIStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { TabBar } from './TabBar'
import { TagTableEditor } from './editors/TagTableEditor'
import { DataBlockEditor } from './editors/DataBlockEditor'
import { UdtEditor } from './editors/UdtEditor'
import { HardwareConfigEditor } from './editors/HardwareConfigEditor'
import { BlockCodeEditor } from './editors/BlockCodeEditor'
import { VirtualIORackPanel } from '../simulation/VirtualIORackPanel'
import { TraceOscilloscope } from '../simulation/TraceOscilloscope'

export const EditorWorkspace: React.FC = () => {
  const {
    tabs,
    activeTabId,
    splitTabId,
    isSplitView,
    setActiveTab,
    setSplitTab,
    openTab
  } = useUIStore()
  const { metadata, loadDemoProject } = useProjectStore()

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const splitTab = isSplitView ? tabs.find((t) => t.id === splitTabId) : undefined

  const renderTabContent = (tab: EditorTab) => {
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
        return <BlockCodeEditor fileName={tab.targetId!} isLad={true} />
      case 'scl':
        return <BlockCodeEditor fileName={tab.targetId!} isLad={false} />
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
              Antigravity S7 Industrial IDE
            </h2>
            <p className="text-xs text-industrial-400 mt-1">
              AI-First Siemens TIA Portal Architecture • Everything-as-Code • Real-Time S7 Memory Overlap Guard
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-left">
            <button
              onClick={() => openTab({ id: 'tab_hardware_config', title: 'Device Configuration', type: 'hardware' })}
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
              onClick={() => openTab({ id: 'tab_all_tags', title: 'All PLC Tags', type: 'allTags' })}
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

            <button
              onClick={() => openTab({ id: 'tab_db_DB1_PlantData.db.json', title: 'DB1_PlantData', type: 'db', targetId: 'DB1_PlantData.db.json' })}
              className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-amber-500 hover:bg-industrial-850 transition-all group flex items-start gap-3"
            >
              <Database className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                  DB1_PlantData
                </div>
                <div className="text-[11px] text-industrial-400 mt-0.5">
                  Global DB with S7 Standard Access Byte.Bit offsets.
                </div>
              </div>
            </button>

            <button
              onClick={() => openTab({ id: 'tab_lad_OB1_Main.lad.json', title: 'OB1_Main', type: 'lad', targetId: 'OB1_Main.lad.json' })}
              className="p-3 rounded-lg bg-industrial-950 border border-industrial-800 hover:border-purple-500 hover:bg-industrial-850 transition-all group flex items-start gap-3"
            >
              <FileCode2 className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-industrial-200 group-hover:text-white">
                  OB1_Main (LAD)
                </div>
                <div className="text-[11px] text-industrial-400 mt-0.5">
                  Ladder logic AST with variable interface strip.
                </div>
              </div>
            </button>

            <button
              onClick={() => openTab({ id: 'tab_simulation', title: 'Simulation & Fault Panel', type: 'simulation' })}
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
        <div className={`h-full overflow-hidden ${isSplitView && splitTab ? 'w-1/2 border-r border-industrial-800' : 'w-full'}`}>
          {activeTab ? renderTabContent(activeTab) : null}
        </div>

        {/* Right Split Pane */}
        {isSplitView && splitTab && (
          <div className="h-full w-1/2 overflow-hidden flex flex-col">
            <div className="h-7 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between text-[11px] text-industrial-300">
              <span className="font-semibold text-cyan-300 font-mono truncate">
                Split View: {splitTab.title}
              </span>
              <span className="text-[10px] text-industrial-500 uppercase">
                {splitTab.type}
              </span>
            </div>
            <div className="flex-1 overflow-hidden">
              {renderTabContent(splitTab)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
