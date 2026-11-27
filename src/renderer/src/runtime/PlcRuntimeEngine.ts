import {
  RuntimeMemorySnapshot,
  RuntimeOperatingState,
  RuntimeWorkerMetrics
} from '@shared/types/runtime'
import { parseS7Address } from '@shared/constants/s7rules'
import { getCpuProfile } from '@shared/constants/cpuProfiles'
import {
  applyStartValues,
  buildLayout,
  BuiltinInstanceKind,
  builtinInstanceKind,
  LayoutVariable,
  readValue,
  reinitNonRetain,
  resolvePath,
  ResolvedLocation,
  S7Type,
  splitPath,
  StructType,
  writeValue
} from '@shared/s7/typeLayout'
import { effectiveInterface, emptyInterface, parseSourceBlock } from '@shared/scl/sourceBlock'
import { SclBlockCall, SclExecutionContext, SclInterpreter } from './SclInterpreter'
import { LadderEvaluator } from './LadderEvaluator'
import { S7BinaryMemory, S7ResolvedAddress } from './S7BinaryMemory'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { CpuConfig } from '@shared/types/hardware'
import { TagTable, TagDefinition } from '@shared/types/tags'
import { UdtDefinition } from '@shared/types/types'
import { BlockInterface, LadBlockDefinition, SclBlockDefinition, DataBlockDefinition } from '@shared/types/blocks'
import { SnapshotHistory } from './engine/SnapshotHistory'
import { DbEntry, DbRegistry } from './engine/DbRegistry'
import { BuiltinInstanceManager, CounterStateRecord, TimerStateRecord } from './engine/BuiltinInstanceManager'
import { SymbolForceTable } from './engine/SymbolForceTable'

/** Live editor state. The engine reads it so online edits take effect, without importing any store. */
export interface LiveProjectProvider {
  tagTables: () => TagTable[]
  ladBlocks: () => LadBlockDefinition[]
  sclBlocks: () => SclBlockDefinition[]
  dataBlocks: () => DataBlockDefinition[]
  udts: () => UdtDefinition[]
}

export interface RuntimeDiagnostic {
  timestamp: number
  cycleNumber: number
  severity: 'info' | 'warning' | 'error'
  message: string
}

export type ExternalRuntimeWriteCmd =
  | { kind: 'setVariable'; symbolOrAddress: string; value: unknown }
  | { kind: 'setBit'; area: 'I' | 'Q' | 'M'; byte: number; bit: number; value: boolean }
  | { kind: 'setByte'; area: 'I' | 'Q' | 'M'; byte: number; value: number }
  | { kind: 'setWord'; area: 'I' | 'Q' | 'M'; byte: number; value: number }
  | { kind: 'setDWord'; area: 'I' | 'Q' | 'M'; byte: number; value: number }
  | { kind: 'setForcedValue'; addressOrSymbol: string; value: unknown; active: boolean }
  | { kind: 'setTraceRecording'; active: boolean }
  | { kind: 'injectHardwareFault'; channel: string }
  | { kind: 'clearHardwareFault'; channel: string }

type CodeBlock = LadBlockDefinition | SclBlockDefinition

interface Scope {
  bytes: Uint8Array
  view: DataView
  base: number
  layout: StructType
  path: string
  readonly?: boolean
}

interface Frame {
  blockName: string
  scopes: Scope[]
  returnName?: string
}

interface BlockInfo {
  iface: BlockInterface
  returnType?: string
  instanceLayout: StructType
  temp: StructType
  args: StructType
  constant?: Scope
}

type Callee =
  | { kind: 'builtin'; builtin: BuiltinInstanceKind; key: string }
  | { kind: 'fb'; block: CodeBlock; scope: Scope }
  | { kind: 'fc'; block: CodeBlock }

const MAX_DIAGNOSTICS = 200
const DEFAULT_INTERRUPT_MS = 100
const TIMER_FIELD = /^(.+)\.(Q|ET|IN|PT|QU|QD|CV|PV|CU|CD|R|LD|CLK)$/i

export class PlcRuntimeEngine {
  private state: RuntimeOperatingState = 'STOP'
  private cycleNumber = 0
  private lastCycleDurationMs = 0
  private averageCycleDurationMs = 0
  private maxCycleDurationMs = 0
  private activeObs = 'OB1'
  private intervalHandle: NodeJS.Timeout | null = null
  private interruptHandles: NodeJS.Timeout[] = []
  private firstScanPending = false
  private lastScanWallClock = 0
  private clock: () => number = () => Date.now()

  // Single-Source-of-Truth Binary S7 Memory Manager
  public readonly memory: S7BinaryMemory = new S7BinaryMemory()

  public get pii(): Uint8Array {
    return this.memory.pii
  }

  public get piq(): Uint8Array {
    return this.memory.piq
  }

  public get merker(): Uint8Array {
    return this.memory.merker
  }

  // Extracted Subsystems
  private readonly dbRegistry: DbRegistry = new DbRegistry({
    memory: this.memory,
    getLiveDataBlocks: () => this.getLiveDataBlocks(),
    getLiveUdts: () => this.getLiveUdts(),
    findBlock: (name) => this.findBlock(name),
    interfaceOf: (block) => this.interfaceOf(block),
    instanceVariables: (iface) => this.instanceVariables(iface),
    reportOnce: (msg, sev) => this.reportOnce(msg, sev)
  })
  private get dbEntries(): Map<string, DbEntry> {
    return this.dbRegistry.entries
  }

  private readonly builtins: BuiltinInstanceManager = new BuiltinInstanceManager({
    memory: this.memory,
    clock: () => this.clock(),
    getDbEntries: () => this.dbRegistry.values(),
    getLiveLadBlocks: () => this.getLiveLadBlocks(),
    getLiveSclBlocks: () => this.getLiveSclBlocks(),
    interfaceOf: (block) => this.interfaceOf(block)
  })

  private readonly forceTable: SymbolForceTable = new SymbolForceTable(this.memory)
  public get forceOverrides(): Map<string, unknown> {
    return this.forceTable.map
  }

  public get timerStates(): TimerStateRecord {
    return this.builtins.timerStates
  }
  public set timerStates(val: TimerStateRecord) {
    this.builtins.timerStates = val
  }

  public get counterStates(): CounterStateRecord {
    return this.builtins.counterStates
  }
  public set counterStates(val: CounterStateRecord) {
    this.builtins.counterStates = val
  }

  private blockInfoCache = new WeakMap<object, BlockInfo>()
  private frames: Frame[] = []
  private diagnostics: RuntimeDiagnostic[] = []
  private reportedOnce = new Set<string>()
  private liveProvider?: LiveProjectProvider
  private tagIndexSource: TagTable[] | null = null
  private tagByName = new Map<string, TagDefinition>()
  private tagByAddress = new Map<string, TagDefinition>()

  // Live node power states and SCL values
  private currentLadPowerStates: Record<string, { powered: boolean; liveValues?: Record<string, string | number> }> = {}
  private currentSclLineValues: Record<string, Record<number, string | number>> = {}

  // 1,000-Cycle O(1) Circular Ring Buffer
  private readonly history = new SnapshotHistory(1000)

  // Throttling & Monitoring Flags
  private monitoringEnabled = false
  private traceRecordingActive = false
  private isCyclicAutoMode = false
  private lastUiEmitTime = 0
  private readonly UI_EMIT_INTERVAL_MS = 40

  // Project AST & Configuration reference
  private projectPayload: ProjectLoadPayload | null = null

