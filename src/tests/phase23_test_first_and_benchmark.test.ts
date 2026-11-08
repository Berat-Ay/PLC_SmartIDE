/**
 * Test first: the model writes the test, the user approves it, and the circuit is judged by that fixed test.
 * The benchmark runs the agent on a scenario in a new project and scores what is left.
 */
import assert from 'node:assert'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { validateTestProposal } from '../renderer/src/services/ai/TestFirst'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { formatBenchSummary, newBenchProject, runBenchCase } from '../renderer/src/services/scenarios/Benchmark'
import { MOTOR_START_STOP } from '../renderer/src/services/scenarios/textbookScenarios'
import { BlackBoxLogger } from '../renderer/src/services/diagnostics/BlackBoxLogger'

console.log('\n=== PHASE 23: TEST FIRST AND BENCHMARK ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const router = AiModelRouter.getInstance() as unknown as AiModelRouter & {
  updateConfig(config: object): void
  applyCircuitPayload(circuit: unknown, mode: 'auto-apply'): unknown
  interpretModelReply(raw: string): { circuit?: unknown; problems: string[] }
}

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

const TAGS = [
  { name: 'Start', address: '%I0.0', dataType: 'BOOL' },
  { name: 'Stop', address: '%I0.1', dataType: 'BOOL' },
  { name: 'Motor', address: '%Q0.0', dataType: 'BOOL' }
]
const TEST = {
  steps: [
    { atMs: 0, set: { Stop: true } },
    { atMs: 100, set: { Start: true } },
    { atMs: 200, set: { Start: false } },
    { atMs: 400, expect: { Motor: true } },
    { atMs: 500, set: { Stop: false } },
    { atMs: 700, expect: { Motor: false } }
  ]
}
const proposal = (extra: object = {}): string =>
  JSON.stringify({ explanation: 'Start ile motor calisir, Stop ile durur.', tagsToUpsert: TAGS, verification: TEST, ...extra })
const MOTOR_DSL = 'NW 1 "Motor": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), COIL(Motor) )'
const circuit = (dsl: string, extra: object = {}): string =>
  JSON.stringify({ explanation: 'x', operationMode: 'replace_ob1_networks', tagsToUpsert: TAGS, dsl, ...extra })
const ob1Nodes = (): number =>
  (useBlockStore.getState().ladBlocks.find((b) => b.blockType === 'OB' && b.blockNumber === 1)?.networks || []).reduce(
    (n, net) => n + (net.nodes || []).length,
    0
  )

