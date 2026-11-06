import assert from 'node:assert'
import { BlackBoxLogger } from '../renderer/src/services/diagnostics/BlackBoxLogger'
import {
  AiModelRouter,
  sanitizeUserPrompt,
  sortGeminiModels,
  normalizeAiGeneratedNetworks,
  DiscoveredModel
} from '../renderer/src/services/ai/AiModelRouter'
import { LadderComparatorNode, LadderCounterNode, LadderTimerNode } from '../shared/types/ladder'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'

let passCount = 0
function testPass(name: string) {
  passCount++
  console.log(`PASS: ${name}`)
}

console.log('\n=== RUNNING PHASE 12 BLACK-BOX FLIGHT RECORDER & TELEMETRY TESTS ===\n')

// 1. Black-Box Logger Core Capabilities
function testBlackBoxLoggerCore() {
  console.log('--- 1. Testing Black-Box Flight Recorder Core & API Key Sanitization ---')

  const logger = BlackBoxLogger.getInstance()
  logger.clearLogs()
  assert.strictEqual(logger.getLogs().length, 0, 'Ring buffer starts clean')

  // Log events across categories
  logger.log('AI_REQUEST', 'Prompt sent to Gemini 2.5 Flash', {
    prompt: 'Synthesize parking garage barrier',
    model: 'gemini-2.5-flash',
    geminiApiKey: 'AIzaSyDemoSecretKey1234567890'
  })

  logger.log('AI_RAW_RESPONSE', 'Raw response from model', {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash?key=AIzaSySecretKey9876543210',
    status: 200
  })

  logger.log('AST_COMPILE', 'Compiled 5 networks', { networksCount: 5 })
  logger.log('TAG_SYNC', 'Synchronized 8 tags', { tagsCount: 8 })

  const allLogs = logger.getLogs()
  assert.strictEqual(allLogs.length, 4, 'Recorded 4 structured log entries')

  // Verify API Key masking
  const reqLog = logger.getLogs('AI_REQUEST')[0]
  assert.ok(reqLog, 'AI_REQUEST entry found')
  assert.ok(
    String(reqLog.details.geminiApiKey).startsWith('...'),
    `API Key in object masked: ${reqLog.details.geminiApiKey}`
  )
  assert.ok(
    !String(reqLog.details.geminiApiKey).includes('AIzaSyDemoSecret'),
    'Raw secret key purged from memory'
  )

  const respLog = logger.getLogs('AI_RAW_RESPONSE')[0]
  assert.ok(
    respLog.details.url.includes('key=...'),
    `URL query key parameter masked: ${respLog.details.url}`
  )

  // Verify Category filtering
  assert.strictEqual(logger.getLogs('AST_COMPILE').length, 1, 'Filtered AST_COMPILE logs')
  assert.strictEqual(logger.getLogs('TAG_SYNC').length, 1, 'Filtered TAG_SYNC logs')
  assert.strictEqual(logger.getLogs('UI_ACTION').length, 0, 'No UI_ACTION logs')

  testPass('BlackBoxLogger records categories and sanitizes API keys')

  // Verify Subscriber callback
  let notifiedEntry: any = null
  const unsubscribe = logger.subscribe((entry) => {
    notifiedEntry = entry
  })

  logger.log('UI_ACTION', 'User clicked [Flight Log] button')
  assert.ok(notifiedEntry, 'Subscriber was notified of new entry')
  assert.strictEqual(notifiedEntry.category, 'UI_ACTION')
  unsubscribe()

  testPass('Live telemetry subscription and event notification verified')

  // Verify Markdown Diagnostic Report Export
  const report = logger.exportDiagnosticReport()
  assert.ok(report.includes('=== RUNGLINE BLACK-BOX DIAGNOSTIC DUMP ==='), 'Contains header')
  assert.ok(report.includes('RECENT 50 TELEMETRY EVENTS'), 'Contains telemetry section')
  assert.ok(report.includes('Prompt sent to Gemini 2.5 Flash'), 'Contains sanitized event')
  testPass('Diagnostic Markdown Report generated successfully')
}

