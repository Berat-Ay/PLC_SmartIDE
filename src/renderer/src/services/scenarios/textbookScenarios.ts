/**
 * Textbook scenarios for the benchmark. Each is small, has one reading and can be built with what this IDE
 * has, so a failure is the agent's and not the specification's. Their prompts are in prompts/<id>.txt.
 * Addresses avoid MB0 and MB1, where a CPU may have its clock and system memory.
 */
import { PathStep, Scenario } from './ScenarioAcceptance'

// ---------------- Motor start/stop with overload and fault lamp ----------------
const MS = {
  Start: '%I0.0',
  Stop: '%I0.1',
  Thermal: '%I0.2',
  Reset: '%I0.3',
  Motor: '%Q0.0',
  Fault: '%Q0.1',
  RunLamp: '%Q0.2'
}
const motorAtRest = { [MS.Start]: false, [MS.Stop]: true, [MS.Thermal]: true, [MS.Reset]: false }

const motorStartStop: PathStep[] = [
  { atMs: 0, set: motorAtRest },
  { atMs: 100, expect: { seal: { [MS.Motor]: false } } },
  { atMs: 200, set: { [MS.Start]: true } },
  { atMs: 300, set: { [MS.Start]: false } },
  { atMs: 400, expect: { seal: { [MS.Motor]: true }, stop: { [MS.Motor]: true }, runLamp: { [MS.RunLamp]: true } } },
  { atMs: 500, set: { [MS.Stop]: false } },
  { atMs: 600, expect: { stop: { [MS.Motor]: false }, runLamp: { [MS.RunLamp]: false } } },
  { atMs: 700, set: { [MS.Stop]: true } },
  { atMs: 800, expect: { stop: { [MS.Motor]: false } } },
  // Start and Stop pressed together
  { atMs: 900, set: { [MS.Start]: true, [MS.Stop]: false } },
  { atMs: 1000, expect: { stopPriority: { [MS.Motor]: false } } },
  { atMs: 1100, set: { [MS.Start]: false, [MS.Stop]: true } },
  { atMs: 1200, expect: { stopPriority: { [MS.Motor]: false } } },
  // Start alone still works, so the motor was kept off by Stop and not by a dead circuit
  { atMs: 1300, set: { [MS.Start]: true } },
  { atMs: 1400, set: { [MS.Start]: false } },
  { atMs: 1500, expect: { stopPriority: { [MS.Motor]: true } } }
]

const motorOverload: PathStep[] = [
  { atMs: 0, set: motorAtRest },
  { atMs: 100, set: { [MS.Start]: true } },
  { atMs: 200, set: { [MS.Start]: false } },
  { atMs: 300, expect: { thermal: { [MS.Motor]: true, [MS.Fault]: false }, blocked: { [MS.Motor]: true } } },
  { atMs: 400, set: { [MS.Thermal]: false } },
  { atMs: 500, expect: { thermal: { [MS.Motor]: false, [MS.Fault]: true } } },
  { atMs: 600, set: { [MS.Thermal]: true } },
  { atMs: 700, expect: { latch: { [MS.Fault]: true } } },
  { atMs: 800, set: { [MS.Start]: true } },
  { atMs: 900, set: { [MS.Start]: false } },
  { atMs: 1000, expect: { blocked: { [MS.Motor]: false } } },
  { atMs: 1100, set: { [MS.Reset]: true } },
  { atMs: 1200, set: { [MS.Reset]: false } },
  { atMs: 1300, expect: { reset: { [MS.Fault]: false, [MS.Motor]: false } } },
  { atMs: 1400, set: { [MS.Start]: true } },
  { atMs: 1500, set: { [MS.Start]: false } },
  { atMs: 1600, expect: { reset: { [MS.Motor]: true } } }
]

const motorResetWhileTripped: PathStep[] = [
  { atMs: 0, set: motorAtRest },
  { atMs: 100, set: { [MS.Thermal]: false } },
  { atMs: 200, expect: { resetBlocked: { [MS.Fault]: true } } },
  { atMs: 300, set: { [MS.Reset]: true } },
  { atMs: 400, set: { [MS.Reset]: false } },
  { atMs: 500, expect: { resetBlocked: { [MS.Fault]: true } } },
  { atMs: 600, set: { [MS.Thermal]: true } },
  { atMs: 700, set: { [MS.Reset]: true } },
  { atMs: 800, set: { [MS.Reset]: false } },
  { atMs: 900, expect: { resetBlocked: { [MS.Fault]: false } } }
]

