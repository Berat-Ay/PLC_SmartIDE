import { create } from 'zustand'
import { ProjectMetadata, CpuOperatingState } from '@shared/types/project'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { CpuConfig } from '@shared/types/hardware'
import { TagTable } from '@shared/types/tags'
import { LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import { ALL_CPU_PROFILES, CPU_1214C_PROFILE } from '@shared/constants/cpuProfiles'
import { DemoProjectSeeder } from '../services/DemoProjectSeeder'
import { CompileEngine, CompileResult } from '../services/CompileEngine'
import { useHardwareStore } from './useHardwareStore'
import { useTagStore } from './useTagStore'
import { useBlockStore } from './useBlockStore'
import { useCrossRefStore } from './useCrossRefStore'
import { useUIStore } from './useUIStore'

export interface CreateProjectOptions {
  name: string
  targetPath?: string
  cpuProfileId: string
  defaultLanguage: 'LAD' | 'SCL'
}

interface ProjectStoreState {
  metadata: ProjectMetadata | null
  projectPath: string | null
  isLoaded: boolean
  isDirty: boolean
  cpuState: CpuOperatingState

  setProject: (payload: ProjectLoadPayload) => void
  createNewProject: (options: CreateProjectOptions) => void
  loadDemoProject: () => void
  closeProject: () => void
  setCpuState: (state: CpuOperatingState) => void
  markDirty: (dirty?: boolean) => void
  saveProjectToDisk: () => Promise<boolean>
  lastCompileResult: CompileResult | null
  compileProject: () => CompileResult
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  metadata: null,
  projectPath: null,
  isLoaded: false,
  isDirty: false,
  cpuState: 'STOP',
  lastCompileResult: null,

  setProject: (payload: ProjectLoadPayload) => {
    set({
      metadata: payload.metadata,
      projectPath: payload.projectPath,
      isLoaded: true,
      isDirty: false
    })

    // Populate dependent stores
    useHardwareStore.getState().setConfig(payload.hardware)
    useTagStore.getState().setTagTables(payload.tagTables)
    useBlockStore.getState().setBlocks({
      udts: payload.udts,
      dataBlocks: payload.dataBlocks,
      ladBlocks: payload.ladBlocks,
      sclBlocks: payload.sclBlocks
    })

    // Run overlap analysis and rebuild cross-reference index
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  createNewProject: (options: CreateProjectOptions) => {
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
      systemMemory: {
        enabled: true,
        byteAddress: 1
      },
      clockMemory: {
        enabled: true,
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
              name: 'Main [OB1]',
              fileName: 'OB1_Main.scl.json',
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
              code: `ORGANIZATION_BLOCK "Main [OB1]"\nTITLE = "Main Program Cycle (OB1)"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n\nVAR_TEMP\nEND_VAR\n\nBEGIN\n    // Main cyclic execution logic\nEND_ORGANIZATION_BLOCK\n`
            }
          ]
        : []

    const projectName = options.name?.trim() || 'Project_01'
    const targetCpuType: 'Virtual S7-1500' | 'Virtual S7-1200' | 'Virtual S7-300' =
      profile.name.includes('1500') || profile.orderNumber.includes('511') || profile.orderNumber.includes('516')
        ? 'Virtual S7-1500'
        : 'Virtual S7-1200'

    const metadata: ProjectMetadata = {
      id: `proj_${Date.now()}`,
      name: projectName,
      schemaVersion: '1.0.0',
      targetCpu: targetCpuType,
      firmwareVersion: profile.firmwareVersion,
      author: 'Industrial Automation Architect',
      description: `${projectName} configured on ${profile.name} (${profile.orderNumber})`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    get().setProject({
      projectPath: options.targetPath || `C:/Projects/S7/${projectName}`,
      metadata,
      hardware,
      tagTables: [defaultTagTable],
      udts: [],
      dataBlocks: [],
      ladBlocks,
      sclBlocks
    })

    // Open Main [OB1] in editor
    const activeFileName = options.defaultLanguage === 'LAD' ? 'OB1_Main.lad.json' : 'OB1_Main.scl.json'
    useUIStore.getState().setTabs([
      {
        id: activeFileName,
        title: 'OB1_Main',
        type: options.defaultLanguage === 'LAD' ? 'lad' : 'scl',
        targetId: activeFileName
      }
    ])
    useUIStore.getState().setActiveTab(activeFileName)
    useUIStore.getState().setPortalViewOpen(false)
  },

  loadDemoProject: () => {
    const demo = DemoProjectSeeder.createDemoProject()
    get().setProject(demo)
    useUIStore.getState().setPortalViewOpen(false)
  },

  closeProject: () => {
    set({
      metadata: null,
      projectPath: null,
      isLoaded: false,
      isDirty: false
    })
    useUIStore.getState().setTabs([])
    useUIStore.getState().setActiveTab(null)
    useUIStore.getState().setPortalViewOpen(true)
  },

  setCpuState: (cpuState: CpuOperatingState) => set({ cpuState }),

  markDirty: (dirty = true) => set({ isDirty: dirty }),

  saveProjectToDisk: async () => {
    const { projectPath, metadata } = get()
    if (!projectPath || !metadata) return false

    const payload: ProjectLoadPayload = {
      projectPath,
      metadata: {
        ...metadata,
        updatedAt: new Date().toISOString()
      },
      hardware: useHardwareStore.getState().config,
      tagTables: useTagStore.getState().tagTables,
      udts: useBlockStore.getState().udts,
      dataBlocks: useBlockStore.getState().dataBlocks,
      ladBlocks: useBlockStore.getState().ladBlocks,
      sclBlocks: useBlockStore.getState().sclBlocks
    }

    if (window.electronApi) {
      try {
        const ok = await window.electronApi.saveAll(payload)
        if (ok) {
          set({ isDirty: false, metadata: payload.metadata })
        }
        return ok
      } catch (err) {
        console.error('Failed to save project:', err)
        return false
      }
    } else {
      // In web preview fallback
      set({ isDirty: false, metadata: payload.metadata })
      return true
    }
  },

  compileProject: () => {
    // Re-run overlap analysis and cross-reference index
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()

    const result = CompileEngine.runFullProjectCompilation()
    set({ lastCompileResult: result })
    return result
  }
}))
