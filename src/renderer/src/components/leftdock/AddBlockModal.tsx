import React, { useState } from 'react'
import { X, Box, Code, Cpu, FileCode2, Database } from 'lucide-react'
import { useUIStore } from '../../stores/useUIStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { BlockType, BlockLanguage, DbType } from '@shared/types/blocks'

export const AddBlockModal: React.FC = () => {
  const { isAddBlockModalOpen, setAddBlockModalOpen, openTab } = useUIStore()
  const { addDataBlock, addLadBlock, addSclBlock } = useBlockStore()
  const { markDirty } = useProjectStore()

  const [blockType, setBlockType] = useState<BlockType>('FB')
  const [language, setLanguage] = useState<BlockLanguage>('LAD')
  const [blockNumber, setBlockNumber] = useState<number>(2)
  const [name, setName] = useState<string>('FB2_ValveControl')
  const [optimizedAccess, setOptimizedAccess] = useState<boolean>(true)
  const [dbType, setDbType] = useState<DbType>('Global')

  if (!isAddBlockModalOpen) return null

  const handleTypeChange = (type: BlockType) => {
    setBlockType(type)
    if (type === 'DB') {
      setName(`DB${blockNumber}_Data`)
    } else {
      setName(`${type}${blockNumber}_NewBlock`)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (blockType === 'DB') {
      const fileName = `${name}.db.json`
      addDataBlock({
        blockType: 'DB',
        blockNumber,
        name,
        fileName,
        dbType,
        optimizedAccess,
        variables: [],
        comment: `User created ${dbType} Data Block`
      })
      openTab({
        id: `tab_db_${fileName}`,
        title: name,
        type: 'db',
        targetId: fileName
      })
    } else if (language === 'LAD') {
      const fileName = `${name}.lad.json`
      addLadBlock({
        blockType,
        blockNumber,
        name,
        fileName,
        optimizedAccess,
        interface: {
          input: [],
          output: [],
          inOut: [],
          static: [],
          temp: [],
          constant: []
        },
        networks: [
          {
            networkNumber: 1,
            title: 'Initial Rung',
            elements: []
          }
        ],
        schemaVersion: '1.0.0'
      })
      openTab({
        id: `tab_lad_${fileName}`,
        title: name,
        type: 'lad',
        targetId: fileName
      })
    } else {
      const fileName = `${name}.scl`
      const initialCode = `// ============================================================
// Block: ${name} (${blockType}${blockNumber})
// ============================================================

${blockType === 'OB' ? 'ORGANIZATION_BLOCK' : blockType === 'FB' ? 'FUNCTION_BLOCK' : 'FUNCTION'} "${name}"
TITLE = "${name}"
{ S7_Optimized_Access := '${optimizedAccess ? 'TRUE' : 'FALSE'}' }
VERSION : 0.1

VAR_INPUT
END_VAR

VAR_OUTPUT
END_VAR

BEGIN
  // SCL Logic execution
END_${blockType === 'OB' ? 'ORGANIZATION_BLOCK' : blockType === 'FB' ? 'FUNCTION_BLOCK' : 'FUNCTION'}
`
      addSclBlock({
        blockType,
        blockNumber,
        name,
        fileName,
        optimizedAccess,
        interface: {
          input: [],
          output: [],
          inOut: [],
          static: [],
          temp: [],
          constant: []
        },
        code: initialCode
      })
      openTab({
        id: `tab_scl_${fileName}`,
        title: name,
        type: 'scl',
        targetId: fileName
      })
    }

    markDirty(true)
    setAddBlockModalOpen(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-industrial-900 border border-industrial-750 rounded-lg shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-industrial-950 border-b border-industrial-800">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-siemens-cyan" />
            <h3 className="text-sm font-semibold text-industrial-100">Add New Program Block</h3>
          </div>
          <button
            onClick={() => setAddBlockModalOpen(false)}
            className="text-industrial-400 hover:text-industrial-200 p-1 rounded hover:bg-industrial-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Block Type Selection */}
          <div>
            <label className="block text-xs font-medium text-industrial-300 mb-1.5">Block Type</label>
            <div className="grid grid-cols-4 gap-2">
              {(['OB', 'FB', 'FC', 'DB'] as BlockType[]).map((type) => {
                const isSelected = blockType === type
                const colorMap = {
                  OB: 'border-s7-ob text-purple-300 bg-purple-950/30',
                  FB: 'border-s7-fb text-blue-300 bg-blue-950/30',
                  FC: 'border-s7-fc text-emerald-300 bg-emerald-950/30',
                  DB: 'border-s7-db text-amber-300 bg-amber-950/30'
                }
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleTypeChange(type)}
                    className={`py-2 px-3 rounded border text-center transition-all ${
                      isSelected
                        ? `${colorMap[type]} font-bold shadow-sm`
                        : 'border-industrial-750 bg-industrial-850 text-industrial-400 hover:text-industrial-200 hover:border-industrial-600'
                    }`}
                  >
                    <div className="text-sm">{type}</div>
                    <div className="text-[10px] opacity-75">
                      {type === 'OB' ? 'Org Block' : type === 'FB' ? 'Func Block' : type === 'FC' ? 'Function' : 'Data Block'}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Language Selection (only if not DB) */}
          {blockType !== 'DB' && (
            <div>
              <label className="block text-xs font-medium text-industrial-300 mb-1.5">Programming Language</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setLanguage('LAD')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded border text-xs transition-all ${
                    language === 'LAD'
                      ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300 font-semibold'
                      : 'border-industrial-750 bg-industrial-850 text-industrial-400 hover:text-industrial-200'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5" />
                  <span>Ladder Logic (LAD)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage('SCL')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded border text-xs transition-all ${
                    language === 'SCL'
                      ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300 font-semibold'
                      : 'border-industrial-750 bg-industrial-850 text-industrial-400 hover:text-industrial-200'
                  }`}
                >
                  <Code className="w-3.5 h-3.5" />
                  <span>Structured Control (SCL)</span>
                </button>
              </div>
            </div>
          )}

          {/* DB Type Selection */}
          {blockType === 'DB' && (
            <div>
              <label className="block text-xs font-medium text-industrial-300 mb-1.5">Data Block Type</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDbType('Global')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded border text-xs transition-all ${
                    dbType === 'Global'
                      ? 'border-amber-500 bg-amber-950/40 text-amber-300 font-semibold'
                      : 'border-industrial-750 bg-industrial-850 text-industrial-400 hover:text-industrial-200'
                  }`}
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>Global DB</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDbType('Instance')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded border text-xs transition-all ${
                    dbType === 'Instance'
                      ? 'border-amber-500 bg-amber-950/40 text-amber-300 font-semibold'
                      : 'border-industrial-750 bg-industrial-850 text-industrial-400 hover:text-industrial-200'
                  }`}
                >
                  <Box className="w-3.5 h-3.5" />
                  <span>Instance DB (FB Link)</span>
                </button>
              </div>
            </div>
          )}

          {/* Name & Block Number */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <label className="block text-xs font-medium text-industrial-300 mb-1">Number</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={blockNumber}
                onChange={(e) => setBlockNumber(parseInt(e.target.value, 10) || 1)}
                className="w-full bg-industrial-950 border border-industrial-700 rounded px-2.5 py-1.5 text-xs text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-industrial-300 mb-1">Block Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-industrial-950 border border-industrial-700 rounded px-2.5 py-1.5 text-xs text-industrial-100 focus:border-cyan-500 focus:outline-hidden"
                placeholder="e.g. FB1_MotorControl"
                required
              />
            </div>
          </div>

          {/* Access Mode */}
          <div className="p-3 rounded bg-industrial-950/60 border border-industrial-800">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-industrial-200">Optimized Block Access</div>
                <div className="text-[11px] text-industrial-400">
                  {optimizedAccess
                    ? 'Symbolic memory management without physical Byte.Bit offsets.'
                    : 'Standard S7 layout with deterministic Byte.Bit offsets and word alignment.'}
                </div>
              </div>
              <input
                type="checkbox"
                checked={optimizedAccess}
                onChange={(e) => setOptimizedAccess(e.target.checked)}
                className="h-4 w-4 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-industrial-800">
            <button
              type="button"
              onClick={() => setAddBlockModalOpen(false)}
              className="px-3 py-1.5 text-xs text-industrial-300 hover:text-industrial-100 hover:bg-industrial-800 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-semibold text-white bg-siemens-cyan hover:bg-cyan-600 rounded shadow-sm transition-colors"
            >
              Create Block
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