async function main(): Promise<void> {
  router.updateConfig({ provider: 'gemini', geminiApiKey: 'test-key', selectedModelId: 'gemini-2.5-flash', testFirst: true })

  // ---- The test step changes nothing and waits for approval ----
  newBenchProject()
  router.cancelPendingTest()
  answers(proposal())
  const asked = await router.executePrompt('Start I0.0, Stop I0.1 (NC), motor Q0.0', 'fast-flash', 'auto-apply')
  assert.ok(asked.pendingTest, asked.replyText)
  assert.ok(asked.replyText.includes('Önce test') || asked.replyText.includes('Test first'), asked.replyText)
  assert.ok(asked.replyText.includes('| 400 ms | – | Motor=1 |'), asked.replyText)
  assert.ok(sent[0].includes('TEST FIRST'), 'The model is asked for the test only')
  assert.strictEqual(ob1Nodes(), 0, 'Nothing is applied before approval')
  assert.ok(router.hasPendingTest())
  ok('The test step shows the test as a table, changes nothing and waits for approval')

  // ---- A correction goes back with the conversation ----
  answers(proposal({ explanation: 'Duzeltilmis' }))
  const corrected = await router.executePrompt('Stop basiliyken Start motoru calistirmamali', 'fast-flash', 'auto-apply')
  assert.ok(corrected.pendingTest && corrected.replyText.includes('Duzeltilmis'), corrected.replyText)
  assert.ok(sent[0].includes('did not approve this test') && sent[0].includes('Stop basiliyken'), 'The correction reaches the model')
  ok('A message while a test waits corrects that test')

  // ---- The approved test judges the circuit; the model's own test is ignored ----
  const weakOwnTest = { steps: [{ atMs: 0, set: { Stop: true } }, { atMs: 100, expect: { Motor: false } }] }
  // First a circuit with no seal-in: the approved test fails, though its own test would pass
  answers(circuit('NW 1 "Motor": SERIES( NO(Start), NO(Stop), COIL(Motor) )', { verification: weakOwnTest }), circuit(MOTOR_DSL))
  const built = await router.approvePendingTest('auto-apply')
  assert.ok(sent[0].includes('APPROVED TEST'), 'The circuit request carries the approved test')
  assert.ok(sent[1].includes("'Motor' should be TRUE but is FALSE"), 'The approved test caught the missing seal-in')
  assert.ok(!built.isError && /\((onaylı|approved)\)/.test(built.replyText), built.replyText)
  assert.ok(ob1Nodes() > 0, 'The circuit is applied')
  assert.ok(!router.hasPendingTest())
  ok('The approved test judges the circuit, and a test of its own cannot replace it')

  // ---- An approved tag may not move ----
  newBenchProject()
  answers(proposal())
  await router.executePrompt('Start I0.0, Stop I0.1, motor Q0.0', 'fast-flash', 'auto-apply')
  const movedTags = TAGS.map((t) => (t.name === 'Motor' ? { ...t, address: '%Q0.5' } : t))
  answers(circuit(MOTOR_DSL, { tagsToUpsert: movedTags }), circuit(MOTOR_DSL))
  const kept = await router.approvePendingTest('auto-apply')
  assert.ok(sent[1].includes('Motor must stay at %Q0.0'), sent[1].slice(-1500))
  assert.ok(!kept.isError, kept.replyText)
  ok('A circuit that moves an approved tag is sent back')

  // ---- A question gets an answer, not a test ----
  newBenchProject()
  router.cancelPendingTest()
  answers(JSON.stringify({ explanation: 'TON bir acma gecikmeli zamanlayicidir.' }))
  const question = await router.executePrompt('TON nedir?', 'fast-flash', 'auto-apply')
  assert.ok(!question.pendingTest && question.replyText.includes('TON bir acma'), question.replyText)
  ok('A question is answered without a test')

  // ---- A test the circuit cannot be judged by is sent back ----
  const existing: Array<{ name: string; address: string }> = []
  const same = validateTestProposal(
    { tagsToUpsert: TAGS, verification: { steps: [{ atMs: 0, set: { Stop: true, Start: true }, expect: { Motor: true } }] } },
    existing,
    [],
    new Set()
  )
  assert.ok(same.problems.some((p) => p.includes('at the same moment')), same.problems.join('\n'))
  const timer = validateTestProposal({ tagsToUpsert: TAGS, verification: { steps: [{ atMs: 100, expect: { 'T1.Q': true } }] } }, existing, [], new Set())
  assert.ok(timer.problems.some((p) => p.includes('does not exist before the circuit')), timer.problems.join('\n'))
  const output = validateTestProposal({ tagsToUpsert: TAGS, verification: { steps: [{ atMs: 0, set: { Motor: true } }, { atMs: 100, expect: { Motor: true } }] } }, existing, [], new Set())
  assert.ok(output.problems.some((p) => p.includes('can only set inputs')), output.problems.join('\n'))
  const missing = validateTestProposal({ tagsToUpsert: TAGS.slice(0, 2), verification: TEST }, existing, [], new Set())
  assert.ok(missing.problems.some((p) => p.includes("'Motor' is not in")), missing.problems.join('\n'))
  const asksOnce = new Set<string>()
  const noOutput = { tagsToUpsert: TAGS, verification: { steps: [{ atMs: 0, set: { Stop: true } }, { atMs: 100, expect: { Start: false } }] } }
  assert.ok(validateTestProposal(noOutput, existing, [], asksOnce).problems[0].includes('never expects Motor'))
  assert.deepStrictEqual(validateTestProposal(noOutput, existing, [], asksOnce).problems, [], 'Asked once, then accepted')
  ok('A test that expects at the moment of a change, reads a timer, sets an output or misses a tag is sent back')

  // ---- Without test first, nothing waits ----
  router.updateConfig({ testFirst: false })
  newBenchProject()
  answers(circuit(MOTOR_DSL, { verification: TEST }))
  const direct = await router.executePrompt('motor', 'fast-flash', 'auto-apply')
  assert.ok(!direct.pendingTest && !direct.isError, direct.replyText)
  ok('With test first off, the circuit is written at once as before')

  // ---- The benchmark scores what the user is left with ----
  const reference = `TAG Start %I0.0 BOOL "a"
TAG Stop %I0.1 BOOL "a"
TAG Thermal %I0.2 BOOL "a"
TAG Reset %I0.3 BOOL "a"
TAG Motor %Q0.0 BOOL "a"
TAG Fault %Q0.1 BOOL "a"
TAG RunLamp %Q0.2 BOOL "a"
NW 1 "a": SERIES( NC(Thermal), SET(Fault) )
NW 2 "b": SERIES( NO(Reset), NO(Thermal), RESET(Fault) )
NW 3 "c": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), NO(Thermal), NC(Fault), COIL(Motor) )
NW 4 "d": SERIES( NO(Motor), COIL(RunLamp) )`
  const good = await runBenchCase(MOTOR_START_STOP, 1, async () => {
    const reply = router.interpretModelReply(JSON.stringify({ explanation: 'x', operationMode: 'replace_ob1_networks', dsl: reference }))
    router.applyCircuitPayload(reply.circuit, 'auto-apply')
    return { replyText: 'ok', tier: 'fast-flash', providerUsed: 'gemini', toolCallsExecuted: [], toolResults: [] }
  })
  assert.strictEqual(good.outcome, 'applied')
  assert.strictEqual(good.specPassed, good.specTotal, good.failedChecks.join(', '))
  assert.ok(good.dsl.includes('COIL(Motor)'), good.dsl)

  // A model answered, but the agent kept nothing
  const empty = await runBenchCase(MOTOR_START_STOP, 2, async () => {
    BlackBoxLogger.getInstance().log('AI_RAW_RESPONSE', 'Gemini API Response received from gemini-test (5ms, 2 chars)')
    return { replyText: 'no', tier: 'fast-flash', providerUsed: 'gemini', toolCallsExecuted: [], toolResults: [], isError: true }
  })
  assert.strictEqual(empty.outcome, 'nothing')
  assert.deepStrictEqual(empty.models, ['gemini-test'], 'The model that answered is recorded')
  assert.strictEqual(empty.specPassed, 0, 'An empty project passes nothing')
  // No model answered: the request failed
  const failed = await runBenchCase(MOTOR_START_STOP, 3, async () => ({
    replyText: 'API key not valid',
    tier: 'fast-flash',
    providerUsed: 'gemini',
    toolCallsExecuted: [],
    toolResults: [],
    isError: true
  }))
  assert.strictEqual(failed.outcome, 'error')
  const thrown = await runBenchCase(MOTOR_START_STOP, 4, async () => {
    throw new Error('aborted')
  })
  assert.strictEqual(thrown.outcome, 'error')
  assert.strictEqual(useTagStore.getState().tagTables.flatMap((t) => t.tags).length, 0, 'Every run starts in a new project')
  const summary = formatBenchSummary([good, empty, failed])
  assert.match(summary, /motor-start-stop\s+3\s+1\s+0\s+1\s+1\s+1\/3/, summary)
  ok('The benchmark runs each case in a new project and counts applied, empty and failed runs')

  // ---- A new project has no clock or system memory, as a new CPU in TIA Portal ----
  newBenchProject()
  const { clockMemory, systemMemory } = useHardwareStore.getState().config
  assert.deepStrictEqual([clockMemory.enabled, systemMemory.enabled], [false, false])
  assert.deepStrictEqual([clockMemory.byteAddress, systemMemory.byteAddress], [0, 1], 'Turned on, they default to MB0 and MB1')
  ok('A new project starts with clock and system memory off, so M0.x and M1.x belong to the user')

  // ---- Model discovery refreshes the list but keeps the user's model ----
  const asked2: string[] = []
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })
  const answer = { candidates: [{ content: { parts: [{ text: JSON.stringify({ explanation: 'Merhaba' }) }] } }] }
  router.updateConfig({ testFirst: false, selectedModelId: 'gemini-2.5-flash', availableModels: [] })
  ;(globalThis as { fetch: unknown }).fetch = async (url: string) => {
    asked2.push(url)
    if (url.endsWith('/v1beta/models')) {
      return reply(200, { models: [{ name: 'models/gemini-9-flash', supportedGenerationMethods: ['generateContent'] }] })
    }
    if (url.includes('/gemini-2.5-flash:')) return reply(503, { error: 'busy' })
    if (url.includes('/gemini-3-flash-preview:')) return reply(404, { error: 'not found' })
    return reply(200, answer)
  }
  const healed = await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(!healed.isError, healed.replyText)
  assert.ok(asked2.some((u) => u.endsWith('/v1beta/models')), 'The 404 started a discovery')
  assert.strictEqual(router.getConfig().selectedModelId, 'gemini-2.5-flash', 'A busy model the user chose stays selected')
  ok('Model discovery after a 404 refreshes the list but does not replace the model the user chose')

  // ---- A pinned model is waited for, never replaced ----
  asked2.length = 0
  router.updateConfig({ pinModel: true, availableModels: [] })
  let first = true
  ;(globalThis as { fetch: unknown }).fetch = async (url: string) => {
    asked2.push(url)
    if (first) {
      first = false
      return reply(429, { error: { details: [{ retryDelay: '0.01s' }] } })
    }
    return reply(200, answer)
  }
  const pinned = await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(!pinned.isError, pinned.replyText)
  assert.strictEqual(asked2.length, 2)
  assert.ok(asked2.every((u) => u.includes('/gemini-2.5-flash:')), asked2.join('\n'))
  ok('A pinned model that is rate limited is asked again after the delay Gemini gives, not replaced')

  // ---- A used-up daily quota is not waited for ----
  asked2.length = 0
  ;(globalThis as { fetch: unknown }).fetch = async (url: string) => {
    asked2.push(url)
    return reply(429, { error: { details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }, { retryDelay: '54345s' }] } })
  }
  const startedAt = Date.now()
  const exhausted = await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(exhausted.isError && /PerDay/.test(exhausted.replyText), exhausted.replyText)
  assert.ok(Date.now() - startedAt < 5000, 'No wait for a quota that returns in hours')
  assert.strictEqual(asked2.length, 1)
  ok('A pinned model whose daily quota is used up fails at once and says so, instead of waiting for hours')

  ;(globalThis as { fetch: unknown }).fetch = realFetch
  router.updateConfig({ geminiApiKey: '', testFirst: false, pinModel: false })
  console.log(`\nPhase 23: ${passed} passed, 0 failed\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
