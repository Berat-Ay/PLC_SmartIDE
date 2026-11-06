// Writes TIA Portal external sources (.scl, .db, .udt) and SimaticML tag tables. Pure text generation.
import { BlockInterface, BlockVariable, DataBlockDefinition, SclBlockDefinition } from '../types/blocks'
import { TagDefinition, TagTable } from '../types/tags'
import { UdtDefinition, UdtMember } from '../types/types'
import { builtinInstanceKind, isElementaryTypeName } from '../s7/typeLayout'
import { effectiveInterface, parseSourceBlock, renderBlockHeader } from '../scl/sourceBlock'
import { qualifySclBody, SymbolContext } from './sclQualify'

const TIA_TYPE_NAMES: Record<string, string> = {
  BOOL: 'Bool',
  BYTE: 'Byte',
  WORD: 'Word',
  DWORD: 'DWord',
  LWORD: 'LWord',
  SINT: 'SInt',
  INT: 'Int',
  DINT: 'DInt',
  LINT: 'LInt',
  USINT: 'USInt',
  UINT: 'UInt',
  UDINT: 'UDInt',
  ULINT: 'ULInt',
  REAL: 'Real',
  LREAL: 'LReal',
  TIME: 'Time',
  LTIME: 'LTime',
  DATE: 'Date',
  TIME_OF_DAY: 'Time_Of_Day',
  TOD: 'Time_Of_Day',
  S5TIME: 'S5Time',
  CHAR: 'Char',
  WCHAR: 'WChar'
}

const BUILTIN_TYPE_NAMES: Record<string, string> = {
  TON: 'TON_TIME',
  TOF: 'TOF_TIME',
  TP: 'TP_TIME',
  CTU: 'CTU_INT',
  CTD: 'CTD_INT',
  CTUD: 'CTUD_INT',
  R_TRIG: 'R_TRIG',
  F_TRIG: 'F_TRIG'
}

/** Writes a data type the way TIA does: Int, String[20], Array[0..4] of Real, "UDT_Pump". */
export function tiaTypeName(rawName: string): string {
  const name = rawName.trim()
  if (/^struct$/i.test(name)) return 'Struct'

  const array = name.match(/^array\s*\[(.+?)\]\s*of\s+(.+)$/i)
  if (array) return `Array[${array[1].replace(/\s+/g, '')}] of ${tiaTypeName(array[2])}`

  const str = name.match(/^(w?string)(?:\s*\[\s*(\d+)\s*\])?$/i)
  if (str) {
    const base = str[1].toLowerCase() === 'wstring' ? 'WString' : 'String'
    return str[2] ? `${base}[${str[2]}]` : base
  }

  if (name.startsWith('"')) return name
  const upper = name.toUpperCase()
  if (upper in TIA_TYPE_NAMES) return TIA_TYPE_NAMES[upper]
  if (isElementaryTypeName(name)) return upper
  if (/^(IEC_TIMER|IEC_COUNTER)$/.test(upper)) return upper
  if (upper in BUILTIN_TYPE_NAMES) return BUILTIN_TYPE_NAMES[upper]
  if (builtinInstanceKind(name)) return upper
  return `"${name}"`
}

function normalizeVariable(variable: BlockVariable): BlockVariable {
  return {
    ...variable,
    dataType: tiaTypeName(variable.dataType),
    members: variable.members?.map(normalizeVariable)
  }
}

function normalizeInterface(iface: BlockInterface): BlockInterface {
  return {
    input: iface.input.map(normalizeVariable),
    output: iface.output.map(normalizeVariable),
    inOut: iface.inOut.map(normalizeVariable),
    static: iface.static.map(normalizeVariable),
    temp: iface.temp.map(normalizeVariable),
    constant: iface.constant.map(normalizeVariable)
  }
}

export interface WrittenSource {
  content: string
  warnings: string[]
}

