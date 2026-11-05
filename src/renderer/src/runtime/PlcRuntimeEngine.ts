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
  TypeResolver,
  writeValue
} from '@shared/s7/typeLayout'
import { effectiveInterface, emptyInterface, parseSourceBlock } from '@shared/scl/sourceBlock'
import { SclBlockCall, SclExecutionContext, SclInterpreter } from './SclInterpreter'
import { LadderEvaluator } from './LadderEvaluator'
import { S7BinaryMemory, S7ResolvedAddress } from './S7BinaryMemory'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { TagTable, TagDefinition } from '@shared/types/tags'
import { UdtDefinition } from '@shared/types/types'
import { BlockInterface, LadBlockDefinition, SclBlockDefinition, DataBlockDefinition } from '@shared/types/blocks'

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

type CodeBlock = LadBlockDefinition | SclBlockDefinition

interface DbEntry {
  def: DataBlockDefinition
  name: string
  number: number
  layout: StructType
  bytes: Uint8Array
  view: DataView
  signature: string
  builtin?: BuiltinInstanceKind
}

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

  // DB contents live in bytes inside S7BinaryMemory; these entries describe their layout
  private dbEntries = new Map<string, DbEntry>()
  private blockInfoCache = new WeakMap<object, BlockInfo>()
  private frames: Frame[] = []
  private diagnostics: RuntimeDiagnostic[] = []
  private reportedOnce = new Set<string>()
  private liveProvider?: LiveProjectProvider
  private tagIndexSource: TagTable[] | null = null
  private tagByName = new Map<string, TagDefinition>()
  private tagByAddress = new Map<string, TagDefinition>()

  public forceOverrides = new Map<string, unknown>()

  // Native IEC Timer & Counter State Dictionaries
  public timerStates: Record<string, { IN: boolean; Q: boolean; PT: number; ET: number }> = {}
  public counterStates: Record<
    string,
    { CU: boolean; CD: boolean; R: boolean; PV: number; QU: boolean; QD: boolean; CV: number }
  > = {}

  // Live node power states and SCL values
  private currentLadPowerStates: Record<string, { powered: boolean; liveValues?: Record<string, string | number> }> = {}
  private currentSclLineValues: Record<string, Record<number, string | number>> = {}

  // 1,000-Cycle Circular Ring Buffer
  private historyBuffer: RuntimeMemorySnapshot[] = []
  private readonly MAX_HISTORY = 1000

  // Project AST & Configuration reference
  private projectPayload: ProjectLoadPayload | null = null

  // Callback listeners
  private onSnapshotCallback?: (snapshot: RuntimeMemorySnapshot, metrics: RuntimeWorkerMetrics) => void
  private onStateChangeCallback?: (state: RuntimeOperatingState) => void
  private physicsHook?: (dtSeconds: number, engine: PlcRuntimeEngine) => void

  constructor(payload?: ProjectLoadPayload) {
    this.memory.onAccessError = (message) => this.reportOnce(message, 'error')
    if (payload) {
      this.loadProject(payload)
    }
  }

  public setLiveProjectProvider(provider: LiveProjectProvider): void {
    this.liveProvider = provider
  }

  /** Replaces the time source. Used by tests to run timers without waiting. */
  public setClock(clock: () => number): void {
    this.clock = clock
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

    const profile = getCpuProfile(payload.hardware?.general?.targetCpu)
    if (profile) this.memory.configure(profile.inputBytes, profile.outputBytes, profile.merkerBytes)

    this.syncDataBlocks()
    this.writeSystemBits(false)
  }

  private typeResolver(): TypeResolver {
    return {
      udt: (name) => this.getLiveUdts().find((u) => u.name.toLowerCase() === name.toLowerCase())?.members as LayoutVariable[] | undefined,
      fb: (name) => {
        const block = this.findBlock(name)
        return block && block.blockType === 'FB' ? this.instanceVariables(this.interfaceOf(block)) : undefined
      },
      onUnknownType: (typeName) => this.reportOnce(`Unknown data type '${typeName}'`, 'error')
    }
  }

  /** Creates a DB's bytes when it is new or its declaration changed; otherwise contents are kept. */
  private syncDataBlocks(): void {
    const resolver = this.typeResolver()
    const defs = this.getLiveDataBlocks()
    const next = new Map<string, DbEntry>()
    let autoNumber = defs.reduce((max, d) => Math.max(max, d.blockNumber || 0), 0)

    for (const def of defs) {
      const parent = def.dbType === 'Instance' ? def.parentFbName : undefined
      const builtin = parent ? builtinInstanceKind(parent) : undefined
      const fb = parent && !builtin ? this.findBlock(parent) : undefined
      const variables: LayoutVariable[] = fb ? this.instanceVariables(this.interfaceOf(fb)) : def.variables || []
      const number = def.blockNumber || ++autoNumber
      const signature = JSON.stringify([number, parent || '', variables])
      const key = def.name.toLowerCase()

      const existing = this.dbEntries.get(key)
      if (existing && existing.signature === signature) {
        next.set(key, { ...existing, def })
        continue
      }

      const layout = buildLayout(variables, resolver)
      const { bytes, view } = this.memory.allocateDb(number, Math.max(layout.byteSize, 1))
      applyStartValues(bytes, view, layout)
      next.set(key, { def, name: def.name, number, layout, bytes, view, signature, builtin })
    }
    this.dbEntries = next
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
    const keep = retentive ? this.memory.merker.slice(retentive.startByte, retentive.startByte + retentive.byteCount) : null
    this.memory.merker.fill(0)
    if (retentive && keep) this.memory.merker.set(keep, retentive.startByte)

    for (const entry of this.dbEntries.values()) {
      reinitNonRetain(entry.bytes, entry.view, entry.layout)
    }

    this.memory.timerStates.clear()
    this.memory.counterStates.clear()
    this.memory.edgeStates.clear()
    LadderEvaluator.resetInternalStates()
    SclInterpreter.resetEdgeStates()
  }

  public start(): void {
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
    if ((this.state as RuntimeOperatingState) !== 'RUN') return

    const minCycle = this.projectPayload?.hardware?.general?.minCycleTimeEnabled
      ? this.projectPayload.hardware.general.minCycleTimeMs
      : 0
    this.intervalHandle = setInterval(() => this.runCyclicScan(), Math.max(10, minCycle || 0))

    for (const block of this.organizationBlocks()) {
      const number = this.blockNumber(block)
      if (number < 30 || number > 38) continue
      const config = this.projectPayload?.hardware?.organizationBlocks?.find((o) => o.blockNumber === number)
      if (config && config.enabled === false) continue
      const period = config?.cycleTimeMs || DEFAULT_INTERRUPT_MS
      this.interruptHandles.push(setInterval(() => this.runCyclicInterrupt(number), period))
    }
  }

  private clearTimers(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    this.intervalHandle = null
    for (const handle of this.interruptHandles) clearInterval(handle)
    this.interruptHandles = []
  }

  public stop(): void {
    if (this.state === 'STOP') return
    this.clearTimers()
    this.state = 'STOP'
    this.onStateChangeCallback?.(this.state)
  }

  /** Program error or double watchdog overrun: the CPU leaves RUN and reports why. */
  private faultStop(message: string): void {
    this.addDiagnostic(message, 'error')
    this.clearTimers()
    this.frames = []
    this.state = 'ERROR'
    this.onStateChangeCallback?.(this.state)
  }

  public reset(): void {
    this.stop()
    this.clearTimers()
    this.state = 'STOP'
    this.memory.reset()
    LadderEvaluator.resetInternalStates()
    SclInterpreter.resetEdgeStates()
    this.timerStates = {}
    this.counterStates = {}
    this.forceOverrides.clear()
    this.cycleNumber = 0
    this.historyBuffer = []
    this.currentLadPowerStates = {}
    this.currentSclLineValues = {}
    this.dbEntries.clear()
    this.diagnostics = []
    this.reportedOnce.clear()

    if (this.projectPayload) {
      this.loadProject(this.projectPayload)
    }

    this.emitSnapshot(1)
  }

  public getState(): RuntimeOperatingState {
    return this.state
  }

  public getHistory(): RuntimeMemorySnapshot[] {
    return this.historyBuffer
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
    return this.historyBuffer.find((s) => s.cycleNumber === cycleNumber)
  }

  public jumpToLastEdge(symbolOrAddress: string): RuntimeMemorySnapshot | undefined {
    // Scan backward through history to find where bit changed value
    if (this.historyBuffer.length < 2) return undefined
    let lastVal: boolean | null = null

    for (let i = this.historyBuffer.length - 1; i >= 0; i--) {
      const snap = this.historyBuffer[i]
      const curVal = !!this.getVariableFromSnapshot(snap, symbolOrAddress)
      if (lastVal !== null && curVal !== lastVal) {
        return snap
      }
      lastVal = curVal
    }
    return undefined
  }

  private getVariableFromSnapshot(snapshot: RuntimeMemorySnapshot, symbolOrAddress: string): unknown {
    const raw = symbolOrAddress.trim()
    const upper = raw.toUpperCase()
    if (upper.startsWith('%') || /^[IQM]/.test(upper)) {
      const parsed = parseS7Address(upper)
      if (parsed.isValid && parsed.sizeCategory === 'BIT') {
        const buf = parsed.area === 'I' ? snapshot.pii : parsed.area === 'Q' ? snapshot.piq : snapshot.merker
        const byte = parsed.byteAddress
        const bit = parsed.bitAddress || 0
        return ((buf[byte] || 0) & (1 << bit)) !== 0
      }
    }
    return undefined
  }

  public setForcedValue(addressOrSymbol: string, value: unknown, active: boolean): void {
    const key = addressOrSymbol.trim().toUpperCase()
    if (active) {
      this.forceOverrides.set(key, value)
      this.memory.forceOverrides.set(key, value)
    } else {
      this.forceOverrides.delete(key)
      this.memory.forceOverrides.delete(key)
    }
    // Also apply immediately
    this.setVariable(addressOrSymbol, value)
  }

  public clearAllForcedValues(): void {
    this.forceOverrides.clear()
    this.memory.forceOverrides.clear()
  }

  public setPhysicsHook(hook?: (dtSeconds: number, engine: PlcRuntimeEngine) => void): void {
    this.physicsHook = hook
  }

  public injectHardwareFault(channel: string = '%IW64'): void {
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
  private runCyclicScan(): void {
    if (this.state !== 'RUN') return

    const startTime = performance.now()
    this.cycleNumber++

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
    this.applyForces()

    this.runOb(1)

    this.applyForces()
    this.syncInstanceStates()
    this.syncAllTagMonitorValues()

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

    this.emitSnapshot(1)
  }

  private watchdogLimit(): number {
    return this.projectPayload?.hardware?.general?.cycleWatchdogTimeMs || 150
  }

  /** Over the limit: time error and OB80. Over twice the limit: STOP. */
  private checkWatchdog(durationMs: number): void {
    if (this.state !== 'RUN') return
    const limit = this.watchdogLimit()
    if (durationMs > limit * 2) {
      this.faultStop(`Cycle time ${durationMs.toFixed(1)} ms exceeded twice the watchdog limit of ${limit} ms`)
    } else if (durationMs > limit) {
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
    const family = getCpuProfile(this.projectPayload?.hardware?.general?.targetCpu)?.family
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
    for (const [key, t] of this.memory.timerStates.entries()) {
      this.timerStates[key] = { IN: t.IN, Q: t.Q, PT: t.PT, ET: Math.round(t.ET) }
    }
    for (const [key, c] of this.memory.counterStates.entries()) {
      this.counterStates[key] = { CU: c.CU, CD: c.CD, R: c.R, PV: c.PV, QU: c.QU, QD: c.QD, CV: c.CV }
    }
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
    this.runOb(number)
    this.applyForces()
  }

  /**
   * Executes OB82 (Diagnostic Fault)
   */
  private executeOb82(_faultChannel: string): void {
    this.runOb(82)
    this.emitSnapshot(82)
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
    return { bytes: entry.bytes, view: entry.view, base: 0, layout: entry.layout, path: entry.name }
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
    const inputs = new Map(Object.entries(call.inputs).map(([k, v]) => [k.toUpperCase(), v]))
    const has = (n: string): boolean => inputs.has(n)
    const bool = (n: string, fallback: boolean): boolean => (has(n) ? !!inputs.get(n) : fallback)
    const num = (n: string, fallback: number): number => (has(n) ? Number(inputs.get(n)) || 0 : fallback)
    const out = (n: string, value: unknown): void => {
      const writerKey = Object.keys(call.writers).find((k) => k.toUpperCase() === n)
      if (writerKey) call.writers[writerKey](value)
    }
    const now = this.clock()

    if (kind === 'TON' || kind === 'TOF' || kind === 'TP') {
      const current = this.memory.getTimer(key)
      const inVal = bool('IN', current.IN)
      const pt = num('PT', current.PT)
      const t =
        kind === 'TON'
          ? this.memory.updateTonTimer(key, inVal, pt, now)
          : kind === 'TOF'
            ? this.memory.updateTofTimer(key, inVal, pt, now)
            : this.memory.updateTpTimer(key, inVal, pt, now)
      out('Q', t.Q)
      out('ET', t.ET)
    } else if (kind === 'R_TRIG' || kind === 'F_TRIG') {
      const e = this.memory.updateEdge(key, kind, bool('CLK', false))
      out('Q', e.Q)
    } else {
      const current = this.memory.getCounter(key)
      const pv = num('PV', current.PV)
      const c =
        kind === 'CTU'
          ? this.memory.updateCtuCounter(key, bool('CU', false), bool('R', false), pv)
          : kind === 'CTD'
            ? this.memory.updateCtdCounter(key, bool('CD', false), bool('LD', false), pv)
            : this.memory.updateCtudCounter(key, bool('CU', false), bool('CD', false), bool('R', false), bool('LD', false), pv)
      out('Q', kind === 'CTD' ? c.QD : c.QU)
      out('QU', c.QU)
      out('QD', c.QD)
      out('CV', c.CV)
    }
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
      canCall: (name, quoted) => this.resolveCallee(name, quoted) !== null,
      callBlock: (call) => this.callBlock(call),
      hasSymbol: (symbol, quoted) => this.hasSymbol(symbol, quoted),
      resolveInstanceKey: (name, quoted) => this.resolveInstanceKey(name, quoted),
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
    const upperKey = key.toUpperCase()
    if (this.memory.edgeStates.has(upperKey)) {
      const e = this.memory.getEdge(upperKey)
      return field === 'CLK' ? e.CLK : e.Q
    }
    const isCounter = this.memory.counterStates.has(upperKey) || ['QU', 'QD', 'CV', 'PV', 'CU', 'CD', 'R', 'LD'].includes(field)
    if (isCounter) {
      const c = this.memory.getCounter(upperKey)
      const values: Record<string, unknown> = { Q: c.QU, QU: c.QU, QD: c.QD, CV: c.CV, PV: c.PV, CU: c.CU, CD: c.CD, R: c.R, LD: c.LD }
      return values[field]
    }
    const t = this.memory.getTimer(upperKey)
    const values: Record<string, unknown> = { Q: t.Q, ET: Math.round(t.ET), IN: t.IN, PT: t.PT }
    return values[field]
  }

  private writeInstanceField(key: string, field: string, value: unknown): void {
    const upperKey = key.toUpperCase()
    const isCounter = this.memory.counterStates.has(upperKey) || ['QU', 'QD', 'CV', 'PV', 'CU', 'CD', 'R', 'LD'].includes(field)
    if (isCounter) {
      const c = this.memory.getCounter(upperKey) as unknown as Record<string, unknown>
      if (field === 'Q') c.QU = !!value
      else c[field] = typeof c[field] === 'boolean' ? !!value : Number(value) || 0
      this.syncInstanceStates()
      return
    }
    const t = this.memory.getTimer(upperKey) as unknown as Record<string, unknown>
    if (field in t) t[field] = typeof t[field] === 'boolean' ? !!value : Number(value) || 0
    this.syncInstanceStates()
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
    if (this.forceOverrides.size === 0) return { found: false }
    const upper = clean.toUpperCase()
    if (this.forceOverrides.has(upper)) return { found: true, value: this.forceOverrides.get(upper) }

    this.refreshTagIndex()
    const tag = this.tagByName.get(clean.toLowerCase())
    if (tag?.address && this.forceOverrides.has(tag.address.toUpperCase())) {
      return { found: true, value: this.forceOverrides.get(tag.address.toUpperCase()) }
    }
    const byAddress = this.tagByAddress.get(this.normalizeAddress(clean))
    if (byAddress && this.forceOverrides.has(byAddress.name.toUpperCase())) {
      return { found: true, value: this.forceOverrides.get(byAddress.name.toUpperCase()) }
    }
    return { found: false }
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
      if (segments.length === 1) return readValue(entry.bytes, entry.view, entry.layout, 0, 0)
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
    if (/^C\d+$/i.test(clean)) return this.memory.getCounter(clean).QU

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
      if (segments.length === 1) {
        writeValue(entry.bytes, entry.view, entry.layout, 0, 0, value)
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
      tag.monitorValue = value as string | number | boolean
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
    const upper = name.toUpperCase()
    return this.memory.timerStates.has(upper) || this.memory.counterStates.has(upper) || this.memory.edgeStates.has(upper)
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

  private typeOfSymbol(symbol: string, quotedHint?: boolean): string | undefined {
    const { clean, quoted } = this.splitName(symbol, quotedHint)
    const nameOf = (type: S7Type): string | undefined => (type.kind === 'elementary' ? type.name : undefined)

    if (!quoted && this.frames.length > 0) {
      const local = this.resolveLocal(clean)
      if (local) {
        if (local.loc.instanceMember) return local.loc.instanceMember === 'Q' ? 'BOOL' : 'DINT'
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
      return loc ? nameOf(loc.type) : undefined
    }
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

  private syncAllTagMonitorValues(): void {
    for (const table of this.getLiveTagTables()) {
      for (const tag of table.tags || []) {
        const liveVal = tag.address ? this.getVariable(tag.address) : tag.name ? this.getVariable(tag.name) : undefined
        if (liveVal !== undefined) tag.monitorValue = liveVal as string | number | boolean
      }
    }
  }

  // Bit/Byte/Word/DWord helpers - routed directly through S7BinaryMemory
  public getBit(area: 'I' | 'Q' | 'M' | 'DB', byte: number, bit: number): boolean {
    return this.memory.readBit(area, byte, bit)
  }

  public setBit(area: 'I' | 'Q' | 'M' | 'DB', byte: number, bit: number, val: boolean): void {
    this.memory.writeBit(area, byte, bit, val)
  }

  public getByte(area: 'I' | 'Q' | 'M' | 'DB', byte: number): number {
    return this.memory.readByte(area, byte)
  }

  public setByte(area: 'I' | 'Q' | 'M' | 'DB', byte: number, val: number): void {
    this.memory.writeByte(area, byte, val)
  }

  public getWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number): number {
    return this.memory.readWord(area, byte)
  }

  public setWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number, val: number): void {
    this.memory.writeWord(area, byte, val)
  }

  public getDWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number): number {
    return this.memory.readDWord(area, byte)
  }

  public setDWord(area: 'I' | 'Q' | 'M' | 'DB', byte: number, val: number): void {
    this.memory.writeDWord(area, byte, val)
  }

  private decodeDataBlocks(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const entry of this.dbEntries.values()) {
      out[entry.name] = readValue(entry.bytes, entry.view, entry.layout, 0, 0) as Record<string, unknown>
    }
    return out
  }

  /** Copies an area up to its last used byte; readers treat bytes past the end as zero. */
  private trimmedCopy(area: Uint8Array): Uint8Array {
    let end = area.length
    while (end > 0 && area[end - 1] === 0) end--
    return area.slice(0, end)
  }

  /**
   * Emits snapshot and maintains the 1,000-cycle circular ring buffer
   */
  private emitSnapshot(triggeringOb: number): void {
    const snapshot: RuntimeMemorySnapshot = {
      cycleNumber: this.cycleNumber,
      timestamp: this.clock(),
      triggeringOb,
      cycleDurationMs: this.lastCycleDurationMs,
      pii: this.trimmedCopy(this.pii),
      piq: this.trimmedCopy(this.piq),
      merker: this.trimmedCopy(this.merker),
      dataBlocks: this.decodeDataBlocks(),
      ladPowerState: { ...this.currentLadPowerStates },
      sclLineValues: JSON.parse(JSON.stringify(this.currentSclLineValues))
    }

    // Add to 1,000-cycle ring buffer
    this.historyBuffer.push(snapshot)
    if (this.historyBuffer.length > this.MAX_HISTORY) {
      this.historyBuffer.shift()
    }

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
