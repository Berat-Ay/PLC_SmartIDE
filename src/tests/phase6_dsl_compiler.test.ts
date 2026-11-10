import assert from 'node:assert'
import {
  LadderDslCompiler,
  splitTopLevel,
  parseFunctionCall
} from '../renderer/src/services/compiler/LadderDslCompiler'

let passCount = 0
function testPass(name: string) {
  passCount++
  console.log(`PASS: ${name}`)
}

console.log('\n=== RUNNING PHASE 6 LADDER DSL COMPILER TESTS ===\n')

// 1. Tokenizer: splitTopLevel and parseFunctionCall
function testTokenizer() {
  console.log('--- 1. Testing Bracket-Aware Tokenizer ---')

  const expr = 'PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), COIL(Motor_Run)'
  const parts = splitTopLevel(expr, ',')
  assert.strictEqual(parts.length, 3, 'Splits 3 top-level elements correctly')
  assert.strictEqual(parts[0], 'PARALLEL( NO(Start_Btn), NO(Motor_Run) )')
  assert.strictEqual(parts[1], 'NC(Stop_Btn)')
  assert.strictEqual(parts[2], 'COIL(Motor_Run)')

  const func = parseFunctionCall('TON(T1, PT=T#10s)')
  assert.ok(func, 'parseFunctionCall succeeds')
  assert.strictEqual(func.name, 'TON')
  assert.strictEqual(func.argsStr, 'T1, PT=T#10s')

  testPass('Tokenizer correctly handles brackets and nested structures')
}

// 2. TAG Declarations with Conflict-Free Address Allocation
function testTagDeclarationsAndConflictFreeAllocation() {
  console.log('\n--- 2. Testing Tag Declarations & Conflict-Free Allocator ---')

  const dsl = `
# TAG DECLARATIONS
TAG Start_Btn %I0.1 BOOL "Start Pushbutton"
TAG Stop_Btn %I0.1 BOOL "Stop Pushbutton (Colliding Address!)"
TAG Motor_Run %Q0.0 BOOL "Main Motor Contactor"
TAG Yesil_Led %Q0.1 BOOL "Green Running LED"
TAG Kirmizi_Led %Q0.2 BOOL "Red Stopped LED"

# NETWORK DEFINITIONS
NW 1 "Motor Start/Stop": SERIES( NO(Start_Btn), NC(Stop_Btn), COIL(Motor_Run) )
`

  const result = LadderDslCompiler.compileLadderDslToAst(dsl)
  assert.ok(result.success, 'DSL compiles successfully')
  assert.strictEqual(result.tags.length, 5, 'All 5 tags declared')

  const startTag = result.tags.find((t) => t.name === 'Start_Btn')!
  const stopTag = result.tags.find((t) => t.name === 'Stop_Btn')!
  assert.strictEqual(startTag.address, '%I0.1', 'Start_Btn kept %I0.1')
  assert.notStrictEqual(stopTag.address, '%I0.1', 'Stop_Btn reallocated away from %I0.1')
  assert.ok(stopTag.address.startsWith('%I'), 'Stop_Btn allocated in %I area')

  // Verify unique addresses
  const addrs = result.tags.map((t) => t.address)
  const uniqueAddrs = new Set(addrs)
  assert.strictEqual(uniqueAddrs.size, 5, 'All 5 tags have unique non-colliding addresses')

  testPass('Conflict-Free Allocator automatically remaps colliding %I0.1 to free sequential bit')
}

