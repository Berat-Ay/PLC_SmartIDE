import {
  DigitalInputChannel,
  DigitalOutputChannel,
  AnalogInputChannel,
  AnalogOutputChannel
} from '../types/hardware'

export interface CpuProfile {
  id: string
  family: 'S7-1200' | 'S7-1500'
  name: string
  orderNumber: string
  firmwareVersion: string
  workMemory: string
  loadMemory: string
  retentiveMemory: string
  inputBytes: number // Process image inputs
  outputBytes: number // Process image outputs
  merkerBytes: number // Bit memory
  defaultDiChannels: DigitalInputChannel[]
  defaultDqChannels: DigitalOutputChannel[]
  defaultAiChannels: AnalogInputChannel[]
  defaultAqChannels: AnalogOutputChannel[]
}

// 0. SIMATIC S7-1200 (CPU 1212C DC/DC/DC)
export const CPU_1212C_PROFILE: CpuProfile = {
  id: 'cpu-1212c',
  family: 'S7-1200',
  name: 'CPU 1212C DC/DC/DC',
  orderNumber: '6ES7 212-1AE40-0XB0',
  firmwareVersion: 'V4.6',
  workMemory: '75 KB',
  loadMemory: '2 MB',
  retentiveMemory: '10 KB',
  inputBytes: 1024,
  outputBytes: 1024,
  merkerBytes: 4096,
  defaultDiChannels: Array.from({ length: 8 }, (_, i) => ({
    channelIndex: i,
    address: `%I0.${i}`,
    name: `DI_Ch_${i}`,
    filterDelay: '3.2 ms',
    enableRisingEdgeInterrupt: false,
    enableFallingEdgeInterrupt: false,
    comment: `Digital input channel ${i}`
  })),
  defaultDqChannels: Array.from({ length: 6 }, (_, i) => ({
    channelIndex: i,
    address: `%Q0.${i}`,
    name: `DQ_Ch_${i}`,
    comment: `Digital output channel ${i}`
  })),
  defaultAiChannels: [
    {
      channelIndex: 0,
      address: '%IW64',
      name: 'AI_Channel_0',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'None',
      wireBreakCheck: false,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: false,
      comment: 'Analog input channel 0 (0..10V)'
    },
    {
      channelIndex: 1,
      address: '%IW66',
      name: 'AI_Channel_1',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'None',
      wireBreakCheck: false,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: false,
      comment: 'Analog input channel 1 (0..10V)'
    }
  ],
  defaultAqChannels: []
}

// 1. SIMATIC S7-1200 (CPU 1214C DC/DC/DC) - DEFAULT
export const CPU_1214C_PROFILE: CpuProfile = {
  id: 'cpu-1214c',
  family: 'S7-1200',
  name: 'CPU 1214C DC/DC/DC',
  orderNumber: '6ES7 214-1AG40-0XB0',
  firmwareVersion: 'V4.6',
  workMemory: '125 KB',
  loadMemory: '4 MB',
  retentiveMemory: '10 KB',
  inputBytes: 1024,
  outputBytes: 1024,
  merkerBytes: 8192,
  defaultDiChannels: Array.from({ length: 14 }, (_, i) => ({
    channelIndex: i,
    address: `%I${Math.floor(i / 8)}.${i % 8}`,
    name: i === 0 ? 'EmergencyStop' : i === 1 ? 'HydraulicPump_Start' : i === 2 ? 'TankLevel_HighSwitch' : `DI_Ch_${i}`,
    filterDelay: '3.2 ms',
    enableRisingEdgeInterrupt: i === 0,
    enableFallingEdgeInterrupt: false,
    comment: i === 0 ? 'Safety circuit channel (NC)' : `Digital input channel ${i}`
  })),
  defaultDqChannels: Array.from({ length: 10 }, (_, i) => ({
    channelIndex: i,
    address: `%Q${Math.floor(i / 8)}.${i % 8}`,
    name: i === 0 ? 'MainConveyor_Run' : i === 1 ? 'HydraulicPump_Run' : `DQ_Ch_${i}`,
    comment: `Digital output channel ${i}`
  })),
  defaultAiChannels: [
    {
      channelIndex: 0,
      address: '%IW64',
      name: 'TankLevel_Raw',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Medium',
      wireBreakCheck: true,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: true,
      comment: 'Analog input channel 0 (0..10V)'
    },
    {
      channelIndex: 1,
      address: '%IW66',
      name: 'ReactorTemp_Raw',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Weak',
      wireBreakCheck: false,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: false,
      comment: 'Analog input channel 1 (0..10V)'
    }
  ],
  defaultAqChannels: []
}

