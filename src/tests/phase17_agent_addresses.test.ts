/**
 * The addresses of a circuit from the agent: what the model declares must reach the tag table,
 * reserved memory stays free, and the running program follows the tag table.
 * The circuits have the shape of the replies Gemini really sent for a traffic light.
 */
import assert from 'node:assert'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { findIoBitsWithoutChannel } from '../renderer/src/services/compiler/ProgramConsistencyChecks'
import { PlcAgentTools } from '../renderer/src/services/ai/PlcAgentTools'

console.log('\n=== PHASE 17: AGENT ADDRESSES ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const router = AiModelRouter.getInstance() as unknown as {
  updateConfig(config: object): void
  interpretModelReply(raw: string): { circuit?: { networks: unknown[] }; problems: string[] }
  applyCircuitPayload(circuit: unknown, mode: 'auto-apply' | 'diff-view'): unknown
  processAgentPrompt?: unknown
}

const demo = DemoProjectSeeder.createDemoProject()
useHardwareStore.getState().setConfig?.(demo.hardware as never)

function resetProject(tags: Array<{ name: string; address: string }> = []): void {
  useBlockStore.setState({
    ladBlocks: structuredClone(demo.ladBlocks).filter((b) => b.blockType === 'OB' && b.blockNumber === 1),
    sclBlocks: [],
    dataBlocks: [],
    udts: []
  })
  useTagStore.getState().setTagTables([
    {
      id: 'table_default',
      name: 'default_tags',
      fileName: 'default_tags.tags.json',
      tags: tags.map((t, i) => ({ id: `t${i}`, dataType: 'BOOL', ...t }))
    }
  ] as never)
}

function tagAddress(name: string): string | undefined {
  return useTagStore
    .getState()
    .tagTables.flatMap((t) => t.tags)
    .find((t) => t.name.toLowerCase() === name.toLowerCase())?.address
}

function applyReply(reply: object): void {
  const parsed = router.interpretModelReply(JSON.stringify({ explanation: 'x', toolCalls: [], ...reply }))
  assert.deepStrictEqual(parsed.problems, [], 'The reply is understood')
  router.applyCircuitPayload(parsed.circuit, 'auto-apply')
}

const REAL_REPLY_3 = {
  operationMode: 'replace_ob1_networks',
  tagsToUpsert: [
    { name: 'stop', dataType: 'BOOL', address: '%I0.0', comment: 'Durdurma Butonu (NC)' },
    { name: 'start', dataType: 'BOOL', address: '%I0.1', comment: 'Baslatma Butonu (NO)' },
    { name: 'Sistem_Aktif', dataType: 'BOOL', address: '%M2.0', comment: 'Sistem' },
    { name: 'Kirmizi_Lamba', dataType: 'BOOL', address: '%Q0.0', comment: 'Kirmizi' },
    { name: 'Sari_Lamba', dataType: 'BOOL', address: '%Q0.1', comment: 'Sari' },
    { name: 'Yesil_Lamba', dataType: 'BOOL', address: '%Q0.2', comment: 'Yesil' }
  ],
  networks: [{ networkNumber: 1, title: 'x', nodes: [] }],
  dsl: `NW 1 "Muhur": SERIES( PARALLEL( NO(start), NO(Sistem_Aktif) ), NO(stop), COIL(Sistem_Aktif) )
NW 2 "Kirmizi": SERIES( NO(Sistem_Aktif), NC(T1.Q), NC(Sari_Lamba), NC(Yesil_Lamba), COIL(Kirmizi_Lamba), TON(T1, PT=T#10s) )
NW 3 "Sari": SERIES( NO(Sistem_Aktif), NO(T1.Q), NC(T2.Q), COIL(Sari_Lamba), TON(T2, PT=T#2s) )
NW 4 "Yesil": SERIES( NO(Sistem_Aktif), NO(T2.Q), NC(T3.Q), COIL(Yesil_Lamba), TON(T3, PT=T#10s) )`
}

// ---- The tag list of the reply ----
{
  resetProject([
    { name: 'stop', address: '%I0.1' },
    { name: 'start', address: '%I0.0' }
  ])
  applyReply(REAL_REPLY_3)
  assert.strictEqual(tagAddress('Sari_Lamba'), '%Q0.1', 'The yellow lamp is on the output the model chose')
  assert.strictEqual(tagAddress('Yesil_Lamba'), '%Q0.2', 'The green lamp is on the output the model chose')
  assert.strictEqual(tagAddress('stop'), '%I0.0', 'Two existing tags can swap addresses')
  assert.strictEqual(tagAddress('start'), '%I0.1', 'Two existing tags can swap addresses')
  assert.strictEqual(tagAddress('Sistem_Aktif'), '%M2.0', 'A free merker stays where it was declared')
  ok('The tag list is used when the reply also has DSL')
}

