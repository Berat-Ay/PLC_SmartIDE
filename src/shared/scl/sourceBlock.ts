// Parses and renders the declaration part of SCL external sources (header and VAR sections).
// Statements inside BEGIN..END stay as text; they are handled by the SCL lexer and parser.
import { BlockInterface, BlockVariable, SclBlockDefinition } from '../types/blocks'

export type SourceBlockKind = 'OB' | 'FB' | 'FC' | 'DB' | 'UDT'

export interface ParsedSourceBlock {
  hasHeader: boolean
  kind?: SourceBlockKind
  name?: string
  returnType?: string
  title?: string
  version?: string
  optimizedAccess?: boolean
  /** Instance DBs name their FB after the header, e.g. DATA_BLOCK "x" ... "FB1". */
  instanceOf?: string
  nonRetain?: boolean
  interface: BlockInterface
  /** Text in front of the header, usually a banner comment. */
  leading: string
  /** Statements between BEGIN and the END_ keyword, or the whole text when there is no header. */
  body: string
  errors: string[]
}

const HEADER_RE = /^\s*(ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|TYPE)\s+("[^"]+"|[^\s:]+)\s*(?::\s*(\S.*?))?\s*$/i
const END_RE = /^\s*END_(ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|TYPE)\s*;?\s*$/i

const KIND_BY_KEYWORD: Record<string, SourceBlockKind> = {
  ORGANIZATION_BLOCK: 'OB',
  FUNCTION_BLOCK: 'FB',
  FUNCTION: 'FC',
  DATA_BLOCK: 'DB',
  TYPE: 'UDT'
}

const KEYWORD_BY_KIND: Record<SourceBlockKind, string> = {
  OB: 'ORGANIZATION_BLOCK',
  FB: 'FUNCTION_BLOCK',
  FC: 'FUNCTION',
  DB: 'DATA_BLOCK',
  UDT: 'TYPE'
}

export function emptyInterface(): BlockInterface {
  return { input: [], output: [], inOut: [], static: [], temp: [], constant: [] }
}

function stripTrailingComment(line: string): { code: string; comment?: string } {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === '/' && line[i + 1] === '/' && !inSingle && !inDouble) {
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() }
    }
  }
  return { code: line }
}

let idCounter = 0
function nextId(name: string): string {
  idCounter++
  return `src_${name}_${idCounter}`
}

function makeVariable(name: string, dataType: string, defaultValue: string | undefined, comment: string | undefined, retain: boolean): BlockVariable {
  return {
    id: nextId(name),
    name,
    dataType,
    defaultValue,
    retain,
    accessibleFromHMI: true,
    comment
  }
}

