import React, { useEffect, useRef } from 'react'
import {
  X,
  Cpu,
  Tag,
  Boxes,
  Database,
  FileCode2,
  Code,
  Columns,
  Flame,
  Activity
} from 'lucide-react'
import { useUIStore, EditorTab } from '../../stores/useUIStore'

interface TabBarProps {
  currentActiveTabId: string | null
  onSelectTab: (tabId: string) => void
}

export const TabBar: React.FC<TabBarProps> = ({ currentActiveTabId, onSelectTab }) => {
  const { tabs, closeTab, isSplitView, toggleSplitView } = useUIStore()
  const stripRef = useRef<HTMLDivElement>(null)

  // The strip has no scrollbar, so the active tab is brought into view and the wheel scrolls sideways
  useEffect(() => {
    stripRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentActiveTabId, tabs.length])

  const getTabIcon = (tab: EditorTab) => {
    switch (tab.type) {
      case 'hardware':
        return <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
      case 'tagTable':
      case 'allTags':
        return <Tag className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
      case 'db':
        return <Database className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      case 'udt':
        return <Boxes className="w-3.5 h-3.5 text-pink-400 shrink-0" />
      case 'lad':
        return <FileCode2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />
      case 'scl':
        return <Code className="w-3.5 h-3.5 text-blue-400 shrink-0" />
      case 'simulation':
        return <Flame className="w-3.5 h-3.5 text-amber-500 shrink-0" />
      case 'trace':
        return <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
      default:
        return null
    }
  }

  return (
    <div className="cq h-9 shrink-0 bg-industrial-950 border-b border-industrial-800 select-none text-xs">
    <div className="h-full flex items-center justify-between px-1 overflow-hidden">
      <div
        ref={stripRef}
        onWheel={(e) => {
          e.currentTarget.scrollLeft += e.deltaY
        }}
        className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0 h-full scrollbar-none"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === currentActiveTabId

          return (
            <div
              key={tab.id}
              data-testid={`editor-tab-${tab.id}`}
              data-active={isActive ? 'true' : 'false'}
              onClick={() => onSelectTab(tab.id)}
              className={`h-full flex items-center gap-2 px-3 border-r border-industrial-850 cursor-pointer transition-colors shrink-0 max-w-[200px] group ${isActive
                  ? 'bg-industrial-900 text-industrial-100 border-t-2 border-t-siemens-cyan font-medium'
                  : 'text-industrial-400 hover:text-industrial-200 hover:bg-industrial-900/40 border-t-2 border-t-transparent'
                }`}
            >
              {getTabIcon(tab)}
              <span className="truncate">{tab.title}</span>
              {tab.isDirty && <span className="text-amber-400 text-xs font-bold">*</span>}

              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded-none hover:bg-industrial-750 text-industrial-400 hover:text-white transition-opacity ml-1"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>

      {tabs.length > 1 && (
        <button
          onClick={toggleSplitView}
          title={isSplitView ? 'Close Split View' : 'Split Editor Side-by-Side'}
          className={`shrink-0 px-2 py-1 mx-1 rounded text-xs flex items-center gap-1 transition-colors ${isSplitView ? 'bg-industrial-800 text-cyan-300' : 'text-industrial-400 hover:text-white hover:bg-industrial-800'
            }`}
        >
          <Columns className="w-3.5 h-3.5" />
          <span className="under-600:hidden text-[10px]">{isSplitView ? 'Single View' : 'Split View'}</span>
        </button>
      )}
    </div>
    </div>
  )
}