// 2. SIMATIC S7-1200 (CPU 1215C DC/DC/DC)
export const CPU_1215C_PROFILE: CpuProfile = {
  id: 'cpu-1215c',
  family: 'S7-1200',
  name: 'CPU 1215C DC/DC/DC',
  orderNumber: '6ES7 215-1AG40-0XB0',
  firmwareVersion: 'V4.6',
  workMemory: '150 KB',
  loadMemory: '4 MB',
  retentiveMemory: '10 KB',
  inputBytes: 1024,
  outputBytes: 1024,
  merkerBytes: 8192,
  defaultDiChannels: Array.from({ length: 14 }, (_, i) => ({
    channelIndex: i,
    address: `%I${Math.floor(i / 8)}.${i % 8}`,
    name: `DI_Ch_${i}`,
    filterDelay: '3.2 ms',
    enableRisingEdgeInterrupt: false,
    enableFallingEdgeInterrupt: false
  })),
  defaultDqChannels: Array.from({ length: 10 }, (_, i) => ({
    channelIndex: i,
    address: `%Q${Math.floor(i / 8)}.${i % 8}`,
    name: `DQ_Ch_${i}`
  })),
  defaultAiChannels: [
    {
      channelIndex: 0,
      address: '%IW64',
      name: 'AI_Channel_0',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'None',
      wireBreakCheck: true,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: true
    },
    {
      channelIndex: 1,
      address: '%IW66',
      name: 'AI_Channel_1',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'None',
      wireBreakCheck: false,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: false
    }
  ],
  defaultAqChannels: [
    {
      channelIndex: 0,
      address: '%QW64',
      name: 'AQ_Channel_0',
      outputType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range'
    },
    {
      channelIndex: 1,
      address: '%QW66',
      name: 'AQ_Channel_1',
      outputType: '0..10 V',
      scalingNote: '0..27648 Nominal Range'
    }
  ]
}

// 3. SIMATIC S7-1500 (CPU 1511-1 PN)
export const CPU_1511_PROFILE: CpuProfile = {
  id: 'cpu-1511',
  family: 'S7-1500',
  name: 'CPU 1511-1 PN',
  orderNumber: '6ES7 511-1AK02-0AB0',
  firmwareVersion: 'V2.9',
  workMemory: '225 KB',
  loadMemory: '12 MB',
  retentiveMemory: '128 KB',
  inputBytes: 32768,
  outputBytes: 32768,
  merkerBytes: 16384,
  defaultDiChannels: Array.from({ length: 16 }, (_, i) => ({
    channelIndex: i,
    address: `%I${Math.floor(i / 8)}.${i % 8}`,
    name: `DI_Ch_${i}`,
    filterDelay: '3.2 ms',
    enableRisingEdgeInterrupt: false,
    enableFallingEdgeInterrupt: false
  })),
  defaultDqChannels: Array.from({ length: 16 }, (_, i) => ({
    channelIndex: i,
    address: `%Q${Math.floor(i / 8)}.${i % 8}`,
    name: `DQ_Ch_${i}`
  })),
  defaultAiChannels: [
    {
      channelIndex: 0,
      address: '%IW64',
      name: 'AI_Channel_0',
      measurementType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Medium',
      wireBreakCheck: true,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: true
    },
    {
      channelIndex: 1,
      address: '%IW66',
      name: 'AI_Channel_1',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Weak',
      wireBreakCheck: false,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: false
    },
    {
      channelIndex: 2,
      address: '%IW68',
      name: 'AI_Channel_2',
      measurementType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Strong',
      wireBreakCheck: true,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: true
    },
    {
      channelIndex: 3,
      address: '%IW70',
      name: 'AI_Channel_3',
      measurementType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Medium',
      wireBreakCheck: true,
      overflowUnderflowCheck: false,
      triggerOb82OnFault: true
    }
  ],
  defaultAqChannels: [
    {
      channelIndex: 0,
      address: '%QW80',
      name: 'AQ_Channel_0',
      outputType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range'
    },
    {
      channelIndex: 1,
      address: '%QW82',
      name: 'AQ_Channel_1',
      outputType: '0..10 V',
      scalingNote: '0..27648 Nominal Range'
    }
  ]
}

