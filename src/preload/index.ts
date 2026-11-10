import { contextBridge, ipcRenderer } from 'electron'
import { ElectronApi, FileChangeEventPayload, ProjectLoadPayload } from '../shared/types/ipc'

const electronApi: ElectronApi = {
  selectProjectDirectory: () => ipcRenderer.invoke('dialog:selectProjectDirectory'),
  openProject: (projectDir: string) => ipcRenderer.invoke('project:open', projectDir),
  saveProjectFile: (projectDir: string, relativePath: string, content: string) =>
    ipcRenderer.invoke('project:saveFile', projectDir, relativePath, content),
  trashProjectFile: (projectDir: string, relativePath: string) =>
    ipcRenderer.invoke('project:trashFile', projectDir, relativePath),
  saveAll: (payload: ProjectLoadPayload) => ipcRenderer.invoke('project:save', payload),
  exportTiaBundle: (projectName, files) => ipcRenderer.invoke('tia:exportBundle', projectName, files),
  pickTiaImportFolder: () => ipcRenderer.invoke('tia:pickImportFolder'),
  getSecret: (key: string) => ipcRenderer.invoke('secrets:get', key),
  setSecret: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  aiHttpRequest: (request) => ipcRenderer.invoke('ai:http', request),
  aiHttpCancel: (id: string) => ipcRenderer.invoke('ai:httpCancel', id),
  onFileChanged: (callback: (payload: FileChangeEventPayload) => void) => {
    const handler = (_: unknown, payload: FileChangeEventPayload) => callback(payload)
    ipcRenderer.on('project:fileChanged', handler)
    return () => {
      ipcRenderer.removeListener('project:fileChanged', handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronApi', electronApi)
  } catch (error) {
    console.error('Failed to expose electronApi to renderer:', error)
  }
} else {
  // @ts-ignore
  window.electronApi = electronApi
}
