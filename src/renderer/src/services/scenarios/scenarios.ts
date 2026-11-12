/**
 * The scenarios the user tested the agent with, as acceptance tests. Addresses are the specification's own.
 * Times leave room: a check waits at least 100 ms after an input changes, and a stand-in for a missing motion
 * block may take up to 9 s.
 */
import { PathStep, Scenario } from './ScenarioAcceptance'
import { TEXTBOOK_SCENARIOS } from './textbookScenarios'
import { HELD_OUT_SCENARIOS } from './heldOutScenarios'

// ---------------- Robot welding cell with two robots ----------------
const RC = {
  PartIn: '%I0.0',
  CellIn: '%I0.1',
  PartOut: '%I0.2',
  FixtFwd: '%I0.3',
  FixtRev: '%I0.4',
  Auto: '%I0.5',
  Start: '%I0.6',
  SafetyOK: '%I0.7',
  R1Req: '%I1.0',
  R1Home: '%I1.1',
  R2Req: '%I1.2',
  R2Home: '%I1.3',
  Reset: '%I1.4',
  ValveFwd: '%Q0.0',
  ValveRev: '%Q0.1',
  Conveyor: '%Q0.2',
  Siren: '%Q0.4',
  R1Permit: '%Q1.0',
  R1Start: '%Q1.1',
  R2Permit: '%Q1.2',
  R2Start: '%Q1.3',
  Ready: '%M10.0',
  CycleDone: '%M10.1'
}

/** The cell at rest: automatic, safe, fixture open, both robots home */
const cellAtRest = {
  [RC.Auto]: true,
  [RC.SafetyOK]: true,
  [RC.FixtRev]: true,
  [RC.FixtFwd]: false,
  [RC.R1Home]: true,
  [RC.R2Home]: true,
  [RC.PartIn]: false,
  [RC.CellIn]: false,
  [RC.PartOut]: false,
  [RC.Start]: false,
  [RC.R1Req]: false,
  [RC.R2Req]: false,
  [RC.Reset]: false
}

const readyPath: PathStep[] = [
  { atMs: 0, set: cellAtRest },
  { atMs: 100, expect: { ready: { [RC.Ready]: true } } },
  { atMs: 200, set: { [RC.R1Home]: false } },
  { atMs: 300, expect: { ready: { [RC.Ready]: false } } },
  { atMs: 400, set: { [RC.R1Home]: true } },
  { atMs: 500, expect: { ready: { [RC.Ready]: true } } },
  { atMs: 600, set: { [RC.R2Home]: false } },
  { atMs: 700, expect: { ready: { [RC.Ready]: false } } },
  { atMs: 800, set: { [RC.R2Home]: true } },
  { atMs: 900, expect: { ready: { [RC.Ready]: true } } },
  { atMs: 1000, set: { [RC.FixtRev]: false } },
  { atMs: 1100, expect: { ready: { [RC.Ready]: false } } },
  { atMs: 1200, set: { [RC.FixtRev]: true } },
  { atMs: 1300, expect: { ready: { [RC.Ready]: true } } },
  { atMs: 1400, set: { [RC.Auto]: false } },
  { atMs: 1500, expect: { ready: { [RC.Ready]: false } } },
  { atMs: 1600, set: { [RC.Auto]: true } },
  { atMs: 1700, expect: { ready: { [RC.Ready]: true } } },
  // Start without a part, and with a part but not ready, starts nothing
  { atMs: 1800, set: { [RC.Start]: true } },
  { atMs: 1900, set: { [RC.Start]: false } },
  { atMs: 2000, expect: { start: { [RC.ValveFwd]: false } } },
  { atMs: 2100, set: { [RC.Auto]: false, [RC.PartIn]: true } },
  { atMs: 2200, set: { [RC.Start]: true } },
  { atMs: 2300, set: { [RC.Start]: false } },
  { atMs: 2400, expect: { start: { [RC.ValveFwd]: false } } },
  { atMs: 2500, set: { [RC.Auto]: true } },
  { atMs: 2600, expect: { start: { [RC.ValveFwd]: false } } },
  { atMs: 2700, set: { [RC.Start]: true } },
  { atMs: 2800, set: { [RC.Start]: false } },
  { atMs: 2900, expect: { start: { [RC.ValveFwd]: true } } }
]

