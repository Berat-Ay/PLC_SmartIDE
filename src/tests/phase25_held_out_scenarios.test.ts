/**
 * Held-out scenarios: a circuit written from each specification passes every check, an empty program passes
 * none, typical mistakes are caught, and each prompt is recognised as its scenario. These scenarios must not
 * be used to tune the agent (see heldOutScenarios.ts); this test only shows that they are fair.
 */
import assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { normalizeAiGeneratedNetworks } from '../renderer/src/services/ai/AiModelRouter'
import { LadderDslCompiler } from '../renderer/src/services/compiler/LadderDslCompiler'
import { BOTTLE_FILLING, GARAGE_DOOR, HEATER_FAN, HELD_OUT_SCENARIOS } from '../renderer/src/services/scenarios/heldOutScenarios'
import { SCENARIOS } from '../renderer/src/services/scenarios/scenarios'
import {
  evaluateScenario,
  formatReport,
  matchScenario,
  projectFromCircuit,
  Scenario,
  testForCheck
} from '../renderer/src/services/scenarios/ScenarioAcceptance'

console.log('\n=== PHASE 25: HELD-OUT SCENARIOS ===\n')

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
const failedIds = (scenario: Scenario, dsl: string): string[] =>
  evaluateScenario(scenario, project(dsl))
    .filter((r) => !r.passed)
    .map((r) => r.check.id)
    .sort()
const mutant = (from: string, a: string, b: string): string => {
  assert.ok(from.includes(a), a)
  return from.replace(a, b)
}

const GARAGE_REFERENCE = `TAG Open %I0.0 BOOL "Ac"
TAG Close %I0.1 BOOL "Kapat"
TAG Stop %I0.2 BOOL "Dur (NC)"
TAG LimOpen %I0.3 BOOL "Acik limit"
TAG LimClosed %I0.4 BOOL "Kapali limit"
TAG Photo %I0.5 BOOL "Fotosel, yol bosken 1"
TAG MotorOpen %Q0.0 BOOL "Acma yonu"
TAG MotorClose %Q0.1 BOOL "Kapama yonu"
TAG Lamp %Q0.2 BOOL "Uyari lambasi"
TAG Reverse %M10.0 BOOL "Engel: tamamen ac"
NW 1 "Engel": SERIES( NO(MotorClose), NC(Photo), SET(Reverse) )
NW 2 "Engel bitti": SERIES( PARALLEL( NO(LimOpen), NC(Stop) ), RESET(Reverse) )
NW 3 "Ac": SERIES( PARALLEL( NO(Open), NO(Reverse), NO(MotorOpen) ), NO(Stop), NC(LimOpen), NC(MotorClose), COIL(MotorOpen) )
NW 4 "Otomatik kapanma": SERIES( NO(LimOpen), NO(Photo), TON(T_Auto, PT=T#10s) )
NW 5 "Kapat": SERIES( PARALLEL( NO(Close), NO(T_Auto.Q), NO(MotorClose) ), NO(Stop), NC(LimClosed), NO(Photo), NC(MotorOpen), COIL(MotorClose) )
NW 6 "Lamba": SERIES( PARALLEL( NO(MotorOpen), NO(MotorClose) ), COIL(Lamp) )`

const BOTTLE_REFERENCE = `TAG Start %I0.0 BOOL "Start"
TAG Stop %I0.1 BOOL "Stop (NC)"
TAG EStop %I0.2 BOOL "Acil stop (NC)"
TAG Reset %I0.3 BOOL "Reset"
TAG Bottle %I0.4 BOOL "Sise sensoru"
TAG Conveyor %Q0.0 BOOL "Konveyor"
TAG Valve %Q0.1 BOOL "Dolum valfi"
TAG BoxFull %Q0.2 BOOL "Kutu dolu"
TAG Fault %Q0.3 BOOL "Ariza"
TAG Run %M10.0 BOOL "Hat calisiyor"
TAG Filling %M10.1 BOOL "Dolum adimi"
NW 1 "Acil stop hatasi": SERIES( NC(EStop), SET(Fault) )
NW 2 "Hata reset": SERIES( NO(Reset), NO(EStop), RESET(Fault) )
NW 3 "Hat": SERIES( PARALLEL( NO(Start), NO(Run) ), NO(Stop), NO(EStop), NC(Fault), NC(BoxFull), COIL(Run) )
NW 4 "Dolum iptal": SERIES( NC(Run), RESET(Filling) )
NW 5 "Dolum basla": SERIES( NO(Run), P_TRIG(Bottle), SET(Filling) )
NW 6 "Dolum suresi": SERIES( NO(Filling), TON(T_Fill, PT=T#3s) )
NW 7 "Say": SERIES( NO(T_Fill.Q), CTU(C_Box, PV=4, R=Reset) )
NW 8 "Dolum bitti": SERIES( NO(T_Fill.Q), RESET(Filling) )
NW 9 "Kutu dolu": SERIES( NO(C_Box.QU), COIL(BoxFull) )
NW 10 "Konveyor": SERIES( NO(Run), NC(Filling), NC(BoxFull), COIL(Conveyor) )
NW 11 "Valf": SERIES( NO(Run), NO(Filling), COIL(Valve) )`

