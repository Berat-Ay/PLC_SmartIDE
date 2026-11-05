import React from 'react'
import { Plus, Trash2, Boxes } from 'lucide-react'
import { useBlockStore } from '../../../stores/useBlockStore'
import { useProjectStore } from '../../../stores/useProjectStore'

interface UdtEditorProps {
  udtId: string
}

export const UdtEditor: React.FC<UdtEditorProps> = ({ udtId }) => {
  const { udts, updateUdt, addUdtMember, updateUdtMember, deleteUdtMember } = useBlockStore()
  const { markDirty } = useProjectStore()

  const udt = udts.find((u) => u.id === udtId)

  if (!udt) {
    return (
      <div className="h-full flex items-center justify-center text-industrial-500 italic text-xs">
        UDT structure not found.
      </div>
    )
  }

  const handleAddMember = () => {
    addUdtMember(udtId, {
      name: `Field_${udt.members.length + 1}`,
      dataType: 'BOOL'
    })
    markDirty(true)
  }

  return (
    <div className="h-full flex flex-col bg-industrial-900 select-none text-xs">
      {/* Header */}
      <div className="h-11 px-4 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Boxes className="w-4 h-4 text-pink-400" />
            <input
              type="text"
              value={udt.name}
              onChange={(e) => {
                updateUdt(udtId, { name: e.target.value })
                markDirty(true)
              }}
              className="font-semibold text-industrial-100 font-mono text-sm bg-transparent border-b border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:outline-hidden"
            />
          </div>
          <span className="text-[11px] text-pink-300 bg-pink-950/80 px-2 py-0.5 rounded border border-pink-800 font-mono">
            Size: {udt.calculatedSizeInBytes || 0} Bytes
          </span>
        </div>

        <button
          onClick={handleAddMember}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-siemens-cyan hover:bg-cyan-600 rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Member</span>
        </button>
      </div>

      {/* Description input */}
      <div className="px-4 py-2 bg-industrial-950/60 border-b border-industrial-800/80 flex items-center gap-2">
        <span className="text-industrial-400 text-[11px]">Description:</span>
        <input
          type="text"
          value={udt.description || ''}
          onChange={(e) => {
            updateUdt(udtId, { description: e.target.value })
            markDirty(true)
          }}
          placeholder="Enter UDT documentation..."
          className="flex-1 bg-transparent text-industrial-200 border-none focus:outline-hidden text-xs placeholder-industrial-600"
        />
      </div>

      {/* Members Grid */}
      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-max text-left border-collapse font-mono">
          <thead className="bg-industrial-950 text-industrial-400 sticky top-0 border-b border-industrial-800 uppercase text-[10px] tracking-wider z-10">
            <tr>
              <th className="py-2 px-3 w-10 min-w-[36px] text-center whitespace-nowrap">#</th>
              <th className="py-2 px-3 w-56 min-w-[180px] whitespace-nowrap">Member Name</th>
              <th className="py-2 px-3 w-36 min-w-[120px] whitespace-nowrap">Data Type</th>
              <th className="py-2 px-3 w-28 min-w-[110px] text-cyan-300 whitespace-nowrap">Offset (Byte.Bit)</th>
              <th className="py-2 px-3 w-28 min-w-[100px] whitespace-nowrap">Start Value</th>
              <th className="py-2 px-3 min-w-[180px] whitespace-nowrap">Comment</th>
              <th className="py-2 px-3 w-16 min-w-[60px] text-right whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
            {udt.members.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-industrial-500 italic font-sans whitespace-nowrap">
                  No members defined in this UDT. Click "+ Add Member" to begin.
                </td>
              </tr>
            ) : (
              udt.members.map((m, index) => (
                <tr key={m.id} className="hover:bg-industrial-850 transition-colors group">
                  <td className="py-1.5 px-3 text-center text-industrial-500 text-[11px] whitespace-nowrap">{index + 1}</td>
                  <td className="py-1 px-3 min-w-[180px] whitespace-nowrap">
                    <input
                      type="text"
                      value={m.name}
                      onChange={(e) => {
                        updateUdtMember(udtId, m.id, { name: e.target.value })
                        markDirty(true)
                      }}
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden whitespace-nowrap"
                    />
                  </td>
                  <td className="py-1 px-3 whitespace-nowrap">
                    <select
                      value={m.dataType}
                      onChange={(e) => {
                        updateUdtMember(udtId, m.id, { dataType: e.target.value })
                        markDirty(true)
                      }}
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
                      {udts.filter((u) => u.id !== udtId).length > 0 && (
                        <optgroup label="Other UDTs" className="bg-industrial-950 text-pink-300">
                          {udts
                            .filter((u) => u.id !== udtId)
                            .map((u) => (
                              <option key={u.id} value={u.name}>
                                {u.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </select>
                  </td>
                  <td className="py-1 px-3 whitespace-nowrap">
                    <span className="font-mono font-bold text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/60 whitespace-nowrap">
                      {m.calculatedOffset || '0.0'}
                    </span>
                  </td>
                  <td className="py-1 px-3 whitespace-nowrap">
                    <input
                      type="text"
                      value={m.defaultValue || ''}
                      onChange={(e) => {
                        updateUdtMember(udtId, m.id, { defaultValue: e.target.value })
                        markDirty(true)
                      }}
                      placeholder="e.g. 0.0"
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-200 font-mono placeholder-industrial-600 focus:outline-hidden whitespace-nowrap"
                    />
                  </td>
                  <td className="py-1 px-3 whitespace-nowrap">
                    <input
                      type="text"
                      value={m.comment || ''}
                      onChange={(e) => {
                        updateUdtMember(udtId, m.id, { comment: e.target.value })
                        markDirty(true)
                      }}
                      placeholder="Field comment..."
                      className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans placeholder-industrial-600 focus:outline-hidden whitespace-nowrap"
                    />
                  </td>
                  <td className="py-1 px-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => {
                        deleteUdtMember(udtId, m.id)
                        markDirty(true)
                      }}
                      data-testid="udt-member-delete-button"
                      title="Delete Member"
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
