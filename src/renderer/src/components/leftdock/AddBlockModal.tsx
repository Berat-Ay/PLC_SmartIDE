import React, { useEffect, useState } from 'react'
import { X, Box, Code, Cpu, FileCode2, Database, AlertCircle } from 'lucide-react'
import { useUIStore } from '../../stores/useUIStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { BlockType, BlockLanguage, DbType } from '@shared/types/blocks'
import { effectiveInterface } from '@shared/scl/sourceBlock'
import { createDataBlockDefinition, createInitialLadNetworks } from '@shared/blocks/blockFactory'
import { S7OffsetCalculator } from '../../services/S7OffsetCalculator'

export const AddBlockModal: React.FC = () => {
  const { isAddBlockModalOpen, setAddBlockModalOpen, openTab } = useUIStore()
  const { ladBlocks, sclBlocks, udts, addDataBlock, addLadBlock, addSclBlock } = useBlockStore()
  const { markDirty } = useProjectStore()

  const [blockType, setBlockType] = useState<BlockType>('FB')
  const [language, setLanguage] = useState<BlockLanguage>('LAD')
  const [blockNumber, setBlockNumber] = useState<number>(2)
  const [name, setName] = useState<string>('FB2_ValveControl')
  const [optimizedAccess, setOptimizedAccess] = useState<boolean>(true)
  const [dbType, setDbType] = useState<DbType>('Global')
  const [parentFbName, setParentFbName] = useState<string>('')

  const availableFbs = [
    ...ladBlocks
      .filter((b) => b.blockType === 'FB')
      .map((b) => ({
        name: b.name,
        blockNumber: b.blockNumber,
        language: 'LAD' as const,
        interface: b.interface
      })),
    ...sclBlocks
      .filter((b) => b.blockType === 'FB')
      .map((b) => ({
        name: b.name,
        blockNumber: b.blockNumber,
        language: 'SCL' as const,
        interface: effectiveInterface(b)
      }))
  ]

  useEffect(() => {
    if (!isAddBlockModalOpen || blockType !== 'DB' || dbType !== 'Instance') return
    if (availableFbs.length === 0) {
      if (parentFbName !== '') setParentFbName('')
      return
    }
    if (!availableFbs.some((fb) => fb.name === parentFbName)) {
      setParentFbName(availableFbs[0].name)
    }
  }, [isAddBlockModalOpen, blockType, dbType, ladBlocks, sclBlocks])

  if (!isAddBlockModalOpen) return null

  const selectedFb =
    blockType === 'DB' && dbType === 'Instance'
      ? availableFbs.find((fb) => fb.name === parentFbName)
      : undefined
  const isInstanceDbInvalid = blockType === 'DB' && dbType === 'Instance' && !selectedFb
  const canSubmit = name.trim().length > 0 && !isInstanceDbInvalid

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
    if (!canSubmit) return

    const cleanName = name.trim()

    if (blockType === 'DB') {
      const dbDef = createDataBlockDefinition({
        blockNumber,
        name: cleanName,
        dbType,
        optimizedAccess,
        parentFb: selectedFb
      })
      if (!optimizedAccess && dbDef.variables.length > 0) {
        const udtMap = new Map(udts.map((u) => [u.name, u]))
        dbDef.variables = S7OffsetCalculator.calculateVariableOffsets(dbDef.variables, udtMap)
      }
      addDataBlock(dbDef)
      openTab({
        id: `tab_db_${dbDef.fileName}`,
        title: cleanName,
        type: 'db',
        targetId: dbDef.fileName
      })
    } else if (language === 'LAD') {
      const fileName = `${cleanName}.lad.json`
      addLadBlock({
        blockType,
        blockNumber,
        name: cleanName,
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
        networks: createInitialLadNetworks(),
        schemaVersion: '1.0.0'
      })
      openTab({
        id: `tab_lad_${fileName}`,
        title: cleanName,
        type: 'lad',
        targetId: fileName
      })
    } else {
      const fileName = `${cleanName}.scl`
      const headerDecl =
        blockType === 'OB'
          ? `ORGANIZATION_BLOCK "${cleanName}"`
          : blockType === 'FB'
          ? `FUNCTION_BLOCK "${cleanName}"`
          : `FUNCTION "${cleanName}" : Void`
      const endDecl =
        blockType === 'OB' ? 'END_ORGANIZATION_BLOCK' : blockType === 'FB' ? 'END_FUNCTION_BLOCK' : 'END_FUNCTION'
      const initialCode = `// ============================================================
// Block: ${cleanName} (${blockType}${blockNumber})
// ============================================================

${headerDecl}
TITLE = "${cleanName}"
{ S7_Optimized_Access := '${optimizedAccess ? 'TRUE' : 'FALSE'}' }
VERSION : 0.1

VAR_INPUT
END_VAR

VAR_OUTPUT
END_VAR

BEGIN
  // SCL Logic execution
${endDecl}
`
      addSclBlock({
        blockType,
        blockNumber,
        name: cleanName,
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
        title: cleanName,
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
            <div className="space-y-3">
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

              {dbType === 'Instance' && (
                <div>
                  <label className="block text-xs font-medium text-industrial-300 mb-1.5">
                    Parent Function Block (FB)
                  </label>
                  {availableFbs.length > 0 ? (
                    <>
                      <select
                        data-testid="add-block-parent-fb-select"
                        value={parentFbName}
                        onChange={(e) => setParentFbName(e.target.value)}
                        required
                        className="w-full bg-industrial-950 border border-industrial-700 rounded px-2.5 py-1.5 text-xs text-industrial-100 font-mono focus:border-amber-500 focus:outline-hidden"
                      >
                        {availableFbs.map((fb) => (
                          <option key={`${fb.language}_${fb.name}_${fb.blockNumber}`} value={fb.name}>
                            {fb.name} (FB{fb.blockNumber} - {fb.language})
                          </option>
                        ))}
                      </select>
                      {selectedFb && (
                        <div className="mt-1 text-[11px] text-industrial-400">
                          Initializes{' '}
                          <span className="text-amber-300 font-mono">
                            {selectedFb.interface.input.length +
                              selectedFb.interface.output.length +
                              selectedFb.interface.inOut.length +
                              selectedFb.interface.static.length}
                          </span>{' '}
                          instance variable(s) from <span className="font-mono text-industrial-200">{selectedFb.name}</span>.
                        </div>
                      )}
                    </>
                  ) : (
                    <div
                      data-testid="add-block-no-fb-warning"
                      className="p-2.5 rounded bg-amber-950/40 border border-amber-700/70 text-amber-200 text-[11px] flex items-start gap-2"
                    >
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>
                        No Function Blocks (FB) exist in this project yet. Create an FB first before creating an Instance DB.
                      </span>
                    </div>
                  )}
                </div>
              )}
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
              disabled={!canSubmit}
              className="px-4 py-1.5 text-xs font-semibold text-white bg-siemens-cyan hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed rounded shadow-sm transition-colors"
            >
              Create Block
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
