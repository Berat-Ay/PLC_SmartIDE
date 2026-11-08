/**
 * Acceptance tests written from a scenario's specification, not by the model.
 * The model's own test shows that a circuit does what the model thinks. These show that it does what the
 * specification says. Each check is one item of the specification and drives the circuit only through the
 * addresses the specification gives (%I in, %Q and %M out), so any circuit for the same plant can be judged.
 *
 * Kinds of checks:
 * - spec: what the specification says in so many words
 * - interpretation: what the specification leaves open, read the way a plant needs it. The user may disagree
 */
import { ProjectLoadPayload } from '@shared/types/ipc'
import { LadderNetwork, LadderNode, LadderSeriesNode } from '@shared/types/ladder'
import { TagDefinition } from '@shared/types/tags'
import { BehaviorStep, BehaviorTest, runBehaviorTest } from '../ai/CircuitBehaviorTest'

type Value = boolean | number

export type CheckKind = 'spec' | 'interpretation'

export interface ScenarioCheck {
  id: string
  kind: CheckKind
  /** The item of the specification, as the user reads it */
  title: string
  /** Values that must be on in at least one scan of the check's timeline (a momentary signal) */
  mustTurnOn?: string[]
}

/** A moment of a timeline. Expectations are grouped by the check they belong to */
export interface PathStep {
  atMs: number
  set?: Record<string, Value>
  expect?: Record<string, Record<string, Value>>
}

export interface Scenario {
  id: string
  title: string
  checks: ScenarioCheck[]
  /** Timelines that drive the plant. A check's expectations sit in one of them */
  paths: PathStep[][]
  /** Inputs of the specification the program must read */
  mustRead: string[]
  /** Outputs and memory bits of the specification the program must write */
  mustWrite: string[]
  /** What these checks cannot judge */
  notChecked: string[]
}

export interface CheckResult {
  check: ScenarioCheck
  passed: boolean
  failures: string[]
}

/** The timeline of one check: its path up to its last expectation, with only its own expectations */
export function testForCheck(scenario: Scenario, checkId: string): BehaviorTest | undefined {
  for (const path of scenario.paths) {
    const last = path.map((s) => !!s.expect?.[checkId]).lastIndexOf(true)
    if (last < 0) continue
    const steps: BehaviorStep[] = []
    for (const step of path.slice(0, last + 1)) {
      const expect = step.expect?.[checkId]
      if (!step.set && !expect) continue
      steps.push({ atMs: step.atMs, ...(step.set ? { set: step.set } : {}), ...(expect ? { expect } : {}) })
    }
    return { steps }
  }
  return undefined
}

const normalize = (address: string): string => `%${address.replace(/[\s%"]/g, '').toUpperCase()}`

function walk(nodes: LadderSeriesNode[] | undefined, visit: (n: LadderNode) => void): void {
  for (const node of nodes || []) {
    if (node.kind === 'parallel') node.branches.forEach((b) => walk(b, visit))
    else visit(node)
  }
}