export const MOTOR_START_STOP: Scenario = {
  id: 'motor-start-stop',
  title: 'Motor yol verme, termik ve arıza lambası',
  checks: [
    { id: 'seal', kind: 'spec', title: '1: Start ile motor çalışır, Start bırakılınca çalışmaya devam eder' },
    { id: 'stop', kind: 'spec', title: '2: Stop ile motor durur ve kendiliğinden yeniden çalışmaz' },
    { id: 'stopPriority', kind: 'spec', title: '2: Start ve Stop birlikte basılıysa motor çalışmaz' },
    { id: 'thermal', kind: 'spec', title: '3: Termik atınca motor durur, arıza lambası yanar' },
    { id: 'latch', kind: 'spec', title: '3: Termik geri gelse de arıza lambası reset\'e kadar yanar' },
    { id: 'blocked', kind: 'spec', title: '4: Arıza varken Start motoru çalıştırmaz' },
    { id: 'resetBlocked', kind: 'spec', title: '4: Termik atıkken reset arızayı silmez' },
    { id: 'reset', kind: 'spec', title: '5: Reset arızayı siler, motor kendiliğinden çalışmaz; yeni Start ile çalışır' },
    { id: 'runLamp', kind: 'spec', title: '6: Çalışıyor lambası motorla birlikte yanar ve söner' }
  ],
  paths: [motorStartStop, motorOverload, motorResetWhileTripped],
  mustRead: [MS.Start, MS.Stop, MS.Thermal, MS.Reset],
  mustWrite: [MS.Motor, MS.Fault, MS.RunLamp],
  notChecked: []
}

// ---------------- Traffic light ----------------
const TL = { On: '%I0.0', Red: '%Q0.0', Yellow: '%Q0.1', Green: '%Q0.2' }
const lamps = (red: boolean, yellow: boolean, green: boolean): Record<string, boolean> => ({
  [TL.Red]: red,
  [TL.Yellow]: yellow,
  [TL.Green]: green
})

// Switched on at 100 ms: red 6 s, red+yellow 2 s, green 6 s, yellow 3 s, then red again at about 17.1 s
const trafficCycle: PathStep[] = [
  { atMs: 0, set: { [TL.On]: false } },
  { atMs: 50, expect: { off: lamps(false, false, false) } },
  { atMs: 100, set: { [TL.On]: true } },
  { atMs: 300, expect: { red: lamps(true, false, false) } },
  { atMs: 5800, expect: { red: lamps(true, false, false) } },
  { atMs: 6400, expect: { redYellow: lamps(true, true, false) } },
  { atMs: 7800, expect: { redYellow: lamps(true, true, false) } },
  { atMs: 8400, expect: { green: lamps(false, false, true) } },
  { atMs: 13800, expect: { green: lamps(false, false, true) } },
  { atMs: 14400, expect: { yellow: lamps(false, true, false) } },
  { atMs: 16800, expect: { yellow: lamps(false, true, false) } },
  { atMs: 17400, expect: { repeat: lamps(true, false, false) } },
  { atMs: 22800, expect: { repeat: lamps(true, false, false) } },
  { atMs: 23400, expect: { repeat: lamps(true, true, false), off: lamps(true, true, false) } },
  // Off in the red+yellow phase, then on again
  { atMs: 24000, set: { [TL.On]: false } },
  { atMs: 24200, expect: { off: lamps(false, false, false) } },
  { atMs: 25000, set: { [TL.On]: true } },
  { atMs: 25300, expect: { restart: lamps(true, false, false) } },
  { atMs: 30700, expect: { restart: lamps(true, false, false) } },
  { atMs: 31300, expect: { restart: lamps(true, true, false) } }
]

