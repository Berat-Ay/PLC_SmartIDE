import { contextBridge, ipcRenderer } from 'electron'
import { CreateProjectRequest, ElectronApi, FileChangeEventPayload, ProjectLoadPayload } from '../shared/types/ipc'

if (!process.contextIsolated) {
  throw new Error('Preload requires contextIsolation: true')
}

const electronApi: ElectronApi = {
  selectProjectDirectory: () => ipcRenderer.invoke('dialog:selectProjectDirectory'),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  getDefaultProjectsRoot: () => ipcRenderer.invoke('dialog:getDefaultProjectsRoot'),
  createProject: (options: CreateProjectRequest) => ipcRenderer.invoke('project:create', options),
  openProject: (projectDir: string) => ipcRenderer.invoke('project:open', projectDir),
  saveProjectFile: (projectDir: string, relativePath: string, content: string) =>
    ipcRenderer.invoke('project:saveFile', projectDir, relativePath, content),
  trashProjectFile: (projectDir: string, relativePath: string) =>
    ipcRenderer.invoke('project:trashFile', projectDir, relativePath),
  saveAll: (payload: ProjectLoadPayload) => ipcRenderer.invoke('project:save', payload),
  exportTiaBundle: (projectName, files) => ipcRenderer.invoke('tia:exportBundle', projectName, files),
  pickTiaImportFolder: () => ipcRenderer.invoke('tia:pickImportFolder'),
  getSecretStatus: () => ipcRenderer.invoke('secrets:status'),
  setSecret: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  aiHttpRequest: (request) => ipcRenderer.invoke('ai:http', request),
  aiHttpCancel: (id: string) => ipcRenderer.invoke('ai:httpCancel', id),
  isTestMode: process.env.NODE_ENV === 'test',
  onFileChanged: (callback: (payload: FileChangeEventPayload) => void) => {
    const handler = (_: unknown, payload: FileChangeEventPayload) => callback(payload)
    ipcRenderer.on('project:fileChanged', handler)
    return () => {
      ipcRenderer.removeListener('project:fileChanged', handler)
    }
  }
}

contextBridge.exposeInMainWorld('electronApi', electronApi)
