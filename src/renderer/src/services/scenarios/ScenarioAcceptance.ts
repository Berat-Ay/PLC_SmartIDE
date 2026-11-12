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
  /** Why the benchmark leaves this scenario out unless it is asked for by name */
  notInBenchmark?: string
  /** Never used to tune the agent: see heldOutScenarios.ts. The benchmark reports these apart */
  heldOut?: boolean
  /** Words the request must contain (case ignored) to be taken for this scenario, besides its addresses */
  matchWords: string[]
}

/**
 * What the agent does with a scenario's acceptance tests when the request is that scenario.
 * off: nothing. report: the result is shown to the user, never to the model, so the tests stay impartial.
 * enforce: a circuit that fails a spec check is undone and the failures go to the model. The model then
 * works with the answer key in hand: a pass under enforce is an upper bound, not a measure of the model.
 * Interpretation checks are never sent to the model, since they may be wrong.
 */
export type AcceptanceGate = 'off' | 'report' | 'enforce'

/** The result of the acceptance tests in short, for the user and the benchmark */
export interface AcceptanceSummary {
  scenarioId: string
  scenarioTitle: string
  gate: AcceptanceGate
  specPassed: number
  specTotal: number
  interpretationPassed: number
  interpretationTotal: number
  /** Ids of the checks that failed */
  failedSpec: string[]
  failedInterpretation: string[]
}

const addressPattern = /(^|[^A-Za-z0-9_.%])%?([IQM])(\d{1,3})\.([0-7])(?![0-9])/gi

/** Bit addresses written in a text, as %I0.0 / %Q1.2 / %M20.0 */
export function bitAddressesInText(text: string): Set<string> {
  const found = new Set<string>()
  for (const m of text.matchAll(addressPattern)) found.add(`%${m[2].toUpperCase()}${Number(m[3])}.${m[4]}`)
  return found
}

/** How much of the request's own I and Q addresses a scenario must account for */
const MIN_IO_COVERAGE = 0.8

export interface ScenarioMatch {
  scenario?: Scenario
  /** More than one scenario fits: none is used */
  ambiguous: Scenario[]
}

/**
 * The scenario a request is, if any: every address of the scenario is in the request, the scenario accounts
 * for most of the request's I/O, and the request has the scenario's words. A user's own request with a
 * few of the same addresses is not a textbook scenario, so the match is strict.
 */
export function matchScenario(prompt: string, scenarios: Scenario[]): ScenarioMatch {
  const inPrompt = bitAddressesInText(prompt)
  const promptIo = Array.from(inPrompt).filter((a) => !a.startsWith('%M'))
  const text = prompt.toLocaleLowerCase('tr')
  const fits = scenarios.filter((s) => {
    const own = new Set([...s.mustRead, ...s.mustWrite].map(normalize))
    if (own.size === 0 || Array.from(own).some((a) => !inPrompt.has(a))) return false
    const covered = promptIo.filter((a) => own.has(a)).length
    if (promptIo.length === 0 || covered / promptIo.length < MIN_IO_COVERAGE) return false
    return s.matchWords.every((w) => text.includes(w.toLocaleLowerCase('tr')))
  })
  return fits.length === 1 ? { scenario: fits[0], ambiguous: [] } : { ambiguous: fits.length > 1 ? fits : [] }
}

export function summarizeAcceptance(scenario: Scenario, results: CheckResult[], gate: AcceptanceGate): AcceptanceSummary {
  const spec = results.filter((r) => r.check.kind === 'spec')
  const interpretation = results.filter((r) => r.check.kind === 'interpretation')
  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    gate,
    specPassed: spec.filter((r) => r.passed).length,
    specTotal: spec.length,
    interpretationPassed: interpretation.filter((r) => r.passed).length,
    interpretationTotal: interpretation.length,
    failedSpec: spec.filter((r) => !r.passed).map((r) => r.check.id),
    failedInterpretation: interpretation.filter((r) => !r.passed).map((r) => r.check.id)
  }
}

/** One line: spec 9/11 · kalan: reset, idle · yorum 1/3 */
export function formatAcceptanceLine(s: AcceptanceSummary): string {
  const left = s.failedSpec.length ? ` · kalan: ${s.failedSpec.join(', ')}` : ''
  const interp = s.interpretationTotal
    ? ` · yorum ${s.interpretationPassed}/${s.interpretationTotal}` +
      (s.failedInterpretation.length ? ` (kalan: ${s.failedInterpretation.join(', ')})` : '')
    : ''
  return `spec ${s.specPassed}/${s.specTotal}${left}${interp}`
}

/**
 * The failed spec checks, written for the model as violations of the specification: the item, then what
 * the plant saw against what the item asks. Interpretation checks are left out.
 */
export function specViolationsForModel(results: CheckResult[], maxPerCheck = 4): string[] {
  const failed = results.filter((r) => r.check.kind === 'spec' && !r.passed)
  if (failed.length === 0) return []
  const lines = [
    `The circuit does not meet the user's specification. ${failed.length} item(s) of the specification failed when the plant was driven through it. Fix the circuit so it meets these items; passing your own test is not enough.`
  ]
  for (const r of failed) {
    lines.push(`Specification item not met: ${r.check.title}`)
    for (const f of r.failures.slice(0, maxPerCheck)) lines.push(`  - ${f}`)
    if (r.failures.length > maxPerCheck) lines.push(`  - ... and ${r.failures.length - maxPerCheck} more`)
  }
  return lines
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
        // A counter reads its count-down and reset inputs, and a comparator its operands, without a contact
        if (n.kind === 'counter') [n.cuOperand, n.cdOperand, n.rLdOperand].forEach((o) => read.add(addressOf(o)))
        if (n.kind === 'comparator') [n.op1, n.op2].forEach((o) => read.add(addressOf(o)))
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