  // Callback listeners
  private onSnapshotCallback?: (snapshot: RuntimeMemorySnapshot, metrics: RuntimeWorkerMetrics) => void
  private onStateChangeCallback?: (state: RuntimeOperatingState) => void
  private physicsHook?: (dtSeconds: number, engine: PlcRuntimeEngine) => void
  private externalWriteSink?: (cmd: ExternalRuntimeWriteCmd) => void
  private inScanCycle = false
  private suppressExternalSink = false
  private lastIngestedTimestamp = 0

  constructor(payload?: ProjectLoadPayload) {
    this.memory.onAccessError = (message) => this.reportOnce(message, 'error')
    if (payload) {
      this.loadProject(payload)
    }
  }

  public setLiveProjectProvider(provider: LiveProjectProvider): void {
    this.liveProvider = provider
  }

  public setExternalWriteSink(sink?: (cmd: ExternalRuntimeWriteCmd) => void): void {
    this.externalWriteSink = sink
  }

  /** Replaces the time source. Used by tests to run timers without waiting. */
  public setClock(clock: () => number): void {
    this.clock = clock
  }

  public setMonitoringEnabled(enabled: boolean): void {
    this.monitoringEnabled = enabled
  }

  public isMonitoringEnabled(): boolean {
    return this.monitoringEnabled
  }

  public setTraceRecordingActive(active: boolean): void {
    this.traceRecordingActive = active
    if (!this.suppressExternalSink) {
      this.externalWriteSink?.({ kind: 'setTraceRecording', active })
    }
  }

  public isTraceRecordingActive(): boolean {
    return this.traceRecordingActive
  }

  public getDiagnostics(): RuntimeDiagnostic[] {
    return this.diagnostics
  }

  private addDiagnostic(message: string, severity: RuntimeDiagnostic['severity']): void {
    this.diagnostics.push({ timestamp: this.clock(), cycleNumber: this.cycleNumber, severity, message })
    if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift()
  }

  private reportOnce(message: string, severity: RuntimeDiagnostic['severity'] = 'warning'): void {
    if (this.reportedOnce.has(message)) return
    this.reportedOnce.add(message)
    this.addDiagnostic(message, severity)
  }

  public setOnSnapshot(cb: (snapshot: RuntimeMemorySnapshot, metrics: RuntimeWorkerMetrics) => void): void {
    this.onSnapshotCallback = cb
  }

  public setOnStateChange(cb: (state: RuntimeOperatingState) => void): void {
    this.onStateChangeCallback = cb
  }

  public loadProject(payload: ProjectLoadPayload): void {
    const sameProject = this.projectPayload?.projectPath === payload.projectPath
    LadderEvaluator.resetInternalStates()
    SclInterpreter.resetEdgeStates()
    this.memory.timerStates.clear()
    this.memory.counterStates.clear()
    this.memory.edgeStates.clear()
    this.timerStates = {}
    this.counterStates = {}
    if (!sameProject) this.clearAllForcedValues()
    this.projectPayload = payload
    this.blockInfoCache = new WeakMap()
    this.reportedOnce.clear()

    const profile = getCpuProfile(
      payload.hardware?.general?.profileId ||
        payload.hardware?.general?.targetCpu ||
        payload.hardware?.general?.cpuName ||
        payload.metadata?.targetCpu
    )
    if (profile) this.memory.configure(profile.inputBytes, profile.outputBytes, profile.merkerBytes)

    this.syncDataBlocks()
    this.writeSystemBits(false)
  }

  /** Applies live IDE hardware, DB, UDT, and block edits cleanly (called inside worker on syncLiveProject). */
  public refreshLiveProjectState(hardware?: CpuConfig): void {
    if (hardware && this.projectPayload) {
      this.projectPayload = { ...this.projectPayload, hardware }
      const profile = getCpuProfile(
        hardware.general?.profileId ||
          hardware.general?.targetCpu ||
          hardware.general?.cpuName ||
          this.projectPayload.metadata?.targetCpu
      )
      if (profile) this.memory.configure(profile.inputBytes, profile.outputBytes, profile.merkerBytes)
    }
    this.blockInfoCache = new WeakMap()
    this.tagIndexSource = null
    this.syncDataBlocks()
    this.writeSystemBits(this.firstScanPending)
  }

  private typeResolver() {
    return this.dbRegistry.typeResolver()
  }

  private entryMemory(entry: DbEntry): { bytes: Uint8Array; view: DataView } {
    return this.dbRegistry.entryMemory(entry)
  }

  /** Creates a DB's bytes when it is new or its declaration changed; otherwise contents are kept. */
  public syncDataBlocks(): void {
    this.dbRegistry.syncDataBlocks()
  }

  public exportDbBytes(): Record<number, Uint8Array> {
    return this.dbRegistry.exportDbBytes()
  }

  private writeSystemBits(firstScan: boolean): void {
    const hardware = this.projectPayload?.hardware
    if (!hardware?.systemMemory?.enabled) return
    const byte = hardware.systemMemory.byteAddress
    this.setBit('M', byte, 0, firstScan)
    this.setBit('M', byte, 2, true) // AlwaysTrue
    this.setBit('M', byte, 3, false) // AlwaysFalse
  }

  /** STOP to RUN: outputs and non-retentive memory start from a defined state. */
  private runStartupInitialization(): void {
    this.memory.piq.fill(0)

    const retentive = this.projectPayload?.hardware?.general?.retentiveMemory
    const merkerLen = this.memory.merker.length
    const start = retentive ? Math.max(0, Math.min(merkerLen, Math.trunc(retentive.startByte))) : 0
    const end = retentive ? Math.max(start, Math.min(merkerLen, start + Math.max(0, Math.trunc(retentive.byteCount)))) : 0
    const keep = end > start ? this.memory.merker.slice(start, end) : null
    this.memory.merker.fill(0)
    if (keep && start < merkerLen) this.memory.merker.set(keep, start)

    for (const entry of this.dbEntries.values()) {
      const { bytes, view } = this.entryMemory(entry)
      reinitNonRetain(bytes, view, entry.layout)
    }

    this.memory.timerStates.clear()
    this.memory.counterStates.clear()
    this.memory.edgeStates.clear()
    this.memory.ladderEdgeStates.clear()
    this.memory.sclEdgeStates.clear()
    this.timerStates = {}
    this.counterStates = {}
    LadderEvaluator.resetInternalStates()
    SclInterpreter.resetEdgeStates()
  }

  /** With manualScans the caller drives the cycle through scanOnce and no timers are started. */
  public start(options: { manualScans?: boolean } = {}): void {
    if (this.state === 'RUN') return

    this.blockInfoCache = new WeakMap()
    this.frames = []
    if (this.projectPayload) this.syncDataBlocks()
    this.runStartupInitialization()

    this.state = 'RUN'
    this.onStateChangeCallback?.(this.state)

    this.firstScanPending = true
    this.lastScanWallClock = 0
    this.writeSystemBits(true)
    this.applyForces()

    this.runOb(100)
    if ((this.state as RuntimeOperatingState) !== 'RUN' || options.manualScans) {
      this.isCyclicAutoMode = false
      return
    }

    this.isCyclicAutoMode = true
    this.lastUiEmitTime = 0
    const minCycle = this.projectPayload?.hardware?.general?.minCycleTimeEnabled
      ? this.projectPayload.hardware.general.minCycleTimeMs
      : 0
    this.intervalHandle = setInterval(() => this.runCyclicScan(false), Math.max(10, minCycle || 0))

    for (const block of this.organizationBlocks()) {
      const number = this.blockNumber(block)
      if (number < 30 || number > 38) continue
      const config = this.projectPayload?.hardware?.organizationBlocks?.find((o) => o.blockNumber === number)
      if (config && config.enabled === false) continue
      const period = config?.cycleTimeMs || DEFAULT_INTERRUPT_MS
      this.interruptHandles.push(setInterval(() => this.runCyclicInterrupt(number), period))
    }
  }