export const TRAFFIC_LIGHT: Scenario = {
  id: 'traffic-light',
  title: 'Trafik lambası',
  checks: [
    { id: 'red', kind: 'spec', title: 'Sistem açılınca 6 s yalnız kırmızı' },
    { id: 'redYellow', kind: 'spec', title: 'Sonra 2 s kırmızı + sarı' },
    { id: 'green', kind: 'spec', title: 'Sonra 6 s yalnız yeşil' },
    { id: 'yellow', kind: 'spec', title: 'Sonra 3 s yalnız sarı' },
    { id: 'repeat', kind: 'spec', title: 'Döngü kırmızıdan tekrar eder' },
    { id: 'off', kind: 'spec', title: 'Sistem kapalıyken bütün lambalar söner' },
    { id: 'restart', kind: 'spec', title: 'Yeniden açılınca döngü kırmızıdan baştan başlar' }
  ],
  paths: [trafficCycle],
  mustRead: [TL.On],
  mustWrite: [TL.Red, TL.Yellow, TL.Green],
  notChecked: ['Faz geçişlerinin tam anı: kontroller her fazın içinde, geçişten en az 300 ms uzakta yapılıyor']
}

// ---------------- Tank filling ----------------
const TF = { Low: '%I0.0', High: '%I0.1', Auto: '%I0.2', Reset: '%I0.3', Pump: '%Q0.0', Alarm: '%Q0.1' }
const tankEmpty = { [TF.Auto]: true, [TF.Low]: false, [TF.High]: false, [TF.Reset]: false }

const tankFill: PathStep[] = [
  { atMs: 0, set: tankEmpty },
  { atMs: 200, expect: { start: { [TF.Pump]: true, [TF.Alarm]: false } } },
  { atMs: 1000, set: { [TF.Low]: true } },
  { atMs: 1200, expect: { hysteresis: { [TF.Pump]: true }, stopHigh: { [TF.Pump]: true }, stayOff: { [TF.Pump]: true } } },
  { atMs: 3000, set: { [TF.High]: true } },
  { atMs: 3200, expect: { stopHigh: { [TF.Pump]: false } } },
  { atMs: 3400, set: { [TF.High]: false } },
  { atMs: 3600, expect: { stayOff: { [TF.Pump]: false } } },
  { atMs: 4000, set: { [TF.Low]: false } },
  { atMs: 4200, expect: { again: { [TF.Pump]: true } } }
]

// The pump runs at about 10 ms, so the 10 s dry-run time ends at about 10.01 s
const tankDry: PathStep[] = [
  { atMs: 0, set: tankEmpty },
  { atMs: 9700, expect: { dry: { [TF.Pump]: true, [TF.Alarm]: false } } },
  { atMs: 10300, expect: { dry: { [TF.Pump]: false, [TF.Alarm]: true } } },
  { atMs: 11000, expect: { alarmLatch: { [TF.Alarm]: true, [TF.Pump]: false } } },
  { atMs: 11100, set: { [TF.Reset]: true } },
  { atMs: 11200, set: { [TF.Reset]: false } },
  { atMs: 11400, expect: { alarmReset: { [TF.Alarm]: false, [TF.Pump]: true } } }
]

const tankAutoOff: PathStep[] = [
  { atMs: 0, set: tankEmpty },
  { atMs: 500, expect: { autoOff: { [TF.Pump]: true } } },
  { atMs: 600, set: { [TF.Auto]: false } },
  { atMs: 700, expect: { autoOff: { [TF.Pump]: false } } }
]

const tankHighSensorFault: PathStep[] = [
  { atMs: 0, set: { ...tankEmpty, [TF.High]: true } },
  { atMs: 300, expect: { highBlock: { [TF.Pump]: false } } },
  { atMs: 400, set: { [TF.High]: false } },
  { atMs: 600, expect: { highBlock: { [TF.Pump]: true } } }
]

