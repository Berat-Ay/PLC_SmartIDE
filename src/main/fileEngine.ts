import * as fs from 'fs/promises'
import * as path from 'path'
import { ProjectLoadPayload } from '../shared/types/ipc'
import { ProjectMetadata } from '../shared/types/project'
import { CpuConfig } from '../shared/types/hardware'
import { TagTable } from '../shared/types/tags'
import { UdtDefinition } from '../shared/types/types'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '../shared/types/blocks'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'
import { effectiveInterface, emptyInterface, parseSourceBlock, toFullSource } from '../shared/scl/sourceBlock'
import { assertPlainFileName, resolveInside } from './pathGuard'

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Writes through a temporary file, so a crash cannot leave a half-written project file. */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, content, 'utf-8')
  try {
    await fs.rename(temp, target)
  } catch (err) {
    // Sync clients and virus scanners can hold the target for a moment on Windows
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      await fs.rename(temp, target)
    } catch {
      await fs.rm(temp, { force: true })
      throw err
    }
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
   * Loads an entire project from disk conforming to the Everything-as-Code structure
   */
  public static async loadProject(projectDir: string): Promise<ProjectLoadPayload> {
    await this.ensureProjectDirectories(projectDir)

    // 1. Project metadata
    const metaPath = path.join(projectDir, 'project.plc.json')
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
    const hwPath = path.join(projectDir, 'hardware', 'cpu_config.json')
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
    const readEach = async (subdir: string, handle: (file: string, raw: string) => void): Promise<void> => {
      const files = await fs.readdir(path.join(projectDir, subdir))
      for (const file of files) {
        try {
          const fullPath = path.join(projectDir, subdir, file)
          if ((await fs.stat(fullPath)).isDirectory()) continue
          handle(file, await fs.readFile(fullPath, 'utf-8'))
        } catch (err) {
          loadErrors.push({ file: `${subdir}/${file}`, message: (err as Error).message })
        }
      }
    }

    // 3. Tag tables (/tags/*.tags.json)
    const tagTables: TagTable[] = []
    await readEach('tags', (file, raw) => {
      if (!file.endsWith('.tags.json')) return
      const table: TagTable = JSON.parse(raw)
      table.fileName = file
      tagTables.push(table)
    })

    // 4. UDT definitions (/types/*.udt.json)
    const udts: UdtDefinition[] = []
    await readEach('types', (file, raw) => {
      if (!file.endsWith('.udt.json')) return
      const udt: UdtDefinition = JSON.parse(raw)
      udt.fileName = file
      udts.push(udt)
    })

    // 5. Blocks (/blocks/)
    const dataBlocks: DataBlockDefinition[] = []
    const ladBlocks: LadBlockDefinition[] = []
    const sclBlocks: SclBlockDefinition[] = []
    await readEach('blocks', (file, raw) => {
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
    })

    // 6. Simulation scenarios are loaded as text. They only run when the user applies them.
    const simulationScripts: { fileName: string; code: string }[] = []
    await readEach('simulation', (file, raw) => {
      if (file.endsWith('.sim.js')) simulationScripts.push({ fileName: file, code: raw })
    })

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

    // Save project.plc.json
    await writeFileAtomic(path.join(projectPath, 'project.plc.json'), JSON.stringify(metadata, null, 2))

    // Save hardware/cpu_config.json
    await writeFileAtomic(path.join(projectPath, 'hardware', 'cpu_config.json'), JSON.stringify(hardware, null, 2))

    // Save tags
    for (const table of tagTables) {
      const fileName = table.fileName || `${table.name || 'tags'}.tags.json`
      await writeFileAtomic(path.join(projectPath, 'tags', assertPlainFileName(fileName)), JSON.stringify(table, null, 2))
    }

    // Save types
    for (const udt of udts) {
      const fileName = udt.fileName || `${udt.name}.udt.json`
      await writeFileAtomic(path.join(projectPath, 'types', assertPlainFileName(fileName)), JSON.stringify(udt, null, 2))
    }

    // Save blocks
    for (const db of dataBlocks) {
      const fileName = db.fileName || `${db.name}.db.json`
      await writeFileAtomic(path.join(projectPath, 'blocks', assertPlainFileName(fileName)), JSON.stringify(db, null, 2))
    }

    for (const lad of ladBlocks) {
      const fileName = lad.fileName || `${lad.name}.lad.json`
      await writeFileAtomic(path.join(projectPath, 'blocks', assertPlainFileName(fileName)), JSON.stringify(lad, null, 2))
    }

    for (const scl of sclBlocks) {
      const fileName = scl.fileName || `${scl.name}.scl`
      await writeFileAtomic(path.join(projectPath, 'blocks', assertPlainFileName(fileName)), toFullSource(scl))
    }

    for (const script of simulationScripts || []) {
      await writeFileAtomic(path.join(projectPath, 'simulation', assertPlainFileName(script.fileName)), script.code)
    }

    return true
  }

  /**
   * Saves an individual file
   */
  public static async saveSingleFile(projectDir: string, relativePath: string, content: string): Promise<boolean> {
    const fullPath = resolveInside(projectDir, relativePath)
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
    const source = resolveInside(projectDir, `${match[1]}/${fileName}`)

    const trashDir = resolveInside(projectDir, '.trash')
    await fs.mkdir(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `_${attempt}`
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
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    }
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