const cyclePath: PathStep[] = [
  { atMs: 0, set: cellAtRest },
  { atMs: 100, set: { [RC.PartIn]: true, [RC.Start]: true } },
  { atMs: 200, set: { [RC.Start]: false } },
  { atMs: 300, expect: { start: { [RC.ValveFwd]: true }, clamp: { [RC.ValveFwd]: true, [RC.ValveRev]: false } } },
  // The fixture closes. Robot 1 already asks to come in
  { atMs: 400, set: { [RC.FixtRev]: false, [RC.FixtFwd]: true, [RC.R1Req]: true } },
  { atMs: 2200, expect: { clamp: { [RC.R1Permit]: false } } },
  {
    atMs: 2600,
    expect: { clamp: { [RC.R1Permit]: true }, r1: { [RC.R1Permit]: true, [RC.R1Start]: true }, hold: { [RC.ValveFwd]: true } }
  },
  // Robot 1 moves in. Robot 2 asks too, and must wait
  { atMs: 2700, set: { [RC.R1Home]: false, [RC.R2Req]: true } },
  { atMs: 2800, expect: { interlock: { [RC.R2Permit]: false, [RC.R2Start]: false } } },
  { atMs: 3200, expect: { r1: { [RC.R1Start]: true } } },
  { atMs: 3700, expect: { r1: { [RC.R1Start]: false, [RC.R1Permit]: true }, hold: { [RC.ValveFwd]: true } } },
  // Robot 1 is done and home
  { atMs: 3800, set: { [RC.R1Home]: true, [RC.R1Req]: false } },
  { atMs: 3900, expect: { r1: { [RC.R1Permit]: false } } },
  { atMs: 4000, expect: { r2: { [RC.R2Permit]: true, [RC.R2Start]: true } } },
  { atMs: 4100, set: { [RC.R2Home]: false } },
  { atMs: 4500, expect: { r2: { [RC.R2Permit]: true }, hold: { [RC.ValveFwd]: true }, unload: { [RC.ValveRev]: false } } },
  // Robot 2 is done and home
  { atMs: 4600, set: { [RC.R2Home]: true, [RC.R2Req]: false } },
  { atMs: 4700, expect: { r2: { [RC.R2Permit]: false, [RC.R2Start]: false } } },
  { atMs: 4800, expect: { unload: { [RC.ValveFwd]: false, [RC.ValveRev]: true, [RC.Conveyor]: false } } },
  { atMs: 4900, set: { [RC.FixtFwd]: false, [RC.FixtRev]: true } },
  { atMs: 5000, expect: { unload: { [RC.Conveyor]: true } } },
  // The part passes the exit sensor
  { atMs: 5100, set: { [RC.PartIn]: false, [RC.PartOut]: true } },
  { atMs: 5200, expect: { unload: { [RC.Conveyor]: true } } },
  { atMs: 5300, set: { [RC.PartOut]: false } },
  {
    atMs: 5400,
    expect: {
      unload: { [RC.Conveyor]: false, [RC.ValveRev]: false },
      pulse: { [RC.CycleDone]: false },
      again: { [RC.Ready]: true }
    }
  },
  // The next part
  { atMs: 5500, set: { [RC.PartIn]: true, [RC.Start]: true } },
  { atMs: 5600, set: { [RC.Start]: false } },
  { atMs: 5700, expect: { again: { [RC.ValveFwd]: true } } }
]

