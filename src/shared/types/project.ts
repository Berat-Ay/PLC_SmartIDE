export interface ProjectMetadata {
  id: string
  name: string
  targetCpu: 'Virtual S7-1500' | 'Virtual S7-1200' | 'Virtual S7-300'
  firmwareVersion: string
  schemaVersion: string
  author?: string
  description?: string
  createdAt: string
  updatedAt: string
  projectPath?: string
}

export type CpuOperatingState = 'RUN' | 'STOP' | 'ERROR'
