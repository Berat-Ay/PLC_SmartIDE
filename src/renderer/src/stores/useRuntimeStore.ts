import { create } from 'zustand'
import {
  RuntimeMemorySnapshot,
  RuntimeOperatingState,
  RuntimeWorkerMetrics
} from '@shared/types/runtime'
import { PlcRuntimeEngine } from '../runtime/PlcRuntimeEngine'
import { useProjectStore } from './useProjectStore'
import { useHardwareStore } from './useHardwareStore'
import { useTagStore } from './useTagStore'
import { useBlockStore } from './useBlockStore'

interface RuntimeStoreState {
  engine: PlcRuntimeEngine
  state: RuntimeOperatingState
  isMonitoring: boolean // [MONITOR ON/OFF]
  metrics: RuntimeWorkerMetrics
  currentSnapshot: RuntimeMemorySnapshot | null
  timeTravelActive: boolean
  scrubbedSnapshot: RuntimeMemorySnapshot | null
  scrubbedIndex: number // -N from live
  forceOverrides: Map<string, unknown>

  // Actions
  start: () => void
  stop: () => void
  reset: () => void
  toggleMonitoring: () => void
  setMonitoring: (monitor: boolean) => void
  forceValue: (addressOrSymbol: string, value: unknown, active: boolean) => void
  freezeScan: () => void
  resumeLive: () => void
  scrubToCycle: (cycleNumber: number) => void
  stepCycle: (delta: number) => void
  jumpToLastEdge: (symbolOrAddress: string) => void
  injectFault: (channel?: string) => void
  syncProjectToEngine: () => void
}

const initialMetrics: RuntimeWorkerMetrics = {
  cycleNumber: 0,
  lastCycleDurationMs: 0,
  averageCycleDurationMs: 0,
  maxCycleDurationMs: 0,
  watchdogLimitMs: 150,
  state: 'STOP',
  activeObs: 'OB1'
}

const defaultEngine = new PlcRuntimeEngine()
defaultEngine.setLiveProjectProvider({
  tagTables: () => useTagStore.getState().tagTables,
  ladBlocks: () => useBlockStore.getState().ladBlocks,
  sclBlocks: () => useBlockStore.getState().sclBlocks,
  dataBlocks: () => useBlockStore.getState().dataBlocks,
  udts: () => useBlockStore.getState().udts
})

