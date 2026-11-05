import * as fs from 'fs/promises'
import * as path from 'path'
import { ProjectLoadPayload } from '../shared/types/ipc'
import { ProjectMetadata } from '../shared/types/project'
import { CpuConfig } from '../shared/types/hardware'
import { TagTable } from '../shared/types/tags'
import { UdtDefinition } from '../shared/types/types'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '../shared/types/blocks'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'

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
      const raw = await fs.readFile(metaPath, 'utf-8')
      metadata = JSON.parse(raw)
      metadata.projectPath = projectDir
    } catch {
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
      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8')
    }

    // 2. Hardware / CPU config
    const hwPath = path.join(projectDir, 'hardware', 'cpu_config.json')
    let hardware: CpuConfig
    try {
      const rawHw = await fs.readFile(hwPath, 'utf-8')
      hardware = JSON.parse(rawHw)
    } catch {
      hardware = this.getDefaultCpuConfig()
      await fs.writeFile(hwPath, JSON.stringify(hardware, null, 2), 'utf-8')
    }

    // 3. Tag tables (/tags/*.tags.json)
    const tagTables: TagTable[] = []
    const tagsDir = path.join(projectDir, 'tags')
    try {
      const tagFiles = await fs.readdir(tagsDir)
      for (const file of tagFiles) {
        if (file.endsWith('.tags.json')) {
          const raw = await fs.readFile(path.join(tagsDir, file), 'utf-8')
          const table: TagTable = JSON.parse(raw)
          table.fileName = file
          tagTables.push(table)
        }
      }
    } catch {
      // ignore
    }

    // 4. UDT definitions (/types/*.udt.json)
    const udts: UdtDefinition[] = []
    const typesDir = path.join(projectDir, 'types')
    try {
      const typeFiles = await fs.readdir(typesDir)
      for (const file of typeFiles) {
        if (file.endsWith('.udt.json')) {
          const raw = await fs.readFile(path.join(typesDir, file), 'utf-8')
          const udt: UdtDefinition = JSON.parse(raw)
          udt.fileName = file
          udts.push(udt)
        }
      }
    } catch {
      // ignore
    }

    // 5. Blocks (/blocks/)
    const dataBlocks: DataBlockDefinition[] = []
    const ladBlocks: LadBlockDefinition[] = []
    const sclBlocks: SclBlockDefinition[] = []
    const blocksDir = path.join(projectDir, 'blocks')
    try {
      const blockFiles = await fs.readdir(blocksDir)
      for (const file of blockFiles) {
        const fullBlockPath = path.join(blocksDir, file)
        if (file.endsWith('.db.json')) {
          const raw = await fs.readFile(fullBlockPath, 'utf-8')
          const db: DataBlockDefinition = JSON.parse(raw)
          db.fileName = file
          dataBlocks.push(db)
        } else if (file.endsWith('.lad.json')) {
          const raw = await fs.readFile(fullBlockPath, 'utf-8')
          const lad: LadBlockDefinition = JSON.parse(raw)
          lad.fileName = file
          ladBlocks.push(lad)
        } else if (file.endsWith('.scl')) {
          const raw = await fs.readFile(fullBlockPath, 'utf-8')
          const scl = this.parseSclFile(file, raw)
          sclBlocks.push(scl)
        }
      }
    } catch {
      // ignore
    }

    return {
      projectPath: projectDir,
      metadata,
      hardware,
      tagTables,
      udts,
      dataBlocks,
      ladBlocks,
      sclBlocks
    }
  }

  /**
   * Saves the entire project payload into the modular folders
   */
  public static async saveProject(payload: ProjectLoadPayload): Promise<boolean> {
    const { projectPath, metadata, hardware, tagTables, udts, dataBlocks, ladBlocks, sclBlocks } = payload
    await this.ensureProjectDirectories(projectPath)

    // Save project.plc.json
    await fs.writeFile(
      path.join(projectPath, 'project.plc.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8'
    )

    // Save hardware/cpu_config.json
    await fs.writeFile(
      path.join(projectPath, 'hardware', 'cpu_config.json'),
      JSON.stringify(hardware, null, 2),
      'utf-8'
    )

    // Save tags
    for (const table of tagTables) {
      const fileName = table.fileName || `${table.name || 'tags'}.tags.json`
      await fs.writeFile(
        path.join(projectPath, 'tags', fileName),
        JSON.stringify(table, null, 2),
        'utf-8'
      )
    }

    // Save types
    for (const udt of udts) {
      const fileName = udt.fileName || `${udt.name}.udt.json`
      await fs.writeFile(
        path.join(projectPath, 'types', fileName),
        JSON.stringify(udt, null, 2),
        'utf-8'
      )
    }

    // Save blocks
    for (const db of dataBlocks) {
      const fileName = db.fileName || `${db.name}.db.json`
      await fs.writeFile(
        path.join(projectPath, 'blocks', fileName),
        JSON.stringify(db, null, 2),
        'utf-8'
      )
    }

    for (const lad of ladBlocks) {
      const fileName = lad.fileName || `${lad.name}.lad.json`
      await fs.writeFile(
        path.join(projectPath, 'blocks', fileName),
        JSON.stringify(lad, null, 2),
        'utf-8'
      )
    }

    for (const scl of sclBlocks) {
      const fileName = scl.fileName || `${scl.name}.scl`
      await fs.writeFile(path.join(projectPath, 'blocks', fileName), scl.code, 'utf-8')
    }

    return true
  }

  /**
   * Saves an individual file
   */
  public static async saveSingleFile(projectDir: string, relativePath: string, content: string): Promise<boolean> {
    const fullPath = path.join(projectDir, relativePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content, 'utf-8')
    return true
  }

  /**
   * Helper to parse an SCL file into an SclBlockDefinition
   */
  private static parseSclFile(fileName: string, rawContent: string): SclBlockDefinition {
    const baseName = fileName.replace(/\.scl$/i, '')
    let blockType: 'OB' | 'FB' | 'FC' = 'FB'
    let blockNumber = 1

    if (baseName.startsWith('OB')) {
      blockType = 'OB'
      const match = baseName.match(/OB(\d+)/i)
      if (match) blockNumber = parseInt(match[1], 10)
    } else if (baseName.startsWith('FC')) {
      blockType = 'FC'
      const match = baseName.match(/FC(\d+)/i)
      if (match) blockNumber = parseInt(match[1], 10)
    } else if (baseName.startsWith('FB')) {
      blockType = 'FB'
      const match = baseName.match(/FB(\d+)/i)
      if (match) blockNumber = parseInt(match[1], 10)
    }

    return {
      blockType,
      blockNumber,
      name: baseName,
      fileName,
      optimizedAccess: true,
      interface: {
        input: [],
        output: [],
        inOut: [],
        static: [],
        temp: [],
        constant: []
      },
      code: rawContent
    }
  }

  public static getDefaultCpuConfig(): CpuConfig {
    return getDefaultCpuConfig()
  }
}
