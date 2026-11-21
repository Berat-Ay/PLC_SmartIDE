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
import { useUIStore } from './useUIStore'

interface RuntimeStoreState {
  engine: PlcRuntimeEngine
  state: RuntimeOperatingState
  isMonitoring: boolean // [MONITOR ON/OFF]
  metrics: RuntimeWorkerMetrics
  currentSnapshot: RuntimeMemorySnapshot | null
  liveTagValues: Record<string, unknown>
  timeTravelActive: boolean
  scrubbedSnapshot: RuntimeMemorySnapshot | null
  scrubbedIndex: number // -N from live
  forceOverrides: Map<string, unknown>

  // Actions
  /** Compiles first. Returns false and shows the errors when the program cannot go to RUN. */
  start: () => boolean
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
    const { timeTravelActive, isMonitoring } = get()
    const liveTagValues = isMonitoring ? defaultEngine.getLiveTagValues() : get().liveTagValues
    if (!timeTravelActive) {
      set({ currentSnapshot: snapshot, metrics, liveTagValues })
    } else {
      // Keep updating metrics even when scrubbing
      set({ metrics, liveTagValues })
    }
  })

  return {
    engine: defaultEngine,
    state: 'STOP',
    isMonitoring: false,
    metrics: initialMetrics,
    currentSnapshot: null,
    liveTagValues: {},
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
      const compile = useProjectStore.getState().compileProject()
      if (!compile.canDownload) {
        useUIStore.getState().setBottomActiveTab('compile')
        return false
      }

      get().syncProjectToEngine()
      get().engine.start()
      const running = get().engine.getState()
      set({ state: running, timeTravelActive: false, scrubbedSnapshot: null })
      useProjectStore.getState().setCpuState(running === 'RUN' ? 'RUN' : running === 'ERROR' ? 'ERROR' : 'STOP')
      return running === 'RUN'
    },

    stop: () => {
      get().engine.stop()
      set({ state: 'STOP' })
      useProjectStore.getState().setCpuState('STOP')
    },

    reset: () => {
      get().engine.reset()
      set({ timeTravelActive: false, scrubbedSnapshot: null, scrubbedIndex: 0, liveTagValues: {} })
    },

    toggleMonitoring: () => {
      const next = !get().isMonitoring
      get().engine.setMonitoringEnabled(next)
      set({
        isMonitoring: next,
        liveTagValues: next ? get().engine.getLiveTagValues() : {}
      })
    },

    setMonitoring: (isMonitoring) => {
      get().engine.setMonitoringEnabled(isMonitoring)
      set({
        isMonitoring,
        liveTagValues: isMonitoring ? get().engine.getLiveTagValues() : {}
      })
    },

    forceValue: (addressOrSymbol, value, active) => {
      get().engine.setForcedValue(addressOrSymbol, value, active)
      set((s) => {
        const copy = new Map(s.forceOverrides)
        if (active) copy.set(addressOrSymbol, value)
        else copy.delete(addressOrSymbol)
        return {
          forceOverrides: copy,
          liveTagValues: s.isMonitoring ? s.engine.getLiveTagValues() : s.liveTagValues
        }
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
      const found = get().engine.jumpToLastEdge(symbolOrAddress)
      if (!found) return
      const history = get().engine.getHistory()
      const idx = history.findIndex((s) => s.cycleNumber === found.cycleNumber)
      set({
        timeTravelActive: true,
        scrubbedSnapshot: found,
        scrubbedIndex: idx >= 0 ? idx : Math.max(0, history.length - 1)
      })
    },

    injectFault: (channel = '%IW64') => {
      get().engine.injectHardwareFault(channel)
    }
  }
})

