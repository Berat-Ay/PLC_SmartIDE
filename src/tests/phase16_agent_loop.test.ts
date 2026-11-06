/**
 * Phase 16: the Gemini agent loop (model, tools, compiler).
 * The model is replaced by scripted replies. These tests check what the app does with a reply,
 * not what a real model would answer.
 */
import assert from 'node:assert'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { emptyInterface } from '@shared/scl/sourceBlock'
import { LadBlockDefinition } from '@shared/types/blocks'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { PlcAgentTools, StagedFileChange } from '../renderer/src/services/ai/PlcAgentTools'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'

console.log('\n=== PHASE 16: AGENT LOOP ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const router = AiModelRouter.getInstance()
router.updateConfig({ provider: 'gemini', geminiApiKey: 'test-key' })
const realFetch = globalThis.fetch

/** Answers each request with the next scripted reply and records what was sent. */
function script(...replies: unknown[]): { requests: string[] } {
  const log = { requests: [] as string[] }
  ;(globalThis as any).fetch = async (_url: string, init: { body: string }) => {
    log.requests.push(init.body)
    const reply = replies[Math.min(log.requests.length - 1, replies.length - 1)]
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })
  }
  return log
}

function ob1Networks(): Array<{ title?: string }> {
  const ob1 = useBlockStore.getState().ladBlocks.find((b) => b.blockType === 'OB' && b.blockNumber === 1)
  return (ob1?.networks || []) as Array<{ title?: string }>
}

function tagNames(): string[] {
  return useTagStore.getState().tagTables.flatMap((t) => t.tags.map((x) => x.name))
}

const VALVE_FB = `FUNCTION_BLOCK "FB_Valve"
VAR_INPUT
  OpenRequest : Bool;
END_VAR
VAR_OUTPUT
  OpenCmd : Bool;
END_VAR
BEGIN
  #OpenCmd := #OpenRequest;
END_FUNCTION_BLOCK`

const BROKEN_FB = `FUNCTION_BLOCK "FB_Valve"
BEGIN
  #Undeclared := TRUE;
END_FUNCTION_BLOCK`

const contact = (operand: string, address: string, id: string): object => ({
  id,
  kind: 'contact',
  contactType: 'NO_CONTACT',
  operand,
  address,
  symbolName: operand
})
const coil = (operand: string, address: string, id: string): object => ({
  id,
  kind: 'coil',
  coilType: 'OUTPUT_COIL',
  operand,
  address,
  symbolName: operand
})
const LIVE_MOTOR_NETWORKS = [
  {
    id: 'net_1',
    networkNumber: 1,
    title: 'Motor Start/Stop',
    comment: '',
    isSclNetwork: false,
    nodes: [
      {
        id: 'parallel_3',
        kind: 'parallel',
        branches: [[contact('Start_Butonu', '%I0.0', 'contact_1')], [contact('Motor', '%Q0.0', 'contact_2')]]
      },
      contact('Stop_Butonu', '%I0.1', 'contact_4'),
      coil('Motor', '%Q0.0', 'coil_5')
    ]
  },
  {
    id: 'net_2',
    networkNumber: 2,
    title: 'Timer',
    comment: '',
    isSclNetwork: false,
    nodes: [
      contact('Motor', '%Q0.0', 'contact_6'),
      { id: 'timer_7', kind: 'timer', timerType: 'TON', instanceDb: 'T1', inOperand: '', ptOperand: 'T#5s', qOperand: 'T1.Q', etOperand: 'T1.ET' }
    ]
  },
  {
    id: 'net_3',
    networkNumber: 3,
    title: 'Lamp',
    comment: '',
    isSclNetwork: false,
    nodes: [contact('T1.Q', 'T1.Q', 'contact_8'), coil('Lamba', '%Q0.1', 'coil_9')]
  }
]

const MOTOR_DSL = 'TAG Start_A %I4.0 BOOL "Start"\nTAG Motor_A %Q4.0 BOOL "Motor"\nNW 1 "Motor A": SERIES( NO(Start_A), COIL(Motor_A) )'

