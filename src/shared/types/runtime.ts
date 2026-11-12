// Virtual S7 Runtime Engine Data Contracts (SoftPLC)

export type RuntimeOperatingState = 'RUN' | 'STOP' | 'PAUSED' | 'ERROR'

export interface RuntimeMemorySnapshot {
  cycleNumber: number
  timestamp: number
  triggeringOb: number // e.g. 1 (OB1), 30 (OB30), 82 (OB82), 100 (OB100)
  cycleDurationMs: number

  // Memory Areas
  // Each area is copied up to its last used byte; bytes past the end read as zero
  pii: Uint8Array // Process Image Inputs
  piq: Uint8Array // Process Image Outputs
  merker: Uint8Array // Bit Memory
  dataBlocks: Record<string, Record<string, unknown>> // dbName -> varName -> value

  // Active Ladder Node states: nodeId -> { powered: boolean, liveValues?: Record<string, string | number> }
  ladPowerState: Record<
    string,
    {
      powered: boolean
      rloIn?: boolean
      isConducting?: boolean
      bitValue?: boolean
      liveValues?: Record<string, string | number>
    }
  >

  // SCL Line inline monitoring values: fileName -> lineNumber -> expression/value
  sclLineValues: Record<string, Record<number, string | number>>
}

export interface RuntimeWorkerMetrics {
  cycleNumber: number
  lastCycleDurationMs: number
  averageCycleDurationMs: number
  maxCycleDurationMs: number
  watchdogLimitMs: number
  state: RuntimeOperatingState
  activeObs: string
}

