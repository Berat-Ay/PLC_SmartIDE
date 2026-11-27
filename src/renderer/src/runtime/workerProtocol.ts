import type { ProjectLoadPayload } from '@shared/types/ipc'
import type { CpuConfig } from '@shared/types/hardware'
import type {
  RuntimeMemorySnapshot,
  RuntimeOperatingState,
  RuntimeWorkerMetrics
} from '@shared/types/runtime'
import type { TagTable } from '@shared/types/tags'
import type {
  DataBlockDefinition,
  LadBlockDefinition,
  SclBlockDefinition
} from '@shared/types/blocks'
import type { UdtDefinition } from '@shared/types/types'
import { PlcRuntimeEngine } from './PlcRuntimeEngine'

export type MainToWorkerMessage =
  | { type: 'loadProject'; payload: ProjectLoadPayload }
  | {
      type: 'syncLiveProject'
      tagTables: TagTable[]
      ladBlocks: LadBlockDefinition[]
      sclBlocks: SclBlockDefinition[]
      dataBlocks: DataBlockDefinition[]
      udts: UdtDefinition[]
      hardware?: CpuConfig
    }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'setMonitoring'; enabled: boolean }
  | { type: 'setTraceRecording'; active: boolean }
  | { type: 'setVariable'; symbolOrAddress: string; value: unknown }
  | { type: 'setBit'; area: 'I' | 'Q' | 'M'; byte: number; bit: number; value: boolean }
  | { type: 'setByte'; area: 'I' | 'Q' | 'M'; byte: number; value: number }
  | { type: 'setWord'; area: 'I' | 'Q' | 'M'; byte: number; value: number }
  | { type: 'setDWord'; area: 'I' | 'Q' | 'M'; byte: number; value: number }
  | { type: 'setForcedValue'; addressOrSymbol: string; value: unknown; active: boolean }
  | { type: 'injectFault'; channel?: string }
  | { type: 'clearFault'; channel?: string }

export type WorkerToMainMessage =
  | { type: 'stateChange'; state: RuntimeOperatingState }
  | {
      type: 'snapshotBatch'
      snapshot: RuntimeMemorySnapshot
      historyDelta: RuntimeMemorySnapshot[]
      metrics: RuntimeWorkerMetrics
      liveTagValues: Record<string, unknown>
      timerStates: Record<string, { IN: boolean; Q: boolean; PT: number; ET: number }>
      counterStates: Record<
        string,
        { CU: boolean; CD: boolean; R: boolean; PV: number; QU: boolean; QD: boolean; CV: number }
      >
      dbBytes?: Record<number, Uint8Array>
    }
  | { type: 'error'; message: string }

export interface WorkerPortLike {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror?: ((event: unknown) => void) | null
  terminate?: () => void
}

/**
 * Binds a dedicated PlcRuntimeEngine instance to a Web Worker (or in-memory test port)
 * so cyclic 10ms scans execute off the UI thread while preserving full 100 Hz trace deltas.
 */
export function attachRuntimeWorkerHost(port: {
  postMessage: (msg: WorkerToMainMessage) => void
  onmessage: ((event: { data: MainToWorkerMessage }) => void) | null
}): PlcRuntimeEngine {
  const engine = new PlcRuntimeEngine()
  let liveSnapshot = {
    tagTables: [] as TagTable[],
    ladBlocks: [] as LadBlockDefinition[],
    sclBlocks: [] as SclBlockDefinition[],
    dataBlocks: [] as DataBlockDefinition[],
    udts: [] as UdtDefinition[]
  }
  let hasLiveSnapshot = false
  let lastSentCycle = 0

  engine.setLiveProjectProvider({
    tagTables: () => (hasLiveSnapshot ? liveSnapshot.tagTables : []),
    ladBlocks: () => (hasLiveSnapshot ? liveSnapshot.ladBlocks : []),
    sclBlocks: () => (hasLiveSnapshot ? liveSnapshot.sclBlocks : []),
    dataBlocks: () => (hasLiveSnapshot ? liveSnapshot.dataBlocks : []),
    udts: () => (hasLiveSnapshot ? liveSnapshot.udts : [])
  })

  engine.setOnStateChange((state) => {
    port.postMessage({ type: 'stateChange', state })
  })

  engine.setOnSnapshot((snapshot, metrics) => {
    if (snapshot.cycleNumber < lastSentCycle) {
      lastSentCycle = 0
    }
    const historyDelta = engine.getHistorySince(lastSentCycle)
    lastSentCycle = snapshot.cycleNumber
    port.postMessage({
      type: 'snapshotBatch',
      snapshot,
      historyDelta: historyDelta.length > 0 ? historyDelta : [snapshot],
      metrics,
      liveTagValues: engine.isMonitoringEnabled() ? engine.getLiveTagValues() : {},
      timerStates: { ...engine.timerStates },
      counterStates: { ...engine.counterStates },
      dbBytes: engine.exportDbBytes()
    })
  })

  port.onmessage = (event) => {
    const msg = event.data
    try {
      switch (msg.type) {
        case 'loadProject':
          hasLiveSnapshot = true
          liveSnapshot = {
            tagTables: msg.payload.tagTables || [],
            ladBlocks: msg.payload.ladBlocks || [],
            sclBlocks: msg.payload.sclBlocks || [],
            dataBlocks: msg.payload.dataBlocks || [],
            udts: msg.payload.udts || []
          }
          lastSentCycle = 0
          engine.loadProject(msg.payload)
          break
        case 'syncLiveProject':
          hasLiveSnapshot = true
          liveSnapshot = {
            tagTables: msg.tagTables,
            ladBlocks: msg.ladBlocks,
            sclBlocks: msg.sclBlocks,
            dataBlocks: msg.dataBlocks,
            udts: msg.udts
          }
          engine.refreshLiveProjectState(msg.hardware)
          break
        case 'start':
          engine.start()
          break
        case 'stop':
          engine.stop()
          break
        case 'reset':
          lastSentCycle = 0
          engine.reset()
          break
        case 'setMonitoring':
          engine.setMonitoringEnabled(msg.enabled)
          break
        case 'setTraceRecording':
          engine.setTraceRecordingActive(msg.active)
          break
        case 'setVariable':
          engine.setVariable(msg.symbolOrAddress, msg.value)
          break
        case 'setBit':
          engine.setBit(msg.area, msg.byte, msg.bit, msg.value)
          break
        case 'setByte':
          engine.setByte(msg.area, msg.byte, msg.value)
          break
        case 'setWord':
          engine.setWord(msg.area, msg.byte, msg.value)
          break
        case 'setDWord':
          engine.setDWord(msg.area, msg.byte, msg.value)
          break
        case 'setForcedValue':
          engine.setForcedValue(msg.addressOrSymbol, msg.value, msg.active)
          break
        case 'injectFault':
          engine.injectHardwareFault(msg.channel)
          break
        case 'clearFault':
          engine.clearHardwareFault(msg.channel)
          break
      }
    } catch (err) {
      port.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return engine
}