export const TANK_FILL: Scenario = {
  id: 'tank-fill',
  title: 'Depo dolum kontrolü',
  checks: [
    { id: 'start', kind: 'spec', title: '1: Otomatikte su alt seviyenin altındaysa pompa çalışır' },
    { id: 'hysteresis', kind: 'spec', title: '2: Su alt seviyeyi geçince pompa durmaz' },
    { id: 'stopHigh', kind: 'spec', title: '3: Üst seviyede pompa durur' },
    { id: 'stayOff', kind: 'spec', title: '3: Su alt seviyenin altına inene kadar pompa çalışmaz' },
    { id: 'again', kind: 'spec', title: '3: Su alt seviyenin altına inince pompa yeniden çalışır' },
    { id: 'dry', kind: 'spec', title: '4: 10 s içinde alt seviye gelmezse pompa durur ve alarm yanar, öncesinde değil' },
    { id: 'alarmLatch', kind: 'spec', title: '5: Alarm reset\'e kadar yanar ve pompa çalışmaz' },
    { id: 'alarmReset', kind: 'spec', title: '5: Reset alarmı siler, şartlar uygunsa pompa yeniden çalışır' },
    { id: 'autoOff', kind: 'spec', title: '6: Otomatik kapanınca pompa hemen durur' },
    { id: 'highBlock', kind: 'spec', title: '7: Üst seviye sensörü 1 iken pompa hiç çalışmaz' }
  ],
  paths: [tankFill, tankDry, tankAutoOff, tankHighSensorFault],
  mustRead: [TF.Low, TF.High, TF.Auto, TF.Reset],
  mustWrite: [TF.Pump, TF.Alarm],
  notChecked: []
}

// ---------------- Star-delta starter ----------------
const SD = { Start: '%I0.0', Stop: '%I0.1', Thermal: '%I0.2', K1: '%Q0.0', K2: '%Q0.1', K3: '%Q0.2' }
const sdAtRest = { [SD.Start]: false, [SD.Stop]: true, [SD.Thermal]: true }
const contactors = (k1: boolean, k2: boolean, k3: boolean): Record<string, boolean> => ({ [SD.K1]: k1, [SD.K2]: k2, [SD.K3]: k3 })

// Start at 100 ms: star until about 5.1 s, a 0.5 s pause, delta from about 5.6 s
const starDeltaRun: PathStep[] = [
  { atMs: 0, set: sdAtRest },
  { atMs: 100, set: { [SD.Start]: true } },
  { atMs: 200, set: { [SD.Start]: false } },
  { atMs: 300, expect: { star: contactors(true, true, false) } },
  { atMs: 4800, expect: { star: contactors(true, true, false) } },
  { atMs: 5350, expect: { pause: contactors(true, false, false) } },
  { atMs: 5900, expect: { delta: contactors(true, false, true) } },
  { atMs: 7000, set: { [SD.Start]: true } },
  { atMs: 7100, set: { [SD.Start]: false } },
  { atMs: 7300, expect: { startIgnored: contactors(true, false, true), stop: contactors(true, false, true) } },
  { atMs: 8000, set: { [SD.Stop]: false } },
  { atMs: 8100, expect: { stop: contactors(false, false, false) } },
  { atMs: 8200, set: { [SD.Stop]: true } },
  { atMs: 8300, expect: { stop: contactors(false, false, false) } },
  { atMs: 8400, set: { [SD.Start]: true } },
  { atMs: 8500, set: { [SD.Start]: false } },
  { atMs: 8700, expect: { again: contactors(true, true, false) } }
]

const starDeltaOverload: PathStep[] = [
  { atMs: 0, set: sdAtRest },
  { atMs: 100, set: { [SD.Start]: true } },
  { atMs: 200, set: { [SD.Start]: false } },
  { atMs: 6000, expect: { thermal: contactors(true, false, true) } },
  { atMs: 6100, set: { [SD.Thermal]: false } },
  { atMs: 6200, expect: { thermal: contactors(false, false, false) } },
  // Overload during star, too
  { atMs: 6300, set: { [SD.Thermal]: true } },
  { atMs: 6400, set: { [SD.Start]: true } },
  { atMs: 6500, set: { [SD.Start]: false } },
  { atMs: 6700, expect: { thermal: contactors(true, true, false) } },
  { atMs: 6800, set: { [SD.Thermal]: false } },
  { atMs: 6900, expect: { thermal: contactors(false, false, false) } }
]

