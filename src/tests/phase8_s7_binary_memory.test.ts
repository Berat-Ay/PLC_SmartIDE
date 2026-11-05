import { S7BinaryMemory } from '../renderer/src/runtime/S7BinaryMemory'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { LadderEvaluator } from '../renderer/src/runtime/LadderEvaluator'

console.log('\n=== RUNNING PHASE 8 S7 BINARY MEMORY & SOFTPCL RUNTIME TESTS ===\n')

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`)
    process.exit(1)
  }
  console.log(`PASS: ${msg}`)
}

// -----------------------------------------------------------------------------
// Test 1: S7 Binary Memory Contiguous Buffer Operations
// -----------------------------------------------------------------------------
console.log('--- 1. Testing Contiguous Uint8Array Bit and Byte Operations ---')
const mem = new S7BinaryMemory()

// Bit Operations
mem.writeBit('I', 0, 0, true)
mem.writeBit('I', 0, 7, true)
assert(mem.readBit('I', 0, 0) === true, 'Bit I0.0 is true')
assert(mem.readBit('I', 0, 1) === false, 'Bit I0.1 is false')
assert(mem.readBit('I', 0, 7) === true, 'Bit I0.7 is true')
assert(mem.readByte('I', 0) === 0x81, 'Byte IB0 is 0x81 (129 decimal)')

// Byte, Word, Int (Big-Endian)
mem.writeByte('M', 10, 0xAB)
assert(mem.readByte('M', 10) === 0xAB, 'Byte MB10 is 0xAB')

mem.writeWord('M', 20, 0x1234)
assert(mem.readWord('M', 20) === 0x1234, 'Word MW20 is 0x1234')
assert(mem.readByte('M', 20) === 0x12, 'High byte MB20 is 0x12 (Big-Endian)')
assert(mem.readByte('M', 21) === 0x34, 'Low byte MB21 is 0x34 (Big-Endian)')

mem.writeInt('M', 30, -500)
assert(mem.readInt('M', 30) === -500, 'Int MW30 is -500')

// DWord, DInt, Real (IEEE 754 Big-Endian)
mem.writeDWord('Q', 0, 0xDEADBEEF)
assert(mem.readDWord('Q', 0) === 0xDEADBEEF, 'DWord QD0 is 0xDEADBEEF')

mem.writeDInt('M', 40, -12345678)
assert(mem.readDInt('M', 40) === -12345678, 'DInt MD40 is -12345678')

mem.writeReal('M', 50, 42.5)
const readRealVal = mem.readReal('M', 50)
assert(Math.abs(readRealVal - 42.5) < 0.001, 'Real MD50 is 42.5')

// -----------------------------------------------------------------------------
// Test 2: Address Resolution and German Syntax Normalization
// -----------------------------------------------------------------------------
console.log('\n--- 2. Testing Address Resolution & German Syntax Normalization ---')
const resE = mem.resolveAddress('%E0.0')
assert(resE !== null && resE.area === 'I' && resE.byteOffset === 0 && resE.bitOffset === 0, 'German %E0.0 resolves to area I')

const resA = mem.resolveAddress('%A4.2')
assert(resA !== null && resA.area === 'Q' && resA.byteOffset === 4 && resA.bitOffset === 2, 'German %A4.2 resolves to area Q')

const resDb = mem.resolveAddress('%DB1.DBW10')
assert(resDb !== null && resDb.area === 'DB' && resDb.dbNumber === 1 && resDb.byteOffset === 10 && resDb.sizeCategory === 'WORD', 'DB1.DBW10 resolves correctly')

// -----------------------------------------------------------------------------
// Test 3: S7 Timer Engine (TON, TOF, TP)
// -----------------------------------------------------------------------------
console.log('\n--- 3. Testing S7 Timer Engine (TON, TOF, TP) ---')
const tMem = new S7BinaryMemory()

// TON: IN false -> Q false, ET 0
let ton = tMem.updateTonTimer('T1', false, 5000, 1000)
assert(ton.Q === false && ton.ET === 0, 'TON with IN=false has Q=false, ET=0')

// TON: IN true at t=1000 -> running, ET=0, Q=false
ton = tMem.updateTonTimer('T1', true, 5000, 1000)
assert(ton.running === true && ton.Q === false, 'TON starts running at t=1000')

// TON: at t=3500 -> ET=2500, Q=false
ton = tMem.updateTonTimer('T1', true, 5000, 3500)
assert(ton.ET === 2500 && ton.Q === false, 'TON accumulated ET=2500ms')

// TON: at t=6100 -> ET=5000, Q=true
ton = tMem.updateTonTimer('T1', true, 5000, 6100)
assert(ton.ET === 5000 && ton.Q === true, 'TON trip threshold reached: ET=5000ms, Q=true')

// Reading via getVariable
assert(tMem.getVariable('T1.Q') === true, 'getVariable("T1.Q") returns true')
assert(tMem.getVariable('T1.ET') === 5000, 'getVariable("T1.ET") returns 5000')

// TON: IN turns false -> resets ET=0, Q=false
ton = tMem.updateTonTimer('T1', false, 5000, 6200)
assert(ton.Q === false && ton.ET === 0, 'TON IN=false resets ET=0 and Q=false')

// -----------------------------------------------------------------------------
// Test 4: S7 Counter Engine (CTU)
// -----------------------------------------------------------------------------
console.log('\n--- 4. Testing S7 Counter Engine (CTU) ---')
const cMem = new S7BinaryMemory()

// Initial state
let ctu = cMem.updateCtuCounter('C1', false, false, 3)
assert(ctu.CV === 0 && ctu.QU === false, 'CTU initial CV=0, QU=false')

// Pulse 1: CU false -> true
ctu = cMem.updateCtuCounter('C1', true, false, 3)
assert(ctu.CV === 1 && ctu.QU === false, 'CTU pulse 1: CV=1')

// Pulse 1 held: CU true -> true (no edge)
ctu = cMem.updateCtuCounter('C1', true, false, 3)
assert(ctu.CV === 1 && ctu.QU === false, 'CTU held true does not increment')

// Falling edge
ctu = cMem.updateCtuCounter('C1', false, false, 3)

// Pulse 2
ctu = cMem.updateCtuCounter('C1', true, false, 3)
assert(ctu.CV === 2 && ctu.QU === false, 'CTU pulse 2: CV=2')
ctu = cMem.updateCtuCounter('C1', false, false, 3)

// Pulse 3 -> reaches PV (3) -> QU becomes true
ctu = cMem.updateCtuCounter('C1', true, false, 3)
assert(ctu.CV === 3 && ctu.QU === true, 'CTU pulse 3: CV=3, QU=true')

// Reading via getVariable
assert(cMem.getVariable('C1.CV') === 3, 'getVariable("C1.CV") returns 3')
assert(cMem.getVariable('C1.QU') === true, 'getVariable("C1.QU") returns true')

// Reset
ctu = cMem.updateCtuCounter('C1', false, true, 3)
assert(ctu.CV === 0 && ctu.QU === false, 'CTU reset: CV=0, QU=false')

// -----------------------------------------------------------------------------
// Test 5: PlcRuntimeEngine Single-Source-of-Truth Memory Integration
// -----------------------------------------------------------------------------
console.log('\n--- 5. Testing PlcRuntimeEngine Single-Source-of-Truth Memory ---')
const engine = new PlcRuntimeEngine()

// Memory image write and read
engine.setBit('I', 1, 2, true)
assert(engine.memory.readBit('I', 1, 2) === true, 'engine.setBit writes to engine.memory')
assert(engine.getBit('I', 1, 2) === true, 'engine.getBit reads from engine.memory')
assert(engine.getVariable('%I1.2') === true, 'engine.getVariable("%I1.2") reads from engine.memory')

// Set variable
engine.setVariable('%Q2.4', true)
assert(engine.memory.readBit('Q', 2, 4) === true, 'engine.setVariable("%Q2.4", true) updates binary memory')

// Timer sub-bit write and read
engine.setVariable('T2.PT', 8000)
engine.setVariable('T2.ET', 3450)
engine.setVariable('T2.Q', true)
assert(engine.getVariable('T2.PT') === 8000, 'engine.getVariable("T2.PT") returns 8000')
assert(engine.getVariable('T2.ET') === 3450, 'engine.getVariable("T2.ET") returns 3450')
assert(engine.getVariable('T2.Q') === true, 'engine.getVariable("T2.Q") returns true')

// Counter sub-bit write and read
engine.setVariable('C2.PV', 50)
engine.setVariable('C2.CV', 25)
engine.setVariable('C2.QU', true)
assert(engine.getVariable('C2.PV') === 50, 'engine.getVariable("C2.PV") returns 50')
assert(engine.getVariable('C2.CV') === 25, 'engine.getVariable("C2.CV") returns 25')
assert(engine.getVariable('C2.QU') === true, 'engine.getVariable("C2.QU") returns true')

// Force Overrides
engine.setBit('I', 0, 0, false)
engine.setForcedValue('%I0.0', true, true)
assert(engine.getVariable('%I0.0') === true, 'Forced value returns true even if buffer is false')
engine.clearAllForcedValues()
engine.setBit('I', 0, 0, false)
assert(engine.getVariable('%I0.0') === false, 'After clearAllForcedValues, returns buffer value (false)')

console.log('\n======================================================')
console.log('ALL PHASE 8 S7 BINARY MEMORY UNIT TESTS PASSED: 5/5')
console.log('======================================================\n')