  /** Runs one main cycle. For a CPU started with manualScans. */
  public scanOnce(): void {
    this.runCyclicScan(true)
  }

  private clearTimers(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    this.intervalHandle = null
    for (const handle of this.interruptHandles) clearInterval(handle)
    this.interruptHandles = []
    this.isCyclicAutoMode = false
  }

  public stop(): void {
    if (this.state === 'STOP') return
    this.clearTimers()
    this.memory.piq.fill(0)
    this.state = 'STOP'
    this.onStateChangeCallback?.(this.state)
    this.emitSnapshot(1, true, false)
  }

  /** Program error or double watchdog overrun: the CPU leaves RUN and reports why. */
  private faultStop(message: string): void {
    this.addDiagnostic(message, 'error')
    this.clearTimers()
    this.memory.piq.fill(0)
    this.frames = []
    this.state = 'ERROR'
    this.onStateChangeCallback?.(this.state)
    this.emitSnapshot(1, true, false)
  }

  public reset(): void {
    this.stop()
    this.clearTimers()
    this.state = 'STOP'
    this.memory.reset()
    LadderEvaluator.resetInternalStates()
    SclInterpreter.resetEdgeStates()
    this.builtins.clear()
    this.forceTable.clearAll()
    this.cycleNumber = 0
    this.history.clear()
    this.lastUiEmitTime = 0
    this.lastIngestedTimestamp = 0
    this.currentLadPowerStates = {}
    this.currentSclLineValues = {}
    this.dbRegistry.clear()
    this.diagnostics = []
    this.reportedOnce.clear()

    if (this.projectPayload) {
      this.loadProject(this.projectPayload)
    }

    this.emitSnapshot(1, true)
  }

  public getState(): RuntimeOperatingState {
    return this.state
  }

  private pushHistory(snapshot: RuntimeMemorySnapshot): void {
    this.history.push(snapshot)
  }

  public getHistory(): RuntimeMemorySnapshot[] {
    return this.history.getAll()
  }

  public getRecentHistory(count: number): RuntimeMemorySnapshot[] {
    return this.history.getRecent(count)
  }

  public getHistorySince(afterCycleNumber: number): RuntimeMemorySnapshot[] {
    return this.history.getSince(afterCycleNumber)
  }

  public getLiveTagTables(): TagTable[] {
    const live = this.liveProvider?.tagTables()
    return live && live.length > 0 ? live : this.projectPayload?.tagTables || []
  }

  public getLiveLadBlocks(): LadBlockDefinition[] {
    const live = this.liveProvider?.ladBlocks()
    return live && live.length > 0 ? live : this.projectPayload?.ladBlocks || []
  }

  public getLiveSclBlocks(): SclBlockDefinition[] {
    const live = this.liveProvider?.sclBlocks()
    return live && live.length > 0 ? live : this.projectPayload?.sclBlocks || []
  }

  public getLiveDataBlocks(): DataBlockDefinition[] {
    const live = this.liveProvider?.dataBlocks()
    return live && live.length > 0 ? live : this.projectPayload?.dataBlocks || []
  }

  public getLiveUdts(): UdtDefinition[] {
    const live = this.liveProvider?.udts()
    return live && live.length > 0 ? live : this.projectPayload?.udts || []
  }

  public getMetrics(): RuntimeWorkerMetrics {
    return {
      cycleNumber: this.cycleNumber,
      lastCycleDurationMs: this.lastCycleDurationMs,
      averageCycleDurationMs: this.averageCycleDurationMs,
      maxCycleDurationMs: this.maxCycleDurationMs,
      watchdogLimitMs: this.watchdogLimit(),
      state: this.state,
      activeObs: this.activeObs
    }
  }

  public getSnapshotAtCycle(cycleNumber: number): RuntimeMemorySnapshot | undefined {
    return this.history.getAtCycle(cycleNumber)
  }

  public jumpToLastEdge(symbolOrAddress: string): RuntimeMemorySnapshot | undefined {
    const total = this.history.length
    if (total < 2) return undefined
    for (let i = total - 1; i > 0; i--) {
      const curSnap = this.history.at(i)!
      const prevSnap = this.history.at(i - 1)!
      const curVal = !!this.getVariableFromSnapshot(curSnap, symbolOrAddress)
      const prevVal = !!this.getVariableFromSnapshot(prevSnap, symbolOrAddress)
      if (curVal !== prevVal) {
        return curSnap
      }
    }
    return undefined
  }

  public getVariableFromSnapshot(snapshot: RuntimeMemorySnapshot, symbolOrAddress: string): unknown {
    const clean = symbolOrAddress.trim().replace(/^"|"$/g, '').trim()
    if (!clean) return undefined

    this.refreshTagIndex()
    const tag = this.tagByName.get(clean.toLowerCase())
    const addrTarget = tag?.address ? tag.address.trim().toUpperCase() : clean.toUpperCase()
    const dataType = tag?.dataType?.toUpperCase()

    // Check Data Block path (e.g. "DB1_PlantData.PressureBar")
    if (!tag && clean.includes('.')) {
      const segments = splitPath(clean)
      const dbKey = Object.keys(snapshot.dataBlocks).find((k) => k.toLowerCase() === segments[0].toLowerCase())
      if (dbKey) {
        let cur: unknown = snapshot.dataBlocks[dbKey]
        for (let i = 1; i < segments.length; i++) {
          if (cur && typeof cur === 'object') {
            const obj = cur as Record<string, unknown>
            const propKey = Object.keys(obj).find((k) => k.toLowerCase() === segments[i].toLowerCase())
            cur = propKey !== undefined ? obj[propKey] : undefined
          } else {
            cur = undefined
          }
        }
        if (cur !== undefined) return cur
      }
    }

    if (addrTarget.startsWith('%') || /^[IQM]/i.test(addrTarget)) {
      const parsed = parseS7Address(addrTarget)
      if (parsed.isValid) {
        const buf = parsed.area === 'I' ? snapshot.pii : parsed.area === 'Q' ? snapshot.piq : snapshot.merker
        const byte = parsed.byteAddress
        if (parsed.sizeCategory === 'BIT') {
          const bit = parsed.bitAddress || 0
          return ((buf[byte] || 0) & (1 << bit)) !== 0
        }
        if (parsed.sizeCategory === 'BYTE') {
          return buf[byte] || 0
        }
        if (parsed.sizeCategory === 'WORD') {
          const tmp = new Uint8Array([buf[byte] || 0, buf[byte + 1] || 0])
          const view = new DataView(tmp.buffer)
          return dataType === 'WORD' || dataType === 'UINT' ? view.getUint16(0, false) : view.getInt16(0, false)
        }
        if (parsed.sizeCategory === 'DWORD') {
          const tmp = new Uint8Array([buf[byte] || 0, buf[byte + 1] || 0, buf[byte + 2] || 0, buf[byte + 3] || 0])
          const view = new DataView(tmp.buffer)
          if (dataType === 'REAL') return view.getFloat32(0, false)
          if (dataType === 'DWORD' || dataType === 'UDINT') return view.getUint32(0, false)
          return view.getInt32(0, false)
        }
      }
    }
    return undefined
  }

  public setForcedValue(addressOrSymbol: string, value: unknown, active: boolean): void {
    this.forceTable.setForce(addressOrSymbol, value, active)
    if (active) {
      this.suppressExternalSink = true
      try {
        this.setVariable(addressOrSymbol, value)
      } finally {
        this.suppressExternalSink = false
      }
    }
    if (!this.inScanCycle && this.frames.length === 0) {
      this.externalWriteSink?.({ kind: 'setForcedValue', addressOrSymbol, value, active })
    }
  }

