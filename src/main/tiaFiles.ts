// Disk access for TIA export and import. Folders always come from a dialog in the main process.
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { assertPlainFileName, resolveInsideReal } from './pathGuard'
import { TiaImportFile } from '../shared/tia/readers'

const BUNDLE_FOLDERS = new Set(['', 'sources', 'tags'])
const IMPORT_EXTENSIONS = new Set(['.scl', '.db', '.udt', '.xml'])
const SKIPPED_FOLDERS = new Set(['tia-project', 'prepared-tags'])
const MAX_IMPORT_FILES = 5000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_IMPORT_BYTES = 100 * 1024 * 1024

export interface BundleFileToWrite {
  filename: string
  folder: string
  content: string
}

export function bundleFolderName(projectName: string): string {
  return `${projectName.replace(/[^A-Za-z0-9_-]+/g, '_') || 'PLC_Project'}_TIA`
}

/** Writes into a new or existing bundle folder. Other files in that folder stay as they are. */
export async function writeBundleFiles(root: string, files: BundleFileToWrite[]): Promise<void> {
  // Pre-validate every entry before mutating disk
  const validated: Array<{ target: string; content: string }> = []
  for (const file of files) {
    if (!BUNDLE_FOLDERS.has(file.folder)) throw new Error(`Invalid bundle folder '${file.folder}'`)
    assertPlainFileName(file.filename)
    const target = await resolveInsideReal(root, path.join(file.folder, file.filename))
    validated.push({ target, content: file.content })
  }

  for (const item of validated) {
    await fs.mkdir(path.dirname(item.target), { recursive: true })
    const temp = `${item.target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, item.content, 'utf-8')
    try {
      await fs.rename(temp, item.target)
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw err
    }
  }
}

/** Reads a TIA export. In a bridge result folder only the exported part is relevant. */
export async function readImportFolder(chosen: string): Promise<{ folder: string; files: TiaImportFile[] }> {
  const exported = path.join(chosen, 'exported')
  const hasExported = await fs.access(path.join(exported, 'manifest.json')).then(
    () => true,
    () => false
  )
  const root = hasExported ? exported : chosen
  const files: TiaImportFile[] = []
  let totalBytes = 0

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) await walk(full)
        continue
      }
      const extension = path.extname(entry.name).toLowerCase()
      if (!entry.isFile() || (!IMPORT_EXTENSIONS.has(extension) && entry.name !== 'manifest.json')) continue
      if (files.length >= MAX_IMPORT_FILES) throw new Error(`The folder has more than ${MAX_IMPORT_FILES} files.`)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink() || !stat.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) throw new Error(`${entry.name} is larger than ${MAX_FILE_BYTES} bytes.`)
      if (totalBytes + stat.size > MAX_TOTAL_IMPORT_BYTES) {
        throw new Error(`Total TIA import size exceeds ${MAX_TOTAL_IMPORT_BYTES} bytes.`)
      }
      totalBytes += stat.size
      files.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        content: await fs.readFile(full, 'utf-8')
      })
    }
  }
  await walk(root)
  return { folder: root, files }
}
