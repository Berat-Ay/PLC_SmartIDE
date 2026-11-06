/**
 * The agent's simulation test. The broken circuit has the shape of the traffic light replies Gemini
 * really sent: it compiles, and only running it shows that the yellow lamp never lights.
 */
import assert from 'node:assert'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { parseBehaviorTest, runBehaviorTest, BehaviorTest } from '../renderer/src/services/ai/CircuitBehaviorTest'
import { PlcAgentTools } from '../renderer/src/services/ai/PlcAgentTools'
import { LadderEvaluator } from '../renderer/src/runtime/LadderEvaluator'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useUIStore } from '../renderer/src/stores/useUIStore'

console.log('\n=== PHASE 18: BEHAVIOR TEST ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const demo = DemoProjectSeeder.createDemoProject()
useProjectStore.getState().setProject(demo)
useHardwareStore.getState().setConfig(demo.hardware)

function resetProject(): void {
  useBlockStore.setState({
    ladBlocks: structuredClone(demo.ladBlocks).filter((b) => b.blockType === 'OB' && b.blockNumber === 1),
    sclBlocks: [],
    dataBlocks: [],
    udts: []
  })
  useTagStore.getState().setTagTables([{ id: 'table_default', name: 'default_tags', fileName: 'default_tags.tags.json', tags: [] }] as never)
}

const router = AiModelRouter.getInstance() as unknown as {
  updateConfig(config: object): void
  runAgentTurn(...args: unknown[]): Promise<{ replyText: string; isError?: boolean; stagedChangeset?: unknown[] }>
}
router.updateConfig({ provider: 'gemini', geminiApiKey: 'test-key' })

const TAGS = `TAG Start %I0.0 BOOL "s"
TAG Stop %I0.1 BOOL "NC"
TAG Sistem_Aktif %M10.0 BOOL "a"
TAG Kirmizi_Lamba %Q0.0 BOOL "r"
TAG Sari_Lamba %Q0.1 BOOL "y"
TAG Yesil_Lamba %Q0.2 BOOL "g"
NW 1 "Muhur": SERIES( PARALLEL( NO(Start), NO(Sistem_Aktif) ), NO(Stop), COIL(Sistem_Aktif) )
`
// The circuit from the logs: each timer's own Q is in the path to its IN
const BROKEN = `${TAGS}NW 2 "K": SERIES( NO(Sistem_Aktif), NC(T1.Q), COIL(Kirmizi_Lamba), TON(T1, PT=T#5s) )
NW 3 "S": SERIES( NO(T1.Q), NC(T2.Q), COIL(Sari_Lamba), TON(T2, PT=T#2s) )
NW 4 "Y": SERIES( NO(T2.Q), NC(T3.Q), COIL(Yesil_Lamba), TON(T3, PT=T#5s) )`
const CORRECT = `${TAGS}NW 2 "T1": SERIES( NO(Sistem_Aktif), NC(T3.Q), TON(T1, PT=T#5s) )
NW 3 "T2": SERIES( NO(T1.Q), TON(T2, PT=T#2s) )
NW 4 "T3": SERIES( NO(T2.Q), TON(T3, PT=T#5s) )
NW 5 "K": SERIES( NO(Sistem_Aktif), NC(T1.Q), COIL(Kirmizi_Lamba) )
NW 6 "S": SERIES( NO(T1.Q), NC(T2.Q), COIL(Sari_Lamba) )
NW 7 "Y": SERIES( NO(T2.Q), NC(T3.Q), COIL(Yesil_Lamba) )`

const lamps = (k: boolean, s: boolean, y: boolean): Record<string, boolean> => ({ Kirmizi_Lamba: k, Sari_Lamba: s, Yesil_Lamba: y })
const TRAFFIC_TEST: BehaviorTest = {
  steps: [
    { atMs: 0, set: { Stop: true } },
    { atMs: 100, set: { Start: true } },
    { atMs: 300, set: { Start: false }, expect: lamps(true, false, false) },
    { atMs: 5500, expect: lamps(false, true, false) },
    { atMs: 7500, expect: lamps(false, false, true) },
    { atMs: 12700, expect: lamps(true, false, false) },
    { atMs: 18000, expect: lamps(false, true, false) },
    { atMs: 18100, set: { Stop: false } },
    { atMs: 18400, expect: lamps(false, false, false) }
  ]
}
const reply = (dsl: string, verification?: object): string =>
  JSON.stringify({ explanation: 'x', operationMode: 'replace_ob1_networks', dsl, ...(verification ? { verification } : {}) })

function scripted(...replies: string[]): { fn: (contents: unknown[]) => Promise<string>; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    fn: async (contents) => {
      sent.push(JSON.stringify(contents))
      return replies[Math.min(sent.length - 1, replies.length - 1)]
    }
  }
}

