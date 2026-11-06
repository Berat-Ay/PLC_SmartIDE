import { contextBridge, ipcRenderer } from 'electron'
import { ElectronApi, FileChangeEventPayload, ProjectLoadPayload } from '../shared/types/ipc'

const electronApi: ElectronApi = {
  selectProjectDirectory: () => ipcRenderer.invoke('dialog:selectProjectDirectory'),
  createProject: (targetDir: string, name: string) => ipcRenderer.invoke('project:create', targetDir, name),
  openProject: (projectDir: string) => ipcRenderer.invoke('project:open', projectDir),
  saveProjectFile: (projectDir: string, relativePath: string, content: string) =>
    ipcRenderer.invoke('project:saveFile', projectDir, relativePath, content),
  saveAll: (payload: ProjectLoadPayload) => ipcRenderer.invoke('project:save', payload),
  loadDemoProject: (customDir?: string) => ipcRenderer.invoke('project:loadDemo', customDir),
  getSecret: (key: string) => ipcRenderer.invoke('secrets:get', key),
  setSecret: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
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
