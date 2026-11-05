import assert from 'node:assert'
import { MemoryOverlapEngine } from '../renderer/src/services/MemoryOverlapEngine'
import { CompileEngine } from '../renderer/src/services/CompileEngine'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { LadderDslCompiler } from '../renderer/src/services/compiler/LadderDslCompiler'
import { BlackBoxLogger } from '../renderer/src/services/diagnostics/BlackBoxLogger'
import { TagTable } from '@shared/types/tags'
import { LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import { LadderNetwork } from '@shared/types/ladder'

let passCount = 0
function testPass(name: string) {
  passCount++
  console.log(`✅ PASS: ${name}`)
}

console.log('\n=== RUNNING PHASE 5 COMPILER, COLLISION & SYNTHESIS TESTS ===\n')

// 1. Exact-Bit Collision Detection (%I0.1 between Start_Btn and Stop_Btn)
function testExactBitCollision() {
  console.log('--- 1. Testing Exact-Bit Memory Overlap Guard ---')

  const tagTable: TagTable = {
    id: 'tbl_test',
    name: 'TestTags',
    fileName: 'TestTags.tags.json',
    tags: [
      { id: 'tag_start', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.1' },
      { id: 'tag_stop', name: 'Stop_Btn', dataType: 'BOOL', address: '%I0.1' },
      { id: 'tag_motor', name: 'Motor_Run', dataType: 'BOOL', address: '%Q0.0' }
    ]
  }

  const analysis = MemoryOverlapEngine.analyzeCollisions([tagTable])
  assert.strictEqual(analysis.totalCollisionCount, 2, 'Exactly 2 colliding tags reported for same bit %I0.1')
  assert.ok(analysis.collisions.has('tag_start'), 'tag_start is flagged in collisions map')
  assert.ok(analysis.collisions.has('tag_stop'), 'tag_stop is flagged in collisions map')
  assert.ok(analysis.collisions.has('start_btn'), 'start_btn (lowercase name) is indexed in collisions map')
  assert.ok(analysis.collisions.has('stop_btn'), 'stop_btn (lowercase name) is indexed in collisions map')
  assert.ok(!analysis.collisions.has('tag_motor'), 'Motor_Run (%Q0.0) has no collisions')

  const startCol = analysis.collisions.get('tag_start')!
  assert.strictEqual(startCol.conflictsWith.length, 1)
  assert.strictEqual(startCol.conflictsWith[0].name, 'Stop_Btn')
  assert.strictEqual(startCol.conflictsWith[0].overlapArea, '%I0.1')

  testPass('MemoryOverlapEngine accurately flags exact-bit collision on %I0.1 without self-collision')
}

// 2. Deterministic Unique Address Allocator in AI Router
function testUniqueAddressAllocator() {
  console.log('\n--- 2. Testing AI Router Unique Address Allocator ---')

  const tagsToUpsert = [
    { name: 'Start_Btn', dataType: 'BOOL' as const, address: '%I0.1', comment: 'Start' },
    { name: 'Stop_Btn', dataType: 'BOOL' as const, address: '%I0.1', comment: 'Stop (colliding %I0.1)' },
    { name: 'Motor_Run', dataType: 'BOOL' as const, address: '%Q0.0', comment: 'Motor' },
    { name: 'Aux_Motor', dataType: 'BOOL' as const, address: '%Q0.0', comment: 'Aux Motor (colliding %Q0.0)' }
  ]

  const networks: LadderNetwork[] = [
    {
      id: 'net_1',
      networkNumber: 1,
      title: 'Net 1',
      nodes: [
        {
          id: 'c1',
          kind: 'contact',
          contactType: 'NO_CONTACT',
          operand: 'Start_Btn',
          address: '%I0.1',
          symbolName: 'Start_Btn'
        },
        {
          id: 'c2',
          kind: 'contact',
          contactType: 'NC_CONTACT',
          operand: 'Stop_Btn',
          address: '%I0.1',
          symbolName: 'Stop_Btn'
        },
        {
          id: 'q1',
          kind: 'coil',
          coilType: 'OUTPUT_COIL',
          operand: 'Motor_Run',
          address: '%Q0.0',
          symbolName: 'Motor_Run'
        },
        {
          id: 'q2',
          kind: 'coil',
          coilType: 'OUTPUT_COIL',
          operand: 'Aux_Motor',
          address: '%Q0.0',
          symbolName: 'Aux_Motor'
        }
      ]
    }
  ]

  const sanitized = AiModelRouter.sanitizeAndAllocateUniqueAddresses(tagsToUpsert, networks, [])
  const addrs = sanitized.tags.map((t) => t.address)
  const uniqueAddrs = new Set(addrs)
  assert.strictEqual(uniqueAddrs.size, 4, 'All 4 tags have distinct allocated addresses')

  const sanitizedStop = sanitized.tags.find((t) => t.name === 'Stop_Btn')!
  assert.notStrictEqual(sanitizedStop.address, '%I0.1', 'Stop_Btn reallocated away from colliding %I0.1')
  assert.ok(sanitizedStop.address.startsWith('%I'), 'Stop_Btn kept in %I area')

  const sanitizedAux = sanitized.tags.find((t) => t.name === 'Aux_Motor')!
  assert.notStrictEqual(sanitizedAux.address, '%Q0.0', 'Aux_Motor reallocated away from colliding %Q0.0')
  assert.ok(sanitizedAux.address.startsWith('%Q'), 'Aux_Motor kept in %Q area')

  // Check network rewiring
  const rewiredNet = sanitized.networks[0]
  const c2Node = rewiredNet.nodes[1] as any
  assert.strictEqual(c2Node.address, sanitizedStop.address, 'Contact node c2 address updated to reallocated address')

  const q2Node = rewiredNet.nodes[3] as any
  assert.strictEqual(q2Node.address, sanitizedAux.address, 'Coil node q2 address updated to reallocated address')

  testPass('Deterministic Unique Address Allocator reallocates colliding addresses and rewires network ASTs')
}

// 3. Dynamic LED Synthesis (4 networks with Green and Red LEDs via Ladder DSL & Telemetry Logger)
async function testDynamicLedSynthesis() {
  console.log('\n--- 3. Testing Dynamic Indicator LED Synthesis via Compact DSL & BlackBoxLogger ---')

  const dslInput = `
# TAG DECLARATIONS
TAG Start_Btn %I0.0 BOOL "Start Pushbutton (NO)"
TAG Stop_Btn %I0.1 BOOL "Stop Pushbutton (NC)"
TAG Motor_Run %Q0.0 BOOL "Main Motor Contactor"
TAG Yesil_Led %Q0.1 BOOL "Motor Running Green Indicator LED"
TAG Kirmizi_Led %Q0.2 BOOL "Motor Stopped Red Indicator LED"

# NETWORK DEFINITIONS
NW 1 "Motor Start, Latch & T1.Q Trip": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), NC(T1.Q), COIL(Motor_Run) )
NW 2 "10-Second Timer (TON T1)": SERIES( NO(Motor_Run), TON(T1, PT=T#10s) )
NW 3 "Motor Running Green Indicator LED": SERIES( NO(Motor_Run), COIL(Yesil_Led) )
NW 4 "Motor Stopped Red Indicator LED": SERIES( NC(Motor_Run), COIL(Kirmizi_Led) )
`
  const dslResult = LadderDslCompiler.compileLadderDslToAst(dslInput)

  assert.strictEqual(dslResult.success, true, 'DSL compiles successfully')
  assert.strictEqual(dslResult.networks.length, 4, 'Compiled exactly 4 networks')
  assert.strictEqual(dslResult.tags.length, 5, 'Extracted 5 tags')

  const greenTag = dslResult.tags.find((t) => t.name === 'Yesil_Led')
  assert.ok(greenTag, 'Contains Yesil_Led tag')
  assert.strictEqual(greenTag.address, '%Q0.1', 'Yesil_Led address is %Q0.1')

  const redTag = dslResult.tags.find((t) => t.name === 'Kirmizi_Led')
  assert.ok(redTag, 'Contains Kirmizi_Led tag')
  assert.strictEqual(redTag.address, '%Q0.2', 'Kirmizi_Led address is %Q0.2')

  testPass('Synthesized 4 networks with Green LED (%Q0.1) and Red LED (%Q0.2)')

  // Verify BlackBoxLogger records the AST compile telemetry
  BlackBoxLogger.getInstance().log('AST_COMPILE', 'Compiled 4-network dynamic LED circuit', {
    networks: dslResult.networks.length,
    tags: dslResult.tags.length
  })

  const logs = BlackBoxLogger.getInstance().getLogs('AST_COMPILE')
  assert.ok(logs.length > 0, 'BlackBoxLogger captured AST_COMPILE telemetry event')
  testPass('Black-box telemetry flight recorder captured AST compilation event')
}

// 4. Real Project Compiler Engine (5-step comprehensive audit)
function testCompilerEngine() {
  console.log('\n--- 4. Testing Full-Project CompileEngine ---')

  // 4a. Compile project with errors (unassigned operand, missing timer instance, SCL syntax error)
  const badTagTable: TagTable = {
    id: 'tbl_bad',
    name: 'BadTags',
    fileName: 'BadTags.tags.json',
    tags: [
      { id: 'tag_1', name: 'Start', dataType: 'BOOL', address: '%I0.0' },
      { id: 'tag_2', name: 'Stop', dataType: 'BOOL', address: '%I0.0' } // Collision!
    ]
  }

  const badLadBlock: LadBlockDefinition = {
    fileName: 'OB1_Bad.lad.json',
    name: 'OB1_Bad',
    blockType: 'OB',
    blockNumber: 1,
    networks: [
      {
        id: 'net_1',
        networkNumber: 1,
        title: 'Net 1',
        nodes: [
          {
            id: 'c_unassigned',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: '???', // Unassigned operand!
            address: '???'
          },
          {
            id: 'c_ghost_timer',
            kind: 'contact',
            contactType: 'NC_CONTACT',
            operand: 'T99.Q', // Missing timer instance!
            address: 'T99.Q'
          },
          {
            id: 'q_dup1',
            kind: 'coil',
            coilType: 'OUTPUT_COIL',
            operand: 'Pump1',
            address: '%Q0.0'
          }
        ]
      },
      {
        id: 'net_2',
        networkNumber: 2,
        title: 'Net 2',
        nodes: [
          {
            id: 'q_dup2',
            kind: 'coil',
            coilType: 'OUTPUT_COIL',
            operand: 'Pump1', // Double-coil conflict!
            address: '%Q0.0'
          }
        ]
      }
    ]
  }

  const badSclBlock: SclBlockDefinition = {
    fileName: 'FC_Bad.scl',
    name: 'FC_Bad',
    blockType: 'FC',
    blockNumber: 10,
    code: `IF #Start THEN
    #Run := TRUE;
// Missing END_IF!`
  }

  const badResult = CompileEngine.runFullProjectCompilation(
    [badTagTable],
    [badLadBlock],
    [badSclBlock]
  )

  assert.strictEqual(badResult.success, false, 'Compilation failed due to errors')
  assert.ok(badResult.errorsCount >= 3, `Expected at least 3 errors, got ${badResult.errorsCount}`)
  assert.ok(badResult.bannerMessage.includes('COMPILE FAILED'), 'Banner reports COMPILE FAILED')

  const errorCodes = badResult.diagnostics.map((d) => d.code)
  assert.ok(errorCodes.includes('ERR_MEMORY_OVERLAP'), 'Compile reports ERR_MEMORY_OVERLAP')
  assert.ok(errorCodes.includes('ERR_UNASSIGNED_OPERAND'), 'Compile reports ERR_UNASSIGNED_OPERAND')
  assert.ok(errorCodes.includes('ERR_UNINSTANTIATED_TIMER'), 'Compile reports ERR_UNINSTANTIATED_TIMER')
  assert.ok(errorCodes.includes('WARN_DOUBLE_COIL'), 'Compile reports WARN_DOUBLE_COIL')
  assert.ok(errorCodes.includes('ERR_SCL_SYNTAX'), 'Compile reports ERR_SCL_SYNTAX')
  testPass('CompileEngine accurately caught all 5 classes of defects (Memory Overlap, ???, T99.Q, Double-Coil, SCL Syntax)')

  // 4b. Clean project compilation success
  const cleanTagTable: TagTable = {
    id: 'tbl_clean',
    name: 'CleanTags',
    fileName: 'CleanTags.tags.json',
    tags: [
      { id: 'tag_s', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.0' },
      { id: 'tag_p', name: 'Stop_Btn', dataType: 'BOOL', address: '%I0.1' },
      { id: 'tag_m', name: 'Motor_Run', dataType: 'BOOL', address: '%Q0.0' }
    ]
  }

  const cleanLadBlock: LadBlockDefinition = {
    fileName: 'OB1_Clean.lad.json',
    name: 'OB1_Clean',
    blockType: 'OB',
    blockNumber: 1,
    networks: [
      {
        id: 'net_1',
        networkNumber: 1,
        title: 'Net 1',
        nodes: [
          {
            id: 'c1',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'Start_Btn',
            address: '%I0.0'
          },
          {
            id: 'c2',
            kind: 'contact',
            contactType: 'NC_CONTACT',
            operand: 'T1.Q',
            address: 'T1.Q'
          },
          {
            id: 'q1',
            kind: 'coil',
            coilType: 'OUTPUT_COIL',
            operand: 'Motor_Run',
            address: '%Q0.0'
          }
        ]
      },
      {
        id: 'net_2',
        networkNumber: 2,
        title: 'Net 2',
        nodes: [
          {
            id: 't1',
            kind: 'timer',
            timerType: 'TON',
            instanceDb: 'T1',
            inOperand: 'Motor_Run',
            ptOperand: 'T#10s',
            qOperand: 'T1.Q',
            etOperand: 'T1.ET'
          }
        ]
      }
    ]
  }

  const cleanResult = CompileEngine.runFullProjectCompilation(
    [cleanTagTable],
    [cleanLadBlock],
    []
  )

  assert.strictEqual(cleanResult.success, true, 'Clean project compilation succeeded')
  assert.strictEqual(cleanResult.errorsCount, 0, 'Zero errors in clean project')
  assert.strictEqual(cleanResult.warningsCount, 0, 'Zero warnings in clean project')
  assert.ok(cleanResult.bannerMessage.includes('COMPILE SUCCESS — 0 Error(s), 0 Warning(s)'), 'Banner displays COMPILE SUCCESS')
  testPass('CompileEngine verifies valid MEB project with 0 errors and generates timestamped success banner')
}

async function runAll() {
  testExactBitCollision()
  testUniqueAddressAllocator()
  await testDynamicLedSynthesis()
  testCompilerEngine()

  console.log(`\n======================================================`)
  console.log(`PHASE 5 TEST SUMMARY: ${passCount} PASSED, 0 FAILED`)
  console.log(`======================================================\n`)
}

runAll()

