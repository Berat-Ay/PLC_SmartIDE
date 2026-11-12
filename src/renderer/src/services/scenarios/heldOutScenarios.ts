/**
 * Held-out scenarios. They were written after the agent's general rules of 2026-11-09 and must never be used
 * to tune the agent: no rule, pattern or prompt change may be made to pass them. They show whether a change
 * that helped the other scenarios helps circuits the change was not made for. If one of them is used for
 * tuning, it stops being held out and a new one is needed.
 *
 * Like the textbook scenarios they are small, have one reading and need nothing this IDE lacks.
 * Their prompts are in prompts/<id>.txt. The test plays the plant: it moves limits and sensors itself.
 */
import { PathStep, Scenario } from './ScenarioAcceptance'

const pulse = (address: string, at: number, length = 100): PathStep[] => [
  { atMs: at, set: { [address]: true } },
  { atMs: at + length, set: { [address]: false } }
]

// ---------------- Garage door ----------------
const GD = {
  Open: '%I0.0',
  Close: '%I0.1',
  Stop: '%I0.2',
  LimOpen: '%I0.3',
  LimClosed: '%I0.4',
  Photo: '%I0.5',
  MotorOpen: '%Q0.0',
  MotorClose: '%Q0.1',
  Lamp: '%Q0.2'
}
const doorClosed = {
  [GD.Open]: false,
  [GD.Close]: false,
  [GD.Stop]: true,
  [GD.LimOpen]: false,
  [GD.LimClosed]: true,
  [GD.Photo]: true
}
const motor = (open: boolean, close: boolean): Record<string, boolean> => ({ [GD.MotorOpen]: open, [GD.MotorClose]: close })

// Opens, closes by itself 10 s after reaching the open limit (about 11 s), is stopped, then closed by hand
const doorCycle: PathStep[] = [
  { atMs: 0, set: doorClosed },
  { atMs: 100, expect: { open: motor(false, false), lamp: { [GD.Lamp]: false } } },
  ...pulse(GD.Open, 200),
  { atMs: 400, set: { [GD.LimClosed]: false } },
  { atMs: 500, expect: { open: motor(true, false), lamp: { [GD.Lamp]: true } } },
  // Close pressed while opening is ignored
  ...pulse(GD.Close, 600),
  { atMs: 800, expect: { reverseIgnored: motor(true, false) } },
  { atMs: 1000, set: { [GD.LimOpen]: true } },
  { atMs: 1100, expect: { open: motor(false, false), reverseIgnored: motor(false, false), lamp: { [GD.Lamp]: false } } },
  { atMs: 10500, expect: { autoClose: motor(false, false) } },
  { atMs: 11300, expect: { autoClose: motor(false, true), lamp: { [GD.Lamp]: true }, stop: motor(false, true) } },
  { atMs: 11400, set: { [GD.LimOpen]: false } },
  { atMs: 12000, set: { [GD.Stop]: false } },
  { atMs: 12100, expect: { stop: motor(false, false) } },
  { atMs: 12200, set: { [GD.Stop]: true } },
  { atMs: 12300, expect: { stop: motor(false, false) } },
  ...pulse(GD.Close, 12400),
  { atMs: 12600, expect: { close: motor(false, true) } },
  // Open pressed while closing is ignored too
  ...pulse(GD.Open, 12700),
  { atMs: 12900, expect: { reverseIgnored: motor(false, true) } },
  { atMs: 13000, set: { [GD.LimClosed]: true } },
  { atMs: 13100, expect: { close: motor(false, false), lamp: { [GD.Lamp]: false } } }
]

// An obstacle while closing opens the door fully; an obstacle keeps it from closing, by hand or by itself
const doorObstacle: PathStep[] = [
  { atMs: 0, set: doorClosed },
  ...pulse(GD.Open, 100),
  { atMs: 300, set: { [GD.LimClosed]: false } },
  { atMs: 1000, set: { [GD.LimOpen]: true } },
  ...pulse(GD.Close, 1200),
  { atMs: 1400, set: { [GD.LimOpen]: false } },
  { atMs: 1500, expect: { photoReverse: motor(false, true) } },
  { atMs: 1600, set: { [GD.Photo]: false } },
  { atMs: 1700, expect: { photoReverse: motor(true, false) } },
  { atMs: 1800, set: { [GD.Photo]: true } },
  { atMs: 1900, expect: { photoReverse: motor(true, false) } },
  { atMs: 2000, set: { [GD.LimOpen]: true } },
  { atMs: 2100, expect: { photoReverse: motor(false, false) } },
  { atMs: 2200, set: { [GD.Photo]: false } },
  ...pulse(GD.Close, 2300),
  { atMs: 2500, expect: { photoBlock: motor(false, false) } },
  { atMs: 12500, expect: { photoBlock: motor(false, false) } },
  // With the way clear it closes again
  { atMs: 12600, set: { [GD.Photo]: true } },
  ...pulse(GD.Close, 12700),
  { atMs: 12900, expect: { photoBlock: motor(false, true) } }
]

