import chokidar, { FSWatcher } from 'chokidar'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { FileChangeEventPayload } from '../shared/types/ipc'

function normalizeDir(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private generation = 0
  private activeDir: string | null = null

  public async startWatching(projectDir: string, getWindow: () => BrowserWindow | null): Promise<void> {
    const norm = normalizeDir(projectDir)
    if (this.watcher && this.activeDir === norm) {
      return
    }

    await this.stopWatching()
    const myGen = ++this.generation

    const newWatcher = chokidar.watch(projectDir, {
      // Tested relative to the project, so a parent folder named 'out' does not hide every file
      ignored: (candidate: string) => {
        const relative = path.relative(projectDir, candidate)
        return relative
          .split(path.sep)
          .some(
            (part) =>
              part.startsWith('.') ||
              part.endsWith('.tmp') ||
              part === 'node_modules' ||
              part === 'out' ||
              part === 'dist'
          )
      },
      persistent: true,
      ignoreInitial: true,
      depth: 3
    })

    if (myGen !== this.generation) {
      void newWatcher.close().catch(() => {})
      return
    }

    this.watcher = newWatcher
    this.activeDir = norm

    const notify = (eventType: 'add' | 'change' | 'unlink', filePath: string): void => {
      if (myGen !== this.generation) return
      const win = getWindow()
      if (!win || win.isDestroyed()) return

      const relativePath = path.relative(projectDir, filePath)
      const payload: FileChangeEventPayload = {
        projectPath: projectDir,
        relativePath,
        eventType
      }
      win.webContents.send('project:fileChanged', payload)
    }

    newWatcher.on('add', (filePath) => notify('add', filePath))
    newWatcher.on('change', (filePath) => notify('change', filePath))
    newWatcher.on('unlink', (filePath) => notify('unlink', filePath))
    newWatcher.on('error', (err) => {
      console.warn('[ProjectWatcher] Watcher error:', err)
    })
  }

  public async stopWatching(): Promise<void> {
    this.generation++
    this.activeDir = null
    const existing = this.watcher
    this.watcher = null
    if (existing) {
      await existing.close().catch(() => {})
    }
  }
}
