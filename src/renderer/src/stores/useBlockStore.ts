import { create } from 'zustand'
import { effectiveInterface, emptyInterface, mergeInterfaces, parseSourceBlock, renameSourceBlockHeader, rewriteSourceInterface } from '@shared/scl/sourceBlock'
import { LayoutVariable } from '@shared/s7/typeLayout'
import {
  DataBlockDefinition,
  LadBlockDefinition,
  SclBlockDefinition,
  BlockVariable
} from '@shared/types/blocks'
import { UdtDefinition, UdtMember } from '@shared/types/types'
import { FbVariableLookup, S7OffsetCalculator } from '../services/S7OffsetCalculator'
import { generateId } from '../utils/id'

function createFbLookup(ladBlocks: LadBlockDefinition[], sclBlocks: SclBlockDefinition[]): FbVariableLookup {
  return (name: string) => {
    const lower = name.toLowerCase()
    const ladFb = ladBlocks.find((b) => b.blockType === 'FB' && b.name.toLowerCase() === lower)
    if (ladFb) {
      const iface = ladFb.interface
      return [...iface.input, ...iface.output, ...iface.inOut, ...iface.static] as LayoutVariable[]
    }
    const sclFb = sclBlocks.find((b) => b.blockType === 'FB' && b.name.toLowerCase() === lower)
    if (sclFb) {
      const iface = effectiveInterface(sclFb)
      return [...iface.input, ...iface.output, ...iface.inOut, ...iface.static] as LayoutVariable[]
    }
    return undefined
  }
}

/** A block's source text is the authority on its interface when the source has a header. */
function normalizeSclBlock(block: SclBlockDefinition): SclBlockDefinition {
  if (!parseSourceBlock(block.code || '').hasHeader) {
    return { ...block, interface: { ...emptyInterface(), ...(block.interface || {}) } }
  }
  return { ...block, interface: mergeInterfaces(effectiveInterface(block), block.interface) }
}

/** After the interface table changed: writes the declarations back into the source. */
function syncInterfaceToSource<T extends LadBlockDefinition | SclBlockDefinition>(block: T): T {
  if (!('code' in block) || !parseSourceBlock(block.code || '').hasHeader) return block
  return { ...block, code: rewriteSourceInterface(block, block.interface) }
}

interface BlockStoreState {
  dataBlocks: DataBlockDefinition[]
  ladBlocks: LadBlockDefinition[]
  sclBlocks: SclBlockDefinition[]
  udts: UdtDefinition[]

  setBlocks: (payload: {
    dataBlocks: DataBlockDefinition[]
    ladBlocks: LadBlockDefinition[]
    sclBlocks: SclBlockDefinition[]
    udts: UdtDefinition[]
  }) => void

  // DB operations
  addDataBlock: (db: DataBlockDefinition) => void
  updateDataBlock: (fileName: string, updates: Partial<DataBlockDefinition>) => void
  deleteDataBlock: (fileName: string) => void
  toggleDbOptimizedAccess: (fileName: string) => void
  addDbVariable: (fileName: string, initial?: Partial<BlockVariable>) => void
  updateDbVariable: (fileName: string, varId: string, updates: Partial<BlockVariable>) => void
  deleteDbVariable: (fileName: string, varId: string) => void

  // UDT operations
  addUdt: (udt: UdtDefinition) => void
  updateUdt: (id: string, updates: Partial<UdtDefinition>) => void
  deleteUdt: (id: string) => void
  addUdtMember: (udtId: string, initial?: Partial<UdtMember>) => void
  updateUdtMember: (udtId: string, memberId: string, updates: Partial<UdtMember>) => void
  deleteUdtMember: (udtId: string, memberId: string) => void

  // Code Block operations
  addLadBlock: (block: LadBlockDefinition) => void
  updateLadBlock: (fileName: string, updates: Partial<LadBlockDefinition>) => void
  deleteLadBlock: (fileName: string) => void
  addSclBlock: (block: SclBlockDefinition) => void
  updateSclBlock: (fileName: string, updates: Partial<SclBlockDefinition>) => void
  deleteSclBlock: (fileName: string) => void

  // Interface strip variable operations for code blocks (OB, FB, FC)
  updateBlockInterfaceVariable: (
    fileName: string,
    section: 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'constant',
    varId: string,
    updates: Partial<BlockVariable>
  ) => void
  addBlockInterfaceVariable: (
    fileName: string,
    section: 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'constant',
    initial?: Partial<BlockVariable>
  ) => void
  removeBlockInterfaceVariable: (
    fileName: string,
    section: 'input' | 'output' | 'inOut' | 'static' | 'temp' | 'constant',
    varId: string
  ) => void
}

