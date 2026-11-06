/**
 * Phase 4 Verification & End-to-End Test Suite
 * Covers:
 * 1. Hotfixes A, B, C verification (Memory overlap deduplication, runtime loop, label clearance)
 * 2. Module 1: AI Model Router & Deterministic Industrial Synthesis Engine (TR & EN)
 * 3. Module 2: Tool-Calling Agent with Compiler-in-the-Loop verification
 * 4. Module 3: [Auto-Apply] vs [Diff-View Approval] Staging Workflow & Revert
 * 5. Module 4: Live "Why is this Coil OFF?" Diagnostics & 3-Layer Self-Learning RAG
 * 6. Module 5: Siemens TIA Portal Openness & SimaticML Export Bridge
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { MemoryOverlapEngine } from '../renderer/src/services/MemoryOverlapEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { LadderEvaluator } from '../renderer/src/runtime/LadderEvaluator'
import { AiModelRouter, isStrictGeminiTextModel } from '../renderer/src/services/ai/AiModelRouter'
import { parseTimePresetMs } from '../renderer/src/runtime/LadderEvaluator'
import { PlcAgentTools } from '../renderer/src/services/ai/PlcAgentTools'
import { CoilDiagnosticEngine } from '../renderer/src/services/ai/CoilDiagnosticEngine'
import { RagKnowledgeEngine } from '../renderer/src/services/ai/RagKnowledgeEngine'
import { TiaExportBridge } from '../renderer/src/services/export/TiaExportBridge'
import { LadderDslCompiler } from '../renderer/src/services/compiler/LadderDslCompiler'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { useRuntimeStore } from '../renderer/src/stores/useRuntimeStore'
import { LadBlockDefinition } from '@shared/types/blocks'

console.log('\n=== RUNNING PHASE 4 AI AGENT, RAG & TIA EXPORT TEST SUITE ===\n')

let passCount = 0
function testPass(label: string) {
  console.log(`✅ PASS: ${label}`)
  passCount++
}

// Seed the clean demo project
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

// -------------------------------------------------------------
// SECTION 1: Hotfixes Verification
// -------------------------------------------------------------
console.log('--- 1. Testing Hotfixes A, B, C (Overlap Guard & Deduplication) ---')

const analysis = MemoryOverlapEngine.analyzeCollisions(demo.tagTables, demo.hardware)
// In clean demo, exactly one tutorial collision (%MW10 with %M11.2)
assert.strictEqual(analysis.totalCollisionCount, 2, 'Exactly 2 colliding tags (MW10 & M11.2 tutorial overlap)')
testPass('Memory Overlap Engine isolates tutorial overlap (%MW10 and %M11.2) without self-collisions')

// Check deduplication
const diagMessages = analysis.diagnostics.map((d) => d.message)
for (const msg of diagMessages) {
  assert.ok(!msg.includes("collides with 'EmergencyStop'"), 'No self-collision for EmergencyStop')
  assert.ok(!msg.includes("collides with 'TankLevel_Raw'"), 'No self-collision for TankLevel_Raw')
}
testPass('Zero phantom duplicate self-collisions reported for symbolic hardware tags')

// -------------------------------------------------------------
// SECTION 2: AI Model Router & Deterministic Industrial Engine
// -------------------------------------------------------------
console.log('\n--- 2. Testing AI Model Router & Multi-Pump Industrial Synthesis ---')

const router = AiModelRouter.getInstance()

// Test Turkish language detection
assert.strictEqual(router.detectTurkish('3 pompalı eş yaşlandırmalı hidrofor sistemi kur'), true)
assert.strictEqual(router.detectTurkish('Create 3-pump booster system with lead-lag alternation'), false)
testPass('Router accurately detects Turkish and English engineering intents')

async function testSynthesis() {
  // Without a key the agent must refuse, and must not answer from a built-in plan
  const realFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    throw new Error('No request is expected')
  }) as typeof fetch
  router.updateConfig({ provider: 'gemini', geminiApiKey: '' })
  const blocksBefore = useBlockStore.getState().sclBlocks.length
  const noKey = await router.executePrompt('3 pompalı hidrofor sistemi kur', 'fast-flash', 'auto-apply')
  globalThis.fetch = realFetch
  assert.strictEqual(noKey.isError, true, 'A missing key is an error')
  assert.ok(noKey.replyText.includes('API anahtarı'), 'The reply says a key is needed')
  assert.strictEqual(requests, 0, 'No request is sent without a key')
  assert.strictEqual(useBlockStore.getState().sclBlocks.length, blocksBefore, 'The project is unchanged')
  testPass('Without an API key the agent reports an error and changes nothing')

  router.updateConfig({ provider: 'openai', openaiApiKey: '' })
  const noOpenAiKey = await router.executePrompt('create a pump', 'fast-flash', 'auto-apply')
  assert.strictEqual(noOpenAiKey.isError, true, 'OpenAI without a key is an error too')
  router.updateConfig({ provider: 'gemini' })
  testPass('OpenAI without a key is refused the same way')

  // The agent tools build a block, and the compiler step checks the result
  const tools = PlcAgentTools.getInstance()
  const valve = await tools.executeToolBatch(
    [
      {
        tool: 'create_or_update_udt',
        params: {
          name: 'UDT_Valve',
          fields: [
            { name: 'OpenCmd', dataType: 'BOOL' },
            { name: 'CloseCmd', dataType: 'BOOL' }
          ]
        }
      },
      {
        tool: 'create_or_update_scl_block',
        params: {
          name: 'FB_ValveControl',
          blockType: 'FB',
          sourceCode: `FUNCTION_BLOCK "FB_ValveControl"
VAR_INPUT
  OpenRequest : Bool;
END_VAR
VAR_OUTPUT
  OpenCmd : Bool;
END_VAR
BEGIN
  #OpenCmd := #OpenRequest;
END_FUNCTION_BLOCK`
        }
      },
      { tool: 'run_compiler_and_self_heal', params: {} }
    ],
    'auto-apply'
  )
  assert.ok(valve.compilerReport?.success, `Compiler accepted the tool output: ${valve.compilerReport?.message}`)
  const currentStore = useBlockStore.getState()
  assert.ok(currentStore.udts.find((u) => u.name === 'UDT_Valve'), 'UDT_Valve created')
  const valveFb = currentStore.sclBlocks.find((b) => b.name === 'FB_ValveControl')
  assert.strictEqual(valveFb?.interface.input.length, 1, 'The interface comes from the source header')
  testPass('Agent tools create a UDT and an FB that pass the compiler')

  const broken = await tools.executeToolBatch(
    [
      { tool: 'create_or_update_scl_block', params: { name: 'FB_Broken', blockType: 'FB', sourceCode: '#Undeclared := TRUE;' } },
      { tool: 'run_compiler_and_self_heal', params: {} }
    ],
    'auto-apply'
  )
  assert.strictEqual(broken.compilerReport?.success, false, 'The compiler step reports an undeclared variable')
  useBlockStore.getState().deleteSclBlock('FB_Broken.scl')
  testPass('The compiler step catches a block with an undeclared variable')
}

// -------------------------------------------------------------
// SECTION 3: Tool-Calling Agent, Diff-View Staging & Snapshot Revert
// -------------------------------------------------------------
console.log('\n--- 3. Testing Tool-Calling Agent, Diff-View Staging & Revert ---')

async function testDiffViewAndRevert() {
  const tools = PlcAgentTools.getInstance()
  const initialSclCount = useBlockStore.getState().sclBlocks.length

  // Test Diff-View Staging (should NOT mutate store until approved)
  const stagedRes = await tools.executeToolBatch(
    [
      {
        tool: 'create_or_update_scl_block',
        params: {
          name: 'FC_TestStagedLogic',
          code: '// Staged code\n"MainConveyor_Run" := TRUE;'
        }
      }
    ],
    'diff-view'
  )

  assert.ok(stagedRes.stagedChangeset, 'Changeset was staged')
  assert.strictEqual(stagedRes.stagedChangeset.length, 1, 'Exactly 1 file staged')
  assert.strictEqual(stagedRes.stagedChangeset[0].title, 'SCL: FC_TestStagedLogic')
  assert.strictEqual(
    useBlockStore.getState().sclBlocks.length,
    initialSclCount,
    'Store count unchanged before approval'
  )
  testPass('Diff-View mode stages changesets without prematurely mutating stores')

  // Now apply staged changeset
  const applyRes = tools.applyStagedChangeset(stagedRes.stagedChangeset)
  assert.strictEqual(applyRes.results[0].success, true)
  assert.strictEqual(useBlockStore.getState().sclBlocks.length, initialSclCount + 1, 'Store updated after approval')
  testPass('applyStagedChangeset successfully applied proposed changes and triggered compiler check')

  // Test Revert Last Turn
  const revertRes = tools.revertLastTurn()
  assert.strictEqual(revertRes.success, true)
  assert.strictEqual(useBlockStore.getState().sclBlocks.length, initialSclCount, 'Store rolled back to previous snapshot')
  testPass('revertLastTurn rolled back all AST mutations to clean previous snapshot')

  const diffUpdate = await tools.executeToolBatch(
    [
      {
        tool: 'create_or_update_scl_block',
        params: { name: 'FB_ValveControl', blockType: 'FB', sourceCode: '// Updated\n#EmergencyStop := TRUE;' }
      }
    ],
    'diff-view'
  )
  assert.strictEqual(diffUpdate.stagedChangeset?.length, 1)
  assert.ok(diffUpdate.stagedChangeset?.[0].afterContent.includes('#EmergencyStop'))
  assert.ok(
    !useBlockStore.getState().sclBlocks.find((b) => b.name === 'FB_ValveControl')?.code.includes('#EmergencyStop'),
    'The block stays as it was until approval'
  )
  testPass('Diff-View stages an update of an existing block without applying it')
}

// -------------------------------------------------------------
// SECTION 4: Live "Why is this Coil OFF?" Diagnostics & 3-Layer RAG
// -------------------------------------------------------------
console.log('\n--- 4. Testing Live Coil Diagnostics & 3-Layer Self-Learning RAG ---')

function testDiagnosticsAndRag() {
  const mainLad = useBlockStore.getState().ladBlocks.find((b) => b.name === 'OB1_Main')
  assert.ok(mainLad, 'OB1_Main LAD block found')

  // Run live diagnostic on de-energized coil
  const diag = CoilDiagnosticEngine.diagnoseCoil(mainLad, 1, 'MainConveyor_Run')
  assert.strictEqual(diag.isEnergized, false, 'Coil is initially de-energized')
  assert.ok(diag.blockingContact, 'Blocking contact identified')
  assert.strictEqual(diag.blockingContact.operand, 'EmergencyStop', 'EmergencyStop identified as root-cause breaker')
  assert.strictEqual(diag.blockingContact.address, '%I0.0', 'Blocking address %I0.0 pinpointed')
  testPass('CoilDiagnosticEngine traced back and pinpointed EmergencyStop (%I0.0) blocking contact')

  // Test 1-click force blocking bit
  CoilDiagnosticEngine.forceBlockingBitTrue('%I0.0')
  const forcedVal = useRuntimeStore.getState().engine.getVariable('%I0.0')
  assert.strictEqual(forcedVal, true, 'Forced bit is now TRUE in runtime engine')
  testPass('forceBlockingBitTrue successfully forced %I0.0 to TRUE in runtime memory image')

  // Test 3-Layer RAG Engine
  const rag = RagKnowledgeEngine.getInstance()
  const contextPrompt = rag.buildDynamicContextPrompt()
  assert.ok(contextPrompt.includes('Target CPU:'), 'RAG Layer 1 injects target CPU context')
  assert.ok(contextPrompt.includes('%MB0'), 'RAG Layer 1 injects clock memory context')
  assert.ok(contextPrompt.includes('S7_Optimized_Access'), 'RAG Layer 1 injects S7 syntax constraints')
  testPass('RAG Layer 1 dynamic context injector generated valid architectural context prompt')

  // Save Block to AI Standard Library
  const savedItem = rag.saveStandardBlock({
    name: 'Company_Conveyor_Standard',
    category: 'sequencing',
    description: 'Standard company dual-speed conveyor block with thermal fault check',
    blockType: 'LAD',
    contentJson: JSON.stringify(mainLad)
  })
  assert.ok(savedItem.id.startsWith('std_'))
  testPass('RAG Layer 3 saved Company_Conveyor_Standard to persistent AI Standard Library')

  const query = rag.queryKnowledge('conveyor')
  assert.ok(query.matchedStandards.length >= 1, 'Found saved company conveyor standard in query')
  testPass('RAG Layer 3 retrieval returned saved standard block in matching search')
}

// -------------------------------------------------------------
// SECTION 5: Siemens TIA Portal Openness & SimaticML Export Bridge
// -------------------------------------------------------------
console.log('\n--- 5. Testing Siemens TIA Portal Openness & SimaticML Export Bridge ---')

function testTiaExportBridge() {
  const bundle = TiaExportBridge.generateBundle()

  assert.ok(bundle.files.length >= 6, 'Generated at least 6 export files in bundle')
  assert.ok(bundle.summary.totalTagsExported >= 10, 'Exported all project tags')
  testPass('TiaExportBridge bundled complete project with tags, blocks, and UDTs')

  // Check SCL export
  const sclFile = bundle.files.find((f) => f.type === 'scl')
  assert.ok(sclFile, 'SCL external source file exists')
  assert.ok(sclFile.content.includes("{ S7_Optimized_Access := 'TRUE' }"), 'SCL file contains S7_Optimized_Access attribute')
  assert.ok(sclFile.content.includes('VERSION : 0.1'), 'SCL file contains Siemens VERSION header')
  testPass('SCL external sources formatted with Siemens S7_Optimized_Access and block headers')

  // Check UDT export
  const udtFile = bundle.files.find((f) => f.type === 'udt')
  assert.ok(udtFile, 'UDT external source file exists')
  assert.ok(udtFile.content.includes('TYPE "'), 'UDT file contains TYPE header')
  assert.ok(udtFile.content.includes('END_TYPE'), 'UDT file contains END_TYPE footer')
  testPass('UDT files formatted as valid Siemens S7 TYPE definitions')

  // Check DB export
  const dbFile = bundle.files.find((f) => f.type === 'db')
  assert.ok(dbFile, 'DB external source file exists')
  assert.ok(dbFile.content.includes('DATA_BLOCK "'), 'DB file contains DATA_BLOCK header')
  assert.ok(dbFile.content.includes('END_DATA_BLOCK'), 'DB file contains END_DATA_BLOCK footer')
  testPass('DB files formatted as valid Siemens S7 DATA_BLOCK sources')

  // Tag table for the bridge
  const tagFile = bundle.files.find((f) => f.type === 'xml')
  assert.ok(tagFile, 'Tag table XML exists')
  assert.ok(tagFile.content.includes('<SW.Tags.PlcTagTable'), 'Tag table element present')
  assert.ok(tagFile.content.includes('"EmergencyStop"') || tagFile.content.includes('>EmergencyStop<'), 'Contains EmergencyStop tag')
  testPass('Tag table written as SimaticML')

  // LAD blocks are reported as skipped until a real SimaticML writer exists
  assert.ok(!bundle.files.some((f) => f.content.includes('<FlgNet')), 'No hand-made LAD XML is exported')
  assert.ok(bundle.manifest.skipped.length > 0, 'The demo LAD blocks are listed as skipped')
  assert.ok(bundle.manifest.warnings.some((w) => w.includes('LAD')), 'Skipping LAD produces a warning')
  testPass('LAD blocks are skipped with an explicit warning')

  // Spreadsheet input for hand import
  const csvFile = bundle.files.find((f) => f.filename === 'PLC_Tags.csv')
  assert.ok(csvFile, 'PLC_Tags.csv exists')
  assert.ok(csvFile.content.startsWith('Name,Path,Data Type,Logical Address,Comment'), 'CSV header matches the TIA tag columns')
  assert.ok(csvFile.content.includes('"EmergencyStop"'), 'Contains EmergencyStop tag')
  testPass('PLC_Tags.csv written')

  assert.ok(bundle.files.some((f) => f.filename === 'manifest.json'), 'manifest.json exists')
  testPass('Manifest written for the Openness bridge')
}

async function testDirectLadderSynthesis() {
  console.log('\n--- 6. Testing Direct Natural Language Ladder Synthesis & Simulation ---')
  const dslInput = `
# TAG DECLARATIONS
TAG Start_Btn %I0.0 BOOL "Start Pushbutton (NO)"
TAG Stop_Btn %I0.1 BOOL "Stop Pushbutton (NC)"
TAG Motor_Run %Q0.0 BOOL "Main Motor Contactor"

# NETWORK DEFINITIONS
NW 1 "Motor Start, Latch & T1.Q Trip": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), NC(T1.Q), COIL(Motor_Run) )
NW 2 "10-Second Timer (TON T1)": SERIES( NO(Motor_Run), TON(T1, PT=T#10s) )
`
  const dslResult = LadderDslCompiler.compileLadderDslToAst(dslInput)
  const res = router.applyCircuitPayload(
    {
      explanation: '10 Saniye Sonra Otomatik Duran Mühürlemeli Motor Devresi (MEB Standartı)',
      operationMode: 'replace_ob1_networks',
      tagsToUpsert: dslResult.tags as any,
      networks: dslResult.networks
    },
    'auto-apply'
  )

  assert.ok(res.summaryText.includes('10 Saniye Sonra Otomatik Duran Mühürlemeli Motor Devresi'), 'Response includes timer circuit summary')
  testPass('Direct natural-language prompt synthesized 10s timer ladder logic')

  // Check tags in TagStore (Strict MEB Standard: 0 %M dummy helper tags!)
  const tagStore = useTagStore.getState()
  const allTags = tagStore.tagTables.flatMap((t) => t.tags)
  const startBtn = allTags.find((t) => t.name === 'Start_Btn')
  const stopBtn = allTags.find((t) => t.name === 'Stop_Btn')
  const motorRun = allTags.find((t) => t.name === 'Motor_Run')
  const dummyTimerTag = allTags.find((t) => t.address.startsWith('%M') && (t.name.toLowerCase().includes('timer') || t.name.toLowerCase().includes('done')))

  assert.ok(startBtn && startBtn.address === '%I0.0', 'Start_Btn at %I0.0 created')
  assert.ok(stopBtn && stopBtn.address === '%I0.1', 'Stop_Btn at %I0.1 created')
  assert.ok(motorRun && motorRun.address === '%Q0.0', 'Motor_Run at %Q0.0 created')
  assert.ok(!dummyTimerTag, 'Zero dummy %M timer helper tags in TagStore (MEB Rule 1)')
  testPass('Canonical MEB tags (%I0.0, %I0.1, %Q0.0) registered with zero dummy %M flags')

  // Check OB1_Main networks in BlockStore
  const ladBlocks = useBlockStore.getState().ladBlocks
  const ob1 = ladBlocks.find((b) => b.number === 1 || b.name === 'OB1_Main')
  assert.ok(ob1, 'OB1_Main block exists')
  assert.strictEqual(ob1.networks.length, 2, 'OB1_Main has exactly 2 synthesized networks')

  const net1 = ob1.networks[0]
  const net2 = ob1.networks[1]
  assert.strictEqual(net1.nodes[0].kind, 'parallel', 'Network 1 starts with parallel branch')
  assert.strictEqual((net1.nodes[2] as any).operand, 'T1.Q', 'Network 1 uses native T1.Q trip contact')
  assert.strictEqual(net2.nodes[1].kind, 'timer', 'Network 2 contains TON timer')
  assert.strictEqual(net2.nodes.length, 2, 'Network 2 has zero trailing dummy coils (terminates at terminal bar)')
  testPass('OB1_Main contains valid MEB 2-network Ladder AST with native T1.Q addressing')

  // Test live simulation execution
  const engine = new PlcRuntimeEngine()
  const currentDemo = DemoProjectSeeder.createDemoProject()
  currentDemo.ladBlocks = useBlockStore.getState().ladBlocks
  currentDemo.tagTables = useTagStore.getState().tagTables
  engine.loadProject(currentDemo)
  engine.start()

  // Press Start_Btn
  engine.setVariable('%I0.0', true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  // Release Start_Btn (momentary pushbutton)
  engine.setVariable('%I0.0', false)
  await new Promise((resolve) => setTimeout(resolve, 40))

  // Verify Motor_Run is latched TRUE
  const motorState = engine.getVariable('%Q0.0')
  assert.strictEqual(motorState, true, 'Motor_Run is latched ON via parallel branch')
  testPass('SoftPLC executes latched motor running via parallel seal-in')

  // Simulate T1.Q trip
  engine.setVariable('T1.Q', true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.strictEqual(engine.getVariable('%Q0.0'), false, 'Motor_Run tripped to FALSE by native T1.Q contact')
  testPass('SoftPLC executes auto-stop trip via native T1.Q contact')

  engine.stop()
}

function testTimerAndModelFilter() {
  console.log('\n--- 7. Testing Strict Model Whitelist & Timer Preset Parsing ---')

  // Strict Model Whitelist Verification
  assert.strictEqual(isStrictGeminiTextModel('gemini-2.5-flash'), true, 'gemini-2.5-flash accepted')
  assert.strictEqual(isStrictGeminiTextModel('gemini-2.5-pro'), true, 'gemini-2.5-pro accepted')
  assert.strictEqual(isStrictGeminiTextModel('gemini-2.0-flash'), true, 'gemini-2.0-flash accepted')
  assert.strictEqual(isStrictGeminiTextModel('gemini-1.5-pro'), true, 'gemini-1.5-pro accepted')

  assert.strictEqual(isStrictGeminiTextModel('models/gemini-2.5-flash'), true, 'models/ prefix handled')
  assert.strictEqual(isStrictGeminiTextModel('lyria-3'), false, 'lyria music model rejected')
  assert.strictEqual(isStrictGeminiTextModel('banana-split'), false, 'banana model rejected')
  assert.strictEqual(isStrictGeminiTextModel('gemini-tts-1'), false, 'tts model rejected')
  assert.strictEqual(isStrictGeminiTextModel('gemini-imagen-3'), false, 'imagen model rejected')
  assert.strictEqual(isStrictGeminiTextModel('gemini-vision-robotics'), false, 'vision/robotics model rejected')
  assert.strictEqual(isStrictGeminiTextModel('gemini-embedding-001'), false, 'embedding model rejected')
  assert.strictEqual(isStrictGeminiTextModel('text-embedding-ada-002'), false, 'non-gemini model rejected')
  testPass('Strict Gemini text/code model whitelist enforces valid models and rejects multimedia/research/audio')

  // Timer Preset Parsing Verification
  assert.strictEqual(parseTimePresetMs('T#10s'), 10000, 'T#10s -> 10000ms')
  assert.strictEqual(parseTimePresetMs('10s'), 10000, '10s -> 10000ms')
  assert.strictEqual(parseTimePresetMs('T#500ms'), 500, 'T#500ms -> 500ms')
  assert.strictEqual(parseTimePresetMs('500ms'), 500, '500ms -> 500ms')
  assert.strictEqual(parseTimePresetMs('T#2m'), 120000, 'T#2m -> 120000ms')
  assert.strictEqual(parseTimePresetMs('10000'), 10000, '10000 -> 10000ms')
  assert.strictEqual(parseTimePresetMs(5000), 5000, '5000 (number) -> 5000ms')
  assert.strictEqual(parseTimePresetMs(''), 10000, 'empty -> default 10000ms')
  assert.strictEqual(parseTimePresetMs('T#1m30s'), 90000, 'compound T#1m30s -> 90000ms')
  testPass('Robust parseTimePresetMs correctly evaluates all industrial standard time presets')
}

async function runAll() {
  await testSynthesis()
  await testDiffViewAndRevert()
  testDiagnosticsAndRag()
  testTiaExportBridge()
  await testDirectLadderSynthesis()
  testTimerAndModelFilter()

  console.log(`\n======================================================`)
  console.log(`PHASE 4 TEST SUMMARY: ${passCount} PASSED, 0 FAILED`)
  console.log(`======================================================\n`)
}

runAll()
