import React from 'react'
import { Plus, Trash2, Database, Layers } from 'lucide-react'
import { useBlockStore } from '../../../stores/useBlockStore'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { BlockVariable } from '@shared/types/blocks'

interface DataBlockEditorProps {
  fileName: string
}

export const DataBlockEditor: React.FC<DataBlockEditorProps> = ({ fileName }) => {
  const {
    dataBlocks,
    udts,
    toggleDbOptimizedAccess,
    addDbVariable,
    updateDbVariable,
    deleteDbVariable
  } = useBlockStore()
  const { markDirty } = useProjectStore()
  const { isMonitoring, engine, forceValue } = useRuntimeStore()

  const db = dataBlocks.find((d) => d.fileName === fileName)

  if (!db) {
    return (
      <div className="h-full flex items-center justify-center text-industrial-500 italic text-xs">
        Data Block not found: {fileName}
      </div>
    )
  }

  const handleToggleOptimized = () => {
    toggleDbOptimizedAccess(fileName)
    markDirty(true)
  }

  const handleAddVar = () => {
    addDbVariable(fileName, {
      name: `Variable_${db.variables.length + 1}`,
      dataType: 'BOOL'
    })
    markDirty(true)
  }

  const handleUpdate = (varId: string, updates: Partial<BlockVariable>) => {
    updateDbVariable(fileName, varId, updates)
    markDirty(true)
  }

  const handleDelete = (varId: string) => {
    deleteDbVariable(fileName, varId)
    markDirty(true)
  }

  return (
    <div className="cq h-full flex flex-col bg-industrial-900 select-none text-xs overflow-hidden">
      {/* Header Bar */}
      <div className="h-11 shrink-0 px-4 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between gap-3 whitespace-nowrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Database className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="font-semibold text-industrial-100 font-mono text-sm truncate" title={db.name}>{db.name}</span>
            <span className="under-720:hidden text-[11px] text-amber-300 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800 font-mono">
              DB{db.blockNumber} [{db.dbType}]
            </span>
          </div>
          {db.parentFbName && (
            <span className="under-900:hidden text-industrial-400 text-[11px]">
              Linked to FB: <strong className="text-blue-300 font-mono">{db.parentFbName}</strong>
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Optimized Access Toggle Switch */}
          <div className="flex items-center gap-2 px-2 py-1 bg-industrial-850 rounded border border-industrial-750" title="Optimized Block Access">
            <span className="under-900:hidden text-industrial-300 font-medium text-[11px]">
              Optimized Block Access:
            </span>
            <button
              onClick={handleToggleOptimized}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                db.optimizedAccess ? 'bg-cyan-600' : 'bg-industrial-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                  db.optimizedAccess ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded ${
                db.optimizedAccess
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                  : 'bg-amber-950 text-amber-300 border border-amber-800'
              }`}
            >
              {db.optimizedAccess ? 'Optimized' : 'Standard'}
            </span>
          </div>

          <button
            onClick={handleAddVar}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-siemens-cyan hover:bg-cyan-600 rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Row</span>
          </button>
        </div>
      </div>

      {/* Explanatory banner for Standard Access */}
      {!db.optimizedAccess && (
        <div className="shrink-0 px-3 py-1.5 bg-amber-950/30 border-b border-amber-800/60 flex items-center gap-2 text-amber-200 text-[11px]">
          <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>
            <strong>Standard Access Active:</strong> Displaying Siemens S7 memory alignment offsets. Multi-byte types align to even byte boundaries, boolean bits pack into bytes 0..7.
          </span>
        </div>
      )}

      {/* Grid Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-max text-left border-collapse font-mono">
          <thead className="bg-industrial-950 text-industrial-400 sticky top-0 border-b border-industrial-800 uppercase text-[10px] tracking-wider z-10">
            <tr>
              <th className="py-2 px-3 w-10 min-w-[36px] text-center whitespace-nowrap">#</th>
              <th className="py-2 px-3 w-56 min-w-[180px] whitespace-nowrap">Name</th>
              <th className="py-2 px-3 w-36 min-w-[120px] whitespace-nowrap">Data Type</th>
              {!db.optimizedAccess && <th className="py-2 px-3 w-28 min-w-[110px] text-cyan-300 whitespace-nowrap">Offset (Byte.Bit)</th>}
              <th className="py-2 px-3 w-28 min-w-[100px] whitespace-nowrap">Start Value</th>
              {isMonitoring && <th className="py-2 px-3 w-36 min-w-[130px] text-emerald-400 whitespace-nowrap">Monitor Value</th>}
              <th className="py-2 px-3 w-20 min-w-[70px] text-center whitespace-nowrap">Retain</th>
              <th className="py-2 px-3 w-24 min-w-[90px] text-center whitespace-nowrap">Visible in HMI</th>
              <th className="py-2 px-3 min-w-[180px] whitespace-nowrap">Comment</th>
              <th className="py-2 px-3 w-16 min-w-[60px] text-right whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
            {db.variables.length === 0 ? (
              <tr>
                <td
                  colSpan={(db.optimizedAccess ? 8 : 9) + (isMonitoring ? 1 : 0)}
                  className="py-8 text-center text-industrial-500 italic font-sans whitespace-nowrap"
                >
                  No variables defined in this Data Block. Click "+ Add Row" to begin.
                </td>
              </tr>
            ) : (
              db.variables.map((v, index) => (
                <tr
                  key={v.id}
                  className="hover:bg-industrial-850 transition-colors group"
                >
                  {/* Row index */}
                  <td className="py-1.5 px-3 text-center text-industrial-500 text-[11px] whitespace-nowrap">
                    {index + 1}
                  </td>

                  {/* Name */}
                  <td className="py-1 px-3 min-w-[180px] whitespace-nowrap">
                    <input
                      type="text"
                      value={v.name}
                      onChange={(e) => handleUpdate(v.id, { name: e.target.value })}
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden whitespace-nowrap"
                    />
                  </td>

                  {/* Data Type (Primitives or UDTs) */}
                  <td className="py-1 px-3 whitespace-nowrap">
                    <select
                      value={v.dataType}
                      onChange={(e) => handleUpdate(v.id, { dataType: e.target.value })}
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1 py-0.5 text-cyan-300 font-mono focus:outline-hidden cursor-pointer whitespace-nowrap"
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
                        <optgroup label="PLC Data Types (UDT)" className="bg-industrial-950 text-pink-300">
                          {udts.map((u) => (
                            <option key={u.id} value={u.name}>
                              {u.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </td>

                  {/* Offset Column (Standard Access only) */}
                  {!db.optimizedAccess && (
                    <td className="py-1 px-3 whitespace-nowrap">
                      <span className="font-mono font-bold text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/60 whitespace-nowrap">
                        {v.calculatedOffset || '0.0'}
                      </span>
                    </td>
                  )}

                  {/* Start / Default Value */}
                  <td className="py-1 px-3 whitespace-nowrap">
                    <input
                      type="text"
                      value={v.defaultValue || ''}
                      onChange={(e) => handleUpdate(v.id, { defaultValue: e.target.value })}
                      placeholder="e.g. 0.0"
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-200 font-mono placeholder-industrial-600 focus:outline-hidden whitespace-nowrap"
                    />
                  </td>

                  {/* Live Monitor Value */}
                  {isMonitoring && (() => {
                    const sym = `${db.name}.${v.name}`
                    const liveVal = engine.getVariable(sym) ?? engine.getVariable(`DB${db.blockNumber}.${v.name}`) ?? v.defaultValue
                    const isBool = v.dataType === 'BOOL'
                    return (
                      <td className="py-1 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap">
                          <span
                            className={`px-1.5 py-0.5 rounded font-bold ${
                              isBool
                                ? liveVal === true || liveVal === 'TRUE'
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-600'
                                  : 'bg-industrial-950 text-industrial-500 border border-industrial-800'
                                : 'bg-industrial-950 text-cyan-300 border border-industrial-800'
                            }`}
                          >
                            {String(liveVal ?? '0')}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (isBool) {
                                const b = !(liveVal === true || liveVal === 'TRUE')
                                forceValue(sym, b, true)
                              } else {
                                const next = prompt(`Modify value for ${sym}:`, String(liveVal ?? 0))
                                if (next !== null) {
                                  const parsed = v.dataType === 'REAL' ? parseFloat(next) : parseInt(next, 10)
                                  forceValue(sym, isNaN(parsed) ? next : parsed, true)
                                }
                              }
                            }}
                            title="Modify DB variable online"
                            className="px-1.5 py-0.5 rounded bg-industrial-800 hover:bg-industrial-700 text-industrial-300 hover:text-white text-[9px] border border-industrial-700 font-sans cursor-pointer whitespace-nowrap"
                          >
                            Modify
                          </button>
                        </div>
                      </td>
                    )
                  })()}

                  {/* Retain */}
                  <td className="py-1 px-3 text-center whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={v.retain}
                      onChange={(e) => handleUpdate(v.id, { retain: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                    />
                  </td>

                  {/* Visible in HMI */}
                  <td className="py-1 px-3 text-center whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={v.accessibleFromHMI}
                      onChange={(e) => handleUpdate(v.id, { accessibleFromHMI: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                    />
                  </td>

                  {/* Comment */}
                  <td className="py-1 px-3 whitespace-nowrap">
                    <input
                      type="text"
                      value={v.comment || ''}
                      onChange={(e) => handleUpdate(v.id, { comment: e.target.value })}
                      placeholder="Description..."
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans placeholder-industrial-600 focus:outline-hidden whitespace-nowrap"
                    />
                  </td>

                  {/* Actions */}
                  <td className="py-1 px-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => handleDelete(v.id)}
                      data-testid="db-var-delete-button"
                      title="Delete Variable"
                      className="p-1 text-industrial-400 hover:text-red-400 hover:bg-industrial-800 rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
