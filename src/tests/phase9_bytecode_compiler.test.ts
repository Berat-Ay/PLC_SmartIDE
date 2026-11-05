import assert from 'node:assert'
import { StlListingGenerator } from '../renderer/src/services/compiler/StlListingGenerator'
import { ProjectCompilerEngine } from '../renderer/src/services/compiler/ProjectCompilerEngine'
import { TagTable } from '@shared/types/tags'
import { LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import { LadderNetwork } from '@shared/types/ladder'

console.log('\n=== RUNNING PHASE 9 IEC 61131-3 BYTECODE & COMPILER TEST SUITE ===\n')

// -----------------------------------------------------------------------------
// 1. LAD to S7 IL Bytecode Compilation Test
// -----------------------------------------------------------------------------
console.log('--- 1. Testing Ladder AST to S7 IL/STL Bytecode Compiler ---')

const ladNet1: LadderNetwork = {
  id: 'net_1',
  networkNumber: 1,
  title: 'Motor Start/Stop with Parallel Seal-in',
  nodes: [
    {
      id: 'p1',
      kind: 'parallel',
      branches: [
        [
          {
            id: 'c1',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'Start_Btn',
            address: '%I0.0',
            symbolName: 'Start_Btn'
          }
        ],
        [
          {
            id: 'c2',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'Motor_Run',
            address: '%Q0.0',
            symbolName: 'Motor_Run'
          }
        ]
      ]
    },
    {
      id: 'c3',
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
    }
  ]
}

const ladNet2: LadderNetwork = {
  id: 'net_2',
  networkNumber: 2,
  title: 'TON Timer Auto-Stop',
  nodes: [
    {
      id: 'c4',
      kind: 'contact',
      contactType: 'NO_CONTACT',
      operand: 'Motor_Run',
      address: '%Q0.0'
    },
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

const ladNet3: LadderNetwork = {
  id: 'net_3',
  networkNumber: 3,
  title: 'Analog Comparator and Add Math',
  nodes: [
    {
      id: 'cmp1',
      kind: 'comparator',
      comparatorType: 'CMP_GT',
      op1: 'TankLevel_Raw',
      op2: '20000',
      dataType: 'INT'
    },
    {
      id: 'math1',
      kind: 'math',
      boxType: 'ADD',
      in1: 'CurrentCycles',
      in2: '1',
      out: 'TotalCycles',
      dataType: 'INT'
    },
    {
      id: 'q_neg',
      kind: 'coil',
      coilType: 'NEGATED_COIL',
      operand: 'Fault_Led',
      address: '%Q0.2'
    }
  ]
}

const testLadBlock: LadBlockDefinition = {
  fileName: 'OB1_Main.lad.json',
  name: 'OB1_Main',
  blockType: 'OB',
  blockNumber: 1,
  networks: [ladNet1, ladNet2, ladNet3]
}

const compiledLad = StlListingGenerator.forLadBlock(testLadBlock)

assert.strictEqual(compiledLad.blockName, 'OB1_Main')
assert.strictEqual(compiledLad.blockType, 'OB')
assert.ok(compiledLad.totalInstructions >= 10, `Expected at least 10 instructions, got ${compiledLad.totalInstructions}`)

// Verify parallel branch instructions
const opcodes = compiledLad.instructions.map((i) => i.opcode)
assert.ok(opcodes.includes('O('), 'Emitted O( parallel branch opcode')
assert.ok(opcodes.includes(')'), 'Emitted ) parallel branch close')
assert.ok(opcodes.includes('AN'), 'Emitted AN for NC contact Stop_Btn')
assert.ok(opcodes.includes('='), 'Emitted = for output coil Motor_Run')
assert.ok(opcodes.includes('CALL'), 'Emitted CALL for TON timer block')
assert.ok(opcodes.includes('L'), 'Emitted L for load instructions')
assert.ok(opcodes.includes('>I'), 'Emitted >I for integer comparator')
assert.ok(opcodes.includes('+I'), 'Emitted +I for math ADD')
assert.ok(opcodes.includes('NOT'), 'Emitted NOT for negated coil')

// Check authentic Siemens disassembly formatting
assert.ok(compiledLad.listingText.includes('// Block: OB1_Main (OB)'))
assert.ok(compiledLad.listingText.includes('Network 1:'))
assert.ok(compiledLad.listingText.includes('CALL     "TON" , "T1"'))
assert.ok(compiledLad.listingText.includes('0001'))
assert.ok(!compiledLad.listingText.includes('Bytecode'), 'The listing does not claim to be bytecode')
console.log('PASS: Ladder AST compiles to authentic Siemens S7 STL bytecode with parallel branches, timers, math and coils')

// -----------------------------------------------------------------------------
// 2. SCL to S7 IL Bytecode Compilation Test
// -----------------------------------------------------------------------------
console.log('\n--- 2. Testing SCL AST to S7 IL/STL Bytecode Compiler ---')

const sclSource = `
IF "TankPressure_Bar" > 5.0 THEN
  "Alarm_High" := TRUE;
ELSE
  "Alarm_High" := FALSE;
END_IF;

FOR #i := 0 TO 10 DO
  #TotalSum := #TotalSum + #i;
END_FOR;
`

const testSclBlock: SclBlockDefinition = {
  fileName: 'FC1_Control.scl',
  name: 'FC1_Control',
  blockType: 'FC',
  blockNumber: 1,
  code: sclSource
}

const compiledScl = StlListingGenerator.forSclBlock(testSclBlock)

assert.strictEqual(compiledScl.blockName, 'FC1_Control')
assert.ok(compiledScl.totalInstructions >= 8, `Expected at least 8 instructions, got ${compiledScl.totalInstructions}`)

const sclOpcodes = compiledScl.instructions.map((i) => i.opcode)
assert.ok(sclOpcodes.includes('JCN'), 'Emitted JCN for conditional branch jump')
assert.ok(sclOpcodes.includes('JU'), 'Emitted JU for unconditional loop/else jump')
assert.ok(sclOpcodes.includes('T'), 'Emitted T for transfer instruction')
assert.ok(sclOpcodes.includes('<=I'), 'Emitted <=I for FOR loop boundary check')

assert.ok(compiledScl.listingText.includes('// Block: FC1_Control (FC)'))
assert.ok(compiledScl.listingText.includes('_ELSE_'))
assert.ok(compiledScl.listingText.includes('_FOR_START_'))
// ELSIF chains, WHILE, REPEAT, CASE, and labels that all exist
const flowBlock: SclBlockDefinition = {
  fileName: 'FC_Flow.scl',
  name: 'FC_Flow',
  blockType: 'FC',
  blockNumber: 2,
  code: `
IF #a > 1 THEN #x := 1; ELSIF #a > 2 THEN #x := 2; ELSIF #a > 3 THEN #x := 3; ELSE #x := 4; END_IF;
WHILE #a > 0 DO #a := #a - 1; IF #a = 3 THEN EXIT; END_IF; END_WHILE;
REPEAT #a := #a + 1; UNTIL #a > 5 END_REPEAT;
CASE #a OF 1: #x := 1; 2..4: #x := 2; ELSE #x := 3; END_CASE;
#flag := (#a > 1 AND #b) OR NOT #c;
`
}
const flow = StlListingGenerator.forSclBlock(flowBlock)
const placed = new Set(flow.instructions.filter((i) => i.label).map((i) => i.label))
const jumps = flow.instructions.filter((i) => ['JCN', 'JC', 'JU', 'JNB'].includes(i.opcode))
assert.ok(jumps.length > 8, 'Control flow produced jumps')
for (const jump of jumps) {
  assert.ok(placed.has(jump.operand), `Jump target ${jump.operand} exists`)
}
assert.strictEqual(placed.size, flow.instructions.filter((i) => i.label).length, 'Each label is placed once')
assert.ok(!flow.listingText.includes('???'), 'Complex operands are expanded, not replaced by ???')
assert.ok(flow.instructions.some((i) => i.opcode === 'A('), 'Nested logic uses A(')

console.log('PASS: SCL AST compiles to STL with valid jumps for IF, ELSIF, CASE, WHILE, REPEAT and FOR')

// -----------------------------------------------------------------------------
// 3. ProjectCompilerEngine 5-Pass Audit Test (Errors + IEC Diagnostic Codes)
// -----------------------------------------------------------------------------
console.log('\n--- 3. Testing ProjectCompilerEngine 5-Pass Audit with IEC Codes ---')

const collidingTagTable: TagTable = {
  id: 'tbl_colliding',
  name: 'CollidingTags',
  fileName: 'CollidingTags.tags.json',
  tags: [
    { id: 'tag_start', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.1' },
    { id: 'tag_stop', name: 'Stop_Btn', dataType: 'BOOL', address: '%I0.1' } // S7-MEM-001 collision
  ]
}

const defectLadBlock: LadBlockDefinition = {
  fileName: 'OB1_Defects.lad.json',
  name: 'OB1_Defects',
  blockType: 'OB',
  blockNumber: 1,
  networks: [
    {
      id: 'net_1',
      networkNumber: 1,
      title: 'Unassigned Operand & Missing Timer',
      nodes: [
        {
          id: 'c_ghost',
          kind: 'contact',
          contactType: 'NO_CONTACT',
          operand: '???', // S7-LAD-002 unassigned
          address: '???'
        },
        {
          id: 'c_tmr',
          kind: 'contact',
          contactType: 'NC_CONTACT',
          operand: 'T99.Q', // S7-TMR-004 missing timer
          address: 'T99.Q'
        },
        {
          id: 'q_dup1',
          kind: 'coil',
          coilType: 'OUTPUT_COIL',
          operand: 'Pump_Motor',
          address: '%Q0.0'
        }
      ]
    },
    {
      id: 'net_2',
      networkNumber: 2,
      title: 'Double-Coil Conflict & Empty Network',
      nodes: [
        {
          id: 'q_dup2',
          kind: 'coil',
          coilType: 'OUTPUT_COIL',
          operand: 'Pump_Motor', // S7-LAD-003 double-coil conflict
          address: '%Q0.0'
        }
      ]
    },
    {
      id: 'net_3',
      networkNumber: 3,
      title: 'Empty Network',
      nodes: [] // S7-LAD-002 empty network
    }
  ]
}

const syntaxErrorSclBlock: SclBlockDefinition = {
  fileName: 'FC_Err.scl',
  name: 'FC_Err',
  blockType: 'FC',
  blockNumber: 5,
  code: `IF #Start THEN #Run := TRUE; // S7-SCL-005 missing END_IF`
}

const errorResult = ProjectCompilerEngine.runFullProjectCompilation(
  [collidingTagTable],
  [defectLadBlock],
  [syntaxErrorSclBlock]
)

assert.strictEqual(errorResult.success, false, 'Compilation flagged defects')
assert.ok(errorResult.errorsCount >= 4, `Expected at least 4 errors, got ${errorResult.errorsCount}`)
assert.ok(errorResult.warningsCount >= 1, `Expected at least 1 warning, got ${errorResult.warningsCount}`)

// Verify IEC diagnostic codes and Auto-Fix actions
const iecCodes = errorResult.diagnostics.map((d) => d.iecCode)
assert.ok(iecCodes.includes('S7-MEM-001'), 'Flags Memory Overlap as S7-MEM-001')
assert.ok(iecCodes.includes('S7-LAD-002'), 'Flags Unassigned Operand/Empty Net as S7-LAD-002')
assert.ok(iecCodes.includes('S7-LAD-003'), 'Flags Double Coil as S7-LAD-003')
assert.ok(iecCodes.includes('S7-TMR-004'), 'Flags Uninstantiated Timer as S7-TMR-004')
assert.ok(iecCodes.includes('S7-SCL-005'), 'Flags SCL Syntax Error as S7-SCL-005')

// Verify auto-fix actions
const memDiag = errorResult.diagnostics.find((d) => d.iecCode === 'S7-MEM-001')!
assert.strictEqual(memDiag.autoFixable, true)
assert.strictEqual(memDiag.fixAction, 'AUTO_ASSIGN_ADDRESS')

const doubleCoilDiag = errorResult.diagnostics.find((d) => d.iecCode === 'S7-LAD-003')!
assert.strictEqual(doubleCoilDiag.autoFixable, true)
assert.strictEqual(doubleCoilDiag.fixAction, 'AUTO_MERGE_COILS')

const unassignedDiag = errorResult.diagnostics.find((d) => d.iecCode === 'S7-LAD-002')!
assert.strictEqual(unassignedDiag.autoFixable, true)
assert.strictEqual(unassignedDiag.fixAction, 'GO_TO_RUNG')

console.log('PASS: ProjectCompilerEngine flags S7-MEM-001, S7-LAD-002, S7-LAD-003, S7-TMR-004, S7-SCL-005 with actionable Auto-Fix metadata')

// -----------------------------------------------------------------------------
// 4. Clean Project Compilation & Bytecode Summary Metrics
// -----------------------------------------------------------------------------
console.log('\n--- 4. Testing Clean Project Compilation Metrics ---')

const cleanTagTable: TagTable = {
  id: 'tbl_clean',
  name: 'CleanTags',
  fileName: 'CleanTags.tags.json',
  tags: [
    { id: 't_start', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.0' },
    { id: 't_stop', name: 'Stop_Btn', dataType: 'BOOL', address: '%I0.1' },
    { id: 't_motor', name: 'Motor_Run', dataType: 'BOOL', address: '%Q0.0' }
  ]
}

const cleanLadBlock: LadBlockDefinition = {
  fileName: 'OB1_Clean.lad.json',
  name: 'OB1_Clean',
  blockType: 'OB',
  blockNumber: 1,
  networks: [ladNet1, ladNet2]
}

const cleanSclBlock: SclBlockDefinition = {
  fileName: 'FC_Clean.scl',
  name: 'FC_Clean',
  blockType: 'FC',
  blockNumber: 1,
  code: `IF "Motor_Run" THEN "Start_Btn" := FALSE; END_IF;`
}

const cleanResult = ProjectCompilerEngine.runFullProjectCompilation(
  [cleanTagTable],
  [cleanLadBlock],
  [cleanSclBlock]
)

assert.strictEqual(cleanResult.success, true, 'Clean project compilation succeeds with 0 errors')
assert.strictEqual(cleanResult.errorsCount, 0)
assert.strictEqual(cleanResult.canDownload, true, 'A clean project can go to RUN')
assert.ok(cleanResult.metricSummary?.includes('Networks'), 'metricSummary reports network count')
assert.ok(cleanResult.metricSummary?.includes('STL listing'), 'metricSummary reports listing size')
assert.ok(cleanResult.listingSummary, 'cleanResult includes listingSummary')
assert.strictEqual(cleanResult.listingSummary?.blocks.length, 2)
assert.ok((cleanResult.listingSummary?.totalInstructions || 0) > 0)

console.log(`PASS: Clean Project Compilation: ${cleanResult.metricSummary}`)

console.log('\n======================================================')
console.log('ALL PHASE 9 LISTING & COMPILER UNIT TESTS PASSED: 4/4')
console.log('======================================================\n')