const HEATER_REFERENCE = `TAG Start %I0.0 BOOL "Start"
TAG Stop %I0.1 BOOL "Stop (NC)"
TAG Demand %I0.2 BOOL "Oda termostati"
TAG OverTemp %I0.3 BOOL "Asiri sicaklik (NC)"
TAG Reset %I0.4 BOOL "Reset"
TAG Fan %Q0.0 BOOL "Fan"
TAG Heater %Q0.1 BOOL "Isitici"
TAG Fault %Q0.2 BOOL "Ariza"
TAG Run %M10.0 BOOL "Sistem calisiyor"
NW 1 "Asiri sicaklik": SERIES( NC(OverTemp), SET(Fault) )
NW 2 "Reset": SERIES( NO(Reset), NO(OverTemp), RESET(Fault) )
NW 3 "Sistem": SERIES( PARALLEL( NO(Start), NO(Run) ), NO(Stop), NC(Fault), COIL(Run) )
NW 4 "Fan art calisma": SERIES( NO(Run), TOF(T_After, PT=T#5s) )
NW 5 "Fan": SERIES( NO(T_After.Q), COIL(Fan) )
NW 6 "On havalandirma": SERIES( NO(Run), TON(T_Purge, PT=T#3s) )
NW 7 "Isitici": SERIES( NO(Run), NO(T_Purge.Q), NO(Demand), NO(OverTemp), COIL(Heater) )`

const EMPTY = 'NW 1 "Bos": SERIES( NO(%I0.0), COIL(%M10.0) )'

function main(): void {
  // ---- Every check has one timeline, and every prompt is its scenario ----
  for (const scenario of HELD_OUT_SCENARIOS) {
    assert.ok(scenario.heldOut, scenario.id)
    for (const check of scenario.checks) {
      assert.ok(testForCheck(scenario, check.id), `${scenario.id}.${check.id} has a timeline`)
      const paths = scenario.paths.filter((p) => p.some((s) => s.expect?.[check.id]))
      assert.strictEqual(paths.length, 1, `${scenario.id}.${check.id} is checked in exactly one path`)
    }
    const prompt = fs.readFileSync(path.resolve('src/renderer/src/services/scenarios/prompts', `${scenario.id}.txt`), 'utf-8')
    assert.strictEqual(matchScenario(prompt, SCENARIOS).scenario?.id, scenario.id)
  }
  ok('Every held-out check has one timeline, and every held-out prompt is recognised as its scenario')

  // ---- A circuit written from the specification passes everything; an empty one passes nothing ----
  for (const [scenario, dsl] of [
    [GARAGE_DOOR, GARAGE_REFERENCE],
    [BOTTLE_FILLING, BOTTLE_REFERENCE],
    [HEATER_FAN, HEATER_REFERENCE]
  ] as const) {
    const results = evaluateScenario(scenario, project(dsl))
    assert.strictEqual(results.filter((r) => !r.passed).length, 0, formatReport(scenario, results))
    const passedByEmpty = evaluateScenario(scenario, project(EMPTY)).filter((r) => r.passed)
    assert.deepStrictEqual(passedByEmpty.map((r) => r.check.id), [], `${scenario.id}: an empty program passes nothing`)
  }
  ok('A circuit written from each held-out specification passes every check, and an empty program passes none')

  // ---- Typical mistakes are caught where they are ----
  // Reset that restarts the machine by itself
  assert.deepStrictEqual(
    failedIds(HEATER_FAN, mutant(HEATER_REFERENCE, 'NW 2 "Reset": SERIES( NO(Reset), NO(OverTemp), RESET(Fault) )', 'NW 2 "Reset": SERIES( NO(Reset), NO(OverTemp), RESET(Fault), SET(Run) )')),
    ['faultReset']
  )
  assert.deepStrictEqual(
    failedIds(BOTTLE_FILLING, mutant(BOTTLE_REFERENCE, 'NW 2 "Hata reset": SERIES( NO(Reset), NO(EStop), RESET(Fault) )', 'NW 2 "Hata reset": SERIES( NO(Reset), NO(EStop), RESET(Fault), SET(Run) )')),
    ['boxReset', 'faultReset']
  )
  // A fill step that is never left blocks the line
  assert.ok(failedIds(BOTTLE_FILLING, mutant(BOTTLE_REFERENCE, 'NW 8 "Dolum bitti": SERIES( NO(T_Fill.Q), RESET(Filling) )\n', '')).includes('fill'))
  // A heater that does not wait for the fan
  assert.deepStrictEqual(failedIds(HEATER_FAN, mutant(HEATER_REFERENCE, 'NO(T_Purge.Q), ', '')), ['purge'])
  // A fan that stops with the system
  assert.deepStrictEqual(failedIds(HEATER_FAN, mutant(HEATER_REFERENCE, 'TOF(T_After', 'TON(T_After')).includes('afterRun'), true)
  // A door whose photocell only stops it
  assert.deepStrictEqual(failedIds(GARAGE_DOOR, mutant(GARAGE_REFERENCE, 'NW 1 "Engel": SERIES( NO(MotorClose), NC(Photo), SET(Reverse) )\n', '')), ['photoReverse'])
  // A door whose closing does not look at the photocell
  assert.ok(failedIds(GARAGE_DOOR, mutant(GARAGE_REFERENCE, 'NO(Photo), NC(MotorOpen)', 'NC(MotorOpen)')).includes('photoBlock'))
  // Without the direction interlock, Open reverses a closing door
  assert.ok(failedIds(GARAGE_DOOR, mutant(GARAGE_REFERENCE, ', NC(MotorClose), COIL(MotorOpen)', ', COIL(MotorOpen)')).includes('reverseIgnored'))
  ok('Each held-out scenario catches the typical mistakes: reset that restarts, a step never left, no interlock, no purge')

  console.log(`\nPhase 25: ${passed} passed, 0 failed\n`)
}

main()
