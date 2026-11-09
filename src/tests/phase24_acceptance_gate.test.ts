/**
 * The acceptance gate: when the request is a built-in scenario, its acceptance tests judge the circuit.
 * report shows the result to the user and never to the model; enforce undoes a circuit that fails a spec
 * check and sends the failures back; off does nothing. The benchmark keeps enforce runs apart.
 */
import assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { BenchRun, formatBenchSummary, newBenchProject } from '../renderer/src/services/scenarios/Benchmark'
import { SCENARIOS } from '../renderer/src/services/scenarios/scenarios'
import {
  CheckResult,
  matchScenario,
  Scenario,
  specViolationsForModel
} from '../renderer/src/services/scenarios/ScenarioAcceptance'

console.log('\n=== PHASE 24: ACCEPTANCE GATE ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const router = AiModelRouter.getInstance()

// Gemini answers from a script; every request body is kept
const sent: string[] = []
let script: string[] = []
const realFetch = globalThis.fetch
;(globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body?: string }) => {
  sent.push(init?.body || '')
  const text = script[Math.min(sent.length - 1, script.length - 1)]
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })
}
function answers(...replies: string[]): void {
  sent.length = 0
  script = replies
}

const promptsDir = path.resolve('src/renderer/src/services/scenarios/prompts')
const promptOf = (id: string): string => fs.readFileSync(path.join(promptsDir, `${id}.txt`), 'utf-8')
const MOTOR_PROMPT = promptOf('motor-start-stop')

const TAG_LINES = `TAG Start %I0.0 BOOL "a"
TAG Stop %I0.1 BOOL "a"
TAG Thermal %I0.2 BOOL "a"
TAG Reset %I0.3 BOOL "a"
TAG Motor %Q0.0 BOOL "a"
TAG Fault %Q0.1 BOOL "a"
TAG RunLamp %Q0.2 BOOL "a"`
// Meets every item of the motor scenario
const GOOD_DSL = `${TAG_LINES}
NW 1 "a": SERIES( NC(Thermal), SET(Fault) )
NW 2 "b": SERIES( NO(Reset), NO(Thermal), RESET(Fault) )
NW 3 "c": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), NO(Thermal), NC(Fault), COIL(Motor) )
NW 4 "d": SERIES( NO(Motor), COIL(RunLamp) )`
// The fault lamp is not latched and Reset is never read: the model's own test below cannot see that
const UNLATCHED_DSL = `${TAG_LINES}
NW 1 "a": SERIES( NC(Thermal), COIL(Fault) )
NW 2 "c": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), NO(Thermal), COIL(Motor) )
NW 3 "d": SERIES( NO(Motor), COIL(RunLamp) )`
const OWN_TEST = {
  steps: [
    { atMs: 0, set: { Stop: true, Thermal: true } },
    { atMs: 100, set: { Start: true } },
    { atMs: 200, set: { Start: false } },
    { atMs: 300, expect: { Motor: true, RunLamp: true, Fault: false } },
    { atMs: 400, set: { Thermal: false } },
    { atMs: 500, expect: { Motor: false, RunLamp: false, Fault: true } }
  ]
}
const reply = (dsl: string): string =>
  JSON.stringify({ explanation: 'Motor devresi.', operationMode: 'replace_ob1_networks', dsl, verification: OWN_TEST })
const ob1Dsl = (): string =>
  JSON.stringify(useBlockStore.getState().ladBlocks.find((b) => b.blockType === 'OB' && b.blockNumber === 1)?.networks || [])