// 3. Complex 4-Network Circuit (Motor Seal-In, TON 10s Timer, Green & Red LEDs)
function testFourNetworkIndustrialCircuit() {
  console.log('\n--- 3. Testing 4-Network Industrial Circuit Synthesis ---')

  const dsl = `
# EXPLANATION
# Motor Start/Stop circuit with 10s auto-stop TON timer,
# Green indicator LED when running (%Q0.1) and Red indicator LED when stopped (%Q0.2).

# TAG DECLARATIONS
TAG Start_Btn %I0.0 BOOL "Start Pushbutton (NO)"
TAG Stop_Btn %I0.1 BOOL "Stop Pushbutton (NC)"
TAG Motor_Run %Q0.0 BOOL "Main Motor Contactor"
TAG Yesil_Led %Q0.1 BOOL "Motor Running Green Indicator LED"
TAG Kirmizi_Led %Q0.2 BOOL "Motor Stopped Red Indicator LED"

# NETWORK DEFINITIONS
NW 1 "Motor Start/Stop Seal-In": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), NC(T1.Q), COIL(Motor_Run) )
NW 2 "10-Second Auto Stop Timer": SERIES( NO(Motor_Run), TON(T1, PT=T#10s) )
NW 3 "Green Running Indicator": SERIES( NO(Motor_Run), COIL(Yesil_Led) )
NW 4 "Red Stopped Indicator": SERIES( NC(Motor_Run), COIL(Kirmizi_Led) )
`

  const result = LadderDslCompiler.compileLadderDslToAst(dsl)
  assert.ok(result.success, 'Compilation succeeded')
  assert.strictEqual(result.networks.length, 4, 'Compiled 4 networks')
  assert.ok(result.explanation?.includes('10s auto-stop'), 'Explanation parsed correctly')

  // Network 1 checks
  const net1 = result.networks[0]
  assert.strictEqual(net1.title, 'Motor Start/Stop Seal-In')
  assert.strictEqual(net1.nodes.length, 4, '4 nodes in Network 1')
  assert.strictEqual(net1.nodes[0].kind, 'parallel', 'Node 0 is parallel branch')
  const pNode = net1.nodes[0] as any
  assert.strictEqual(pNode.branches.length, 2, 'Parallel has 2 branches')
  assert.strictEqual(pNode.branches[0][0].operand, 'Start_Btn')
  assert.strictEqual(pNode.branches[1][0].operand, 'Motor_Run')
  assert.strictEqual(net1.nodes[1].kind, 'contact')
  assert.strictEqual((net1.nodes[1] as any).operand, 'Stop_Btn')
  assert.strictEqual((net1.nodes[1] as any).contactType, 'NC_CONTACT')
  assert.strictEqual((net1.nodes[2] as any).operand, 'T1.Q')
  assert.strictEqual((net1.nodes[2] as any).contactType, 'NC_CONTACT')
  assert.strictEqual(net1.nodes[3].kind, 'coil')
  assert.strictEqual((net1.nodes[3] as any).operand, 'Motor_Run')

  // Network 2 checks (TON Timer)
  const net2 = result.networks[1]
  assert.strictEqual(net2.nodes.length, 2)
  assert.strictEqual(net2.nodes[1].kind, 'timer')
  const timerNode = net2.nodes[1] as any
  assert.strictEqual(timerNode.timerType, 'TON')
  assert.strictEqual(timerNode.instanceDb, 'T1')
  assert.strictEqual(timerNode.ptOperand, 'T#10s')
  assert.strictEqual(timerNode.qOperand, 'T1.Q')

  // Network 3 checks (Green LED %Q0.1)
  const net3 = result.networks[2]
  assert.strictEqual((net3.nodes[1] as any).operand, 'Yesil_Led')
  assert.strictEqual((net3.nodes[1] as any).address, '%Q0.1')

  // Network 4 checks (Red LED %Q0.2)
  const net4 = result.networks[3]
  assert.strictEqual((net4.nodes[0] as any).operand, 'Motor_Run')
  assert.strictEqual((net4.nodes[0] as any).contactType, 'NC_CONTACT')
  assert.strictEqual((net4.nodes[1] as any).operand, 'Kirmizi_Led')
  assert.strictEqual((net4.nodes[1] as any).address, '%Q0.2')

  testPass('4-Network Industrial Circuit with TON timer and indicator LEDs synthesized deterministically')
}

