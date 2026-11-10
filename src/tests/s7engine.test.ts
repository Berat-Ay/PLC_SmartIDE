import { parseS7Address, getOccupiedCoordinates } from '../shared/constants/s7rules'
import { MemoryOverlapEngine } from '../renderer/src/services/MemoryOverlapEngine'
import { S7OffsetCalculator } from '../renderer/src/services/S7OffsetCalculator'
import { CrossReferenceEngine } from '../renderer/src/services/CrossReferenceEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { TagTable } from '../shared/types/tags'
import { UdtDefinition } from '../shared/types/types'

console.log('=== RUNNING SIEMENS S7 INDUSTRIAL IDE ENGINE TESTS ===\n')

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

// 1. S7 Address Parsing & Bit Coordinates
console.log('--- 1. Testing Siemens S7 Address Parsing & Occupancy ---')
const parsedBit = parseS7Address('%M11.4')
assert(parsedBit.isValid && parsedBit.byteAddress === 11 && parsedBit.bitAddress === 4, 'Parse %M11.4')
const bitCoords = getOccupiedCoordinates(parsedBit)
assert(bitCoords.length === 1 && bitCoords[0].byte === 11 && bitCoords[0].bit === 4, 'Bit coordinates for %M11.4')

const parsedWord = parseS7Address('%MW10')
assert(parsedWord.isValid && parsedWord.sizeCategory === 'WORD' && parsedWord.occupiedBytes.length === 2, 'Parse %MW10')
assert(parsedWord.occupiedBytes[0] === 10 && parsedWord.occupiedBytes[1] === 11, '%MW10 occupies MB10 and MB11')
const wordCoords = getOccupiedCoordinates(parsedWord)
assert(wordCoords.length === 16, '%MW10 expands to 16 bits (8 in Byte 10, 8 in Byte 11)')

const parsedDWord = parseS7Address('%MD20')
assert(parsedDWord.isValid && parsedDWord.occupiedBytes.length === 4, 'Parse %MD20 (4 bytes: 20..23)')

// 2. Memory Overlap Guard & Collision Detection
console.log('\n--- 2. Testing Memory Overlap Guard & Collision Analysis ---')
const testTagTable: TagTable = {
  id: 'table_test',
  name: 'test_table',
  fileName: 'test.tags.json',
  tags: [
    { id: 't_speed', name: 'Motor_Speed', dataType: 'INT', address: '%MW10' },
    { id: 't_alarm', name: 'Alarm_Silenced', dataType: 'BOOL', address: '%M11.2' },
    { id: 't_safe', name: 'Pump_Run', dataType: 'BOOL', address: '%M14.0' }
  ]
}

const analysis = MemoryOverlapEngine.analyzeCollisions([testTagTable])
assert(analysis.totalCollisionCount === 2, 'Detects collision between %MW10 and %M11.2')
const speedCollision = analysis.collisions.get('t_speed')
assert(!!speedCollision, 'Motor_Speed (%MW10) is flagged with collision')
assert(
  speedCollision?.conflictsWith.some((c) => c.name === 'Alarm_Silenced' && c.overlapArea === '%M11.2'),
  '%MW10 explicitly conflicts with %M11.2 at byte 11 bit 2'
)

// Test Auto-Assign Safe Address
console.log('\n--- 3. Testing 1-Click Auto-Assign Safe Address ---')
const nextSafeWord = MemoryOverlapEngine.findNextSafeAddress('M', 'INT', [testTagTable], undefined, 't_speed')
assert(nextSafeWord !== '%MW10', 'Reassigned safe address differs from conflicting %MW10')
const parsedSafe = parseS7Address(nextSafeWord)
assert(parsedSafe.byteAddress % 2 === 0, 'Safe word address respects even-byte alignment (e.g. MW0, MW2, MW12)')

// 3. Siemens S7 Standard Access (Non-Optimized) Offset Calculator
console.log('\n--- 4. Testing S7 Standard Access Offset Calculator ---')
const udtPump: UdtDefinition = {
  id: 'udt_1',
  name: 'UDT_Pump',
  fileName: 'UDT_Pump.udt.json',
  members: [
    { id: 'm1', name: 'StartCmd', dataType: 'BOOL' },
    { id: 'm2', name: 'StopCmd', dataType: 'BOOL' },
    { id: 'm3', name: 'Fault', dataType: 'BOOL' },
    { id: 'm4', name: 'PressureBar', dataType: 'REAL' }, // Must word-align to even boundary
    { id: 'm5', name: 'SpeedRaw', dataType: 'INT' }       // Must word-align to even boundary
  ]
}

const udtMap = new Map([[udtPump.name, udtPump]])
const calculatedVars = S7OffsetCalculator.calculateVariableOffsets(
  udtPump.members.map((m) => ({
    id: m.id,
    name: m.name,
    dataType: m.dataType,
    retain: false,
    accessibleFromHMI: true
  })),
  udtMap
)

assert(calculatedVars[0].calculatedOffset === '0.0', 'StartCmd (BOOL) is at 0.0')
assert(calculatedVars[1].calculatedOffset === '0.1', 'StopCmd (BOOL) packs into 0.1')
assert(calculatedVars[2].calculatedOffset === '0.2', 'Fault (BOOL) packs into 0.2')
assert(calculatedVars[3].calculatedOffset === '2.0', 'PressureBar (REAL) pads remaining bits in byte 0 and aligns to 2.0')
assert(calculatedVars[4].calculatedOffset === '6.0', 'SpeedRaw (INT) starts at 6.0 (2.0 + 4 bytes REAL)')

const udtByteSize = S7OffsetCalculator.calculateUdtSize(udtPump, udtMap)
assert(udtByteSize === 8, 'Total UDT_Pump size is 8 bytes (6.0 + 2 bytes INT = 8 bytes)')

// 4. Default Demo Project Seeder & Cross-Reference Indexer
console.log('\n--- 5. Testing Demo Project Seeding & Instant 0ms Cross-Reference ---')
const demo = DemoProjectSeeder.createDemoProject()
assert(demo.tagTables.length > 0, 'Demo tag tables seeded')
assert(demo.udts.length > 0, 'Demo UDTs seeded')
assert(demo.dataBlocks.length > 0, 'Demo DBs seeded')
assert(demo.ladBlocks.length > 0, 'Demo LAD blocks seeded')
assert(demo.sclBlocks.length > 0, 'Demo SCL blocks seeded')

CrossReferenceEngine.rebuildIndex({
  cpuConfig: demo.hardware,
  tagTables: demo.tagTables,
  udts: demo.udts,
  dataBlocks: demo.dataBlocks,
  ladBlocks: demo.ladBlocks,
  sclBlocks: demo.sclBlocks
})

const eStopRefs = CrossReferenceEngine.query('EmergencyStop')
assert(eStopRefs.totalCount >= 2, 'EmergencyStop found in Tag Table (Decl) and OB1_Main (Read)')
const eStopHasDecl = eStopRefs.references.some((r) => r.accessType === 'Declaration')
const eStopHasRead = eStopRefs.references.some((r) => r.accessType === 'Read' && r.sourceObject === 'OB1_Main')
assert(eStopHasDecl && eStopHasRead, 'EmergencyStop correctly indexed with Declaration and LAD Contact Read')

const pumpTypeRefs = CrossReferenceEngine.query('UDT_Pump')
assert(pumpTypeRefs.totalCount >= 2, 'UDT_Pump found in UDT Decl and DB1_PlantData variable references')

console.log(`\n======================================================`)
console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`)
console.log(`======================================================\n`)

if (failed > 0) {
  process.exit(1)
} else {
  process.exit(0)
}