  /**
   * Mirrors worker-thread cyclic snapshots onto the local engine so TraceOscilloscope,
   * time-travel debugging, tag monitoring, and plant physics continue seamlessly.
   */
  public ingestWorkerFrame(
    snapshot: RuntimeMemorySnapshot,
    historyDelta: RuntimeMemorySnapshot[],
    metrics: RuntimeWorkerMetrics,
    timerStates?: Record<string, { IN: boolean; Q: boolean; PT: number; ET: number }>,
    counterStates?: Record<
      string,
      { CU: boolean; CD: boolean; R: boolean; PV: number; QU: boolean; QD: boolean; CV: number }
    >,
    dbBytes?: Record<number, Uint8Array>
  ): void {
    const framesToPush = historyDelta.length > 0 ? historyDelta : [snapshot]
    for (const frame of framesToPush) {
      this.pushHistory(frame)
    }

    this.memory.pii.fill(0)
    this.memory.pii.set(snapshot.pii.subarray(0, this.memory.pii.length))
    this.memory.piq.fill(0)
    this.memory.piq.set(snapshot.piq.subarray(0, this.memory.piq.length))
    this.memory.merker.fill(0)
    this.memory.merker.set(snapshot.merker.subarray(0, this.memory.merker.length))

    if (dbBytes) {
      for (const [dbNumStr, bytes] of Object.entries(dbBytes)) {
        const dbNum = Number(dbNumStr)
        if (Number.isInteger(dbNum) && dbNum >= 1 && bytes instanceof Uint8Array) {
          this.memory.setDbBytes(dbNum, bytes)
        }
      }
      this.dbRegistry.refreshViews()
    }

    this.builtins.ingestWorkerStates(timerStates, counterStates)

    this.cycleNumber = metrics.cycleNumber
    this.lastCycleDurationMs = metrics.lastCycleDurationMs
    this.averageCycleDurationMs = metrics.averageCycleDurationMs
    this.maxCycleDurationMs = metrics.maxCycleDurationMs
    this.activeObs = metrics.activeObs
    this.state = metrics.state

    if (this.physicsHook) {
      const dt = this.lastIngestedTimestamp
        ? Math.min(0.2, Math.max(0.001, (snapshot.timestamp - this.lastIngestedTimestamp) / 1000))
        : 0.01
      this.lastIngestedTimestamp = snapshot.timestamp
      try {
        this.physicsHook(dt, this)
      } catch (err) {
        this.reportOnce(`Plant model error: ${(err as Error).message}`, 'error')
      }
    }
  }

  public clearAllForcedValues(): void {
    this.forceTable.clearAll()
  }

  public setPhysicsHook(hook?: (dtSeconds: number, engine: PlcRuntimeEngine) => void): void {
    this.physicsHook = hook
  }

  public injectHardwareFault(channel: string = '%IW64'): void {
    if (!this.inScanCycle && !this.suppressExternalSink && this.externalWriteSink) {
      this.externalWriteSink({ kind: 'injectHardwareFault', channel })
      return
    }

    // Force S7 Wire-Break raw count (32767 / 16#7FFF)
    this.setVariable(channel, 32767)

    // Set CPU Diagnostic Status bit (%M1.1) in System Memory Byte
    if (this.projectPayload?.hardware?.systemMemory?.enabled) {
      const byte = this.projectPayload.hardware.systemMemory.byteAddress
      this.setBit('M', byte, 1, true)
    }

    // Trigger OB82 Diagnostic Interrupt
    this.executeOb82(channel)
  }

  public clearHardwareFault(channel: string = '%IW64'): void {
    if (!this.inScanCycle && !this.suppressExternalSink && this.externalWriteSink) {
      this.externalWriteSink({ kind: 'clearHardwareFault', channel })
      return
    }

    // Reset CPU Diagnostic Status bit (%M1.1)
    if (this.projectPayload?.hardware?.systemMemory?.enabled) {
      const byte = this.projectPayload.hardware.systemMemory.byteAddress
      this.setBit('M', byte, 1, false)
    }
    // Restore nominal value
    this.setVariable(channel, 0)
  }

  /**
   * Main cyclic scan (OB1)
   */
  private runCyclicScan(forceEmit: boolean = true): void {
    if (this.state !== 'RUN') return

    const startTime = performance.now()
    this.cycleNumber++
    this.inScanCycle = true
    try {

    // Plant model runs on measured wall time, clamped so a stalled window does not jump the plant
    if (this.physicsHook) {
      const wall = this.clock()
      const dt = this.lastScanWallClock ? Math.min(0.1, Math.max(0, (wall - this.lastScanWallClock) / 1000)) : 0.01
      this.lastScanWallClock = wall
      try {
        this.physicsHook(dt, this)
      } catch (err) {
        this.reportOnce(`Plant model error: ${(err as Error).message}`, 'error')
      }
    }

    this.updateClockMemory()
    this.writeSystemBits(this.firstScanPending)
    this.applyForces()

    this.currentLadPowerStates = {}
    this.runOb(1)

    this.applyForces()
    this.syncInstanceStates()

    if (this.firstScanPending) {
      this.firstScanPending = false
      const hardware = this.projectPayload?.hardware
      if (hardware?.systemMemory?.enabled) this.setBit('M', hardware.systemMemory.byteAddress, 0, false)
    }

      const duration = Math.max(0.1, performance.now() - startTime)
      this.lastCycleDurationMs = Math.round(duration * 100) / 100
      this.averageCycleDurationMs =
        Math.round(((this.averageCycleDurationMs * 0.9) + (this.lastCycleDurationMs * 0.1)) * 100) / 100
      this.maxCycleDurationMs = Math.max(this.maxCycleDurationMs, this.lastCycleDurationMs)
      this.checkWatchdog(duration)

      this.emitSnapshot(1, forceEmit)
    } finally {
      this.inScanCycle = false
    }
  }

  private watchdogLimit(): number {
    return this.projectPayload?.hardware?.general?.cycleWatchdogTimeMs || 150
  }

  /** Over the limit: time error and OB80 (or STOP if OB80 is absent). Over twice the limit: STOP. */
  private checkWatchdog(durationMs: number): void {
    if (this.state !== 'RUN') return
    const limit = this.watchdogLimit()
    if (durationMs > limit * 2) {
      this.faultStop(`Cycle time ${durationMs.toFixed(1)} ms exceeded twice the watchdog limit of ${limit} ms`)
    } else if (durationMs > limit) {
      if (!this.findOb(80)) {
        this.faultStop(`Cycle time ${durationMs.toFixed(1)} ms exceeded the watchdog limit of ${limit} ms (OB80 not configured)`)
        return
      }
      this.addDiagnostic(`Cycle time ${durationMs.toFixed(1)} ms exceeded the watchdog limit of ${limit} ms`, 'warning')
      this.runOb(80)
    }
  }

  /**
   * Generates authentic Siemens S7 Clock Memory byte (%MB0) frequencies:
   * 10Hz, 5Hz, 2.5Hz, 2Hz, 1.25Hz, 1Hz, 0.625Hz, 0.5Hz
   */
  private updateClockMemory(): void {
    if (!this.projectPayload?.hardware?.clockMemory?.enabled) return
    const byte = this.projectPayload.hardware.clockMemory.byteAddress
    const now = this.clock()
    const periods = [100, 200, 400, 500, 800, 1000, 1600, 2000]
    periods.forEach((period, bit) => this.setBit('M', byte, bit, now % period < period / 2))
  }

  private blockNumber(block: CodeBlock): number {
    return block.blockNumber ?? (block as unknown as { number?: number }).number ?? 0
  }

