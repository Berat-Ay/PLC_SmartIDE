import {
  RuntimeMemorySnapshot,
  RuntimeOperatingState,
  RuntimeWorkerMetrics
} from '@shared/types/runtime'
import { parseS7Address } from '@shared/constants/s7rules'
import { SclExecutionContext, SclInterpreter } from './SclInterpreter'
import { LadderEvaluator } from './LadderEvaluator'
import { S7BinaryMemory } from './S7BinaryMemory'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { TagTable } from '@shared/types/tags'
import { LadBlockDefinition, SclBlockDefinition, DataBlockDefinition } from '@shared/types/blocks'
import { useTagStore } from '../stores/useTagStore'
import { useBlockStore } from '../stores/useBlockStore'

export class PlcRuntimeEngine {
  private state: RuntimeOperatingState = 'STOP'
  private cycleNumber = 0
  private lastCycleDurationMs = 0
  private averageCycleDurationMs = 0
  private maxCycleDurationMs = 0
  private activeObs = 'OB1'
  private intervalHandle: NodeJS.Timeout | null = null
  private ob30IntervalHandle: NodeJS.Timeout | null = null

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

  private dataBlocks: Record<string, Record<string, unknown>> = {}
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
    if (payload) {
      this.loadProject(payload)
    }
  }

  public setOnSnapshot(cb: (snapshot: RuntimeMemorySnapshot, metrics: RuntimeWorkerMetrics) => void): void {
    this.onSnapshotCallback = cb
  }

  public setOnStateChange(cb: (state: RuntimeOperatingState) => void): void {
    this.onStateChangeCallback = cb
  }

  public loadProject(payload: ProjectLoadPayload): void {
    LadderEvaluator.resetInternalStates()
    this.timerStates = {}
    this.counterStates = {}
    this.forceOverrides.clear()
    this.projectPayload = payload

    // Initialize DataBlock state from variables start values
    this.dataBlocks = {}
    for (const db of payload.dataBlocks) {
      const vars: Record<string, unknown> = {}
      for (const v of db.variables) {
        if (v.dataType === 'BOOL') {
          vars[v.name] = v.defaultValue?.toUpperCase() === 'TRUE'
        } else if (v.dataType === 'INT' || v.dataType === 'DINT' || v.dataType === 'REAL') {
          vars[v.name] = Number(v.defaultValue) || 0
        } else {
          vars[v.name] = v.defaultValue || ''
        }
      }
      this.dataBlocks[db.name] = vars
    }

    // Default System Memory bits
    if (payload.hardware.systemMemory.enabled) {
      const byte = payload.hardware.systemMemory.byteAddress
      this.setBit('M', byte, 2, true) // AlwaysTrue
      this.setBit('M', byte, 3, false) // AlwaysFalse
    }
  }

  public start(): void {
    if (this.state === 'RUN') return

    LadderEvaluator.resetInternalStates()
    this.state = 'RUN'
    this.onStateChangeCallback?.(this.state)

    // S7 STOP -> RUN transition:
    // Set FirstScan = TRUE
    if (this.projectPayload?.hardware.systemMemory.enabled) {
      const byte = this.projectPayload.hardware.systemMemory.byteAddress
      this.setBit('M', byte, 0, true) // FirstScan
      this.setBit('M', byte, 2, true) // AlwaysTrue
      this.setBit('M', byte, 3, false) // AlwaysFalse
    }

    // Execute OB100 (Startup OB) once
    this.executeOb100()

    // Start cyclic scan (10ms tick)
    this.intervalHandle = setInterval(() => {
      this.runCyclicScan()
    }, 10)

    // Start OB30 Cyclic Interrupt (100ms tick)
    this.ob30IntervalHandle = setInterval(() => {
      this.runCyclicInterruptOb30()
    }, 100)
  }

  public stop(): void {
    if (this.state === 'STOP') return

    if (this.intervalHandle) clearInterval(this.intervalHandle)
    if (this.ob30IntervalHandle) clearInterval(this.ob30IntervalHandle)
    this.intervalHandle = null
    this.ob30IntervalHandle = null

    this.state = 'STOP'
    this.onStateChangeCallback?.(this.state)
  }

  public reset(): void {
    this.stop()
    this.memory.reset()
    LadderEvaluator.resetInternalStates()
    this.timerStates = {}
    this.counterStates = {}
    this.forceOverrides.clear()
    this.cycleNumber = 0
    this.historyBuffer = []
    this.currentLadPowerStates = {}
    this.currentSclLineValues = {}

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
    try {
      const storeTables = useTagStore.getState().tagTables
      if (storeTables && storeTables.length > 0) {
        return storeTables
      }
    } catch {
      // In standalone tests or non-browser env
    }
    return this.projectPayload?.tagTables || []
  }

  public getLiveLadBlocks(): LadBlockDefinition[] {
    try {
      const storeBlocks = useBlockStore.getState().ladBlocks
      if (storeBlocks && storeBlocks.length > 0) {
        return storeBlocks
      }
    } catch {
      // In standalone tests or non-browser env
    }
    return this.projectPayload?.ladBlocks || []
  }

  public getLiveSclBlocks(): SclBlockDefinition[] {
    try {
      const storeBlocks = useBlockStore.getState().sclBlocks
      if (storeBlocks && storeBlocks.length > 0) {
        return storeBlocks
      }
    } catch {
      // In standalone tests or non-browser env
    }
    return this.projectPayload?.sclBlocks || []
  }

  public getLiveDataBlocks(): DataBlockDefinition[] {
    try {
      const storeBlocks = useBlockStore.getState().dataBlocks
      if (storeBlocks && storeBlocks.length > 0) {
        return storeBlocks
      }
    } catch {
      // In standalone tests or non-browser env
    }
    return this.projectPayload?.dataBlocks || []
  }

  public getMetrics(): RuntimeWorkerMetrics {
    return {
      cycleNumber: this.cycleNumber,
      lastCycleDurationMs: this.lastCycleDurationMs,
      averageCycleDurationMs: this.averageCycleDurationMs,
      maxCycleDurationMs: this.maxCycleDurationMs,
      watchdogLimitMs: this.projectPayload?.hardware.general.cycleWatchdogTimeMs || 150,
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
    if (this.projectPayload?.hardware.systemMemory.enabled) {
      const byte = this.projectPayload.hardware.systemMemory.byteAddress
      this.setBit('M', byte, 1, true)
    }

    // Trigger OB82 Diagnostic Interrupt
    this.executeOb82(channel)
  }

  public clearHardwareFault(channel: string = '%IW64'): void {
    // Reset CPU Diagnostic Status bit (%M1.1)
    if (this.projectPayload?.hardware.systemMemory.enabled) {
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

    try {
      const startTime = performance.now()
      this.cycleNumber++

      // 0. Execute Closed-Loop Plant Physics Hook (if registered)
      if (this.physicsHook) {
        try {
          this.physicsHook(0.01, this)
        } catch (err) {
          console.error('Error executing plant physics hook:', err)
        }
      }

      // 1. Generate S7 Clock Memory square waves
      this.updateClockMemory()

      // 2. Build execution context
      const context = this.createExecutionContext()

      // 3. Execute OB1 (LAD networks & called SCL blocks)
      this.executeOb1(context)

      // Sync tag monitor values to useTagStore
      this.syncAllTagMonitorValues()

      // 4. Clear FirstScan bit after scan cycle #1
      if (this.cycleNumber === 1 && this.projectPayload?.hardware?.systemMemory?.enabled) {
        const byte = this.projectPayload.hardware.systemMemory.byteAddress
        this.setBit('M', byte, 0, false)
      }

      const duration = Math.max(0.1, performance.now() - startTime)
      this.lastCycleDurationMs = Math.round(duration * 100) / 100
      this.averageCycleDurationMs =
        Math.round(((this.averageCycleDurationMs * 0.9) + (this.lastCycleDurationMs * 0.1)) * 100) / 100
      this.maxCycleDurationMs = Math.max(this.maxCycleDurationMs, this.lastCycleDurationMs)

      // 5. Emit snapshot and record in circular ring buffer
      this.emitSnapshot(1)
    } catch (err) {
      console.error('Error in cyclic scan:', err)
    }
  }

  /**
   * Generates authentic Siemens S7 Clock Memory byte (%MB0) frequencies:
   * 10Hz, 5Hz, 2.5Hz, 2Hz, 1.25Hz, 1Hz, 0.625Hz, 0.5Hz
   */
  private updateClockMemory(): void {
    if (!this.projectPayload?.hardware.clockMemory.enabled) return
    const byte = this.projectPayload.hardware.clockMemory.byteAddress
    const now = Date.now()

    // 10 Hz: period 100ms (50ms on / 50ms off)
    this.setBit('M', byte, 0, (now % 100) < 50)
    // 5 Hz: period 200ms
    this.setBit('M', byte, 1, (now % 200) < 100)
    // 2.5 Hz: period 400ms
    this.setBit('M', byte, 2, (now % 400) < 200)
    // 2 Hz: period 500ms
    this.setBit('M', byte, 3, (now % 500) < 250)
    // 1.25 Hz: period 800ms
    this.setBit('M', byte, 4, (now % 800) < 400)
    // 1 Hz: period 1000ms
    this.setBit('M', byte, 5, (now % 1000) < 500)
    // 0.625 Hz: period 1600ms
    this.setBit('M', byte, 6, (now % 1600) < 800)
    // 0.5 Hz: period 2000ms
    this.setBit('M', byte, 7, (now % 2000) < 1000)
  }

  /**
   * Executes OB1
   */
  private executeOb1(context: SclExecutionContext): void {
    const ladBlocks = this.getLiveLadBlocks()
    const now = Date.now()

    // Find OB1 LAD block
    const ob1Lad =
      ladBlocks.find((b) => (b.blockNumber === 1 || (b as any).number === 1) && b.blockType === 'OB') ||
      ladBlocks.find((b) => b.fileName === 'OB1_Main.lad.json' || b.name?.includes('OB1')) ||
      ladBlocks[0]
    if (ob1Lad && ob1Lad.networks) {
      for (const net of ob1Lad.networks) {
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
          now,
          this.memory
        )
        Object.assign(this.currentLadPowerStates, evalRes.nodePowerStates)
      }

      // Sync live timer states from binary memory into PlcRuntimeEngine
      for (const [key, tState] of this.memory.timerStates.entries()) {
        this.timerStates[key] = {
          IN: tState.IN,
          Q: tState.Q,
          PT: tState.PT || 10000,
          ET: Math.round(tState.ET)
        }
      }
      for (const [key, cState] of this.memory.counterStates.entries()) {
        this.counterStates[key] = {
          CU: cState.CU,
          CD: cState.CD,
          R: cState.R,
          PV: cState.PV,
          QU: cState.QU,
          QD: cState.QD,
          CV: cState.CV
        }
      }
    }

    // Also execute FB1_PumpControl logic if present
    const sclBlocks = this.getLiveSclBlocks()
    const fb1 = sclBlocks.find((b) => b.name === 'FB1_PumpControl')
    if (fb1) {
      const lineVals: Record<number, string | number> = {}
      SclInterpreter.execute(fb1.code, {
        ...context,
        lineValues: lineVals
      })
      this.currentSclLineValues[fb1.fileName] = lineVals
    }
  }

  /**
   * Executes OB100 (Startup)
   */
  private executeOb100(): void {
    const context = this.createExecutionContext()
    const ob100 = this.projectPayload?.ladBlocks.find((b) => b.blockNumber === 100 && b.blockType === 'OB')
    if (ob100) {
      for (const net of ob100.networks) {
        LadderEvaluator.evaluateNetwork(
          {
            id: `net_${net.networkNumber}`,
            networkNumber: net.networkNumber,
            title: net.title,
            nodes: net.nodes || []
          },
          context,
          Date.now()
        )
      }
    }
  }

  /**
   * Executes OB30 (100ms Cyclic Interrupt for PID header)
   */
  private runCyclicInterruptOb30(): void {
    if (this.state !== 'RUN') return
    const context = this.createExecutionContext()
    const ob30 = this.projectPayload?.sclBlocks.find((b) => b.blockNumber === 30 && b.blockType === 'OB')
    if (ob30) {
      const lineVals: Record<number, string | number> = {}
      SclInterpreter.execute(ob30.code, {
        ...context,
        lineValues: lineVals
      })
      this.currentSclLineValues[ob30.fileName] = lineVals
    }
  }

  /**
   * Executes OB82 (Diagnostic Fault)
   */
  private executeOb82(faultChannel: string): void {
    const context = this.createExecutionContext()
    context.setVar('FaultChannel', faultChannel)

    const ob82 = this.projectPayload?.ladBlocks.find((b) => b.blockNumber === 82 && b.blockType === 'OB')
    if (ob82) {
      for (const net of ob82.networks) {
        LadderEvaluator.evaluateNetwork(
          {
            id: `net_${net.networkNumber}`,
            networkNumber: net.networkNumber,
            title: net.title,
            nodes: net.nodes || []
          },
          context,
          Date.now()
        )
      }
    }

    const ob82Scl = this.projectPayload?.sclBlocks.find((b) => b.blockNumber === 82 && b.blockType === 'OB')
    if (ob82Scl) {
      const lineVals: Record<number, string | number> = {}
      SclInterpreter.execute(ob82Scl.code, {
        ...context,
        lineValues: lineVals
      })
      this.currentSclLineValues[ob82Scl.fileName] = lineVals
    }

    // Emit diagnostic snapshot
    this.emitSnapshot(82)
  }

  /**
   * Creates an execution context that resolves symbols and addresses
   */
  public createExecutionContext(): SclExecutionContext {
    return {
      getVar: (symbol: string) => this.getVariable(symbol),
      setVar: (symbol: string, value: unknown) => this.setVariable(symbol, value)
    }
  }

  /**
   * Resolves variable reading
   */
  public getVariable(symbolOrAddress: string): unknown {
    if (!symbolOrAddress) return 0
    const raw = symbolOrAddress.trim()
    const cleanSym = raw.replace(/^"|"$/g, '').trim()
    const upper = cleanSym.toUpperCase()

    // 1. Check Forced Overrides (by direct key)
    if (this.forceOverrides.has(upper)) {
      return this.forceOverrides.get(upper)
    }

    const tagResolver = (name: string) => {
      const tagTables = this.getLiveTagTables()
      for (const table of tagTables) {
        const tag = table.tags?.find(
          (t) =>
            (t.name && t.name.toLowerCase() === name.toLowerCase()) ||
            (t.address && t.address.toUpperCase() === name.toUpperCase())
        )
        if (tag) return { address: tag.address, dataType: tag.dataType }
      }
      return undefined
    }

    // 2. Native Timer or Counter sub-bit
    if (/^[A-Za-z0-9_]+\.(Q|ET|IN|PT|QU|QD|CV|PV|CU|CD|R|LD)$/i.test(cleanSym) || /^[TC]\d+$/i.test(cleanSym)) {
      return this.memory.getVariable(cleanSym, tagResolver)
    }

    // 3. Direct S7 Physical Address (%I, %Q, %M, %DB)
    const resolved = this.memory.resolveAddress(cleanSym)
    if (resolved) {
      // Also check if any tag with this address has a forced override by symbol name
      const tagTables = this.getLiveTagTables()
      const normParsed = (resolved.raw.startsWith('%') ? resolved.raw : `%${resolved.raw}`).toUpperCase()
      for (const table of tagTables) {
        const t = table.tags?.find((tag) => tag.address && tag.address.toUpperCase() === normParsed)
        if (t && this.forceOverrides.has(t.name.toUpperCase())) {
          return this.forceOverrides.get(t.name.toUpperCase())
        }
      }
      return this.memory.getVariable(cleanSym, tagResolver)
    }

    // 4. DB Member reference: "DB1_PlantData".SystemPressureBar or DB1_PlantData.Pump1.StartCmd
    if (cleanSym.includes('.')) {
      const parts = cleanSym.split('.')
      const dbName = parts[0]
      if (this.dataBlocks[dbName]) {
        let current: unknown = this.dataBlocks[dbName]
        for (const part of parts.slice(1)) {
          if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
            current = (current as Record<string, unknown>)[part]
          } else {
            return undefined
          }
        }
        return current
      }
    }

    // 5. Live Tag Tables lookup
    const tag = tagResolver(cleanSym)
    if (tag) {
      if (tag.address && this.forceOverrides.has(tag.address.toUpperCase())) {
        return this.forceOverrides.get(tag.address.toUpperCase())
      }
      if (tag.address) {
        return this.getVariable(tag.address)
      }
    }

    // 6. Look in Data Blocks for bare variable name
    for (const dbName of Object.keys(this.dataBlocks)) {
      if (cleanSym in this.dataBlocks[dbName]) {
        return this.dataBlocks[dbName][cleanSym]
      }
    }

    return 0
  }

  /**
   * Resolves variable writing
   */
  public setVariable(symbolOrAddress: string, value: unknown): void {
    if (!symbolOrAddress) return
    const raw = symbolOrAddress.trim()
    const cleanSym = raw.replace(/^"|"$/g, '').trim()
    const upper = cleanSym.toUpperCase()

    const tagResolver = (name: string) => {
      const tagTables = this.getLiveTagTables()
      for (const table of tagTables) {
        const tag = table.tags?.find(
          (t) =>
            (t.name && t.name.toLowerCase() === name.toLowerCase()) ||
            (t.address && t.address.toUpperCase() === name.toUpperCase())
        )
        if (tag) return { address: tag.address, dataType: tag.dataType }
      }
      return undefined
    }

    // 1. Write to S7BinaryMemory
    this.memory.setVariable(cleanSym, value, tagResolver)

    // Sync legacy timerStates and counterStates map if applicable
    const timerMatch = cleanSym.match(/^([A-Za-z0-9_]+)\.(Q|ET|IN|PT)$/i)
    if (timerMatch) {
      const inst = timerMatch[1].toUpperCase()
      const t = this.memory.getTimer(inst)
      this.timerStates[inst] = { IN: t.IN, Q: t.Q, PT: t.PT, ET: t.ET }
      const tEval = LadderEvaluator.getTimerState(inst)
      if (tEval) {
        tEval.q = t.Q
        tEval.elapsed = t.ET
        tEval.running = t.IN
        tEval.ptVal = t.PT
      }
      return
    }

    const counterMatch = cleanSym.match(/^([A-Za-z0-9_]+)\.(QU|QD|CV|PV|CU|CD|R|LD)$/i)
    if (counterMatch) {
      const inst = counterMatch[1].toUpperCase()
      const c = this.memory.getCounter(inst)
      this.counterStates[inst] = { CU: c.CU, CD: c.CD, R: c.R, PV: c.PV, QU: c.QU, QD: c.QD, CV: c.CV }
      const cEval = LadderEvaluator.getCounterState(inst)
      if (cEval) {
        cEval.q = c.QU
        cEval.cv = c.CV
      }
      return
    }

    // 2. Direct S7 Address - sync Tag monitor value
    const resolved = this.memory.resolveAddress(cleanSym)
    if (resolved) {
      const normAddress = resolved.raw.startsWith('%') ? resolved.raw : `%${resolved.raw}`
      this.syncTagMonitorValue(normAddress, value)
      return
    }

    // 3. DB Member: "DB1_PlantData".Pump1.StartCmd
    if (cleanSym.includes('.')) {
      const parts = cleanSym.split('.')
      const dbName = parts[0]
      if (this.dataBlocks[dbName]) {
        let current: Record<string, unknown> = this.dataBlocks[dbName]
        for (let i = 1; i < parts.length - 1; i++) {
          const part = parts[i]
          if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {}
          }
          current = current[part] as Record<string, unknown>
        }
        current[parts[parts.length - 1]] = value
        return
      }
    }

    // 4. Tag symbol mapping
    const tagTables = this.getLiveTagTables()
    for (const table of tagTables) {
      const tag = table.tags?.find(
        (t) =>
          (t.name && t.name.toLowerCase() === cleanSym.toLowerCase()) ||
          (t.address && t.address.toUpperCase() === upper)
      )
      if (tag) {
        if (tag.address) {
          this.setVariable(tag.address, value)
        }
        tag.monitorValue = value as string | number | boolean
        return
      }
    }

    // 5. Default: write to DB
    for (const dbName of Object.keys(this.dataBlocks)) {
      if (cleanSym in this.dataBlocks[dbName]) {
        this.dataBlocks[dbName][cleanSym] = value
        return
      }
    }
  }

  private syncTagMonitorValue(address: string, value: unknown): void {
    try {
      const { tagTables } = useTagStore.getState()
      if (!tagTables) return
      for (const table of tagTables) {
        for (const tag of table.tags) {
          if (tag.address && address && tag.address.toUpperCase() === address.toUpperCase()) {
            tag.monitorValue = value as string | number | boolean
          }
        }
      }
    } catch {
      // In tests or outside React
    }
  }

  private syncAllTagMonitorValues(): void {
    try {
      const { tagTables } = useTagStore.getState()
      if (!tagTables) return
      for (const table of tagTables) {
        for (const tag of table.tags) {
          const liveVal = tag.address
            ? this.getVariable(tag.address)
            : tag.name
            ? this.getVariable(tag.name)
            : undefined
          if (liveVal !== undefined) {
            tag.monitorValue = liveVal as string | number | boolean
          }
        }
      }
    } catch {
      // In tests or outside React
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

  /**
   * Emits snapshot and maintains the 1,000-cycle circular ring buffer
   */
  private emitSnapshot(triggeringOb: number): void {
    const snapshot: RuntimeMemorySnapshot = {
      cycleNumber: this.cycleNumber,
      timestamp: Date.now(),
      triggeringOb,
      cycleDurationMs: this.lastCycleDurationMs,
      pii: Array.from(this.pii),
      piq: Array.from(this.piq),
      merker: Array.from(this.merker),
      dataBlocks: JSON.parse(JSON.stringify(this.dataBlocks)),
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
      watchdogLimitMs: this.projectPayload?.hardware.general.cycleWatchdogTimeMs || 150,
      state: this.state,
      activeObs: this.activeObs
    }

    this.onSnapshotCallback?.(snapshot, metrics)
  }
}
