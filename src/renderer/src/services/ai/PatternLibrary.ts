/**
 * Circuit patterns for the agent. Each one has a circuit, a timeline it must follow and its known pitfalls.
 *
 * Written for Rungline from common relay and PLC practice, not copied from a textbook or standard.
 * src/tests/phase19_pattern_library.test.ts runs every pattern on the simulator and checks that its timeline
 * notices the loss of any network. None of them has been run on a real CPU.
 */
import { BehaviorTest } from './CircuitBehaviorTest'

export interface CircuitPattern {
  id: string
  category: 'motor' | 'analog' | 'sequencing' | 'safety' | 'communication'
  summary: string
  /** Words a user may use for this circuit, in Turkish and English. */
  keywords: string
  dsl: string
  test: BehaviorTest
  pitfalls: string[]
}

const STOP_WIRING = 'Stop is wired normally closed, so it reads 1 at rest and takes an NO contact. An NC contact here would only suit a normally open button, and then a broken wire could not stop the machine.'

export const CIRCUIT_PATTERNS: CircuitPattern[] = [
  {
    id: 'seal_in',
    category: 'motor',
    summary: 'Start and stop buttons with a seal-in contact and a thermal overload.',
    keywords: 'motor muhur muhurleme muhurlemeli seal latch start stop baslat durdur termik overload kontaktor',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Overload %I0.2 BOOL "Thermal relay, wired NC, 1 when healthy"
TAG Motor %Q0.0 BOOL "Motor contactor"
NW 1 "Motor": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), NO(Overload), COIL(Motor) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true, Overload: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Motor: true } },
        { atMs: 1000, expect: { Motor: true } },
        { atMs: 1100, set: { Stop: false }, expect: { Motor: false } },
        { atMs: 1300, set: { Stop: true }, expect: { Motor: false } },
        { atMs: 1500, set: { Start: true } },
        { atMs: 1700, set: { Start: false }, expect: { Motor: true } },
        { atMs: 1900, set: { Overload: false }, expect: { Motor: false } }
      ]
    },
    pitfalls: [STOP_WIRING, 'The seal-in is what keeps the motor off after a power cut: the coil starts off and waits for a new press.']
  },
  {
    id: 'set_reset',
    category: 'motor',
    summary: 'Latch with SET and RESET coils, where stop wins if both buttons are pressed.',
    keywords: 'set reset sr rs latch kilit birak mandal pump pompa',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Pump %Q0.0 BOOL "Pump"
NW 1 "Set": SERIES( NO(Start), SET(Pump) )
NW 2 "Reset": SERIES( NC(Stop), RESET(Pump) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Pump: true } },
        { atMs: 500, set: { Stop: false }, expect: { Pump: false } },
        { atMs: 700, set: { Start: true }, expect: { Pump: false } },
        { atMs: 900, set: { Stop: true }, expect: { Pump: true } },
        { atMs: 1100, set: { Start: false }, expect: { Pump: true } }
      ]
    },
    pitfalls: ['The network written last wins, so the order of SET and RESET decides the priority.', STOP_WIRING]
  },
  {
    id: 'auto_stop',
    category: 'motor',
    summary: 'A motor that starts by button and stops by itself after a set time, and can start again.',
    keywords: 'otomatik duran sure sonra kapanan zaman timer ton auto stop motor saniye kesme',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Motor %Q0.0 BOOL "Motor contactor"
NW 1 "Motor": SERIES( PARALLEL( NO(Start), NO(Motor) ), NO(Stop), NC(T1.Q), COIL(Motor) )
NW 2 "Run time": SERIES( NO(Motor), TON(T1, PT=T#5s) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Motor: true } },
        { atMs: 4800, expect: { Motor: true } },
        { atMs: 5400, expect: { Motor: false } },
        { atMs: 7000, expect: { Motor: false } },
        { atMs: 7100, set: { Start: true } },
        { atMs: 7300, set: { Start: false }, expect: { Motor: true } },
        { atMs: 11900, expect: { Motor: true } },
        { atMs: 12500, expect: { Motor: false } }
      ]
    },
    pitfalls: [
      'This only works because the motor is sealed in: when T1.Q opens the path, the seal drops and T1.Q going false again cannot restart it.',
      'Without the seal-in the same wiring turns into a one-scan pulse. See timer_ring.'
    ]
  },
  {
    id: 'on_delay',
    category: 'sequencing',
    summary: 'An output that follows an input only after the input has stayed on for a set time.',
    keywords: 'gecikmeli acma calisma ton on delay gecikme bekle sonra sensor zamanlayici',
    dsl: `TAG Sensor %I0.0 BOOL "Sensor"
TAG Valve %Q0.0 BOOL "Valve"
NW 1 "Delay": SERIES( NO(Sensor), TON(T1, PT=T#2s) )
NW 2 "Valve": SERIES( NO(T1.Q), COIL(Valve) )`,
    test: {
      steps: [
        { atMs: 100, set: { Sensor: true } },
        { atMs: 1500, expect: { Valve: false } },
        { atMs: 2400, expect: { Valve: true } },
        { atMs: 2500, set: { Sensor: false }, expect: { Valve: false } },
        { atMs: 3000, set: { Sensor: true } },
        { atMs: 3500, set: { Sensor: false }, expect: { Valve: false } },
        { atMs: 5700, expect: { Valve: false } }
      ]
    },
    pitfalls: ['TON restarts from zero whenever IN goes false, so short pulses never add up.']
  },
  {
    id: 'off_delay',
    category: 'sequencing',
    summary: 'An output that stays on for a set time after the input goes off, such as a cooling fan.',
    keywords: 'gecikmeli kapama birakma tof off delay fan sogutma aspirator sonra kapanma',
    dsl: `TAG Run %I0.0 BOOL "Machine running"
TAG Fan %Q0.0 BOOL "Cooling fan"
NW 1 "Run-on": SERIES( NO(Run), TOF(T1, PT=T#3s) )
NW 2 "Fan": SERIES( NO(T1.Q), COIL(Fan) )`,
    test: {
      steps: [
        { atMs: 100, set: { Run: true } },
        { atMs: 300, expect: { Fan: true } },
        { atMs: 1000, set: { Run: false }, expect: { Fan: true } },
        { atMs: 3500, expect: { Fan: true } },
        { atMs: 4400, expect: { Fan: false } }
      ]
    },
    pitfalls: ['TOF Q is on as soon as IN is on. The set time only counts after IN falls.']
  },
  {
    id: 'pulse',
    category: 'sequencing',
    summary: 'A fixed-length output from a button, however long or short the press.',
    keywords: 'darbe pulse tp sabit sureli korna horn tek atim buton',
    dsl: `TAG Button %I0.0 BOOL "Button"
TAG Horn %Q0.0 BOOL "Horn"
NW 1 "Pulse": SERIES( NO(Button), TP(T1, PT=T#2s) )
NW 2 "Horn": SERIES( NO(T1.Q), COIL(Horn) )`,
    test: {
      steps: [
        { atMs: 100, set: { Button: true } },
        { atMs: 300, set: { Button: false }, expect: { Horn: true } },
        { atMs: 1500, expect: { Horn: true } },
        { atMs: 2500, expect: { Horn: false } },
        { atMs: 3000, set: { Button: true } },
        { atMs: 5400, expect: { Horn: false } }
      ]
    },
    pitfalls: ['TP cannot be retriggered while it runs, and holding the button does not lengthen the pulse.']
  },
  {
    id: 'timer_ring',
    category: 'sequencing',
    summary: 'A repeating cycle of timed stages, one output per stage, such as a traffic light.',
    keywords: 'trafik lambasi lamba isik kirmizi sari yesil traffic light dongu cycle sirali tekrar asama stage zamanli',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Running %M10.0 BOOL "Cycle enabled"
TAG Red %Q0.0 BOOL "Stage 1 output"
TAG Yellow %Q0.1 BOOL "Stage 2 output"
TAG Green %Q0.2 BOOL "Stage 3 output"
NW 1 "Enable": SERIES( PARALLEL( NO(Start), NO(Running) ), NO(Stop), COIL(Running) )
NW 2 "End of stage 1": SERIES( NO(Running), NC(T3.Q), TON(T1, PT=T#10s) )
NW 3 "End of stage 2": SERIES( NO(T1.Q), TON(T2, PT=T#2s) )
NW 4 "End of stage 3": SERIES( NO(T2.Q), TON(T3, PT=T#10s) )
NW 5 "Stage 1": SERIES( NO(Running), NC(T1.Q), COIL(Red) )
NW 6 "Stage 2": SERIES( NO(T1.Q), NC(T2.Q), COIL(Yellow) )
NW 7 "Stage 3": SERIES( NO(T2.Q), NC(T3.Q), COIL(Green) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Red: true, Yellow: false, Green: false } },
        { atMs: 9800, expect: { Red: true, Yellow: false, Green: false } },
        { atMs: 10500, expect: { Red: false, Yellow: true, Green: false } },
        { atMs: 12500, expect: { Red: false, Yellow: false, Green: true } },
        { atMs: 22600, expect: { Red: true, Yellow: false, Green: false } },
        { atMs: 32800, expect: { Red: false, Yellow: true, Green: false } },
        { atMs: 34800, expect: { Red: false, Yellow: false, Green: true } },
        { atMs: 35000, set: { Stop: false } },
        { atMs: 35300, expect: { Red: false, Yellow: false, Green: false, Running: false } }
      ]
    },
    pitfalls: [
      'Do not put a timer\'s own Q in the path to its IN, as in NC(T1.Q) then TON(T1): T1 resets in the next scan, so T1.Q and everything after it lasts one scan.',
      'Every timer must stay on until the last one resets the chain. That is what holds each stage on.',
      'The lamp networks read the timers and never feed them, so a lamp cannot cut its own timer.'
    ]
  },
  {
    id: 'flasher',
    category: 'sequencing',
    summary: 'A lamp that flashes with its on and off times set by two timers.',
    keywords: 'flasor yanip sonen flasher blink beacon ikaz uyari lamba osilator yanson',
    dsl: `TAG Enable %I0.0 BOOL "Enable"
TAG Beacon %Q0.0 BOOL "Beacon"
NW 1 "On time": SERIES( NO(Enable), NC(T2.Q), TON(T1, PT=T#1s) )
NW 2 "Off time": SERIES( NO(T1.Q), TON(T2, PT=T#1s) )
NW 3 "Beacon": SERIES( NO(Enable), NC(T1.Q), COIL(Beacon) )`,
    test: {
      steps: [
        { atMs: 100, set: { Enable: true } },
        { atMs: 400, expect: { Beacon: true } },
        { atMs: 1500, expect: { Beacon: false } },
        { atMs: 2500, expect: { Beacon: true } },
        { atMs: 3500, expect: { Beacon: false } },
        { atMs: 4400, expect: { Beacon: true } },
        { atMs: 4500, set: { Enable: false }, expect: { Beacon: false } },
        { atMs: 7000, expect: { Beacon: false } }
      ]
    },
    pitfalls: [
      'A timer ring of two. T2 resets T1, and T1 never resets itself.',
      'If only a fixed frequency is needed and clock memory is on, a clock memory bit does it without timers.'
    ]
  },
  {
    id: 'star_delta',
    category: 'motor',
    summary: 'Star-delta starter with a dead time between the star and delta contactors.',
    keywords: 'yildiz ucgen star delta yol verme baslatma kontaktor gecis motor',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Main_K1 %Q0.0 BOOL "Main contactor"
TAG Star_K2 %Q0.1 BOOL "Star contactor"
TAG Delta_K3 %Q0.2 BOOL "Delta contactor"
NW 1 "Main": SERIES( PARALLEL( NO(Start), NO(Main_K1) ), NO(Stop), COIL(Main_K1) )
NW 2 "Star time": SERIES( NO(Main_K1), TON(T_Star, PT=T#5s) )
NW 3 "Dead time": SERIES( NO(T_Star.Q), TON(T_Dead, PT=T#500ms) )
NW 4 "Star": SERIES( NO(Main_K1), NC(T_Star.Q), NC(Delta_K3), COIL(Star_K2) )
NW 5 "Delta": SERIES( NO(T_Dead.Q), NC(Star_K2), COIL(Delta_K3) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Main_K1: true, Star_K2: true, Delta_K3: false } },
        { atMs: 4800, expect: { Main_K1: true, Star_K2: true, Delta_K3: false } },
        { atMs: 5350, expect: { Main_K1: true, Star_K2: false, Delta_K3: false } },
        { atMs: 5900, expect: { Main_K1: true, Star_K2: false, Delta_K3: true } },
        { atMs: 6100, set: { Stop: false } },
        { atMs: 6300, expect: { Main_K1: false, Star_K2: false, Delta_K3: false } }
      ]
    },
    pitfalls: [
      'Star and delta closed together is a short circuit, and the program cannot see a welded contact. They also need an electrical interlock in the wiring.',
      'Without a dead time delta can close before the star arc is out. 500 ms is only an example, take the value from the motor and contactor data.'
    ]
  },
  {
    id: 'forward_reverse',
    category: 'motor',
    summary: 'A motor with two directions, each locking out the other, with end-of-travel switches.',
    keywords: 'ileri geri fwdrev forward reverse yon degistirme kilitleme interlock limit switch motor elektriksel',
    dsl: `TAG Forward_Btn %I0.0 BOOL "Forward button, NO"
TAG Reverse_Btn %I0.1 BOOL "Reverse button, NO"
TAG Stop %I0.2 BOOL "Stop button, wired NC, 1 at rest"
TAG Forward_Limit %I0.3 BOOL "Forward end switch, wired NC, 1 until reached"
TAG Reverse_Limit %I0.4 BOOL "Reverse end switch, wired NC, 1 until reached"
TAG Forward_K1 %Q0.0 BOOL "Forward contactor"
TAG Reverse_K2 %Q0.1 BOOL "Reverse contactor"
NW 1 "Forward": SERIES( PARALLEL( NO(Forward_Btn), NO(Forward_K1) ), NO(Stop), NO(Forward_Limit), NC(Reverse_K2), COIL(Forward_K1) )
NW 2 "Reverse": SERIES( PARALLEL( NO(Reverse_Btn), NO(Reverse_K2) ), NO(Stop), NO(Reverse_Limit), NC(Forward_K1), COIL(Reverse_K2) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true, Forward_Limit: true, Reverse_Limit: true } },
        { atMs: 100, set: { Forward_Btn: true } },
        { atMs: 300, set: { Forward_Btn: false }, expect: { Forward_K1: true, Reverse_K2: false } },
        { atMs: 500, set: { Reverse_Btn: true }, expect: { Forward_K1: true, Reverse_K2: false } },
        { atMs: 700, set: { Reverse_Btn: false } },
        { atMs: 900, set: { Stop: false }, expect: { Forward_K1: false, Reverse_K2: false } },
        { atMs: 1100, set: { Stop: true } },
        { atMs: 1300, set: { Reverse_Btn: true } },
        { atMs: 1500, set: { Reverse_Btn: false }, expect: { Forward_K1: false, Reverse_K2: true } },
        { atMs: 1700, set: { Forward_Btn: true }, expect: { Forward_K1: false, Reverse_K2: true } },
        { atMs: 1900, set: { Forward_Btn: false } },
        { atMs: 2100, set: { Reverse_Limit: false }, expect: { Reverse_K2: false } },
        { atMs: 2300, set: { Reverse_Limit: true, Forward_Btn: true } },
        { atMs: 2500, set: { Forward_Btn: false }, expect: { Forward_K1: true } },
        { atMs: 2700, set: { Forward_Limit: false }, expect: { Forward_K1: false } }
      ]
    },
    pitfalls: [
      'Both contactors closed together is a short circuit between phases, so the interlock must also be in the wiring.',
      'Going straight from one direction to the other needs Stop first here. A heavy load may also need a wait before reversing.'
    ]
  },
  {
    id: 'staged_start',
    category: 'sequencing',
    summary: 'Three motors that start one after another with a delay, and all stop together.',
    keywords: 'sirali kademeli ardisik sequential cascade staged motor yol verme konveyor bant uc motor gecikmeli',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Motor_1 %Q0.0 BOOL "Motor 1"
TAG Motor_2 %Q0.1 BOOL "Motor 2"
TAG Motor_3 %Q0.2 BOOL "Motor 3"
NW 1 "Motor 1": SERIES( PARALLEL( NO(Start), NO(Motor_1) ), NO(Stop), COIL(Motor_1) )
NW 2 "Delay to motor 2": SERIES( NO(Motor_1), TON(T1, PT=T#3s) )
NW 3 "Motor 2": SERIES( NO(T1.Q), COIL(Motor_2) )
NW 4 "Delay to motor 3": SERIES( NO(Motor_2), TON(T2, PT=T#3s) )
NW 5 "Motor 3": SERIES( NO(T2.Q), COIL(Motor_3) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Motor_1: true, Motor_2: false, Motor_3: false } },
        { atMs: 2800, expect: { Motor_1: true, Motor_2: false, Motor_3: false } },
        { atMs: 3400, expect: { Motor_1: true, Motor_2: true, Motor_3: false } },
        { atMs: 6500, expect: { Motor_1: true, Motor_2: true, Motor_3: true } },
        { atMs: 6700, set: { Stop: false } },
        { atMs: 6900, expect: { Motor_1: false, Motor_2: false, Motor_3: false } }
      ]
    },
    pitfalls: ['The program reads its own coils, not the motors. A real line should read each contactor\'s auxiliary contact before starting the next.']
  },
  {
    id: 'batch_counter',
    category: 'sequencing',
    summary: 'Count parts up to a preset, then drive an output until it is reset.',
    keywords: 'sayici sayac counter ctu adet paket batch parca sayma paketleme piston',
    dsl: `TAG Part_Sensor %I0.0 BOOL "Part sensor"
TAG Batch_Reset %I0.1 BOOL "Reset button, NO"
TAG Batch_Done %Q0.0 BOOL "Batch complete"
NW 1 "Count": SERIES( NO(Part_Sensor), CTU(C1, PV=3, R=Batch_Reset) )
NW 2 "Done": SERIES( NO(C1.QU), COIL(Batch_Done) )`,
    test: {
      steps: [
        { atMs: 100, set: { Part_Sensor: true } },
        { atMs: 200, set: { Part_Sensor: false }, expect: { 'C1.CV': 1, Batch_Done: false } },
        { atMs: 300, set: { Part_Sensor: true } },
        { atMs: 400, set: { Part_Sensor: false }, expect: { 'C1.CV': 2, Batch_Done: false } },
        { atMs: 500, set: { Part_Sensor: true } },
        { atMs: 600, set: { Part_Sensor: false }, expect: { 'C1.CV': 3, Batch_Done: true } },
        { atMs: 900, expect: { Batch_Done: true } },
        { atMs: 1000, set: { Batch_Reset: true }, expect: { 'C1.CV': 0, Batch_Done: false } },
        { atMs: 1200, set: { Batch_Reset: false }, expect: { Batch_Done: false } }
      ]
    },
    pitfalls: [
      'CTU counts rising edges of its CU input, not scans or time.',
      'A part that passes faster than the scan or the input filter is missed. Fast parts need a high-speed counter.'
    ]
  },
  {
    id: 'up_down_counter',
    category: 'sequencing',
    summary: 'Count up on entry and down on exit, and signal when the place is full.',
    keywords: 'ctud yukari asagi up down otopark parking kapasite dolu giris cikis bariyer doluluk arac',
    dsl: `TAG Entry_Sensor %I0.0 BOOL "Entry sensor"
TAG Exit_Sensor %I0.1 BOOL "Exit sensor"
TAG Full_Sign %Q0.0 BOOL "Full sign"
NW 1 "Count": SERIES( NO(Entry_Sensor), CTUD(C1, PV=2, CD=Exit_Sensor) )
NW 2 "Full": SERIES( NO(C1.QU), COIL(Full_Sign) )`,
    test: {
      steps: [
        { atMs: 100, set: { Entry_Sensor: true } },
        { atMs: 200, set: { Entry_Sensor: false }, expect: { 'C1.CV': 1, Full_Sign: false } },
        { atMs: 300, set: { Entry_Sensor: true } },
        { atMs: 400, set: { Entry_Sensor: false }, expect: { 'C1.CV': 2, Full_Sign: true } },
        { atMs: 500, set: { Exit_Sensor: true } },
        { atMs: 600, set: { Exit_Sensor: false }, expect: { 'C1.CV': 1, Full_Sign: false } }
      ]
    },
    pitfalls: ['The count drifts if a sensor misses a car, so a real site needs a way to correct or reset it.']
  },
  {
    id: 'toggle',
    category: 'sequencing',
    summary: 'One button that turns an output on with one press and off with the next.',
    keywords: 'tek buton toggle ac kapa edge kenar p_trig basinca degisen yukselen pulse flip',
    dsl: `TAG Button %I0.0 BOOL "Button, NO"
TAG Press %M10.0 BOOL "On for one scan per press"
TAG Lamp %Q0.0 BOOL "Lamp"
NW 1 "Edge": SERIES( P_TRIG(Button), COIL(Press) )
NW 2 "Toggle": SERIES( PARALLEL( SERIES( NO(Press), NC(Lamp) ), SERIES( NC(Press), NO(Lamp) ) ), COIL(Lamp) )`,
    test: {
      steps: [
        { atMs: 100, set: { Button: true } },
        { atMs: 400, expect: { Lamp: true } },
        { atMs: 500, set: { Button: false }, expect: { Lamp: true } },
        { atMs: 700, set: { Button: true } },
        { atMs: 1000, expect: { Lamp: false } },
        { atMs: 1100, set: { Button: false }, expect: { Lamp: false } },
        { atMs: 1300, set: { Button: true } },
        { atMs: 1500, set: { Button: false }, expect: { Lamp: true } }
      ]
    },
    pitfalls: ['Without the edge the lamp would change on every scan while the button is held.', 'A real button bounces. Filter the input or add a short delay on a poor contact.']
  },
  {
    id: 'level_control',
    category: 'sequencing',
    summary: 'A pump that fills a tank between a low and a high level switch.',
    keywords: 'seviye depo tank su level pompa pump dolum alt ust samandira hysteresis histerezis',
    dsl: `TAG Low_Level %I0.0 BOOL "Low switch, 1 when covered"
TAG High_Level %I0.1 BOOL "High switch, 1 when covered"
TAG Pump %Q0.0 BOOL "Fill pump"
NW 1 "Pump": SERIES( PARALLEL( NC(Low_Level), NO(Pump) ), NC(High_Level), COIL(Pump) )`,
    test: {
      steps: [
        { atMs: 100, expect: { Pump: true } },
        { atMs: 200, set: { Low_Level: true }, expect: { Pump: true } },
        { atMs: 400, set: { High_Level: true }, expect: { Pump: false } },
        { atMs: 600, set: { High_Level: false }, expect: { Pump: false } },
        { atMs: 800, set: { Low_Level: false }, expect: { Pump: true } }
      ]
    },
    pitfalls: [
      'The pump keeps running if the high switch fails. A real tank needs a separate overflow protection or a maximum run time.',
      'If the switches read the other way round, swap the contacts. Check what each switch reads when covered.'
    ]
  },
  {
    id: 'alarm_ack',
    category: 'safety',
    summary: 'A fault that flashes a lamp, goes steady on acknowledge, and clears once the fault is gone.',
    keywords: 'alarm ariza ack onay acknowledge fault hata sinyal ikaz resetleme lamba bekci',
    dsl: `TAG Fault %I0.0 BOOL "Fault signal"
TAG Ack %I0.1 BOOL "Acknowledge button, NO"
TAG Alarm %M10.0 BOOL "Alarm active"
TAG Acked %M10.1 BOOL "Alarm acknowledged"
TAG Alarm_Lamp %Q0.0 BOOL "Alarm lamp"
NW 1 "Raise": SERIES( NO(Fault), SET(Alarm) )
NW 2 "Acknowledge": SERIES( NO(Alarm), NO(Ack), SET(Acked) )
NW 3 "Clear": SERIES( NC(Fault), NO(Acked), RESET(Alarm) )
NW 4 "Ready for next": SERIES( NC(Alarm), RESET(Acked) )
NW 5 "Flash on": SERIES( NO(Alarm), NC(T2.Q), TON(T1, PT=T#1s) )
NW 6 "Flash off": SERIES( NO(T1.Q), TON(T2, PT=T#1s) )
NW 7 "Lamp": SERIES( NO(Alarm), PARALLEL( NO(Acked), NC(T1.Q) ), COIL(Alarm_Lamp) )`,
    test: {
      steps: [
        { atMs: 100, set: { Fault: true } },
        { atMs: 400, expect: { Alarm_Lamp: true } },
        { atMs: 1500, expect: { Alarm_Lamp: false } },
        { atMs: 2500, expect: { Alarm_Lamp: true } },
        { atMs: 3500, set: { Ack: true }, expect: { Alarm_Lamp: true } },
        { atMs: 3700, set: { Ack: false } },
        { atMs: 4300, expect: { Alarm_Lamp: true } },
        { atMs: 5000, expect: { Alarm_Lamp: true } },
        { atMs: 5100, set: { Fault: false }, expect: { Alarm_Lamp: false } },
        { atMs: 5300, set: { Fault: true } },
        { atMs: 6800, expect: { Alarm_Lamp: false } }
      ]
    },
    pitfalls: ['A fault that disappears is still shown until someone acknowledges it. That is the purpose of the latch.']
  },
  {
    id: 'watchdog',
    category: 'safety',
    summary: 'Stop a machine and latch a fault if a sensor is not seen within a set time, such as a jam.',
    keywords: 'sikisma jam tikanma bekci watchdog konveyor bant sensor gorulmedi hata ariza timeout zaman asimi',
    dsl: `TAG Run %I0.0 BOOL "Run switch"
TAG Part_Sensor %I0.1 BOOL "Sensor that must keep changing"
TAG Fault_Reset %I0.2 BOOL "Reset button, NO"
TAG Jam_Fault %M10.0 BOOL "Latched fault"
TAG Belt %Q0.0 BOOL "Belt"
NW 1 "Sensor time": SERIES( NO(Belt), NC(Part_Sensor), TON(T1, PT=T#3s) )
NW 2 "Latch fault": SERIES( NO(T1.Q), SET(Jam_Fault) )
NW 3 "Reset fault": SERIES( NO(Fault_Reset), RESET(Jam_Fault) )
NW 4 "Belt": SERIES( NO(Run), NC(Jam_Fault), COIL(Belt) )`,
    test: {
      steps: [
        { atMs: 100, set: { Run: true } },
        { atMs: 300, expect: { Belt: true } },
        { atMs: 2000, set: { Part_Sensor: true }, expect: { Belt: true } },
        { atMs: 2300, set: { Part_Sensor: false } },
        { atMs: 4800, expect: { Belt: true, Jam_Fault: false } },
        { atMs: 5600, expect: { Belt: false, Jam_Fault: true } },
        { atMs: 6000, set: { Fault_Reset: true } },
        { atMs: 6300, set: { Fault_Reset: false }, expect: { Belt: true, Jam_Fault: false } }
      ]
    },
    pitfalls: ['The timer runs from the belt output. If the belt stops for another reason, the wait starts again from zero.', 'Latch the fault. Otherwise the machine restarts by itself as soon as the timer drops.']
  },
  {
    id: 'step_sequence',
    category: 'sequencing',
    summary: 'A one-shot process in steps, where each step waits for its own condition: fill, mix, drain.',
    keywords: 'adim step sequence sekans grafcet proses karistirici mixer dolum bosaltma tank recete kademe durum',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG Stop %I0.1 BOOL "Stop button, wired NC, 1 at rest"
TAG Low_Level %I0.2 BOOL "Low switch, 1 when covered"
TAG High_Level %I0.3 BOOL "High switch, 1 when covered"
TAG Step_1 %M10.0 BOOL "Filling"
TAG Step_2 %M10.1 BOOL "Mixing"
TAG Step_3 %M10.2 BOOL "Draining"
TAG Fill_Valve %Q0.0 BOOL "Fill valve"
TAG Mixer %Q0.1 BOOL "Mixer"
TAG Drain_Valve %Q0.2 BOOL "Drain valve"
NW 1 "Start": SERIES( NO(Start), NO(Stop), NC(Step_1), NC(Step_2), NC(Step_3), SET(Step_1) )
NW 2 "Fill to mix": SERIES( NO(Step_1), NO(High_Level), SET(Step_2) )
NW 3 "Leave fill": SERIES( NO(Step_2), RESET(Step_1) )
NW 4 "Mix time": SERIES( NO(Step_2), TON(T_Mix, PT=T#3s) )
NW 5 "Mix to drain": SERIES( NO(T_Mix.Q), SET(Step_3) )
NW 6 "Leave mix": SERIES( NO(Step_3), RESET(Step_2) )
NW 7 "Drain done": SERIES( NO(Step_3), NC(Low_Level), RESET(Step_3) )
NW 8 "Stop fill": SERIES( NC(Stop), RESET(Step_1) )
NW 9 "Stop mix": SERIES( NC(Stop), RESET(Step_2) )
NW 10 "Stop drain": SERIES( NC(Stop), RESET(Step_3) )
NW 11 "Fill valve": SERIES( NO(Step_1), COIL(Fill_Valve) )
NW 12 "Mixer": SERIES( NO(Step_2), COIL(Mixer) )
NW 13 "Drain valve": SERIES( NO(Step_3), COIL(Drain_Valve) )`,
    test: {
      steps: [
        { atMs: 0, set: { Stop: true } },
        { atMs: 100, set: { Start: true } },
        { atMs: 300, set: { Start: false }, expect: { Fill_Valve: true, Mixer: false, Drain_Valve: false } },
        { atMs: 500, set: { Low_Level: true }, expect: { Fill_Valve: true } },
        { atMs: 700, set: { High_Level: true } },
        { atMs: 900, expect: { Fill_Valve: false, Mixer: true, Drain_Valve: false } },
        { atMs: 3300, expect: { Mixer: true } },
        { atMs: 4000, expect: { Fill_Valve: false, Mixer: false, Drain_Valve: true } },
        { atMs: 4100, set: { High_Level: false } },
        { atMs: 4300, set: { Low_Level: false } },
        { atMs: 4600, expect: { Fill_Valve: false, Mixer: false, Drain_Valve: false } },
        { atMs: 4700, set: { Start: true } },
        { atMs: 4900, set: { Start: false }, expect: { Fill_Valve: true } },
        { atMs: 5100, set: { Stop: false }, expect: { Fill_Valve: false } },
        { atMs: 5300, set: { Stop: true, Start: true } },
        { atMs: 5500, set: { Start: false, Low_Level: true, High_Level: true } },
        { atMs: 5800, expect: { Mixer: true } },
        { atMs: 5900, set: { Stop: false }, expect: { Mixer: false } },
        { atMs: 6100, set: { Stop: true, Start: true } },
        { atMs: 6300, set: { Start: false } },
        { atMs: 9700, expect: { Drain_Valve: true } },
        { atMs: 9800, set: { Stop: false }, expect: { Drain_Valve: false } }
      ]
    },
    pitfalls: [
      'Exactly one step should be on. Leave a step only after the next one is set, in that order.',
      'Every step needs a way out for Stop. A step without one cannot be stopped.',
      'A sequence stopped in the middle does not resume here: it starts again from filling. Decide what the plant really needs.'
    ]
  },
  {
    id: 'cycle_sequence',
    category: 'sequencing',
    summary:
      'A machine cycle that repeats for every new part in automatic, with E-stop, fault reset and restart: clamp, work, release.',
    keywords:
      'cevrim cycle otomatik auto tekrar repeat parca part istasyon station adim step sekans acil stop e-stop estop hata reset fault restart yeniden baslatma tutucu gripper clamp sikma pres',
    dsl: `TAG Start %I0.0 BOOL "Start button, NO"
TAG EStop_OK %I0.1 BOOL "E-stop, wired NC, 1 when healthy"
TAG Fault_Reset %I0.2 BOOL "Fault reset button, NO"
TAG Part_Ready %I0.3 BOOL "Part in place"
TAG Clamped %I0.4 BOOL "Clamp closed sensor"
TAG Auto %M10.0 BOOL "Machine in automatic"
TAG Fault %M10.1 BOOL "E-stop fault, latched"
TAG Step_Clamp %M10.2 BOOL "Step: clamp the part"
TAG Step_Work %M10.3 BOOL "Step: work on the part"
TAG Step_Release %M10.4 BOOL "Step: release the part"
TAG Clamp_Valve %Q0.0 BOOL "Clamp valve, spring return"
TAG Work_Motor %Q0.1 BOOL "Work motor"
TAG Auto_Lamp %Q0.2 BOOL "Automatic lamp"
NW 1 "E-stop latches a fault": SERIES( NC(EStop_OK), SET(Fault) )
NW 2 "Fault ends automatic and every step": SERIES( NO(Fault), RESET(Auto), RESET(Step_Clamp), RESET(Step_Work), RESET(Step_Release) )
NW 3 "Reset clears the fault only": SERIES( NO(Fault_Reset), NO(EStop_OK), RESET(Fault) )
NW 4 "Start enters automatic": SERIES( NO(Start), NC(Fault), SET(Auto) )
NW 5 "New part starts a cycle": SERIES( NO(Auto), P_TRIG(Part_Ready), NC(Step_Clamp), NC(Step_Work), NC(Step_Release), SET(Step_Clamp) )
NW 6 "Clamped to work": SERIES( NO(Step_Clamp), NO(Clamped), SET(Step_Work), RESET(Step_Clamp) )
NW 7 "Work time": SERIES( NO(Step_Work), TON(T_Work, PT=T#2s) )
NW 8 "Work to release": SERIES( NO(T_Work.Q), SET(Step_Release), RESET(Step_Work) )
NW 9 "Released ends the cycle": SERIES( NO(Step_Release), NC(Clamped), RESET(Step_Release) )
NW 10 "Clamp held while the part is worked": SERIES( PARALLEL( NO(Step_Clamp), NO(Step_Work) ), COIL(Clamp_Valve) )
NW 11 "Work motor": SERIES( NO(Step_Work), COIL(Work_Motor) )
NW 12 "Automatic lamp": SERIES( NO(Auto), COIL(Auto_Lamp) )`,
    test: {
      steps: [
        { atMs: 0, set: { EStop_OK: true } },
        { atMs: 100, expect: { Auto: false, Clamp_Valve: false } },
        // A part without automatic starts nothing
        { atMs: 200, set: { Part_Ready: true } },
        { atMs: 300, expect: { Step_Clamp: false, Clamp_Valve: false } },
        { atMs: 400, set: { Part_Ready: false } },
        { atMs: 500, set: { Start: true } },
        { atMs: 600, set: { Start: false } },
        { atMs: 700, expect: { Auto: true, Auto_Lamp: true, Clamp_Valve: false } },
        { atMs: 800, set: { Part_Ready: true } },
        { atMs: 900, expect: { Clamp_Valve: true, Work_Motor: false } },
        { atMs: 1000, set: { Clamped: true } },
        { atMs: 1100, expect: { Work_Motor: true, Clamp_Valve: true } },
        { atMs: 2800, expect: { Work_Motor: true, Clamp_Valve: true } },
        { atMs: 3200, expect: { Work_Motor: false, Clamp_Valve: false, Step_Release: true } },
        { atMs: 3300, set: { Clamped: false } },
        // The cycle has ended, and the part still in place does not start another one
        { atMs: 3400, expect: { Step_Release: false, Step_Clamp: false, Clamp_Valve: false } },
        { atMs: 3600, set: { Part_Ready: false } },
        { atMs: 3700, set: { Part_Ready: true } },
        { atMs: 3800, expect: { Clamp_Valve: true, Auto: true } },
        // E-stop in the middle of a cycle
        { atMs: 3900, set: { EStop_OK: false } },
        { atMs: 4000, expect: { Clamp_Valve: false, Step_Clamp: false, Auto: false, Auto_Lamp: false } },
        { atMs: 4100, set: { EStop_OK: true } },
        { atMs: 4200, expect: { Clamp_Valve: false, Auto: false } },
        // Reset starts nothing
        { atMs: 4300, set: { Fault_Reset: true } },
        { atMs: 4400, set: { Fault_Reset: false } },
        { atMs: 4500, expect: { Clamp_Valve: false, Auto: false, Step_Clamp: false } },
        // Start and a new part do
        { atMs: 4700, set: { Start: true } },
        { atMs: 4800, set: { Start: false } },
        { atMs: 4900, expect: { Auto: true } },
        { atMs: 5000, set: { Part_Ready: false } },
        { atMs: 5100, set: { Part_Ready: true } },
        { atMs: 5200, expect: { Clamp_Valve: true } }
      ]
    },
    pitfalls: [
      'Reset clears the fault and nothing else. A reset that sets the first step makes the machine move without Start, which a machine must not do after an E-stop.',
      'Every step bit is reset when its step ends and by the fault, also where the request does not say so. A step left on blocks the next cycle or starts the wrong one.',
      'The clamp valve is spring return, so it is driven through every step that holds the part. A valve that keeps its position by itself needs an open and a close output instead, never on together.',
      'The cycle starts on the rising edge of Part_Ready, so a part left in place after a cycle does not start another. If the plant signals a new part differently, wait for that.',
      'The lamp here shows automatic mode. If it should show a cycle in progress, drive it from the steps instead, and say which one you chose.'
    ]
  },
  {
    id: 'analog_threshold',
    category: 'analog',
    summary: 'Scale a raw analog input to engineering units and raise an alarm above a limit.',
    keywords: 'analog sicaklik basinc debi olcum sensor norm_x scale_x olcekleme limit esik karsilastirma iw64 rampa bar',
    dsl: `TAG Raw_Pressure %IW64 INT "Raw analog input, 0..27648"
TAG Norm_Pressure %MD20 REAL "0.0..1.0"
TAG Pressure_Bar %MD24 REAL "Pressure in bar"
TAG High_Alarm %Q0.0 BOOL "Pressure above limit"
NW 1 "Normalize": NORM_X(Raw_Pressure, 0, 27648, Norm_Pressure)
NW 2 "Scale": SCALE_X(Norm_Pressure, 0.0, 10.0, Pressure_Bar)
NW 3 "Limit": SERIES( CMP_GT(Pressure_Bar, 8.0, REAL), COIL(High_Alarm) )`,
    test: {
      steps: [
        { atMs: 100, set: { Raw_Pressure: 13824 }, expect: { Pressure_Bar: 5, High_Alarm: false } },
        { atMs: 300, set: { Raw_Pressure: 24883 }, expect: { High_Alarm: true } },
        { atMs: 500, set: { Raw_Pressure: 0 }, expect: { Pressure_Bar: 0, High_Alarm: false } }
      ]
    },
    pitfalls: [
      'The nominal range of a unipolar S7 analog value is 0..27648. A bipolar input uses -27648..27648.',
      'A single limit chatters around its value. Add a timer or a separate clear limit for a noisy signal.'
    ]
  }
]

export function findPattern(id: string): CircuitPattern | undefined {
  const wanted = id.trim().toLowerCase()
  return CIRCUIT_PATTERNS.find((p) => p.id === wanted)
}
