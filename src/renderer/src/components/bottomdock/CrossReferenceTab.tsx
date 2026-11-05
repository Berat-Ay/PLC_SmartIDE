import React from 'react'
import {
  Search,
  ExternalLink,
  BookOpen,
  Eye,
  Edit3,
  Layers,
  CheckCircle2
} from 'lucide-react'
import { useCrossRefStore } from '../../stores/useCrossRefStore'
import { useUIStore } from '../../stores/useUIStore'
import { CrossReferenceItem } from '@shared/types/crossref'

export const CrossReferenceTab: React.FC = () => {
  const { activeQuery, queryResult, setQuery } = useCrossRefStore()
  const { openTab } = useUIStore()

  const handleRowClick = (ref: CrossReferenceItem) => {
    switch (ref.sourceType) {
      case 'OB':
      case 'FB':
      case 'FC':
        if (ref.sourceObjectId.endsWith('.lad.json')) {
          openTab({
            id: `tab_lad_${ref.sourceObjectId}`,
            title: ref.sourceObject,
            type: 'lad',
            targetId: ref.sourceObjectId
          })
        } else if (ref.sourceObjectId.endsWith('.scl')) {
          openTab({
            id: `tab_scl_${ref.sourceObjectId}`,
            title: ref.sourceObject,
            type: 'scl',
            targetId: ref.sourceObjectId
          })
        }
        break
      case 'DB':
        openTab({
          id: `tab_db_${ref.sourceObjectId}.db.json`,
          title: ref.sourceObject,
          type: 'db',
          targetId: `${ref.sourceObject}.db.json`
        })
        break
      case 'TagTable':
        openTab({
          id: `tab_tags_${ref.sourceObjectId}`,
          title: ref.sourceObject,
          type: 'tagTable',
          targetId: ref.sourceObjectId
        })
        break
      case 'Hardware':
        openTab({
          id: 'tab_hardware_config',
          title: 'Device Configuration',
          type: 'hardware'
        })
        break
      case 'UDT':
        openTab({
          id: `tab_udt_${ref.sourceObjectId}`,
          title: ref.sourceObject,
          type: 'udt',
          targetId: ref.sourceObjectId
        })
        break
    }
  }

  const getAccessBadge = (access: CrossReferenceItem['accessType']) => {
    switch (access) {
      case 'Declaration':
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-950 text-purple-300 border border-purple-800">
            DECL
          </span>
        )
      case 'Read':
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-950 text-cyan-300 border border-cyan-800">
            READ
          </span>
        )
      case 'Write':
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-800">
            WRITE
          </span>
        )
      case 'Read/Write':
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-950 text-blue-300 border border-blue-800">
            R/W
          </span>
        )
    }
  }

  return (
    <div className="h-full flex flex-col bg-industrial-900 select-none text-xs">
      {/* Search Header */}
      <div className="h-8 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-industrial-400" />
          <input
            type="text"
            value={activeQuery}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type symbol, address (e.g. %I0.0, %MW10), or DB field..."
            className="w-full bg-industrial-900 border border-industrial-700 rounded px-2 py-0.5 text-xs text-industrial-100 placeholder-industrial-500 font-mono focus:border-cyan-500 focus:outline-hidden"
          />
        </div>

        <div className="text-[11px] text-industrial-400 font-mono">
          {queryResult ? (
            <span>
              Found <strong className="text-cyan-400">{queryResult.totalCount}</strong> references for "
              <strong className="text-industrial-200">{queryResult.symbol}</strong>"
            </span>
          ) : (
            <span>Select any tag or type a symbol to query instantly (0ms)</span>
          )}
        </div>
      </div>

      {/* Results Table */}
      <div className="flex-1 overflow-auto">
        {!queryResult || queryResult.references.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-4 text-industrial-500 text-xs italic">
            No cross-references found. Select a row in a Tag Table, DB, or enter a symbol name above.
          </div>
        ) : (
          <table className="w-full text-left font-mono">
            <thead className="bg-industrial-950 text-industrial-400 sticky top-0 border-b border-industrial-850 uppercase text-[10px]">
              <tr>
                <th className="py-1.5 px-3 w-16 text-center">Access</th>
                <th className="py-1.5 px-3 w-48">Source Object</th>
                <th className="py-1.5 px-3 w-48">Location</th>
                <th className="py-1.5 px-3">Code / Element Reference</th>
                <th className="py-1.5 px-3 w-16 text-right">Go to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-industrial-850 text-industrial-200">
              {queryResult.references.map((ref) => (
                <tr
                  key={ref.id}
                  onClick={() => handleRowClick(ref)}
                  className="hover:bg-industrial-850 cursor-pointer group transition-colors"
                >
                  <td className="py-1.5 px-3 text-center">{getAccessBadge(ref.accessType)}</td>
                  <td className="py-1.5 px-3 font-semibold text-industrial-200 truncate">
                    {ref.sourceObject}
                  </td>
                  <td className="py-1.5 px-3 text-industrial-400 truncate font-sans text-xs">
                    {ref.location}
                  </td>
                  <td className="py-1.5 px-3 text-cyan-300 font-mono text-[11px] truncate">
                    {ref.snippet || ref.targetSymbol}
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    <button
                      title="Open source block"
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-industrial-400 hover:text-cyan-400"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
