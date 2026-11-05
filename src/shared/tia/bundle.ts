// Builds the export folder for TIA Portal: source files, tag tables and a manifest for the Openness bridge.
import { ProjectLoadPayload } from '../types/ipc'
import { getCpuProfile } from '../constants/cpuProfiles'
import { builtinInstanceKind } from '../s7/typeLayout'
import { effectiveInterface, parseSourceBlock } from '../scl/sourceBlock'
import { SclLexer } from '../scl/lexer'
import { writeDataBlock, writeSclBlock, writeTagCsv, writeTagTableXml, writeUdt } from './writers'
import { BlockVariable } from '../types/blocks'

export type TiaFileType = 'scl' | 'db' | 'udt' | 'xml' | 'csv' | 'manifest'

export interface TiaBundleFile {
  filename: string
  folder: string
  content: string
  type: TiaFileType
}

export type TiaStepKind = 'udt' | 'db' | 'fc' | 'fb' | 'ob'

export interface TiaManifestStep {
  file: string
  kind: TiaStepKind
  name: string
  number?: number
}

export interface TiaManifest {
  formatVersion: 1
  project: string
  cpu: { name: string; orderNumber: string; firmware: string } | null
  tagTables: { file: string; name: string }[]
  /** Source files in the order TIA has to generate them. */
  steps: TiaManifestStep[]
  skipped: { name: string; reason: string }[]
  warnings: string[]
}

export interface TiaBundle {
  manifest: TiaManifest
  files: TiaBundleFile[]
}

interface PlannedStep extends TiaManifestStep {
  content: string
  dependsOn: Set<string>
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_')
}