export const STAR_DELTA: Scenario = {
  id: 'star-delta',
  title: 'Yıldız-üçgen yol verme',
  checks: [
    { id: 'star', kind: 'spec', title: '1: Start ile K1 ve K2 (yıldız) çeker, 5 s yıldızda kalır' },
    { id: 'pause', kind: 'spec', title: '2–3: Yıldız bıraktıktan sonraki 0,5 s\'de K2 ve K3 ikisi de açık' },
    { id: 'delta', kind: 'spec', title: '2: Sonra K1 + K3 (üçgen) ile çalışır' },
    { id: 'startIgnored', kind: 'spec', title: '5: Çalışırken Start\'a basmak bir şey değiştirmez' },
    { id: 'stop', kind: 'spec', title: '4: Stop ile bütün kontaktörler bırakır, kendiliğinden çekmez' },
    { id: 'again', kind: 'spec', title: '4: Yeniden Start ile yıldızdan başlar' },
    { id: 'thermal', kind: 'spec', title: '4: Termik atınca (yıldızda da üçgende de) bütün kontaktörler bırakır' }
  ],
  paths: [starDeltaRun, starDeltaOverload],
  mustRead: [SD.Start, SD.Stop, SD.Thermal],
  mustWrite: [SD.K1, SD.K2, SD.K3],
  notChecked: ['K2 ve K3 arasındaki elektriksel kilit (birbirinin rung\'unda NC kontak) yapısal olarak aranmıyor, yalnızca davranışı ölçülüyor']
}

// ---------------- Car park counter ----------------
const CP = { In: '%I0.0', Out: '%I0.1', Reset: '%I0.2', Free: '%Q0.0', Full: '%Q0.1' }
const pulse = (address: string, at: number, length = 100): PathStep[] => [
  { atMs: at, set: { [address]: true } },
  { atMs: at + length, set: { [address]: false } }
]

const parkCount: PathStep[] = [
  { atMs: 0, set: { [CP.In]: false, [CP.Out]: false, [CP.Reset]: false } },
  { atMs: 100, expect: { free: { [CP.Free]: true, [CP.Full]: false } } },
  ...pulse(CP.In, 200),
  // The second car stays on the sensor for 600 ms
  ...pulse(CP.In, 400, 600),
  { atMs: 1100, expect: { single: { [CP.Full]: false, [CP.Free]: true } } },
  ...pulse(CP.In, 1200),
  { atMs: 1400, expect: { full: { [CP.Full]: true, [CP.Free]: false } } },
  ...pulse(CP.Out, 1500),
  { atMs: 1700, expect: { leave: { [CP.Full]: false, [CP.Free]: true } } }
]

const parkNoNegative: PathStep[] = [
  { atMs: 0, set: { [CP.In]: false, [CP.Out]: false, [CP.Reset]: false } },
  // Two cars leave an empty car park, then three come in
  ...pulse(CP.Out, 100),
  ...pulse(CP.Out, 300),
  ...pulse(CP.In, 500),
  ...pulse(CP.In, 700),
  ...pulse(CP.In, 900),
  { atMs: 1100, expect: { noNegative: { [CP.Full]: true, [CP.Free]: false } } }
]

const parkReset: PathStep[] = [
  { atMs: 0, set: { [CP.In]: false, [CP.Out]: false, [CP.Reset]: false } },
  ...pulse(CP.In, 100),
  ...pulse(CP.In, 300),
  ...pulse(CP.In, 500),
  { atMs: 700, expect: { reset: { [CP.Full]: true } } },
  ...pulse(CP.Reset, 800),
  { atMs: 1000, expect: { reset: { [CP.Full]: false, [CP.Free]: true } } }
]

export const CAR_PARK: Scenario = {
  id: 'car-park',
  title: 'Otopark sayacı',
  checks: [
    { id: 'free', kind: 'spec', title: 'Boş otoparkta yeşil yanar, DOLU söner' },
    { id: 'single', kind: 'spec', title: '5: Sensörde uzun kalan araç bir kez sayılır' },
    { id: 'full', kind: 'spec', title: '2: Üçüncü araçta DOLU yanar, yeşil söner' },
    { id: 'leave', kind: 'spec', title: '3: Bir araç çıkınca DOLU söner, yeşil yanar' },
    { id: 'noNegative', kind: 'spec', title: '1: Sayı 0\'ın altına inmez' },
    { id: 'reset', kind: 'spec', title: '4: Reset sayıyı sıfırlar' }
  ],
  paths: [parkCount, parkNoNegative, parkReset],
  mustRead: [CP.In, CP.Out, CP.Reset],
  mustWrite: [CP.Free, CP.Full],
  notChecked: ['Sayının kendisi (adresi spesifikasyonda yok); yalnızca lambalardan izleniyor']
}

export const TEXTBOOK_SCENARIOS: Scenario[] = [MOTOR_START_STOP, TRAFFIC_LIGHT, TANK_FILL, STAR_DELTA, CAR_PARK]
