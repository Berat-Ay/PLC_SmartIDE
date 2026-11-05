// Reads TIA Portal exports into project definitions: external sources and SimaticML tag tables.
// LAD SimaticML is recognized and reported, not converted. That conversion is phase 3 work.
import { BlockVariable, DataBlockDefinition, SclBlockDefinition } from '../types/blocks'
import { TagDefinition, TagTable } from '../types/tags'
import { UdtDefinition } from '../types/types'
import { parseSourceBlock, ParsedSourceBlock } from '../scl/sourceBlock'
import { TiaManifest } from './bundle'

export interface TiaImportFile {
  /** Path relative to the chosen folder, with forward slashes. */
  path: string
  content: string
}

export interface TiaImportResult {
  udts: UdtDefinition[]
  dataBlocks: DataBlockDefinition[]
  sclBlocks: SclBlockDefinition[]
  tagTables: TagTable[]
  warnings: string[]
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

function element(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return match ? unescapeXml(match[1].trim()) : undefined
}

/** Reads a tag table. Returns null when the document is some other kind of SimaticML. */
export function readTagTableXml(xml: string, fileName: string): TagTable | null {
  const tableStart = xml.indexOf('<SW.Tags.PlcTagTable')
  if (tableStart < 0) return null

  const tagPattern = /<SW\.Tags\.PlcTag\b[\s\S]*?<\/SW\.Tags\.PlcTag>/g
  const tags: TagDefinition[] = []
  for (const match of xml.matchAll(tagPattern)) {
    const name = element(match[0], 'Name')
    const dataType = element(match[0], 'DataTypeName')
    const address = element(match[0], 'LogicalAddress')
    if (!name || !dataType) continue
    tags.push({
      id: `tag_${name}`,
      name,
      dataType: dataType.replace(/^"|"$/g, ''),
      address: address || '',
      comment: element(match[0], 'Text')
    })
  }

  const tableName = element(xml.slice(tableStart), 'Name') || fileName.replace(/\.xml$/i, '')
  return { id: `table_${tableName}`, name: tableName, fileName: `${tableName}.tags.json`, tags }
}

/** Start values written after BEGIN in a DB source: Member := value; */
function applyDbStartValues(parsed: ParsedSourceBlock, warnings: string[]): void {
  for (const raw of parsed.body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    const match = line.match(/^"?([A-Za-z_]\w*)"?\s*:=\s*(.+?)\s*;\s*$/)
    const variable = match && parsed.interface.static.find((v) => v.name.toLowerCase() === match[1].toLowerCase())
    if (match && variable) variable.defaultValue = match[2]
    else warnings.push(`${parsed.name}: start value '${line}' was not imported.`)
  }
}

function toUdtMembers(variables: BlockVariable[]): UdtDefinition['members'] {
  return variables.map((v) => ({
    id: v.id,
    name: v.name,
    dataType: v.dataType.replace(/^"|"$/g, ''),
    defaultValue: v.defaultValue,
    comment: v.comment
  }))
}

function stripTypeQuotes(variables: BlockVariable[]): BlockVariable[] {
  return variables.map((v) => ({
    ...v,
    dataType: v.dataType.replace(/^"([^"]+)"$/, '$1'),
    members: v.members ? stripTypeQuotes(v.members) : undefined
  }))
}

/** Reads every file of an export folder. Problems become warnings so the rest still imports. */
export function readTiaFolder(files: TiaImportFile[]): TiaImportResult {
  const result: TiaImportResult = { udts: [], dataBlocks: [], sclBlocks: [], tagTables: [], warnings: [] }

  let manifest: TiaManifest | null = null
  const manifestFile = files.find((f) => /(^|\/)manifest\.json$/i.test(f.path))
  if (manifestFile) {
    try {
      manifest = JSON.parse(manifestFile.content)
    } catch {
      result.warnings.push('manifest.json could not be read; block numbers are assigned automatically.')
    }
  }
  const numberOf = (name: string): number | undefined =>
    manifest?.steps?.find((s) => s.name.toLowerCase() === name.toLowerCase())?.number

  let nextAutoNumber = 1000
  const assignNumber = (name: string, fileName: string): number => {
    const known = numberOf(name)
    if (known) return known
    const fromName = `${name} ${fileName}`.match(/\b(?:OB|FB|FC|DB)(\d+)/i)
    if (fromName) return parseInt(fromName[1], 10)
    if (/^main$/i.test(name)) return 1
    result.warnings.push(`${name}: the export has no block number; assigned ${nextAutoNumber}.`)
    return nextAutoNumber++
  }

  for (const file of files) {
    const base = file.path.split('/').pop() as string
    const extension = base.split('.').pop()?.toLowerCase()

    if (extension === 'xml') {
      const table = readTagTableXml(file.content, base)
      if (table) result.tagTables.push(table)
      else if (/<FlgNet|ProgrammingLanguage>(LAD|FBD)/.test(file.content)) {
        result.warnings.push(`${file.path}: LAD/FBD block was not imported (phase 3).`)
      } else if (!file.path.startsWith('xml/')) {
        // The bridge writes an XML twin of every block into xml/. Text blocks already come from their source.
        result.warnings.push(`${file.path}: this SimaticML document type is not imported.`)
      }
      continue
    }
    if (extension !== 'scl' && extension !== 'db' && extension !== 'udt') continue

    const parsed = parseSourceBlock(file.content.replace(/^﻿/, ''))
    if (!parsed.hasHeader || !parsed.kind || !parsed.name) {
      result.warnings.push(`${file.path}: no block header found.`)
      continue
    }
    for (const err of parsed.errors) result.warnings.push(`${file.path}: ${err}`)

    if (parsed.kind === 'UDT') {
      result.udts.push({
        id: `udt_${parsed.name}`,
        name: parsed.name,
        fileName: `${parsed.name}.udt.json`,
        members: toUdtMembers(parsed.interface.static)
      })
    } else if (parsed.kind === 'DB') {
      applyDbStartValues(parsed, result.warnings)
      result.dataBlocks.push({
        blockType: 'DB',
        blockNumber: assignNumber(parsed.name, base),
        name: parsed.name,
        fileName: `${parsed.name}.db.json`,
        dbType: parsed.instanceOf ? 'Instance' : 'Global',
        parentFbName: parsed.instanceOf,
        optimizedAccess: parsed.optimizedAccess ?? true,
        variables: stripTypeQuotes(parsed.interface.static),
        comment: parsed.title
      })
    } else {
      result.sclBlocks.push({
        blockType: parsed.kind,
        blockNumber: assignNumber(parsed.name, base),
        name: parsed.name,
        fileName: `${parsed.name}.scl`,
        optimizedAccess: parsed.optimizedAccess ?? true,
        interface: parsed.interface,
        code: file.content.replace(/^﻿/, '').replace(/\r\n/g, '\n')
      })
    }
  }
  return result
}