  private organizationBlocks(): CodeBlock[] {
    return [...this.getLiveLadBlocks(), ...this.getLiveSclBlocks()].filter((b) => b.blockType === 'OB')
  }

  private findOb(number: number): CodeBlock | undefined {
    return this.organizationBlocks().find((b) => this.blockNumber(b) === number)
  }

  private findBlock(name: string): CodeBlock | undefined {
    const lower = name.toLowerCase()
    return [...this.getLiveSclBlocks(), ...this.getLiveLadBlocks()].find((b) => b.name?.toLowerCase() === lower)
  }

  private interfaceOf(block: CodeBlock): BlockInterface {
    if ('code' in block) return effectiveInterface(block)
    return { ...emptyInterface(), ...(block.interface || {}) }
  }

  private instanceVariables(iface: BlockInterface): LayoutVariable[] {
    return [...iface.input, ...iface.output, ...iface.inOut, ...iface.static]
  }

  private blockInfo(block: CodeBlock): BlockInfo {
    const cached = this.blockInfoCache.get(block)
    if (cached) return cached

    const resolver = this.typeResolver()
    const iface = this.interfaceOf(block)
    const returnType = 'code' in block ? parseSourceBlock(block.code || '').returnType : undefined
    const hasReturn = !!returnType && returnType.toLowerCase() !== 'void'
    const argVars: LayoutVariable[] = [
      ...iface.input,
      ...iface.output,
      ...iface.inOut,
      ...iface.temp,
      ...(hasReturn ? [{ name: 'Ret_Val', dataType: returnType as string }] : [])
    ]

    const info: BlockInfo = {
      iface,
      returnType: hasReturn ? returnType : undefined,
      instanceLayout: buildLayout(this.instanceVariables(iface), resolver),
      temp: buildLayout(iface.temp, resolver),
      args: buildLayout(argVars, resolver)
    }
    if (iface.constant.length > 0) {
      const layout = buildLayout(iface.constant, resolver)
      const bytes = new Uint8Array(layout.byteSize)
      const view = new DataView(bytes.buffer)
      applyStartValues(bytes, view, layout)
      info.constant = { bytes, view, base: 0, layout, path: `${block.name}.#const`, readonly: true }
    }
    this.blockInfoCache.set(block, info)
    return info
  }

  private newScope(layout: StructType, path: string): Scope {
    const bytes = new Uint8Array(layout.byteSize)
    return { bytes, view: new DataView(bytes.buffer), base: 0, layout, path }
  }

  /** Runs an OB if the project has one. Any program error takes the CPU out of RUN. */
  private runOb(number: number): void {
    const block = this.findOb(number)
    if (!block) return
    const info = this.blockInfo(block)
    const scopes = [this.newScope(info.temp, `${block.name}.#temp`)]
    if (info.constant) scopes.push(info.constant)
    try {
      this.runInFrame(block, { blockName: block.name, scopes })
    } catch (err) {
      this.faultStop(`${block.name}: ${(err as Error).message}`)
    }
  }

  private runInFrame(block: CodeBlock, frame: Frame): void {
    const general = this.projectPayload?.hardware?.general
    const family = getCpuProfile(general?.targetCpu || general?.cpuName || this.projectPayload?.metadata?.targetCpu)?.family
    const maxDepth = family === 'S7-1200' ? 16 : 24
    if (this.frames.length >= maxDepth) {
      throw new Error(`Block nesting deeper than ${maxDepth} levels at '${block.name}'`)
    }
    this.frames.push(frame)
    try {
      this.runBlockBody(block)
    } finally {
      this.frames.pop()
    }
  }

  private runBlockBody(block: CodeBlock): void {
    const context = this.createExecutionContext()
    if ('code' in block) {
      const lineVals: Record<number, string | number> = {}
      const result = SclInterpreter.execute(block.code, { ...context, lineValues: lineVals })
      this.currentSclLineValues[block.fileName] = lineVals
      if (!result.success) throw new Error(result.error || 'SCL execution failed')
      return
    }

    for (const net of block.networks || []) {
      const evalRes = LadderEvaluator.evaluateNetwork(
        {
          id: `net_${net.networkNumber}`,
          networkNumber: net.networkNumber,
          title: net.title,
          comment: net.comment,
          isSclNetwork: net.isSclNetwork,
          sclCode: net.sclCode,
          nodes: net.nodes || []
        },
        context,
        this.clock(),
        this.memory
      )
      Object.assign(this.currentLadPowerStates, evalRes.nodePowerStates)
    }
  }

  private syncInstanceStates(): void {
    this.builtins.syncInstanceStates()
  }

  /** Forced values win over the program at the start and end of each scan. */
  private applyForces(): void {
    for (const [key, value] of this.forceOverrides.entries()) {
      this.writeGlobal(key, value)
    }
  }

  /**
   * Executes one cyclic interrupt OB (OB30..OB38).
   */
  private runCyclicInterrupt(number: number): void {
    if (this.state !== 'RUN') return
    this.inScanCycle = true
    const prevObs = this.activeObs
    this.activeObs = `OB${number}`
    try {
      this.applyForces()
      this.runOb(number)
      this.applyForces()
      this.syncInstanceStates()
    } finally {
      this.activeObs = prevObs
      this.inScanCycle = false
    }
  }

  /**
   * Executes OB82 (Diagnostic Fault)
   */
  private executeOb82(_faultChannel: string): void {
    if (this.state === 'RUN') {
      this.runOb(82)
    }
    this.emitSnapshot(82, true)
  }

  // ===========================================================================
  // Block calls
  // ===========================================================================