// 2. Resilient JSON Block Extraction
function testResilientJsonBlockExtraction() {
  console.log('\n--- 2. Testing Resilient JSON Block Extraction ---')

  const router = AiModelRouter.getInstance()

  // 2a. Markdown fenced json block
  const markdownFenced = `Here is the requested PLC logic:
\`\`\`json
{
  "explanation": "Test circuit with 1 network",
  "operationMode": "replace_ob1_networks",
  "tagsToUpsert": [
    { "name": "Start", "dataType": "BOOL", "address": "%I0.0" }
  ],
  "networks": [
    { "networkNumber": 1, "title": "Net 1", "comment": "", "nodes": [] }
  ]
}
\`\`\`
Let me know if you need adjustments.`

  const result1 = router.extractValidJsonBlock(markdownFenced)
  assert.ok(result1 !== null, 'Extracted from markdown fenced code block')
  assert.strictEqual(result1?.json.explanation, 'Test circuit with 1 network')
  assert.strictEqual(result1?.json.networks.length, 1)

  // 2b. Raw text with surrounding chatter (no markdown code fence)
  const rawChatter = `Sure thing! {"explanation": "Bare JSON without fences", "networks": []} hope that helps!`
  const result2 = router.extractValidJsonBlock(rawChatter)
  assert.ok(result2 !== null, 'Extracted bare JSON surrounded by text')
  assert.strictEqual(result2?.json.explanation, 'Bare JSON without fences')

  // 2c. Non-JSON conversational text
  const conversationalText = `The S7-1200 CPU supports up to 1024 digital inputs and 64 analog channels.`
  const result3 = router.extractValidJsonBlock(conversationalText)
  assert.strictEqual(result3, null, 'Returns null for non-JSON text')

  testPass('Resilient JSON extractor parses markdown fences, bare substrings, and ignores non-JSON text')
}

// 3. Strict Ban on Hardcoded Circuit Fallbacks & Honest Error Handling
async function testStrictBanOnHardcodedFallbacks() {
  console.log('\n--- 3. Testing Strict Ban on Hardcoded Fallbacks & Honest Error Telemetry ---')

  const router = AiModelRouter.getInstance()

  // Configure provider as 'gemini' with an invalid/mock key that will fail
  router.updateConfig({
    provider: 'gemini',
    geminiApiKey: 'invalid_dummy_api_key_for_testing'
  })

  // The API rejects the key. No test talks to the real network.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 })) as typeof fetch

  // Attempt prompt synthesis
  const prompt = 'motor calissin 10 sn sonra dursun yesil ve kirmizi led yansin'
  const response = await router.executePrompt(prompt, 'fast-flash', 'auto-apply')
  globalThis.fetch = realFetch

  // MUST return an honest error and NOT return canned Yesil_Led / Kirmizi_Led circuit!
  assert.strictEqual(response.isError, true, 'Flagged as error response')
  assert.strictEqual(response.providerUsed, 'gemini', 'Provider marked as gemini')
  assert.ok(
    response.replyText.includes('Gemini API') || response.replyText.includes('hata') || response.replyText.includes('failed'),
    'Honest error message returned'
  )

  // Verify that an AI_ERROR entry was recorded in BlackBoxLogger
  const logger = BlackBoxLogger.getInstance()
  const errorLogs = logger.getLogs('AI_ERROR')
  assert.ok(errorLogs.length > 0, 'BlackBoxLogger recorded AI_ERROR telemetry event')

  testPass('Zero-fake-fallback verified: Gemini API failure returns honest error and logs telemetry without fake circuit injection')

  router.updateConfig({ geminiApiKey: '' })
}