// ---- Existing tags and guessed tags ----
{
  resetProject([
    { name: 'stop', address: '%I0.5' },
    { name: 'start', address: '%I0.4' }
  ])
  applyReply({
    operationMode: 'replace_ob1_networks',
    dsl: 'NW 1 "A": SERIES( NO(start), NC(stop), NC(Sari_Lamba), COIL(Kirmizi_Lamba) )\nNW 2 "B": SERIES( NO(start), COIL(Sari_Lamba) )'
  })
  assert.strictEqual(tagAddress('start'), '%I0.4', 'An undeclared existing tag keeps its address')
  assert.strictEqual(tagAddress('stop'), '%I0.5', 'An undeclared existing tag keeps its address')
  assert.match(tagAddress('Sari_Lamba') || '', /^%Q/, 'A lamp first read by a contact is still an output')
  ok('An existing tag keeps its address and a Turkish lamp name means an output')
}

// ---- Replacing OB1 frees the addresses of the tags that go with it ----
{
  resetProject([
    { name: 'Old_Input', address: '%I0.0' },
    { name: 'Old_Output', address: '%Q0.0' },
    { name: 'Used_Elsewhere', address: '%I0.1' }
  ])
  useBlockStore.setState({
    sclBlocks: [
      {
        name: 'FC_Other',
        blockType: 'FC',
        blockNumber: 1,
        code: 'IF "Used_Elsewhere" THEN ; END_IF;',
        interface: { input: [], output: [], inOut: [], temp: [], static: [], constant: [] }
      }
    ] as never
  })
  applyReply({
    operationMode: 'replace_ob1_networks',
    dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Other %I0.1 BOOL "o"\nTAG Motor %Q0.0 BOOL "m"\nNW 1 "A": SERIES( NO(Start), NO(Other), COIL(Motor) )'
  })
  assert.strictEqual(tagAddress('Start'), '%I0.0', 'The address of a tag that goes away is free')
  assert.strictEqual(tagAddress('Motor'), '%Q0.0', 'The address of a tag that goes away is free')
  assert.strictEqual(tagAddress('Old_Input'), undefined, 'The old tag is gone, not left on the same address')
  assert.strictEqual(tagAddress('Used_Elsewhere'), '%I0.1', 'A tag another block uses stays')
  assert.strictEqual(tagAddress('Other'), '%I0.1', 'A declared address is never moved unasked, that would change the wiring')
  const overlap = PlcAgentTools.getInstance().runCompilerVerification().warnings.join('\n')
  assert.ok(overlap.includes('S7-MEM-001') && overlap.includes('Used_Elsewhere'), `The overlap is reported: ${overlap}`)

  // A guessed address does avoid a tag that stays
  applyReply({
    operationMode: 'replace_ob1_networks',
    dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Motor %Q0.0 BOOL "m"\nNW 1 "A": SERIES( NO(Start), NO(Sensor_New), COIL(Motor) )'
  })
  assert.match(tagAddress('Sensor_New') || '', /^%I/, 'A sensor is guessed as an input')
  assert.notStrictEqual(tagAddress('Sensor_New'), '%I0.1', 'A guessed address avoids a tag that stays')
  ok('Replacing OB1 frees old addresses, keeps declared ones and avoids kept ones when guessing')
}

// ---- Reserved memory ----
{
  const config = useHardwareStore.getState().config
  assert.ok(config.clockMemory.enabled, 'Clock memory is on for this test')
  const clock = config.clockMemory.byteAddress
  resetProject()
  applyReply({
    operationMode: 'replace_ob1_networks',
    tagsToUpsert: [{ name: 'Declared_Bit', dataType: 'BOOL', address: `%M${clock}.0` }],
    dsl: 'NW 1 "A": SERIES( NO(Declared_Bit), NO(Guessed_Bit), COIL(Other_Bit) )'
  })
  for (const name of ['Declared_Bit', 'Guessed_Bit']) {
    const address = tagAddress(name) || ''
    assert.ok(address && !address.startsWith(`%M${clock}.`), `${name} is not in clock memory (${address})`)
    assert.ok(!address.startsWith(`%M${config.systemMemory.byteAddress}.`), `${name} is not in system memory (${address})`)
  }
  ok('Nothing is placed in clock or system memory')
}

