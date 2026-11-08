/**
 * What went wrong with a robot cell request: a CALL became a contact, quoted names became new tags, a DB
 * variable became an output, the test got weaker between attempts, and a slow or quota-less model stopped
 * the whole request. The circuits have the shape of the replies Gemini really sent.
 */
import assert from 'node:assert'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { AiModelRouter, sortGeminiModels, escapeControlCharsInJsonStrings } from '../renderer/src/services/ai/AiModelRouter'
import { PlcAgentTools } from '../renderer/src/services/ai/PlcAgentTools'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'

console.log('\n=== PHASE 20: AGENT HONESTY ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const demo = DemoProjectSeeder.createDemoProject()
useProjectStore.getState().setProject(demo)
useHardwareStore.getState().setConfig(demo.hardware)

type Router = {
  updateConfig(config: object): void
  getConfig(): { selectedModelId: string }
  interpretModelReply(raw: string): { circuit?: { networks: Array<{ nodes: Array<Record<string, unknown>> }> }; problems: string[] }
  applyCircuitPayload(circuit: unknown, mode: 'auto-apply'): unknown
  runAgentTurn(...args: unknown[]): Promise<{ replyText: string; isError?: boolean }>
  executePrompt(prompt: string, tier: string, mode: string): Promise<{ replyText: string; isError?: boolean }>
  unavailableModels: Map<string, string>
  modelTimeoutMs: number
}
const router = AiModelRouter.getInstance() as unknown as Router
router.updateConfig({ provider: 'gemini', geminiApiKey: 'test-key' })
const tools = PlcAgentTools.getInstance()

const CELL_TAGS = [
  { name: 'I_R1_Zone', address: '%I0.0' },
  { name: 'I_R2_Zone', address: '%I0.1' },
  { name: 'I_R1_Home', address: '%I0.2' },
  { name: 'I_R2_Home', address: '%I0.3' },
  { name: 'Q_R1_Permit', address: '%Q0.0' },
  { name: 'Q_R2_Permit', address: '%Q0.1' },
  { name: 'Q_Table_Rot', address: '%Q0.2' }
]

function resetProject(withDb = false): void {
  useBlockStore.setState({
    ladBlocks: structuredClone(demo.ladBlocks)
      .filter((b) => b.blockType === 'OB' && b.blockNumber === 1)
      .map((b) => ({ ...b, networks: [] })),
    sclBlocks: [],
    dataBlocks: withDb
      ? ([
          {
            id: 'db_cell',
            name: 'DB_CellData',
            fileName: 'DB_CellData.db.json',
            blockNumber: 10,
            isInstanceDb: false,
            optimizedAccess: true,
            variables: [{ name: 'R1_InZone', dataType: 'BOOL', initialValue: 'FALSE' }]
          }
        ] as never)
      : [],
    udts: []
  })
  useTagStore.getState().setTagTables([
    {
      id: 'table_default',
      name: 'default_tags',
      fileName: 'default_tags.tags.json',
      tags: CELL_TAGS.map((t, i) => ({ id: `t${i}`, dataType: 'BOOL', ...t }))
    }
  ] as never)
}

const allTags = (): Array<{ name: string; address: string }> => useTagStore.getState().tagTables.flatMap((t) => t.tags)
const reply = (dsl: string, extra: object = {}): string =>
  JSON.stringify({ explanation: 'x', operationMode: 'append_ob1_networks', dsl, ...extra })
const problemsOf = (dsl: string): string => router.interpretModelReply(reply(dsl)).problems.join('\n')

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

async function main(): Promise<void> {
  // ---- CALL is not a contact ----
  resetProject()
  const call = problemsOf('NW 2 "Cell": SERIES( CALL("FB_CellControl", "IDB_Cell") )')
  assert.match(call, /cannot call an FB or FC/, 'CALL is refused with the reason')
  assert.match(problemsOf('NW 1 "x": SERIES( NO(I_R1_Zone), FOO(Q_R1_Permit) )'), /unknown instruction FOO/, 'An unknown instruction is refused')
  assert.match(problemsOf('NW 1 "x": SERIES( I_R1_Zone, COIL(Q_R1_Permit) )'), /not an instruction\. Write NO\(I_R1_Zone\)/, 'A bare name is refused')
  assert.match(problemsOf('NW 1 "x": SERIES( NO(), COIL(Q_R1_Permit) )'), /NO\(\) needs an operand/, 'An empty operand is refused')
  ok('CALL, unknown instructions, bare names and empty operands are errors, not contacts')

  // ---- Quoted names are the existing tags ----
  resetProject()
  const quoted = router.interpretModelReply(
    reply(`NW 3 "R1": SERIES( NO("I_R1_Zone"), NC("I_R2_Zone"), NO("I_R2_Home"), COIL("Q_R1_Permit") )
NW 4 "Table": SERIES( NO("I_R1_Home"), NO("I_R2_Home"), COIL("Q_Table_Rot") )`)
  )
  assert.deepStrictEqual(quoted.problems, [])
  const contacts = quoted.circuit!.networks[0].nodes
  assert.deepStrictEqual(
    contacts.map((n) => `${n.operand}@${n.address}`),
    ['I_R1_Zone@%I0.0', 'I_R2_Zone@%I0.1', 'I_R2_Home@%I0.3', 'Q_R1_Permit@%Q0.0']
  )
  router.applyCircuitPayload(quoted.circuit, 'auto-apply')
  assert.strictEqual(allTags().length, CELL_TAGS.length, 'No new tag')
  assert.ok(!allTags().some((t) => t.name.includes('"')), 'No tag has quotes in its name')
  assert.match(problemsOf('NW 1 "x": SERIES( NO("I R1"), COIL(Q_R1_Permit) )'), /'"I R1"' is not a tag name/, 'A name a tag cannot have is refused')
  useTagStore.getState().setTagTables([
    { id: 'table_default', name: 'default_tags', fileName: 'default_tags.tags.json', tags: [{ id: 'k', name: 'Kırmızı_Lamba', dataType: 'BOOL', address: '%Q0.5' }] }
  ] as never)
  const turkish = router.interpretModelReply(reply('NW 1 "x": SERIES( NO(I_R1_Zone), COIL("Kırmızı_Lamba") )'))
  assert.deepStrictEqual(turkish.problems, [], 'An existing tag with Turkish letters is found')
  assert.strictEqual(turkish.circuit!.networks[0].nodes[1].address, '%Q0.5')
  ok('A quoted name is the existing tag, and no tag gets quotes in its name')

  // ---- A DB variable is read from the DB ----
  resetProject(true)
  const member = router.interpretModelReply(reply('NW 1 "Zone": SERIES( NO(I_R1_Zone), COIL("DB_CellData".R1_InZone) )'))
  assert.deepStrictEqual(member.problems, [])
  const coil = member.circuit!.networks[0].nodes[1]
  assert.strictEqual(coil.operand, '"DB_CellData".R1_InZone')
  router.applyCircuitPayload(member.circuit, 'auto-apply')
  assert.strictEqual(allTags().length, CELL_TAGS.length, 'The DB variable is not a new output tag')
  assert.ok(!allTags().some((t) => t.address === '%Q0.3'))
  assert.deepStrictEqual(tools.runCompilerVerification().errors, [], 'It compiles when the DB exists')

  const turn = await router.runAgentTurn(
    'zone',
    'fast-flash',
    'auto-apply',
    true,
    [],
    scripted(
      reply('NW 1 "Zone": SERIES( NO(I_R1_Zone), COIL("DB_CellData".R1_InZone) )', {
        verification: {
          steps: [
            { atMs: 0, expect: { '"DB_CellData".R1_InZone': false } },
            { atMs: 100, set: { I_R1_Zone: true } },
            { atMs: 300, expect: { '"DB_CellData".R1_InZone': true } }
          ]
        }
      })
    ).fn
  )
  assert.ok(!turn.isError && turn.replyText.includes('2 kontrolün hepsi geçti'), `The DB variable follows the zone: ${turn.replyText}`)

  resetProject(false)
  const missingDb = router.interpretModelReply(reply('NW 1 "Zone": SERIES( NO(I_R1_Zone), COIL("DB_Nowhere".R1_InZone) )'))
  router.applyCircuitPayload(missingDb.circuit, 'auto-apply')
  assert.ok(
    tools.runCompilerVerification().errors.some((e) => e.includes('DB_Nowhere')),
    'A DB that does not exist is a compiler error'
  )
  ok('A DB variable is written to the DB, and a DB that does not exist is an error')

  // ---- The test cannot get weaker without a word ----
  const STRONG = {
    steps: [
      { atMs: 100, set: { I_R1_Zone: true } },
      { atMs: 300, expect: { Q_R1_Permit: true, Q_Table_Rot: true } },
      { atMs: 400, set: { I_R1_Zone: false } },
      { atMs: 600, expect: { Q_R1_Permit: false } }
    ]
  }
  const WEAK = { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
  const PERMIT = 'NW 1 "Permit": SERIES( NO(I_R1_Zone), COIL(Q_R1_Permit) )'
  resetProject()
  const weaker = scripted(reply(PERMIT, { verification: STRONG }), reply(PERMIT, { verification: WEAK }), reply(PERMIT, { verification: WEAK }))
  const weakened = await router.runAgentTurn('permit', 'fast-flash', 'auto-apply', true, [], weaker.fn)
  assert.strictEqual(weaker.sent.length, 3, 'The weaker test is questioned once')
  assert.match(weaker.sent[2], /checks 1 values, your earlier test checked 3/)
  assert.ok(!weakened.isError && weakened.replyText.includes('testi denemeler arasında zayıflattı (3 kontrolden 1 kontrole)'), weakened.replyText)
  ok('A test that loses checks between attempts is questioned, then shown to the user')

  // ---- A created FB is said to run nowhere ----
  resetProject()
  const fb = scripted(
    reply(PERMIT, {
      toolCalls: [
        {
          tool: 'create_or_update_scl_block',
          params: {
            name: 'FB_CellControl',
            sourceCode:
              'FUNCTION_BLOCK "FB_CellControl"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nVAR_INPUT\n  Cmd : Bool;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK'
          }
        }
      ],
      verification: WEAK
    })
  )
  const withFb = await router.runAgentTurn('cell', 'fast-flash', 'auto-apply', true, [], fb.fn)
  assert.ok(!withFb.isError, withFb.replyText)
  assert.ok(withFb.replyText.includes('FB/FC hiçbir yerden çağrılmıyor'), withFb.replyText)
  ok('A reply that creates an FB says that the FB is never called')

  // ---- MOVE has two values. Read as ADD it wrote nowhere and a state machine never left its first state ----
  resetProject()
  assert.match(problemsOf('NW 1 "x": SERIES( NO(I_R1_Zone), MOVE(20) )'), /MOVE takes 2 values, in, out/, 'MOVE needs a target')
  assert.match(problemsOf('NW 1 "x": SERIES( NO(I_R1_Zone), MOVE(20, 1, Q_R1_Permit) )'), /MOVE takes 2 values/, 'MOVE with three values is refused')
  assert.match(problemsOf('NW 1 "x": SERIES( NO(I_R1_Zone), ADD(1, 2) )'), /ADD takes 3 values, in1, in2, out/, 'ADD needs a target')
  assert.match(problemsOf('NW 1 "x": SERIES( CMP_EQ(1), COIL(Q_R1_Permit) )'), /CMP_EQ compares two values/)
  const moved = router.interpretModelReply(reply('NW 1 "x": SERIES( NO(I_R1_Zone), MOVE(20, DB_Cell.State) )'))
  const move = moved.circuit!.networks[0].nodes[1]
  assert.deepStrictEqual([move.in1, move.out], ['20', '"DB_Cell".State'], 'MOVE writes its second value')
  ok('MOVE takes (in, out), and a box with the wrong number of values is an error')

  // The reply Gemini sent in round 5 of the robot cell: its logic was right, and it failed 6 times on MOVE
  resetProject()
  const D = '"DB_Cell_Control"'
  const cellTags = [
    ['R1_Req', '%I0.0'], ['R2_Req', '%I0.1'], ['R1_In_Zone', '%I1.0'], ['R2_In_Zone', '%I1.1'], ['Part_Seated_Sensor', '%I1.2'],
    ['Light_Curtain_OK', '%I0.2'], ['R1_Home', '%I0.3'], ['R2_Home', '%I0.4'], ['R3_Done', '%I0.5'], ['R4_Done', '%I0.6'],
    ['Table_A_Pos', '%I0.7'], ['Cell_Alarm', '%Q0.0'], ['Table_Rotate_Cmd', '%Q0.1']
  ].map(([name, address]) => ({ name, address, dataType: 'BOOL' }))
  const round5 = JSON.stringify({
    explanation: 'x',
    toolCalls: [
      {
        tool: 'create_or_update_db',
        params: {
          name: 'DB_Cell_Control',
          variables: [
            { name: 'State', dataType: 'INT', initialValue: '10' },
            { name: 'R1_Permit', dataType: 'BOOL' },
            { name: 'R2_Permit', dataType: 'BOOL' },
            { name: 'Clamps_Closed', dataType: 'BOOL' },
            { name: 'Table_Sync_Active', dataType: 'BOOL' },
            { name: 'Emergency_Stop', dataType: 'BOOL', initialValue: 'false' }
          ]
        }
      }
    ],
    operationMode: 'replace_ob1_networks',
    tagsToUpsert: cellTags,
    dsl: [
      `NW 1 "Interference R1": SERIES(NO(R1_Req), NC(R2_In_Zone), COIL(${D}.R1_Permit))`,
      `NW 2 "Interference R2": SERIES(NO(R2_Req), NC(R1_In_Zone), COIL(${D}.R2_Permit))`,
      `NW 3 "Collision": SERIES(NO(R1_In_Zone), NO(R2_In_Zone), SET(${D}.Emergency_Stop))`,
      `NW 4 "10 to 20": SERIES(CMP_EQ(${D}.State, 10), NO(Table_A_Pos), MOVE(20, ${D}.State))`,
      `NW 5 "20 to 30": SERIES(CMP_EQ(${D}.State, 20), NO(R1_Home), NO(R2_Home), MOVE(30, ${D}.State))`,
      `NW 6 "30 to 40": SERIES(CMP_EQ(${D}.State, 30), NO(Part_Seated_Sensor), NO(Light_Curtain_OK), MOVE(40, ${D}.State))`,
      `NW 7 "40 to 50": SERIES(CMP_EQ(${D}.State, 40), NO(R3_Done), NO(R4_Done), MOVE(50, ${D}.State))`,
      `NW 8 "50 to 10": SERIES(CMP_EQ(${D}.State, 50), NC(Table_A_Pos), MOVE(10, ${D}.State))`,
      `NW 9 "Clamps": SERIES(CMP_GE(${D}.State, 30), CMP_LT(${D}.State, 50), COIL(${D}.Clamps_Closed))`,
      `NW 10 "Sync": SERIES(CMP_EQ(${D}.State, 40), COIL(${D}.Table_Sync_Active))`,
      `NW 11 "Rotate": SERIES(CMP_EQ(${D}.State, 50), COIL(Table_Rotate_Cmd))`
    ].join('\n'),
    verification: {
      steps: [
        { atMs: 0, set: { Table_A_Pos: true, Light_Curtain_OK: true } },
        { atMs: 100, set: { R1_Home: true, R2_Home: true }, expect: { 'DB_Cell_Control.Clamps_Closed': true } },
        { atMs: 200, set: { Part_Seated_Sensor: true }, expect: { 'DB_Cell_Control.State': 40 } },
        { atMs: 300, set: { R3_Done: true, R4_Done: true }, expect: { Table_Rotate_Cmd: true } },
        { atMs: 400, set: { Table_A_Pos: false }, expect: { 'DB_Cell_Control.State': 10 } }
      ]
    }
  })
  const cell = scripted(round5)
  const cellTurn = await router.runAgentTurn('cell', 'fast-flash', 'auto-apply', true, [], cell.fn)
  assert.strictEqual(cell.sent.length, 1, `The round 5 reply is accepted at once: ${cellTurn.replyText}`)
  assert.ok(cellTurn.replyText.includes('4 kontrolün hepsi geçti'), cellTurn.replyText)
  ok('The robot cell state machine from the logs runs through its states')

  // ---- A circuit sent as "networks" may use the tags OB1 already has ----
  resetProject()
  router.applyCircuitPayload(
    router.interpretModelReply(
      reply('NW 1 "Old": SERIES( NO(I_R1_Zone), NO(I_R2_Zone), COIL(Q_R1_Permit) )\nNW 2 "Old 2": SERIES( NO(I_R1_Home), COIL(Q_Table_Rot) )')
    ).circuit,
    'auto-apply'
  )
  const jsonReply = JSON.stringify({
    explanation: 'x',
    operationMode: 'replace_ob1_networks',
    tagsToUpsert: [{ name: 'R1_Req_Zone', dataType: 'BOOL', address: '%I0.4' }],
    networks: [
      {
        networkNumber: 1,
        title: 'Q_Table_Rot is mentioned only here',
        nodes: [
          { type: 'NO', operand: 'I_R1_Zone' },
          { type: 'NO', operand: 'R1_Req_Zone' },
          { type: 'COIL', operand: 'Q_R1_Permit' }
        ]
      }
    ],
    verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true, R1_Req_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
  })
  const jsonTurn = scripted(jsonReply)
  const jsonResult = await router.runAgentTurn('cell', 'fast-flash', 'auto-apply', true, [], jsonTurn.fn)
  assert.strictEqual(jsonTurn.sent.length, 1, `An existing tag used by name is not "not a tag": ${jsonResult.replyText}`)
  const after = new Map(allTags().map((t) => [t.name, t.address]))
  assert.strictEqual(after.get('I_R1_Zone'), '%I0.0', 'A tag the new networks use keeps its address')
  assert.strictEqual(after.get('Q_R1_Permit'), '%Q0.0')
  assert.ok(!after.has('Q_Table_Rot'), 'A tag named only in a title is released')
  assert.ok(!after.has('I_R2_Zone'), 'A tag the new program does not use is released')
  ok('Replacing OB1 with "networks" keeps the tags the new networks use')

  // ---- Third log: a lite model answered, its circuit read a DB bit nothing writes ----
  assert.deepStrictEqual(
    sortGeminiModels(
      ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'].map((id) => ({
        id,
        displayName: id
      }))
    ).map((m) => m.id),
    ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest'],
    'The newest flash comes first, a lite model last of its version'
  )
  ok('Models are ranked newest first, and a lite model is not chosen over a newer flash')

  resetProject()
  const nested = router.interpretModelReply(
    JSON.stringify({
      explanation: 'x',
      networks: [{ networkNumber: 1, title: 'S', nodes: [], dsl: 'NW 1 "S": SERIES(NO(I_R1_Zone), COIL(Q_R1_Permit))' }]
    })
  )
  assert.deepStrictEqual(nested.problems, [], 'DSL inside a network is read as the DSL')
  assert.strictEqual(nested.circuit!.networks[0].nodes.length, 2)
  ok('DSL put inside a network is still compiled')

  resetProject()
  const emptyFirst = JSON.stringify({
    explanation: 'x',
    networks: [{ networkNumber: 1, title: 'x', nodes: [] }],
    verification: {
      steps: [
        { atMs: 100, set: { I_R1_Zone: true }, expect: { Q_R2_Permit: false } },
        { atMs: 300, expect: { Q_R1_Permit: true } }
      ]
    }
  })
  const oneCheck = reply('NW 1 "x": SERIES( NO(I_R1_Zone), COIL(Q_R1_Permit) )', {
    verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
  })
  const afterReject = scripted(emptyFirst, oneCheck)
  const afterRejectTurn = await router.runAgentTurn('x', 'fast-flash', 'auto-apply', true, [], afterReject.fn)
  assert.strictEqual(afterReject.sent.length, 3, 'The test of a rejected reply counts too')
  assert.ok(afterRejectTurn.replyText.includes('2 kontrolden 1 kontrole'), afterRejectTurn.replyText)
  ok('A test that shrinks after a rejected reply is questioned too')

  resetProject()
  const deadRead = JSON.stringify({
    explanation: 'x',
    toolCalls: [
      {
        tool: 'create_or_update_db',
        params: {
          name: 'Cell_Control',
          variables: [
            { name: 'Emergency_Stop', dataType: 'BOOL', initialValue: 'false' },
            { name: 'Laser_Active', dataType: 'BOOL', initialValue: 'false' }
          ]
        }
      }
    ],
    operationMode: 'replace_ob1_networks',
    tagsToUpsert: [
      { name: 'R1_In_Zone1', dataType: 'BOOL', address: '%I0.4' },
      { name: 'R2_In_Zone1', dataType: 'BOOL', address: '%I0.5' },
      { name: 'Safety_Door_Lock', dataType: 'BOOL', address: '%Q0.4' },
      { name: 'Collision_Alarm', dataType: 'BOOL', address: '%Q0.5' }
    ],
    dsl: [
      'NW 1 "Collision": SERIES(NO(R1_In_Zone1), NO(R2_In_Zone1), SET("Cell_Control".Emergency_Stop))',
      'NW 2 "Door": SERIES(NO("Cell_Control".Laser_Active), COIL(Safety_Door_Lock))',
      'NW 3 "Alarm": SERIES(NO("Cell_Control".Emergency_Stop), COIL(Collision_Alarm))'
    ].join('\n'),
    verification: {
      steps: [
        { atMs: 100, set: { R1_In_Zone1: true } },
        { atMs: 200, set: { R2_In_Zone1: true }, expect: { Collision_Alarm: true, Safety_Door_Lock: false } }
      ]
    }
  })
  const dead = scripted(deadRead)
  const deadTurn = await router.runAgentTurn('x', 'fast-flash', 'auto-apply', true, [], dead.fn)
  assert.strictEqual(dead.sent.length, 2, `A value nothing writes is asked about once: ${deadTurn.replyText}`)
  const question = JSON.parse(dead.sent[1]).at(-1).parts[0].text as string
  assert.ok(question.includes('reads "Cell_Control".Laser_Active, but nothing in OB1 writes it'), question)
  assert.ok(!question.includes('Emergency_Stop'), 'A bit a SET coil writes is not flagged')
  assert.ok(deadTurn.replyText.includes("okunuyor ama OB1'de hiçbir şey yazmıyor"), deadTurn.replyText)
  ok('A DB bit the circuit reads but nothing writes is questioned, then shown as a warning')

  // ---- A busy model (503) is asked again in the next round ----
  {
    const fetchBefore = globalThis.fetch
    router.unavailableModels.clear()
    router.updateConfig({ selectedModelId: 'gemini-3-flash-preview' })
    const calls: string[] = []
    let busy = true
    const answer = (text: string): Response =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })
    ;(globalThis as any).fetch = async (url: string) => {
      calls.push(url)
      if (url.includes('gemini-3-flash-preview:')) {
        if (busy) {
          busy = false
          return new Response('{"error":{"code":503,"message":"high demand"}}', { status: 503 })
        }
        return answer('{"explanation":"ok"}')
      }
      return answer(JSON.stringify({ explanation: 'x', networks: [{ networkNumber: 1, title: 'x', nodes: [] }] }))
    }
    await router.executePrompt('x', 'fast-flash', 'auto-apply')
    assert.strictEqual(calls.filter((u) => u.includes('gemini-3-flash-preview:')).length, 2, calls.join('\n'))
    ;(globalThis as any).fetch = fetchBefore
    ok('A model that was busy (503) is asked again in the next round')
  }

  // ---- Fourth log: the robot cell sequencer ----
  // gemini-3.7-flash wrote real line breaks inside "dsl". The reply was complete and was refused 4 times as cut off
  resetProject()
  const rawBreaks =
    '{\n  "explanation": "x",\n  "operationMode": "append_ob1_networks",\n  "dsl": "TAG Seq_Start %I0.6 BOOL \\"Start\\"\nTAG Seq_Step %M0.1 BOOL \\"Step 1\\"\nNW 1 \\"S1\\": SERIES(NO(Seq_Start), SET(Seq_Step))\nNW 2 \\"Out\\": SERIES(NO(Seq_Step), COIL(Q_R1_Permit))",\n  "verification": { "steps": [ { "atMs": 100, "set": { "Seq_Start": true } }, { "atMs": 300, "expect": { "Q_R1_Permit": true } } ] }\n}'
  assert.throws(() => JSON.parse(rawBreaks), 'The reply really is not strict JSON')
  const broken = router.interpretModelReply(rawBreaks)
  assert.deepStrictEqual(broken.problems, [], 'Line breaks inside a string do not make a reply cut off')
  assert.strictEqual(broken.circuit!.networks.length, 2)
  assert.strictEqual(escapeControlCharsInJsonStrings('{"a":"x\n\\"y\\"\tz"}'), '{"a":"x\\n\\"y\\"\\tz"}')
  ok('A reply with line breaks inside the "dsl" string is read, not refused as cut off')

  // gemini-3.6-flash wrote P_TRIG(M_Trig_R1_Done, R1_Bitti_Home). The signal was dropped and the step never came
  resetProject()
  assert.match(
    problemsOf('NW 1 "x": SERIES( P_TRIG(M_Edge, I_R1_Home), SET(Q_R1_Permit) )'),
    /P_TRIG takes one value, the signal whose edge it detects/
  )
  assert.match(problemsOf('NW 1 "x": SERIES( NO(I_R1_Zone, I_R2_Zone), COIL(Q_R1_Permit) )'), /NO takes one value/)
  assert.match(problemsOf('NW 1 "x": SERIES( NO(I_R1_Zone), COIL(Q_R1_Permit, Q_R2_Permit) )'), /COIL takes one value/)
  assert.deepStrictEqual(problemsOf('NW 1 "x": SERIES( N_TRIG(I_R1_Home), SET(Q_R1_Permit) )'), '')
  ok('An edge contact, contact or coil with two values is an error, not a contact on the wrong bit')

  // The user's I/O list had Robot 2 on %Q1.2 and %Q1.3, which this CPU lacks. The models moved them away
  resetProject()
  const cpuOutputs = useHardwareStore.getState().config.digitalIO.dqChannels.map((c) => c.address)
  assert.ok(!cpuOutputs.includes('%Q1.2'), `The demo CPU has no %Q1.2: ${cpuOutputs.join(' ')}`)
  const onModule = reply('TAG R2_Izin %Q1.2 BOOL "R2"\nNW 1 "x": SERIES( NO(I_R1_Zone), COIL(R2_Izin) )', {
    verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { R2_Izin: true } }] }
  })
  const userAddress = scripted(onModule)
  const askedTurn = await router.runAgentTurn('Robot Giriş İzni (Q1.2) verin', 'fast-flash', 'auto-apply', true, [], userAddress.fn)
  assert.strictEqual(userAddress.sent.length, 1, `An address the user gave is kept: ${askedTurn.replyText}`)
  assert.ok(askedTurn.replyText.includes('sinyal modülü'), askedTurn.replyText)
  resetProject()
  const notAsked = scripted(onModule)
  await router.runAgentTurn('Robot izni versin', 'fast-flash', 'auto-apply', true, [], notAsked.fn)
  assert.strictEqual(notAsked.sent.length, 2, 'An address the model chose by itself is still questioned')
  ok('An address from the user\'s I/O list is kept with a signal module note; one the model chose is questioned')

  // ---- Sixth log: the pick & place axis. A test with 2 checks of a 14-network sequence was accepted ----
  resetProject()
  const twoOutputs = 'NW 1 "a": SERIES( NO(I_R1_Zone), COIL(Q_R1_Permit) )\nNW 2 "b": SERIES( NO(I_R2_Zone), COIL(Q_R2_Permit) )'
  const thin = reply(twoOutputs, {
    verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
  })
  const thinRun = scripted(thin)
  const thinTurn = await router.runAgentTurn('iki izin', 'fast-flash', 'auto-apply', true, [], thinRun.fn)
  assert.strictEqual(thinRun.sent.length, 2, `An output the test never checks is asked about once: ${thinTurn.replyText}`)
  const thinQuestion = JSON.parse(thinRun.sent[1]).at(-1).parts[0].text as string
  assert.ok(thinQuestion.includes('never checks Q_R2_Permit'), thinQuestion)
  assert.ok(thinTurn.replyText.includes('**Test kapsamı:**') && thinTurn.replyText.includes('Q_R2_Permit'), thinTurn.replyText)
  resetProject()
  const fullRun = scripted(
    reply(twoOutputs, {
      verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true, Q_R2_Permit: false } }] }
    })
  )
  const fullTurn = await router.runAgentTurn('iki izin', 'fast-flash', 'auto-apply', true, [], fullRun.fn)
  assert.strictEqual(fullRun.sent.length, 1, fullTurn.replyText)
  assert.ok(!fullTurn.replyText.includes('Test kapsamı'), fullTurn.replyText)
  ok('A test that never checks an output is sent back once, then the unchecked values are shown')

  // gemini-3.8-flash wrote P_TRIG(M3.0) on a bit nothing writes. The test failed and the model never heard why
  resetProject()
  const deadEdge = scripted(
    reply('NW 1 "a": SERIES( NO(I_R1_Zone), P_TRIG(M3.0), SET(Q_R1_Permit) )', {
      verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
    }),
    reply('NW 1 "a": SERIES( P_TRIG(I_R1_Zone), SET(Q_R1_Permit) )', {
      verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
    })
  )
  await router.runAgentTurn('kenar', 'fast-flash', 'auto-apply', true, [], deadEdge.fn)
  const edgeFeedback = JSON.parse(deadEdge.sent[1]).at(-1).parts[0].text as string
  assert.ok(edgeFeedback.includes('simulation test failed') && /reads [^,]*\(%M3\.0\), but nothing in OB1 writes it/.test(edgeFeedback), edgeFeedback)
  ok('A failed test also says which read bit nothing writes')

  // gemini-3.5-flash put Robot 2's outputs (Q1.2, Q1.3 in the user's list) on M2.0 and M2.1
  resetProject()
  const onMerker = reply('TAG R2_Izin %M2.0 BOOL "R2"\nNW 1 "x": SERIES( NO(I_R1_Zone), COIL(R2_Izin) )', {
    verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { R2_Izin: true } }] }
  })
  const movedOff = scripted(onMerker)
  const movedTurn = await router.runAgentTurn('Robot 2 Giriş İzni (Q1.2) versin', 'fast-flash', 'auto-apply', true, [], movedOff.fn)
  assert.strictEqual(movedOff.sent.length, 2, movedTurn.replyText)
  const movedQuestion = JSON.parse(movedOff.sent[1]).at(-1).parts[0].text as string
  assert.ok(movedQuestion.includes("The user's I/O list names %Q1.2"), movedQuestion)
  assert.ok(movedTurn.replyText.includes('Listenizdeki %Q1.2'), movedTurn.replyText)
  ok('A signal the user gave an address for, put on another address, is questioned and then shown')

  // The steps the model put on M0.1..M0.4 went to free bits, because MB0 is the clock memory. Nobody was told
  resetProject()
  const clockByte = useHardwareStore.getState().config.clockMemory
  assert.ok(clockByte.enabled && clockByte.byteAddress === 0, 'The demo CPU has its clock memory in MB0')
  const onClock = scripted(
    reply('TAG Step_1 %M0.1 BOOL "Adim 1"\nNW 1 "s": SERIES( NO(I_R1_Zone), COIL(Step_1) )\nNW 2 "o": SERIES( NO(Step_1), COIL(Q_R1_Permit) )', {
      verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Step_1: true, Q_R1_Permit: true } }] }
    })
  )
  const clockTurn = await router.runAgentTurn('adim', 'fast-flash', 'auto-apply', true, [], onClock.fn)
  const step1 = allTags().find((t) => t.name === 'Step_1')!
  assert.notStrictEqual(step1.address, '%M0.1')
  assert.ok(
    clockTurn.replyText.includes('**Adres değişikliği:**') && clockTurn.replyText.includes(`Step_1: %M0.1 → ${step1.address}`),
    clockTurn.replyText
  )
  ok('A tag moved off the clock memory byte is reported with its old and new address')

  // The request needed MC_Power, MC_Home and MC_MoveAbsolute. Only the first reply said they were left out
  resetProject()
  const motion = scripted(
    reply('NW 1 "a": SERIES( NO(I_R1_Zone), COIL(Q_R1_Permit) )', {
      verification: { steps: [{ atMs: 100, set: { I_R1_Zone: true } }, { atMs: 300, expect: { Q_R1_Permit: true } }] }
    })
  )
  const motionTurn = await router.runAgentTurn('MC_Power ve MC_MoveAbsolute ile ekseni sür', 'fast-flash', 'auto-apply', true, [], motion.fn)
  assert.ok(motionTurn.replyText.includes('**Yapılamayan:**') && motionTurn.replyText.includes('MC_Power, MC_MoveAbsolute'), motionTurn.replyText)
  ok('A request for motion blocks is told that they are not in the circuit')

  // ---- What the model is told it cannot do ----
  const sentPrompt: string[] = []
  const realFetch = globalThis.fetch
  ;(globalThis as any).fetch = async (_url: string, init: { body: string }) => {
    sentPrompt.push(init.body)
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"explanation":"ok"}' }] } }] }), { status: 200 })
  }
  await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(/WHAT THIS IDE CANNOT DO/.test(sentPrompt[0]) && /safety program/.test(sentPrompt[0]) && /servo/.test(sentPrompt[0]))
  ok('The model is told that FB calls, motion and safety are not possible here')

  // ---- A model with no quota is not asked again, and a slow one does not stop the request ----
  router.updateConfig({ selectedModelId: 'gemini-noquota' })
  router.unavailableModels.clear()
  router.modelTimeoutMs = 200
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: string, init: { signal?: AbortSignal }) => {
    asked.push(url)
    if (url.includes('gemini-noquota')) {
      return new Response('{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 0"}}', { status: 429 })
    }
    if (url.includes('gemini-3-flash-preview:')) {
      // Hangs until the per-model timeout aborts it
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"explanation":"ok"}' }] } }] }), { status: 200 })
  }
  const first = await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(!first.isError, `A timeout moves on to the next model: ${first.replyText}`)
  assert.ok(asked.some((u) => u.includes('gemini-2.5-flash:')), 'The next model was asked')
  asked.length = 0
  await router.executePrompt('merhaba', 'fast-flash', 'auto-apply')
  assert.ok(!asked.some((u) => u.includes('gemini-noquota')), 'A model with limit 0 is not asked again')
  assert.strictEqual(router.getConfig().selectedModelId, 'gemini-noquota', 'The user setting is kept')
  ok('A model with no quota is skipped for the session, and a timeout tries the next model')

  ;(globalThis as any).fetch = realFetch
  router.modelTimeoutMs = 180000
  router.unavailableModels.clear()
  router.updateConfig({ geminiApiKey: '', selectedModelId: '' })
  console.log(`\nPhase 20: ${passed} passed, 0 failed\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