  private resolveCallee(name: string, quoted: boolean): Callee | null {
    const clean = name.replace(/"/g, '')

    if (!quoted && this.frames.length > 0) {
      const local = this.resolveLocal(clean)
      if (local) {
        const callee = this.calleeFromLocation(local.scope, local.loc)
        if (callee) return callee
      }
    }
    if (clean.startsWith('#')) return null

    const segments = splitPath(clean)
    const entry = this.dbEntries.get(segments[0].toLowerCase())
    if (entry) {
      if (segments.length === 1) {
        if (entry.builtin) return { kind: 'builtin', builtin: entry.builtin, key: entry.name }
        const fb = entry.def.parentFbName ? this.findBlock(entry.def.parentFbName) : undefined
        if (fb && fb.blockType === 'FB') {
          return { kind: 'fb', block: fb, scope: this.dbScope(entry) }
        }
        throw new Error(`'${entry.name}' is not an instance data block and cannot be called`)
      }
      if (segments.length === 2) {
        const kind = builtinInstanceKind(segments[1])
        if (kind) return { kind: 'builtin', builtin: kind, key: entry.name }
      }
      const loc = resolvePath(entry.layout, segments.slice(1), 0, entry.name)
      if (loc) return this.calleeFromLocation(this.dbScope(entry), loc)
      return null
    }

    const block = this.findBlock(clean)
    if (block?.blockType === 'FC') return { kind: 'fc', block }
    if (block?.blockType === 'FB') throw new Error(`Function block '${block.name}' needs an instance to be called`)
    return null
  }

  private calleeFromLocation(scope: Scope, loc: ResolvedLocation): Callee | null {
    if (loc.type.kind === 'instance') return { kind: 'builtin', builtin: loc.type.builtin, key: loc.path }
    if (loc.type.kind !== 'fbInstance') return null
    const fb = this.findBlock(loc.type.fbName)
    if (!fb) return null
    return {
      kind: 'fb',
      block: fb,
      scope: { bytes: scope.bytes, view: scope.view, base: loc.byteOffset, layout: loc.type.layout, path: loc.path }
    }
  }

  private dbScope(entry: DbEntry): Scope {
    const { bytes, view } = this.entryMemory(entry)
    return { bytes, view, base: 0, layout: entry.layout, path: entry.name }
  }

  private callBlock(call: SclBlockCall): { handled: boolean; returnValue?: unknown } {
    const callee = this.resolveCallee(call.name, call.quoted)
    if (!callee) return { handled: false }
    if (callee.kind === 'builtin') {
      this.callBuiltin(callee.builtin, callee.key, call)
      return { handled: true }
    }
    if (callee.kind === 'fb') {
      this.callFb(callee.block, callee.scope, call)
      return { handled: true }
    }
    return { handled: true, returnValue: this.callFc(callee.block, call) }
  }

  /** Puts positional arguments on the parameters in declaration order. */
  private namedParams(info: BlockInfo, source: Record<string, unknown>): Map<string, unknown> {
    const out = new Map<string, unknown>()
    const declared = [...info.iface.input, ...info.iface.inOut]
    for (const [param, value] of Object.entries(source)) {
      const positional = param.match(/^arg_(\d+)$/)
      const name = positional ? declared[parseInt(positional[1], 10)]?.name : param
      if (name) out.set(name.toLowerCase(), value)
    }
    return out
  }

  private writeParams(block: CodeBlock, info: BlockInfo, scope: Scope, call: SclBlockCall): void {
    const inputSet = new Set([...info.iface.input, ...info.iface.inOut].map((v) => v.name.toLowerCase()))
    const outputSet = new Set(info.iface.output.map((v) => v.name.toLowerCase()))
    for (const [param, value] of this.namedParams(info, call.inputs)) {
      if (outputSet.has(param)) continue
      if (!inputSet.has(param)) throw new Error(`Block '${block.name}' has no parameter '${param}'`)
      this.writeScope(scope, [param], value)
    }
  }

  private readParams(info: BlockInfo, scope: Scope, call: SclBlockCall): void {
    const outputSet = new Set([...info.iface.output, ...info.iface.inOut].map((v) => v.name.toLowerCase()))
    for (const [param, writer] of Object.entries(call.writers)) {
      const positional = param.match(/^arg_(\d+)$/)
      const name = positional
        ? [...info.iface.input, ...info.iface.inOut][parseInt(positional[1], 10)]?.name
        : param
      if (name && outputSet.has(name.toLowerCase())) writer(this.readScope(scope, [name]))
    }
  }

  private callFb(block: CodeBlock, instance: Scope, call: SclBlockCall): void {
    const info = this.blockInfo(block)
    this.writeParams(block, info, instance, call)
    const scopes = [instance, this.newScope(info.temp, `${block.name}.#temp`)]
    if (info.constant) scopes.push(info.constant)
    this.runInFrame(block, { blockName: block.name, scopes })
    this.readParams(info, instance, call)
  }

  private callFc(block: CodeBlock, call: SclBlockCall): unknown {
    const info = this.blockInfo(block)
    const args = this.newScope(info.args, `${block.name}.#args`)
    this.writeParams(block, info, args, call)
    const scopes = [args]
    if (info.constant) scopes.push(info.constant)
    this.runInFrame(block, { blockName: block.name, scopes, returnName: block.name.toLowerCase() })
    this.readParams(info, args, call)
    return info.returnType ? this.readScope(args, ['Ret_Val']) : undefined
  }

  private callBuiltin(kind: BuiltinInstanceKind, key: string, call: SclBlockCall): void {
    this.builtins.callBuiltin(kind, key, call)
  }

  // ===========================================================================
  // Symbol resolution
  // ===========================================================================

  /**
   * Creates an execution context that resolves symbols and addresses
   */
  public createExecutionContext(): SclExecutionContext {
    return {
      getVar: (symbol, quoted) => this.getVariable(symbol, quoted),
      setVar: (symbol, value, quoted) => this.setVariable(symbol, value, quoted),
      typeOf: (symbol, quoted) => this.typeOfSymbol(symbol, quoted),
      returnTypeOf: (name) => {
        const block = this.findBlock(name.replace(/"/g, '').trim())
        return block && block.blockType === 'FC' ? this.blockInfo(block).returnType : undefined
      },
      canCall: (name, quoted) => this.resolveCallee(name, quoted) !== null,
      callBlock: (call) => this.callBlock(call),
      hasSymbol: (symbol, quoted) => this.hasSymbol(symbol, quoted),
      resolveInstanceKey: (name, quoted) => this.resolveInstanceKey(name, quoted),
      edgeStates: this.memory.sclEdgeStates,
      instancePrefix: () => {
        const scope = this.frames[this.frames.length - 1]?.scopes[0]
        return scope ? `${scope.path}.` : ''
      },
      onError: (message) => {
        throw new Error(message)
      }
    }
  }

  private splitName(symbol: string, quoted?: boolean): { clean: string; quoted: boolean } {
    const raw = symbol.trim()
    return { clean: raw.replace(/"/g, '').trim(), quoted: !!quoted || raw.startsWith('"') }
  }

  private resolveLocal(name: string): { scope: Scope; loc: ResolvedLocation } | null {
    const frame = this.frames[this.frames.length - 1]
    if (!frame) return null
    const bare = name.replace(/^#/, '')
    const lower = bare.toLowerCase()
    const segments = frame.returnName && (lower === frame.returnName || lower === 'ret_val') ? ['Ret_Val'] : splitPath(bare)
    for (const scope of frame.scopes) {
      const loc = resolvePath(scope.layout, segments, scope.base, scope.path)
      if (loc) return { scope, loc }
    }
    return null
  }

  private readLocation(scope: Scope, loc: ResolvedLocation): unknown {
    if (loc.instanceMember) return this.readInstanceField(loc.path, loc.instanceMember)
    if (loc.type.kind === 'instance') return this.readInstanceField(loc.path, 'Q')
    return readValue(scope.bytes, scope.view, loc.type, loc.byteOffset, loc.bitOffset)
  }

  private writeLocation(scope: Scope, loc: ResolvedLocation, value: unknown): void {
    if (loc.instanceMember) {
      this.writeInstanceField(loc.path, loc.instanceMember, value)
      return
    }
    if (scope.readonly) {
      throw new Error(`Cannot write to constant '${loc.path}'`)
    }
    writeValue(scope.bytes, scope.view, loc.type, loc.byteOffset, loc.bitOffset, value)
  }

  private readScope(scope: Scope, segments: string[]): unknown {
    const loc = resolvePath(scope.layout, segments, scope.base, scope.path)
    return loc ? this.readLocation(scope, loc) : undefined
  }

  private writeScope(scope: Scope, segments: string[], value: unknown): void {
    const loc = resolvePath(scope.layout, segments, scope.base, scope.path)
    if (loc) this.writeLocation(scope, loc, value)
  }

  private readInstanceField(key: string, field: string): unknown {
    return this.builtins.readInstanceField(key, field)
  }

  private writeInstanceField(key: string, field: string, value: unknown): void {
    this.builtins.writeInstanceField(key, field, value)
  }

  private refreshTagIndex(): void {
    const tables = this.getLiveTagTables()
    if (tables === this.tagIndexSource && this.tagByName.size > 0) return
    this.tagIndexSource = tables
    this.tagByName.clear()
    this.tagByAddress.clear()
    for (const table of tables) {
      for (const tag of table.tags || []) {
        if (tag.name) this.tagByName.set(tag.name.toLowerCase(), tag)
        if (tag.address) this.tagByAddress.set(this.normalizeAddress(tag.address), tag)
      }
    }
  }

  private normalizeAddress(address: string): string {
    const upper = address.trim().toUpperCase()
    return upper.startsWith('%') ? upper : `%${upper}`
  }

  private addressKey(resolved: S7ResolvedAddress): string {
    return this.normalizeAddress(resolved.raw)
  }

  /** Reads an address, decoding it with the type of a tag declared on the same address. */
  private readAddress(resolved: S7ResolvedAddress): unknown {
    this.refreshTagIndex()
    const tag = this.tagByAddress.get(this.addressKey(resolved))
    if (tag?.dataType && resolved.sizeCategory !== 'BIT') return this.memory.readTyped(resolved, tag.dataType)
    return this.memory.getVariable(resolved.raw)
  }

  private writeAddress(resolved: S7ResolvedAddress, value: unknown): void {
    this.refreshTagIndex()
    const tag = this.tagByAddress.get(this.addressKey(resolved))
    if (tag?.dataType && resolved.sizeCategory !== 'BIT') {
      this.memory.writeTyped(resolved, tag.dataType, value)
      return
    }
    const size = resolved.sizeCategory === 'BIT' ? 'Bool' : resolved.sizeCategory === 'BYTE' ? 'Byte' : resolved.sizeCategory === 'WORD' ? 'Word' : 'DWord'
    this.memory.writeTyped(resolved, size, value)
  }

  private lookupForce(clean: string): { found: boolean; value?: unknown } {
    this.refreshTagIndex()
    return this.forceTable.lookupForce(clean, this.tagByName, this.tagByAddress, (a) => this.normalizeAddress(a))
  }

  /**
   * Resolves variable reading
   */
  public getVariable(symbolOrAddress: string, quotedHint?: boolean): unknown {
    if (!symbolOrAddress) return 0
    const { clean, quoted } = this.splitName(symbolOrAddress, quotedHint)

    if (!quoted && this.frames.length > 0) {
      const local = this.resolveLocal(clean)
      if (local) return this.readLocation(local.scope, local.loc)
      if (clean.startsWith('#')) {
        this.reportOnce(`Unknown local variable '${clean}' in ${this.frames[this.frames.length - 1].blockName}`, 'error')
        return 0
      }
    }
    if (quoted && this.frames.length > 0) {
      const frame = this.frames[this.frames.length - 1]
      if (frame.returnName === clean.toLowerCase()) return this.readScope(frame.scopes[0], ['Ret_Val'])
    }

    const force = this.lookupForce(clean)
    if (force.found) return force.value

    return this.readGlobal(clean, quoted)
  }

  private readGlobal(clean: string, quoted: boolean): unknown {
    if (!quoted) {
      const resolved = this.memory.resolveAddress(clean)
      if (resolved) return this.readAddress(resolved)
    }

    const segments = splitPath(clean)
    const entry = this.dbEntries.get(segments[0].toLowerCase())
    if (entry) {
      const { bytes, view } = this.entryMemory(entry)
      if (segments.length === 1) return readValue(bytes, view, entry.layout, 0, 0)
      const loc = resolvePath(entry.layout, segments.slice(1), 0, entry.name)
      if (loc) return this.readLocation(this.dbScope(entry), loc)
      const field = segments.length === 2 ? segments[1].toUpperCase() : ''
      if (field && (entry.builtin || this.isKnownInstance(entry.name))) return this.readInstanceField(entry.name, field)
      this.reportOnce(`'${clean}' does not exist in data block '${entry.name}'`, 'error')
      return 0
    }

    this.refreshTagIndex()
    const tag = this.tagByName.get(clean.toLowerCase())
    if (tag) {
      const resolved = tag.address ? this.memory.resolveAddress(tag.address) : null
      if (!resolved) {
        this.reportOnce(`Tag '${tag.name}' has no valid address`, 'error')
        return 0
      }
      if (tag.dataType && resolved.sizeCategory !== 'BIT') return this.memory.readTyped(resolved, tag.dataType)
      return this.readAddress(resolved)
    }

    const fieldMatch = clean.match(TIMER_FIELD)
    if (fieldMatch) return this.readInstanceField(fieldMatch[1], fieldMatch[2].toUpperCase())
    if (/^T\d+$/i.test(clean)) return this.memory.getTimer(clean).Q
    if (/^C\d+$/i.test(clean)) {
      const c = this.memory.getCounter(clean)
      return c.kind === 'CTD' ? c.QD : c.QU
    }

    this.reportOnce(`Unknown symbol '${clean}'`, 'error')
    return 0
  }

  /**
   * Resolves variable writing
   */
  public setVariable(symbolOrAddress: string, value: unknown, quotedHint?: boolean): void {
    if (!symbolOrAddress) return
    const { clean, quoted } = this.splitName(symbolOrAddress, quotedHint)

    if (!quoted && this.frames.length > 0) {
      const local = this.resolveLocal(clean)
      if (local) {
        this.writeLocation(local.scope, local.loc, value)
        return
      }
      if (clean.startsWith('#')) {
        this.reportOnce(`Unknown local variable '${clean}' in ${this.frames[this.frames.length - 1].blockName}`, 'error')
        return
      }
    }
    if (quoted && this.frames.length > 0) {
      const frame = this.frames[this.frames.length - 1]
      if (frame.returnName === clean.toLowerCase()) {
        this.writeScope(frame.scopes[0], ['Ret_Val'], value)
        return
      }
    }

    this.writeGlobal(clean, value, quoted)
    if (!this.inScanCycle && !this.suppressExternalSink && this.frames.length === 0) {
      this.externalWriteSink?.({ kind: 'setVariable', symbolOrAddress, value })
    }
  }

  private writeGlobal(clean: string, value: unknown, quoted = false): void {
    if (!quoted) {
      const resolved = this.memory.resolveAddress(clean)
      if (resolved) {
        this.writeAddress(resolved, value)
        return
      }
    }

    const segments = splitPath(clean)
    const entry = this.dbEntries.get(segments[0].toLowerCase())
    if (entry) {
      const { bytes, view } = this.entryMemory(entry)
      if (segments.length === 1) {
        writeValue(bytes, view, entry.layout, 0, 0, value)
        return
      }
      const loc = resolvePath(entry.layout, segments.slice(1), 0, entry.name)
      if (loc) {
        this.writeLocation(this.dbScope(entry), loc, value)
        return
      }
      const field = segments.length === 2 ? segments[1].toUpperCase() : ''
      if (field && (entry.builtin || this.isKnownInstance(entry.name))) {
        this.writeInstanceField(entry.name, field, value)
        return
      }
      this.reportOnce(`'${clean}' does not exist in data block '${entry.name}'`, 'error')
      return
    }

    this.refreshTagIndex()
    const tag = this.tagByName.get(clean.toLowerCase())
    if (tag) {
      const resolved = tag.address ? this.memory.resolveAddress(tag.address) : null
      if (!resolved) {
        this.reportOnce(`Tag '${tag.name}' has no valid address`, 'error')
        return
      }
      if (tag.dataType && resolved.sizeCategory !== 'BIT') this.memory.writeTyped(resolved, tag.dataType, value)
      else this.writeAddress(resolved, value)
      return
    }

    const fieldMatch = clean.match(TIMER_FIELD)
    if (fieldMatch) {
      this.writeInstanceField(fieldMatch[1], fieldMatch[2].toUpperCase(), value)
      return
    }

    this.reportOnce(`Write to unknown symbol '${clean}' was ignored`, 'error')
  }

  private isKnownInstance(name: string): boolean {
    return this.builtins.isKnownInstance(name)
  }

  private hasSymbol(symbol: string, quotedHint?: boolean): boolean {
    const { clean, quoted } = this.splitName(symbol, quotedHint)
    if (!quoted && this.frames.length > 0 && this.resolveLocal(clean)) return true
    if (!quoted && this.memory.resolveAddress(clean)) return true
    const segments = splitPath(clean)
    const entry = this.dbEntries.get(segments[0].toLowerCase())
    if (entry) return segments.length === 1 || !!resolvePath(entry.layout, segments.slice(1))
    this.refreshTagIndex()
    return this.tagByName.has(clean.toLowerCase())
  }

  private instanceMemberType(member: string): string | undefined {
    return this.builtins.instanceMemberType(member)
  }

  private typeOfSymbol(symbol: string, quotedHint?: boolean): string | undefined {
    const { clean, quoted } = this.splitName(symbol, quotedHint)
    const nameOf = (type: S7Type): string | undefined =>
      type.kind === 'elementary' ? type.name : type.kind === 'string' ? 'STRING' : undefined

    if (!quoted && this.frames.length > 0) {
      const local = this.resolveLocal(clean)
      if (local) {
        if (local.loc.instanceMember) return this.instanceMemberType(local.loc.instanceMember)
        return nameOf(local.loc.type)
      }
    }
    if (!quoted) {
      const resolved = this.memory.resolveAddress(clean)
      if (resolved) {
        this.refreshTagIndex()
        const tag = this.tagByAddress.get(this.addressKey(resolved))
        if (tag?.dataType) return tag.dataType.toUpperCase()
        return resolved.sizeCategory === 'BIT' ? 'BOOL' : resolved.sizeCategory
      }
    }
    const segments = splitPath(clean)
    const entry = this.dbEntries.get(segments[0].toLowerCase())
    if (entry) {
      const loc = segments.length > 1 ? resolvePath(entry.layout, segments.slice(1)) : null
      if (loc) {
        if (loc.instanceMember) return this.instanceMemberType(loc.instanceMember)
        return nameOf(loc.type)
      }
      if (segments.length === 2 && (entry.builtin || this.isKnownInstance(entry.name))) {
        return this.instanceMemberType(segments[1])
      }
      return undefined
    }
    const fieldMatch = clean.match(TIMER_FIELD)
    if (fieldMatch) return this.instanceMemberType(fieldMatch[2])
    this.refreshTagIndex()
    return this.tagByName.get(clean.toLowerCase())?.dataType?.toUpperCase()
  }

  private resolveInstanceKey(name: string, quoted: boolean): string {
    if (!quoted && this.frames.length > 0) {
      const local = this.resolveLocal(name)
      if (local && local.loc.type.kind === 'instance') return local.loc.path
      if (name.startsWith('#')) return `${this.frames[this.frames.length - 1].blockName}.${name.slice(1)}`
    }
    return name
  }

  public getLiveTagValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const table of this.getLiveTagTables()) {
      for (const tag of table.tags || []) {
        const liveVal = tag.address ? this.getVariable(tag.address) : tag.name ? this.getVariable(tag.name) : undefined
        if (liveVal !== undefined) {
          out[tag.id] = liveVal
        }
      }
    }
    return out
  }

  // Bit/Byte/Word/DWord helpers - routed directly through S7BinaryMemory
  public getBit(area: 'I' | 'Q' | 'M' | 'DB', byte: number, bit: number): boolean {
    return this.memory.readBit(area, byte, bit)
  }

  public setBit(area: 'I' | 'Q' | 'M' | 'DB', byte: number, bit: number, val: boolean): void {
    this.memory.writeBit(area, byte, bit, val)
    if (area !== 'DB' && !this.inScanCycle && !this.suppressExternalSink && this.frames.length === 0) {
      this.externalWriteSink?.({ kind: 'setBit', area, byte, bit, value: val })
    }
  }

  public getByte(area: 'I' | 'Q' | 'M' | 'DB', byte: number): number {
    return this.memory.readByte(area, byte)
  }

  public setByte(area: 'I' | 'Q' | 'M' | 'DB', byte: number, val: number): void {
    this.memory.writeByte(area, byte, val)
    if (area !== 'DB' && !this.inScanCycle && !this.suppressExternalSink && this.frames.length === 0) {
      this.externalWriteSink?.({ kind: 'setByte', area, byte, value: val })
    }
  }

  public getWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number): number {
    return this.memory.readWord(area, byte)
  }

  public setWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number, val: number): void {
    this.memory.writeWord(area, byte, val)
    if (area !== 'DB' && !this.inScanCycle && !this.suppressExternalSink && this.frames.length === 0) {
      this.externalWriteSink?.({ kind: 'setWord', area, byte, value: val })
    }
  }

  public getDWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number): number {
    return this.memory.readDWord(area, byte)
  }

  public setDWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number, val: number): void {
    this.memory.writeDWord(area, byte, val)
    if (area !== 'DB' && !this.inScanCycle && !this.suppressExternalSink && this.frames.length === 0) {
      this.externalWriteSink?.({ kind: 'setDWord', area, byte, value: val })
    }
  }

