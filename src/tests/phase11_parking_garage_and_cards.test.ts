/**
 * Phase 11 Test Suite: Parking Garage (Otopark) Control System,
 * CTUD / N_TRIG / P_TRIG / Comparator Evaluation & TIA Portal v19 Component Cards
 */

import { LadderEvaluator } from '../renderer/src/runtime/LadderEvaluator'
import { S7BinaryMemory } from '../renderer/src/runtime/S7BinaryMemory'
import { LadderDslCompiler } from '../renderer/src/services/compiler/LadderDslCompiler'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { SclExecutionContext } from '../renderer/src/runtime/SclInterpreter'
import {
  LadderContactNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderTimerNode,
  LadderNetwork
} from '../shared/types/ladder'

console.log('=== RUNNING PHASE 11 PARKING GARAGE & TIA CARDS TEST SUITE ===\n')

let passCount = 0
let failCount = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`PASS: ${msg}`)
    passCount++
  } else {
    console.error(`FAIL: ${msg}`)
    failCount++
    throw new Error(`Assertion failed: ${msg}`)
  }
}

async function runTests() {
  // ---------------------------------------------------------------------------
  // 1. Testing CTUD Binary Memory & Runtime Engine
  // ---------------------------------------------------------------------------
  console.log('--- 1. Testing CTUD Counter Execution in S7BinaryMemory & LadderEvaluator ---')
  const memory = new S7BinaryMemory()

  // Initial CTUD C1 (PV = 10)
  let c1 = memory.getCounter('C1')
  assert(c1.CV === 0, 'Initial C1.CV is 0')
  assert(c1.QU === false, 'Initial C1.QU is FALSE')
  assert(c1.QD === false, 'Initial C1.QD is FALSE')

  // Pulse CU (Count Up)
  c1 = memory.updateCtudCounter('C1', true, false, false, false, 10)
  assert(c1.CV === 1, 'Pulse CU #1: C1.CV incremented to 1')
  assert(c1.QU === false, 'C1.QU is still FALSE (1 < 10)')

  // Hold CU = true (no edge)
  c1 = memory.updateCtudCounter('C1', true, false, false, false, 10)
  assert(c1.CV === 1, 'Holding CU = true does NOT re-increment (edge-triggered)')

  // Release CU = false
  c1 = memory.updateCtudCounter('C1', false, false, false, false, 10)

  // Increment up to 10
  for (let i = 2; i <= 10; i++) {
    memory.updateCtudCounter('C1', true, false, false, false, 10)
    c1 = memory.updateCtudCounter('C1', false, false, false, false, 10)
  }
  assert(c1.CV === 10, 'C1.CV reached 10 vehicles')
  assert(c1.QU === true, 'C1.QU is TRUE when CV >= PV (Full)')

  // Pulse CD (Count Down - Vehicle exits)
  c1 = memory.updateCtudCounter('C1', false, true, false, false, 10)
  assert(c1.CV === 9, 'Pulse CD #1: C1.CV decremented to 9')
  assert(c1.QU === false, 'C1.QU tripped to FALSE when CV < PV (Space available)')

  // Release CD = false
  c1 = memory.updateCtudCounter('C1', false, false, false, false, 10)

  // Reset counter
  c1 = memory.updateCtudCounter('C1', false, false, true, false, 10)
  assert(c1.CV === 0, 'Reset pulse: C1.CV reset to 0')
  assert(c1.QD === true, 'C1.QD is TRUE when CV <= 0')

  // ---------------------------------------------------------------------------
  // 2. Testing N_TRIG and P_TRIG Edge Triggers in LadderEvaluator
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Testing N_TRIG (Falling Edge) & P_TRIG (Rising Edge) in LadderEvaluator ---')
  LadderEvaluator.resetInternalStates()

  const vars: Record<string, unknown> = {
    Giris_Fotosel: false,
    Cikis_Fotosel: false
  }

  const context: SclExecutionContext = {
    getVar: (sym: string) => vars[sym],
    setVar: (sym: string, val: unknown) => {
      vars[sym] = val
    }
  }

  const nTrigNode: LadderContactNode = {
    id: 'node_ntrig',
    kind: 'contact',
    contactType: 'N_TRIG',
    operand: 'Giris_Fotosel'
  }

  const pTrigNode: LadderContactNode = {
    id: 'node_ptrig',
    kind: 'contact',
    contactType: 'P_TRIG',
    operand: 'Cikis_Fotosel'
  }

  const netNTrig: LadderNetwork = {
    id: 'net_ntrig',
    networkNumber: 1,
    title: 'N_TRIG Test',
    nodes: [nTrigNode]
  }

  const netPTrig: LadderNetwork = {
    id: 'net_ptrig',
    networkNumber: 2,
    title: 'P_TRIG Test',
    nodes: [pTrigNode]
  }

  // Scan 1: Both initially FALSE
  let resN = LadderEvaluator.evaluateNetwork(netNTrig, context, 1000)
  let resP = LadderEvaluator.evaluateNetwork(netPTrig, context, 1000)
  assert(resN.nodePowerStates['node_ntrig']?.isConducting === false, 'Scan 1: N_TRIG is FALSE when steady FALSE')
  assert(resP.nodePowerStates['node_ptrig']?.isConducting === false, 'Scan 1: P_TRIG is FALSE when steady FALSE')

  // Scan 2: Vehicle blocks photocell (Giris_Fotosel: FALSE -> TRUE)
  vars['Giris_Fotosel'] = true
  vars['Cikis_Fotosel'] = true
  resN = LadderEvaluator.evaluateNetwork(netNTrig, context, 1010)
  resP = LadderEvaluator.evaluateNetwork(netPTrig, context, 1010)
  assert(resN.nodePowerStates['node_ntrig']?.isConducting === false, 'Scan 2: N_TRIG is FALSE on rising edge (only triggers on falling edge)')
  assert(resP.nodePowerStates['node_ptrig']?.isConducting === true, 'Scan 2: P_TRIG conducts on rising edge (FALSE -> TRUE)')

  // Scan 3: Still TRUE
  resP = LadderEvaluator.evaluateNetwork(netPTrig, context, 1020)
  assert(resP.nodePowerStates['node_ptrig']?.isConducting === false, 'Scan 3: P_TRIG de-energizes on next cycle (1-scan pulse)')

  // Scan 4: Vehicle leaves photocell (Giris_Fotosel: TRUE -> FALSE: Falling edge!)
  vars['Giris_Fotosel'] = false
  resN = LadderEvaluator.evaluateNetwork(netNTrig, context, 1030)
  assert(resN.nodePowerStates['node_ntrig']?.isConducting === true, 'Scan 4: N_TRIG conducts exactly 1 scan on falling edge (TRUE -> FALSE)')

  // Scan 5: Steady FALSE
  resN = LadderEvaluator.evaluateNetwork(netNTrig, context, 1040)
  assert(resN.nodePowerStates['node_ntrig']?.isConducting === false, 'Scan 5: N_TRIG de-energizes on next scan')

  // ---------------------------------------------------------------------------
  // 3. Testing Comparator Evaluation (CMP_LT, CMP_GE with C1.CV)
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Testing Comparator Nodes (CMP_LT, CMP_GE with C1.CV) ---')
  vars['C1.CV'] = 7

  const cmpLtNode: LadderComparatorNode = {
    id: 'cmp_lt',
    kind: 'comparator',
    comparatorType: 'CMP_LT',
    op1: 'C1.CV',
    op2: '10',
    dataType: 'INT'
  }

  const cmpGeNode: LadderComparatorNode = {
    id: 'cmp_ge',
    kind: 'comparator',
    comparatorType: 'CMP_GE',
    op1: 'C1.CV',
    op2: '10',
    dataType: 'INT'
  }

  const netCmpLt: LadderNetwork = { id: 'net_cmp_lt', networkNumber: 1, title: 'CMP_LT', nodes: [cmpLtNode] }
  const netCmpGe: LadderNetwork = { id: 'net_cmp_ge', networkNumber: 2, title: 'CMP_GE', nodes: [cmpGeNode] }

  let evalLt = LadderEvaluator.evaluateNetwork(netCmpLt, context, 2000)
  let evalGe = LadderEvaluator.evaluateNetwork(netCmpGe, context, 2000)
  assert(evalLt.nodePowerStates['cmp_lt']?.powered === true, 'CMP_LT(7, 10) conducts (7 < 10 is TRUE)')
  assert(evalGe.nodePowerStates['cmp_ge']?.powered === false, 'CMP_GE(7, 10) blocks (7 >= 10 is FALSE)')

  // Change CV to 10
  vars['C1.CV'] = 10
  evalLt = LadderEvaluator.evaluateNetwork(netCmpLt, context, 2010)
  evalGe = LadderEvaluator.evaluateNetwork(netCmpGe, context, 2010)
  assert(evalLt.nodePowerStates['cmp_lt']?.powered === false, 'CMP_LT(10, 10) blocks (10 < 10 is FALSE)')
  assert(evalGe.nodePowerStates['cmp_ge']?.powered === true, 'CMP_GE(10, 10) conducts (10 >= 10 is TRUE)')

  // ---------------------------------------------------------------------------
  // 4. Testing Compact Ladder DSL with CTUD & Parking Garage Compilation
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Testing Compact Ladder DSL Compilation for CTUD & Parking Garage ---')
  const parkingDsl = [
    '# TAG DECLARATIONS',
    'TAG Giris_Kart %I0.0 BOOL "Giriş Kart Okuyucu (NO)"',
    'TAG Giris_Fotosel %I0.1 BOOL "Giriş Güvenlik Fotoseli"',
    'TAG Ust_Limit %I0.2 BOOL "Bariyer Üst Limit Sınır Anahtarı"',
    'TAG Alt_Limit %I0.3 BOOL "Bariyer Alt Limit Sınır Anahtarı"',
    'TAG Cikis_Fotosel %I0.4 BOOL "Çıkış Araç Algılama Fotoseli"',
    'TAG Kapi_Yukari_Motor %Q0.0 BOOL "Bariyer Kapı Yukarı Açma Motoru"',
    'TAG Kapi_Asagi_Motor %Q0.1 BOOL "Bariyer Kapı Aşağı Kapatma Motoru"',
    'TAG Otopark_Dolu_Tabela %Q0.2 BOOL "Otopark Dolu Işıklı Tabela"',
    '',
    '# NETWORK DEFINITIONS',
    'NW 1 "Bariyer Kapı Yukarı Motoru ve Emniyet Geri Açılma (%Q0.0)": SERIES( PARALLEL( SERIES( CMP_LT(C1.CV, 10), NO(Giris_Kart) ), SERIES( NO(Kapi_Asagi_Motor), NO(Giris_Fotosel) ), NO(Kapi_Yukari_Motor) ), NC(Ust_Limit), NC(Kapi_Asagi_Motor), COIL(Kapi_Yukari_Motor) )',
    'NW 2 "Araç Giriş/Çıkış Sayacı (CTUD C1, PV=10)": SERIES( N_TRIG(Giris_Fotosel), CTUD(C1, PV=10, CD=Cikis_Fotosel) )',
    'NW 3 "7 Saniye Otomatik Kapanma Zamanlayıcısı (TON T1)": SERIES( NO(Ust_Limit), TON(T1, PT=T#7s) )',
    'NW 4 "Bariyer Kapı Aşağı Kapatma Motoru (%Q0.1)": SERIES( PARALLEL( NO(T1.Q), NO(Kapi_Asagi_Motor) ), NC(Alt_Limit), NC(Giris_Fotosel), NC(Kapi_Yukari_Motor), COIL(Kapi_Asagi_Motor) )',
    'NW 5 "Otopark Dolu Tabelası Kontrolü (%Q0.2)": SERIES( CMP_GE(C1.CV, 10), COIL(Otopark_Dolu_Tabela) )'
  ].join('\n')

  const dslRes = LadderDslCompiler.compileLadderDslToAst(parkingDsl)
  assert(dslRes.success, 'Parking DSL compiled successfully')
  assert(dslRes.networks.length === 5, 'Compiled exactly 5 networks')
  assert(dslRes.tags.length === 8, 'Extracted 8 non-overlapping tags')

  // Verify Network 2 has CTUD
  const net2Nodes = dslRes.networks[1].nodes
  assert(net2Nodes[0].kind === 'contact' && (net2Nodes[0] as LadderContactNode).contactType === 'N_TRIG', 'NW2 starts with N_TRIG')
  assert(net2Nodes[1].kind === 'counter' && (net2Nodes[1] as LadderCounterNode).counterType === 'CTUD', 'NW2 has CTUD counter')
  assert((net2Nodes[1] as LadderCounterNode).cdOperand === 'Cikis_Fotosel', 'CTUD CD operand is Cikis_Fotosel')

  // Verify Network 3 has TON with 7s preset
  const net3Nodes = dslRes.networks[2].nodes
  assert(net3Nodes[1].kind === 'timer' && (net3Nodes[1] as LadderTimerNode).timerType === 'TON', 'NW3 has TON timer')
  assert((net3Nodes[1] as LadderTimerNode).ptOperand === 'T#7s', 'TON PT is T#7s')

  // Verify Network 5 has CMP_GE
  const net5Nodes = dslRes.networks[4].nodes
  assert(net5Nodes[0].kind === 'comparator' && (net5Nodes[0] as LadderComparatorNode).comparatorType === 'CMP_GE', 'NW5 has CMP_GE comparator')

  // ---------------------------------------------------------------------------
  // 5. Testing AiModelRouter Parking Garage Synthesis & Fake Diagnostic Removal
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Testing AiModelRouter Parking Garage Synthesis & Fake Interceptor Purge ---')
  const router = AiModelRouter.getInstance()

  // Prompt that previously triggered fake EmergencyStop diagnostic interceptor
  const parkingPrompt = '10 araçlık otopark sistemi yap. kapı yukarı motoru çalışmazsa neden diye sormadan otopark bariyerini kur'
  const agentRes = await router.executePrompt(parkingPrompt, 'fast-flash', 'auto-apply')

  assert(!agentRes.replyText.includes('EmergencyStop (%I0.0) kontağı FALSE'), 'Fake diagnostic interceptor permanently eliminated!')
  assert(agentRes.replyText.includes('Otopark') || agentRes.replyText.includes('otopark') || agentRes.replyText.includes('Bariyer'), 'Correctly synthesized Otopark system')

  console.log('\n======================================================')
  console.log(`PHASE 11 UNIT TESTS COMPLETED: ${passCount} PASSED, ${failCount} FAILED`)
  console.log('======================================================\n')
}

runTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})