const estopPath: PathStep[] = [
  { atMs: 0, set: cellAtRest },
  { atMs: 100, set: { [RC.PartIn]: true, [RC.Start]: true } },
  { atMs: 200, set: { [RC.Start]: false } },
  { atMs: 300, set: { [RC.FixtRev]: false, [RC.FixtFwd]: true, [RC.R1Req]: true } },
  { atMs: 2600, expect: { estop: { [RC.R1Permit]: true } } },
  { atMs: 2700, set: { [RC.SafetyOK]: false } },
  { atMs: 2800, expect: { estop: { [RC.R1Permit]: false, [RC.ValveFwd]: false }, estopTrigger: { [RC.R1Start]: false } } },
  // The safety relay is back and the fixture open: nothing starts by itself
  { atMs: 2900, set: { [RC.SafetyOK]: true, [RC.FixtFwd]: false, [RC.FixtRev]: true, [RC.R1Req]: false } },
  { atMs: 3800, expect: { estop: { [RC.ValveFwd]: false, [RC.R1Permit]: false, [RC.R1Start]: false } } },
  // Reset (in case the E-stop also set the siren), then a new start
  { atMs: 3900, set: { [RC.Reset]: true } },
  { atMs: 4000, set: { [RC.Reset]: false } },
  { atMs: 4100, set: { [RC.Start]: true } },
  { atMs: 4200, set: { [RC.Start]: false } },
  { atMs: 4300, expect: { estop: { [RC.ValveFwd]: true } } }
]

const faultPath: PathStep[] = [
  { atMs: 0, set: cellAtRest },
  { atMs: 100, set: { [RC.PartIn]: true, [RC.Start]: true } },
  { atMs: 200, set: { [RC.Start]: false } },
  // The fixture never reaches the front sensor
  { atMs: 4900, expect: { fault: { [RC.Siren]: false } } },
  { atMs: 5300, expect: { fault: { [RC.Siren]: true, [RC.Ready]: false } } },
  // The operator frees the fixture; the siren stays until Hata Reset. Resetting while the fault is still
  // there is not checked: a circuit may set the siren again at once, as the fault is not fixed.
  { atMs: 5400, set: { [RC.FixtFwd]: true } },
  { atMs: 5600, expect: { fault: { [RC.Siren]: true, [RC.Ready]: false } } },
  { atMs: 5700, set: { [RC.Reset]: true } },
  { atMs: 5800, set: { [RC.Reset]: false } },
  { atMs: 5900, expect: { fault: { [RC.Siren]: false } } }
]

