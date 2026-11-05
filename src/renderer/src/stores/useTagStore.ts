import { create } from 'zustand'
import { TagTable, TagDefinition, TagMemoryCollision } from '@shared/types/tags'
import { DiagnosticMessage } from '@shared/types/diagnostics'
import { MemoryOverlapEngine } from '../services/MemoryOverlapEngine'
import { useHardwareStore } from './useHardwareStore'
import { useCrossRefStore } from './useCrossRefStore'

interface TagStoreState {
  tagTables: TagTable[]
  activeTableId: string | null
  selectedTagId: string | null
  collisions: Map<string, TagMemoryCollision>
  diagnostics: DiagnosticMessage[]
  totalCollisions: number

  setTagTables: (tables: TagTable[]) => void
  setActiveTableId: (id: string | null) => void
  selectTag: (tagId: string | null) => void
  addTag: (tableId: string, initial?: Partial<TagDefinition>) => TagDefinition
  updateTag: (tableId: string, tagId: string, updates: Partial<TagDefinition>) => void
  deleteTag: (tableId: string, tagId: string) => void
  createTagTable: (name: string) => TagTable
  renameTagTable: (tableId: string, newName: string) => void
  deleteTagTable: (tableId: string) => void
  autoAssignSafeAddress: (tagId: string) => void
  resolveAllOverlaps: () => void
  recalculateCollisions: () => void
  getNextSafeAddressForNewTag: (area?: 'I' | 'Q' | 'M', dataType?: string) => string
}