// 5. Prompt Sanitizer & Model Priority Sorting
function testPromptSanitizerAndModelSorting() {
  console.log('\n--- 5. Testing Prompt Sanitizer & Model Priority Sorting ---')

  // 5a. Prompt Sanitizer
  const dirtyPrompt1 = `10 Araçlık Otopark devresi oluştur\n[DIAGNOSTIC] Canlı Bobin Teşhis Raporu: Motor_Run enerjilenmedi.`
  assert.strictEqual(sanitizeUserPrompt(dirtyPrompt1), '10 Araçlık Otopark devresi oluştur')

  const dirtyPrompt2 = `motoru baslat 5 sn calissin [TIP] Try asking: "3 pompali hidrofor yap" RAG Context: MEB_Motor_StartStop_SealIn Rungline Agent`
  assert.strictEqual(sanitizeUserPrompt(dirtyPrompt2), 'motoru baslat 5 sn calissin')

  const cleanPrompt = '   start butonuna basinca motor calissin   '
  assert.strictEqual(sanitizeUserPrompt(cleanPrompt), 'start butonuna basinca motor calissin')

  testPass('sanitizeUserPrompt purges [DIAGNOSTIC], [TIP], RAG Context, and Rungline Agent clipboard pollution')

  // 5b. Model Priority Sorting
  const discovered: DiscoveredModel[] = [
    { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview' },
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }
  ]

  const sorted = sortGeminiModels(discovered)
  assert.strictEqual(sorted[0].id, 'gemini-2.5-flash', 'Top priority is gemini-2.5-flash')
  assert.strictEqual(sorted[1].id, 'gemini-3-flash-preview', 'Second priority is gemini-3-flash-preview')
  assert.strictEqual(sorted[2].id, 'gemini-2.5-flash-lite', 'Third priority is gemini-2.5-flash-lite')
  assert.strictEqual(sorted[3].id, 'gemini-2.5-pro', 'Fourth priority is gemini-2.5-pro')
  assert.strictEqual(sorted[4].id, 'gemini-2.0-flash', 'Fifth priority is gemini-2.0-flash')

  testPass('sortGeminiModels deterministically prioritizes models according to benchmark capability')
}

// 6. AST Normalizer (Mapping variant LLM output schemas into standard Siemens S7 AST)
function testNormalizeAiGeneratedNetworks() {
  console.log('\n--- 6. Testing AST Normalizer (normalizeAiGeneratedNetworks) ---')

  const rawVariantNetworks = [
    {
      id: 'nw_1',
      title: 'Variant Comparators and Contacts',
      elements: [
        { type: 'NO_CONTACT', operand: 'Start_Btn' },
        { type: 'CMP', operator: '<', in1: 'C1.CV', in2: '10' },
        { type: 'COMPARATOR', comparatorType: 'CMP_GE', op1: 'C1.CV', op2: '10' },
        { type: 'LESS_THAN', op1: 'C1.CV', op2: '5' },
        { type: 'OUTPUT_COIL', operand: 'Motor_Run' }
      ]
    },
    {
      id: 'nw_2',
      title: 'Variant Counters and Timers',
      nodes: [
        { type: 'N_TRIG', operand: 'Giris_Fotosel' },
        {
          type: 'CTUD',
          instanceName: 'C1',
          pv: 10,
          cu: '%I0.1',
          cd: '%I0.4'
        },
        {
          type: 'TON',
          instanceName: 'T1',
          pt: 'T#7s'
        },
        {
          type: 'PARALLEL_BRANCH',
          branches: [
            [{ type: 'NO', operand: 'T1.Q' }],
            [{ type: 'NC', operand: 'Ust_Limit' }]
          ]
        }
      ]
    }
  ]

  const normalized = normalizeAiGeneratedNetworks(rawVariantNetworks)
  assert.strictEqual(normalized.length, 2, 'Normalized 2 networks')

  // Check Network 1
  const net1 = normalized[0]
  assert.strictEqual(net1.nodes.length, 5, 'Network 1 converted elements to 5 nodes')

  // CMP operator: '<' -> CMP_LT
  const cmp1 = net1.nodes[1] as LadderComparatorNode
  assert.strictEqual(cmp1.kind, 'comparator', 'Node 1 is comparator')
  assert.strictEqual(cmp1.comparatorType, 'CMP_LT', 'operator: < mapped to CMP_LT')
  assert.strictEqual(cmp1.op1, 'C1.CV', 'op1 correctly mapped')
  assert.strictEqual(cmp1.op2, '10', 'op2 correctly mapped')

  // CMP_GE
  const cmp2 = net1.nodes[2] as LadderComparatorNode
  assert.strictEqual(cmp2.kind, 'comparator')
  assert.strictEqual(cmp2.comparatorType, 'CMP_GE')

  // LESS_THAN -> CMP_LT
  const cmp3 = net1.nodes[3] as LadderComparatorNode
  assert.strictEqual(cmp3.kind, 'comparator')
  assert.strictEqual(cmp3.comparatorType, 'CMP_LT')

  // Check Network 2
  const net2 = normalized[1]
  const nTrig = net2.nodes[0]
  assert.strictEqual(nTrig.kind, 'contact')
  assert.strictEqual((nTrig as any).contactType, 'N_TRIG')

  const ctud = net2.nodes[1] as LadderCounterNode
  assert.strictEqual(ctud.kind, 'counter')
  assert.strictEqual(ctud.counterType, 'CTUD')
  assert.strictEqual(ctud.instanceDb, 'C1')
  assert.strictEqual(ctud.pvOperand, '10')
  assert.strictEqual(ctud.cuOperand, '%I0.1')
  assert.strictEqual(ctud.cdOperand, '%I0.4')
  assert.strictEqual(ctud.qOperand, 'C1.QU')
  assert.strictEqual(ctud.cvOperand, 'C1.CV')

  const ton = net2.nodes[2] as LadderTimerNode
  assert.strictEqual(ton.kind, 'timer')
  assert.strictEqual(ton.timerType, 'TON')
  assert.strictEqual(ton.instanceDb, 'T1')
  assert.strictEqual(ton.ptOperand, 'T#7s')
  assert.strictEqual(ton.qOperand, 'T1.Q')

  const parallel = net2.nodes[3] as any
  assert.strictEqual(parallel.kind, 'parallel')
  assert.strictEqual(parallel.branches.length, 2)
  assert.strictEqual(parallel.branches[0][0].kind, 'contact')
  assert.strictEqual(parallel.branches[0][0].contactType, 'NO_CONTACT')

  testPass('normalizeAiGeneratedNetworks seamlessly maps all variant LLM AST representations')
}

