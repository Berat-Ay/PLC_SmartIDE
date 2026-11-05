import { CpuConfig } from '../types/hardware'
import { CPU_1214C_PROFILE } from './cpuProfiles'

export function getDefaultCpuConfig(): CpuConfig {
  return {
    general: {
      cpuName: CPU_1214C_PROFILE.name,
      cycleWatchdogTimeMs: 150,
      minCycleTimeEnabled: false,
      minCycleTimeMs: 1,
      retentiveMemory: { startByte: 0, byteCount: 2048 }
    },
    systemMemory: { enabled: true, byteAddress: 1 },
    clockMemory: { enabled: true, byteAddress: 0 },
    digitalIO: {
      diStartByte: 0,
      dqStartByte: 0,
      diChannels: CPU_1214C_PROFILE.defaultDiChannels,
      dqChannels: CPU_1214C_PROFILE.defaultDqChannels
    },
    analogIO: {
      aiChannels: CPU_1214C_PROFILE.defaultAiChannels,
      aqChannels: CPU_1214C_PROFILE.defaultAqChannels
    },
    organizationBlocks: [
      {
        blockNumber: 1,
        name: 'Main [OB1]',
        type: 'Cyclic',
        enabled: true,
        priority: 1,
        description: 'Cyclic execution loop'
      },
      {
        blockNumber: 100,
        name: 'Startup [OB100]',
        type: 'Startup',
        enabled: true,
        priority: 1,
        description: 'Executed once upon transition from STOP to RUN'
      },
      {
        blockNumber: 30,
        name: 'Cyclic_Interrupt_100ms [OB30]',
        type: 'CyclicInterrupt',
        enabled: true,
        cycleTimeMs: 100,
        phaseOffsetMs: 0,
        priority: 7,
        description: 'Deterministic 100ms cyclic interrupt for PID header control'
      },
      {
        blockNumber: 82,
        name: 'Diag_Error_Interrupt [OB82]',
        type: 'DiagnosticInterrupt',
        enabled: true,
        priority: 24,
        description: 'Hardware diagnostic interrupt triggered by wire-break or analog overflow'
      }
    ]
  }
}
