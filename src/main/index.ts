import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import * as path from 'path'
import * as os from 'os'
import { FileEngine } from './fileEngine'
import { ProjectWatcher } from './watcher'
import { ProjectLoadPayload } from '../shared/types/ipc'

let mainWindow: BrowserWindow | null = null
const projectWatcher = new ProjectWatcher()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: 'Antigravity S7 Industrial IDE',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer based on electron-vite cli
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  projectWatcher.stopWatching()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC Handlers
ipcMain.handle('dialog:selectProjectDirectory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select S7 Project Directory'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('project:create', async (_, targetDir: string, name: string) => {
  const fullPath = path.join(targetDir, name)
  await FileEngine.ensureProjectDirectories(fullPath)
  const payload = await FileEngine.loadProject(fullPath)
  payload.metadata.name = name
  await FileEngine.saveProject(payload)
  projectWatcher.startWatching(fullPath, () => mainWindow)
  return payload
})

ipcMain.handle('project:open', async (_, projectDir: string) => {
  const payload = await FileEngine.loadProject(projectDir)
  projectWatcher.startWatching(projectDir, () => mainWindow)
  return payload
})

ipcMain.handle('project:save', async (_, payload: ProjectLoadPayload) => {
  return await FileEngine.saveProject(payload)
})

ipcMain.handle('project:saveFile', async (_, projectDir: string, relPath: string, content: string) => {
  return await FileEngine.saveSingleFile(projectDir, relPath, content)
})

ipcMain.handle('project:loadDemo', async (_, customDir?: string) => {
  const targetDir = customDir || path.join(os.tmpdir(), 'Virtual_S7_Plant_Demo')
  await FileEngine.ensureProjectDirectories(targetDir)
  const payload = await FileEngine.loadProject(targetDir)
  projectWatcher.startWatching(targetDir, () => mainWindow)
  return payload
})