export const useRuntimeStore = create<RuntimeStoreState>((set, get) => {
  defaultEngine.setOnStateChange((state) => {
    set({ state })
    // Also sync to project store CPU badge
    useProjectStore.getState().setCpuState(state === 'RUN' ? 'RUN' : state === 'ERROR' ? 'ERROR' : 'STOP')
  })

  defaultEngine.setOnSnapshot((snapshot, metrics) => {
    const { timeTravelActive } = get()
    if (!timeTravelActive) {
      set({ currentSnapshot: snapshot, metrics })
    } else {
      // Keep updating metrics even when scrubbing
      set({ metrics })
    }
  })

  return {
    engine: defaultEngine,
    state: 'STOP',
    isMonitoring: false,
    metrics: initialMetrics,
    currentSnapshot: null,
    timeTravelActive: false,
    scrubbedSnapshot: null,
    scrubbedIndex: 0,
    forceOverrides: new Map(),

    syncProjectToEngine: () => {
      const { engine } = get()
      const metadata = useProjectStore.getState().metadata
      const hardware = useHardwareStore.getState().config
      const tagTables = useTagStore.getState().tagTables
      const { udts, dataBlocks, ladBlocks, sclBlocks } = useBlockStore.getState()

      if (metadata) {
        engine.loadProject({
          projectPath: metadata.projectPath || '',
          metadata,
          hardware,
          tagTables,
          udts,
          dataBlocks,
          ladBlocks,
          sclBlocks
        })
      }
    },

    start: () => {
      if (!useProjectStore.getState().metadata) {
        useProjectStore.getState().loadDemoProject()
      }
      get().syncProjectToEngine()
      get().engine.start()
      set({ state: 'RUN', timeTravelActive: false, scrubbedSnapshot: null })
      useProjectStore.getState().setCpuState('RUN')
    },

    stop: () => {
      get().engine.stop()
      set({ state: 'STOP' })
      useProjectStore.getState().setCpuState('STOP')
    },

    reset: () => {
      get().engine.reset()
      set({ timeTravelActive: false, scrubbedSnapshot: null, scrubbedIndex: 0 })
    },

    toggleMonitoring: () => {
      set((s) => ({ isMonitoring: !s.isMonitoring }))
    },

    setMonitoring: (isMonitoring) => set({ isMonitoring }),

    forceValue: (addressOrSymbol, value, active) => {
      get().engine.setForcedValue(addressOrSymbol, value, active)
      set((s) => {
        const copy = new Map(s.forceOverrides)
        if (active) copy.set(addressOrSymbol, value)
        else copy.delete(addressOrSymbol)
        return { forceOverrides: copy }
      })
    },

    freezeScan: () => {
      const history = get().engine.getHistory()
      if (history.length > 0) {
        const last = history[history.length - 1]
        set({
          timeTravelActive: true,
          scrubbedSnapshot: last,
          scrubbedIndex: history.length - 1
        })
      }
    },

    resumeLive: () => {
      set({ timeTravelActive: false, scrubbedSnapshot: null })
    },

    scrubToCycle: (cycleNumber) => {
      const history = get().engine.getHistory()
      const found = history.find((s) => s.cycleNumber === cycleNumber)
      if (found) {
        const idx = history.indexOf(found)
        set({
          timeTravelActive: true,
          scrubbedSnapshot: found,
          scrubbedIndex: idx
        })
      }
    },

    stepCycle: (delta) => {
      const history = get().engine.getHistory()
      if (history.length === 0) return

      const currentIdx = get().scrubbedIndex
      const nextIdx = Math.max(0, Math.min(history.length - 1, currentIdx + delta))
      set({
        timeTravelActive: true,
        scrubbedSnapshot: history[nextIdx],
        scrubbedIndex: nextIdx
      })
    },

    jumpToLastEdge: (symbolOrAddress) => {
      const history = get().engine.getHistory()
      if (history.length < 2) return

      // Search backwards through ring buffer
      const clean = symbolOrAddress.trim().replace(/"/g, '')

      const evalSnapshotValue = (snap: RuntimeMemorySnapshot): boolean => {
        // Look in DB
        if (clean.includes('.')) {
          const parts = clean.split('.')
          const dbName = parts[0]
          const field = parts[1]
          if (snap.dataBlocks[dbName] && field in snap.dataBlocks[dbName]) {
            return !!snap.dataBlocks[dbName][field]
          }
        }
        // Look in process images
        const parsed = useTagStore.getState().tagTables
        for (const t of parsed) {
          const found = t.tags.find((tag) => tag.name.toLowerCase() === clean.toLowerCase())
          if (found) {
            const addr = found.address.toUpperCase()
            if (addr.startsWith('%I')) {
              const byte = parseInt(addr.slice(2).split('.')[0], 10) || 0
              const bit = parseInt(addr.slice(2).split('.')[1], 10) || 0
              return (snap.pii[byte] & (1 << bit)) !== 0
            }
            if (addr.startsWith('%Q')) {
              const byte = parseInt(addr.slice(2).split('.')[0], 10) || 0
              const bit = parseInt(addr.slice(2).split('.')[1], 10) || 0
              return (snap.piq[byte] & (1 << bit)) !== 0
            }
            if (addr.startsWith('%M')) {
              const byte = parseInt(addr.slice(2).split('.')[0], 10) || 0
              const bit = parseInt(addr.slice(2).split('.')[1], 10) || 0
              return (snap.merker[byte] & (1 << bit)) !== 0
            }
          }
        }
        return false
      }

      for (let i = history.length - 1; i > 0; i--) {
        const vNow = evalSnapshotValue(history[i])
        const vPrev = evalSnapshotValue(history[i - 1])
        if (vNow !== vPrev) {
          // Found transition!
          set({
            timeTravelActive: true,
            scrubbedSnapshot: history[i],
            scrubbedIndex: i
          })
          break
        }
      }
    },

    injectFault: (channel = '%IW64') => {
      get().engine.injectHardwareFault(channel)
    }
  }
})