/** Reads variable declarations from a line cursor until the terminator returns true. */
function readDeclarations(
  lines: string[],
  start: number,
  isEnd: (trimmedUpper: string) => boolean,
  retain: boolean,
  errors: string[]
): { vars: BlockVariable[]; next: number } {
  const vars: BlockVariable[] = []
  let i = start
  while (i < lines.length) {
    const { code, comment } = stripTrailingComment(lines[i])
    const text = code.trim()
    i++
    if (!text) continue
    if (isEnd(text.toUpperCase())) return { vars, next: i }

    const cleaned = text.replace(/\{[^}]*\}/g, ' ')
    const structMatch = cleaned.match(/^("[^"]+"|[^\s:]+)\s*:\s*struct\s*$/i)
    if (structMatch) {
      const inner = readDeclarations(lines, i, (u) => /^END_STRUCT\s*;?$/.test(u), retain, errors)
      const v = makeVariable(structMatch[1].replace(/^"|"$/g, ''), 'Struct', undefined, comment, retain)
      v.members = inner.vars
      vars.push(v)
      i = inner.next
      continue
    }

    const m = cleaned.match(/^("[^"]+"|[^\s:]+)\s*:\s*(.+?)\s*(?::=\s*(.+?))?\s*;\s*$/)
    if (!m) {
      errors.push(`Line ${i}: Cannot read declaration '${text}'`)
      continue
    }
    vars.push(makeVariable(m[1].replace(/^"|"$/g, ''), m[2].trim(), m[3]?.trim(), comment, retain))
  }
  errors.push(`Line ${i}: Declaration section is not closed`)
  return { vars, next: i }
}

/** Parses an SCL, DB or UDT source. A fragment without a block header is returned as body only. */
export function parseSourceBlock(source: string): ParsedSourceBlock {
  const lines = source.split(/\r?\n/)
  const result: ParsedSourceBlock = {
    hasHeader: false,
    interface: emptyInterface(),
    leading: '',
    body: source,
    errors: []
  }

  let headerLine = -1
  let inBlockComment = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (inBlockComment) {
      if (trimmed.includes('*)')) inBlockComment = false
      continue
    }
    if (!trimmed || trimmed.startsWith('//')) continue
    if (trimmed.startsWith('(*')) {
      if (!trimmed.includes('*)')) inBlockComment = true
      continue
    }
    if (HEADER_RE.test(lines[i])) headerLine = i
    break
  }
  if (headerLine < 0) return result

  const header = lines[headerLine].match(HEADER_RE)!
  result.hasHeader = true
  result.kind = KIND_BY_KEYWORD[header[1].toUpperCase()]
  result.name = header[2].replace(/^"|"$/g, '')
  result.returnType = header[3]?.trim()
  result.leading = lines.slice(0, headerLine).join('\n')

  const iface = result.interface
  let i = headerLine + 1
  let bodyStart = -1

  while (i < lines.length) {
    const { code } = stripTrailingComment(lines[i])
    const text = code.trim()
    const upper = text.toUpperCase()
    const lineIndex = i
    i++
    if (!text) continue

    if (/^BEGIN\b/.test(upper)) {
      bodyStart = i
      break
    }
    if (END_RE.test(text)) {
      i = lineIndex
      break
    }

    const titleMatch = text.match(/^TITLE\s*=\s*(.*)$/i)
    if (titleMatch) {
      result.title = titleMatch[1].trim().replace(/^"|"$/g, '')
      continue
    }
    const versionMatch = text.match(/^VERSION\s*:\s*(\S+)/i)
    if (versionMatch) {
      result.version = versionMatch[1]
      continue
    }
    if (text.startsWith('{')) {
      const attr = text.match(/S7_Optimized_Access\s*:=\s*'(TRUE|FALSE)'/i)
      if (attr) result.optimizedAccess = attr[1].toUpperCase() === 'TRUE'
      continue
    }
    if (/^NON_RETAIN\b/.test(upper)) {
      result.nonRetain = true
      continue
    }
    if (/^(AUTHOR|FAMILY|NAME|KNOW_HOW_PROTECT|READ_ONLY|DB_SPECIFIC)\b/.test(upper)) continue

    // Instance DB: the FB name on its own line in the header of a DATA_BLOCK
    if (result.kind === 'DB' && /^"[^"]+"$/.test(text)) {
      result.instanceOf = text.replace(/^"|"$/g, '')
      continue
    }

    if (result.kind === 'UDT' && /^STRUCT\b/.test(upper)) {
      const decl = readDeclarations(lines, i, (u) => /^END_STRUCT\s*;?$/.test(u), false, result.errors)
      iface.static.push(...decl.vars)
      i = decl.next
      continue
    }

    if (result.kind === 'DB' && /^STRUCT\b/.test(upper)) {
      const decl = readDeclarations(lines, i, (u) => /^END_STRUCT\s*;?$/.test(u), false, result.errors)
      iface.static.push(...decl.vars)
      i = decl.next
      continue
    }

    const varMatch = upper.match(/^VAR(_INPUT|_OUTPUT|_IN_OUT|_TEMP|_STAT)?(\s+\w+)?\s*$/)
    if (varMatch) {
      const qualifier = (varMatch[2] || '').trim()
      const retain = qualifier === 'RETAIN'
      const decl = readDeclarations(lines, i, (u) => /^END_VAR\s*;?$/.test(u), retain, result.errors)
      i = decl.next
      const section = varMatch[1]
      if (section === '_INPUT') iface.input.push(...decl.vars)
      else if (section === '_OUTPUT') iface.output.push(...decl.vars)
      else if (section === '_IN_OUT') iface.inOut.push(...decl.vars)
      else if (section === '_TEMP') iface.temp.push(...decl.vars)
      else if (qualifier === 'CONSTANT') iface.constant.push(...decl.vars)
      else iface.static.push(...decl.vars)
      continue
    }

    result.errors.push(`Line ${lineIndex + 1}: Unexpected text in block header: '${text}'`)
  }

  let bodyEnd = lines.length
  for (let j = lines.length - 1; j >= (bodyStart >= 0 ? bodyStart : i); j--) {
    if (END_RE.test(lines[j])) {
      bodyEnd = j
      break
    }
  }
  result.body = bodyStart >= 0 ? lines.slice(bodyStart, bodyEnd).join('\n') : ''
  return result
}