/** Addresses the program reads with a contact and writes with a coil */
function addressesInProgram(project: ProjectLoadPayload): { read: Set<string>; written: Set<string> } {
  const tags = new Map(project.tagTables.flatMap((t) => t.tags || []).map((t) => [t.name.toLowerCase(), t.address]))
  const addressOf = (operand?: string, address?: string): string => {
    const name = (operand || '').replace(/"/g, '').trim().toLowerCase()
    const raw = tags.get(name) || address || operand || ''
    return /^%?[IQM]\d/i.test(raw.trim()) ? normalize(raw) : ''
  }
  const read = new Set<string>()
  const written = new Set<string>()
  for (const block of project.ladBlocks) {
    for (const net of block.networks || []) {
      walk(net.nodes, (n) => {
        if (n.kind === 'contact') read.add(addressOf(n.operand, n.address))
        if (n.kind === 'coil') written.add(addressOf(n.operand, n.address))
      })
    }
  }
  return { read, written }
}

export function evaluateScenario(scenario: Scenario, project: ProjectLoadPayload): CheckResult[] {
  const results: CheckResult[] = []
  const { read, written } = addressesInProgram(project)
  const notRead = scenario.mustRead.map(normalize).filter((a) => !read.has(a))
  const notWritten = scenario.mustWrite.map(normalize).filter((a) => !written.has(a))
  results.push({
    check: { id: 'reads', kind: 'spec', title: 'Spesifikasyondaki bütün girişler programda okunuyor' },
    passed: notRead.length === 0,
    failures: notRead.length ? [`Hiçbir kontak okumuyor: ${notRead.join(', ')}`] : []
  })
  results.push({
    check: { id: 'writes', kind: 'spec', title: 'Spesifikasyondaki bütün çıkışlar ve M bitleri kendi adresinde yazılıyor' },
    passed: notWritten.length === 0,
    failures: notWritten.length ? [`Hiçbir bobin yazmıyor: ${notWritten.join(', ')}`] : []
  })

  for (const check of scenario.checks) {
    const test = testForCheck(scenario, check.id)
    if (!test) {
      results.push({ check, passed: false, failures: ['Bu kontrolün zaman çizelgesi yok (senaryo tanımında hata).'] })
      continue
    }
    const result = runBehaviorTest(test, project)
    const failures = [...result.failures]
    for (const name of check.mustTurnOn || []) {
      if (!result.seenOn.includes(name)) failures.push(`${name} hiç 1 olmadı.`)
    }
    results.push({ check, passed: failures.length === 0, failures })
  }
  return results
}

/** The project a diagnostic dump describes: its OB1 and its tag table on the demo CPU */
export function projectFromDump(dump: string, base: ProjectLoadPayload): ProjectLoadPayload {
  const section = (heading: RegExp): unknown => {
    const start = dump.search(heading)
    if (start < 0) throw new Error(`The dump has no section ${heading}`)
    const block = dump.slice(start).match(/```json\s*\n([\s\S]*?)\n```/)
    if (!block) throw new Error(`The section ${heading} has no JSON block`)
    return JSON.parse(block[1])
  }
  const ob1 = section(/## 2\. ACTIVE OB1_MAIN LADDER AST/) as ProjectLoadPayload['ladBlocks'][number]
  const tagTables = section(/## 3\. S7 TAG TABLE/) as ProjectLoadPayload['tagTables']
  return { ...base, ladBlocks: [ob1], sclBlocks: [], dataBlocks: [], udts: [], tagTables }
}

/** A project with one OB1 made of the given networks and tags */
export function projectFromCircuit(networks: LadderNetwork[], tags: TagDefinition[], base: ProjectLoadPayload): ProjectLoadPayload {
  const ob1 = base.ladBlocks.find((b) => b.blockType === 'OB' && b.blockNumber === 1)
  if (!ob1) throw new Error('The base project has no OB1')
  return {
    ...base,
    ladBlocks: [{ ...ob1, networks }],
    sclBlocks: [],
    dataBlocks: [],
    udts: [],
    tagTables: [{ id: 'table_default', name: 'default_tags', fileName: 'default_tags.tags.json', tags }]
  }
}

export function formatReport(scenario: Scenario, results: CheckResult[]): string {
  const lines = [`Senaryo: ${scenario.title}`, '']
  for (const r of results) {
    const kind = r.check.kind === 'interpretation' ? ' [yorum]' : ''
    lines.push(`${r.passed ? 'GEÇTİ ' : 'KALDI '} ${r.check.title}${kind}`)
    for (const f of r.failures.slice(0, 6)) lines.push(`        - ${f}`)
    if (r.failures.length > 6) lines.push(`        - ... ve ${r.failures.length - 6} hata daha`)
  }
  const spec = results.filter((r) => r.check.kind === 'spec')
  const interp = results.filter((r) => r.check.kind === 'interpretation')
  lines.push(
    '',
    `Spesifikasyon: ${spec.filter((r) => r.passed).length}/${spec.length} geçti` +
      (interp.length ? `, yorum: ${interp.filter((r) => r.passed).length}/${interp.length} geçti` : ''),
    '',
    'Bu kontrollerin ölçemedikleri:',
    ...scenario.notChecked.map((n) => `- ${n}`)
  )
  return lines.join('\n')
}