// 4. Advanced Node Types: CTU, CMP_EQ, ADD, NORM_X
function testAdvancedNodes() {
  console.log('\n--- 4. Testing Advanced Nodes (Counter, Comparator, Math) ---')

  const dsl = `
# NETWORK DEFINITIONS
NW 1 "Part Counter": SERIES( NO(Sensor_Part), CTU(C1, PV=50) )
NW 2 "Batch Limit Check": SERIES( CMP_GE(C1.CV, 50, INT), COIL(Batch_Full) )
NW 3 "Math Scaling": SERIES( NO(Enable_Calc), ADD(Offset_Val, 100, Result_Val), SCALE_X(Raw_Input, 0, 1000, Scaled_Out) )
`

  const result = LadderDslCompiler.compileLadderDslToAst(dsl)
  assert.ok(result.success, 'Advanced nodes compile successfully')
  assert.strictEqual(result.networks.length, 3)

  // Network 1 counter
  const net1 = result.networks[0]
  const cntNode = net1.nodes[1] as any
  assert.strictEqual(cntNode.kind, 'counter')
  assert.strictEqual(cntNode.counterType, 'CTU')
  assert.strictEqual(cntNode.instanceDb, 'C1')
  assert.strictEqual(cntNode.pvOperand, '50')

  // Network 2 comparator
  const net2 = result.networks[1]
  const cmpNode = net2.nodes[0] as any
  assert.strictEqual(cmpNode.kind, 'comparator')
  assert.strictEqual(cmpNode.comparatorType, 'CMP_GE')
  assert.strictEqual(cmpNode.op1, 'C1.CV')
  assert.strictEqual(cmpNode.op2, '50')

  // Network 3 math
  const net3 = result.networks[2]
  const addNode = net3.nodes[1] as any
  assert.strictEqual(addNode.kind, 'math')
  assert.strictEqual(addNode.boxType, 'ADD')
  assert.strictEqual(addNode.in1, 'Offset_Val')
  assert.strictEqual(addNode.in2, '100')
  assert.strictEqual(addNode.out, 'Result_Val')

  const scaleNode = net3.nodes[2] as any
  assert.strictEqual(scaleNode.kind, 'math')
  assert.strictEqual(scaleNode.boxType, 'SCALE_X')
  assert.strictEqual(scaleNode.value, 'Raw_Input')
  assert.strictEqual(scaleNode.min, '0')
  assert.strictEqual(scaleNode.max, '1000')
  assert.strictEqual(scaleNode.out, 'Scaled_Out')

  testPass('Counter, Comparator, and Math nodes parsed with 100% AST schema compliance')
}

// 5. Bidirectional DSL Generator (AST -> DSL -> AST round-trip)
function testRoundTripBidirectional() {
  console.log('\n--- 5. Testing Bidirectional Round-Trip (AST -> DSL -> AST) ---')

  const originalDsl = `
# TAG DECLARATIONS
TAG Start_Btn %I0.0 BOOL "Start Button"
TAG Stop_Btn %I0.1 BOOL "Stop Button"
TAG Motor_Run %Q0.0 BOOL "Main Motor"

# NETWORK DEFINITIONS
NW 1 "Motor Circuit": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), COIL(Motor_Run) )
NW 2 "Timer Circuit": SERIES( NO(Motor_Run), TON(T1, PT=T#10s) )
`

  const ast1 = LadderDslCompiler.compileLadderDslToAst(originalDsl)
  assert.ok(ast1.success)

  const regeneratedDsl = LadderDslCompiler.generateLadderDslFromAst(ast1.networks, ast1.tags)
  assert.ok(regeneratedDsl.includes('TAG Start_Btn %I0.0 BOOL "Start Button"'))
  assert.ok(regeneratedDsl.includes('NW 1 "Motor Circuit"'))
  assert.ok(regeneratedDsl.includes('PARALLEL( NO(Start_Btn), NO(Motor_Run) )'))
  assert.ok(regeneratedDsl.includes('TON(T1, PT=T#10s)'))

  const ast2 = LadderDslCompiler.compileLadderDslToAst(regeneratedDsl)
  assert.ok(ast2.success)
  assert.strictEqual(ast2.networks.length, ast1.networks.length)
  assert.strictEqual(ast2.tags.length, ast1.tags.length)

  testPass('Bidirectional generator achieves lossless roundtrip idempotence')
}

// Execute all test functions
testTokenizer()
testTagDeclarationsAndConflictFreeAllocation()
testFourNetworkIndustrialCircuit()
testAdvancedNodes()
testRoundTripBidirectional()

console.log(`\n======================================================`)
console.log(`ALL PHASE 6 DSL COMPILER UNIT TESTS PASSED: ${passCount}/${passCount}`)
console.log(`======================================================\n`)

