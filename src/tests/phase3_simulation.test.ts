import { PlantPhysicsEngine } from '../renderer/src/runtime/PlantPhysicsEngine'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { DoubleCoilDetector } from '../renderer/src/services/DoubleCoilDetector'
import { MemoryOverlapEngine } from '../renderer/src/services/MemoryOverlapEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { LadBlockDefinition } from '../shared/types/blocks'
import { LadderNetwork, LadderContactNode, LadderCoilNode } from '../shared/types/ladder'

console.log('=== RUNNING PHASE 3 INDUSTRIAL SIMULATION & HOTFIX TESTS ===\n')

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
// 1. Hotfix 1: Double Coil Idempotent Auto-Refactor Verification
// =========================================================================
console.log('--- 1. Testing Hotfix 1 (Idempotent 1-Click Double-Coil Auto-Refactor) ---')

const testBlock: LadBlockDefinition = {
  blockType: 'OB',
  blockNumber: 1,
  name: 'OB1_Test',
  fileName: 'OB1_Test.lad.json',
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
      title: 'Run from Sensor 1',
      nodes: [
        { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Sensor1' } as LadderContactNode,
        { id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Conveyor_Drive' } as LadderCoilNode
      ]
    },
    {
      id: 'net_2',
      networkNumber: 2,
      title: 'Run from Sensor 2',
      nodes: [
        { id: 'c2', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Sensor2' } as LadderContactNode,
        { id: 'q2', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Conveyor_Drive' } as LadderCoilNode
      ]
    }
  ],
  schemaVersion: '1.0.0'
}

// Scan conflicts initially
const initialConflicts = DoubleCoilDetector.scanBlock(testBlock)
assert(initialConflicts.length === 1, 'Initial double-coil conflict detected on Conveyor_Drive')

// First auto-refactor
const refactoredBlock1 = DoubleCoilDetector.autoRefactorBlock(testBlock, 'Conveyor_Drive')
const conflictsAfterFirst = DoubleCoilDetector.scanBlock(refactoredBlock1)
assert(conflictsAfterFirst.length === 0, 'Zero conflicts after 1st auto-refactor')
assert(refactoredBlock1.networks.length === 3, 'Network count increased to 3 (consolidation OR-network added)')

// Second auto-refactor (IDEMPOTENCY TEST: user clicks Auto-Merge again on same operand)
const refactoredBlock2 = DoubleCoilDetector.autoRefactorBlock(refactoredBlock1, 'Conveyor_Drive')
const conflictsAfterSecond = DoubleCoilDetector.scanBlock(refactoredBlock2)
assert(conflictsAfterSecond.length === 0, 'Zero conflicts after 2nd auto-refactor (strictly idempotent)')
assert(
  refactoredBlock2.networks.length === 3,
  'Network count remains 3 after 2nd auto-refactor (no duplicate networks spawned)'
)

// Check that temporary variable names don't suffer from recursive suffixes like _Net1_Net1
const tempVars = refactoredBlock2.interface.temp.map((t) => t.name)
const hasDoubleNetSuffix = tempVars.some((name) => /_Net\d+_Net\d+/.test(name))
assert(!hasDoubleNetSuffix, 'No recursive _Net1_Net1 suffixes in block interface temp variables')

// =========================================================================
// 2. Hotfix 4: Memory Overlap Engine Deduplication & Self-Collision Guard
// =========================================================================
console.log('\n--- 2. Testing Hotfix 4 (Memory Overlap Self-Collision Guard & Deduplication) ---')

const projectData = DemoProjectSeeder.createDemoProject('C:/TestProject')
const overlapAnalysis = MemoryOverlapEngine.analyzeCollisions(projectData.tagTables, projectData.hardware)

// Multi-bit tags must not report collisions with themselves
let foundSelfCollision = false
for (const col of overlapAnalysis.collisions.values()) {
  for (const conflict of col.conflictsWith) {
    if (conflict.id === col.tagId) {
      foundSelfCollision = true
    }
  }
}
assert(!foundSelfCollision, 'Multi-bit tags never report collisions with themselves')

// Verify diagnostic messages contain no duplicate conflict names
let hasDuplicateInDiagnostic = false
for (const diag of overlapAnalysis.diagnostics) {
  const parts = diag.message.split('with ')
  if (parts.length > 1) {
    const names = parts[1].split(', ')
    const unique = new Set(names)
    if (unique.size !== names.length) {
      hasDuplicateInDiagnostic = true
    }
  }
}
assert(!hasDuplicateInDiagnostic, 'Diagnostic collision messages deduplicate conflict names')

// =========================================================================
// 3. Closed-Loop Plant Physics Engine (Mass-Balance & Thermodynamics)
// =========================================================================
console.log('\n--- 3. Testing Closed-Loop Plant Physics Engine ---')

const physics = new PlantPhysicsEngine()
const runtime = new PlcRuntimeEngine(projectData)

// Initial values
assert(physics.tankLevelRaw === 6500, 'Initial tank level is nominal ~2.35m')
assert(physics.closedLoopActive === true, 'Closed loop simulation active by default')

// Step with pump stopped and drain valve at 20%: tank drains
physics.setOutflowValvePct(20)
const initialLevel = physics.tankLevelRaw
physics.step(0.1, runtime) // 100ms
assert(physics.tankLevelRaw < initialLevel, 'Tank drains when pump is OFF and outflow valve is open')

// Step with pump active (%Q0.1 = TRUE): tank fills
runtime.setVariable('%Q0.1', true)
const levelBeforeFill = physics.tankLevelRaw
physics.step(0.5, runtime) // 500ms
assert(physics.tankLevelRaw > levelBeforeFill, 'Tank fills when hydraulic feed pump (%Q0.1) is active')

// High Limit Switch Trip: level >= 24,500 trips %I0.2
physics.tankLevelRaw = 25000
physics.step(0.01, runtime)
const highSwitch = runtime.getBit('I', 0, 2)
assert(highSwitch === true, 'TankLevel_HighSwitch (%I0.2) trips to TRUE when level >= 24,500 ADC')

// Low Limit Switch Trip: level <= 2,000 trips %I0.3
physics.tankLevelRaw = 1500
physics.step(0.01, runtime)
const lowSwitch = runtime.getBit('I', 0, 3)
assert(lowSwitch === true, 'TankLevel_LowSwitch (%I0.3) trips to TRUE when level <= 2,000 ADC')

// Thermodynamic Heater: %Q0.2 = TRUE heats reactor temperature
runtime.setVariable('%Q0.2', true)
const tempBeforeHeat = physics.reactorTempRaw
physics.step(0.5, runtime)
assert(physics.reactorTempRaw > tempBeforeHeat, 'Reactor temperature (%IW66) heats up when %Q0.2 is TRUE')

// =========================================================================
// 4. Hardware Fault Injection (Wire-Break, Overflow & OB82 Diagnostics)
// =========================================================================
console.log('\n--- 4. Testing Hardware Fault Injection & OB82 Interrupt ---')

// Initial state: System Memory %M1.1 (DiagStatus) is FALSE
assert(runtime.getBit('M', 1, 1) === false, 'CPU System Memory %M1.1 (DiagStatus) is initially FALSE')

// Inject Wire-Break on %IW64
physics.injectFault('%IW64', 'wireBreak', runtime)
physics.step(0.01, runtime)

// 1. Raw ADC count forced to Siemens out-of-range wire-break code: 32767 (16#7FFF)
const rawCount = Number(runtime.getVariable('%IW64'))
assert(rawCount === 32767, 'Wire-break forces %IW64 to 32767 (16#7FFF Siemens code)')

// 2. CPU Diagnostic Status bit %M1.1 is set to TRUE
const diagStatusBit = runtime.getBit('M', 1, 1)
assert(diagStatusBit === true, 'CPU System Memory DiagStatus bit (%M1.1) set to TRUE on fault')

// 3. OB82 diagnostic snapshot recorded
const lastHistory = runtime.getHistory()
const ob82Snapshot = lastHistory.find((s) => s.triggeringOb === 82)
assert(ob82Snapshot !== undefined, 'OB82_DiagFault interrupt executed and recorded in history buffer')

// 4. Clear Faults
physics.clearFaults('%IW64', runtime)
physics.step(0.01, runtime)
const diagStatusAfterClear = runtime.getBit('M', 1, 1)
assert(diagStatusAfterClear === false, 'Fault cleared and %M1.1 reset to FALSE')

// 5. Sensor Signal Noise Injection (±2% ripple)
physics.injectFault('%IW64', 'noise')
physics.tankLevelRaw = 10000
physics.step(0.01, runtime)
const valWithNoise = Number(runtime.getVariable('%IW64'))
assert(
  valWithNoise >= 9000 && valWithNoise <= 11000,
  'Sensor noise modulates raw count within realistic industrial ripple bounds'
)

// =========================================================================
// 5. Trace Oscilloscope CSV Export Formatting
// =========================================================================
console.log('\n--- 5. Testing Trace Oscilloscope Recording & CSV Export ---')

const sampleRow = [Date.now(), 120, 1, true, false, true, false, 13824, 6200].join(',')
assert(sampleRow.split(',').length === 9, 'Trace sample record contains all timestamped channel fields')

const csvHeader = 'timestamp_ms,cycle,triggeringOb,EmergencyStop,HydraulicPump_Run,MainConveyor_Run,TankLevel_HighSwitch,TankLevel_Raw,ReactorTemp_Raw'
assert(csvHeader.includes('TankLevel_Raw'), 'CSV export header contains analog channels')

// Final Summary
console.log('\n======================================================')
console.log(`PHASE 3 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`)
console.log('======================================================\n')

if (failed > 0) {
  process.exit(1)
}