export const GARAGE_DOOR: Scenario = {
  id: 'garage-door',
  matchWords: ['garaj', 'kapı'],
  heldOut: true,
  title: 'Otomatik garaj kapısı',
  checks: [
    { id: 'open', kind: 'spec', title: '1: Aç ile kapı açılır, buton bırakılınca devam eder, açık limitte durur' },
    { id: 'close', kind: 'spec', title: '2: Kapat ile kapı kapanır, kapalı limitte durur' },
    { id: 'reverseIgnored', kind: 'spec', title: '3: Açılırken Kapat butonu dikkate alınmaz, iki yön birlikte çalışmaz' },
    { id: 'stop', kind: 'spec', title: '4: Dur her hareketi durdurur, kapı kendiliğinden yeniden hareket etmez' },
    { id: 'photoReverse', kind: 'spec', title: '5: Kapanırken fotosel engel görürse kapı durur ve tamamen açılır' },
    { id: 'photoBlock', kind: 'spec', title: '6: Fotosel engel görürken kapı kapanmaz, elle de kendiliğinden de' },
    { id: 'autoClose', kind: 'spec', title: '7: Tam açık kapı 10 s sonra kendiliğinden kapanır, öncesinde değil' },
    { id: 'lamp', kind: 'spec', title: '8: Uyarı lambası kapı hareket ederken yanar, dururken söner' }
  ],
  paths: [doorCycle, doorObstacle],
  mustRead: [GD.Open, GD.Close, GD.Stop, GD.LimOpen, GD.LimClosed, GD.Photo],
  mustWrite: [GD.MotorOpen, GD.MotorClose, GD.Lamp],
  notChecked: ['Fotosel engeli kalktıktan sonra 10 s\'nin baştan mı yoksa kaldığı yerden mi sayıldığı']
}

// ---------------- Bottle filling line ----------------
const BF = {
  Start: '%I0.0',
  Stop: '%I0.1',
  EStop: '%I0.2',
  Reset: '%I0.3',
  Bottle: '%I0.4',
  Conveyor: '%Q0.0',
  Valve: '%Q0.1',
  BoxFull: '%Q0.2',
  Fault: '%Q0.3'
}
const lineAtRest = { [BF.Start]: false, [BF.Stop]: true, [BF.EStop]: true, [BF.Reset]: false, [BF.Bottle]: false }
const line = (conveyor: boolean, valve: boolean): Record<string, boolean> => ({ [BF.Conveyor]: conveyor, [BF.Valve]: valve })

// Four bottles fill a box. A fill takes 3 s from the bottle's arrival
const fillBox: PathStep[] = [
  { atMs: 0, set: lineAtRest },
  { atMs: 100, expect: { run: line(false, false) } },
  ...pulse(BF.Start, 200),
  { atMs: 400, expect: { run: line(true, false) } },
  { atMs: 500, set: { [BF.Bottle]: true } },
  { atMs: 600, expect: { fill: line(false, true) } },
  { atMs: 3300, expect: { fill: line(false, true) } },
  { atMs: 3700, expect: { fill: line(true, false) } },
  // The filled bottle is still under the nozzle
  { atMs: 3900, expect: { noRefill: line(true, false) } },
  { atMs: 4200, set: { [BF.Bottle]: false } },
  { atMs: 4500, set: { [BF.Bottle]: true } },
  { atMs: 7700, set: { [BF.Bottle]: false } },
  { atMs: 8000, set: { [BF.Bottle]: true } },
  { atMs: 11200, set: { [BF.Bottle]: false } },
  { atMs: 11300, expect: { boxFull: { [BF.BoxFull]: false, [BF.Conveyor]: true } } },
  { atMs: 11500, set: { [BF.Bottle]: true } },
  { atMs: 14700, expect: { boxFull: { [BF.BoxFull]: true, ...line(false, false) } } },
  { atMs: 14800, set: { [BF.Bottle]: false } },
  ...pulse(BF.Start, 15000),
  { atMs: 15200, expect: { boxFull: { [BF.BoxFull]: true, [BF.Conveyor]: false } } },
  ...pulse(BF.Reset, 15300),
  { atMs: 15500, expect: { boxReset: { [BF.BoxFull]: false, [BF.Conveyor]: false } } },
  ...pulse(BF.Start, 15600),
  { atMs: 15800, expect: { boxReset: { [BF.Conveyor]: true } } },
  // The count starts again from zero: one more bottle does not fill the box
  { atMs: 16000, set: { [BF.Bottle]: true } },
  { atMs: 19300, expect: { boxReset: { [BF.BoxFull]: false, [BF.Conveyor]: true } } }
]

