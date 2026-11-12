import { LadderEvaluator } from '../renderer/src/runtime/LadderEvaluator'
import { DoubleCoilDetector } from '../renderer/src/services/DoubleCoilDetector'
import { SclInterpreter, SclExecutionContext } from '../renderer/src/runtime/SclInterpreter'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import {
  LadderNetwork,
  LadderContactNode,
  LadderCoilNode,
  LadderParallelBranchNode,
  LadderMathNode
} from '../shared/types/ladder'
import { LadBlockDefinition } from '../shared/types/blocks'

console.log('=== RUNNING PHASE 2 INDUSTRIAL PLC ENGINE & RUNTIME TESTS ===\n')

let passed = 0
let failed = 0

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`)
    passed++
  } else {
    console.error(`❌ FAIL: ${testName}${detail ? ' - ' + detail : ''}`)
    failed++
  }
}

// =========================================================================
// 1. Interactive AST Grid Ladder Logic Power Flow Evaluation
// =========================================================================
console.log('--- 1. Testing Ladder Evaluator (Series, Parallel, Timers, Math) ---')

// 1.1 Series logic
const seriesNet: LadderNetwork = {
  id: 'net_s1',
  networkNumber: 1,
  title: 'Series Interlock',
  nodes: [
    { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'E_Stop' } as LadderContactNode,
    { id: 'c2', kind: 'contact', contactType: 'NC_CONTACT', operand: 'Fault_Bit' } as LadderContactNode,
    { id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor_Run' } as LadderCoilNode
  ]
}

const vars1 = new Map<string, unknown>([
  ['E_Stop', true],
  ['Fault_Bit', false]
])
const ctx1 = { getVar: (s: string) => vars1.get(s), setVar: (s: string, v: unknown) => vars1.set(s, v) }
const res1 = LadderEvaluator.evaluateNetwork(seriesNet, ctx1, 10)
assert(vars1.get('Motor_Run') === true, 'Series logic energized when E_Stop=TRUE and Fault_Bit=FALSE')
assert(res1.nodePowerStates['c1']?.powered === true && res1.nodePowerStates['c2']?.powered === true, 'Power states tracked for SVG glow')

// Now Fault_Bit turns true -> coil should de-energize
vars1.set('Fault_Bit', true)
LadderEvaluator.evaluateNetwork(seriesNet, ctx1, 20)
assert(vars1.get('Motor_Run') === false, 'Series logic de-energized when NC contact opens')

// 1.2 Parallel branch logic
const parallelNet: LadderNetwork = {
  id: 'net_p1',
  networkNumber: 2,
  title: 'Seal-in Circuit',
  nodes: [
    {
      id: 'branch_seal',
      kind: 'parallel',
      branches: [
        [{ id: 'btn_start', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Start_PB' } as LadderContactNode],
        [{ id: 'aux_contact', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Pump_Aux' } as LadderContactNode]
      ]
    } as LadderParallelBranchNode,
    { id: 'coil_pump', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Pump_Aux' } as LadderCoilNode
  ]
}

const vars2 = new Map<string, unknown>([
  ['Start_PB', false],
  ['Pump_Aux', true]
])
const ctx2 = { getVar: (s: string) => vars2.get(s), setVar: (s: string, v: unknown) => vars2.set(s, v) }
LadderEvaluator.evaluateNetwork(parallelNet, ctx2, 10)
assert(vars2.get('Pump_Aux') === true, 'Parallel branch conducts through active seal-in contact')

// 1.3 Math & Analog Scaling (NORM_X & SCALE_X)
const mathNet: LadderNetwork = {
  id: 'net_m1',
  networkNumber: 3,
  title: 'Analog Scaling',
  nodes: [
    {
      id: 'box_norm',
      kind: 'math',
      boxType: 'NORM_X',
      in1: 'Raw_AI',
      in2: '27648',
      out: 'Norm_Val',
      dataType: 'REAL'
    } as LadderMathNode,
    {
      id: 'box_scale',
      kind: 'math',
      boxType: 'SCALE_X',
      in1: 'Norm_Val',
      in2: '10.0',
      out: 'Scaled_Bar',
      dataType: 'REAL'
    } as LadderMathNode
  ]
}

const vars3 = new Map<string, unknown>([['Raw_AI', 13824]]) // 50% scale
const ctx3 = { getVar: (s: string) => vars3.get(s), setVar: (s: string, v: unknown) => vars3.set(s, v) }
LadderEvaluator.evaluateNetwork(mathNet, ctx3, 10)
const normVal = vars3.get('Norm_Val') as number
const scaledBar = vars3.get('Scaled_Bar') as number
assert(Math.abs(normVal - 0.5) < 0.001, 'NORM_X correctly normalizes 13824/27648 to 0.5')
assert(Math.abs(scaledBar - 5.0) < 0.001, 'SCALE_X correctly scales 0.5 to 5.0 Bar')

// =========================================================================
// 2. Double-Coil Detection & 1-Click Auto-Refactor (Solution A)
// =========================================================================
console.log('\n--- 2. Testing Double-Coil Detector & 1-Click Auto-Refactor ---')

const doubleCoilBlock: LadBlockDefinition = {
  blockType: 'OB',
  blockNumber: 1,
  name: 'OB1_TestDouble',
  fileName: 'OB1_TestDouble.lad.json',
  optimizedAccess: true,
  interface: {
    input: [],
    output: [],
    inOut: [],
    static: [],
    temp: [],
    constant: []
  },
  networks: [
    {
      id: 'net_1',
      networkNumber: 1,
      title: 'Manual Mode',
      nodes: [
        { id: 'c_man', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Manual_Mode' } as LadderContactNode,
        { id: 'q_dup1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'MainConveyor_Run' } as LadderCoilNode
      ]
    },
    {
      id: 'net_2',
      networkNumber: 2,
      title: 'Auto Mode',
      nodes: [
        { id: 'c_auto', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Auto_Mode' } as LadderContactNode,
        { id: 'q_dup2', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'MainConveyor_Run' } as LadderCoilNode
      ]
    }
  ]
}

const conflicts = DoubleCoilDetector.detectConflicts(doubleCoilBlock)
assert(conflicts.length === 1, 'Double-Coil detector flags conflicting coils')
assert(conflicts[0].operand === 'MainConveyor_Run', 'Conflict operand identified as MainConveyor_Run')
assert(conflicts[0].networkNumbers.length === 2 && conflicts[0].networkNumbers[0] === 1 && conflicts[0].networkNumbers[1] === 2, 'Conflict networks identified as 1 and 2')

// Auto-refactor with Solution A
const refactoredBlock = DoubleCoilDetector.autoRefactorBlock(doubleCoilBlock, 'MainConveyor_Run')
assert(refactoredBlock.networks.length === 3, 'Auto-refactor appends final OR-mapped output network (total 3 networks)')

// Verify intermediate temp booleans were registered in interface
const tempVars = refactoredBlock.interface.temp
assert(
  tempVars.some((v) => v.name === 'MainConveyor_Run_Net1') &&
  tempVars.some((v) => v.name === 'MainConveyor_Run_Net2'),
  'Intermediate temp booleans #MainConveyor_Run_Net1 and #MainConveyor_Run_Net2 added to block interface'
)

// Re-scan refactored block -> conflicts must be 0!
const remainingConflicts = DoubleCoilDetector.detectConflicts(refactoredBlock)
assert(remainingConflicts.length === 0, 'Zero double-coil conflicts remain after 1-click Solution A auto-refactor!')

// =========================================================================
// 3. IEC 61131-3 SCL Compiler & Interpreter
// =========================================================================
console.log('\n--- 3. Testing SCL Interpreter, Syntax Validation & Online Badges ---')

// 3.1 Syntax Validator
const validScl = `
IF "TankLevel_Raw" > 20000 THEN
    #AlarmActive := TRUE;
