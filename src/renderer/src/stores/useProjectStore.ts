import { create } from 'zustand'
import { ProjectMetadata, CpuOperatingState } from '@shared/types/project'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { buildInitialProjectPayload } from '@shared/project/createProjectPayload'
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
  loadErrors: { file: string; message: string }[]
  simulationScripts: { fileName: string; code: string }[]
  /** Time of this app's last write, so the file watcher can tell it from an external edit. */
  lastLocalWriteAt: number
  noteLocalWrite: () => void

  setProject: (payload: ProjectLoadPayload) => void
  initializeCreatedProject: (payload: ProjectLoadPayload, defaultLanguage: 'LAD' | 'SCL') => void
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
  loadErrors: [],
  simulationScripts: [],
  lastLocalWriteAt: 0,
  noteLocalWrite: () => set({ lastLocalWriteAt: Date.now() }),

  setProject: (payload: ProjectLoadPayload) => {
    set({
      metadata: payload.metadata,
      projectPath: payload.projectPath,
      isLoaded: true,
      isDirty: false,
      loadErrors: payload.loadErrors || [],
      simulationScripts: payload.simulationScripts || []
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

    if (payload.loadErrors && payload.loadErrors.length > 0) {
      get().compileProject()
      useUIStore.getState().setBottomActiveTab('compile')
    }
  },

  initializeCreatedProject: (payload: ProjectLoadPayload, defaultLanguage: 'LAD' | 'SCL') => {
    get().setProject(payload)

    const isLad = defaultLanguage === 'LAD'
    const activeFileName = isLad
      ? payload.ladBlocks[0]?.fileName || 'OB1_Main.lad.json'
      : payload.sclBlocks[0]?.fileName || 'OB1_Main.scl'

    useUIStore.getState().setTabs([
      {
        id: activeFileName,
        title: 'OB1_Main',
        type: isLad ? 'lad' : 'scl',
        targetId: activeFileName
      }
    ])
    useUIStore.getState().setActiveTab(activeFileName)
    useUIStore.getState().setPortalViewOpen(false)
  },

  createNewProject: (options: CreateProjectOptions) => {
    const projectName = options.name?.trim() || 'Project_01'
    const payload = buildInitialProjectPayload({
      name: projectName,
      targetPath: options.targetPath?.trim() || `C:/Projects/S7/${projectName}`,
      cpuProfileId: options.cpuProfileId,
      defaultLanguage: options.defaultLanguage
    })
    get().initializeCreatedProject(payload, options.defaultLanguage)
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
      sclBlocks: useBlockStore.getState().sclBlocks,
      simulationScripts: get().simulationScripts
    }

    if (window.electronApi) {
      try {
        get().noteLocalWrite()
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
    for (const loadError of get().loadErrors) {
      result.diagnostics.push({
        id: `load_error_${loadError.file}`,
        severity: 'Warning',
        code: 'WARN_FILE_NOT_LOADED',
        source: 'Project Loader',
        message: `${loadError.file} could not be read and is not part of this session: ${loadError.message}`,
        timestamp: Date.now()
      })
      result.warningsCount++
    }
    set({ lastCompileResult: result })
    return result
  }
}))