const lineStops: PathStep[] = [
  { atMs: 0, set: lineAtRest },
  ...pulse(BF.Start, 100),
  { atMs: 300, set: { [BF.Bottle]: true } },
  { atMs: 900, expect: { stop: line(false, true) } },
  { atMs: 1000, set: { [BF.Stop]: false } },
  { atMs: 1100, expect: { stop: line(false, false) } },
  { atMs: 1200, set: { [BF.Stop]: true } },
  { atMs: 1300, expect: { stop: line(false, false) } },
  // Started again, the line goes on and the half-filled bottle is not filled again
  ...pulse(BF.Start, 1400),
  { atMs: 1600, expect: { stop: line(true, false) } },
  { atMs: 1700, set: { [BF.EStop]: false } },
  { atMs: 1800, expect: { estop: { ...line(false, false), [BF.Fault]: true } } },
  ...pulse(BF.Reset, 1900),
  { atMs: 2100, expect: { estop: { [BF.Fault]: true } } },
  { atMs: 2200, set: { [BF.EStop]: true } },
  { atMs: 2300, expect: { faultLatch: { [BF.Fault]: true, [BF.Conveyor]: false } } },
  ...pulse(BF.Start, 2400),
  { atMs: 2600, expect: { faultLatch: { [BF.Conveyor]: false } } },
  ...pulse(BF.Reset, 2700),
  { atMs: 2900, expect: { faultReset: { [BF.Fault]: false, [BF.Conveyor]: false } } },
  ...pulse(BF.Start, 3000),
  { atMs: 3200, expect: { faultReset: { [BF.Conveyor]: true } } }
]

export const BOTTLE_FILLING: Scenario = {
  id: 'bottle-filling',
  matchWords: ['şişe', 'dolum'],
  heldOut: true,
  title: 'Şişe dolum hattı',
  checks: [
    { id: 'run', kind: 'spec', title: '1: Start ile konveyör döner' },
    { id: 'fill', kind: 'spec', title: '2–3: Şişe gelince konveyör durur, valf 3 s açılır, sonra konveyör yeniden döner' },
    { id: 'noRefill', kind: 'spec', title: '3: Dolan şişe sensörden çıkmadan yeniden dolum yapılmaz' },
    { id: 'boxFull', kind: 'spec', title: '4: 4. şişe dolunca Kutu dolu yanar, hat durur ve Start ile çalışmaz' },
    { id: 'boxReset', kind: 'spec', title: '4: Reset sayacı ve lambayı siler, hattı çalıştırmaz; Start ile sayım baştan başlar' },
    { id: 'stop', kind: 'spec', title: '5: Stop konveyörü ve valfi hemen durdurur; yarıda kalan dolum tekrarlanmaz' },
    { id: 'estop', kind: 'spec', title: '6: E-stop her şeyi durdurur, Arıza yanar; E-stop basılıyken Reset arızayı silmez' },
    { id: 'faultLatch', kind: 'spec', title: '6: Arıza E-stop bırakılınca da yanar, arıza varken Start çalıştırmaz' },
    { id: 'faultReset', kind: 'spec', title: '6: Reset arızayı siler ama hattı çalıştırmaz; yeniden Start gerekir' }
  ],
  paths: [fillBox, lineStops],
  mustRead: [BF.Start, BF.Stop, BF.EStop, BF.Reset, BF.Bottle],
  mustWrite: [BF.Conveyor, BF.Valve, BF.BoxFull, BF.Fault],
  notChecked: []
}

// ---------------- Heater with purge and after-run fan ----------------
const HT = {
  Start: '%I0.0',
  Stop: '%I0.1',
  Demand: '%I0.2',
  OverTemp: '%I0.3',
  Reset: '%I0.4',
  Fan: '%Q0.0',
  Heater: '%Q0.1',
  Fault: '%Q0.2'
}
const heaterAtRest = { [HT.Start]: false, [HT.Stop]: true, [HT.Demand]: true, [HT.OverTemp]: true, [HT.Reset]: false }
const unit = (fan: boolean, heater: boolean): Record<string, boolean> => ({ [HT.Fan]: fan, [HT.Heater]: heater })

