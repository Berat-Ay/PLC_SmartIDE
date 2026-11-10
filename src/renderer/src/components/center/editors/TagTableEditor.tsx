import React from 'react'
import {
  AlertTriangle,
  Wand2,
  Plus,
  Trash2,
  CheckCircle2,
  Zap
} from 'lucide-react'
import { useTagStore } from '../../../stores/useTagStore'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { TagDefinition } from '@shared/types/tags'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'

interface TagTableEditorProps {
  tableId?: string // undefined means "All Tags" view
}

export const TagTableEditor: React.FC<TagTableEditorProps> = ({ tableId }) => {
  const {
    tagTables,
    collisions,
    selectedTagId,
    selectTag,
    addTag,
    updateTag,
    deleteTag,
    autoAssignSafeAddress,
    resolveAllOverlaps
  } = useTagStore()
  const { markDirty } = useProjectStore()
  const { isMonitoring, state: runtimeState, engine, forceValue } = useRuntimeStore()
  const showMonitoring = isMonitoring && runtimeState === 'RUN'

  const isAllTags = !tableId
  const activeTable = tagTables.find((t) => t.id === tableId)

  // Collect tags to display
  const tagsToDisplay: Array<{ tag: TagDefinition; sourceTableId: string; sourceTableName: string }> = []
  if (isAllTags) {
    for (const tbl of tagTables) {
      for (const t of tbl.tags) {
        tagsToDisplay.push({ tag: t, sourceTableId: tbl.id, sourceTableName: tbl.name })
      }
    }
  } else if (activeTable) {
    for (const t of activeTable.tags) {
      tagsToDisplay.push({ tag: t, sourceTableId: activeTable.id, sourceTableName: activeTable.name })
    }
  }

  // Count overlaps within currently visible tags
  const visibleCollisionsCount = tagsToDisplay.filter(
    (item) => collisions.has(item.tag.id) || collisions.has(item.tag.name.toLowerCase())
  ).length

  const handleAddTag = () => {
    const targetId = tableId || (tagTables.length > 0 ? tagTables[0].id : '')
    if (!targetId) return
    const newTag = addTag(targetId, {
      name: `Tag_${Math.floor(Math.random() * 900 + 100)}`,
      dataType: 'BOOL'
    })
    selectTag(newTag.id)
    markDirty(true)
  }

  const handleUpdate = (
    srcTableId: string,
    tagId: string,
    field: keyof TagDefinition,
    value: string
  ) => {
    updateTag(srcTableId, tagId, { [field]: value })
    markDirty(true)
  }

  const handleAddressCommit = (
    srcTableId: string,
    tagId: string,
    rawVal: string,
    currentDataType: string
  ) => {
    const norm = normalizeS7Address(rawVal)
    if (norm.isValid) {
      updateTag(srcTableId, tagId, { address: norm.formatted })
      if (
        norm.dataTypeDefault &&
        (currentDataType === 'BOOL' || currentDataType === 'BYTE' || currentDataType === 'INT' || currentDataType === 'DINT')
      ) {
        updateTag(srcTableId, tagId, { dataType: norm.dataTypeDefault })
      }
    } else {
      updateTag(srcTableId, tagId, { address: norm.formatted })
    }
    markDirty(true)
  }

  const handleDelete = (srcTableId: string, tagId: string) => {
    deleteTag(srcTableId, tagId)
    markDirty(true)
  }

  return (
    <div className="cq h-full flex flex-col bg-industrial-900 select-none text-xs overflow-hidden">
      {/* Table Toolbar */}
      <div className="h-10 shrink-0 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between gap-3 whitespace-nowrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-semibold text-industrial-100 truncate">
            {isAllTags ? 'All PLC Tags (Unified View)' : `Tag Table: ${activeTable?.name}`}
          </span>
          <span className="under-720:hidden shrink-0 text-[11px] text-industrial-400 bg-industrial-850 px-2 py-0.5 rounded border border-industrial-750">
            {tagsToDisplay.length} Tags Total
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {visibleCollisionsCount > 0 ? (
            <button
              data-testid="resolve-overlaps-btn"
              onClick={resolveAllOverlaps}
              title="Automatically find safe non-overlapping addresses for all colliding tags"
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded shadow transition-all animate-pulse"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>
                <span className="under-720:hidden">Resolve All Overlaps </span>({visibleCollisionsCount})
              </span>
            </button>
          ) : (
            <div className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 px-2 py-0.5 rounded">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span className="under-600:hidden">Memory Guard: No Overlaps</span>
            </div>
          )}

          <button
            onClick={handleAddTag}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-siemens-cyan hover:bg-cyan-600 rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Tag</span>
          </button>
        </div>
      </div>

      {/* Collision Alert Banner */}
      {visibleCollisionsCount > 0 && (
        <div data-testid="collision-alert-banner" className="shrink-0 px-3 py-2 bg-amber-950/40 border-b border-amber-800/80 flex items-center justify-between gap-3 text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>S7 Memory Overlap Detected:</strong> {visibleCollisionsCount} tag(s) occupy overlapping physical memory coordinates.
              <span className="under-900:hidden"> Click "Auto-Assign Safe Address" to resolve.</span>
            </span>
          </div>
          <button
            data-testid="fix-all-overlaps-banner-btn"
            onClick={resolveAllOverlaps}
            className="shrink-0 text-xs underline text-amber-300 hover:text-white font-medium cursor-pointer"
          >
            Fix All Now
          </button>
        </div>
      )}

      {/* Data Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-max text-left border-collapse font-mono">
          <thead className="bg-industrial-950 text-industrial-400 sticky top-0 border-b border-industrial-800 uppercase text-[10px] tracking-wider z-10">
            <tr>
              <th className="py-2 px-3 w-10 min-w-[40px] text-center whitespace-nowrap">Status</th>
              <th className="py-2 px-3 w-56 min-w-[200px] whitespace-nowrap">Name</th>
              <th className="py-2 px-3 w-28 min-w-[100px] whitespace-nowrap">Data Type</th>
              <th className="py-2 px-3 w-32 min-w-[110px] whitespace-nowrap">Address</th>
              {showMonitoring && <th className="py-2 px-3 w-40 min-w-[140px] text-emerald-400 whitespace-nowrap">Monitor Value</th>}
              {isAllTags && <th className="py-2 px-3 w-32 min-w-[120px] whitespace-nowrap">Table</th>}
              <th className="py-2 px-3 min-w-[220px] whitespace-nowrap">Comment</th>
              <th className="py-2 px-3 w-32 min-w-[110px] text-right whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
            {tagsToDisplay.length === 0 ? (
              <tr>
                <td colSpan={showMonitoring ? (isAllTags ? 8 : 7) : (isAllTags ? 7 : 6)} className="py-8 text-center text-industrial-500 italic font-sans whitespace-nowrap">
                  No tags in this table. Click "+ Add Tag" to create one.
                </td>
              </tr>
            ) : (
              tagsToDisplay.map(({ tag, sourceTableId, sourceTableName }) => {
                const collision = collisions.get(tag.id) || collisions.get(tag.name.toLowerCase())
                const isSelected = selectedTagId === tag.id

                return (
                  <tr
                    key={tag.id}
                    onClick={() => selectTag(tag.id)}
                    className={`transition-colors cursor-pointer group ${
                      collision
                        ? 'bg-amber-950/30 hover:bg-amber-950/50 border-l-4 border-amber-500'
                        : isSelected
                        ? 'bg-cyan-950/40 hover:bg-cyan-950/50 border-l-4 border-cyan-500'
                        : 'hover:bg-industrial-850 border-l-4 border-transparent'
                    }`}
                  >
                    {/* Status column */}
                    <td className="py-1.5 px-3 text-center whitespace-nowrap">
                      {collision ? (
                        <div
                          title={`Memory Collision!\n${collision.conflictsWith
                            .map((c) => `Overlaps with '${c.name}' (${c.address}) at ${c.overlapArea}`)
                            .join('\n')}`}
                          className="inline-flex"
                        >
                          <AlertTriangle className="w-4 h-4 text-amber-400 animate-pulse" />
                        </div>
                      ) : (
                        <div className="w-2 h-2 rounded-full bg-emerald-500/60 mx-auto" />
                      )}
                    </td>

                    {/* Name */}
                    <td className="py-1 px-3 min-w-[200px] whitespace-nowrap">
                      <input
                        type="text"
                        value={tag.name}
                        onChange={(e) => handleUpdate(sourceTableId, tag.id, 'name', e.target.value)}
                        className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden whitespace-nowrap"
                      />
                    </td>

                    {/* Data Type */}
                    <td className="py-1 px-3 whitespace-nowrap">
                      <select
                        value={tag.dataType}
                        onChange={(e) => handleUpdate(sourceTableId, tag.id, 'dataType', e.target.value)}
                        className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1 py-0.5 text-cyan-300 font-mono focus:outline-hidden cursor-pointer"
                      >
                        <option value="BOOL" className="bg-industrial-900 text-industrial-100">BOOL</option>
                        <option value="BYTE" className="bg-industrial-900 text-industrial-100">BYTE</option>
                        <option value="WORD" className="bg-industrial-900 text-industrial-100">WORD</option>
                        <option value="DWORD" className="bg-industrial-900 text-industrial-100">DWORD</option>
                        <option value="INT" className="bg-industrial-900 text-industrial-100">INT</option>
                        <option value="DINT" className="bg-industrial-900 text-industrial-100">DINT</option>
                        <option value="REAL" className="bg-industrial-900 text-industrial-100">REAL</option>
                        <option value="TIME" className="bg-industrial-900 text-industrial-100">TIME</option>
                        <option value="STRING" className="bg-industrial-900 text-industrial-100">STRING</option>
                      </select>
                    </td>

                    {/* Address */}
                    <td className="py-1 px-3 whitespace-nowrap">
                      <div className="relative">
                        <input
                          data-testid="tag-address-input"
                          type="text"
                          value={tag.address}
                          onChange={(e) => handleUpdate(sourceTableId, tag.id, 'address', e.target.value)}
                          onBlur={(e) => handleAddressCommit(sourceTableId, tag.id, e.target.value, tag.dataType)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleAddressCommit(sourceTableId, tag.id, e.currentTarget.value, tag.dataType)
                            }
                          }}
                          className={`w-full font-mono font-bold rounded-none px-1.5 py-0.5 focus:outline-hidden whitespace-nowrap ${
                            collision
                              ? 'bg-amber-900/40 border border-amber-600 text-amber-200'
                              : 'bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 text-industrial-100'
                          }`}
                        />
                      </div>
                    </td>

                    {/* Live Monitor Value */}
                    {showMonitoring && (() => {
                      const liveVal =
                        (tag.address ? engine.getVariable(tag.address) : undefined) ??
                        (tag.name ? engine.getVariable(tag.name) : undefined) ??
                        tag.monitorValue
                      const isBool = tag.dataType === 'BOOL' || typeof liveVal === 'boolean'
                      return (
                        <td className="py-1 px-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span
                              data-testid={`tag-monitor-val-${tag.name}`}
                              className={`px-1.5 py-0.5 rounded-none font-bold ${
                                isBool
                                  ? liveVal
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-600'
                                    : 'bg-industrial-950 text-industrial-500 border border-industrial-800'
                                  : 'bg-industrial-950 text-cyan-300 border border-industrial-800'
                              }`}
                            >
                              {liveVal !== undefined ? String(liveVal) : '0'}
                            </span>
                            <button
                              data-testid={`tag-modify-btn-${tag.name}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (isBool) {
                                  const nextVal = !Boolean(liveVal)
                                  forceValue(tag.address, nextVal, true)
                                  forceValue(tag.name, nextVal, true)
                                  engine.setVariable(tag.address, nextVal)
                                  engine.setVariable(tag.name, nextVal)
                                  tag.monitorValue = nextVal
                                  updateTag(sourceTableId, tag.id, { monitorValue: nextVal })
                                } else {
                                  const next = prompt(`Modify value for ${tag.name} (${tag.address}):`, String(liveVal ?? 0))
                                  if (next !== null) {
                                    const parsed = tag.dataType === 'REAL' ? parseFloat(next) : parseInt(next, 10)
                                    const valToWrite = isNaN(parsed) ? next : parsed
                                    forceValue(tag.address, valToWrite, true)
                                    forceValue(tag.name, valToWrite, true)
                                    engine.setVariable(tag.address, valToWrite)
                                    engine.setVariable(tag.name, valToWrite)
                                    tag.monitorValue = valToWrite
                                    updateTag(sourceTableId, tag.id, { monitorValue: valToWrite })
                                  }
                                }
                              }}
                              title="Modify / Force value online"
                              className="px-1.5 py-0.5 rounded-none bg-industrial-800 hover:bg-industrial-700 text-industrial-300 hover:text-white text-[9px] border border-industrial-700 font-sans cursor-pointer whitespace-nowrap"
                            >
                              Modify
                            </button>
                          </div>
                        </td>
                      )
                    })()}

                    {/* Table Name (if unified view) */}
                    {isAllTags && (
                      <td className="py-1 px-3 text-industrial-400 font-sans truncate whitespace-nowrap">
                        {sourceTableName}
                      </td>
                    )}

                    {/* Comment */}
                    <td className="py-1 px-3 whitespace-nowrap">
                      <input
                        type="text"
                        value={tag.comment || ''}
                        onChange={(e) => handleUpdate(sourceTableId, tag.id, 'comment', e.target.value)}
                        placeholder="Add engineering comment..."
                        className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans placeholder-industrial-600 focus:outline-hidden whitespace-nowrap"
                      />
                    </td>

                    {/* Actions */}
                    <td className="py-1 px-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        {collision && (
                          <button
                            data-testid={`auto-fix-tag-${tag.name}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              autoAssignSafeAddress(tag.id)
                            }}
                            title="Auto-Assign Next Safe Address"
                            className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded transition-colors whitespace-nowrap cursor-pointer"
                          >
                            <Zap className="w-3 h-3" />
                            <span>Auto-Fix</span>
                          </button>
                        )}

                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(sourceTableId, tag.id)
                          }}
                          data-testid="tag-delete-button"
                          title="Delete Tag"
                          className="p-1 text-industrial-400 hover:text-red-400 hover:bg-industrial-800 rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
