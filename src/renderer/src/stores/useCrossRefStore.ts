import { create } from 'zustand'
import { CrossRefQueryResult } from '@shared/types/crossref'
import { CrossReferenceEngine } from '../services/CrossReferenceEngine'
import { useHardwareStore } from './useHardwareStore'
import { useTagStore } from './useTagStore'
import { useBlockStore } from './useBlockStore'

interface CrossRefStoreState {
  activeQuery: string
  queryResult: CrossRefQueryResult | null

  setQuery: (query: string) => void
  reindex: () => void
}

export const useCrossRefStore = create<CrossRefStoreState>((set, get) => ({
  activeQuery: '',
  queryResult: null,

  setQuery: (query: string) => {
    set({ activeQuery: query })
    if (!query) {
      set({ queryResult: null })
      return
    }
    const result = CrossReferenceEngine.query(query)
    set({ queryResult: result })
  },

  reindex: () => {
    const cpuConfig = useHardwareStore.getState().config
    const tagTables = useTagStore.getState().tagTables
    const { udts, dataBlocks, ladBlocks, sclBlocks } = useBlockStore.getState()

    CrossReferenceEngine.rebuildIndex({
      cpuConfig,
      tagTables,
      udts,
      dataBlocks,
      ladBlocks,
      sclBlocks
    })

    // Re-evaluate current active query if one exists
    const currentQuery = get().activeQuery
    if (currentQuery) {
      set({ queryResult: CrossReferenceEngine.query(currentQuery) })
    }
  }
}))