const VALVE_TOOLS = [
  { tool: 'create_or_update_udt', params: { name: 'UDT_Valve', fields: [{ name: 'Open', dataType: 'BOOL' }] } },
  { tool: 'create_or_update_scl_block', params: { name: 'FB_Valve', sourceCode: VALVE_FB } }
]

async function run(): Promise<void> {
  const demo = DemoProjectSeeder.createDemoProject()
  useProjectStore.getState().setProject(demo)
  useTagStore.getState().setTagTables(demo.tagTables)
  useBlockStore.getState().setBlocks({
    udts: demo.udts,
    dataBlocks: demo.dataBlocks,
    ladBlocks: demo.ladBlocks,
    sclBlocks: demo.sclBlocks
  })
  useHardwareStore.getState().setConfig(demo.hardware)
  const originalNetworks = ob1Networks().length
  const originalTags = tagNames().length
  assert.ok(originalNetworks > 0, 'The demo has an OB1 to protect')

  // The exact request that wiped OB1 in the live test
  let log = script({ explanation: 'Vana hazır', toolCalls: VALVE_TOOLS })
  let res = await router.executePrompt('FB_Valve ve UDT_Valve oluştur', 'fast-flash', 'auto-apply')
  let blocks = useBlockStore.getState()
  assert.ok(!res.isError, res.replyText)
  assert.ok(blocks.udts.some((u) => u.name === 'UDT_Valve'), 'The UDT exists')
  const fb = blocks.sclBlocks.find((b) => b.name === 'FB_Valve')
  assert.strictEqual(fb?.blockType, 'FB', 'The type comes from the source header')
  assert.strictEqual(fb?.interface.input.length, 1, 'The interface comes from the source')
  assert.strictEqual(ob1Networks().length, originalNetworks, 'OB1 was not touched')
  assert.strictEqual(tagNames().length, originalTags, 'Tags were not touched')
  assert.strictEqual(log.requests.length, 1, 'A clean reply needs one request')
  ok('Tools create an FB and a UDT and leave OB1 alone')

  // The model sees the project
  assert.ok(log.requests[0].includes('CURRENT PROJECT'), 'Project context sent')
  assert.ok(log.requests[0].includes(useTagStore.getState().tagTables[0].tags[0].name), 'Tags are in the request')
  ok('The request includes the current project')

  // Undo Turn goes back to before the turn
  assert.strictEqual(PlcAgentTools.getInstance().revertLastTurn().success, true)
  blocks = useBlockStore.getState()
  assert.ok(!blocks.sclBlocks.some((b) => b.name === 'FB_Valve') && !blocks.udts.some((u) => u.name === 'UDT_Valve'))
  ok('Undo Turn removes what the turn added')

  // Empty networks never reach the project, and the model is told why
  log = script(
    {
      explanation: 'Oluşturuldu',
      operationMode: 'replace_ob1_networks',
      networks: [{ networkNumber: 1, title: 'UDT_Valve Definition', nodes: [] }]
    },
    { explanation: 'Şimdi araçlarla', toolCalls: VALVE_TOOLS }
  )
  res = await router.executePrompt('FB_Valve oluştur', 'fast-flash', 'auto-apply')
  assert.ok(!res.isError, res.replyText)
  assert.strictEqual(log.requests.length, 2, 'The model got a second try')
  assert.ok(log.requests[1].includes('A network has no instructions'), 'The reason went back to the model')
  assert.strictEqual(ob1Networks().length, originalNetworks, 'OB1 survived the empty reply')
  ok('An empty network is refused and sent back to the model')
  PlcAgentTools.getInstance().revertLastTurn()

  // A compile error undoes the reply; the corrected reply is applied once
  log = script(
    { explanation: 'İlk deneme', toolCalls: [{ tool: 'create_or_update_scl_block', params: { name: 'FB_Valve', sourceCode: BROKEN_FB } }] },
    { explanation: 'Düzeltildi', toolCalls: VALVE_TOOLS }
  )
  res = await router.executePrompt('FB_Valve oluştur', 'fast-flash', 'auto-apply')
  assert.ok(!res.isError, res.replyText)
  assert.ok(log.requests[1].includes('undone'), 'The errors went back to the model')
  assert.ok(log.requests[1].includes('Undeclared'), 'The compiler message is included')
  assert.strictEqual(useBlockStore.getState().sclBlocks.filter((b) => b.name === 'FB_Valve').length, 1)
  assert.ok(useBlockStore.getState().sclBlocks.find((b) => b.name === 'FB_Valve')?.code.includes('OpenRequest'))
  ok('A compile error undoes the reply and the corrected one is applied')
  PlcAgentTools.getInstance().revertLastTurn()

  // A model that never gets it right changes nothing and says so
  log = script({ explanation: 'Oluşturuldu', toolCalls: [{ tool: 'create_or_update_scl_block', params: { name: 'FB_Valve', sourceCode: BROKEN_FB } }] })
  const netsBefore = JSON.stringify(ob1Networks())
  res = await router.executePrompt('FB_Valve oluştur', 'fast-flash', 'auto-apply')
  assert.strictEqual(res.isError, true, 'Reported as an error')
  assert.ok(!res.replyText.includes('Oluşturuldu'), 'The false claim is not shown')
  assert.ok(res.replyText.includes('Undeclared'), 'The real error is shown')
  assert.ok(!useBlockStore.getState().sclBlocks.some((b) => b.name === 'FB_Valve'), 'Nothing was added')
  assert.strictEqual(JSON.stringify(ob1Networks()), netsBefore)
  assert.ok(log.requests.length <= 6, 'The loop has a limit')
  ok('After the last attempt the project is unchanged and the error is shown')

  // A circuit that adds to OB1 keeps what was there, and Undo Turn covers it
  script({ explanation: 'Motor', dsl: MOTOR_DSL })
  res = await router.executePrompt('Motor A ekle', 'fast-flash', 'auto-apply')
  assert.ok(!res.isError, res.replyText)
  assert.strictEqual(ob1Networks().length, originalNetworks + 1, 'Missing mode means add, not replace')
  assert.ok(tagNames().includes('Motor_A'))
  PlcAgentTools.getInstance().revertLastTurn()
  assert.strictEqual(ob1Networks().length, originalNetworks, 'Undo Turn covers ladder circuits')
  assert.ok(!tagNames().includes('Motor_A'), 'Undo Turn covers their tags')
  ok('A ladder circuit is added to OB1 and Undo Turn takes it back')

  // Text alone
  script({ explanation: 'FB_Valve oluşturuldu.' })
  res = await router.executePrompt('FB_Valve oluştur', 'fast-flash', 'auto-apply')
  assert.ok(res.replyText.includes('Projede değişiklik yapılmadı'), res.replyText)
  ok('A reply with no action says the project did not change')

  // The model only gets the agreed tools
  const hardwareCalls = ['revert_last_turn', 'update_hardware_parameters', 'update_plant_physics_scenario', 'run_compiler_and_self_heal']
  for (const tool of hardwareCalls) {
    log = script({ explanation: 'x', toolCalls: [{ tool, params: {} }] }, { explanation: 'Yapamam.' })
    res = await router.executePrompt('deneme', 'fast-flash', 'auto-apply')
    assert.ok(log.requests[1]?.includes('not available'), `${tool} is refused`)
  }
  log = script(
    { explanation: 'x', toolCalls: [{ tool: 'manage_plc_tags', params: { action: 'delete', tagId: 'x' } }] },
    { explanation: 'Yapamam.' }
  )
  await router.executePrompt('deneme', 'fast-flash', 'auto-apply')
  assert.ok(log.requests[1]?.includes('not available'), 'Deleting tags is refused')
  ok('Hardware, plant scripts, undo and deleting tags are refused')

  // Names become file names
  log = script({
    explanation: 'x',
    toolCalls: [{ tool: 'create_or_update_udt', params: { name: '../../evil', fields: [{ name: 'A', dataType: 'BOOL' }] } }]
  })
  res = await router.executePrompt('deneme', 'fast-flash', 'auto-apply')
  assert.strictEqual(res.isError, true)
  assert.ok(!useBlockStore.getState().udts.some((u) => u.name.includes('evil')), 'A path as a name is refused')
  ok('A name that is a path is refused')

  // Reads come back to the model in the next request
  log = script(
    { explanation: 'Okuyorum', toolCalls: [{ tool: 'read_block', params: { name: 'FB1_PumpControl' } }] },
    { explanation: 'Blok şöyle çalışıyor.' }
  )
  await router.executePrompt('FB1 ne yapıyor', 'fast-flash', 'auto-apply')
  assert.strictEqual(log.requests.length, 2)
  assert.ok(log.requests[1].includes('AutoStart'), 'The block source reached the model')
  ok('read_block sends the source to the next request')

  // A bad DSL goes back with the compiler's message
  log = script({ explanation: 'x', dsl: 'TAG broken' }, { explanation: 'Yapamadım.' })
  res = await router.executePrompt('deneme', 'fast-flash', 'auto-apply')
  assert.ok(log.requests[1].includes('did not compile'), 'The DSL error went back')
  assert.ok(res.replyText.includes('No changes were made'), res.replyText)
  ok('A DSL that does not compile is not reported as success')

  // A reply cut off in the middle
  log = script('{"explanation": "yarım', { explanation: 'Tamam.' })
  await router.executePrompt('deneme', 'fast-flash', 'auto-apply')
  assert.ok(log.requests[1].includes('not valid JSON'))
  ok('A reply cut off in the middle is sent back')

  // New blocks get free numbers, in their own range
  const firstFree = (kind: string): number => {
    const state = useBlockStore.getState()
    const used = [...state.ladBlocks, ...state.sclBlocks].filter((b) => b.blockType === kind).map((b) => b.blockNumber)
    let n = 1
    while (used.includes(n)) n++
    return n
  }
  const expectedFb = firstFree('FB')
  script({ explanation: 'x', toolCalls: VALVE_TOOLS })
  await router.executePrompt('FB_Valve oluştur', 'fast-flash', 'auto-apply')
  assert.strictEqual(useBlockStore.getState().sclBlocks.find((b) => b.name === 'FB_Valve')?.blockNumber, expectedFb)
  ok('A new FB takes the first free FB number')
  PlcAgentTools.getInstance().revertLastTurn()

  // A new OB cannot be chosen safely by the agent
  const newOb = 'ORGANIZATION_BLOCK "OB_New"\nBEGIN\n  ;\nEND_ORGANIZATION_BLOCK'
  script({ explanation: 'x', toolCalls: [{ tool: 'create_or_update_scl_block', params: { name: 'OB_New', sourceCode: newOb } }] })
  res = await router.executePrompt('OB ekle', 'fast-flash', 'auto-apply')
  assert.strictEqual(res.isError, true)
  assert.ok(res.replyText.includes('cannot add a new OB'), res.replyText)
  ok('The agent cannot add a new OB')

  // Diff-View changes nothing until it is approved
  const tagsBefore = tagNames().length
  log = script({ explanation: 'Motor', dsl: MOTOR_DSL })
  res = await router.executePrompt('Motor A ekle', 'fast-flash', 'diff-view')
  assert.strictEqual(tagNames().length, tagsBefore, 'No tag before approval')
  assert.strictEqual(ob1Networks().length, originalNetworks, 'No network before approval')
  assert.ok(res.stagedChangeset && res.stagedChangeset.length === 2, 'Tags and OB1 are both staged')
  ok('Diff-View stages tags and networks without changing the project')

  PlcAgentTools.getInstance().applyStagedChangeset(res.stagedChangeset as StagedFileChange[])
  assert.ok(tagNames().includes('Motor_A'), 'The tag arrives on approval')
  assert.strictEqual(ob1Networks().length, originalNetworks + 1, 'The network arrives on approval')
  ok('Approving Diff-View applies the tags and the networks')
  PlcAgentTools.getInstance().revertLastTurn()
  assert.strictEqual(ob1Networks().length, originalNetworks)

  // Diff-View tools
  res = await (async () => {
    script({ explanation: 'x', toolCalls: VALVE_TOOLS })
    return router.executePrompt('FB_Valve oluştur', 'fast-flash', 'diff-view')
  })()
  assert.ok(!useBlockStore.getState().sclBlocks.some((b) => b.name === 'FB_Valve'), 'No FB before approval')
  assert.strictEqual(res.stagedChangeset?.length, 2)
  PlcAgentTools.getInstance().applyStagedChangeset(res.stagedChangeset as StagedFileChange[])
  const approved = useBlockStore.getState().sclBlocks.find((b) => b.name === 'FB_Valve')
  assert.strictEqual(approved?.blockType, 'FB', 'The approved block is an FB')
  assert.strictEqual(approved?.interface.input.length, 1, 'The approved block has its interface')
  ok('Approved tools create the same FB as the direct path')
  PlcAgentTools.getInstance().revertLastTurn()

  // A model that stopped existing is dropped from the chain
  router.updateConfig({ selectedModelId: 'gemini-gone' })
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: string) => {
    asked.push(url)
    if (url.includes('gemini-gone')) return new Response('{}', { status: 404 })
    if (url.endsWith('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"explanation":"ok"}' }] } }] }), { status: 200 })
  }
  await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.notStrictEqual(router.getConfig().selectedModelId, 'gemini-gone', 'The working model is remembered')
  asked.length = 0
  await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(!asked.some((u) => u.includes('gemini-gone')), 'The missing model is not asked again')
  assert.ok(!asked.some((u) => u.includes('key=')), 'The API key never goes in a URL')
  ok('A model the API no longer serves is not tried on every request')

  // The circuit Gemini really returned for the motor prompt on 2026-11-06, run on the simulator
  const engine = new PlcRuntimeEngine({
    ...demo,
    tagTables: [
      {
        id: 't',
        name: 't',
        fileName: 't.tags.json',
        tags: [
          { id: '1', name: 'Start_Butonu', address: '%I0.0', dataType: 'BOOL' },
          { id: '2', name: 'Stop_Butonu', address: '%I0.1', dataType: 'BOOL' },
          { id: '3', name: 'Motor', address: '%Q0.0', dataType: 'BOOL' },
          { id: '4', name: 'Lamba', address: '%Q0.1', dataType: 'BOOL' }
        ]
      }
    ],
    udts: [],
    dataBlocks: [],
    sclBlocks: [],
    ladBlocks: [
      {
        blockType: 'OB',
        blockNumber: 1,
        name: 'Main',
        fileName: 'OB1.lad.json',
        optimizedAccess: true,
        interface: emptyInterface(),
        networks: LIVE_MOTOR_NETWORKS
      } as unknown as LadBlockDefinition
    ]
  } as ConstructorParameters<typeof PlcRuntimeEngine>[0]) as unknown as PlcRuntimeEngine & { runCyclicScan(): void }
  let now = 1000
  engine.setClock(() => now)
  engine.start()
  const timers = engine as unknown as { intervalHandle: NodeJS.Timeout | null; interruptHandles: NodeJS.Timeout[] }
  if (timers.intervalHandle) clearInterval(timers.intervalHandle)
  timers.interruptHandles.forEach((h) => clearInterval(h))
  const scan = (): void => engine.runCyclicScan()

  engine.setVariable('%I0.1', true) // NC stop button at rest
  scan()
  assert.strictEqual(engine.getVariable('%Q0.0'), false, 'Motor is off at rest')
  engine.setVariable('%I0.0', true)
  scan()
  assert.strictEqual(engine.getVariable('%Q0.0'), true, 'Start runs the motor')
  engine.setVariable('%I0.0', false)
  scan()
  assert.strictEqual(engine.getVariable('%Q0.0'), true, 'The motor seals in')
  now += 4900
  scan()
  scan()
  assert.strictEqual(engine.getVariable('%Q0.1'), false, 'The lamp is off before 5 s')
  now += 200
  scan()
  scan()
  assert.strictEqual(engine.getVariable('%Q0.1'), true, 'The lamp is on after 5 s')
  engine.setVariable('%I0.1', false) // stop pressed opens the NC button
  scan()
  scan()
  assert.strictEqual(engine.getVariable('%Q0.0'), false, 'Stop drops the motor')
  scan()
  assert.strictEqual(engine.getVariable('%Q0.1'), false, 'The lamp follows the timer off')
  engine.stop()
  ok('The circuit Gemini returned runs correctly on the simulator')
}

run()
  .then(() => {
    ;(globalThis as any).fetch = realFetch
    router.updateConfig({ geminiApiKey: '' })
    console.log(`\nPhase 16: ${passed} passed, 0 failed\n`)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