// Started at 200 ms: heater from about 3.2 s; stopped at 4 s: fan until about 9 s
const heaterRun: PathStep[] = [
  { atMs: 0, set: heaterAtRest },
  { atMs: 100, expect: { run: unit(false, false) } },
  ...pulse(HT.Start, 200),
  { atMs: 400, expect: { run: { [HT.Fan]: true }, purge: { [HT.Heater]: false } } },
  { atMs: 3000, expect: { purge: unit(true, false) } },
  { atMs: 3400, expect: { purge: unit(true, true) } },
  { atMs: 3500, set: { [HT.Demand]: false } },
  { atMs: 3600, expect: { demand: unit(true, false) } },
  { atMs: 3700, set: { [HT.Demand]: true } },
  { atMs: 3800, expect: { demand: unit(true, true) } },
  { atMs: 4000, set: { [HT.Stop]: false } },
  { atMs: 4100, expect: { stop: unit(true, false) } },
  { atMs: 4200, set: { [HT.Stop]: true } },
  { atMs: 8800, expect: { afterRun: unit(true, false) } },
  { atMs: 9200, expect: { afterRun: unit(false, false) } },
  // Started again, it waits for the purge again
  ...pulse(HT.Start, 9400),
  { atMs: 9700, expect: { purge: unit(true, false) } },
  { atMs: 12800, expect: { purge: unit(true, true) } }
]

const heaterStopPriority: PathStep[] = [
  { atMs: 0, set: heaterAtRest },
  { atMs: 100, set: { [HT.Start]: true, [HT.Stop]: false } },
  { atMs: 200, expect: { stopPriority: unit(false, false) } },
  { atMs: 300, set: { [HT.Start]: false, [HT.Stop]: true } },
  { atMs: 400, expect: { stopPriority: unit(false, false) } },
  // Start alone still works, so the system was kept off by Stop and not by a dead circuit
  ...pulse(HT.Start, 500),
  { atMs: 700, expect: { stopPriority: { [HT.Fan]: true } } }
]

const heaterOverTemp: PathStep[] = [
  { atMs: 0, set: heaterAtRest },
  ...pulse(HT.Start, 100),
  { atMs: 3500, expect: { overTemp: unit(true, true) } },
  { atMs: 3600, set: { [HT.OverTemp]: false } },
  { atMs: 3700, expect: { overTemp: { ...unit(true, false), [HT.Fault]: true } } },
  { atMs: 8400, expect: { overTemp: unit(true, false) } },
  { atMs: 8900, expect: { overTemp: unit(false, false) } },
  ...pulse(HT.Reset, 9000),
  { atMs: 9200, expect: { resetBlocked: { [HT.Fault]: true } } },
  { atMs: 9300, set: { [HT.OverTemp]: true } },
  { atMs: 9400, expect: { latch: { [HT.Fault]: true, ...unit(false, false) } } },
  ...pulse(HT.Start, 9500),
  { atMs: 9700, expect: { latch: unit(false, false) } },
  ...pulse(HT.Reset, 9800),
  { atMs: 10000, expect: { faultReset: { [HT.Fault]: false, ...unit(false, false) } } },
  ...pulse(HT.Start, 10100),
  { atMs: 10300, expect: { faultReset: { [HT.Fan]: true } } }
]

export const HEATER_FAN: Scenario = {
  id: 'heater-fan',
  matchWords: ['ısıtıcı', 'fan'],
  heldOut: true,
  title: 'Fanlı ısıtıcı: ön havalandırma ve art çalışma',
  checks: [
    { id: 'run', kind: 'spec', title: '1–2: Start ile sistem çalışır, fan döner' },
    { id: 'purge', kind: 'spec', title: '3: Isıtıcı ancak fan 3 s döndükten sonra açılır (her Start\'ta)' },
    { id: 'demand', kind: 'spec', title: '3: Isıtıcı yalnız termostat ısı isterken açık' },
    { id: 'stop', kind: 'spec', title: '4: Stop ısıtıcıyı hemen kapatır, fan art çalışmaya geçer' },
    { id: 'stopPriority', kind: 'spec', title: '1: Start ve Stop birlikte basılıysa sistem çalışmaz' },
    { id: 'afterRun', kind: 'spec', title: '4: Durunca fan 5 s daha döner, sonra durur' },
    { id: 'overTemp', kind: 'spec', title: '5: Aşırı sıcaklıkta ısıtıcı kapanır, Arıza yanar, fan 5 s döner' },
    { id: 'resetBlocked', kind: 'spec', title: '6: Aşırı sıcaklık sürerken Reset arızayı silmez' },
    { id: 'latch', kind: 'spec', title: '6: Arıza Reset\'e kadar yanar, arıza varken Start çalıştırmaz' },
    { id: 'faultReset', kind: 'spec', title: '6: Reset arızayı siler ama sistemi çalıştırmaz; yeniden Start gerekir' }
  ],
  paths: [heaterRun, heaterStopPriority, heaterOverTemp],
  mustRead: [HT.Start, HT.Stop, HT.Demand, HT.OverTemp, HT.Reset],
  mustWrite: [HT.Fan, HT.Heater, HT.Fault],
  notChecked: ['Art çalışma sırasında yeniden Start\'a basılınca ne olacağı (istek söylemiyor)']
}

export const HELD_OUT_SCENARIOS: Scenario[] = [GARAGE_DOOR, BOTTLE_FILLING, HEATER_FAN]