function ob1Titles(): string[] {
  const ob1 = useBlockStore.getState().ladBlocks[0]
  return (ob1.networks as Array<{ title?: string }>).map((n) => n.title || '')
}

function lastSent(sent: string[]): string {
  return sent[sent.length - 1]
}

async function main(): Promise<void> {
  // ---- The test shape ----
  assert.ok(parseBehaviorTest(undefined).problems.length > 0)
  assert.ok(parseBehaviorTest({ steps: [] }).problems.length > 0)
  assert.ok(parseBehaviorTest({ steps: [{ atMs: 0, set: { A: true } }] }).problems.length > 0, 'A test that expects nothing is refused')
  assert.ok(parseBehaviorTest({ steps: [{ atMs: 500, expect: { A: true } }, { atMs: 100 }] }).problems.length > 0, 'Steps go forward')
  assert.ok(parseBehaviorTest({ steps: [{ atMs: 400000, expect: { A: true } }] }).problems.length > 0, 'A test has a length limit')
  assert.ok(parseBehaviorTest({ steps: [{ atMs: 0, expect: { A: 'on' } }] }).problems.length > 0, 'Values are booleans or numbers')
  assert.ok(parseBehaviorTest(TRAFFIC_TEST).test)
  ok('A malformed test is refused')

  // ---- The broken circuit from the logs ----
  resetProject()
  const firstProject = ob1Titles()
  const broken = scripted(reply(BROKEN, TRAFFIC_TEST), reply(CORRECT, TRAFFIC_TEST))
  const fixed = await router.runAgentTurn('trafik lambasi', 'fast-flash', 'auto-apply', true, [], broken.fn)
  assert.strictEqual(broken.sent.length, 2, 'The broken circuit goes back to the model')
  const feedback = lastSent(broken.sent)
  assert.ok(feedback.includes('Sari_Lamba') && feedback.includes('should be TRUE'), 'The model hears which lamp failed')
  assert.ok(feedback.includes('really did'), 'The model gets the real timeline')
  assert.ok(ob1Titles().includes('T1'), 'The correct circuit is applied')
  assert.ok(fixed.replyText.includes('kontrolün hepsi geçti'), 'The user sees that the test passed')
  ok('The circuit from the logs fails the test and the correct one passes')

  // ---- A circuit that never passes leaves the project alone ----
  resetProject()
  const never = scripted(reply(BROKEN, TRAFFIC_TEST))
  const failed = await router.runAgentTurn('trafik lambasi', 'fast-flash', 'auto-apply', true, [], never.fn)
  assert.ok(failed.isError, 'It is reported as a failure')
  assert.deepStrictEqual(ob1Titles(), firstProject, 'OB1 is unchanged')
  assert.strictEqual(useTagStore.getState().tagTables[0].tags.length, 0, 'No tags stay behind')
  ok('A circuit that keeps failing changes nothing')

  // ---- A missing test ----
  resetProject()
  const untested = scripted(reply(CORRECT))
  const accepted = await router.runAgentTurn('trafik lambasi', 'fast-flash', 'auto-apply', true, [], untested.fn)
  assert.strictEqual(untested.sent.length, 2, 'The model is asked for a test once')
  assert.ok(lastSent(untested.sent).includes('verification'), 'It is told what is missing')
  assert.ok(accepted.replyText.includes('doğrulanmadı'), 'The user is told it was not verified')
  ok('A circuit without a test is accepted only with a visible note')

  // ---- A test can only drive inputs ----
  resetProject()
  const cheat = runBehaviorTest(
    { steps: [{ atMs: 0, set: { Kirmizi_Lamba: true }, expect: { Kirmizi_Lamba: true } }] },
    {
      ...demo,
      tagTables: [{ id: 't', name: 't', fileName: 't', tags: [{ id: '1', name: 'Kirmizi_Lamba', address: '%Q0.0', dataType: 'BOOL' }] }]
    } as never
  )
  assert.ok(cheat.failures.some((f) => f.includes('only set inputs')), 'A test cannot force an output')
  const unknown = runBehaviorTest({ steps: [{ atMs: 0, expect: { Nothing: true } }] }, { ...demo } as never)
  assert.ok(unknown.failures.some((f) => f.includes('does not exist')), 'A test cannot expect an unknown name')
  const noTimer = runBehaviorTest({ steps: [{ atMs: 100, expect: { 'T9.Q': false } }] }, { ...demo } as never)
  assert.ok(noTimer.failures.some((f) => f.includes('does not exist')), 'A check on a timer that is not there does not pass by itself')
  ok('A test can only set inputs and read things that exist')

  // ---- A short pulse without a failing check ----
  resetProject()
  const pulseTest = { steps: [{ atMs: 0, set: { Stop: true } }, { atMs: 100, set: { Start: true } }, { atMs: 300, set: { Start: false } }, { atMs: 13000, expect: { Kirmizi_Lamba: true } }] }
  const pulses = scripted(reply(BROKEN, pulseTest))
  const pulsed = await router.runAgentTurn('trafik lambasi', 'fast-flash', 'auto-apply', true, [], pulses.fn)
  assert.ok(pulses.sent.length >= 2, 'A weak test does not hide a one-scan output')
  assert.ok(lastSent(pulses.sent).includes('one-scan pulse'), 'The model is told about the pulse')
  assert.ok(pulsed.replyText.includes('scan(s)'), 'If the model insists, the user sees the warning')
  ok('A one-scan output is raised even if the test does not look at it')

  // ---- Diff-View ----
  resetProject()
  const titlesBefore = ob1Titles()
  const staged = scripted(reply(BROKEN, TRAFFIC_TEST), reply(CORRECT, TRAFFIC_TEST))
  const stagedResult = await router.runAgentTurn('trafik lambasi', 'fast-flash', 'diff-view', true, [], staged.fn)
  assert.strictEqual(staged.sent.length, 2, 'Diff-View tests the circuit too')
  assert.ok(stagedResult.stagedChangeset && stagedResult.stagedChangeset.length > 0, 'The change is staged')
  assert.deepStrictEqual(ob1Titles(), titlesBefore, 'The project is not changed before approval')
  assert.strictEqual(useTagStore.getState().tagTables[0].tags.length, 0, 'No tags are added before approval')
  assert.ok(stagedResult.replyText.includes('kontrolün hepsi geçti'), 'The user sees the result')
  ok('Diff-View tests a circuit and leaves the project alone')

  // The trial run does not move the user to another tab
  resetProject()
  useUIStore.setState({ activeTabId: 'tab_of_the_user' })
  await router.runAgentTurn('trafik lambasi', 'fast-flash', 'diff-view', true, [], scripted(reply(CORRECT, TRAFFIC_TEST)).fn)
  assert.strictEqual(useUIStore.getState().activeTabId, 'tab_of_the_user', 'The active tab stays')
  ok('A Diff-View trial run leaves the active tab alone')

  // A reply that also uses a writing tool cannot run before approval, and the user is told
  resetProject()
  const withTool = JSON.stringify({
    ...JSON.parse(reply(CORRECT, TRAFFIC_TEST)),
    toolCalls: [{ tool: 'manage_plc_tags', params: { action: 'upsert', tags: [{ name: 'Extra', dataType: 'BOOL', address: '%M20.0' }] } }]
  })
  const skipped = await router.runAgentTurn('trafik lambasi', 'fast-flash', 'diff-view', true, [], scripted(withTool).fn)
  assert.ok(skipped.replyText.includes('doğrulanmadı'), 'The user is told the test did not run')
  assert.deepStrictEqual(ob1Titles(), titlesBefore, 'The project is not changed before approval')
  ok('Diff-View says so when it cannot run the test')

  // ---- The live CPU keeps its edge memory ----
  const evaluator = LadderEvaluator as unknown as { edgeStates: Map<string, { prevVal: boolean }> }
  evaluator.edgeStates.set('live_edge', { prevVal: true })
  resetProject()
  runBehaviorTest(TRAFFIC_TEST, {
    ...demo,
    tagTables: [
      {
        id: 't',
        name: 't',
        fileName: 't',
        tags: [
          { id: '1', name: 'Start', address: '%I0.0', dataType: 'BOOL' },
          { id: '2', name: 'Stop', address: '%I0.1', dataType: 'BOOL' },
          { id: '3', name: 'Kirmizi_Lamba', address: '%Q0.0', dataType: 'BOOL' },
          { id: '4', name: 'Sari_Lamba', address: '%Q0.1', dataType: 'BOOL' },
          { id: '5', name: 'Yesil_Lamba', address: '%Q0.2', dataType: 'BOOL' }
        ]
      }
    ]
  } as never)
  assert.strictEqual(evaluator.edgeStates.get('live_edge')?.prevVal, true, 'A test run does not touch the live edge memory')
  ok('A test run does not disturb the running CPU')

  // ---- The undo of the turn ----
  resetProject()
  const titles = ob1Titles()
  await router.runAgentTurn('trafik lambasi', 'fast-flash', 'auto-apply', true, [], scripted(reply(CORRECT, TRAFFIC_TEST)).fn)
  assert.ok(ob1Titles().includes('T1'))
  assert.strictEqual(PlcAgentTools.getInstance().revertLastTurn().success, true)
  assert.deepStrictEqual(ob1Titles(), titles)
  ok('Undo still takes the whole turn back')

  console.log(`\nPhase 18: ${passed} passed, 0 failed\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
