import { ProjectMetadata } from './project'
import { CpuConfig } from './hardware'
import { TagTable } from './tags'
import { UdtDefinition } from './types'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from './blocks'

export interface ProjectLoadPayload {
  projectPath: string
  metadata: ProjectMetadata
  hardware: CpuConfig
  tagTables: TagTable[]
  udts: UdtDefinition[]
  dataBlocks: DataBlockDefinition[]
  ladBlocks: LadBlockDefinition[]
  sclBlocks: SclBlockDefinition[]
  simulationScripts?: { fileName: string; code: string }[]
  /** Files that could not be read when the project was opened. They stay untouched on disk. */
  loadErrors?: { file: string; message: string }[]
}

export interface FileChangeEventPayload {
  projectPath: string
  relativePath: string
  eventType: 'add' | 'change' | 'unlink'
  content?: string
}

export interface ElectronApi {
  selectProjectDirectory: () => Promise<string | null>
  createProject: (targetDir: string, name: string) => Promise<ProjectLoadPayload>
  openProject: (projectDir: string) => Promise<ProjectLoadPayload>
  saveProjectFile: (projectDir: string, relativePath: string, content: string) => Promise<boolean>
  saveAll: (payload: ProjectLoadPayload) => Promise<boolean>
  loadDemoProject: (customDir?: string) => Promise<ProjectLoadPayload>
  onFileChanged: (callback: (payload: FileChangeEventPayload) => void) => () => void
  getSecret: (key: string) => Promise<string | null>
  setSecret: (key: string, value: string) => Promise<boolean>
}

declare global {
  interface Window {
    electronApi: ElectronApi
  }
}
