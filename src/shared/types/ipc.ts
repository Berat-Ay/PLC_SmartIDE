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
  /** Moves a file from blocks, types or tags to the project's .trash folder. False if it was never saved. */
  trashProjectFile: (projectDir: string, relativePath: string) => Promise<boolean>
  saveAll: (payload: ProjectLoadPayload) => Promise<boolean>
  loadDemoProject: (customDir?: string) => Promise<ProjectLoadPayload>
  onFileChanged: (callback: (payload: FileChangeEventPayload) => void) => () => void
  /** Asks for a folder, writes the bundle there and returns its path. Null when cancelled. */
  exportTiaBundle: (projectName: string, files: { filename: string; folder: string; content: string }[]) => Promise<string | null>
  /** Asks for a folder and returns its TIA files. Null when cancelled. */
  pickTiaImportFolder: () => Promise<{ folder: string; files: { path: string; content: string }[] } | null>
  getSecret: (key: string) => Promise<string | null>
  setSecret: (key: string, value: string) => Promise<boolean>
  /** An AI API request sent by the main process, where a server without CORS headers can still answer */
  aiHttpRequest: (request: AiHttpRequest) => Promise<AiHttpResponse>
  /** Aborts a request started with aiHttpRequest */
  aiHttpCancel: (id: string) => Promise<void>
}

export interface AiHttpRequest {
  id: string
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

/** status is 0 when no HTTP answer came: error says why (network, timeout or cancelled) */
export interface AiHttpResponse {
  status: number
  statusText: string
  body: string
  error?: 'network' | 'timeout' | 'cancelled'
  message?: string
}

declare global {
  interface Window {
    electronApi: ElectronApi
  }
}