export const ROBOT_CELL: Scenario = {
  id: 'robot-cell',
  matchWords: ['robot', 'fikstür'],
  title: 'İki robotlu kaynak hücresi (sıralayıcı)',
  checks: [
    { id: 'ready', kind: 'spec', title: 'NW1: Sistem_Hazır (M10.0) otomatik, güvenlik, robotlar evde ve fikstür geride iken 1, biri eksikse 0' },
    { id: 'start', kind: 'spec', title: 'NW2: Start yalnızca sistem hazırken ve parça varken çevrimi başlatır' },
    { id: 'clamp', kind: 'spec', title: 'NW3: Q0.0 açılır, Q0.1 kapalı; I0.3 2 s sürmeden Adım 2\'ye geçilmez' },
    { id: 'r1', kind: 'spec', title: 'NW4: Robot 1 izni (Q1.0) ve 1 s start darbesi (Q1.1); Robot 1 iş bitince izin düşer' },
    { id: 'interlock', kind: 'spec', title: 'NW4/5: Robot 1 izinliyken Robot 2 izin almaz (çarpışma kilidi)' },
    { id: 'r2', kind: 'spec', title: 'NW5: Robot 2 izni (Q1.2) ve start (Q1.3); Robot 2 iş bitince Adım 4' },
    { id: 'unload', kind: 'spec', title: 'NW6: Q0.0 kesilir, Q0.1 açılır; I0.4 ile konveyör; I0.2 düşen kenarında konveyör durur' },
    { id: 'pulse', kind: 'spec', title: 'NW6: Çevrim_Bitti (M10.1) anlık olarak 1 olur, kalıcı kalmaz', mustTurnOn: [RC.CycleDone] },
    { id: 'again', kind: 'spec', title: 'NW6: Sistem başa döner, ikinci parça yeni çevrim başlatır' },
    { id: 'estop', kind: 'spec', title: 'NW7: E-stop adımları sıfırlar; güvenlik dönünce kendiliğinden devam etmez' },
    { id: 'fault', kind: 'spec', title: 'NW7: I0.3 5 s içinde gelmezse siren (Q0.4) ve sistem hazır değil; hata giderilince siren Hata Reset\'e kadar kalır, Reset ile söner' },
    { id: 'estopTrigger', kind: 'interpretation', title: 'E-stop anında Robot 1 start tetiği (Q1.1) hemen düşer; TP darbesi süresini tamamlamaz' },
    { id: 'hold', kind: 'interpretation', title: 'Fikstür robotlar çalışırken kapalı kalır (Q0.0, Adım 2–4 boyunca 1)' }
  ],
  paths: [readyPath, cyclePath, estopPath, faultPath],
  mustRead: [RC.PartIn, RC.PartOut, RC.FixtFwd, RC.FixtRev, RC.Auto, RC.Start, RC.SafetyOK, RC.R1Req, RC.R1Home, RC.R2Req, RC.R2Home, RC.Reset],
  mustWrite: [RC.ValveFwd, RC.ValveRev, RC.Conveyor, RC.Siren, RC.R1Permit, RC.R1Start, RC.R2Permit, RC.R2Start, RC.Ready, RC.CycleDone],
  notChecked: [
    'Adım bitleri M0.1–M0.4: bu projede MB0 clock memory, bu yüzden adımlar yalnızca çıkışlarından izleniyor',
    'Yeşil lamba (Q0.3): spesifikasyonda kuralı yok',
    'Parça Hücre İçi sensörü (I0.1): spesifikasyonda kullanılmıyor'
  ]
}

// ---------------- Cartesian pick & place axis ----------------
const PP = {
  DriveReady: '%I0.0',
  RobotDone: '%I0.1',
  ConvEmpty: '%I0.2',
  GripOpen: '%I0.3',
  GripClosed: '%I0.4',
  Start: '%I0.5',
  EStop: '%I0.6',
  Reset: '%I0.7',
  ValveOpen: '%Q0.0',
  ValveClose: '%Q0.1',
  Lamp: '%Q0.2',
  Powered: '%M10.0',
  StepHome: '%M20.0',
  HomeDone: '%M20.1',
  GoPick: '%M20.2',
  AtPick: '%M20.3',
  Gripped: '%M20.4',
  GoDrop: '%M20.5',
  AtDrop: '%M20.6',
  GoHome: '%M20.7'
}

const axisAtRest = {
  [PP.DriveReady]: true,
  [PP.EStop]: true,
  [PP.GripOpen]: true,
  [PP.GripClosed]: false,
  [PP.ConvEmpty]: false,
  [PP.RobotDone]: false,
  [PP.Start]: false,
  [PP.Reset]: false
}

