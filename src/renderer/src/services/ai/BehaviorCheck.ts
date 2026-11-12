/**
 * Judges a circuit on the simulator: the reply's own test, the scenario's acceptance tests, and values the
 * circuit reads that nothing writes
 */

import { BehaviorTest, runBehaviorTest } from './CircuitBehaviorTest'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { useTagStore } from '../../stores/useTagStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { useBlockStore } from '../../stores/useBlockStore'
import {
  AcceptanceGate,
  AcceptanceSummary,
  evaluateScenario,
  formatAcceptanceLine,
  Scenario,
  specViolationsForModel,
  summarizeAcceptance
} from '../scenarios/ScenarioAcceptance'
import { LadderNetwork, LadderNode, LadderSeriesNode } from '@shared/types/ladder'
import { AiCircuitSynthesisPayload } from './aiTypes'
import { projectInStores } from './ProjectContext'

function walkLadder(nodes: LadderSeriesNode[] | undefined, visit: (n: LadderNode) => void): void {
  for (const node of nodes || []) {
    if (node.kind === 'parallel') node.branches.forEach((b) => walkLadder(b, visit))
    else visit(node)
  }
}

function listNames(names: string[], max = 12): string {
  return names.length > max ? `${names.slice(0, max).join(', ')} (+${names.length - max})` : names.join(', ')
}

/**
 * Runs the reply's test on the project as it stands now. A wrong behaviour always goes back to the model.
 * A missing test or a very short output pulse is raised once, and accepted with a note if the model repeats it.
 */
