import { create } from 'zustand'
import {
  DataBlockDefinition,
  LadBlockDefinition,
  SclBlockDefinition,
  BlockVariable,
  LadNetwork
} from '@shared/types/blocks'
import { UdtDefinition, UdtMember } from '@shared/types/types'
import { S7OffsetCalculator } from '../services/S7OffsetCalculator'
import { useCrossRefStore } from './useCrossRefStore'

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
    set({ dataBlocks, ladBlocks, sclBlocks, udts })
  },

  // DB operations
  addDataBlock: (db) => {
    set((state) => ({ dataBlocks: [...state.dataBlocks, db] }))
    useCrossRefStore.getState().reindex()
  },

  updateDataBlock: (fileName, updates) => {
    set((state) => ({
      dataBlocks: state.dataBlocks.map((db) => (db.fileName === fileName ? { ...db, ...updates } : db))
    }))
    useCrossRefStore.getState().reindex()
  },

  deleteDataBlock: (fileName) => {
    set((state) => ({
      dataBlocks: state.dataBlocks.filter((db) => db.fileName !== fileName)
    }))
    useCrossRefStore.getState().reindex()
  },

  toggleDbOptimizedAccess: (fileName) => {
    const { dataBlocks, udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const newOptimized = !db.optimizedAccess
        let updatedVariables = db.variables
        if (!newOptimized) {
          // Calculate standard S7 byte.bit offsets
          updatedVariables = S7OffsetCalculator.calculateVariableOffsets(db.variables, udtMap)
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
    const { dataBlocks, udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

    const newVar: BlockVariable = {
      id: `v_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
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
          : S7OffsetCalculator.calculateVariableOffsets(rawVars, udtMap)
        return { ...db, variables }
      })
    })

    useCrossRefStore.getState().reindex()
  },

  updateDbVariable: (fileName, varId, updates) => {
    const { dataBlocks, udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const rawVars = db.variables.map((v) => (v.id === varId ? { ...v, ...updates } : v))
        const variables = db.optimizedAccess
          ? rawVars
          : S7OffsetCalculator.calculateVariableOffsets(rawVars, udtMap)
        return { ...db, variables }
      })
    })

    useCrossRefStore.getState().reindex()
  },

  deleteDbVariable: (fileName, varId) => {
    const { dataBlocks, udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

    set({
      dataBlocks: dataBlocks.map((db) => {
        if (db.fileName !== fileName) return db
        const rawVars = db.variables.filter((v) => v.id !== varId)
        const variables = db.optimizedAccess
          ? rawVars
          : S7OffsetCalculator.calculateVariableOffsets(rawVars, udtMap)
        return { ...db, variables }
      })
    })

    useCrossRefStore.getState().reindex()
  },

  // UDT operations
  addUdt: (udt) => {
    set((state) => ({ udts: [...state.udts, udt] }))
    useCrossRefStore.getState().reindex()
  },

  updateUdt: (id, updates) => {
    set((state) => ({
      udts: state.udts.map((u) => (u.id === id ? { ...u, ...updates } : u))
    }))
    useCrossRefStore.getState().reindex()
  },

  deleteUdt: (id) => {
    set((state) => ({
      udts: state.udts.filter((u) => u.id !== id)
    }))
    useCrossRefStore.getState().reindex()
  },

  addUdtMember: (udtId, initial) => {
    const { udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

    const newMember: UdtMember = {
      id: `m_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
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
        const calculated = S7OffsetCalculator.calculateVariableOffsets(tempVars, udtMap)
        const updatedMembers = members.map((m, idx) => ({
          ...m,
          calculatedOffset: calculated[idx]?.calculatedOffset
        }))
        return {
          ...u,
          members: updatedMembers,
          calculatedSizeInBytes: S7OffsetCalculator.calculateUdtSize({ ...u, members: updatedMembers }, udtMap)
        }
      })
    })

    useCrossRefStore.getState().reindex()
  },

  updateUdtMember: (udtId, memberId, updates) => {
    const { udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

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
        const calculated = S7OffsetCalculator.calculateVariableOffsets(tempVars, udtMap)
        const updatedMembers = members.map((m, idx) => ({
          ...m,
          calculatedOffset: calculated[idx]?.calculatedOffset
        }))
        return {
          ...u,
          members: updatedMembers,
          calculatedSizeInBytes: S7OffsetCalculator.calculateUdtSize({ ...u, members: updatedMembers }, udtMap)
        }
      })
    })

    useCrossRefStore.getState().reindex()
  },

  deleteUdtMember: (udtId, memberId) => {
    const { udts } = get()
    const udtMap = new Map(udts.map((u) => [u.name, u]))

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
        const calculated = S7OffsetCalculator.calculateVariableOffsets(tempVars, udtMap)
        const updatedMembers = members.map((m, idx) => ({
          ...m,
          calculatedOffset: calculated[idx]?.calculatedOffset
        }))
        return {
          ...u,
          members: updatedMembers,
          calculatedSizeInBytes: S7OffsetCalculator.calculateUdtSize({ ...u, members: updatedMembers }, udtMap)
        }
      })
    })

    useCrossRefStore.getState().reindex()
  },

  // Code Block operations
  addLadBlock: (block) => {
    set((state) => ({ ladBlocks: [...state.ladBlocks, block] }))
    useCrossRefStore.getState().reindex()
  },

  updateLadBlock: (fileName, updates) => {
    set((state) => ({
      ladBlocks: state.ladBlocks.map((b) => (b.fileName === fileName ? { ...b, ...updates } : b))
    }))
    useCrossRefStore.getState().reindex()
  },

  deleteLadBlock: (fileName) => {
    set((state) => ({
      ladBlocks: state.ladBlocks.filter((b) => b.fileName !== fileName)
    }))
    useCrossRefStore.getState().reindex()
  },

  addSclBlock: (block) => {
    set((state) => ({ sclBlocks: [...state.sclBlocks, block] }))
    useCrossRefStore.getState().reindex()
  },

  updateSclBlock: (fileName, updates) => {
    set((state) => ({
      sclBlocks: state.sclBlocks.map((b) => (b.fileName === fileName ? { ...b, ...updates } : b))
    }))
    useCrossRefStore.getState().reindex()
  },

  deleteSclBlock: (fileName) => {
    set((state) => ({
      sclBlocks: state.sclBlocks.filter((b) => b.fileName !== fileName)
    }))
    useCrossRefStore.getState().reindex()
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
      sclBlocks: state.sclBlocks.map(updateBlock)
    }))
    useCrossRefStore.getState().reindex()
  },

  addBlockInterfaceVariable: (fileName, section, initial) => {
    const newVar: BlockVariable = {
      id: `v_if_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
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
      sclBlocks: state.sclBlocks.map(addVar)
    }))
    useCrossRefStore.getState().reindex()
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
      sclBlocks: state.sclBlocks.map(removeVar)
    }))
    useCrossRefStore.getState().reindex()
  }
}))
