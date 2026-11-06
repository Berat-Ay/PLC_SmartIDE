import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Layers,
  Tag,
  Boxes,
  Activity,
  Plus,
  Flame,
  FileCode2,
  Code,
  Database,
  Trash2,
  Edit3
} from 'lucide-react'
import { useUIStore } from '../../stores/useUIStore'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useHardwareStore } from '../../stores/useHardwareStore'

export const ProjectTree: React.FC = () => {
  const { openTab, closeTab, setAddBlockModalOpen } = useUIStore()
  const { tagTables, createTagTable, renameTagTable, deleteTagTable } = useTagStore()
  const {
    udts,
    dataBlocks,
    ladBlocks,
    sclBlocks,
    addUdt,
    updateUdt,
    deleteUdt,
    updateLadBlock,
    deleteLadBlock,
    updateSclBlock,
    deleteSclBlock,
    updateDataBlock,
    deleteDataBlock
  } = useBlockStore()
  const { config } = useHardwareStore()

  // Asks first. The block leaves the project only after its file has safely moved to .trash.
  const confirmAndTrash = async (
    label: string,
    folder: 'blocks' | 'types' | 'tags',
    fileName: string | undefined,
    remove: () => void
  ): Promise<void> => {
    if (!window.confirm(`Delete ${label}?\n\nIts file moves to the .trash folder inside the project.`)) return
    const projectStore = useProjectStore.getState()
    if (window.electronApi && projectStore.projectPath && fileName) {
      try {
        projectStore.noteLocalWrite()
        await window.electronApi.trashProjectFile(projectStore.projectPath, `${folder}/${fileName}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // The built-in demo lives only in memory, so it has no file to move
        if (!message.includes('is not an open project')) {
          window.alert(`${label} was not deleted because its file could not be moved:\n${message}`)
          return
        }
      }
    }
    remove()
  }

  // Node expansion states
  const [blocksOpen, setBlocksOpen] = useState(true)
  const [tagsOpen, setTagsOpen] = useState(true)
  const [typesOpen, setTypesOpen] = useState(true)
  const [techOpen, setTechOpen] = useState(false)
  const [simOpen, setSimOpen] = useState(false)

  const handleOpenHardware = () => {
    openTab({
      id: 'tab_hardware_config',
      title: 'Device Configuration',
      type: 'hardware'
    })
  }

  const handleOpenAllTags = () => {
    openTab({
      id: 'tab_all_tags',
      title: 'All PLC Tags',
      type: 'allTags'
    })
  }

  const handleOpenTagTable = (tableId: string, name: string) => {
    openTab({
      id: `tab_tags_${tableId}`,
      title: name,
      type: 'tagTable',
      targetId: tableId
    })
  }

  const handleOpenUdt = (udtId: string, name: string) => {
    openTab({
      id: `tab_udt_${udtId}`,
      title: name,
      type: 'udt',
      targetId: udtId
    })
  }

  const handleOpenDb = (fileName: string, name: string) => {
    openTab({
      id: `tab_db_${fileName}`,
      title: name,
      type: 'db',
      targetId: fileName
    })
  }

  const handleOpenLad = (fileName: string, name: string) => {
    openTab({
      id: `tab_lad_${fileName}`,
      title: name,
      type: 'lad',
      targetId: fileName
    })
  }

  const handleOpenScl = (fileName: string, name: string) => {
    openTab({
      id: `tab_scl_${fileName}`,
      title: name,
      type: 'scl',
      targetId: fileName
    })
  }

  const handleAddUdt = () => {
    const id = `udt_${Date.now()}`
    const name = `UDT_${Math.floor(Math.random() * 900 + 100)}`
    addUdt({
      id,
      name,
      fileName: `${name}.udt.json`,
      description: 'Custom User Data Type',
      members: [
        { id: 'm1', name: 'Enable', dataType: 'BOOL', defaultValue: 'FALSE', comment: 'Enable flag' },
        { id: 'm2', name: 'Status', dataType: 'INT', defaultValue: '0', comment: 'Status code' }
      ]
    })
    handleOpenUdt(id, name)
  }

  const handleAddTagTable = () => {
    const name = `io_table_${Math.floor(Math.random() * 90 + 10)}`
    const tbl = createTagTable(name)
    handleOpenTagTable(tbl.id, tbl.name)
  }

  return (
    <div className="h-full bg-industrial-900 border-r border-industrial-800 flex flex-col select-none overflow-hidden text-xs">
      {/* Header */}
      <div className="h-8 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between text-industrial-300 font-medium tracking-wide">
        <span className="uppercase text-[11px] font-semibold text-industrial-200">Project Tree</span>
        <span className="text-[10px] text-cyan-400 font-mono font-bold">
          {config.general.targetCpu?.includes('1200') || config.general.cpuName.includes('12') ? 'S7-1200' : 'S7-1500'}
        </span>
      </div>

      {/* Tree View Body */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {/* 1. Device Configuration */}
        <div
          onClick={handleOpenHardware}
          className="flex items-center gap-2 px-2 py-1.5 rounded-none cursor-pointer text-industrial-200 hover:text-white hover:bg-industrial-800 transition-colors group"
        >
          <Cpu className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="font-medium truncate">Device Configuration</span>
          <span className="ml-auto text-[10px] text-industrial-400 group-hover:text-industrial-300 font-mono">
            {config.general.cpuName}
          </span>
        </div>

        {/* 2. Program Blocks */}
        <div>
          <div className="flex items-center justify-between px-1 py-1 rounded-none text-industrial-300 hover:text-industrial-100 hover:bg-industrial-850 group cursor-pointer">
            <div
              className="flex items-center gap-1.5 flex-1"
              onClick={() => setBlocksOpen(!blocksOpen)}
            >
              {blocksOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              <span className="font-semibold text-industrial-200">Program Blocks</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setAddBlockModalOpen(true)
              }}
              title="Add New Block"
              className="p-0.5 rounded-none text-industrial-400 hover:text-cyan-400 hover:bg-industrial-750 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {blocksOpen && (
            <div className="pl-4 space-y-0.5 mt-0.5">
              {/* Organization Blocks (OB) */}
              {ladBlocks
                .filter((b) => b.blockType === 'OB')
                .map((b) => {
                  const isMainOb = b.name === 'Main' || b.name === 'OB1' || b.fileName.includes('OB1') || b.fileName.includes('Main')
                  return (
                    <div
                      key={b.fileName}
                      data-testid={`tree-block-${b.fileName}`}
                      onClick={() => handleOpenLad(b.fileName, b.name)}
                      className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-purple-950/80 text-purple-300 border border-purple-800">
                          OB
                        </span>
                        <FileCode2 className="w-3 h-3 text-purple-400 shrink-0" />
                        <span className="truncate">{b.name}</span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const n = prompt('Rename Block:', b.name)
                            if (n && n.trim() && n.trim() !== b.name) updateLadBlock(b.fileName, { name: n.trim() })
                          }}
                          title="Rename Block"
                          className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                        {!isMainOb && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                                deleteLadBlock(b.fileName)
                                closeTab(`tab_lad_${b.fileName}`)
                              })
                            }}
                            data-testid="tree-delete-block"
                            title="Delete Block"
                            className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              {sclBlocks
                .filter((b) => b.blockType === 'OB')
                .map((b) => {
                  const isMainOb = b.name === 'Main' || b.name === 'OB1' || b.fileName.includes('OB1') || b.fileName.includes('Main')
                  return (
                    <div
                      key={b.fileName}
                      onClick={() => handleOpenScl(b.fileName, b.name)}
                      className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-purple-950/80 text-purple-300 border border-purple-800">
                          OB
                        </span>
                        <Code className="w-3 h-3 text-purple-400 shrink-0" />
                        <span className="truncate">{b.name}</span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const n = prompt('Rename Block:', b.name)
                            if (n && n.trim() && n.trim() !== b.name) updateSclBlock(b.fileName, { name: n.trim() })
                          }}
                          title="Rename Block"
                          className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                        {!isMainOb && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                                deleteSclBlock(b.fileName)
                                closeTab(`tab_scl_${b.fileName}`)
                              })
                            }}
                            data-testid="tree-delete-block"
                            title="Delete Block"
                            className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}

              {/* Function Blocks (FB) */}
              {ladBlocks
                .filter((b) => b.blockType === 'FB')
                .map((b) => (
                  <div
                    key={b.fileName}
                    onClick={() => handleOpenLad(b.fileName, b.name)}
                    className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-blue-950/80 text-blue-300 border border-blue-800">
                        FB
                      </span>
                      <FileCode2 className="w-3 h-3 text-blue-400 shrink-0" />
                      <span className="truncate">{b.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const n = prompt('Rename FB:', b.name)
                          if (n && n.trim() && n.trim() !== b.name) updateLadBlock(b.fileName, { name: n.trim() })
                        }}
                        title="Rename FB"
                        className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                            deleteLadBlock(b.fileName)
                            closeTab(`tab_lad_${b.fileName}`)
                          })
                        }}
                        data-testid="tree-delete-block"
                        title="Delete FB"
                        className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              {sclBlocks
                .filter((b) => b.blockType === 'FB')
                .map((b) => (
                  <div
                    key={b.fileName}
                    onClick={() => handleOpenScl(b.fileName, b.name)}
                    className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-blue-950/80 text-blue-300 border border-blue-800">
                        FB
                      </span>
                      <Code className="w-3 h-3 text-blue-400 shrink-0" />
                      <span className="truncate">{b.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const n = prompt('Rename FB:', b.name)
                          if (n && n.trim() && n.trim() !== b.name) updateSclBlock(b.fileName, { name: n.trim() })
                        }}
                        title="Rename FB"
                        className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                            deleteSclBlock(b.fileName)
                            closeTab(`tab_scl_${b.fileName}`)
                          })
                        }}
                        data-testid="tree-delete-block"
                        title="Delete FB"
                        className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}

              {/* Functions (FC) */}
              {ladBlocks
                .filter((b) => b.blockType === 'FC')
                .map((b) => (
                  <div
                    key={b.fileName}
                    onClick={() => handleOpenLad(b.fileName, b.name)}
                    className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-emerald-950/80 text-emerald-300 border border-emerald-800">
                        FC
                      </span>
                      <FileCode2 className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span className="truncate">{b.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const n = prompt('Rename FC:', b.name)
                          if (n && n.trim() && n.trim() !== b.name) updateLadBlock(b.fileName, { name: n.trim() })
                        }}
                        title="Rename FC"
                        className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                            deleteLadBlock(b.fileName)
                            closeTab(`tab_lad_${b.fileName}`)
                          })
                        }}
                        data-testid="tree-delete-block"
                        title="Delete FC"
                        className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              {sclBlocks
                .filter((b) => b.blockType === 'FC')
                .map((b) => (
                  <div
                    key={b.fileName}
                    onClick={() => handleOpenScl(b.fileName, b.name)}
                    className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-emerald-950/80 text-emerald-300 border border-emerald-800">
                        FC
                      </span>
                      <Code className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span className="truncate">{b.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const n = prompt('Rename FC:', b.name)
                          if (n && n.trim() && n.trim() !== b.name) updateSclBlock(b.fileName, { name: n.trim() })
                        }}
                        title="Rename FC"
                        className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                            deleteSclBlock(b.fileName)
                            closeTab(`tab_scl_${b.fileName}`)
                          })
                        }}
                        data-testid="tree-delete-block"
                        title="Delete FC"
                        className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}

              {/* Data Blocks (DB) */}
              {dataBlocks.map((b) => (
                <div
                  key={b.fileName}
                  onClick={() => handleOpenDb(b.fileName, b.name)}
                  className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className="px-1 py-0.2 rounded-none text-[9px] font-bold bg-amber-950/80 text-amber-300 border border-amber-800">
                      DB
                    </span>
                    <Database className="w-3 h-3 text-amber-400 shrink-0" />
                    <span className="truncate">{b.name}</span>
                    <span className="text-[10px] text-industrial-500 font-mono">
                      {b.optimizedAccess ? 'Opt' : 'Std'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const n = prompt('Rename DB:', b.name)
                        if (n && n.trim() && n.trim() !== b.name) updateDataBlock(b.fileName, { name: n.trim() })
                      }}
                      title="Rename DB"
                      className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void confirmAndTrash(b.name, 'blocks', b.fileName, () => {
                          deleteDataBlock(b.fileName)
                          closeTab(`tab_db_${b.fileName}`)
                        })
                      }}
                      data-testid="tree-delete-block"
                      title="Delete DB"
                      className="p-0.5 text-industrial-400 hover:text-red-400 rounded-none"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3. PLC Tags */}
        <div>
          <div className="flex items-center justify-between px-1 py-1 rounded-none text-industrial-300 hover:text-industrial-100 hover:bg-industrial-850 group cursor-pointer">
            <div
              className="flex items-center gap-1.5 flex-1"
              onClick={() => setTagsOpen(!tagsOpen)}
            >
              {tagsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Tag className="w-3.5 h-3.5 text-cyan-400" />
              <span className="font-semibold text-industrial-200">PLC Tags</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleAddTagTable()
              }}
              title="Add New Tag Table"
              className="p-0.5 rounded-none text-industrial-400 hover:text-cyan-400 hover:bg-industrial-750 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {tagsOpen && (
            <div className="pl-4 space-y-0.5 mt-0.5">
              <div
                onClick={handleOpenAllTags}
                className="flex items-center gap-2 px-2 py-1 rounded-none cursor-pointer text-cyan-300 hover:text-white hover:bg-industrial-800 transition-colors font-medium"
              >
                <Tag className="w-3 h-3 text-cyan-400" />
                <span>Show All Tags</span>
              </div>

              {tagTables.map((tbl) => (
                <div
                  key={tbl.id}
                  onClick={() => handleOpenTagTable(tbl.id, tbl.name)}
                  className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                >
                  <div className="flex items-center gap-2 truncate">
                    <Tag className="w-3 h-3 text-industrial-400 group-hover:text-cyan-400" />
                    <span className="truncate">{tbl.name}</span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const n = prompt('Rename Tag Table:', tbl.name)
                        if (n && n.trim() && n.trim() !== tbl.name) renameTagTable(tbl.id, n.trim())
                      }}
                      title="Rename Tag Table"
                      className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                    {tagTables.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndTrash(tbl.name, 'tags', tbl.fileName, () => {
                            deleteTagTable(tbl.id)
                            closeTab(`tab_tags_${tbl.id}`)
                          })
                        }}
                        data-testid="tree-delete-tag-table"
                        title="Delete Tag Table"
                        className="p-0.5 text-industrial-500 hover:text-red-400 rounded-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 4. PLC Data Types (UDT) */}
        <div>
          <div className="flex items-center justify-between px-1 py-1 rounded-none text-industrial-300 hover:text-industrial-100 hover:bg-industrial-850 group cursor-pointer">
            <div
              className="flex items-center gap-1.5 flex-1"
              onClick={() => setTypesOpen(!typesOpen)}
            >
              {typesOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Boxes className="w-3.5 h-3.5 text-pink-400" />
              <span className="font-semibold text-industrial-200">PLC Data Types (UDT)</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleAddUdt()
              }}
              title="Add New UDT"
              className="p-0.5 rounded-none text-industrial-400 hover:text-pink-400 hover:bg-industrial-750 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {typesOpen && (
            <div className="pl-4 space-y-0.5 mt-0.5">
              {udts.map((udt) => (
                <div
                  key={udt.id}
                  onClick={() => handleOpenUdt(udt.id, udt.name)}
                  className="flex items-center justify-between px-2 py-1 rounded-none cursor-pointer text-industrial-300 hover:text-white hover:bg-industrial-800 transition-colors group"
                >
                  <div className="flex items-center gap-2 truncate">
                    <Boxes className="w-3 h-3 text-pink-400" />
                    <span className="truncate">{udt.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-industrial-500 font-mono mr-1">
                      {udt.calculatedSizeInBytes || 0}B
                    </span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const n = prompt('Rename UDT:', udt.name)
                          if (n && n.trim() && n.trim() !== udt.name) updateUdt(udt.id, { name: n.trim() })
                        }}
                        title="Rename UDT"
                        className="p-0.5 text-industrial-400 hover:text-cyan-400 rounded-none"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndTrash(udt.name, 'types', udt.fileName, () => {
                            deleteUdt(udt.id)
                            closeTab(`tab_udt_${udt.id}`)
                          })
                        }}
                        data-testid="tree-delete-udt"
                        title="Delete UDT"
                        className="p-0.5 text-industrial-500 hover:text-red-400 rounded-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 5. Technology Objects (Placeholder for HSC, PID) */}
        <div>
          <div
            onClick={() => setTechOpen(!techOpen)}
            className="flex items-center gap-1.5 px-1 py-1 rounded-none text-industrial-400 hover:text-industrial-200 hover:bg-industrial-850 cursor-pointer"
          >
            {techOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Activity className="w-3.5 h-3.5 text-orange-400" />
            <span className="font-semibold">Technology Objects</span>
          </div>
          {techOpen && (
            <div className="pl-6 py-1 text-[11px] text-industrial-500 italic">
              Reserved for PID_Compact & High-Speed Counter (HSC) objects.
            </div>
          )}
        </div>

        {/* 6. Simulation & Fault Panel */}
        <div>
          <div
            onClick={() => {
              setSimOpen(!simOpen)
              openTab({
                id: 'tab_simulation',
                title: 'Simulation & Fault Panel',
                type: 'simulation'
              })
            }}
            className="flex items-center gap-1.5 px-1 py-1 rounded-none text-industrial-400 hover:text-industrial-200 hover:bg-industrial-850 cursor-pointer group"
          >
            {simOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Flame className="w-3.5 h-3.5 text-amber-500" />
            <span className="font-semibold text-industrial-300 group-hover:text-white">Simulation & Fault Panel</span>
          </div>
          {simOpen && (
            <div className="pl-6 space-y-0.5 mt-0.5">
              <div
                onClick={() =>
                  openTab({
                    id: 'tab_simulation',
                    title: 'Simulation & Fault Panel',
                    type: 'simulation'
                  })
                }
                className="flex items-center gap-1.5 px-1.5 py-1 rounded-none text-industrial-400 hover:text-industrial-100 hover:bg-industrial-850 cursor-pointer text-xs"
              >
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                <span>Virtual I/O Rack & Faults</span>
              </div>

              <div
                onClick={() =>
                  openTab({
                    id: 'tab_trace_scope',
                    title: 'Trace Oscilloscope',
                    type: 'trace'
                  })
                }
                className="flex items-center gap-1.5 px-1.5 py-1 rounded-none text-industrial-400 hover:text-industrial-100 hover:bg-industrial-850 cursor-pointer text-xs"
              >
                <Activity className="w-3.5 h-3.5 text-emerald-400" />
                <span>Trace Oscilloscope</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
