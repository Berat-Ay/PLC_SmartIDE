/**
 * Acceptance tests from the specification. A correct circuit passes them all, and the circuits the agent
 * really wrote fail exactly where they differ from the specification.
 */
import assert from 'node:assert'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { LadderDslCompiler } from '../renderer/src/services/compiler/LadderDslCompiler'
import { normalizeAiGeneratedNetworks } from '../renderer/src/services/ai/AiModelRouter'
import {
  CheckResult,
  evaluateScenario,
  formatReport,
  projectFromCircuit,
  projectFromDump,
  Scenario,
  testForCheck
} from '../renderer/src/services/scenarios/ScenarioAcceptance'
import { PICK_AND_PLACE, ROBOT_CELL, SCENARIOS } from '../renderer/src/services/scenarios/scenarios'
import { CAR_PARK, MOTOR_START_STOP, STAR_DELTA, TANK_FILL, TRAFFIC_LIGHT } from '../renderer/src/services/scenarios/textbookScenarios'
import { parseBehaviorTest } from '../renderer/src/services/ai/CircuitBehaviorTest'

console.log('\n=== PHASE 22: SCENARIO ACCEPTANCE TESTS ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const demo = DemoProjectSeeder.createDemoProject()

function project(dsl: string): ReturnType<typeof projectFromCircuit> {
  const compiled = LadderDslCompiler.compileLadderDslToAst(dsl, { reservedMerkerBytes: [0, 1] })
  assert.deepStrictEqual(compiled.errors, [], 'The circuit compiles')
  return projectFromCircuit(normalizeAiGeneratedNetworks(compiled.networks), compiled.tags, demo)
}

function failedIds(scenario: Scenario, dsl: string): string[] {
  return evaluateScenario(scenario, project(dsl))
    .filter((r: CheckResult) => !r.passed)
    .map((r) => r.check.id)
}

// ---- A correct robot cell, written from the specification ----
const ROBOT_CELL_REFERENCE = `TAG PartIn %I0.0 BOOL "Parca giris"
TAG PartOut %I0.2 BOOL "Cikis sensoru"
TAG FixtFwd %I0.3 BOOL "Fikstur ileri"
TAG FixtRev %I0.4 BOOL "Fikstur geri"
TAG Auto %I0.5 BOOL "Otomatik"
TAG Start %I0.6 BOOL "Cevrim start"
TAG SafetyOK %I0.7 BOOL "E-stop rolesi OK"
TAG R1Req %I1.0 BOOL "R1 talep"
TAG R1Home %I1.1 BOOL "R1 is bitti / evde"
TAG R2Req %I1.2 BOOL "R2 talep"
TAG R2Home %I1.3 BOOL "R2 is bitti / evde"
TAG FaultReset %I1.4 BOOL "Hata reset"
TAG ValveFwd %Q0.0 BOOL "Silindir ileri"
TAG ValveRev %Q0.1 BOOL "Silindir geri"
TAG Conveyor %Q0.2 BOOL "Konveyor"
TAG Green %Q0.3 BOOL "Yesil lamba"
TAG Siren %Q0.4 BOOL "Hata sireni"
TAG R1Permit %Q1.0 BOOL "R1 izin"
TAG R1Start %Q1.1 BOOL "R1 start"
TAG R2Permit %Q1.2 BOOL "R2 izin"
TAG R2Start %Q1.3 BOOL "R2 start"
TAG Ready %M10.0 BOOL "Sistem hazir"
TAG CycleDone %M10.1 BOOL "Cevrim bitti"
TAG S1 %M2.1 BOOL "Adim 1"
TAG S2 %M2.2 BOOL "Adim 2"
TAG S3 %M2.3 BOOL "Adim 3"
TAG S4 %M2.4 BOOL "Adim 4"
TAG R1Busy %M2.5 BOOL "R1 calisiyor"
TAG R2Busy %M2.6 BOOL "R2 calisiyor"
NW 1 "Hazir": SERIES( NO(Auto), NO(SafetyOK), NC(Siren), NO(R1Home), NO(R2Home), NO(FixtRev), COIL(Ready), COIL(Green) )
NW 2 "Adim 1": SERIES( NO(Ready), NO(Start), NO(PartIn), NC(S2), NC(S3), NC(S4), SET(S1) )
NW 3 "Kilit suresi": SERIES( NO(S1), NO(FixtFwd), TON(T_Clamp, PT=T#2S) )
NW 4 "Adim 2": SERIES( NO(T_Clamp.Q), SET(S2), RESET(S1) )
NW 5 "Fikstur ileri": SERIES( PARALLEL( NO(S1), NO(S2), NO(S3) ), NC(ValveRev), COIL(ValveFwd) )
NW 6 "R1 izin": SERIES( NO(S2), NO(R1Req), NC(R2Permit), COIL(R1Permit) )
NW 7 "R1 darbe": SERIES( NO(R1Permit), TP(T_R1Start, PT=T#1S) )
NW 8 "R1 start": SERIES( NO(T_R1Start.Q), NO(R1Permit), COIL(R1Start) )
NW 9 "R1 calisiyor": SERIES( NO(S2), NO(R1Permit), NC(R1Home), SET(R1Busy) )
NW 10 "Adim 3": SERIES( NO(S2), NO(R1Busy), NO(R1Home), SET(S3), RESET(S2), RESET(R1Busy) )
NW 11 "R2 izin": SERIES( NO(S3), NO(R2Req), NC(R1Permit), COIL(R2Permit) )
NW 12 "R2 start": SERIES( NO(R2Permit), COIL(R2Start) )
NW 13 "R2 calisiyor": SERIES( NO(S3), NO(R2Permit), NC(R2Home), SET(R2Busy) )
NW 14 "Adim 4": SERIES( NO(S3), NO(R2Busy), NO(R2Home), SET(S4), RESET(S3), RESET(R2Busy) )
NW 15 "Fikstur geri": SERIES( NO(S4), NC(ValveFwd), COIL(ValveRev) )
NW 16 "Konveyor": SERIES( NO(S4), NO(FixtRev), COIL(Conveyor) )
NW 17 "Cevrim bitti": SERIES( NO(S4), N_TRIG(PartOut), COIL(CycleDone) )
NW 18 "Basa don": SERIES( NO(CycleDone), RESET(S4) )
NW 19 "Kilit hatasi": SERIES( NO(S1), NC(FixtFwd), TON(T_Fault, PT=T#5S) )
NW 20 "Siren": SERIES( NO(T_Fault.Q), SET(Siren), RESET(S1) )
NW 21 "E-stop": SERIES( NC(SafetyOK), RESET(S1), RESET(S2), RESET(S3), RESET(S4), RESET(R1Busy), RESET(R2Busy) )
NW 22 "Hata reset": SERIES( NO(FaultReset), RESET(Siren) )`

// ---- A correct pick & place axis. The moves are TONs, standing in for MC_Home and MC_MoveAbsolute ----
const PICK_PLACE_REFERENCE = `TAG DriveReady %I0.0 BOOL "Surucu hazir"
TAG RobotDone %I0.1 BOOL "Robot is bitti"
TAG ConvEmpty %I0.2 BOOL "Konveyor bos"
TAG GripOpen %I0.3 BOOL "Tutucu acik"
TAG GripClosed %I0.4 BOOL "Tutucu kapali"
TAG Start %I0.5 BOOL "Cevrim start"
TAG EStop %I0.6 BOOL "E-stop (NC)"
TAG FaultReset %I0.7 BOOL "Hata reset"
TAG ValveOpen %Q0.0 BOOL "Tutucu ac"
TAG ValveClose %Q0.1 BOOL "Tutucu kapat"
TAG Lamp %Q0.2 BOOL "Hucre calisiyor"
TAG Powered %M10.0 BOOL "Eksen enerjili"
TAG StepHome %M20.0 BOOL "Home baslat"
TAG HomeDone %M20.1 BOOL "Home tamam"
TAG GoPick %M20.2 BOOL "Almaya git"
TAG AtPick %M20.3 BOOL "Alma konumunda"
TAG Gripped %M20.4 BOOL "Parca yakalandi"
TAG GoDrop %M20.5 BOOL "Birakmaya git"
TAG AtDrop %M20.6 BOOL "Birakma konumunda"
TAG GoHome %M20.7 BOOL "Eve don"
NW 1 "Enerji": SERIES( NO(EStop), NO(DriveReady), COIL(Powered) )
NW 2 "Home baslat": SERIES( NO(Powered), P_TRIG(Start), NC(HomeDone), SET(StepHome) )
NW 3 "Home hareketi (MC_Home yerine)": SERIES( NO(StepHome), TON(T_Home, PT=T#2S) )
NW 4 "Home tamam": SERIES( NO(T_Home.Q), SET(HomeDone), RESET(StepHome) )
NW 5 "Almaya git": SERIES( NO(HomeDone), NO(RobotDone), NC(GoPick), NC(AtPick), NC(Gripped), NC(GoDrop), NC(AtDrop), NC(GoHome), SET(GoPick) )
NW 6 "Alma hareketi": SERIES( NO(GoPick), TON(T_MovePick, PT=T#2S) )
NW 7 "Alma konumunda": SERIES( NO(T_MovePick.Q), SET(AtPick), RESET(GoPick) )
NW 8 "Tutucu kapat": SERIES( PARALLEL( NO(AtPick), NO(Gripped), NO(GoDrop) ), COIL(ValveClose) )
NW 9 "Kavrama suresi": SERIES( NO(AtPick), NO(GripClosed), TON(T_Grip, PT=T#1S) )
NW 10 "Parca yakalandi": SERIES( NO(T_Grip.Q), SET(Gripped), RESET(AtPick) )
NW 11 "Birakmaya git": SERIES( NO(Gripped), NO(ConvEmpty), SET(GoDrop), RESET(Gripped) )
NW 12 "Birakma hareketi": SERIES( NO(GoDrop), TON(T_MoveDrop, PT=T#2S) )
NW 13 "Birakma konumunda": SERIES( NO(T_MoveDrop.Q), SET(AtDrop), RESET(GoDrop) )
NW 14 "Tutucu ac": SERIES( NO(AtDrop), COIL(ValveOpen) )
NW 15 "Eve don": SERIES( NO(AtDrop), NO(GripOpen), SET(GoHome) )
NW 16 "Eve donus hareketi": SERIES( NO(GoHome), TON(T_MoveHome, PT=T#2S) )
NW 17 "Cevrim sonu": SERIES( NO(T_MoveHome.Q), RESET(AtDrop), RESET(GoHome) )
NW 18 "Lamba": SERIES( PARALLEL( NO(StepHome), NO(GoPick), NO(AtPick), NO(Gripped), NO(GoDrop), NO(AtDrop), NO(GoHome) ), COIL(Lamp) )
NW 19 "E-stop": SERIES( NC(EStop), RESET(StepHome), RESET(HomeDone), RESET(GoPick), RESET(AtPick), RESET(Gripped), RESET(GoDrop), RESET(AtDrop), RESET(GoHome) )
NW 20 "Hata reset (MC_Reset yerine)": SERIES( NO(Powered), P_TRIG(FaultReset), NC(HomeDone), SET(StepHome) )`

// ---- What gemini-3.5-flash wrote for the robot cell (fifth log, accepted with 21 checks) ----
const ROBOT_CELL_FROM_LOG = `TAG Sens_PartIn %I0.0 BOOL "x"
TAG Sens_CellIn %I0.1 BOOL "x"
TAG Sens_PartOut %I0.2 BOOL "x"
TAG Sens_FixtFwd %I0.3 BOOL "x"
TAG Sens_FixtRev %I0.4 BOOL "x"
TAG Mode_Auto %I0.5 BOOL "x"
TAG Btn_CycleStart %I0.6 BOOL "x"
TAG Safety_OK %I0.7 BOOL "x"
TAG R1_Req %I1.0 BOOL "x"
TAG R1_DoneHome %I1.1 BOOL "x"
TAG R2_Req %I1.2 BOOL "x"
TAG R2_DoneHome %I1.3 BOOL "x"
TAG Btn_FaultReset %I1.4 BOOL "x"
TAG Valv_FixtFwd %Q0.0 BOOL "x"
TAG Valv_FixtRev %Q0.1 BOOL "x"
TAG Mot_OutConv %Q0.2 BOOL "x"
TAG Lamp_Green %Q0.3 BOOL "x"
TAG Siren_Fault %Q0.4 BOOL "x"
TAG R1_Permit %Q1.0 BOOL "x"
TAG R1_Trigger %Q1.1 BOOL "x"
TAG R2_Permit %M2.0 BOOL "x"
TAG R2_Trigger %M2.1 BOOL "x"
TAG Sys_Ready %M10.0 BOOL "x"
TAG Cycle_Done %M10.1 BOOL "x"
TAG Step_1 %M0.1 BOOL "x"
TAG Step_2 %M0.2 BOOL "x"
TAG Step_3 %M0.3 BOOL "x"
TAG Step_4 %M0.4 BOOL "x"
TAG R1_Busy %M2.2 BOOL "x"
TAG R2_Busy %M2.3 BOOL "x"
NW 1 "a": SERIES( NO(Mode_Auto), NO(Safety_OK), NC(Siren_Fault), NO(Sens_FixtRev), NO(R1_DoneHome), NO(R2_DoneHome), COIL(Sys_Ready), COIL(Lamp_Green) )
NW 2 "b": SERIES( NO(Sys_Ready), NO(Btn_CycleStart), NO(Sens_PartIn), SET(Step_1) )
NW 3 "c": SERIES( NO(Step_1), NO(Sens_FixtFwd), TON(T_Clamp, PT=T#2s) )
NW 4 "d": SERIES( NO(Step_1), NC(Valv_FixtRev), COIL(Valv_FixtFwd) )
NW 5 "e": SERIES( NO(Step_1), NO(T_Clamp.Q), SET(Step_2), RESET(Step_1) )
NW 6 "f": SERIES( NO(Step_2), NO(R1_Req), NC(R2_Permit), COIL(R1_Permit), TP(T_R1Start, PT=T#1s), COIL(R1_Trigger) )
NW 7 "g": SERIES( NO(Step_2), NC(R1_DoneHome), SET(R1_Busy) )
NW 8 "h": SERIES( NO(Step_2), NO(R1_Busy), NO(R1_DoneHome), SET(Step_3), RESET(R1_Busy), RESET(Step_2) )
NW 9 "i": SERIES( NO(Step_3), NO(R2_Req), NC(R1_Permit), COIL(R2_Permit), COIL(R2_Trigger) )
NW 10 "j": SERIES( NO(Step_3), NC(R2_DoneHome), SET(R2_Busy) )
NW 11 "k": SERIES( NO(Step_3), NO(R2_Busy), NO(R2_DoneHome), SET(Step_4), RESET(R2_Busy), RESET(Step_3) )
NW 12 "l": SERIES( NO(Step_4), NC(Valv_FixtFwd), COIL(Valv_FixtRev) )
NW 13 "m": SERIES( NO(Step_4), NO(Sens_FixtRev), COIL(Mot_OutConv) )
NW 14 "n": SERIES( NO(Step_4), N_TRIG(Sens_PartOut), SET(Cycle_Done), RESET(Step_4) )
NW 15 "o": SERIES( NO(Step_1), NC(Sens_FixtFwd), TON(T_Fault, PT=T#5s) )
NW 16 "p": SERIES( PARALLEL( NO(T_Fault.Q), NC(Safety_OK) ), SET(Siren_Fault), RESET(Step_1), RESET(Step_2), RESET(Step_3), RESET(Step_4), RESET(R1_Busy), RESET(R2_Busy) )
NW 17 "q": SERIES( NO(Btn_FaultReset), RESET(Siren_Fault), RESET(Cycle_Done) )`

// ---- What gemini-3.5-flash wrote for the pick & place axis (sixth log, accepted with 2 checks) ----
const PICK_PLACE_FROM_LOG = `TAG Sens_DriveReady %I0.0 BOOL "x"
TAG Sens_RobotDone %I0.1 BOOL "x"
TAG Sens_ConvEmpty %I0.2 BOOL "x"
TAG Sens_GripperOpen %I0.3 BOOL "x"
TAG Sens_GripperClosed %I0.4 BOOL "x"
TAG Btn_Start %I0.5 BOOL "x"
TAG Safety_Estop %I0.6 BOOL "x"
TAG Btn_Reset %I0.7 BOOL "x"
TAG Valv_GripperOpen %Q0.0 BOOL "x"
TAG Valv_GripperClose %Q0.1 BOOL "x"
TAG Lamp_CellActive %Q0.2 BOOL "x"
TAG Axis_Powered %M10.0 BOOL "x"
TAG Step_Home %M20.0 BOOL "x"
TAG Step_HomeDone %M20.1 BOOL "x"
TAG Step_GoPick %M20.2 BOOL "x"
TAG Step_AtPick %M20.3 BOOL "x"
TAG Step_Grip %M20.4 BOOL "x"
TAG Step_GoDrop %M20.5 BOOL "x"
TAG Step_AtDrop %M20.6 BOOL "x"
TAG Step_HomeReturn %M20.7 BOOL "x"
NW 1 "a": SERIES(NO(Safety_Estop), NO(Sens_DriveReady), COIL(Axis_Powered))
NW 2 "b": SERIES(NO(Axis_Powered), P_TRIG(Btn_Start), NC(Step_HomeDone), SET(Step_Home))
NW 3 "c": SERIES(NO(Step_Home), SET(Step_HomeDone), RESET(Step_Home))
NW 4 "d": SERIES(NO(Step_HomeDone), NO(Sens_RobotDone), P_TRIG(Btn_Start), SET(Step_GoPick))
NW 5 "e": SERIES(NO(Step_GoPick), SET(Step_AtPick), RESET(Step_GoPick))
NW 6 "f": SERIES(NO(Step_AtPick), COIL(Valv_GripperClose))
NW 7 "g": SERIES(NO(Step_AtPick), NO(Sens_GripperClosed), TON(T1, PT=T#1S))
NW 8 "h": SERIES(NO(T1.Q), SET(Step_Grip), RESET(Step_AtPick))
NW 9 "i": SERIES(NO(Step_Grip), NO(Sens_ConvEmpty), SET(Step_GoDrop))
NW 10 "j": SERIES(NO(Step_GoDrop), SET(Step_AtDrop), RESET(Step_GoDrop))
NW 11 "k": SERIES(NO(Step_AtDrop), COIL(Valv_GripperOpen))
NW 12 "l": SERIES(NO(Step_AtDrop), NO(Sens_GripperOpen), SET(Step_HomeReturn))
NW 13 "m": SERIES(NO(Step_HomeReturn), RESET(Step_HomeDone), RESET(Step_Grip), RESET(Step_AtDrop), RESET(Step_HomeReturn), COIL(Lamp_CellActive))
NW 14 "n": SERIES(NC(Safety_Estop), RESET(Step_Home), RESET(Step_HomeDone), RESET(Step_GoPick), RESET(Step_AtPick), RESET(Step_Grip), RESET(Step_GoDrop), RESET(Step_AtDrop), RESET(Step_HomeReturn))`

// ---- What gemini-3.5-flash wrote for the pick & place axis (seventh log, accepted with 18 checks) ----
const PICK_PLACE_SEVENTH_LOG = `TAG Driver_Ready %I0.0 BOOL "x"
TAG Robot_Done %I0.1 BOOL "x"
TAG Conveyor_Empty %I0.2 BOOL "x"
TAG Gripper_Open_Sens %I0.3 BOOL "x"
TAG Gripper_Close_Sens %I0.4 BOOL "x"
TAG Cycle_Start %I0.5 BOOL "x"
TAG E_Stop %I0.6 BOOL "x"
TAG Fault_Reset %I0.7 BOOL "x"
TAG Gripper_Open_Valf %Q0.0 BOOL "x"
TAG Gripper_Close_Valf %Q0.1 BOOL "x"
TAG Cell_Running_Lamp %Q0.2 BOOL "x"
TAG Axis_Powered %M10.0 BOOL "x"
TAG Fault_Active %M10.1 BOOL "x"
TAG Step_Home_Start %M20.0 BOOL "x"
TAG Step_Home_Done %M20.1 BOOL "x"
TAG Step_Go_Pick %M20.2 BOOL "x"
TAG Step_At_Pick %M20.3 BOOL "x"
TAG Step_Part_Grip %M20.4 BOOL "x"
TAG Step_Go_Drop %M20.5 BOOL "x"
TAG Step_At_Drop %M20.6 BOOL "x"
TAG Step_Go_Home %M20.7 BOOL "x"
NW 1 "a": SERIES(NO(E_Stop), NO(Driver_Ready), COIL(Axis_Powered), COIL(Cell_Running_Lamp))
NW 2 "b": SERIES(NO(Axis_Powered), NC(Step_Home_Done), NO(Cycle_Start), SET(Step_Home_Start))
NW 3 "c": SERIES(NO(Step_Home_Start), TON(T_Home, PT=T#1S))
NW 4 "d": SERIES(NO(T_Home.Q), SET(Step_Home_Done), RESET(Step_Home_Start))
NW 5 "e": SERIES(NO(Axis_Powered), NO(Step_Home_Done), NO(Robot_Done), NC(Step_At_Pick), SET(Step_Go_Pick))
NW 6 "f": SERIES(NO(Step_Go_Pick), TON(T_MovePick, PT=T#1S))
NW 7 "g": SERIES(NO(T_MovePick.Q), SET(Step_At_Pick), RESET(Step_Go_Pick))
NW 8 "h": SERIES(NO(Step_At_Pick), COIL(Gripper_Close_Valf))
NW 9 "i": SERIES(NO(Step_At_Pick), NO(Gripper_Close_Sens), TON(T_Grip, PT=T#1S))
NW 10 "j": SERIES(NO(T_Grip.Q), SET(Step_Part_Grip), RESET(Step_At_Pick))
NW 11 "k": SERIES(NO(Axis_Powered), NO(Step_Part_Grip), NO(Conveyor_Empty), NC(Step_At_Drop), SET(Step_Go_Drop))
NW 12 "l": SERIES(NO(Step_Go_Drop), TON(T_MoveDrop, PT=T#1S))
NW 13 "m": SERIES(NO(T_MoveDrop.Q), SET(Step_At_Drop), RESET(Step_Go_Drop), RESET(Step_Part_Grip))
NW 14 "n": SERIES(NO(Step_At_Drop), COIL(Gripper_Open_Valf))
NW 15 "o": SERIES(NO(Step_At_Drop), NO(Gripper_Open_Sens), SET(Step_Go_Home))
NW 16 "p": SERIES(NO(Step_Go_Home), TON(T_MoveHome, PT=T#1S))
NW 17 "q": SERIES(NO(T_MoveHome.Q), RESET(Step_At_Drop), RESET(Step_Go_Home))
NW 18 "r": SERIES(PARALLEL(NC(E_Stop), NO(Fault_Reset)), COIL(Fault_Active))
NW 19 "s": SERIES(NO(Fault_Active), RESET(Step_Home_Start), RESET(Step_Go_Pick), RESET(Step_At_Pick), RESET(Step_Part_Grip), RESET(Step_Go_Drop), RESET(Step_At_Drop), RESET(Step_Go_Home))`


// ---- Correct circuits for the textbook scenarios ----
const MOTOR_REFERENCE = `TAG Start %I0.0 BOOL "Start"
TAG Stop %I0.1 BOOL "Stop (NC)"
TAG Thermal %I0.2 BOOL "Termik (NC)"
TAG Reset %I0.3 BOOL "Ariza reset"
TAG Motor %Q0.0 BOOL "Motor"
TAG Fault %Q0.1 BOOL "Ariza lambasi"
TAG RunLamp %Q0.2 BOOL "Calisiyor lambasi"
NW 1 "Termik": SERIES( NC(Thermal), SET(Fault) )
NW 2 "Reset": SERIES( NO(Reset), NO(Thermal), RESET(Fault) )
NW 3 "Motor": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), NO(Thermal), NC(Fault), COIL(Motor) )
NW 4 "Lamba": SERIES( NO(Motor), COIL(RunLamp) )`

const TRAFFIC_REFERENCE = `TAG On %I0.0 BOOL "Sistem acik"
TAG Red %Q0.0 BOOL "Kirmizi"
TAG Yellow %Q0.1 BOOL "Sari"
TAG Green %Q0.2 BOOL "Yesil"
NW 1 "Kirmizi suresi": SERIES( NO(On), NC(T4.Q), TON(T1, PT=T#6S) )
NW 2 "Kirmizi sari": SERIES( NO(T1.Q), TON(T2, PT=T#2S) )
NW 3 "Yesil": SERIES( NO(T2.Q), TON(T3, PT=T#6S) )
NW 4 "Sari": SERIES( NO(T3.Q), TON(T4, PT=T#3S) )
NW 5 "Kirmizi lamba": SERIES( NO(On), NC(T2.Q), COIL(Red) )
NW 6 "Sari lamba": SERIES( PARALLEL( SERIES( NO(T1.Q), NC(T2.Q) ), SERIES( NO(T3.Q), NC(T4.Q) ) ), COIL(Yellow) )
NW 7 "Yesil lamba": SERIES( NO(T2.Q), NC(T3.Q), COIL(Green) )`

const TANK_REFERENCE = `TAG Low %I0.0 BOOL "Alt seviye"
TAG High %I0.1 BOOL "Ust seviye"
TAG Auto %I0.2 BOOL "Otomatik"
TAG Reset %I0.3 BOOL "Alarm reset"
TAG Pump %Q0.0 BOOL "Pompa"
TAG Alarm %Q0.1 BOOL "Alarm"
NW 1 "Pompa": SERIES( NO(Auto), NC(High), NC(Alarm), PARALLEL( NC(Low), NO(Pump) ), COIL(Pump) )
NW 2 "Kuru calisma": SERIES( NO(Pump), NC(Low), TON(T_Dry, PT=T#10S) )
NW 3 "Alarm": SERIES( NO(T_Dry.Q), SET(Alarm) )
NW 4 "Reset": SERIES( NO(Reset), RESET(Alarm) )`

const STAR_DELTA_REFERENCE = `TAG Start %I0.0 BOOL "Start"
TAG Stop %I0.1 BOOL "Stop (NC)"
TAG Thermal %I0.2 BOOL "Termik (NC)"
TAG K1 %Q0.0 BOOL "Ana"
TAG K2 %Q0.1 BOOL "Yildiz"
TAG K3 %Q0.2 BOOL "Ucgen"
NW 1 "K1": SERIES( PARALLEL( NO(Start), NO(K1) ), NO(Stop), NO(Thermal), COIL(K1) )
NW 2 "Yildiz suresi": SERIES( NO(K1), TON(T_Star, PT=T#5S) )
NW 3 "K2": SERIES( NO(K1), NC(T_Star.Q), NC(K3), COIL(K2) )
NW 4 "Gecis": SERIES( NO(K1), NO(T_Star.Q), NC(K2), TON(T_Pause, PT=T#500MS) )
NW 5 "K3": SERIES( NO(K1), NO(T_Pause.Q), NC(K2), COIL(K3) )`

const CAR_PARK_REFERENCE = `TAG InS %I0.0 BOOL "Giris"
TAG OutS %I0.1 BOOL "Cikis"
TAG Rst %I0.2 BOOL "Reset"
TAG Free %Q0.0 BOOL "Yesil"
TAG Full %Q0.1 BOOL "Dolu"
TAG DownOk %M10.0 BOOL "Azaltilabilir"
NW 1 "Sayac": SERIES( NO(InS), CTUD(C_Park, PV=3, CD=DownOk, R=Rst) )
NW 2 "Sifirin alti yok": SERIES( NO(OutS), CMP_GT(C_Park.CV, 0), COIL(DownOk) )
NW 3 "Dolu": SERIES( NO(C_Park.QU), COIL(Full) )
NW 4 "Yesil": SERIES( NC(C_Park.QU), COIL(Free) )`

function main(): void {
  // ---- Every check has a valid timeline ----
  for (const scenario of SCENARIOS) {
    for (const check of scenario.checks) {
      const test = testForCheck(scenario, check.id)
      assert.ok(test, `${scenario.id}/${check.id} has a timeline`)
      assert.deepStrictEqual(parseBehaviorTest(test).problems, [], `${scenario.id}/${check.id}`)
    }
  }
  ok('Every check of every scenario has a valid timeline')

  // ---- A correct circuit passes everything ----
  for (const [scenario, dsl] of [
    [ROBOT_CELL, ROBOT_CELL_REFERENCE],
    [PICK_AND_PLACE, PICK_PLACE_REFERENCE]
  ] as const) {
    const results = evaluateScenario(scenario, project(dsl))
    const failed = results.filter((r) => !r.passed)
    assert.strictEqual(failed.length, 0, formatReport(scenario, results))
  }
  ok('A circuit written from the specification passes every check of both scenarios')

  for (const [scenario, dsl] of [
    [MOTOR_START_STOP, MOTOR_REFERENCE],
    [TRAFFIC_LIGHT, TRAFFIC_REFERENCE],
    [TANK_FILL, TANK_REFERENCE],
    [STAR_DELTA, STAR_DELTA_REFERENCE],
    [CAR_PARK, CAR_PARK_REFERENCE]
  ] as const) {
    const results = evaluateScenario(scenario, project(dsl))
    assert.ok(results.every((r) => r.passed), formatReport(scenario, results))
  }
  ok('A circuit written from the specification passes every check of the five textbook scenarios')

  // ---- The checks catch a typical mistake each, and an empty program passes none ----
  const EMPTY = 'TAG X %I0.7 BOOL "x"\nTAG Y %Q0.7 BOOL "y"\nNW 1 "x": SERIES( NO(X), COIL(Y) )'
  for (const scenario of [MOTOR_START_STOP, TRAFFIC_LIGHT, TANK_FILL, STAR_DELTA, CAR_PARK]) {
    const passedByEmpty = evaluateScenario(scenario, project(EMPTY)).filter((r) => r.passed)
    assert.deepStrictEqual(passedByEmpty.map((r) => r.check.id), [], `${scenario.id}: an empty program passes nothing`)
  }
  const mutant = (from: string, a: string, b: string): string => {
    assert.ok(from.includes(a), a)
    return from.replace(a, b)
  }
  assert.deepStrictEqual(failedIds(MOTOR_START_STOP, mutant(MOTOR_REFERENCE, 'NC(Fault), COIL(Motor)', 'COIL(Motor)')), ['blocked', 'reset'])
  assert.deepStrictEqual(
    failedIds(TANK_FILL, mutant(TANK_REFERENCE, 'PARALLEL( NC(Low), NO(Pump) )', 'NC(Low)')),
    ['hysteresis', 'stopHigh', 'stayOff']
  )
  assert.deepStrictEqual(failedIds(STAR_DELTA, mutant(STAR_DELTA_REFERENCE, 'TON(T_Pause, PT=T#500MS)', 'TON(T_Pause, PT=T#10MS)')), ['pause'])
  assert.deepStrictEqual(
    failedIds(TRAFFIC_LIGHT, mutant(TRAFFIC_REFERENCE, 'SERIES( NO(On), NC(T4.Q), TON(T1', 'SERIES( NC(T4.Q), TON(T1')),
    ['off', 'restart']
  )
  // As on the CPU, CTUD counts below 0, so a count-down straight from the exit sensor goes negative
  assert.deepStrictEqual(failedIds(CAR_PARK, mutant(CAR_PARK_REFERENCE, 'CD=DownOk', 'CD=OutS')), ['noNegative'])
  ok('Each textbook check catches a typical mistake, and an empty program passes none of them')

  // ---- The robot cell from the log: right sequence, Robot 2 on M bits, fixture released early ----
  assert.deepStrictEqual(failedIds(ROBOT_CELL, ROBOT_CELL_FROM_LOG).sort(), ['estopTrigger', 'hold', 'pulse', 'r2', 'writes'])
  ok('The accepted robot cell fails where it differs: Robot 2 on M2.0/M2.1, latched Cycle_Done, fixture released early')

  // ---- The pick & place from the log: no motion time, re-homes, lamp for one scan, reset never read ----
  assert.deepStrictEqual(
    failedIds(PICK_AND_PLACE, PICK_PLACE_FROM_LOG).sort(),
    ['carry', 'drop', 'grip', 'home', 'idle', 'lamp', 'pick', 'reads', 'release', 'reset']
  )
  ok('The accepted pick & place fails where it differs: instant moves, re-homing, extra Start, unused reset')

  // ---- The seventh log: moves take time now. E-stop keeps "homed", reset only stops, a held done signal restarts the pick ----
  assert.deepStrictEqual(failedIds(PICK_AND_PLACE, PICK_PLACE_SEVENTH_LOG).sort(), ['carry', 'estop', 'lamp', 'oneStep', 'reset'])
  ok('The seventh pick & place fails where it differs: E-stop keeps M20.1, reset does not home, held done restarts the pick')

  // ---- A network written without SERIES gets an error that says so ----
  const unwrapped = LadderDslCompiler.compileLadderDslToAst('NW 1 "x": PARALLEL(NC(A), NO(B)), COIL(C)')
  assert.strictEqual(unwrapped.errors.length, 1, unwrapped.errors.join('\n'))
  assert.ok(unwrapped.errors[0].includes('Put them in SERIES: SERIES( PARALLEL(NC(A), NO(B)), COIL(C) )'), unwrapped.errors[0])
  ok('A network written as a list without SERIES is told to use SERIES, not to wrap its coil in NO()')

  // ---- A diagnostic dump is read as the project it describes ----
  const reference = project(PICK_PLACE_REFERENCE)
  const dump = [
    '=== RUNGLINE BLACK-BOX DIAGNOSTIC DUMP ===',
    '## 2. ACTIVE OB1_MAIN LADDER AST',
    '```json',
    JSON.stringify(reference.ladBlocks[0], null, 2),
    '```',
    '## 3. S7 TAG TABLE (SYMBOL TABLE)',
    '```json',
    JSON.stringify(reference.tagTables, null, 2),
    '```',
    '## 4. SOFTPCL RUNTIME STATE'
  ].join('\n')
  const fromDump = evaluateScenario(PICK_AND_PLACE, projectFromDump(dump, demo))
  assert.ok(fromDump.every((r) => r.passed), formatReport(PICK_AND_PLACE, fromDump))
  assert.ok(/Spesifikasyon: 11\/11 geçti, yorum: 3\/3 geçti/.test(formatReport(PICK_AND_PLACE, fromDump)), formatReport(PICK_AND_PLACE, fromDump))
  ok('A diagnostic dump is checked as the project it describes')

  console.log(`\nPhase 22: ${passed} passed, 0 failed\n`)
}

main()