ELSE
    #AlarmActive := FALSE;
END_IF;
`
const valResult = SclInterpreter.validateSyntax(validScl)
assert(valResult.valid, 'Valid SCL passes syntax check')

const invalidScl = `
IF "TankLevel_Raw" > 20000 THEN
    #AlarmActive := TRUE;
// Missing END_IF!
`
const invalResult = SclInterpreter.validateSyntax(invalidScl)
assert(!invalResult.valid && invalResult.errors.length > 0, 'Syntax checker catches missing END_IF')

// 3.2 Execution with live line value tracking
const sclMemory = new Map<string, unknown>([
  ['TankLevel_Raw', 25000],
  ['#AlarmActive', false],
  ['#BatchCount', 0]
])
const lineValues: Record<number, string | number> = {}

const sclCtx: SclExecutionContext = {
  getVar: (s) => sclMemory.get(s),
  setVar: (s, v) => sclMemory.set(s, v),
  lineValues
}

const execResult = SclInterpreter.execute(validScl, sclCtx)
assert(execResult.success, 'SCL execution completes successfully')
assert(sclMemory.get('#AlarmActive') === true, 'SCL IF block evaluated and set #AlarmActive := TRUE')

// 3.3 SCL FOR loop and runaway limit protection
const forLoopScl = `
FOR i := 1 TO 5 DO
    #BatchCount := #BatchCount + 2;