const pickPath: PathStep[] = [
  { atMs: 0, set: axisAtRest },
  { atMs: 100, expect: { power: { [PP.Powered]: true }, lamp: { [PP.Lamp]: false } } },
  { atMs: 200, set: { [PP.Start]: true } },
  { atMs: 300, set: { [PP.Start]: false } },
  { atMs: 400, expect: { home: { [PP.StepHome]: true, [PP.HomeDone]: false } } },
  { atMs: 10300, expect: { home: { [PP.HomeDone]: true, [PP.StepHome]: false }, pick: { [PP.GoPick]: false } } },
  { atMs: 10400, set: { [PP.RobotDone]: true } },
  { atMs: 10500, expect: { pick: { [PP.GoPick]: true }, lamp: { [PP.Lamp]: true } } },
  { atMs: 10600, set: { [PP.RobotDone]: false } },
  { atMs: 10700, expect: { pick: { [PP.AtPick]: false } } },
  { atMs: 20500, expect: { pick: { [PP.AtPick]: true, [PP.GoPick]: false }, grip: { [PP.ValveClose]: true }, lamp: { [PP.Lamp]: true } } },
  { atMs: 20600, set: { [PP.GripOpen]: false, [PP.GripClosed]: true } },
  { atMs: 21400, expect: { grip: { [PP.Gripped]: false } } },
  { atMs: 21800, expect: { grip: { [PP.Gripped]: true, [PP.AtPick]: false }, carry: { [PP.ValveClose]: true } } },
  { atMs: 21900, set: { [PP.ConvEmpty]: true } },
  { atMs: 22000, expect: { drop: { [PP.GoDrop]: true, [PP.AtDrop]: false }, carry: { [PP.ValveClose]: true }, lamp: { [PP.Lamp]: true } } },
  { atMs: 32000, expect: { drop: { [PP.AtDrop]: true, [PP.GoDrop]: false }, release: { [PP.ValveClose]: false, [PP.ValveOpen]: true } } },
  { atMs: 32100, set: { [PP.GripClosed]: false, [PP.GripOpen]: true } },
  { atMs: 32200, expect: { release: { [PP.GoHome]: true } } },
  { atMs: 42200, expect: { release: { [PP.AtDrop]: false, [PP.GoHome]: false }, idle: { [PP.HomeDone]: true, [PP.StepHome]: false } } },
  // The robot has the next part
  { atMs: 42300, set: { [PP.RobotDone]: true } },
  { atMs: 42400, expect: { idle: { [PP.GoPick]: true, [PP.StepHome]: false } } }
]

const axisStopPath: PathStep[] = [
  { atMs: 0, set: axisAtRest },
  { atMs: 100, set: { [PP.Start]: true } },
  { atMs: 200, set: { [PP.Start]: false } },
  { atMs: 10200, expect: { estop: { [PP.HomeDone]: true } } },
  // E-stop with the axis homed
  { atMs: 10300, set: { [PP.EStop]: false } },
  { atMs: 10400, expect: { estop: { [PP.StepHome]: false, [PP.HomeDone]: false, [PP.GoPick]: false, [PP.Powered]: false } } },
  { atMs: 10500, set: { [PP.EStop]: true } },
  { atMs: 10600, expect: { estop: { [PP.Powered]: true }, reset: { [PP.StepHome]: false } } },
  { atMs: 10700, set: { [PP.Reset]: true } },
  { atMs: 10800, set: { [PP.Reset]: false } },
  // "Return to the start" is read as the start state: a reset alone must not move the axis (IEC 60204-1,
  // a reset only allows a restart). Start then begins again at homing, since E-stop cleared HomeDone
  { atMs: 10900, expect: { reset: { [PP.StepHome]: false } } },
  { atMs: 11000, set: { [PP.Start]: true } },
  { atMs: 11100, set: { [PP.Start]: false } },
  { atMs: 11200, expect: { reset: { [PP.StepHome]: true } } }
]

// The robot's done signal stays on while the axis works: the axis must not go back for a part mid-cycle
const robotDoneStaysOnPath: PathStep[] = [
  { atMs: 0, set: axisAtRest },
  { atMs: 200, set: { [PP.Start]: true } },
  { atMs: 300, set: { [PP.Start]: false } },
  { atMs: 10300, set: { [PP.RobotDone]: true } },
  { atMs: 20400, set: { [PP.GripOpen]: false, [PP.GripClosed]: true } },
  { atMs: 21800, expect: { oneStep: { [PP.GoPick]: false } } },
  { atMs: 21900, set: { [PP.ConvEmpty]: true } },
  { atMs: 22100, expect: { oneStep: { [PP.GoPick]: false } } },
  { atMs: 32000, expect: { oneStep: { [PP.GoPick]: false } } }
]

