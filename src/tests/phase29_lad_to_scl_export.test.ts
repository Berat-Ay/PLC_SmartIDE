// Regression tests for LAD-to-SCL Transpiler & Full TIA Portal Export integration.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { ProjectCompilerEngine } from '../renderer/src/services/compiler/ProjectCompilerEngine'
import { buildTiaBundle } from '../shared/tia/bundle'
import { transpileLadToScl } from '../shared/tia/ladToScl'
import { readTiaFolder } from '../shared/tia/readers'
import { CPU_1214C_PROFILE } from '../shared/constants/cpuProfiles'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'
import type { LadBlockDefinition } from '../shared/types/blocks'
import type { ProjectLoadPayload } from '../shared/types/ipc'
import type { TagTable } from '../shared/types/tags'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`✅ PASS: ${name}`)
  } else {
    failed++
    console.error(`❌ FAIL: ${name}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`)
  }
}

function blankInterface() {
  return { input: [], output: [], inOut: [], static: [], temp: [], constant: [] }
}

async function run(): Promise<void> {
  console.log('=== PHASE 29: LAD-TO-SCL TRANSPILER & FULL TIA EXPORT ===\n')

  // 1. Check untracked inceleme.txt was removed
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  check('Root note file inceleme.txt is removed', !existsSync(path.join(repoRoot, 'inceleme.txt')))

  // 2. Pure series/parallel/NC/comparator folding into idiomatic SCL
  const latchLad: LadBlockDefinition = {
    blockType: 'OB',
    blockNumber: 1,
    name: 'OB1_Latch',
    fileName: 'OB1_Latch.lad.json',
    optimizedAccess: true,
    schemaVersion: '2.0',
    interface: blankInterface(),
    networks: [
      {
        id: 'nw1',
        networkNumber: 1,
        title: 'Motor Latch with Trip',
        nodes: [
          {
            id: 'par_1',
            kind: 'parallel',
            branches: [
              [{ id: 'c_start', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Start_Btn' }],
              [{ id: 'c_seal', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Motor_Run' }]
            ]
          },
          { id: 'c_stop', kind: 'contact', contactType: 'NC_CONTACT', operand: 'Stop_Btn' },
          { id: 'c_done', kind: 'contact', contactType: 'NC_CONTACT', operand: 'T1.Q' },
          { id: 'cmp_1', kind: 'comparator', comparatorType: 'CMP_LT', op1: 'C1.CV', op2: '5', dataType: 'INT' },
          { id: 'out_1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor_Run' }
        ]
      }
    ]
  }
  const latchRes = transpileLadToScl(latchLad)
  check(
    'Pure LAD rung folds into idiomatic boolean SCL assignment',
    latchRes.sclBlock.code.includes('"Motor_Run" := ("Start_Btn" OR "Motor_Run") AND NOT "Stop_Btn" AND NOT "T1".Q AND ("C1".CV < 5);') &&
      latchRes.synthesizedDbs.length === 0,
    latchRes.sclBlock.code
  )

  // 3. SET / RESET / NEGATED coils & side-effecting parallel branches
  const coilBranchLad: LadBlockDefinition = {
    blockType: 'FC',
    blockNumber: 10,
    name: 'FC10_SideEffects',
    fileName: 'FC10_SideEffects.lad.json',
    optimizedAccess: true,
    schemaVersion: '2.0',
    interface: {
      ...blankInterface(),
      input: [{ id: 'i1', name: 'Enable', dataType: 'Bool', retain: false, accessibleFromHMI: false }],
      output: [
        { id: 'o1', name: 'AlarmLatched', dataType: 'Bool', retain: false, accessibleFromHMI: false },
        { id: 'o2', name: 'ReadyBar', dataType: 'Bool', retain: false, accessibleFromHMI: false }
      ]
    },
    networks: [
      {
        id: 'nw_set_reset',
        networkNumber: 1,
        title: 'Side-effect parallel branch and coils',
        nodes: [
          { id: 'c_en', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Enable' },
          {
            id: 'par_se',
            kind: 'parallel',
            branches: [
              [{ id: 's_alarm', kind: 'coil', coilType: 'SET_COIL', operand: 'AlarmLatched' }],
              [
                { id: 'nc_en', kind: 'contact', contactType: 'NC_CONTACT', operand: 'Enable' },
                { id: 'r_alarm', kind: 'coil', coilType: 'RESET_COIL', operand: 'AlarmLatched' }
              ]
            ]
          },
          { id: 'neg_out', kind: 'coil', coilType: 'NEGATED_COIL', operand: 'ReadyBar' }
        ]
      }
    ]
  }
  const coilBranchRes = transpileLadToScl(coilBranchLad)
  check(
    'SET/RESET/NEGATED coils & side-effecting parallel branches emit valid #temps and local #params',
    coilBranchRes.sclBlock.code.includes('VAR_TEMP') &&
      coilBranchRes.sclBlock.code.includes('_rlo_in_1 : Bool;') &&
      coilBranchRes.sclBlock.code.includes('_br_1 : Bool;') &&
      coilBranchRes.sclBlock.code.includes('#AlarmLatched := TRUE;') &&
      coilBranchRes.sclBlock.code.includes('#AlarmLatched := FALSE;') &&
      coilBranchRes.sclBlock.code.includes('#ReadyBar := NOT (#_br_1);'),
    coilBranchRes.sclBlock.code
  )

  // 4. Math (ADD/SUB/MUL/DIV with 0-guard, MOVE, NORM_X, SCALE_X) + Hybrid SCL network
  const mathLad: LadBlockDefinition = {
    blockType: 'OB',
    blockNumber: 1,
    name: 'OB1_Math',
    fileName: 'OB1_Math.lad.json',
    optimizedAccess: true,
    schemaVersion: '2.0',
    interface: blankInterface(),
    networks: [
      {
        id: 'nw_math',
        networkNumber: 1,
        title: 'Arithmetic and Scaling',
        nodes: [
          { id: 'm_en', kind: 'contact', contactType: 'NO_CONTACT', operand: 'EnableMath' },
          { id: 'm_add', kind: 'math', boxType: 'ADD', in1: 'ValA', in2: 'ValB', out: 'SumAB' },
          { id: 'm_div', kind: 'math', boxType: 'DIV', in1: 'SumAB', in2: 'Divisor', out: 'QuotAB' },
          { id: 'm_move', kind: 'math', boxType: 'MOVE', in1: '42', out: 'StatusCode' },
          { id: 'm_norm', kind: 'math', boxType: 'NORM_X', min: '0', max: '27648', value: 'RawAi', out: 'NormVal' },
          { id: 'm_scale', kind: 'math', boxType: 'SCALE_X', min: '-10.0', max: '100.0', value: 'NormVal', out: 'EngVal' }
        ]
      },
      {
        id: 'nw_hyb',
        networkNumber: 2,
        title: 'Hybrid SCL Snippet',
        isSclNetwork: true,
        sclCode: '"DirectFlag" := "SumAB" > 10;',
        nodes: []
      }
    ]
  }
  const mathRes = transpileLadToScl(mathLad)
  check(
    'Math instructions & hybrid SCL networks transpile with div-by-zero protection and SCALE_X/NORM_X pins',
    mathRes.sclBlock.code.includes('IF "EnableMath" THEN') &&
      mathRes.sclBlock.code.includes('"SumAB" := "ValA" + "ValB";') &&
      mathRes.sclBlock.code.includes('IF ("Divisor") <> 0 THEN') &&
      mathRes.sclBlock.code.includes('"StatusCode" := 42;') &&
      mathRes.sclBlock.code.includes('NORM_X(MIN := 0, VALUE := "RawAi", MAX := 27648)') &&
      mathRes.sclBlock.code.includes('SCALE_X(MIN := -10.0, VALUE := "NormVal", MAX := 100.0)') &&
      mathRes.sclBlock.code.includes('"DirectFlag" := "SumAB" > 10;'),
    mathRes.sclBlock.code
  )

  // 5. Demo Project Full Export & Re-import Compiler Audit
  const demo = DemoProjectSeeder.createDemoProject()
  const demoBundle = buildTiaBundle(demo)
  const stepOrder = demoBundle.manifest.steps.map((s) => s.name)
  check(
    'Demo TIA bundle exports OB1_Main.scl, OB82_DiagFault.scl, DB2_TON_Pump.db in dependency order with 0 skipped',
    demoBundle.manifest.skipped.length === 0 &&
      demoBundle.files.some((f) => f.filename === 'OB1_Main.scl') &&
      demoBundle.files.some((f) => f.filename === 'OB82_DiagFault.scl') &&
      demoBundle.files.some((f) => f.filename === 'DB2_TON_Pump.db') &&
      stepOrder.indexOf('DB2_TON_Pump') < stepOrder.indexOf('OB1_Main'),
    stepOrder
  )

  const demoRoundTrip = readTiaFolder(
    demoBundle.files.map((f) => ({ path: (f.folder ? `${f.folder}/` : '') + f.filename, content: f.content }))
  )
  check(
    'Re-importing exported demo project recovers 4 SCL blocks & 2 DBs (1 global + 1 synthesized IEC_TIMER)',
    demoRoundTrip.sclBlocks.length === 4 &&
      demoRoundTrip.dataBlocks.length === 2 &&
      demoRoundTrip.dataBlocks.some((d) => d.name === 'DB2_TON_Pump' && d.parentFbName === 'IEC_TIMER'),
    {
      scl: demoRoundTrip.sclBlocks.map((b) => b.name),
      dbs: demoRoundTrip.dataBlocks.map((d) => `${d.name}:${d.parentFbName}`)
    }
  )

  const rtCompile = ProjectCompilerEngine.runFullProjectCompilation(
    demo.tagTables,
    [],
    demoRoundTrip.sclBlocks,
    demo.hardware,
    demoRoundTrip.dataBlocks,
    demoRoundTrip.udts
  )
  check(
    'Re-imported pure-SCL version of Demo Project passes ProjectCompilerEngine with 0 blocking errors (canDownload === true)',
    rtCompile.canDownload &&
      rtCompile.diagnostics.filter((d) => d.severity === 'Error' && d.blocksDownload !== false).length === 0,
    rtCompile.diagnostics
  )

  // 6. Behavioral Equivalence Proof in PlcRuntimeEngine:
  // Original LAD Project vs Exported & Re-Imported Pure SCL + Synthesized DB Project
  const eqTags: TagTable[] = [
    {
      id: 'tt_eq',
      name: 'Default_Tags',
      fileName: 'Default_Tags.tags.json',
      tags: [
        { id: 't1', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.0' },
        { id: 't2', name: 'Stop_Btn', dataType: 'BOOL', address: '%I0.1' },
        { id: 't3', name: 'Pulse_In', dataType: 'BOOL', address: '%I0.2' },
        { id: 't4', name: 'Counter_Reset', dataType: 'BOOL', address: '%I0.3' },
        { id: 't5', name: 'Raw_Temp', dataType: 'INT', address: '%IW64' },
        { id: 't6', name: 'Motor_Run', dataType: 'BOOL', address: '%Q0.0' },
        { id: 't7', name: 'Pump_Run', dataType: 'BOOL', address: '%Q0.1' },
        { id: 't8', name: 'Batch_Done', dataType: 'BOOL', address: '%Q0.2' },
        { id: 't9', name: 'Edge_Mem', dataType: 'BOOL', address: '%M0.0' },
        { id: 't10', name: 'Norm_Temp', dataType: 'REAL', address: '%MD20' },
        { id: 't11', name: 'Scaled_Temp', dataType: 'REAL', address: '%MD24' }
      ]
    }
  ]

  const eqOb1: LadBlockDefinition = {
    blockType: 'OB',
    blockNumber: 1,
    name: 'OB1_Equiv',
    fileName: 'OB1_Equiv.lad.json',
    optimizedAccess: true,
    schemaVersion: '2.0',
    interface: blankInterface(),
    networks: [
      {
        id: 'eq_nw1',
        networkNumber: 1,
        title: 'Motor Latch + TON Delay',
        nodes: [
          {
            id: 'eq_par',
            kind: 'parallel',
            branches: [
              [{ id: 'eq_c1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Start_Btn' }],
              [{ id: 'eq_c2', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Motor_Run' }]
            ]
          },
          { id: 'eq_stop', kind: 'contact', contactType: 'NC_CONTACT', operand: 'Stop_Btn' },
          { id: 'eq_coil_m', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor_Run' }
        ]
      },
      {
        id: 'eq_nw2',
        networkNumber: 2,
        title: '500ms Pump Startup Timer',
        nodes: [
          { id: 'eq_m_on', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Motor_Run' },
          {
            id: 'eq_ton',
            kind: 'timer',
            timerType: 'TON',
            instanceDb: 'T1_Delay',
            inOperand: 'Motor_Run',
            ptOperand: 'T#500ms',
            qOperand: 'Pump_Run',
            etOperand: ''
          }
        ]
      },
      {
        id: 'eq_nw3',
        networkNumber: 3,
        title: 'Edge Pulse + CTU Counter + Comparator',
        nodes: [
          { id: 'eq_p', kind: 'contact', contactType: 'P_TRIG', operand: 'Pulse_In', edgeTag: 'Edge_Mem' },
          {
            id: 'eq_ctu',
            kind: 'counter',
            counterType: 'CTU',
            instanceDb: 'C1_Batch',
            cuCdOperand: '',
            rLdOperand: 'Counter_Reset',
            pvOperand: '2',
            qOperand: '',
            cvOperand: ''
          }
        ]
      },
      {
        id: 'eq_nw4',
        networkNumber: 4,
        title: 'Batch Done Comparator',
        nodes: [
          { id: 'eq_cmp', kind: 'comparator', comparatorType: 'CMP_GE', op1: 'C1_Batch.CV', op2: '2', dataType: 'INT' },
          { id: 'eq_bcoil', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Batch_Done' }
        ]
      },
      {
        id: 'eq_nw5',
        networkNumber: 5,
        title: 'Analog Temp Scaling',
        nodes: [
          { id: 'eq_norm', kind: 'math', boxType: 'NORM_X', min: '0', max: '27648', value: 'Raw_Temp', out: 'Norm_Temp' },
          { id: 'eq_scale', kind: 'math', boxType: 'SCALE_X', min: '0.0', max: '150.0', value: 'Norm_Temp', out: 'Scaled_Temp' }
        ]
      }
    ]
  }

  const eqLadProject: ProjectLoadPayload = {
    projectPath: '/tmp/eq_lad',
    metadata: {
      id: 'eq_test',
      name: 'Equiv_Project',
      targetCpu: 'Virtual S7-1200',
      firmwareVersion: CPU_1214C_PROFILE.firmwareVersion,
      schemaVersion: '1.0.0',
      author: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectPath: '/tmp/eq_lad'
    },
    hardware: getDefaultCpuConfig(),
    tagTables: eqTags,
    udts: [],
    dataBlocks: [],
    ladBlocks: [eqOb1],
    sclBlocks: []
  }

  const eqBundle = buildTiaBundle(eqLadProject)
  const eqImported = readTiaFolder(
    eqBundle.files.map((f) => ({ path: (f.folder ? `${f.folder}/` : '') + f.filename, content: f.content }))
  )
  const eqSclProject: ProjectLoadPayload = {
    ...eqLadProject,
    udts: eqImported.udts,
    dataBlocks: eqImported.dataBlocks,
    ladBlocks: [],
    sclBlocks: eqImported.sclBlocks
  }

  function runScenario(proj: ProjectLoadPayload): Array<Record<string, unknown>> {
    const eng = new PlcRuntimeEngine(proj)
    let now = 1000
    eng.setClock(() => now)
    eng.start({ manualScans: true })
    eng.setVariable('Raw_Temp', 13824) // 50% -> 75.0 degC

    const snap = () => ({
      motor: Boolean(eng.getVariable('Motor_Run')),
      pump: Boolean(eng.getVariable('Pump_Run')),
      done: Boolean(eng.getVariable('Batch_Done')),
      cv: Number(eng.getVariable('C1_Batch.CV') || 0),
      temp: Math.round(Number(eng.getVariable('Scaled_Temp') || 0) * 100) / 100
    })

    const trace: Array<Record<string, unknown>> = []
    // Step 1: Start press + Pulse 1
    eng.setVariable('Start_Btn', true)
    eng.setVariable('Pulse_In', true)
    eng.scanOnce()
    trace.push(snap())

    // Step 2: Release Start & Pulse after 300ms (latched, timer not done yet)
    now += 300
    eng.setVariable('Start_Btn', false)
    eng.setVariable('Pulse_In', false)
    eng.scanOnce()
    trace.push(snap())

    // Step 3: +300ms (600ms total -> TON done!) + Pulse 2 (CV becomes 2 -> Batch_Done TRUE)
    now += 300
    eng.setVariable('Pulse_In', true)
    eng.scanOnce()
    trace.push(snap())

    // Step 4: Stop pressed -> Motor & Pump drop
    now += 50
    eng.setVariable('Stop_Btn', true)
    eng.setVariable('Pulse_In', false)
    eng.scanOnce()
    trace.push(snap())

    eng.stop()
    return trace
  }

  const ladTrace = runScenario(eqLadProject)
  const sclTrace = runScenario(eqSclProject)

  const expectedTrace = [
    { motor: true, pump: false, done: false, cv: 1, temp: 75 },
    { motor: true, pump: false, done: false, cv: 1, temp: 75 },
    { motor: true, pump: true, done: true, cv: 2, temp: 75 },
    { motor: false, pump: false, done: true, cv: 2, temp: 75 }
  ]

  check(
    'Original LAD project and TIA-exported/re-imported SCL project execute identically across latch, TON, P_TRIG, CTU, Comparator, and NORM_X/SCALE_X',
    JSON.stringify(ladTrace) === JSON.stringify(expectedTrace) &&
      JSON.stringify(sclTrace) === JSON.stringify(ladTrace),
    { expectedTrace, ladTrace, sclTrace }
  )

  console.log(`\nPhase 29 Summary: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal test failure:', err)
  process.exit(1)
})