// ---- The running program follows the tag table ----
{
  resetProject([
    { name: 'Run', address: '%I0.0' },
    { name: 'Flag', address: '%M0.0' },
    { name: 'Lamp', address: '%Q0.0' }
  ])
  // Stored addresses as the overlap fixer leaves them: the table moved Flag, the network did not
  const tagTables = useTagStore.getState().tagTables
  tagTables[0].tags[1].address = '%M20.0'
  const ob1 = structuredClone(useBlockStore.getState().ladBlocks[0])
  ob1.networks = [
    {
      id: 'n1',
      networkNumber: 1,
      nodes: [
        { id: 'c', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Run', address: '%I0.0', symbolName: 'Run' },
        { id: 'k', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Flag', address: '%M0.0', symbolName: 'Flag' }
      ]
    },
    {
      id: 'n2',
      networkNumber: 2,
      nodes: [
        { id: 'd', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Flag', address: '%M0.0', symbolName: 'Flag' },
        { id: 'q', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Lamp', address: '%Q0.0', symbolName: 'Lamp' }
      ]
    }
  ] as never
  const engine = new PlcRuntimeEngine({ ...demo, tagTables, udts: [], dataBlocks: [], sclBlocks: [], ladBlocks: [ob1] } as never) as unknown as PlcRuntimeEngine & {
    runCyclicScan(): void
    intervalHandle: NodeJS.Timeout | null
    interruptHandles: NodeJS.Timeout[]
  }
  let now = 1000
  engine.setClock(() => now)
  engine.start()
  if (engine.intervalHandle) clearInterval(engine.intervalHandle)
  engine.interruptHandles.forEach((h) => clearInterval(h))

  engine.setVariable('%I0.0', true)
  const samples = new Set<unknown>()
  for (let i = 0; i < 120; i++) {
    now += 10
    engine.runCyclicScan()
    samples.add(engine.getVariable('%Q0.0'))
  }
  assert.deepStrictEqual([...samples], [true], 'The lamp stays on instead of following a clock bit')
  assert.strictEqual(engine.getVariable('%M20.0'), true, 'The coil writes the address in the tag table')
  engine.stop()
  ok('The program follows the tag table when a stored address is out of date')
}

// ---- Nothing else is removed ----
{
  resetProject([
    { name: 'Timer_Done', address: '%M30.0' },
    { name: 'Start', address: '%I0.0' }
  ])
  applyReply({
    operationMode: 'append_ob1_networks',
    tagsToUpsert: [{ name: 'Lamba', dataType: 'BOOL', address: '%Q0.3' }],
    dsl: 'NW 1 "A": SERIES( NO(Start), TON(T5, PT=T#1s), COIL(Lamba) )'
  })
  assert.strictEqual(tagAddress('Timer_Done'), '%M30.0', "A user's tag is not deleted because of its name")
  const networks = useBlockStore.getState().ladBlocks[0].networks
  const nodes = networks[networks.length - 1].nodes as Array<{ kind: string; operand?: string }>
  assert.ok(nodes.some((n) => n.kind === 'coil' && n.operand === 'Lamba'), 'A coil on a real output after a timer stays')
  ok('A user tag and a real output after a timer are kept')
}

// ---- Channels ----
{
  const config = useHardwareStore.getState().config
  const found = findIoBitsWithoutChannel(
    [
      {
        id: 't',
        name: 't',
        fileName: 't.tags.json',
        tags: [
          { id: '1', name: 'Real', address: '%Q1.1', dataType: 'BOOL' },
          { id: '2', name: 'Nothing', address: '%Q1.3', dataType: 'BOOL' },
          { id: '3', name: 'Flag', address: '%M90.0', dataType: 'BOOL' }
        ]
      }
    ] as never,
    config
  )
  assert.deepStrictEqual(found.map((f) => f.tagName), ['Nothing'], 'Only the bit with no channel on a 1214C is reported')
  ok('A bit with no channel on the CPU is reported')
}

// ---- Round trip through the agent ----
async function agentRetriesOnMissingChannel(): Promise<void> {
  resetProject()
  useProjectStore.getState().setProject?.(demo as never)
  resetProject()
  const realRouter = AiModelRouter.getInstance() as unknown as {
    updateConfig(config: object): void
    runAgentTurn(...args: unknown[]): Promise<{ replyText: string }>
  }
  realRouter.updateConfig({ provider: 'gemini', geminiApiKey: 'test-key' })
  const lampTest = { steps: [{ atMs: 0, set: { Start: true } }, { atMs: 100, expect: { Lamba: true } }] }
  const replies = [
    {
      explanation: 'first',
      verification: lampTest,
      operationMode: 'replace_ob1_networks',
      dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Lamba %Q1.3 BOOL "l"\nNW 1 "A": SERIES( NO(Start), COIL(Lamba) )'
    },
    {
      explanation: 'second',
      verification: lampTest,
      operationMode: 'replace_ob1_networks',
      dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Lamba %Q0.3 BOOL "l"\nNW 1 "A": SERIES( NO(Start), COIL(Lamba) )'
    }
  ]
  const sent: string[] = []
  const requestModel = async (contents: unknown[]): Promise<string> => {
    sent.push(JSON.stringify(contents))
    return JSON.stringify(replies[Math.min(sent.length - 1, replies.length - 1)])
  }
  await realRouter.runAgentTurn('lamba', 'fast-flash', 'auto-apply', true, [], requestModel)
  assert.strictEqual(sent.length, 2, 'The model is asked again')
  assert.ok(sent[1].includes('S7-IO-009'), 'The model is told which address has no channel')
  assert.strictEqual(tagAddress('Lamba'), '%Q0.3', 'The corrected address is kept')
  ok('The agent sends a new bit with no channel back to the model')

  // The user has an expansion module: the same answer again is accepted and the warning is shown
  resetProject()
  const module = {
    explanation: 'module',
    verification: { steps: [{ atMs: 0, set: { Start: true } }, { atMs: 100, expect: { Valf: true } }] },
    operationMode: 'replace_ob1_networks',
    dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Valf %Q8.0 BOOL "SM modul"\nNW 1 "A": SERIES( NO(Start), COIL(Valf) )'
  }
  let asked = 0
  const result = await realRouter.runAgentTurn('Q8.0 kullan', 'fast-flash', 'auto-apply', true, [], async () => {
    asked++
    return JSON.stringify(module)
  })
  assert.strictEqual(asked, 2, 'The model is asked once and then believed')
  assert.strictEqual(tagAddress('Valf'), '%Q8.0', 'The address the model insists on is kept')
  assert.ok(result.replyText.includes('S7-IO-009'), 'The user sees the warning')
  ok('An address the model repeats is accepted with a warning')

  // A declared address on top of a tag another block uses: asked once, never moved in silence
  resetProject([{ name: 'Used_Elsewhere', address: '%I0.1' }])
  useBlockStore.setState({
    sclBlocks: [
      {
        name: 'FC_Other',
        blockType: 'FC',
        blockNumber: 1,
        code: 'IF "Used_Elsewhere" THEN ; END_IF;',
        interface: { input: [], output: [], inOut: [], temp: [], static: [], constant: [] }
      }
    ] as never
  })
  const overlapping = {
    explanation: 'overlap',
    operationMode: 'replace_ob1_networks',
    verification: { steps: [{ atMs: 0, set: { Other: true } }, { atMs: 100, expect: { Lamba: true } }] },
    dsl: 'TAG Other %I0.1 BOOL "o"\nTAG Lamba %Q0.3 BOOL "l"\nNW 1 "A": SERIES( NO(Other), COIL(Lamba) )'
  }
  const overlapSent: string[] = []
  const overlapResult = await realRouter.runAgentTurn('lamba', 'fast-flash', 'auto-apply', true, [], async (contents: unknown[]) => {
    overlapSent.push(JSON.stringify(contents))
    return JSON.stringify(overlapping)
  })
  assert.strictEqual(overlapSent.length, 2, 'The model is asked once')
  assert.ok(overlapSent[1].includes('S7-MEM-001'), 'The model is told about the overlap')
  assert.strictEqual(tagAddress('Other'), '%I0.1', 'What the model repeats is kept')
  assert.ok(overlapResult.replyText.includes('S7-MEM-001'), 'The user sees the overlap')
  ok('A new overlap goes to the model once and is shown to the user')
}

agentRetriesOnMissingChannel()
  .then(() => {
    console.log(`\nPhase 17: ${passed} passed, 0 failed\n`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