export function checkCircuitBehavior(
  test: BehaviorTest | undefined,
  askedOnce: Set<string>,
  isTurkish: boolean,
  circuit?: AiCircuitSynthesisPayload,
  /** The user approved the test, so how much it checks is not the model's to answer for */
  approvedTest = false
): { problems: string[]; note: string } {
  const askOnce = (kind: string, problems: string[], note: string): { problems: string[]; note: string } => {
    if (askedOnce.has(kind)) return { problems: [], note }
    askedOnce.add(kind)
    return { problems, note: '' }
  }

  if (!test) {
    return askOnce(
      'missing test',
      ['A ladder circuit needs a "verification" timeline, so it can be run on the simulator. Send the complete answer with one.'],
      isTurkish
        ? '**Simülasyon testi:** Model test göndermedi, devrenin davranışı doğrulanmadı.'
        : '**Simulation test:** The model sent no test, so the behaviour was not verified.'
    )
  }

  const result = runBehaviorTest(test, projectInStores())
  BlackBoxLogger.getInstance().log('AI_PARSE_AND_AST_INJECTION', `Simulation test: ${result.checks} checks, ${result.failures.length} failed`, {
    failures: result.failures,
    pulses: result.pulses,
    timeline: result.timeline
  })

  const whatHappened = result.timeline ? [`What the program really did:\n${result.timeline}`] : []
  // A test cannot set it and no rung writes it, so every rung that needs it is dead
  const unwritten = circuit ? readsNothingWrites(circuit.networks) : []
  if (result.failures.length > 0) {
    // A dead read is often why the test failed (an edge contact on a bit nothing writes never fires)
    const deadReads = unwritten.length
      ? [`Your circuit reads ${unwritten.join(', ')}, but nothing in OB1 writes it, so the rungs that need it never work. P_TRIG and N_TRIG take the signal itself: P_TRIG(Signal).`]
      : []
    // A value that arrives a scan or two after the check is a matter of timing, not of a wrong circuit
    const late = result.failures.some((f) => f.includes('scan(s) later'))
    const lateAdvice = !late
      ? []
      : approvedTest
        ? ['Some values come one or a few scans later than the approved test expects. Make the circuit set them sooner: a value written in a network below the one that needs it, or through an extra step bit, lags a scan.']
        : ['Some values come one or a few scans late. If that delay is right, check this value later in the test and keep the circuit.']
    return {
      problems: [`The simulation test failed:`, ...result.failures, ...lateAdvice, ...result.pulses, ...deadReads, ...whatHappened],
      note: ''
    }
  }
  if (unwritten.length > 0 && !askedOnce.has('unwritten read')) {
    askedOnce.add('unwritten read')
    return {
      problems: [
        `Your circuit reads ${unwritten.join(', ')}, but nothing in OB1 writes it and a test cannot set it, so the rungs that need it never work. Write it from the logic, or use an input (%I) tag for a signal that comes from outside. If an HMI or another device really writes it, send the same answer again.`,
        ...whatHappened
      ],
      note: ''
    }
  }
  // A test that passes but checks almost nothing shows nothing
  const checked = new Set(
    test.steps.flatMap((step) => Object.keys(step.expect || {})).map((k) => k.replace(/"/g, '').trim().toLowerCase())
  )
  const writtenNames = new Set<string>()
  const untested: string[] = []
  let untestedOutput = false
  for (const net of circuit?.networks || []) {
    walkLadder(net.nodes, (n) => {
      if (n.kind !== 'coil' || !n.operand) return
      const name = n.operand.replace(/"/g, '').trim()
      writtenNames.add(name.toLowerCase())
      if (checked.has(name.toLowerCase()) || checked.has((n.address || '').trim().toLowerCase())) return
      if (/^%Q/i.test((n.address || '').trim())) untestedOutput = true
      if (!untested.includes(name)) untested.push(name)
    })
  }
  // An internal bit the outputs already show need not be checked. An output nobody looks at, or a test that
  // looks at a few values of many, is thin
  const thinTest =
    untestedOutput || (writtenNames.size >= 4 && (writtenNames.size - untested.length) * 3 < writtenNames.size)
  if (!thinTest) untested.length = 0
  if (untested.length > 0 && !approvedTest && !askedOnce.has('untested writes')) {
    askedOnce.add('untested writes')
    return {
      problems: [
        `Your test passed, but it never checks ${listNames(untested, 30)}, which your circuit writes. A test that checks ${result.checks} value(s) does not show the circuit does what the user asked. Run the timeline through the whole behaviour (every step, every output, the fault, E-stop and reset paths) and expect these values on the way. If some of them really cannot be checked, send the same answer again.`,
        ...whatHappened
      ],
      note: ''
    }
  }
  const untestedNote = untested.length
    ? isTurkish
      ? `\n\n**Test kapsamı:** Test şunları hiç kontrol etmedi: ${listNames(untested)}. Bunların davranışı doğrulanmadı.`
      : `\n\n**Test coverage:** The test never checked ${listNames(untested)}. Their behaviour was not verified.`
    : ''
  const unwrittenNote = unwritten.length
    ? isTurkish
      ? `\n\n**Uyarı:** ${unwritten.join(', ')} okunuyor ama OB1'de hiçbir şey yazmıyor. HMI veya başka bir cihaz yazmazsa bunlara bağlı satırlar hiç çalışmaz ve test edilmedi.`
      : `\n\n**Warning:** ${unwritten.join(', ')} is read but nothing in OB1 writes it. Unless an HMI or another device writes it, the rungs that need it never work, and they were not tested.`
    : ''
  const passed =
    (isTurkish
      ? `**Simülasyon testi${approvedTest ? ' (onaylı)' : ''}:** ${result.checks} kontrolün hepsi geçti.`
      : `**Simulation test${approvedTest ? ' (approved)' : ''}:** all ${result.checks} checks passed.`) +
    untestedNote +
    unwrittenNote
  if (result.pulses.length > 0) {
    const asked = askOnce(
      'short pulse',
      [
        ...result.pulses,
        'A timer whose own Q output resets its IN gives a one-scan pulse. Fix the circuit. If such a short pulse is really wanted, send the same answer again.',
        ...whatHappened
      ],
      `${passed}\n\n${result.pulses.map((p) => `- ${p}`).join('\n')}`
    )
    return asked
  }
  return { problems: [], note: passed }
}

/**
 * The scenario's acceptance tests on the project as it stands. Under enforce, failed spec checks are problems
 * for the model; interpretation checks never are. The note is for the user only.
 */
export function judgeAcceptance(
  scenario: Scenario,
  gate: AcceptanceGate,
  isTurkish: boolean
): { problems: string[]; summary: AcceptanceSummary; note: string } {
  const results = evaluateScenario(scenario, projectInStores())
  const summary = summarizeAcceptance(scenario, results, gate)
  BlackBoxLogger.getInstance().log('AI_PARSE_AND_AST_INJECTION', `Acceptance (${scenario.id}, ${gate}): ${formatAcceptanceLine(summary)}`, {
    failures: results.filter((r) => !r.passed).map((r) => ({ id: r.check.id, kind: r.check.kind, failures: r.failures }))
  })
  const failedTitles = results.filter((r) => !r.passed).map((r) => `- ${r.check.title}${r.check.kind === 'interpretation' ? (isTurkish ? ' [yorum]' : ' [interpretation]') : ''}`)
  const heading = isTurkish
    ? `**Kabul testi (${scenario.title}):** ${formatAcceptanceLine(summary)}`
    : `**Acceptance test (${scenario.title}):** ${formatAcceptanceLine(summary)}`
  const how = isTurkish
    ? gate === 'enforce'
      ? 'Kabul testi kapı olarak çalıştı: spesifikasyon hataları modele gönderildi. Bu sonuç modelin kendi başarısı değil, üst sınırdır.'
      : 'Kabul testi sonucu yalnızca size gösterilir, modele gönderilmedi.'
    : gate === 'enforce'
      ? "The acceptance test ran as a gate: specification failures were sent to the model. This result is an upper bound, not the model's own."
      : 'The acceptance result is shown only to you; it was not sent to the model.'
  const note = [heading, ...failedTitles, `*${how}*`].join('\n')
  return { problems: gate === 'enforce' ? specViolationsForModel(results) : [], summary, note }
}

/**
 * Values the new networks read that are not inputs, constants or system bits, and that no rung of OB1 writes.
 * S7 allows them (an HMI may write them), so the model is asked about them, not stopped.
 */
function readsNothingWrites(newNetworks: LadderNetwork[]): string[] {
  const key = (op: string | undefined): string => (op || '').replace(/"/g, '').trim().toLowerCase()
  const walk = (nodes: LadderSeriesNode[] | undefined, visit: (n: LadderNode) => void): void => {
    for (const node of nodes || []) {
      if (node.kind === 'parallel') node.branches.forEach((b) => walk(b, visit))
      else visit(node)
    }
  }

  const tags = new Map(useTagStore.getState().tagTables.flatMap((t) => t.tags).map((t) => [t.name.toLowerCase(), t]))
  const constants = new Set<string>()
  for (const db of useBlockStore.getState().dataBlocks) {
    for (const v of db.variables || []) {
      const start = (v.defaultValue || '').trim().toLowerCase()
      if (start && !['0', '0.0', 'false'].includes(start)) constants.add(`${db.name}.${v.name}`.toLowerCase())
    }
  }
  const { clockMemory, systemMemory } = useHardwareStore.getState().config
  const systemBytes = [clockMemory?.enabled ? clockMemory.byteAddress : null, systemMemory?.enabled ? systemMemory.byteAddress : null]
    .filter((b) => b !== null && b !== undefined)
    .map((b) => `%m${b}.`)

  const ob1 = useBlockStore.getState().ladBlocks.find((b) => (b.blockType === 'OB' && b.blockNumber === 1) || b.name === 'OB1_Main')
  const written = new Set<string>()
  const write = (op: string | undefined, address?: string): void => {
    if (key(op)) written.add(key(op))
    if (key(address)) written.add(key(address))
  }
  for (const net of ob1?.networks || []) {
    walk(net.nodes, (n) => {
      if (n.kind === 'coil') write(n.operand, n.address)
      else if (n.kind === 'math') write(n.out)
      else if (n.kind === 'timer') [n.instanceDb, n.qOperand, n.etOperand].forEach((o) => write(o))
      else if (n.kind === 'counter') [n.instanceDb, n.qOperand, n.cvOperand, n.quOperand, n.qdOperand].forEach((o) => write(o))
      else if (n.kind === 'contact' && n.edgeTag) write(n.edgeTag)
    })
  }

  const found = new Map<string, string>()
  const read = (op: string | undefined, address?: string): void => {
    const k = key(op)
    if (!k || /^[-+]?\d/.test(k) || /^[a-z]+#/.test(k) || k === 'true' || k === 'false') return
    if (written.has(k) || constants.has(k)) return
    // A timer or counter field belongs to its instance
    const dot = k.indexOf('.')
    if (dot > 0 && (written.has(k.slice(0, dot)) || /\.(q|et|in|pt|cv|pv|qu|qd)$/.test(k))) return
    const tag = tags.get(k)
    if (!tag && dot < 0 && !k.startsWith('%')) return // unknown names are the compiler's errors
    const where = key(tag?.address || address || (k.startsWith('%') ? k : ''))
    if (where.startsWith('%i') || written.has(where) || systemBytes.some((b) => where.startsWith(b))) return
    const shown = (op || '').trim()
    const at = (tag?.address || address || '').trim()
    found.set(k, at.startsWith('%') && at.toLowerCase() !== k ? `${shown} (${at})` : shown)
  }
  for (const net of newNetworks) {
    walk(net.nodes, (n) => {
      if (n.kind === 'contact') read(n.operand, n.address)
      else if (n.kind === 'comparator') [n.op1, n.op2].forEach((o) => read(o))
      else if (n.kind === 'math') [n.in1, n.in2, n.value, n.min, n.max].forEach((o) => read(o))
    })
  }
  return Array.from(found.values())
}
