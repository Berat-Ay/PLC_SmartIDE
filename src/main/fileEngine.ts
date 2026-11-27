import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { CreateProjectRequest, ProjectLoadPayload } from '../shared/types/ipc'
import { ProjectMetadata } from '../shared/types/project'
import { CpuConfig } from '../shared/types/hardware'
import { TagTable } from '../shared/types/tags'
import { UdtDefinition } from '../shared/types/types'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '../shared/types/blocks'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'
import { buildInitialProjectPayload } from '../shared/project/createProjectPayload'
import { effectiveInterface, emptyInterface, parseSourceBlock, toFullSource } from '../shared/scl/sourceBlock'
import { assertPlainFileName, resolveInsideReal } from './pathGuard'

const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024
const MAX_TRASH_ATTEMPTS = 100
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Writes through a temporary file, so a crash cannot leave a half-written project file. */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, content, 'utf-8')
  const delays = [50, 100, 200]
  let lastErr: unknown
  try {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await fs.rename(temp, target)
        return
      } catch (err) {
        lastErr = err
        const code = (err as NodeJS.ErrnoException)?.code
        if (attempt < delays.length && code && RETRYABLE_RENAME_CODES.has(code)) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
          continue
        }
        throw err
      }
    }
    throw lastErr
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

export class FileEngine {
  /**
   * Ensures the standard modular S7 project folder hierarchy exists on disk
   */
  public static async ensureProjectDirectories(projectDir: string): Promise<void> {
    const subdirs = ['hardware', 'tags', 'types', 'blocks', 'simulation']
    for (const subdir of subdirs) {
      const fullPath = path.join(projectDir, subdir)
      await fs.mkdir(fullPath, { recursive: true })
    }
  }

  /**
   * Creates a new modular S7 project directory structure on disk and returns the loaded payload.
   */
  public static async createProject(options: CreateProjectRequest): Promise<ProjectLoadPayload> {
    const target = options.targetPath?.trim()
    if (!target) {
      throw new Error('Target project directory cannot be empty')
    }
    const normalizedDir = path.resolve(target)
    try {
      const stat = await fs.stat(normalizedDir)
      if (stat.isFile()) {
        throw new Error(`'${normalizedDir}' is a file, not a directory`)
      }
    } catch (err) {
      if (!isMissingFile(err)) throw err
    }

    await fs.mkdir(normalizedDir, { recursive: true })
    await this.ensureProjectDirectories(normalizedDir)

    const initial = buildInitialProjectPayload({
      ...options,
      targetPath: normalizedDir
    })
    await this.saveProject(initial)
    return await this.loadProject(normalizedDir)
  }

  /**
   * Loads an entire project from disk conforming to the Everything-as-Code structure
   */
  public static async loadProject(projectDir: string): Promise<ProjectLoadPayload> {
    await this.ensureProjectDirectories(projectDir)

    // 1. Project metadata
    const metaPath = await resolveInsideReal(projectDir, 'project.plc.json')
    let metadata: ProjectMetadata
    try {
      metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
      metadata.projectPath = projectDir
    } catch (err) {
      // Only a missing file gets defaults. A corrupt one must not be overwritten.
      if (!isMissingFile(err)) throw new Error(`Cannot read project.plc.json: ${(err as Error).message}`)
      metadata = {
        id: `proj_${Date.now()}`,
        name: path.basename(projectDir),
        targetCpu: 'Virtual S7-1500',
        firmwareVersion: 'V2.9',
        schemaVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectPath: projectDir
      }
      await writeFileAtomic(metaPath, JSON.stringify(metadata, null, 2))
    }

    // 2. Hardware / CPU config
    const hwPath = await resolveInsideReal(projectDir, 'hardware/cpu_config.json')
    let hardware: CpuConfig
    try {
      hardware = JSON.parse(await fs.readFile(hwPath, 'utf-8'))
    } catch (err) {
      if (!isMissingFile(err)) throw new Error(`Cannot read hardware/cpu_config.json: ${(err as Error).message}`)
      hardware = this.getDefaultCpuConfig()
      await writeFileAtomic(hwPath, JSON.stringify(hardware, null, 2))
    }

    // A damaged file is reported and left on disk; the rest of the project still opens
    const loadErrors: { file: string; message: string }[] = []
    const readEach = async (
      subdir: string,
      filter: (file: string) => boolean,
      handle: (file: string, raw: string) => void
    ): Promise<void> => {
      const entries = await fs.readdir(path.join(projectDir, subdir), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile() || !filter(entry.name)) continue
        try {
          const fullPath = await resolveInsideReal(projectDir, `${subdir}/${entry.name}`)
          const stat = await fs.lstat(fullPath)
          if (stat.isSymbolicLink() || !stat.isFile()) continue
          if (stat.size > MAX_PROJECT_FILE_BYTES) {
            throw new Error(`File exceeds maximum size (${MAX_PROJECT_FILE_BYTES} bytes)`)
          }
          handle(entry.name, await fs.readFile(fullPath, 'utf-8'))
        } catch (err) {
          loadErrors.push({ file: `${subdir}/${entry.name}`, message: (err as Error).message })
        }
      }
    }

