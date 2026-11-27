import { app, shell, BrowserWindow, ipcMain, dialog, session, IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import * as path from 'path'
import { FileEngine } from './fileEngine'
import {
  approveCreateParent,
  approveOpenRoot,
  assertApprovedCreateTarget,
  assertApprovedOpenRoot,
  assertProjectRoot,
  registerProjectRoot
} from './pathGuard'
import { BundleFileToWrite, bundleFolderName, readImportFolder, writeBundleFiles } from './tiaFiles'
import { getSecret, getSecretStatus, setSecret } from './secretStore'
import { cancelAiHttpRequest, cancelAllAiHttpRequests, sendAiHttpRequest, setAiHttpSecretReader } from './aiHttp'
import { ProjectWatcher } from './watcher'
import { installSimSandboxProtocol, registerSimSandboxScheme } from './simSandboxProtocol'
import { AiHttpRequest, CreateProjectRequest, ProjectLoadPayload } from '../shared/types/ipc'

registerSimSandboxScheme()

let mainWindow: BrowserWindow | null = null
const projectWatcher = new ProjectWatcher()

function assertSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed() || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Unauthorized IPC sender frame')
  }
}

function assertNonEmptyString(val: unknown, name: string): string {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Invalid IPC argument '${name}': expected non-empty string`)
  }
  return val
}

function assertString(val: unknown, name: string): string {
  if (typeof val !== 'string') {
    throw new Error(`Invalid IPC argument '${name}': expected string`)
  }
  return val
}

function assertObject<T extends object>(val: unknown, name: string): T {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`Invalid IPC argument '${name}': expected object`)
  }
  return val as T
}

function restoreWindowFocus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.focus()
  mainWindow.webContents.focus()
}

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

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The app window only ever shows the app itself
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (process.env.ELECTRON_RENDERER_URL) {
      try {
        if (new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin) return
      } catch {
        // invalid URL falls through to preventDefault
      }
    }
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
  setAiHttpSecretReader(getSecret)
  installSimSandboxProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  cancelAllAiHttpRequests()
  void projectWatcher.stopWatching()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC Handlers
ipcMain.handle('dialog:getDefaultProjectsRoot', async (event) => {
  assertSender(event)
  const root =
    process.env.NODE_ENV === 'test'
      ? path.join(app.getPath('userData'), 'projects')
      : path.join(app.getPath('documents'), 'Rungline')
  approveCreateParent(root)
  return root
})

ipcMain.handle('dialog:selectProjectDirectory', async (event) => {
  assertSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return null
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select S7 Project Directory'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    approveOpenRoot(chosen)
    return chosen
  } finally {
    restoreWindowFocus()
  }
})

ipcMain.handle('dialog:selectDirectory', async (event) => {
  assertSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return null
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Target Directory'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    approveCreateParent(chosen)
    return chosen
  } finally {
    restoreWindowFocus()
  }
})

ipcMain.handle('project:create', async (event, rawOptions: CreateProjectRequest) => {
  assertSender(event)
  const options = assertObject<CreateProjectRequest>(rawOptions, 'options')
  const targetPath = assertNonEmptyString(options.targetPath, 'options.targetPath')
  assertNonEmptyString(options.name, 'options.name')
  assertApprovedCreateTarget(targetPath)

  const payload = await FileEngine.createProject(options)
  registerProjectRoot(payload.projectPath)
  void projectWatcher.startWatching(payload.projectPath, () => mainWindow)
  return payload
})

ipcMain.handle('project:open', async (event, rawProjectDir: string) => {
  assertSender(event)
  const projectDir = assertNonEmptyString(rawProjectDir, 'projectDir')
  assertApprovedOpenRoot(projectDir)

  const payload = await FileEngine.loadProject(projectDir)
  registerProjectRoot(projectDir)
  void projectWatcher.startWatching(projectDir, () => mainWindow)
  return payload
})

ipcMain.handle('project:save', async (event, rawPayload: ProjectLoadPayload) => {
  assertSender(event)
  const payload = assertObject<ProjectLoadPayload>(rawPayload, 'payload')
  const projectPath = assertNonEmptyString(payload.projectPath, 'payload.projectPath')
  assertProjectRoot(projectPath)
  return await FileEngine.saveProject(payload)
})

ipcMain.handle('project:saveFile', async (event, rawProjectDir: string, rawRelPath: string, rawContent: string) => {
  assertSender(event)
  const projectDir = assertNonEmptyString(rawProjectDir, 'projectDir')
  const relPath = assertNonEmptyString(rawRelPath, 'relPath')
  const content = assertString(rawContent, 'content')
  assertProjectRoot(projectDir)
  return await FileEngine.saveSingleFile(projectDir, relPath, content)
})

ipcMain.handle('project:trashFile', async (event, rawProjectDir: string, rawRelPath: string) => {
  assertSender(event)
  const projectDir = assertNonEmptyString(rawProjectDir, 'projectDir')
  const relPath = assertNonEmptyString(rawRelPath, 'relPath')
  assertProjectRoot(projectDir)
  return await FileEngine.moveToTrash(projectDir, relPath)
})

ipcMain.handle('tia:exportBundle', async (event, rawProjectName: string, rawFiles: BundleFileToWrite[]) => {
  assertSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const projectName = assertString(rawProjectName, 'projectName')
  if (!Array.isArray(rawFiles)) throw new Error("Invalid IPC argument 'files': expected array")

  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where to create the TIA export folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = path.join(result.filePaths[0], bundleFolderName(projectName))
    await writeBundleFiles(root, rawFiles)
    return root
  } finally {
    restoreWindowFocus()
  }
})

ipcMain.handle('tia:pickImportFolder', async (event) => {
  assertSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return null
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Choose a TIA export or bridge result folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return await readImportFolder(result.filePaths[0])
  } finally {
    restoreWindowFocus()
  }
})

ipcMain.handle('secrets:status', async (event) => {
  assertSender(event)
  return getSecretStatus()
})

ipcMain.handle('secrets:set', async (event, rawKey: string, rawValue: string) => {
  assertSender(event)
  const key = assertNonEmptyString(rawKey, 'key')
  const value = assertString(rawValue, 'value')
  return setSecret(key, value)
})

ipcMain.handle('ai:http', async (event, rawRequest: AiHttpRequest) => {
  assertSender(event)
  const request = assertObject<AiHttpRequest>(rawRequest, 'request')
  assertNonEmptyString(request.id, 'request.id')
  assertNonEmptyString(request.url, 'request.url')
  return sendAiHttpRequest(request)
})

ipcMain.handle('ai:httpCancel', async (event, rawId: string) => {
  assertSender(event)
  const id = assertNonEmptyString(rawId, 'id')
  cancelAiHttpRequest(id)
})