// 4. SIMATIC S7-1500 (CPU 1516-3 PN/DP)
export const CPU_1516_PROFILE: CpuProfile = {
  id: 'cpu-1516',
  family: 'S7-1500',
  name: 'CPU 1516-3 PN/DP',
  orderNumber: '6ES7 516-3AN02-0AB0',
  firmwareVersion: 'V2.9',
  workMemory: '1.5 MB',
  loadMemory: '32 MB',
  retentiveMemory: '512 KB',
  inputBytes: 32768,
  outputBytes: 32768,
  merkerBytes: 16384,
  defaultDiChannels: Array.from({ length: 16 }, (_, i) => ({
    channelIndex: i,
    address: `%I${Math.floor(i / 8)}.${i % 8}`,
    name: `DI_Ch_${i}`,
    filterDelay: '3.2 ms',
    enableRisingEdgeInterrupt: false,
    enableFallingEdgeInterrupt: false
  })),
  defaultDqChannels: Array.from({ length: 16 }, (_, i) => ({
    channelIndex: i,
    address: `%Q${Math.floor(i / 8)}.${i % 8}`,
    name: `DQ_Ch_${i}`
  })),
  defaultAiChannels: [
    {
      channelIndex: 0,
      address: '%IW64',
      name: 'AI_Channel_0',
      measurementType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Medium',
      wireBreakCheck: true,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: true
    },
    {
      channelIndex: 1,
      address: '%IW66',
      name: 'AI_Channel_1',
      measurementType: '0..10 V',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Weak',
      wireBreakCheck: false,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: false
    },
    {
      channelIndex: 2,
      address: '%IW68',
      name: 'AI_Channel_2',
      measurementType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Strong',
      wireBreakCheck: true,
      overflowUnderflowCheck: true,
      triggerOb82OnFault: true
    },
    {
      channelIndex: 3,
      address: '%IW70',
      name: 'AI_Channel_3',
      measurementType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range',
      smoothing: 'Medium',
      wireBreakCheck: true,
      overflowUnderflowCheck: false,
      triggerOb82OnFault: true
    }
  ],
  defaultAqChannels: [
    {
      channelIndex: 0,
      address: '%QW80',
      name: 'AQ_Channel_0',
      outputType: '4..20 mA',
      scalingNote: '0..27648 Nominal Range'
    },
    {
      channelIndex: 1,
      address: '%QW82',
      name: 'AQ_Channel_1',
      outputType: '0..10 V',
      scalingNote: '0..27648 Nominal Range'
    }
  ]
}

export const ALL_CPU_PROFILES: CpuProfile[] = [
  CPU_1212C_PROFILE,
  CPU_1214C_PROFILE,
  CPU_1215C_PROFILE,
  CPU_1511_PROFILE,
  CPU_1516_PROFILE
]

/** Finds a profile from an id, a CPU name or a family label such as 'Virtual S7-1200'. */
export function getCpuProfile(target: string | undefined): CpuProfile | undefined {
  if (!target) return undefined
  const lower = target.toLowerCase()
  const exact = ALL_CPU_PROFILES.find(
    (p) => p.id === lower || lower.includes(p.name.toLowerCase()) || lower.includes(p.id.replace('cpu-', ''))
  )
  if (exact) return exact
  if (lower.includes('1200')) return CPU_1214C_PROFILE
  if (lower.includes('1500')) return CPU_1516_PROFILE
  return undefined
}
