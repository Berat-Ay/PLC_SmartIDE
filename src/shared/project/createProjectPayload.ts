import { ALL_CPU_PROFILES, CPU_1214C_PROFILE } from '../constants/cpuProfiles'
import { LadBlockDefinition, SclBlockDefinition } from '../types/blocks'
import { CpuConfig } from '../types/hardware'
import { CreateProjectRequest, ProjectLoadPayload } from '../types/ipc'
import { ProjectMetadata } from '../types/project'
import { TagTable } from '../types/tags'

/**
 * Builds the initial ProjectLoadPayload for a newly created project,
 * shared between main-process disk creation and renderer/test fallbacks.
 */
export function buildInitialProjectPayload(options: CreateProjectRequest): ProjectLoadPayload {
  const profile = ALL_CPU_PROFILES.find((p) => p.id === options.cpuProfileId) || CPU_1214C_PROFILE

  const hardware: CpuConfig = {
    general: {
      cpuName: profile.name,
      targetCpu: `${profile.name} (${profile.orderNumber})`,
      cycleWatchdogTimeMs: 150,
      minCycleTimeEnabled: false,
      minCycleTimeMs: 1,
      retentiveMemory: {
        startByte: 0,
        byteCount: 2048
      }
    },
    // As in TIA Portal, a new CPU has system and clock memory off; the user turns them on in the CPU settings
    systemMemory: {
      enabled: false,
      byteAddress: 1
    },
    clockMemory: {
      enabled: false,
      byteAddress: 0
    },
    digitalIO: {
      diStartByte: 0,
      dqStartByte: 0,
      diChannels: profile.defaultDiChannels,
      dqChannels: profile.defaultDqChannels
    },
    analogIO: {
      aiChannels: profile.defaultAiChannels,
      aqChannels: profile.defaultAqChannels
    },
    organizationBlocks: [
      {
        blockNumber: 1,
        name: 'OB1_Main',
        type: 'Cyclic',
        enabled: true,
        priority: 1,
        description: 'Main Program Cycle Execution'
      },
      {
        blockNumber: 100,
        name: 'OB100_Startup',
        type: 'Startup',
        enabled: true,
        priority: 1,
        description: 'Warm Restart Execution'
      },
      {
        blockNumber: 30,
        name: 'OB30_CyclicInterrupt',
        type: 'CyclicInterrupt',
        enabled: true,
        cycleTimeMs: 100,
        phaseOffsetMs: 0,
        priority: 7,
        description: '100ms High-Speed Cyclic Interrupt'
      },
      {
        blockNumber: 82,
        name: 'OB82_DiagFault',
        type: 'DiagnosticInterrupt',
        enabled: true,
        priority: 26,
        description: 'Hardware Diagnostic Interrupt (Wire-break / Overflow)'
      }
    ]
  }

  const defaultTagTable: TagTable = {
    id: 'table_default',
    name: 'default_tags',
    fileName: 'default_tags.tags.json',
    tags: []
  }

  const ladBlocks: LadBlockDefinition[] =
    options.defaultLanguage === 'LAD'
      ? [
          {
            blockType: 'OB',
            name: 'Main [OB1]',
            fileName: 'OB1_Main.lad.json',
            blockNumber: 1,
            optimizedAccess: true,
            schemaVersion: '1.0.0',
            interface: {
              input: [],
              output: [],
              inOut: [],
              static: [],
              temp: [],
              constant: []
            },
            networks: [
              {
                id: 'net_1',
                networkNumber: 1,
                title: 'Network 1',
                comment: 'Empty network ready for LAD logic',
                nodes: []
              }
            ]
          }
        ]
      : []

  const sclBlocks: SclBlockDefinition[] =
    options.defaultLanguage === 'SCL'
      ? [
          {
            blockType: 'OB',
            name: 'Main',
            fileName: 'OB1_Main.scl',
            blockNumber: 1,
            optimizedAccess: true,
            interface: {
              input: [],
              output: [],
              inOut: [],
              static: [],
              temp: [],
              constant: []
            },
            code: `ORGANIZATION_BLOCK "Main"\nTITLE = Main Program Cycle (OB1)\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n\nVAR_TEMP\nEND_VAR\n\nBEGIN\n    // Main cyclic execution logic\nEND_ORGANIZATION_BLOCK\n`
          }
        ]
      : []

  const projectName = options.name?.trim() || 'Project_01'
  const projectPath = options.targetPath?.trim() || `C:/Projects/S7/${projectName}`
  const targetCpuType: 'Virtual S7-1500' | 'Virtual S7-1200' | 'Virtual S7-300' =
    profile.name.includes('1500') || profile.orderNumber.includes('511') || profile.orderNumber.includes('516')
      ? 'Virtual S7-1500'
      : 'Virtual S7-1200'

  const now = new Date().toISOString()
  const metadata: ProjectMetadata = {
    id: `proj_${Date.now()}`,
    name: projectName,
    schemaVersion: '1.0.0',
    targetCpu: targetCpuType,
    firmwareVersion: profile.firmwareVersion,
    author: 'Industrial Automation Architect',
    description: `${projectName} configured on ${profile.name} (${profile.orderNumber})`,
    createdAt: now,
    updatedAt: now,
    projectPath
  }

  return {
    projectPath,
    metadata,
    hardware,
    tagTables: [defaultTagTable],
    udts: [],
    dataBlocks: [],
    ladBlocks,
    sclBlocks
  }
}
