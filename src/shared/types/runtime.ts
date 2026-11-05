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

export interface ForceOverride {
  addressOrSymbol: string
  forcedValue: boolean | number | string
  active: boolean
}

// Commands from Main/Renderer to Worker
export type RuntimeWorkerCommand =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'RESET' }
  | { type: 'INJECT_FAULT'; faultCode: number; channel: string }
  | { type: 'FORCE_VALUE'; addressOrSymbol: string; value: boolean | number | string; force: boolean }
  | { type: 'UPDATE_PROJECT_STATE'; payload: unknown }
  | { type: 'SCRUB_CYCLE'; cycleNumber: number }
  | { type: 'RESUME_LIVE' }

// Messages from Worker to Main/Renderer
export type RuntimeWorkerMessage =
  | { type: 'STATE_CHANGED'; state: RuntimeOperatingState }
  | { type: 'CYCLE_SNAPSHOT'; snapshot: RuntimeMemorySnapshot; metrics: RuntimeWorkerMetrics }
  | { type: 'SCRUB_SNAPSHOT'; snapshot: RuntimeMemorySnapshot }
  | { type: 'DIAGNOSTIC_ERROR'; message: string; ob: number }