function renderVariable(v: BlockVariable, indent: string): string[] {
  const comment = v.comment ? ` // ${v.comment.replace(/\r?\n/g, ' ')}` : ''
  if (/^struct$/i.test(v.dataType.trim())) {
    const out = [`${indent}${quoteIfNeeded(v.name)} : Struct${comment}`]
    for (const m of v.members || []) out.push(...renderVariable(m, indent + '   '))
    out.push(`${indent}END_STRUCT;`)
    return out
  }
  const init = v.defaultValue !== undefined && v.defaultValue !== '' ? ` := ${v.defaultValue}` : ''
  return [`${indent}${quoteIfNeeded(v.name)} : ${v.dataType}${init};${comment}`]
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`
}

function renderSection(keyword: string, vars: BlockVariable[]): string[] {
  if (vars.length === 0) return []
  const out = [`   ${keyword}`]
  for (const v of vars) out.push(...renderVariable(v, '      '))
  out.push('   END_VAR', '')
  return out
}

/** Renders VAR sections for a code block. */
export function renderInterfaceSections(iface: BlockInterface, kind: 'OB' | 'FB' | 'FC'): string[] {
  const out: string[] = []
  if (kind !== 'OB') {
    out.push(...renderSection('VAR_INPUT', iface.input || []))
    out.push(...renderSection('VAR_OUTPUT', iface.output || []))
    out.push(...renderSection('VAR_IN_OUT', iface.inOut || []))
  }
  if (kind === 'FB') {
    const statics = iface.static || []
    out.push(...renderSection('VAR', statics.filter((v) => !v.retain)))
    out.push(...renderSection('VAR RETAIN', statics.filter((v) => v.retain)))
  }
  out.push(...renderSection('VAR_TEMP', iface.temp || []))
  out.push(...renderSection('VAR CONSTANT', iface.constant || []))
  return out
}

/** Renders the block header followed by its interface, up to and including BEGIN. */
export function renderBlockHeader(options: {
  kind: 'OB' | 'FB' | 'FC'
  name: string
  returnType?: string
  title?: string
  version?: string
  optimizedAccess: boolean
  iface: BlockInterface
}): string[] {
  const { kind, name } = options
  const keyword = KEYWORD_BY_KIND[kind]
  const out: string[] = []
  out.push(kind === 'FC' ? `${keyword} "${name}" : ${options.returnType || 'Void'}` : `${keyword} "${name}"`)
  if (options.title) out.push(`TITLE = ${options.title}`)
  out.push(`{ S7_Optimized_Access := '${options.optimizedAccess ? 'TRUE' : 'FALSE'}' }`)
  out.push(`VERSION : ${options.version || '0.1'}`)
  out.push(...renderInterfaceSections(options.iface, kind))
  out.push('BEGIN')
  return out
}

/** Keeps variable ids stable so the interface editor does not lose focus or selection. */
function mergeIds(next: BlockVariable[], prev: BlockVariable[] | undefined): BlockVariable[] {
  if (!prev) return next
  const byName = new Map(prev.map((v) => [v.name.toLowerCase(), v]))
  return next.map((v) => {
    const old = byName.get(v.name.toLowerCase())
    return old ? { ...old, ...v, id: old.id, accessibleFromHMI: old.accessibleFromHMI } : v
  })
}

export function mergeInterfaces(next: BlockInterface, prev?: BlockInterface): BlockInterface {
  return {
    input: mergeIds(next.input, prev?.input),
    output: mergeIds(next.output, prev?.output),
    inOut: mergeIds(next.inOut, prev?.inOut),
    static: mergeIds(next.static, prev?.static),
    temp: mergeIds(next.temp, prev?.temp),
    constant: mergeIds(next.constant, prev?.constant)
  }
}

/** The interface declared in an SCL block's source wins; fragments use the stored interface. */
export function effectiveInterface(block: Pick<SclBlockDefinition, 'code' | 'interface'>): BlockInterface {
  const parsed = parseSourceBlock(block.code || '')
  if (parsed.hasHeader && parsed.errors.length === 0) return parsed.interface
  return block.interface || emptyInterface()
}

/** Rewrites the declaration part of a block's source after its interface changed in the UI. */
export function rewriteSourceInterface(block: SclBlockDefinition, iface: BlockInterface): string {
  const parsed = parseSourceBlock(block.code || '')
  const body = parsed.hasHeader ? parsed.body : block.code || ''
  return composeSource(block, iface, body, parsed)
}

function composeSource(
  block: SclBlockDefinition,
  iface: BlockInterface,
  body: string,
  parsed: ParsedSourceBlock
): string {
  const header = renderBlockHeader({
    kind: block.blockType,
    name: parsed.name || block.name,
    returnType: parsed.returnType,
    title: parsed.title,
    version: parsed.version,
    optimizedAccess: parsed.optimizedAccess ?? block.optimizedAccess,
    iface
  })
  const parts: string[] = []
  if (parsed.leading.trim()) parts.push(parsed.leading.trimEnd(), '')
  parts.push(...header, body.replace(/\s+$/, ''), `END_${KEYWORD_BY_KIND[block.blockType]}`, '')
  return parts.join('\n')
}

/** Returns a complete source text for saving; fragments gain a header built from the interface. */
export function toFullSource(block: SclBlockDefinition): string {
  const parsed = parseSourceBlock(block.code || '')
  if (parsed.hasHeader) return block.code
  return composeSource(block, block.interface || emptyInterface(), block.code || '', parsed)
}