function typeReferences(dataType: string, into: Set<string>): void {
  const quoted = dataType.match(/"([^"]+)"/g)
  for (const q of quoted || []) into.add(q.replace(/"/g, '').toLowerCase())
  const bare = dataType.match(/^(?:array\s*\[.+?\]\s*of\s+)?([A-Za-z_]\w*)$/i)
  if (bare) into.add(bare[1].toLowerCase())
}

function variableReferences(variables: BlockVariable[] | undefined, into: Set<string>): void {
  for (const v of variables || []) {
    typeReferences(v.dataType, into)
    variableReferences(v.members, into)
  }
}

/** Orders steps so dependencies come first; kind order keeps unrelated blocks in a readable sequence. */
function orderSteps(steps: PlannedStep[], warnings: string[]): PlannedStep[] {
  const kindRank: Record<TiaStepKind, number> = { udt: 0, db: 1, fc: 2, fb: 3, ob: 5 }
  const rank = (s: PlannedStep): number => (s.kind === 'db' && s.dependsOn.size > 0 ? 4 : kindRank[s.kind])
  const byName = new Map(steps.map((s) => [s.name.toLowerCase(), s]))
  const sorted = [...steps].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const visited = new Map<PlannedStep, 'active' | 'done'>()
  const out: PlannedStep[] = []

  const visit = (step: PlannedStep): void => {
    const state = visited.get(step)
    if (state === 'done') return
    if (state === 'active') {
      warnings.push(`Blocks depend on each other in a cycle through ${step.name}. TIA may need a second compile.`)
      return
    }
    visited.set(step, 'active')
    const deps = [...step.dependsOn].filter((d) => d !== step.name.toLowerCase()).sort()
    for (const dep of deps) {
      const target = byName.get(dep)
      if (target) visit(target)
    }
    visited.set(step, 'done')
    out.push(step)
  }
  sorted.forEach(visit)
  return out
}

export function buildTiaBundle(payload: ProjectLoadPayload): TiaBundle {
  const warnings: string[] = []
  const skipped: TiaManifest['skipped'] = []
  const steps: PlannedStep[] = []

  const globals = new Set<string>()
  for (const table of payload.tagTables) for (const t of table.tags || []) globals.add(t.name.toLowerCase())
  for (const db of payload.dataBlocks) globals.add(db.name.toLowerCase())
  for (const b of [...payload.sclBlocks, ...payload.ladBlocks]) globals.add(b.name.toLowerCase())

  for (const lad of payload.ladBlocks) {
    skipped.push({ name: lad.name, reason: 'LAD blocks are not exported yet: TIA needs SimaticML, planned for phase 3.' })
  }
  if (payload.ladBlocks.length > 0) {
    warnings.push(`${payload.ladBlocks.length} LAD block(s) were not exported. SCL that calls them will not compile in TIA.`)
  }

  for (const udt of payload.udts) {
    const written = writeUdt(udt)
    const dependsOn = new Set<string>()
    for (const m of udt.members) typeReferences(m.dataType, dependsOn)
    warnings.push(...written.warnings)
    steps.push({ file: `${safeFileName(udt.name)}.udt`, kind: 'udt', name: udt.name, content: written.content, dependsOn })
  }

  for (const db of payload.dataBlocks) {
    const written = writeDataBlock(db)
    const dependsOn = new Set<string>()
    variableReferences(db.variables, dependsOn)
    if (db.dbType === 'Instance' && db.parentFbName && !builtinInstanceKind(db.parentFbName)) {
      dependsOn.add(db.parentFbName.toLowerCase())
    }
    warnings.push(...written.warnings)
    steps.push({
      file: `${safeFileName(db.name)}.db`,
      kind: 'db',
      name: db.name,
      number: db.blockNumber,
      content: written.content,
      dependsOn
    })
  }

  for (const block of payload.sclBlocks) {
    const written = writeSclBlock(block, { globals })
    const iface = effectiveInterface(block)
    const dependsOn = new Set<string>()
    for (const section of [iface.input, iface.output, iface.inOut, iface.static, iface.temp, iface.constant]) {
      variableReferences(section, dependsOn)
    }
    const { tokens } = SclLexer.tokenize(parseSourceBlock(block.code || '').body || block.code || '')
    tokens.forEach((token, index) => {
      if (token.quoted && tokens[index - 1]?.value !== '.') dependsOn.add(token.value.toLowerCase())
    })
    warnings.push(...written.warnings)
    steps.push({
      file: `${safeFileName(block.name)}.scl`,
      kind: block.blockType.toLowerCase() as TiaStepKind,
      name: block.name,
      number: block.blockNumber,
      content: written.content,
      dependsOn
    })
  }

  const ordered = orderSteps(steps, warnings)

  const files: TiaBundleFile[] = ordered.map((step) => ({
    filename: step.file,
    folder: 'sources',
    content: step.content,
    type: step.kind === 'udt' ? 'udt' : step.kind === 'db' ? 'db' : 'scl'
  }))

  const tagTables = payload.tagTables.map((table) => {
    const written = writeTagTableXml(table)
    warnings.push(...written.warnings)
    const filename = `${safeFileName(table.name)}.xml`
    files.push({ filename, folder: 'tags', content: written.content, type: 'xml' })
    return { file: `tags/${filename}`, name: table.name }
  })
  files.push({ filename: 'PLC_Tags.csv', folder: 'tags', content: writeTagCsv(payload.tagTables), type: 'csv' })

  const general = payload.hardware?.general
  const profile = getCpuProfile(general?.targetCpu || general?.cpuName || payload.metadata?.targetCpu)
  if (!profile) warnings.push('The target CPU is not known. Pass --cpu to the bridge or add the device in TIA by hand.')

  const manifest: TiaManifest = {
    formatVersion: 1,
    project: payload.metadata?.name || 'PLC_Project',
    cpu: profile ? { name: profile.name, orderNumber: profile.orderNumber, firmware: profile.firmwareVersion } : null,
    tagTables,
    steps: ordered.map(({ file, kind, name, number }) => ({ file: `sources/${file}`, kind, name, number })),
    skipped,
    warnings
  }
  files.push({ filename: 'manifest.json', folder: '', content: JSON.stringify(manifest, null, 2) + '\n', type: 'manifest' })

  return { manifest, files }
}