    // 3. Tag tables (/tags/*.tags.json)
    const tagTables: TagTable[] = []
    await readEach(
      'tags',
      (f) => f.endsWith('.tags.json'),
      (file, raw) => {
        const table: TagTable = JSON.parse(raw)
        table.fileName = file
        tagTables.push(table)
      }
    )

    // 4. UDT definitions (/types/*.udt.json)
    const udts: UdtDefinition[] = []
    await readEach(
      'types',
      (f) => f.endsWith('.udt.json'),
      (file, raw) => {
        const udt: UdtDefinition = JSON.parse(raw)
        udt.fileName = file
        udts.push(udt)
      }
    )

    // 5. Blocks (/blocks/)
    const dataBlocks: DataBlockDefinition[] = []
    const ladBlocks: LadBlockDefinition[] = []
    const sclBlocks: SclBlockDefinition[] = []
    await readEach(
      'blocks',
      (f) => f.endsWith('.db.json') || f.endsWith('.lad.json') || f.endsWith('.scl'),
      (file, raw) => {
        if (file.endsWith('.db.json')) {
          const db: DataBlockDefinition = JSON.parse(raw)
          db.fileName = file
          dataBlocks.push(db)
        } else if (file.endsWith('.lad.json')) {
          const lad: LadBlockDefinition = JSON.parse(raw)
          lad.fileName = file
          ladBlocks.push(lad)
        } else if (file.endsWith('.scl')) {
          sclBlocks.push(this.parseSclFile(file, raw))
        }
      }
    )

    // 6. Simulation scenarios are loaded as text. They only run when the user applies them.
    const simulationScripts: { fileName: string; code: string }[] = []
    await readEach(
      'simulation',
      (f) => f.endsWith('.sim.js'),
      (file, raw) => {
        simulationScripts.push({ fileName: file, code: raw })
      }
    )