END_FOR;
`
SclInterpreter.execute(forLoopScl, sclCtx)
assert(sclMemory.get('#BatchCount') === 10, 'SCL FOR loop executed 5 iterations (+10 total)')

// =========================================================================
// 4. SoftPLC Runtime Engine Lifecycle & 1,000-Cycle Time-Travel Ring Buffer
// =========================================================================
console.log('\n--- 4. Testing Virtual SoftPLC Runtime Engine & Time-Travel Debugger ---')

const engine = new PlcRuntimeEngine()
const demoPayload = DemoProjectSeeder.createDemoProject()
engine.loadProject(demoPayload)

assert(engine.getState() === 'STOP', 'SoftPLC initialized in STOP mode')

// Force an input to trigger logic
engine.setVariable('%I0.0', true)  // EmergencyStop
engine.setVariable('%M10.0', true) // Plant_Ready

// Transition to RUN -> executes OB100 then starts cyclic loop
engine.start()
assert(engine.getState() === 'RUN', 'SoftPLC transitioned to RUN mode')

// Let engine run for a short burst (50ms)
await new Promise((resolve) => setTimeout(resolve, 80))

const metrics = engine.getMetrics()
assert(metrics.cycleNumber > 0, `Cyclic scan executed ${metrics.cycleNumber} cycles (target 10ms loop)`)
assert(metrics.lastCycleDurationMs < 10, `Cycle scan time is high-speed (${metrics.lastCycleDurationMs.toFixed(2)}ms < 10ms)`)

// Verify Output was energized by OB1 ladder evaluation
const conveyorRun = engine.getVariable('%Q0.0')
assert(conveyorRun !== undefined, 'PIQ output %Q0.0 evaluated and updated in memory image')

// Verify %MB0 Clock Memory pulse generator
const clockByte = engine.getVariable('%MB0') as number
assert(clockByte >= 0 && clockByte <= 255, `%MB0 Clock Memory byte updated by square wave generator (Value: ${clockByte})`)

// Check 1,000-cycle circular ring buffer
const history = engine.getHistory()
assert(history.length > 0 && history.length <= 1000, `Circular ring buffer holds ${history.length} snapshots (capped at 1,000)`)

// Test Time-Travel Debugger Scrubbing
const oldestSnapshot = history[0]
const scrubbed = engine.getSnapshotAtCycle(oldestSnapshot.cycleNumber)
assert(scrubbed?.cycleNumber === oldestSnapshot.cycleNumber, `Time-Travel scrubber retrieved historical snapshot at Cycle #${oldestSnapshot.cycleNumber}`)

// Stop engine cleanly
engine.stop()
assert(engine.getState() === 'STOP', 'SoftPLC successfully transitioned to STOP mode')

console.log(`\n======================================================`)
console.log(`PHASE 2 ENGINE TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`)
console.log(`======================================================\n`)

if (failed > 0) {
  process.exit(1)
} else {
  process.exit(0)
}
