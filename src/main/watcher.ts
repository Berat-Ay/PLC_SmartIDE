import chokidar, { FSWatcher } from 'chokidar'
import * as path from 'path'
import * as fs from 'fs/promises'
import { BrowserWindow } from 'electron'
import { FileChangeEventPayload } from '../shared/types/ipc'

export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private projectPath: string | null = null

  public startWatching(projectDir: string, getWindow: () => BrowserWindow | null): void {
    this.stopWatching()
    this.projectPath = projectDir

    this.watcher = chokidar.watch(projectDir, {
      ignored: [
        /(^|[/\\])\../, // ignore dotfiles
        /node_modules/,
        /\.git/,
        /out/,
        /dist/
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 3
    })

    const notify = async (eventType: 'add' | 'change' | 'unlink', filePath: string) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return

      const relativePath = path.relative(projectDir, filePath)
      let content: string | undefined = undefined

      if (eventType !== 'unlink') {
        try {
          content = await fs.readFile(filePath, 'utf-8')
        } catch {
          // File might be busy
        }
      }

      const payload: FileChangeEventPayload = {
        projectPath: projectDir,
        relativePath,
        eventType,
        content
      }

      win.webContents.send('project:fileChanged', payload)
    }

    this.watcher.on('add', (filePath) => notify('add', filePath))
    this.watcher.on('change', (filePath) => notify('change', filePath))
    this.watcher.on('unlink', (filePath) => notify('unlink', filePath))
  }

  public stopWatching(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {})
      this.watcher = null
      this.projectPath = null
    }
  }
}
