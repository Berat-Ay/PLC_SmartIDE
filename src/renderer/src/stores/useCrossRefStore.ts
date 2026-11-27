import { create } from 'zustand'
import { CpuConfig } from '@shared/types/hardware'
import { TagTable } from '@shared/types/tags'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import { UdtDefinition } from '@shared/types/types'
import { CrossRefQueryResult } from '@shared/types/crossref'
import { CrossReferenceEngine } from '../services/CrossReferenceEngine'

export interface CrossRefSources {
  cpuConfig: CpuConfig
  tagTables: TagTable[]
  udts: UdtDefinition[]
  dataBlocks: DataBlockDefinition[]
  ladBlocks: LadBlockDefinition[]
  sclBlocks: SclBlockDefinition[]
}

let sourcesReader: (() => CrossRefSources) | null = null

export function registerCrossRefSources(reader: () => CrossRefSources): void {
  sourcesReader = reader
}

interface CrossRefStoreState {
  activeQuery: string
  queryResult: CrossRefQueryResult | null
  isIndexDirty: boolean

  markIndexDirty: () => void
  setQuery: (query: string) => void
  reindex: () => void
}

export const useCrossRefStore = create<CrossRefStoreState>((set, get) => ({
  activeQuery: '',
  queryResult: null,
  isIndexDirty: false,

  markIndexDirty: () => set({ isIndexDirty: true }),

  setQuery: (query: string) => {
    set({ activeQuery: query })
    if (!query) {
      set({ queryResult: null })
      return
    }
    if (get().isIndexDirty) {
      get().reindex()
    }
    const result = CrossReferenceEngine.query(query)
    set({ queryResult: result })
  },

  reindex: () => {
    if (!sourcesReader) return
    const { cpuConfig, tagTables, udts, dataBlocks, ladBlocks, sclBlocks } = sourcesReader()

    CrossReferenceEngine.rebuildIndex({
      cpuConfig,
      tagTables,
      udts,
      dataBlocks,
      ladBlocks,
      sclBlocks
    })

    const currentQuery = get().activeQuery
    set({
      isIndexDirty: false,
      queryResult: currentQuery ? CrossReferenceEngine.query(currentQuery) : null
    })
  }
}))