export const useTagStore = create<TagStoreState>((set, get) => ({
  tagTables: [],
  activeTableId: null,
  selectedTagId: null,
  collisions: new Map(),
  diagnostics: [],
  totalCollisions: 0,

  setTagTables: (tagTables) => {
    set({
      tagTables,
      activeTableId: tagTables.length > 0 ? tagTables[0].id : null
    })
    get().recalculateCollisions()
  },

  setActiveTableId: (activeTableId) => set({ activeTableId }),

  selectTag: (selectedTagId) => {
    set({ selectedTagId })
    if (selectedTagId) {
      // Find the tag and query cross-references
      const tables = get().tagTables
      for (const t of tables) {
        const found = t.tags.find((tag) => tag.id === selectedTagId)
        if (found) {
          useCrossRefStore.getState().setQuery(found.name)
          break
        }
      }
    }
  },

  getNextSafeAddressForNewTag: (area = 'M', dataType = 'BOOL') => {
    const { tagTables } = get()
    const cpuConfig = useHardwareStore.getState().config
    return MemoryOverlapEngine.findNextSafeAddress(area, dataType, tagTables, cpuConfig)
  },

  addTag: (tableId, initial) => {
    const { tagTables } = get()
    const cpuConfig = useHardwareStore.getState().config

    const area = (initial?.address?.startsWith('%I') ? 'I' : initial?.address?.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
    const dataType = initial?.dataType || 'BOOL'
    const safeAddr = initial?.address || MemoryOverlapEngine.findNextSafeAddress(area, dataType, tagTables, cpuConfig)

    const newTag: TagDefinition = {
      id: `tag_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name: initial?.name || `Tag_${Math.floor(Math.random() * 900 + 100)}`,
      dataType,
      address: safeAddr,
      comment: initial?.comment || '',
      systemLocked: false
    }

    let found = false
    const updatedTables = tagTables.map((table) => {
      if (table.id === tableId || (!found && tagTables.length === 1)) {
        found = true
        return {
          ...table,
          tags: [...table.tags, newTag]
        }
      }
      return table
    })

    if (!found) {
      updatedTables.push({
        id: tableId || 'table_default',
        name: 'default_tags',
        fileName: 'default_tags.tags.json',
        tags: [newTag]
      })
    }

    set({ tagTables: updatedTables })
    get().recalculateCollisions()
    useCrossRefStore.getState().reindex()
    return newTag
  },

  updateTag: (tableId, tagId, updates) => {
    const { tagTables } = get()
    const updatedTables = tagTables.map((table) => {
      if (table.id === tableId) {
        return {
          ...table,
          tags: table.tags.map((t) => (t.id === tagId ? { ...t, ...updates } : t))
        }
      }
      return table
    })

    set({ tagTables: updatedTables })
    get().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  deleteTag: (tableId, tagId) => {
    const { tagTables } = get()
    const updatedTables = tagTables.map((table) => {
      if (table.id === tableId) {
        return {
          ...table,
          tags: table.tags.filter((t) => t.id !== tagId)
        }
      }
      return table
    })

    set({ tagTables: updatedTables })
    get().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  createTagTable: (name) => {
    const cleanName = name.replace(/\.tags\.json$/i, '')
    const newTable: TagTable = {
      id: `table_${Date.now()}`,
      name: cleanName,
      fileName: `${cleanName}.tags.json`,
      tags: []
    }

    set((state) => ({
      tagTables: [...state.tagTables, newTable],
      activeTableId: newTable.id
    }))

    return newTable
  },

  renameTagTable: (tableId, newName) => {
    const cleanName = newName.replace(/\.tags\.json$/i, '').trim()
    if (!cleanName) return
    set((state) => ({
      tagTables: state.tagTables.map((t) =>
        t.id === tableId ? { ...t, name: cleanName, fileName: `${cleanName}.tags.json` } : t
      )
    }))
  },

  deleteTagTable: (tableId) => {
    set((state) => {
      const remaining = state.tagTables.filter((t) => t.id !== tableId)
      return {
        tagTables: remaining,
        activeTableId: remaining.length > 0 ? remaining[0].id : null
      }
    })
    get().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  autoAssignSafeAddress: (tagId) => {
    const { tagTables } = get()
    const cpuConfig = useHardwareStore.getState().config

    // Find the tag by id or by name (in case a name was passed)
    let targetTableId: string | null = null
    let targetTag: TagDefinition | null = null

    for (const table of tagTables) {
      const tag = table.tags.find((t) => t.id === tagId || t.name.toLowerCase() === tagId.toLowerCase())
      if (tag) {
        targetTableId = table.id
        targetTag = tag
        break
      }
    }

    if (!targetTag || !targetTableId) return

    const area = (targetTag.address.startsWith('%I') ? 'I' : targetTag.address.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
    const safeAddress = MemoryOverlapEngine.findNextSafeAddress(
      area,
      targetTag.dataType,
      tagTables,
      cpuConfig,
      targetTag.id
    )

    get().updateTag(targetTableId, targetTag.id, { address: safeAddress })
  },

  resolveAllOverlaps: () => {
    const { tagTables, collisions } = get()
    const cpuConfig = useHardwareStore.getState().config

    if (collisions.size === 0) return

    let currentTables = [...tagTables]

    // Extract unique colliding tag IDs to avoid duplicates from multiple index entries
    const distinctTagIds = new Set<string>()
    for (const col of collisions.values()) {
      if (col.tagId) distinctTagIds.add(col.tagId)
    }

    // Resolve each colliding tag sequentially to avoid new collisions
    for (const tagId of distinctTagIds) {
      let foundTag: TagDefinition | null = null
      let foundTableId: string | null = null

      for (const table of currentTables) {
        const tag = table.tags.find((t) => t.id === tagId)
        if (tag) {
          foundTag = tag
          foundTableId = table.id
          break
        }
      }

      if (foundTag && foundTableId) {
        const area = (foundTag.address.startsWith('%I') ? 'I' : foundTag.address.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
        const safeAddr = MemoryOverlapEngine.findNextSafeAddress(
          area,
          foundTag.dataType,
          currentTables,
          cpuConfig,
          tagId
        )

        currentTables = currentTables.map((tbl) => {
          if (tbl.id === foundTableId) {
            return {
              ...tbl,
              tags: tbl.tags.map((t) => (t.id === tagId ? { ...t, address: safeAddr } : t))
            }
          }
          return tbl
        })
      }
    }

    set({ tagTables: currentTables })
    get().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  recalculateCollisions: () => {
    const { tagTables } = get()
    const cpuConfig = useHardwareStore.getState().config
    const analysis = MemoryOverlapEngine.analyzeCollisions(tagTables, cpuConfig)

    set({
      collisions: analysis.collisions,
      diagnostics: analysis.diagnostics,
      totalCollisions: analysis.totalCollisionCount
    })
  }
}))