async function main(): Promise<void> {
  // ---- Every prompt file is its own scenario, and nothing else is ----
  for (const s of SCENARIOS) {
    assert.strictEqual(matchScenario(promptOf(s.id), SCENARIOS).scenario?.id, s.id, s.id)
  }
  // A user's own request with some of the same addresses is not a textbook scenario
  assert.strictEqual(matchScenario('Start I0.0, Stop I0.1 (NC), motor Q0.0', SCENARIOS).scenario, undefined)
  // The right addresses without the scenario's words are not enough either
  assert.strictEqual(
    matchScenario('Girişler I0.0 I0.1 I0.2 I0.3, çıkışlar Q0.0 Q0.1 Q0.2 olan bir karıştırıcı', SCENARIOS).scenario,
    undefined
  )
  // A request that is two scenarios at once is neither
  const twin: Scenario = { ...SCENARIOS.find((s) => s.id === 'motor-start-stop')!, id: 'twin' }
  const both = matchScenario(MOTOR_PROMPT, [...SCENARIOS, twin])
  assert.strictEqual(both.scenario, undefined)
  assert.deepStrictEqual(both.ambiguous.map((s) => s.id).sort(), ['motor-start-stop', 'twin'])
  ok('Each scenario prompt matches only its scenario; a partial or ambiguous request matches none')

  // ---- Only spec checks go to the model ----
  const results: CheckResult[] = [
    { check: { id: 'a', kind: 'spec', title: 'Spec item A' }, passed: false, failures: ["At 100 ms '%Q0.0' should be TRUE but is FALSE."] },
    { check: { id: 'b', kind: 'interpretation', title: 'Reading B' }, passed: false, failures: ['secret'] },
    { check: { id: 'c', kind: 'spec', title: 'Spec item C' }, passed: true, failures: [] }
  ]
  const forModel = specViolationsForModel(results).join('\n')
  assert.ok(forModel.includes('Specification item not met: Spec item A') && forModel.includes("'%Q0.0' should be TRUE"), forModel)
  assert.ok(!forModel.includes('Reading B') && !forModel.includes('secret') && !forModel.includes('Spec item C'), forModel)
  assert.deepStrictEqual(specViolationsForModel(results.filter((r) => r.check.kind !== 'spec' || r.passed)), [])
  ok('Failed spec checks are written for the model as items of the specification; interpretation checks never are')

  router.updateConfig({ provider: 'gemini', geminiApiKey: 'test-key', selectedModelId: 'gemini-2.5-flash', testFirst: false })

  // ---- report: the user sees the result, the model never hears of it ----
  router.updateConfig({ acceptanceGate: 'report' })
  newBenchProject()
  answers(reply(UNLATCHED_DSL))
  const reported = await router.executePrompt(MOTOR_PROMPT, 'fast-flash', 'auto-apply')
  assert.ok(!reported.isError, reported.replyText)
  assert.strictEqual(sent.length, 1, 'One request: the acceptance result does not go back to the model')
  assert.ok(ob1Dsl().includes('Fault'), 'The circuit that passed its own test is applied')
  assert.strictEqual(reported.acceptanceReport?.scenarioId, 'motor-start-stop')
  assert.strictEqual(reported.acceptanceReport?.gate, 'report')
  assert.ok(reported.acceptanceReport!.specPassed < reported.acceptanceReport!.specTotal)
  assert.ok(reported.acceptanceReport!.failedSpec.includes('latch'), reported.acceptanceReport!.failedSpec.join(','))
  assert.ok(reported.replyText.includes('Kabul testi') && reported.replyText.includes('modele gönderilmedi'), reported.replyText)
  ok('report: a circuit that passes its own test is applied, and its acceptance result is shown only to the user')

  // In diff-view the staged circuit is judged on a trial run, and the project is left as it was
  newBenchProject()
  answers(reply(UNLATCHED_DSL))
  const staged = await router.executePrompt(MOTOR_PROMPT, 'fast-flash', 'diff-view')
  assert.ok(!staged.isError && staged.stagedChangeset && staged.stagedChangeset.length > 0, staged.replyText)
  assert.strictEqual(ob1Dsl().includes('Fault'), false, 'Nothing is applied before approval')
  assert.ok(staged.acceptanceReport?.failedSpec.includes('latch'), staged.replyText)
  assert.strictEqual(sent.length, 1)
  ok('report in diff-view: the staged circuit carries its acceptance result and the project is unchanged')

  // ---- enforce: a spec failure undoes the circuit and goes back to the model ----
  router.updateConfig({ acceptanceGate: 'enforce' })
  newBenchProject()
  answers(reply(UNLATCHED_DSL), reply(GOOD_DSL))
  const enforced = await router.executePrompt(MOTOR_PROMPT, 'fast-flash', 'auto-apply')
  assert.ok(!enforced.isError, enforced.replyText)
  assert.strictEqual(sent.length, 2, 'The failed circuit was sent back once')
  assert.ok(sent[1].includes('Specification item not met') && sent[1].includes('reset'), 'The model gets the spec items it missed')
  assert.strictEqual(enforced.acceptanceReport?.specPassed, enforced.acceptanceReport?.specTotal)
  assert.strictEqual(enforced.acceptanceReport?.gate, 'enforce')
  assert.ok(enforced.replyText.includes('üst sınırdır'), 'The user is told the pass is not impartial')
  ok('enforce: a circuit that fails a spec check is undone, the failures go to the model, and the fixed circuit is kept')

  // A model that never meets the specification leaves the project as it was and offers its last circuit
  newBenchProject()
  answers(reply(UNLATCHED_DSL))
  const never = await router.executePrompt(MOTOR_PROMPT, 'fast-flash', 'auto-apply')
  assert.ok(never.isError, never.replyText)
  assert.strictEqual(ob1Dsl().includes('Fault'), false, 'Nothing was applied')
  assert.ok(never.stagedChangeset && never.stagedChangeset.length > 0, 'The last circuit is offered for review')
  assert.ok(never.replyText.includes('kabul testini geçemedi'), never.replyText)
  assert.ok(never.acceptanceReport && never.acceptanceReport.failedSpec.length > 0)
  ok('enforce: when the rounds run out, the project is unchanged and the reply says the acceptance test failed')

  // ---- off: no acceptance test at all ----
  router.updateConfig({ acceptanceGate: 'off' })
  newBenchProject()
  answers(reply(UNLATCHED_DSL))
  const off = await router.executePrompt(MOTOR_PROMPT, 'fast-flash', 'auto-apply')
  assert.ok(!off.isError && off.acceptanceReport === undefined && !off.replyText.includes('Kabul testi'), off.replyText)
  assert.strictEqual(sent.length, 1)
  ok('off: the circuit is judged by its own test only')

  // ---- A request that is not a scenario gets no acceptance result ----
  router.updateConfig({ acceptanceGate: 'enforce' })
  newBenchProject()
  answers(reply(UNLATCHED_DSL))
  const own = await router.executePrompt('Start I0.0, Stop I0.1, Thermal I0.2, Reset I0.3, Motor Q0.0, Fault Q0.1, RunLamp Q0.2', 'fast-flash', 'auto-apply')
  assert.ok(!own.isError && own.acceptanceReport === undefined, own.replyText)
  ok("A user's own request is never gated by a built-in scenario")

  // ---- The benchmark never counts enforce runs with the others ----
  const run = (gate: BenchRun['gate'], specPassed: number): BenchRun => ({
    scenario: 'motor-start-stop',
    run: 1,
    gate,
    heldOut: false,
    outcome: 'applied',
    specPassed,
    specTotal: 11,
    interpretationPassed: 0,
    interpretationTotal: 0,
    failedChecks: [],
    rounds: 1,
    models: ['m'],
    fallbacks: [],
    durationMs: 1,
    reply: '',
    dsl: ''
  })
  const summary = formatBenchSummary([run('off', 9), run('enforce', 11), run('enforce', 11)])
  assert.match(summary, /^motor-start-stop\s+1\s+1\s+0\s+0\s+0\s+0\/1/m, summary)
  assert.match(summary, /^motor-start-stop \[enforce\]\s+2\s+2\s+0\s+0\s+0\s+2\/2/m, summary)
  assert.ok(summary.includes('Toplam: 1 koşu, spesifikasyonun tamamını karşılayan 0 (0%)'), summary)
  assert.ok(summary.includes('Enforce: 2 koşu, tam karşılayan 2 (100%)') && summary.includes('üst sınırdır'), summary)
  ok('The benchmark summary shows enforce runs in their own rows and total, as an upper bound')

  const held = { ...run('off', 11), scenario: 'heater-fan', heldOut: true }
  const split = formatBenchSummary([run('off', 11), run('off', 9), held])
  assert.match(split, /^heater-fan \(held-out\)\s+1/m, split)
  assert.ok(split.includes('Ayarlamada görülenler: 2 koşu, tam 1 (50%). Held-out: 1 koşu, tam 1 (100%).'), split)
  ok('The benchmark summary reports held-out scenarios apart from the ones seen while tuning')

  ;(globalThis as { fetch: unknown }).fetch = realFetch
  router.updateConfig({ geminiApiKey: '', acceptanceGate: 'report' })
  console.log(`\nPhase 24: ${passed} passed, 0 failed\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
