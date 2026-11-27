import { create } from 'zustand'
import {
  RuntimeMemorySnapshot,
  RuntimeOperatingState,
  RuntimeWorkerMetrics
} from '@shared/types/runtime'
import { PlcRuntimeEngine } from '../runtime/PlcRuntimeEngine'
import { PlcRuntimeWorkerClient } from '../runtime/PlcRuntimeWorkerClient'
import { registerProjectLifecycleHooks, useProjectStore } from './useProjectStore'
import { useHardwareStore } from './useHardwareStore'
import { useTagStore } from './useTagStore'
import { useBlockStore } from './useBlockStore'
import { useUIStore } from './useUIStore'
import { registerWorkerSyncHook } from './projectCoordinator'

interface RuntimeStoreState {
  engine: PlcRuntimeEngine
  runtimeMode: 'worker' | 'main-thread'
  workerEnabled: boolean
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
  setWorkerEnabled: (enabled: boolean) => void
  forceValue: (addressOrSymbol: string, value: unknown, active: boolean) => void
  freezeScan: () => void
  resumeLive: () => void
  scrubToCycle: (cycleNumber: number) => void
  stepCycle: (delta: number) => void
  jumpToLastEdge: (symbolOrAddress: string) => void
  injectFault: (channel?: string) => void
  clearFault: (channel?: string) => void
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

const workerClient = new PlcRuntimeWorkerClient()

export const syncLiveStateToWorker = (): void => {
  if (!workerClient.isRunning()) return
  const blocks = useBlockStore.getState()
  workerClient.post({
    type: 'syncLiveProject',
    tagTables: useTagStore.getState().tagTables,
    ladBlocks: blocks.ladBlocks,
    sclBlocks: blocks.sclBlocks,
    dataBlocks: blocks.dataBlocks,
    udts: blocks.udts,
    hardware: useHardwareStore.getState().config
  })
}

registerWorkerSyncHook(syncLiveStateToWorker)

export const useRuntimeStore = create<RuntimeStoreState>((set, get) => {
  const attachExternalSink = (): void => {
    defaultEngine.setExternalWriteSink((cmd) => {
      if (!workerClient.isRunning()) return
      if (cmd.kind === 'setVariable') {
        workerClient.post({ type: 'setVariable', symbolOrAddress: cmd.symbolOrAddress, value: cmd.value })
      } else if (cmd.kind === 'setBit') {
        workerClient.post({ type: 'setBit', area: cmd.area, byte: cmd.byte, bit: cmd.bit, value: cmd.value })
      } else if (cmd.kind === 'setByte') {
        workerClient.post({ type: 'setByte', area: cmd.area, byte: cmd.byte, value: cmd.value })
      } else if (cmd.kind === 'setWord') {
        workerClient.post({ type: 'setWord', area: cmd.area, byte: cmd.byte, value: cmd.value })
      } else if (cmd.kind === 'setDWord') {
        workerClient.post({ type: 'setDWord', area: cmd.area, byte: cmd.byte, value: cmd.value })
      } else if (cmd.kind === 'setForcedValue') {
        workerClient.post({ type: 'setForcedValue', addressOrSymbol: cmd.addressOrSymbol, value: cmd.value, active: cmd.active })
      } else if (cmd.kind === 'setTraceRecording') {
        workerClient.post({ type: 'setTraceRecording', active: cmd.active })
      } else if (cmd.kind === 'injectHardwareFault') {
        workerClient.post({ type: 'injectFault', channel: cmd.channel })
      } else if (cmd.kind === 'clearHardwareFault') {
        workerClient.post({ type: 'clearFault', channel: cmd.channel })
      }
    })
  }

  workerClient.setOnStateChange((state) => {
    set({ state })
    useProjectStore.getState().setCpuState(state === 'RUN' ? 'RUN' : state === 'ERROR' ? 'ERROR' : 'STOP')
  })

  workerClient.setOnSnapshotBatch((batch) => {
    defaultEngine.ingestWorkerFrame(
      batch.snapshot,
      batch.historyDelta,
      batch.metrics,
      batch.timerStates,
      batch.counterStates,
      batch.dbBytes
    )
    const { timeTravelActive, isMonitoring } = get()
    const liveTagValues = isMonitoring ? batch.liveTagValues : get().liveTagValues
    if (!timeTravelActive) {
      set({ currentSnapshot: batch.snapshot, metrics: batch.metrics, liveTagValues })
    } else {
      set({ metrics: batch.metrics, liveTagValues })
    }
  })

  workerClient.setOnError((message) => {
    console.error('[PLC Runtime Worker] Worker failed:', message)
    workerClient.dispose()
    defaultEngine.setExternalWriteSink(undefined)
    set((s) => ({
      runtimeMode: 'main-thread',
      state: 'ERROR',
      metrics: { ...s.metrics, state: 'ERROR' }
    }))
    useProjectStore.getState().setCpuState('ERROR')
  })

  defaultEngine.setOnStateChange((state) => {
    if (get().runtimeMode === 'worker' && workerClient.isRunning()) return
    set({ state })
    // Also sync to project store CPU badge
    useProjectStore.getState().setCpuState(state === 'RUN' ? 'RUN' : state === 'ERROR' ? 'ERROR' : 'STOP')
  })

  defaultEngine.setOnSnapshot((snapshot, metrics) => {
    if (get().runtimeMode === 'worker' && workerClient.isRunning()) return
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
    runtimeMode: 'main-thread',
    workerEnabled: workerClient.isAvailable(),
    state: 'STOP',
    isMonitoring: false,
    metrics: initialMetrics,
    currentSnapshot: null,
    liveTagValues: {},
    timeTravelActive: false,
    scrubbedSnapshot: null,
    scrubbedIndex: 0,
    forceOverrides: new Map(),

    setWorkerEnabled: (workerEnabled) => {
      if (!workerEnabled && workerClient.isRunning()) {
        workerClient.post({ type: 'stop' })
        workerClient.dispose()
        defaultEngine.setExternalWriteSink(undefined)
        set({ workerEnabled: false, runtimeMode: 'main-thread' })
      } else {
        set({ workerEnabled })
      }
    },

    syncProjectToEngine: () => {
      const { engine, runtimeMode } = get()
      const projectState = useProjectStore.getState()
      const metadata = projectState.metadata
      const hardware = useHardwareStore.getState().config
      const tagTables = useTagStore.getState().tagTables
      const { udts, dataBlocks, ladBlocks, sclBlocks } = useBlockStore.getState()

      if (metadata) {
        const payload = {
          projectPath: projectState.projectPath || metadata.projectPath || '',
          metadata,
          hardware,
          tagTables,
          udts,
          dataBlocks,
          ladBlocks,
          sclBlocks
        }
        engine.loadProject(payload)
        if (runtimeMode === 'worker' && workerClient.isRunning()) {
          workerClient.post({ type: 'loadProject', payload })
        }
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

      if (get().workerEnabled && workerClient.ensureStarted()) {
        attachExternalSink()
        const projectState = useProjectStore.getState()
        const metadata = projectState.metadata!
        const blocks = useBlockStore.getState()
        const payload = {
          projectPath: projectState.projectPath || metadata.projectPath || '',
          metadata,
          hardware: useHardwareStore.getState().config,
          tagTables: useTagStore.getState().tagTables,
          udts: blocks.udts,
          dataBlocks: blocks.dataBlocks,
          ladBlocks: blocks.ladBlocks,
          sclBlocks: blocks.sclBlocks
        }
        get().engine.loadProject(payload)
        workerClient.post({ type: 'loadProject', payload })
        workerClient.post({ type: 'setMonitoring', enabled: get().isMonitoring })
        workerClient.post({ type: 'setTraceRecording', active: get().engine.isTraceRecordingActive() })
        workerClient.post({ type: 'start' })
        set({ runtimeMode: 'worker', state: 'RUN', timeTravelActive: false, scrubbedSnapshot: null })
        useProjectStore.getState().setCpuState('RUN')
        return true
      }

      get().syncProjectToEngine()
      get().engine.start()
      const running = get().engine.getState()
      set({ runtimeMode: 'main-thread', state: running, timeTravelActive: false, scrubbedSnapshot: null })
      useProjectStore.getState().setCpuState(running === 'RUN' ? 'RUN' : running === 'ERROR' ? 'ERROR' : 'STOP')
      return running === 'RUN'
    },

    stop: () => {
      if (get().runtimeMode === 'worker' && workerClient.isRunning()) {
        workerClient.post({ type: 'stop' })
      }
      get().engine.stop()
      set({ state: 'STOP' })
      useProjectStore.getState().setCpuState('STOP')
    },

    reset: () => {
      if (get().runtimeMode === 'worker' && workerClient.isRunning()) {
        workerClient.post({ type: 'reset' })
      }
      get().engine.reset()
      set({
        state: 'STOP',
        timeTravelActive: false,
        scrubbedSnapshot: null,
        scrubbedIndex: 0,
        liveTagValues: {},
        forceOverrides: new Map()
      })
      useProjectStore.getState().setCpuState('STOP')
    },

    toggleMonitoring: () => {
      const next = !get().isMonitoring
      get().engine.setMonitoringEnabled(next)
      if (get().runtimeMode === 'worker' && workerClient.isRunning()) {
        workerClient.post({ type: 'setMonitoring', enabled: next })
      }
      set({
        isMonitoring: next,
        liveTagValues: next ? get().engine.getLiveTagValues() : {}
      })
    },

    setMonitoring: (isMonitoring) => {
      get().engine.setMonitoringEnabled(isMonitoring)
      if (get().runtimeMode === 'worker' && workerClient.isRunning()) {
        workerClient.post({ type: 'setMonitoring', enabled: isMonitoring })
      }
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
      if (get().runtimeMode === 'worker' && workerClient.isRunning()) {
        workerClient.post({ type: 'injectFault', channel })
      } else {
        get().engine.injectHardwareFault(channel)
      }
    },

    clearFault: (channel = '%IW64') => {
      if (get().runtimeMode === 'worker' && workerClient.isRunning()) {
        workerClient.post({ type: 'clearFault', channel })
      } else {
        get().engine.clearHardwareFault(channel)
      }
    }
  }
})

registerProjectLifecycleHooks({
  onBeforeProjectSwitch: () => {
    const rt = useRuntimeStore.getState()
    rt.stop()
    rt.reset()
  },
  onCloseProject: () => {
    const rt = useRuntimeStore.getState()
    rt.stop()
    rt.reset()
  }
})