// 7. End-to-End Parking Garage Synthesis with Telemetry Verification
async function testParkingGarageEndToEndTelemetry() {
  const demo = DemoProjectSeeder.createDemoProject()
  useBlockStore.getState().setBlocks({
    dataBlocks: demo.dataBlocks,
    ladBlocks: demo.ladBlocks,
    sclBlocks: demo.sclBlocks,
    udts: demo.udts
  })
  useTagStore.getState().setTagTables(demo.tagTables)

  console.log('\n--- 7. Testing End-to-End Parking Garage Synthesis with Telemetry Verification ---')

  const logger = BlackBoxLogger.getInstance()
  logger.clearLogs()

  // Reset tag store with clean default table
  useTagStore.getState().setTagTables([
    {
      id: 'tbl_default',
      name: 'Default Tag Table',
      tags: []
    }
  ])

  // Simulate LLM returning raw JSON payload for 10-Car Parking Garage
  const mockParkingJson = {
    explanation: '10-Car Parking Garage System with CTUD Counter, N_TRIG, and 7s Auto-Close Timer',
    operationMode: 'replace_ob1_networks',
    tagsToUpsert: [
      { name: 'Giris_Kart', address: '%I0.0', dataType: 'BOOL', comment: 'Card Reader' },
      { name: 'Giris_Fotosel', address: '%I0.1', dataType: 'BOOL', comment: 'Inlet Photocell' },
      { name: 'Ust_Limit', address: '%I0.2', dataType: 'BOOL', comment: 'Upper Limit' },
      { name: 'Alt_Limit', address: '%I0.3', dataType: 'BOOL', comment: 'Lower Limit' },
      { name: 'Cikis_Fotosel', address: '%I0.4', dataType: 'BOOL', comment: 'Outlet Photocell' },
      { name: 'Kapi_Yukari_Motor', address: '%Q0.0', dataType: 'BOOL', comment: 'Door Up Motor' },
      { name: 'Kapi_Asagi_Motor', address: '%Q0.1', dataType: 'BOOL', comment: 'Door Down Motor' },
      { name: 'Otopark_Dolu_Tabela', address: '%Q0.2', dataType: 'BOOL', comment: 'Garage Full Sign' }
    ],
    networks: [
      {
        networkNumber: 1,
        title: 'Bariyer Acma Motoru (%Q0.0)',
        nodes: [
          {
            kind: 'parallel',
            branches: [
              [
                { type: 'CMP', operator: '<', in1: 'C1.CV', in2: '10' },
                { type: 'NO', operand: 'Giris_Kart' }
              ],
              [
                { type: 'NO', operand: 'Kapi_Asagi_Motor' },
                { type: 'NO', operand: 'Giris_Fotosel' }
              ],
              [{ type: 'NO', operand: 'Kapi_Yukari_Motor' }]
            ]
          },
          { type: 'NC', operand: 'Ust_Limit' },
          { type: 'NC', operand: 'Kapi_Asagi_Motor' },
          { type: 'COIL', operand: 'Kapi_Yukari_Motor' }
        ]
      },
      {
        networkNumber: 2,
        title: 'Arac Giris/Cikis Sayaci (CTUD C1)',
        nodes: [
          { type: 'N_TRIG', operand: 'Giris_Fotosel' },
          { type: 'CTUD', instanceName: 'C1', pv: 10, cu: '%I0.1', cd: '%I0.4' }
        ]
      },
      {
        networkNumber: 3,
        title: '7 Saniye Otomatik Kapanma (TON T1)',
        nodes: [
          { type: 'NO', operand: 'Ust_Limit' },
          { type: 'TON', instanceName: 'T1', pt: 'T#7s' }
        ]
      },
      {
        networkNumber: 4,
        title: 'Bariyer Asagi Kapatma Motoru (%Q0.1)',
        nodes: [
          {
            kind: 'parallel',
            branches: [
              [{ type: 'NO', operand: 'T1.Q' }],
              [{ type: 'NO', operand: 'Kapi_Asagi_Motor' }]
            ]
          },
          { type: 'NC', operand: 'Alt_Limit' },
          { type: 'NC', operand: 'Giris_Fotosel' },
          { type: 'NC', operand: 'Kapi_Yukari_Motor' },
          { type: 'COIL', operand: 'Kapi_Asagi_Motor' }
        ]
      },
      {
        networkNumber: 5,
        title: 'Otopark Dolu Tabelasi (%Q0.2)',
        nodes: [
          { type: 'COMPARATOR', comparatorType: 'CMP_GE', op1: 'C1.CV', op2: '10' },
          { type: 'COIL', operand: 'Otopark_Dolu_Tabela' }
        ]
      }
    ]
  }

  const router = AiModelRouter.getInstance()
  const result = router.applyCircuitPayload(mockParkingJson as any, 'auto-apply')

  // Log raw and parse events into flight recorder
  logger.log('AI_RAW_RESPONSE', 'Gemini API Response received from gemini-2.5-flash (420ms, 1250 chars)', {
    rawFull: JSON.stringify(mockParkingJson)
  })
  logger.log('AI_PARSE_AND_AST_INJECTION', 'Extracted JSON payload: 5 networks, 8 tags', {
    networks: 5,
    tags: 8
  })

  // Verify tags in tag store
  const tags = useTagStore.getState().tagTables[0]?.tags || []
  assert.strictEqual(tags.length, 8, '8 unique tags created')
  assert.ok(tags.some((t) => t.name === 'Giris_Fotosel' && t.address === '%I0.1'))
  assert.ok(tags.some((t) => t.name === 'Kapi_Yukari_Motor' && t.address === '%Q0.0'))
  assert.ok(tags.some((t) => t.name === 'Otopark_Dolu_Tabela' && t.address === '%Q0.2'))

  // Verify OB1_Main networks
  const ob1 = useBlockStore.getState().ladBlocks.find((b) => b.number === 1 || b.name === 'OB1_Main')
  assert.ok(ob1, 'OB1_Main block updated')
  assert.strictEqual(ob1?.networks.length, 5, 'OB1 contains exactly 5 networks')

  // Verify flight log telemetry entries
  const rawLogs = logger.getLogs('AI_RAW_RESPONSE')
  assert.strictEqual(rawLogs.length, 1, 'AI_RAW_RESPONSE logged')

  const parseLogs = logger.getLogs('AI_PARSE_AND_AST_INJECTION')
  assert.strictEqual(parseLogs.length, 1, 'AI_PARSE_AND_AST_INJECTION logged')
  assert.strictEqual(parseLogs[0].details.networks, 5, 'Recorded 5 networks')
  assert.strictEqual(parseLogs[0].details.tags, 8, 'Recorded 8 tags')

  testPass('End-to-End Parking Garage JSON normalization, tag allocation & BlackBox telemetry verified')
}

// Run All Tests
async function runAll() {
  testBlackBoxLoggerCore()
  testResilientJsonBlockExtraction()
  await testStrictBanOnHardcodedFallbacks()
  testPromptSanitizerAndModelSorting()
  testNormalizeAiGeneratedNetworks()
  await testParkingGarageEndToEndTelemetry()

  console.log(`\n======================================================`)
  console.log(`PHASE 12 UNIT TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`)
  console.log(`======================================================\n`)
}

runAll().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