export function writeSclBlock(block: SclBlockDefinition, symbols: SymbolContext): WrittenSource {
  const warnings: string[] = []
  const parsed = parseSourceBlock(block.code || '')
  const iface = effectiveInterface(block)
  const body = parsed.hasHeader ? parsed.body : block.code || ''
  const returnType = parsed.returnType ? tiaTypeName(parsed.returnType) : undefined

  if (block.blockType === 'OB' && block.blockNumber !== 1) {
    warnings.push(
      `${block.name}: an external source cannot state the OB type. Check in TIA that OB${block.blockNumber} has the expected type.`
    )
  }

  const header = renderBlockHeader({
    kind: block.blockType,
    name: block.name,
    returnType: returnType && returnType !== '"Void"' ? returnType : 'Void',
    title: parsed.title,
    version: parsed.version,
    optimizedAccess: parsed.optimizedAccess ?? block.optimizedAccess,
    iface: normalizeInterface(iface)
  })
  const keyword = { OB: 'ORGANIZATION_BLOCK', FB: 'FUNCTION_BLOCK', FC: 'FUNCTION' }[block.blockType]
  const qualified = qualifySclBody(body, iface, block.name, symbols).trim()
  const lines = [...header, ...indentBody(qualified), `END_${keyword}`, '']
  return { content: lines.join('\n'), warnings }
}

/** Keeps relative indentation and shifts the whole body to the usual three spaces. */
function indentBody(body: string): string[] {
  const lines = body.split('\n').map((l) => l.replace(/\s+$/, ''))
  const margins = lines.slice(1).filter((l) => l).map((l) => l.length - l.trimStart().length)
  const margin = margins.length > 0 ? Math.min(...margins) : 0
  return lines.map((l, index) => (l ? `   ${index === 0 ? l.trimStart() : l.slice(margin)}` : l))
}

function memberLine(member: UdtMember | BlockVariable, indent: string): string[] {
  const comment = member.comment ? ` // ${member.comment.replace(/\r?\n/g, ' ')}` : ''
  const init = member.defaultValue !== undefined && member.defaultValue !== '' ? ` := ${member.defaultValue}` : ''
  const nested = (member as BlockVariable).members
  if (/^struct$/i.test(member.dataType.trim())) {
    return [
      `${indent}${quoteMember(member.name)} : Struct${comment}`,
      ...(nested || []).flatMap((m) => memberLine(m, `${indent}   `)),
      `${indent}END_STRUCT;`
    ]
  }
  return [`${indent}${quoteMember(member.name)} : ${tiaTypeName(member.dataType)}${init};${comment}`]
}

