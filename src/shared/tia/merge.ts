// Merges definitions read from TIA into the open project. Pure, so the UI can show the result before applying it.
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '../types/blocks'
import { TagTable } from '../types/tags'
import { UdtDefinition } from '../types/types'
import { TiaImportResult } from './readers'

export interface TiaProjectContents {
  udts: UdtDefinition[]
  dataBlocks: DataBlockDefinition[]
  ladBlocks: LadBlockDefinition[]
  sclBlocks: SclBlockDefinition[]
  tagTables: TagTable[]
}

export interface TiaMergeResult {
  next: TiaProjectContents
  added: string[]
  replaced: string[]
  skipped: string[]
  warnings: string[]
}

const key = (name: string): string => name.toLowerCase()

function upsert<T extends { name: string; fileName?: string; id?: string }>(
  current: T[],
  incoming: T[],
  label: string,
  result: TiaMergeResult
): T[] {
  const next = [...current]
  for (const item of incoming) {
    const index = next.findIndex((existing) => key(existing.name) === key(item.name))
    if (index >= 0) {
      const existing = next[index]
      next[index] = { ...item, fileName: existing.fileName ?? item.fileName, id: existing.id ?? item.id }
      result.replaced.push(`${label} ${item.name}`)
    } else {
      next.push(item)
      result.added.push(`${label} ${item.name}`)
    }
  }
  return next
}

/** A real CPU cannot hold two blocks of one kind with the same number. */
function reportNumberClashes(contents: TiaProjectContents, warnings: string[]): void {
  const seen = new Map<string, string>()
  const blocks = [...contents.sclBlocks, ...contents.ladBlocks, ...contents.dataBlocks]
  for (const block of blocks) {
    const id = `${block.blockType}${block.blockNumber}`
    const other = seen.get(id)
    if (other && key(other) !== key(block.name)) warnings.push(`${id} is used by both ${other} and ${block.name}.`)
    else seen.set(id, block.name)
  }
}

export function mergeTiaImport(current: TiaProjectContents, imported: TiaImportResult): TiaMergeResult {
  const result: TiaMergeResult = {
    next: current,
    added: [],
    replaced: [],
    skipped: [],
    warnings: [...imported.warnings]
  }

  // Replacing a LAD block with text would destroy its networks, so the user has to decide that by hand.
  const ladNames = new Set(current.ladBlocks.map((b) => key(b.name)))
  const sclBlocks = imported.sclBlocks.filter((block) => {
    if (!ladNames.has(key(block.name))) return true
    result.skipped.push(`${block.name}: a LAD block with this name exists in the project.`)
    return false
  })

  result.next = {
    udts: upsert(current.udts, imported.udts, 'UDT', result),
    dataBlocks: upsert(current.dataBlocks, imported.dataBlocks, 'DB', result),
    ladBlocks: current.ladBlocks,
    sclBlocks: upsert(current.sclBlocks, sclBlocks, 'SCL', result),
    tagTables: upsert(current.tagTables, imported.tagTables, 'Tag table', result)
  }
  reportNumberClashes(result.next, result.warnings)
  return result
}