export const PICK_AND_PLACE: Scenario = {
  id: 'pick-place',
  matchWords: ['pick', 'eksen'],
  title: 'Hücre içi kartezyen taşıma ekseni (pick & place)',
  notInBenchmark: "MC_ hareket blokları bu IDE'de yok: ölçülen, modelin TON ile yaptığı taklit olur",
  checks: [
    { id: 'power', kind: 'spec', title: 'NW1: E-stop sağlam ve sürücü hazırken Eksen_Enerjili (M10.0)' },
    { id: 'home', kind: 'spec', title: 'NW2: Start ile M20.0; home hareketi süre alır, bitince M20.1 ve M20.0 sıfır' },
    { id: 'pick', kind: 'spec', title: 'NW3: Robot iş bitti ile M20.2 (Start gerekmez); hareket bitince M20.3' },
    { id: 'grip', kind: 'spec', title: 'NW4: M20.3\'te Q0.1; I0.4 geldikten 1 s sonra M20.4, öncesinde değil' },
    { id: 'drop', kind: 'spec', title: 'NW5: Konveyör boşken M20.5; hareket bitince M20.6' },
    { id: 'release', kind: 'spec', title: 'NW6: M20.6\'da Q0.1 kesilir, Q0.0 verilir; I0.3 ile M20.7; dönüş bitince M20.6 ve M20.7 sıfır' },
    { id: 'idle', kind: 'spec', title: 'NW6: Çevrim sonunda yeniden home yapılmaz; yeni çevrim Robot iş bitti ile başlar' },
    { id: 'estop', kind: 'spec', title: 'NW7: E-stop bütün adım bitlerini sıfırlar' },
    { id: 'reset', kind: 'spec', title: 'NW7: E-stop sonrası kendiliğinden başlamaz; Hata Reset ekseni hareket ettirmez, ardından Start ile en baştan (M20.0) başlar' },
    { id: 'carry', kind: 'interpretation', title: 'Tutucu parça taşınırken kapalı kalır (Q0.1, M20.4–M20.5 boyunca 1)' },
    { id: 'oneStep', kind: 'interpretation', title: 'Robot iş bitti sinyali açık kalsa da çevrim ortasında yeniden almaya gidilmez (M20.2)' },
    { id: 'lamp', kind: 'interpretation', title: 'Hücre Çalışıyor lambası (Q0.2) çevrim boyunca yanar, beklerken söner' }
  ],
  paths: [pickPath, axisStopPath, robotDoneStaysOnPath],
  mustRead: [PP.DriveReady, PP.RobotDone, PP.ConvEmpty, PP.GripOpen, PP.GripClosed, PP.Start, PP.EStop, PP.Reset],
  mustWrite: [PP.ValveOpen, PP.ValveClose, PP.Lamp, PP.Powered, PP.StepHome, PP.HomeDone, PP.GoPick, PP.AtPick, PP.Gripped, PP.GoDrop, PP.AtDrop, PP.GoHome],
  notChecked: [
    'MC_Power, MC_Home, MC_MoveAbsolute, MC_Reset: bu IDE\'de yok. Hareketlerin bir süre aldığı ve en çok 9 s sürdüğü varsayılıyor',
    'Hareket bloklarının Error/CommandAborted çıkışları ve eksen hatası sonrası davranış',
    'Hız ve pozisyon değerleri (450.0 / 1200.0 mm, 500 / 750 mm/s)',
    'Hata Reset\'in MC_Reset.Done beklemesi: burada reset anında etki ediyor'
  ]
}

export const SCENARIOS: Scenario[] = [ROBOT_CELL, PICK_AND_PLACE, ...TEXTBOOK_SCENARIOS, ...HELD_OUT_SCENARIOS]