export const useBlockStore = create<BlockStoreState>((set, get) => ({
  dataBlocks: [],
  ladBlocks: [],
  sclBlocks: [],
  udts: [],

  setBlocks: ({ dataBlocks, ladBlocks, sclBlocks, udts }) => {
    set({ dataBlocks, ladBlocks, sclBlocks: sclBlocks.map(normalizeSclBlock), udts })
  },

  // DB operations
  addDataBlock: (db) => {
    set((state) => ({ dataBlocks: [...state.dataBlocks, db] }))
  },

  updateDataBlock: (fileName, updates) => {
    set((state) => ({
      dataBlocks: state.dataBlocks.map((db) => (db.fileName === fileName ? { ...db, ...updates } : db))
    }))
  },

  deleteDataBlock: (fileName) => {
    set((state) => ({
      dataBlocks: state.dataBlocks.filter((db) => db.fileName !== fileName)
    }))
  },

  toggleDbOptimizedAccess: (fileName) => {
    const { dataBlocks, udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const newOptimized = !db.optimizedAccess
        let updatedVariables = db.variables
        if (!newOptimized) {
          // Calculate standard S7 byte.bit offsets
          updatedVariables = S7OffsetCalculator.calculateVariableOffsets(db.variables, udtMap, fbLookup)
        }
        return {
          ...db,
          optimizedAccess: newOptimized,
          variables: updatedVariables
        }
      })
    })
  },

  addDbVariable: (fileName, initial) => {
    const { dataBlocks, udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    const newVar: BlockVariable = {
      id: generateId('v'),
      name: initial?.name || `Var_${Math.floor(Math.random() * 900 + 100)}`,
      dataType: initial?.dataType || 'BOOL',
      defaultValue: initial?.defaultValue || '',
      retain: initial?.retain ?? false,
      accessibleFromHMI: initial?.accessibleFromHMI ?? true,
      comment: initial?.comment || ''
    }

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const rawVars = [...db.variables, newVar]
        const variables = db.optimizedAccess
          ? rawVars
          : S7OffsetCalculator.calculateVariableOffsets(rawVars, udtMap, fbLookup)
        return { ...db, variables }
      })
    })
  },

  updateDbVariable: (fileName, varId, updates) => {
    const { dataBlocks, udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const rawVars = db.variables.map((v) => (v.id === varId ? { ...v, ...updates } : v))
        const variables = db.optimizedAccess
          ? rawVars
          : S7OffsetCalculator.calculateVariableOffsets(rawVars, udtMap, fbLookup)
        return { ...db, variables }
      })
    })
  },

  deleteDbVariable: (fileName, varId) => {
    const { dataBlocks, udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const rawVars = db.variables.filter((v) => v.id !== varId)
        const variables = db.optimizedAccess
          ? rawVars
          : S7OffsetCalculator.calculateVariableOffsets(rawVars, udtMap, fbLookup)
        return { ...db, variables }
      })
    })
  },

  // UDT operations
  addUdt: (udt) => {
    set((state) => ({ udts: [...state.udts, udt] }))
  },

  updateUdt: (id, updates) => {
    set((state) => ({
      udts: state.udts.map((u) => (u.id === id ? { ...u, ...updates } : u))
    }))
  },

  deleteUdt: (id) => {
    set((state) => ({
      udts: state.udts.filter((u) => u.id !== id)
    }))
  },

  addUdtMember: (udtId, initial) => {
    const { udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    const newMember: UdtMember = {
      id: generateId('m'),
      name: initial?.name || `Member_${Math.floor(Math.random() * 900 + 100)}`,
      dataType: initial?.dataType || 'BOOL',
      defaultValue: initial?.defaultValue || '',
      comment: initial?.comment || ''
    }

    set({
      udts: udts.map((u) => {
        if (u.id !== udtId) return u
        const members = [...u.members, newMember]
        const tempVars = members.map((m) => ({
          id: m.id,
          name: m.name,
          dataType: m.dataType,
          retain: false,
          accessibleFromHMI: true
        }))
        const calculated = S7OffsetCalculator.calculateVariableOffsets(tempVars, udtMap, fbLookup)
        const updatedMembers = members.map((m, idx) => ({
          ...m,
          calculatedOffset: calculated[idx]?.calculatedOffset
        }))
        return {
          ...u,
          members: updatedMembers,
          calculatedSizeInBytes: S7OffsetCalculator.calculateUdtSize({ ...u, members: updatedMembers }, udtMap, fbLookup)
        }
      })
    })
  },

  updateUdtMember: (udtId, memberId, updates) => {
    const { udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    set({
      udts: udts.map((u) => {
        if (u.id !== udtId) return u
        const members = u.members.map((m) => (m.id === memberId ? { ...m, ...updates } : m))
        const tempVars = members.map((m) => ({
          id: m.id,
          name: m.name,
          dataType: m.dataType,
          retain: false,
          accessibleFromHMI: true
        }))
        const calculated = S7OffsetCalculator.calculateVariableOffsets(tempVars, udtMap, fbLookup)
        const updatedMembers = members.map((m, idx) => ({
          ...m,
          calculatedOffset: calculated[idx]?.calculatedOffset
        }))
        return {
          ...u,
          members: updatedMembers,
          calculatedSizeInBytes: S7OffsetCalculator.calculateUdtSize({ ...u, members: updatedMembers }, udtMap, fbLookup)
        }
      })
    })
  },

  deleteUdtMember: (udtId, memberId) => {
    const { udts, ladBlocks, sclBlocks } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))
    const fbLookup = createFbLookup(ladBlocks, sclBlocks)

    set({
      udts: udts.map((u) => {
        if (u.id !== udtId) return u
        const members = u.members.filter((m) => m.id !== memberId)
        const tempVars = members.map((m) => ({
          id: m.id,
          name: m.name,
          dataType: m.dataType,
          retain: false,
          accessibleFromHMI: true
        }))
        const calculated = S7OffsetCalculator.calculateVariableOffsets(tempVars, udtMap, fbLookup)
        const updatedMembers = members.map((m, idx) => ({
          ...m,
          calculatedOffset: calculated[idx]?.calculatedOffset
        }))
        return {
          ...u,
          members: updatedMembers,
          calculatedSizeInBytes: S7OffsetCalculator.calculateUdtSize({ ...u, members: updatedMembers }, udtMap, fbLookup)
        }
      })
    })
  },

  // Code Block operations
  addLadBlock: (block) => {
    set((state) => ({ ladBlocks: [...state.ladBlocks, block] }))
  },

  updateLadBlock: (fileName, updates) => {
    set((state) => ({
      ladBlocks: state.ladBlocks.map((b) => (b.fileName === fileName ? { ...b, ...updates } : b))
    }))
  },

  deleteLadBlock: (fileName) => {
    set((state) => ({
      ladBlocks: state.ladBlocks.filter((b) => b.fileName !== fileName)
    }))
  },

  addSclBlock: (block) => {
    set((state) => ({ sclBlocks: [...state.sclBlocks, normalizeSclBlock(block)] }))
  },

  updateSclBlock: (fileName, updates) => {
    set((state) => ({
      sclBlocks: state.sclBlocks.map((b) => {
        if (b.fileName !== fileName) return b
        const nextCode =
          updates.name && updates.name !== b.name && updates.code === undefined
            ? renameSourceBlockHeader(b.code, updates.name)
            : updates.code ?? b.code
        return normalizeSclBlock({ ...b, ...updates, code: nextCode })
      })
    }))
  },

  deleteSclBlock: (fileName) => {
    set((state) => ({
      sclBlocks: state.sclBlocks.filter((b) => b.fileName !== fileName)
    }))
  },

  // Interface variable operations
  updateBlockInterfaceVariable: (fileName, section, varId, updates) => {
    const updateBlock = <T extends LadBlockDefinition | SclBlockDefinition>(b: T): T => {
      if (b.fileName !== fileName) return b
      const list = b.interface[section] || []
      const updatedList = list.map((v) => (v.id === varId ? { ...v, ...updates } : v))
      return {
        ...b,
        interface: {
          ...b.interface,
          [section]: updatedList
        }
      }
    }

    set((state) => ({
      ladBlocks: state.ladBlocks.map(updateBlock),
      sclBlocks: state.sclBlocks.map((b) => (b.fileName === fileName ? syncInterfaceToSource(updateBlock(b)) : b))
    }))
  },

  addBlockInterfaceVariable: (fileName, section, initial) => {
    const newVar: BlockVariable = {
      id: generateId('v_if'),
      name: initial?.name || `Var_${Math.floor(Math.random() * 900 + 100)}`,
      dataType: initial?.dataType || 'BOOL',
      defaultValue: initial?.defaultValue || '',
      retain: initial?.retain ?? false,
      accessibleFromHMI: initial?.accessibleFromHMI ?? true,
      comment: initial?.comment || ''
    }

    const addVar = <T extends LadBlockDefinition | SclBlockDefinition>(b: T): T => {
      if (b.fileName !== fileName) return b
      const list = b.interface[section] || []
      return {
        ...b,
        interface: {
          ...b.interface,
          [section]: [...list, newVar]
        }
      }
    }

    set((state) => ({
      ladBlocks: state.ladBlocks.map(addVar),
      sclBlocks: state.sclBlocks.map((b) => (b.fileName === fileName ? syncInterfaceToSource(addVar(b)) : b))
    }))
  },

  removeBlockInterfaceVariable: (fileName, section, varId) => {
    const removeVar = <T extends LadBlockDefinition | SclBlockDefinition>(b: T): T => {
      if (b.fileName !== fileName) return b
      const list = b.interface[section] || []
      return {
        ...b,
        interface: {
          ...b.interface,
          [section]: list.filter((v) => v.id !== varId)
        }
      }
    }

    set((state) => ({
      ladBlocks: state.ladBlocks.map(removeVar),
      sclBlocks: state.sclBlocks.map((b) => (b.fileName === fileName ? syncInterfaceToSource(removeVar(b)) : b))
    }))
  }
}))
