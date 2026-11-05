export type InputFilterDelay = '0.1 ms' | '0.8 ms' | '1.6 ms' | '3.2 ms' | '6.4 ms' | '12.8 ms'
export type AnalogMeasurementType = '4..20 mA' | '0..10 V' | '±10 V' | 'Deactivated'
export type AnalogOutputType = '4..20 mA' | '0..10 V' | 'Deactivated'
export type AnalogSmoothingFilter = 'None' | 'Weak' | 'Medium' | 'Strong'

export interface DigitalInputChannel {
  channelIndex: number
  address: string // e.g. %I0.0
  name: string
  filterDelay: InputFilterDelay
  enableRisingEdgeInterrupt: boolean
  enableFallingEdgeInterrupt: boolean
  comment?: string
}

export interface DigitalOutputChannel {
  channelIndex: number
  address: string // e.g. %Q0.0
  name: string
  comment?: string
}

export interface AnalogInputChannel {
  channelIndex: number
  address: string // e.g. %IW64
  name: string
  measurementType: AnalogMeasurementType
  scalingNote: string // '0..27648 Nominal Range'
  smoothing: AnalogSmoothingFilter
  wireBreakCheck: boolean
  overflowUnderflowCheck: boolean
  triggerOb82OnFault: boolean
  comment?: string
}

export interface AnalogOutputChannel {
  channelIndex: number
  address: string // e.g. %QW80
  name: string
  outputType: AnalogOutputType
  scalingNote: string
  comment?: string
}

export interface OrganizationBlockConfig {
  blockNumber: number // 1, 100, 30..38, 82
  name: string
  type: 'Cyclic' | 'Startup' | 'CyclicInterrupt' | 'DiagnosticInterrupt'
  enabled: boolean
  cycleTimeMs?: number // e.g., 100 ms for OB30
  phaseOffsetMs?: number
  priority: number
  description: string
}

export interface CpuConfig {
  general: {
    cpuName: string
    targetCpu?: string
    cycleWatchdogTimeMs: number // default 150
    minCycleTimeEnabled: boolean
    minCycleTimeMs: number
    retentiveMemory: {
      startByte: number
      byteCount: number
    }
  }
  systemMemory: {
    enabled: boolean
    byteAddress: number // default 1 -> MB1
  }
  clockMemory: {
    enabled: boolean
    byteAddress: number // default 0 -> MB0
  }
  digitalIO: {
    diStartByte: number // default 0 -> IB0..IB1
    dqStartByte: number // default 0 -> QB0..QB1
    diChannels: DigitalInputChannel[]
    dqChannels: DigitalOutputChannel[]
  }
  analogIO: {
    aiChannels: AnalogInputChannel[] // default 4 channels at IW64, IW66, IW68, IW70
    aqChannels: AnalogOutputChannel[] // default 2 channels at QW80, QW82
  }
  organizationBlocks: OrganizationBlockConfig[]
}
