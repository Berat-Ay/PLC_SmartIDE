import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  TableProperties,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  HardDrive,
  Clock,
  Key
} from 'lucide-react'
import { useBlockStore } from '../../stores/useBlockStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { BlockInterface, BlockType, BlockVariable } from '@shared/types/blocks'

interface BlockInterfaceStripProps {
  fileName: string
  blockType: BlockType
  blockInterface: BlockInterface
}

type SectionKey = 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'constant'

export const BlockInterfaceStrip: React.FC<BlockInterfaceStripProps> = ({
  fileName,
  blockType,
  blockInterface
}) => {
  const {
    udts,
    addBlockInterfaceVariable,
    updateBlockInterfaceVariable,
    removeBlockInterfaceVariable
  } = useBlockStore()
  const { markDirty } = useProjectStore()

  const [collapsed, setCollapsed] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionKey>('input')

  const sections: Array<{
    key: SectionKey
    label: string
    icon: React.ReactNode
    vars: BlockVariable[]
    allowed: boolean
  }> = [
    { key: 'input', label: 'Input', icon: <ArrowDownLeft className="w-3 h-3 text-cyan-400" />, vars: blockInterface.input || [], allowed: true },
    { key: 'output', label: 'Output', icon: <ArrowUpRight className="w-3 h-3 text-emerald-400" />, vars: blockInterface.output || [], allowed: true },
    { key: 'inOut', label: 'InOut', icon: <ArrowLeftRight className="w-3 h-3 text-yellow-400" />, vars: blockInterface.inOut || [], allowed: true },
    { key: 'static', label: 'Static', icon: <HardDrive className="w-3 h-3 text-blue-400" />, vars: blockInterface.static || [], allowed: blockType === 'FB' },
    { key: 'temp', label: 'Temp', icon: <Clock className="w-3 h-3 text-purple-400" />, vars: blockInterface.temp || [], allowed: true },
    { key: 'constant', label: 'Constant', icon: <Key className="w-3 h-3 text-amber-400" />, vars: blockInterface.constant || [], allowed: true }
  ]

  const activeVars =
    activeSection === 'input'
      ? blockInterface.input || []
      : activeSection === 'output'
      ? blockInterface.output || []
      : activeSection === 'inOut'
      ? blockInterface.inOut || []
      : activeSection === 'static'
      ? blockInterface.static || []
      : activeSection === 'temp'
      ? blockInterface.temp || []
      : blockInterface.constant || []

  const handleAddVar = () => {
    addBlockInterfaceVariable(fileName, activeSection, {
      name: `${activeSection}_${activeVars.length + 1}`,
      dataType: 'BOOL'
    })
    markDirty(true)
  }

  const handleUpdate = (varId: string, updates: Partial<BlockVariable>) => {
    updateBlockInterfaceVariable(fileName, activeSection, varId, updates)
    markDirty(true)
  }

  const handleDelete = (varId: string) => {
    removeBlockInterfaceVariable(fileName, activeSection, varId)
    markDirty(true)
  }

  return (
    <div className="bg-industrial-950 border-b border-industrial-800 select-none text-xs">
      {/* Strip Toggle Bar */}
      <div className="h-8 px-3 flex items-center justify-between bg-industrial-900 border-b border-industrial-800">
        <div
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 cursor-pointer text-industrial-200 hover:text-white"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <TableProperties className="w-3.5 h-3.5 text-siemens-cyan" />
          <span className="font-semibold text-industrial-100 uppercase tracking-wider text-[11px]">
            Block Variable Interface
          </span>
          <span className="text-[10px] text-industrial-400">
            ({blockType} Interface Declarations)
          </span>
        </div>

        {!collapsed && (
          <button
            onClick={handleAddVar}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-white bg-siemens-cyan hover:bg-cyan-600 rounded transition-colors"
          >
            <Plus className="w-3 h-3" />
            <span>Add {activeSection}</span>
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="flex flex-col">
          {/* Section Selector Tabs */}
          <div className="flex items-center gap-1 px-3 py-1 bg-industrial-950 border-b border-industrial-800/80">
            {sections
              .filter((s) => s.allowed)
              .map((s) => (
                <button
                  key={s.key}
                  onClick={() => setActiveSection(s.key)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                    activeSection === s.key
                      ? 'bg-industrial-800 text-white font-medium border border-industrial-700'
                      : 'text-industrial-400 hover:text-industrial-200 hover:bg-industrial-900'
                  }`}
                >
                  {s.icon}
                  <span>{s.label}</span>
                  <span className="text-[10px] text-industrial-500 font-mono">({s.vars.length})</span>
                </button>
              ))}
          </div>

          {/* Variables Table */}
          <div className="max-h-48 overflow-auto">
            <table className="w-full min-w-max text-left font-mono border-collapse">
              <thead className="bg-industrial-950 text-industrial-400 sticky top-0 text-[10px] uppercase border-b border-industrial-850">
                <tr>
                  <th className="py-1.5 px-3 w-8 min-w-[32px] text-center whitespace-nowrap">#</th>
                  <th className="py-1.5 px-3 w-48 min-w-[160px] whitespace-nowrap">Name</th>
                  <th className="py-1.5 px-3 w-32 min-w-[110px] whitespace-nowrap">Data Type</th>
                  <th className="py-1.5 px-3 w-28 min-w-[100px] whitespace-nowrap">Start Value</th>
                  {activeSection === 'static' && (
                    <th className="py-1.5 px-3 w-16 min-w-[60px] text-center whitespace-nowrap">Retain</th>
                  )}
                  <th className="py-1.5 px-3 w-20 min-w-[70px] text-center whitespace-nowrap">HMI</th>
                  <th className="py-1.5 px-3 min-w-[180px] whitespace-nowrap">Comment</th>
                  <th className="py-1.5 px-3 w-14 min-w-[50px] text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-industrial-850 text-industrial-200">
                {activeVars.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-3 text-center text-industrial-500 italic font-sans text-[11px] whitespace-nowrap">
                      No variables defined in VAR_{activeSection.toUpperCase()}. Click "+ Add {activeSection}" to create.
                    </td>
                  </tr>
                ) : (
                  activeVars.map((v, idx) => (
                    <tr
                      key={v.id}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Delete' && (e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'SELECT') {
                          handleDelete(v.id)
                        }
                      }}
                      className="hover:bg-industrial-900 group"
                    >
                      <td className="py-1 px-3 text-center text-industrial-500 text-[10px] whitespace-nowrap">{idx + 1}</td>
                      <td className="py-0.5 px-3 min-w-[160px] whitespace-nowrap">
                        <input
                          type="text"
                          value={v.name}
                          onChange={(e) => handleUpdate(v.id, { name: e.target.value })}
                          className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 rounded px-1 text-industrial-100 font-sans focus:outline-hidden whitespace-nowrap"
                        />
                      </td>
                      <td className="py-0.5 px-3 whitespace-nowrap">
                        <select
                          value={v.dataType}
                          onChange={(e) => handleUpdate(v.id, { dataType: e.target.value })}
                          className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 rounded px-1 text-cyan-300 font-mono focus:outline-hidden cursor-pointer"
                        >
                          <optgroup label="S7 Primitives" className="bg-industrial-950 text-industrial-100">
                            <option value="BOOL">BOOL</option>
                            <option value="BYTE">BYTE</option>
                            <option value="WORD">WORD</option>
                            <option value="DWORD">DWORD</option>
                            <option value="INT">INT</option>
                            <option value="DINT">DINT</option>
                            <option value="REAL">REAL</option>
                            <option value="TIME">TIME</option>
                            <option value="STRING">STRING</option>
                          </optgroup>
                          {udts.length > 0 && (
                            <optgroup label="UDT Structures" className="bg-industrial-950 text-pink-300">
                              {udts.map((u) => (
                                <option key={u.id} value={u.name}>
                                  {u.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </td>
                      <td className="py-0.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={v.defaultValue || ''}
                          onChange={(e) => handleUpdate(v.id, { defaultValue: e.target.value })}
                          placeholder="Init..."
                          className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 rounded px-1 text-industrial-200 font-mono focus:outline-hidden whitespace-nowrap"
                        />
                      </td>
                      {activeSection === 'static' && (
                        <td className="py-0.5 px-3 text-center whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={v.retain}
                            onChange={(e) => handleUpdate(v.id, { retain: e.target.checked })}
                            className="h-3 w-3 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                          />
                        </td>
                      )}
                      <td className="py-0.5 px-3 text-center whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={v.accessibleFromHMI}
                          onChange={(e) => handleUpdate(v.id, { accessibleFromHMI: e.target.checked })}
                          className="h-3 w-3 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                        />
                      </td>
                      <td className="py-0.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={v.comment || ''}
                          onChange={(e) => handleUpdate(v.id, { comment: e.target.value })}
                          placeholder="Description..."
                          className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 rounded px-1 text-industrial-300 font-sans focus:outline-hidden whitespace-nowrap"
                        />
                      </td>
                      <td className="py-0.5 px-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleDelete(v.id)}
                          data-testid="interface-var-delete-button"
                          title="Delete variable"
                          className="p-1 text-industrial-400 hover:text-red-400 hover:bg-industrial-800 rounded transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