    return {
      projectPath: projectDir,
      metadata,
      hardware,
      tagTables,
      udts,
      dataBlocks,
      ladBlocks,
      sclBlocks,
      simulationScripts,
      loadErrors
    }
  }

  /**
   * Saves the entire project payload into the modular folders
   */
  public static async saveProject(payload: ProjectLoadPayload): Promise<boolean> {
    const { projectPath, metadata, hardware, tagTables, udts, dataBlocks, ladBlocks, sclBlocks, simulationScripts } = payload
    await this.ensureProjectDirectories(projectPath)

    // Pre-validate all target file names & paths before writing anything to disk
    const writes: Array<{ fullPath: string; content: string }> = [
      { fullPath: await resolveInsideReal(projectPath, 'project.plc.json'), content: JSON.stringify(metadata, null, 2) },
      { fullPath: await resolveInsideReal(projectPath, 'hardware/cpu_config.json'), content: JSON.stringify(hardware, null, 2) }
    ]

    for (const table of tagTables) {
      const fileName = assertPlainFileName(table.fileName || `${table.name || 'tags'}.tags.json`)
      writes.push({ fullPath: await resolveInsideReal(projectPath, `tags/${fileName}`), content: JSON.stringify(table, null, 2) })
    }

    for (const udt of udts) {
      const fileName = assertPlainFileName(udt.fileName || `${udt.name}.udt.json`)
      writes.push({ fullPath: await resolveInsideReal(projectPath, `types/${fileName}`), content: JSON.stringify(udt, null, 2) })
    }

    for (const db of dataBlocks) {
      const fileName = assertPlainFileName(db.fileName || `${db.name}.db.json`)
      writes.push({ fullPath: await resolveInsideReal(projectPath, `blocks/${fileName}`), content: JSON.stringify(db, null, 2) })
    }

    for (const lad of ladBlocks) {
      const fileName = assertPlainFileName(lad.fileName || `${lad.name}.lad.json`)
      writes.push({ fullPath: await resolveInsideReal(projectPath, `blocks/${fileName}`), content: JSON.stringify(lad, null, 2) })
    }

    for (const scl of sclBlocks) {
      const fileName = assertPlainFileName(scl.fileName || `${scl.name}.scl`)
      writes.push({ fullPath: await resolveInsideReal(projectPath, `blocks/${fileName}`), content: toFullSource(scl) })
    }

    for (const script of simulationScripts || []) {
      const fileName = assertPlainFileName(script.fileName)
      writes.push({ fullPath: await resolveInsideReal(projectPath, `simulation/${fileName}`), content: script.code })
    }

    for (const item of writes) {
      await writeFileAtomic(item.fullPath, item.content)
    }

    return true
  }

  /**
   * Saves an individual file
   */
  public static async saveSingleFile(projectDir: string, relativePath: string, content: string): Promise<boolean> {
    const fullPath = await resolveInsideReal(projectDir, relativePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await writeFileAtomic(fullPath, content)
    return true
  }

  /**
   * Moves a deleted block, type or tag table to the project's .trash folder, so opening the project
   * does not bring it back and a mistake can still be undone by hand. Returns false if the file never
   * reached the disk.
   */
  public static async moveToTrash(projectDir: string, relativePath: string): Promise<boolean> {
    const match = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').match(/^(blocks|types|tags)\/([^/]+)$/)
    if (!match) throw new Error(`'${relativePath}' cannot be moved to the trash`)
    const fileName = assertPlainFileName(match[2])
    const source = await resolveInsideReal(projectDir, `${match[1]}/${fileName}`)

    let sourceStat
    try {
      sourceStat = await fs.lstat(source)
    } catch (err) {
      if (isMissingFile(err)) return false
      throw err
    }
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Cannot trash symbolic link '${relativePath}'`)
    }

    const trashDir = await resolveInsideReal(projectDir, '.trash')
    await fs.mkdir(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (let attempt = 0; attempt < MAX_TRASH_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? '' : `_${crypto.randomUUID().slice(0, 8)}`
      const target = path.join(trashDir, `${stamp}${suffix}_${match[1]}_${fileName}`)
      const taken = await fs.access(target).then(
        () => true,
        () => false
      )
      if (taken) continue
      try {
        await fs.rename(source, target)
        return true
      } catch (err) {
        if (isMissingFile(err)) return false
        throw err
      }
    }
    throw new Error(`Could not move '${relativePath}' to .trash after ${MAX_TRASH_ATTEMPTS} attempts`)
  }

  /**
   * Helper to parse an SCL file into an SclBlockDefinition
   */
  private static parseSclFile(fileName: string, rawContent: string): SclBlockDefinition {
    const baseName = fileName.replace(/\.scl$/i, '')
    const parsed = parseSourceBlock(rawContent)
    const prefix = baseName.match(/^(OB|FC|FB)(\d+)?/i)
    const kind = parsed.kind === 'OB' || parsed.kind === 'FB' || parsed.kind === 'FC' ? parsed.kind : undefined
    const blockType = kind || ((prefix?.[1].toUpperCase() as 'OB' | 'FB' | 'FC') ?? 'FB') || 'FB'

    const block: SclBlockDefinition = {
      blockType,
      blockNumber: prefix?.[2] ? parseInt(prefix[2], 10) : 1,
      name: parsed.name || baseName,
      fileName,
      optimizedAccess: parsed.optimizedAccess ?? true,
      interface: emptyInterface(),
      code: rawContent
    }
    block.interface = effectiveInterface(block)
    return block
  }

  public static getDefaultCpuConfig(): CpuConfig {
    return getDefaultCpuConfig()
  }
}