function quoteMember(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`
}

export function writeUdt(udt: UdtDefinition): WrittenSource {
  const lines = [
    `TYPE "${udt.name}"`,
    'VERSION : 0.1',
    '   STRUCT',
    ...udt.members.flatMap((m) => memberLine(m, '      ')),
    '   END_STRUCT;',
    '',
    'END_TYPE',
    ''
  ]
  return { content: lines.join('\n'), warnings: [] }
}

export function writeDataBlock(db: DataBlockDefinition): WrittenSource {
  const warnings: string[] = []
  const lines = [`DATA_BLOCK "${db.name}"`]
  if (db.comment) lines.push(`TITLE = ${db.comment.replace(/\r?\n/g, ' ')}`)
  lines.push(`{ S7_Optimized_Access := '${db.optimizedAccess ? 'TRUE' : 'FALSE'}' }`, 'VERSION : 0.1')

  if (db.dbType === 'Instance' && db.parentFbName) {
    const kind = builtinInstanceKind(db.parentFbName)
    lines.push('NON_RETAIN')
    if (kind) lines.push(['TON', 'TOF', 'TP'].includes(kind) ? 'IEC_TIMER' : kind.startsWith('CT') ? 'IEC_COUNTER' : kind)
    else lines.push(`"${db.parentFbName}"`)
    lines.push('', 'BEGIN', '', 'END_DATA_BLOCK', '')
    return { content: lines.join('\n'), warnings }
  }

  const variables = db.variables || []
  const retained = variables.filter((v) => v.retain)
  if (db.optimizedAccess) {
    if (retained.length > 0) {
      lines.push('   VAR RETAIN', ...retained.flatMap((v) => memberLine(v, '      ')), '   END_VAR', '')
    }
    const others = variables.filter((v) => !v.retain)
    if (others.length > 0) lines.push('   VAR', ...others.flatMap((v) => memberLine(v, '      ')), '   END_VAR', '')
    if (retained.length === 0) lines.splice(lines.indexOf('VERSION : 0.1') + 1, 0, 'NON_RETAIN')
  } else {
    if (retained.length > 0 && retained.length < variables.length) {
      warnings.push(`${db.name}: a standard-access DB is retentive as a whole. Exported as retentive.`)
    }
    if (retained.length === 0) lines.push('NON_RETAIN')
    lines.push('   VAR', ...variables.flatMap((v) => memberLine(v, '      ')), '   END_VAR', '')
  }
  lines.push('BEGIN', '', 'END_DATA_BLOCK', '')
  return { content: lines.join('\n'), warnings }
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** The bridge replaces this with the running TIA version, because TIA rejects other versions. */
export const ENGINEERING_VERSION_PLACEHOLDER = 'V17'

export function writeTagTableXml(table: TagTable): WrittenSource {
  const warnings: string[] = []
  let id = 1
  const nextId = (): string => (id++).toString(16).toUpperCase()

  const tagXml = (tag: TagDefinition): string[] => {
    const out = [
      `      <SW.Tags.PlcTag ID="${nextId()}" CompositionName="Tags">`,
      '        <AttributeList>',
      `          <DataTypeName>${escapeXml(tiaTypeName(tag.dataType))}</DataTypeName>`,
      `          <LogicalAddress>${escapeXml(tag.address)}</LogicalAddress>`,
      `          <Name>${escapeXml(tag.name)}</Name>`,
      '        </AttributeList>'
    ]
    if (tag.comment) {
      out.push(
        '        <ObjectList>',
        `          <MultilingualText ID="${nextId()}" CompositionName="Comment">`,
        '            <ObjectList>',
        `              <MultilingualTextItem ID="${nextId()}" CompositionName="Items">`,
        '                <AttributeList>',
        '                  <Culture>en-US</Culture>',
        `                  <Text>${escapeXml(tag.comment)}</Text>`,
        '                </AttributeList>',
        '              </MultilingualTextItem>',
        '            </ObjectList>',
        '          </MultilingualText>',
        '        </ObjectList>'
      )
    } else {
      out.push('        <ObjectList />')
    }
    out.push('      </SW.Tags.PlcTag>')
    return out
  }

  const tags = (table.tags || []).filter((t) => {
    if (!t.address) warnings.push(`Tag ${t.name} has no address and was not exported.`)
    return !!t.address
  })
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Document>',
    `  <Engineering version="${ENGINEERING_VERSION_PLACEHOLDER}" />`,
    '  <SW.Tags.PlcTagTable ID="0">',
    '    <AttributeList>',
    `      <Name>${escapeXml(table.name)}</Name>`,
    '    </AttributeList>',
    '    <ObjectList>',
    ...tags.flatMap(tagXml),
    '    </ObjectList>',
    '  </SW.Tags.PlcTagTable>',
    '</Document>',
    ''
  ]
  return { content: lines.join('\n'), warnings }
}

/** For opening in Excel and saving as .xlsx, which is the only tag format TIA's own dialog imports. */
export function writeTagCsv(tables: TagTable[]): string {
  const q = (s: string): string => `"${String(s ?? '').replace(/"/g, '""')}"`
  const rows = ['Name,Path,Data Type,Logical Address,Comment,Hmi Visible,Hmi Accessible,Hmi Writeable,Typeobject ID,Version ID']
  for (const table of tables) {
    for (const tag of table.tags || []) {
      if (!tag.address) continue
      rows.push(
        [q(tag.name), q(table.name), q(tiaTypeName(tag.dataType)), q(tag.address), q(tag.comment || ''), 'True', 'True', 'True', '', ''].join(',')
      )
    }
  }
  return rows.join('\r\n') + '\r\n'
}