  private decodeDataBlocks(): Record<string, Record<string, unknown>> {
    return this.dbRegistry.decodeDataBlocks()
  }

  /** Copies an area up to its last used byte; readers treat bytes past the end as zero. */
  private trimmedCopy(area: Uint8Array): Uint8Array {
    let end = area.length
    while (end > 0 && area[end - 1] === 0) end--
    return area.slice(0, end)
  }

  private cloneSclLineValues(): Record<string, Record<number, string | number>> {
    const out: Record<string, Record<number, string | number>> = {}
    for (const [fileName, lines] of Object.entries(this.currentSclLineValues)) {
      out[fileName] = { ...lines }
    }
    return out
  }

  /**
   * Emits snapshot (throttled to ~25 FPS in free-running cyclic mode) and maintains the O(1) 1,000-cycle ring buffer
   */
  private emitSnapshot(triggeringOb: number, forceEmit: boolean = true, recordHistory: boolean = true): void {
    let shouldEmitUi = true
    if (this.isCyclicAutoMode && !forceEmit) {
      const nowWall = performance.now()
      if (this.lastUiEmitTime !== 0 && nowWall - this.lastUiEmitTime < this.UI_EMIT_INTERVAL_MS) {
        shouldEmitUi = false
      } else {
        this.lastUiEmitTime = nowWall
      }
    }

    const skipHeavyClones =
      this.isCyclicAutoMode && !forceEmit && !shouldEmitUi && !this.monitoringEnabled && !this.traceRecordingActive

    const snapshot: RuntimeMemorySnapshot = {
      cycleNumber: this.cycleNumber,
      timestamp: this.clock(),
      triggeringOb,
      cycleDurationMs: this.lastCycleDurationMs,
      pii: this.trimmedCopy(this.pii),
      piq: this.trimmedCopy(this.piq),
      merker: this.trimmedCopy(this.merker),
      dataBlocks: skipHeavyClones ? {} : this.decodeDataBlocks(),
      ladPowerState: skipHeavyClones ? {} : { ...this.currentLadPowerStates },
      sclLineValues: skipHeavyClones ? {} : this.cloneSclLineValues()
    }

    // Add to O(1) 1,000-cycle ring buffer on actual scan / diagnostic transitions
    if (recordHistory) {
      this.pushHistory(snapshot)
    }

    if (!shouldEmitUi) return

    const metrics: RuntimeWorkerMetrics = {
      cycleNumber: this.cycleNumber,
      lastCycleDurationMs: this.lastCycleDurationMs,
      averageCycleDurationMs: this.averageCycleDurationMs,
      maxCycleDurationMs: this.maxCycleDurationMs,
      watchdogLimitMs: this.watchdogLimit(),
      state: this.state,
      activeObs: this.activeObs
    }

    this.onSnapshotCallback?.(snapshot, metrics)
  }
}
