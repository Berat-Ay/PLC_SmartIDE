import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import * as path from 'path'
import { FileEngine } from './fileEngine'
import { assertProjectRoot, registerProjectRoot } from './pathGuard'
import { BundleFileToWrite, bundleFolderName, readImportFolder, writeBundleFiles } from './tiaFiles'
import { getSecret, setSecret } from './secretStore'
import { cancelAiHttpRequest, sendAiHttpRequest } from './aiHttp'
import { ProjectWatcher } from './watcher'
import { AiHttpRequest, ProjectLoadPayload } from '../shared/types/ipc'

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
    title: 'Rungline',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      // The virtual PLC keeps scanning while the window is in the background
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The app window only ever shows the app itself
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return
    event.preventDefault()
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

ipcMain.handle('project:open', async (_, projectDir: string) => {
  registerProjectRoot(projectDir)
  const payload = await FileEngine.loadProject(projectDir)
  projectWatcher.startWatching(projectDir, () => mainWindow)
  return payload
})

ipcMain.handle('project:save', async (_, payload: ProjectLoadPayload) => {
  assertProjectRoot(payload.projectPath)
  return await FileEngine.saveProject(payload)
})

ipcMain.handle('project:saveFile', async (_, projectDir: string, relPath: string, content: string) => {
  assertProjectRoot(projectDir)
  return await FileEngine.saveSingleFile(projectDir, relPath, content)
})

ipcMain.handle('project:trashFile', async (_, projectDir: string, relPath: string) => {
  assertProjectRoot(projectDir)
  return await FileEngine.moveToTrash(projectDir, relPath)
})

ipcMain.handle('tia:exportBundle', async (_, projectName: string, files: BundleFileToWrite[]) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose where to create the TIA export folder'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const root = path.join(result.filePaths[0], bundleFolderName(projectName))
  await writeBundleFiles(root, files)
  return root
})

ipcMain.handle('tia:pickImportFolder', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose a TIA export or bridge result folder'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return await readImportFolder(result.filePaths[0])
})

ipcMain.handle('secrets:get', async (_, key: string) => getSecret(key))
ipcMain.handle('secrets:set', async (_, key: string, value: string) => setSecret(key, value))
ipcMain.handle('ai:http', async (_, request: AiHttpRequest) => sendAiHttpRequest(request))
ipcMain.handle('ai:httpCancel', async (_, id: string) => cancelAiHttpRequest(id))
