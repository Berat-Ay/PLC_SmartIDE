// Regression tests for S7 runtime behavior. Each case reproduces a bug found in the project audit.
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { S7BinaryMemory } from '../renderer/src/runtime/S7BinaryMemory'
import { parseTimePresetMs } from '../renderer/src/runtime/LadderEvaluator'
import { parseS7Time } from '../shared/s7/time'
import { buildLayout } from '../shared/s7/typeLayout'
import { parseSourceBlock, toFullSource, rewriteSourceInterface, emptyInterface } from '../shared/scl/sourceBlock'
import { ProjectLoadPayload } from '../shared/types/ipc'
import { SclBlockDefinition, LadBlockDefinition, DataBlockDefinition, BlockVariable } from '../shared/types/blocks'

let passed = 0
let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) < 1e-4
      : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    console.log(`✅ PASS: ${name}`)
  } else {
    failed++
    console.error(`❌ FAIL: ${name} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function v(name: string, dataType: string, defaultValue?: string, retain = false): BlockVariable {
  return { id: name, name, dataType, defaultValue, retain, accessibleFromHMI: true }
}

function scl(blockType: 'OB' | 'FB' | 'FC', blockNumber: number, name: string, code: string): SclBlockDefinition {
  return { blockType, blockNumber, name, fileName: `${name}.scl`, optimizedAccess: true, interface: emptyInterface(), code }
}

function db(blockNumber: number, name: string, variables: BlockVariable[], extra: Partial<DataBlockDefinition> = {}): DataBlockDefinition {
  return { blockType: 'DB', blockNumber, name, fileName: `${name}.db.json`, dbType: 'Global', optimizedAccess: false, variables, ...extra }
}

function project(overrides: Partial<ProjectLoadPayload> = {}): ProjectLoadPayload {
  return {
    projectPath: 'test',
    metadata: {} as ProjectLoadPayload['metadata'],
    hardware: {
      general: {
        cpuName: 'CPU 1214C',
        targetCpu: 'cpu-1214c',
        cycleWatchdogTimeMs: 150,
        minCycleTimeEnabled: false,
        minCycleTimeMs: 0,
        retentiveMemory: { startByte: 0, byteCount: 0 }
      },
      systemMemory: { enabled: true, byteAddress: 1 },
      clockMemory: { enabled: false, byteAddress: 0 },
      digitalIO: { diStartByte: 0, dqStartByte: 0, diChannels: [], dqChannels: [] },
      analogIO: { aiChannels: [], aqChannels: [] },
      organizationBlocks: []
    },
    tagTables: [],
    udts: [],
    dataBlocks: [],
    ladBlocks: [],
    sclBlocks: [],
    ...overrides
  }
}

type TestEngine = PlcRuntimeEngine & {
  runCyclicScan(): void
  runCyclicInterrupt(n: number): void
  checkWatchdog(ms: number): void
  state: string
}

/** Runs the startup sequence without the background timers, so scans are driven by the test. */
function boot(payload: ProjectLoadPayload): { engine: TestEngine; advance: (ms: number) => void } {
  const engine = new PlcRuntimeEngine(payload) as unknown as TestEngine
  let now = 1000
  engine.setClock(() => now)
  engine.start()
  const timers = engine as unknown as { intervalHandle: NodeJS.Timeout | null; interruptHandles: NodeJS.Timeout[] }
  if (timers.intervalHandle) clearInterval(timers.intervalHandle)
  timers.interruptHandles.forEach((h) => clearInterval(h))
  return {
    engine,
    advance: (ms) => {
      now += ms
    }
  }
}

console.log('=== PHASE 13: S7 RUNTIME FIDELITY ===\n')

// --- OB locals and constants -------------------------------------------------
{
  const { engine } = boot(
    project({
      dataBlocks: [db(1, 'Plant', [v('Pressure', 'Real', '3.0')])],
      tagTables: [{ id: 't', name: 't', fileName: 't', tags: [{ id: '1', name: 'Output', dataType: 'Real', address: '%MD20' }] }],
      sclBlocks: [
        scl(
          'OB',
          30,
          'OB30_Pid',
          `ORGANIZATION_BLOCK "OB30_Pid"
VAR_TEMP
  Err : Real;
END_VAR
VAR CONSTANT
  GAIN : Real := 2.4;
END_VAR
BEGIN
  #Err := 4.5 - "Plant".Pressure;
  "Output" := #Err * #GAIN;
END_ORGANIZATION_BLOCK`
        )
      ]
    })
  )
  engine.runCyclicInterrupt(30)
  check('OB30 temp and constant compute a real output', engine.getVariable('Output'), 3.6)
  check('REAL tag reads back through its address without truncation', engine.getVariable('%MD20'), 3.6)
}

// --- Typed tags ---------------------------------------------------------------
{
  const engine = new PlcRuntimeEngine(
    project({
      tagTables: [
        {
          id: 't',
          name: 't',
          fileName: 't',
          tags: [
            { id: '1', name: 'Speed', dataType: 'Int', address: '%MW10' },
            { id: '2', name: 'Total', dataType: 'DInt', address: '%MD24' }
          ]
        }
      ]
    })
  )
  engine.setVariable('Speed', -5)
  check('INT tag keeps its sign', engine.getVariable('Speed'), -5)
  engine.setVariable('Total', -100000)
  check('DINT tag keeps its sign', engine.getVariable('Total'), -100000)
  engine.setVariable('%MW40', 70000)
  check('Untyped word write wraps at 16 bits', engine.getVariable('%MW40'), 70000 & 0xffff)
}

// --- FB and FC calls -----------------------------------------------------------
{
  const fb = scl(
    'FB',
    1,
    'FB_Count',
    `FUNCTION_BLOCK "FB_Count"
VAR_INPUT
  Enable : Bool;
END_VAR
VAR_OUTPUT
  Total : Int;
END_VAR
VAR
  Count : Int := 10;
END_VAR
BEGIN
  IF #Enable THEN
    #Count := #Count + 1;
  END_IF;
  #Total := #Count;
END_FUNCTION_BLOCK`
  )
  const fc = scl(
    'FC',
    2,
    'FC_Double',
    `FUNCTION "FC_Double" : Int
VAR_INPUT
  Value : Int;
END_VAR
BEGIN
  #FC_Double := #Value * 2;
END_FUNCTION`
  )
  const ob1 = scl(
    'OB',
    1,
    'Main',
    `"Inst_A"(Enable := TRUE, Total => "Result".A);
"Inst_B"(Enable := FALSE, Total => "Result".B);
"Result".C := "FC_Double"(Value := 21);`
  )
  const { engine } = boot(
    project({
      sclBlocks: [fb, fc, ob1],
      dataBlocks: [
        db(1, 'Result', [v('A', 'Int'), v('B', 'Int'), v('C', 'Int')]),
        db(2, 'Inst_A', [], { dbType: 'Instance', parentFbName: 'FB_Count' }),
        db(3, 'Inst_B', [], { dbType: 'Instance', parentFbName: 'FB_Count' })
      ]
    })
  )
  engine.runCyclicScan()
  engine.runCyclicScan()
  check('FB static memory survives scans', engine.getVariable('"Result".A'), 12)
  check('Second instance has its own memory', engine.getVariable('"Result".B'), 10)
  check('FC return value', engine.getVariable('"Result".C'), 42)
  check('Instance DB member is readable', engine.getVariable('"Inst_A".Count'), 12)
}

// --- Multi-instance timer in an FB, and independent instances --------------------
{
  const fb = scl(
    'FB',
    1,
    'FB_Delay',
    `FUNCTION_BLOCK "FB_Delay"
VAR_INPUT
  Start : Bool;
END_VAR
VAR_OUTPUT
  Done : Bool;
END_VAR
VAR
  Tmr : TON_TIME;
END_VAR
BEGIN
  #Tmr(IN := #Start, PT := T#1s, Q => #Done);
END_FUNCTION_BLOCK`
  )
  const ob1 = scl('OB', 1, 'Main', `"D1"(Start := TRUE);\n"D2"(Start := FALSE);`)
  const { engine, advance } = boot(
    project({
      sclBlocks: [fb, ob1],
      dataBlocks: [
        db(1, 'D1', [], { dbType: 'Instance', parentFbName: 'FB_Delay' }),
        db(2, 'D2', [], { dbType: 'Instance', parentFbName: 'FB_Delay' })
      ]
    })
  )
  engine.runCyclicScan()
  advance(1100)
  engine.runCyclicScan()
  check('TON inside FB elapses', engine.getVariable('"D1".Done'), true)
  check('Timer of other instance is unaffected', engine.getVariable('"D2".Done'), false)
}

// --- Arrays with computed indices and loops --------------------------------------
{
  const { engine } = boot(
    project({
      dataBlocks: [db(1, 'Data', [v('Values', 'Array[0..4] of Int'), v('Sum', 'Int')])],
      sclBlocks: [
        scl(
          'OB',
          1,
          'Main',
          `ORGANIZATION_BLOCK "Main"
VAR_TEMP
  i : Int;
END_VAR
BEGIN
  FOR #i := 0 TO 4 DO
    "Data".Values[#i] := #i * 2;
  END_FOR;
  "Data".Sum := "Data".Values[1 + 1] + "Data".Values[4];
END_ORGANIZATION_BLOCK`
        )
      ]
    })
  )
  engine.runCyclicScan()
  check('Array index is evaluated', engine.getVariable('"Data".Sum'), 12)
}

// --- Integer and REAL division, conversions -------------------------------------
{
  const { engine } = boot(
    project({
      dataBlocks: [db(1, 'D', [v('A', 'Int', '7'), v('B', 'Int', '2'), v('I', 'Int'), v('R', 'Real'), v('Rounded', 'Int'), v('Word', 'Word')])],
      sclBlocks: [
        scl(
          'OB',
          1,
          'Main',
          `"D".I := "D".A / "D".B;
"D".R := 7.0 / 2.0;
"D".Rounded := REAL_TO_INT(2.5);
"D".Word := 16#F0 OR 16#0F;`
        )
      ]
    })
  )
  engine.runCyclicScan()
  check('INT / INT truncates', engine.getVariable('"D".I'), 3)
  check('REAL / REAL keeps the fraction', engine.getVariable('"D".R'), 3.5)
  check('REAL_TO_INT rounds ties to even', engine.getVariable('"D".Rounded'), 2)
  check('OR on words is bitwise', engine.getVariable('"D".Word'), 255)
}

// --- OB dispatch ----------------------------------------------------------------
{
  const notOb1: LadBlockDefinition = {
    blockType: 'FC',
    blockNumber: 5,
    name: 'FC5',
    fileName: 'FC5.lad.json',
    optimizedAccess: true,
    interface: emptyInterface(),
    schemaVersion: '1',
    networks: [
      {
        networkNumber: 1,
        title: 'n',
        nodes: [{ id: 'c', kind: 'coil', coilType: 'OUTPUT_COIL', operand: '%M50.0' } as never]
      }
    ]
  }
  const { engine } = boot(project({ ladBlocks: [notOb1] }))
  engine.runCyclicScan()
  check('A block that is not OB1 does not run as OB1', engine.getVariable('%M50.0'), false)
}
{
  const { engine } = boot(project({ sclBlocks: [scl('OB', 1, 'Main', `"%M60.0" := TRUE;`.replace(/"/g, ''))] }))
  engine.runCyclicScan()
  check('OB1 written in SCL runs', engine.getVariable('%M60.0'), true)
}

// --- FirstScan and restart -------------------------------------------------------
{
  const { engine } = boot(project())
  check('FirstScan is set after startup', engine.getVariable('%M1.0'), true)
  engine.runCyclicScan()
  check('FirstScan clears after one scan', engine.getVariable('%M1.0'), false)
  engine.stop()
  const timers = engine as unknown as { intervalHandle: NodeJS.Timeout | null; interruptHandles: NodeJS.Timeout[] }
  engine.start()
  if (timers.intervalHandle) clearInterval(timers.intervalHandle)
  check('FirstScan is set again after STOP to RUN', engine.getVariable('%M1.0'), true)
  engine.runCyclicScan()
  check('FirstScan clears again', engine.getVariable('%M1.0'), false)
}

// --- Startup initialization -------------------------------------------------------
{
  const { engine } = boot(
    project({ dataBlocks: [db(1, 'D', [v('Keep', 'Int', '1', true), v('Drop', 'Int', '2')])] })
  )
  engine.setVariable('"D".Keep', 50)
  engine.setVariable('"D".Drop', 60)
  engine.setVariable('%Q0.0', true)
  engine.setVariable('%M5.0', true)
  engine.stop()
  engine.start()
  const timers = engine as unknown as { intervalHandle: NodeJS.Timeout | null }
  if (timers.intervalHandle) clearInterval(timers.intervalHandle)
  check('RETAIN member keeps its value over STOP to RUN', engine.getVariable('"D".Keep'), 50)
  check('Non-retain member returns to its start value', engine.getVariable('"D".Drop'), 2)
  check('Outputs are cleared on startup', engine.getVariable('%Q0.0'), false)
  check('Non-retentive bit memory is cleared on startup', engine.getVariable('%M5.0'), false)
}

// --- DB access ---------------------------------------------------------------------
{
  const engine = new PlcRuntimeEngine(project({ dataBlocks: [db(1, 'DB1', [v('Flow', 'Real', '1.5'), v('Run', 'Bool')])] }))
  check('DB name wins over the timer pattern (.PT)', engine.getVariable('DB1.PT'), 0)
  check('DB name wins over the timer pattern (.Q)', engine.getVariable('DB1.Q'), 0)
  check('A wrong member is reported', engine.getDiagnostics().some((d) => d.message.includes('DB1.PT')), true)
  check('Symbolic DB read returns the start value', engine.getVariable('"DB1".Flow'), 1.5)
  engine.setVariable('"DB1".Flow', 2.5)
  const view = new DataView(engine.memory.dataBlocks.get(1)!.buffer)
  check('Symbolic write lands in the DB bytes', view.getFloat32(0, false), 2.5)
  view.setFloat32(0, 9.5, false)
  check('Absolute change is seen by the symbolic read', engine.getVariable('"DB1".Flow'), 9.5)
  check('Absolute DBD read uses the same bytes', engine.getVariable('DB1.DBD0'), view.getUint32(0, false))
}

// --- Forces -------------------------------------------------------------------------
{
  const { engine } = boot(
    project({ sclBlocks: [scl('OB', 1, 'Main', `%Q0.0 := FALSE;`)] })
  )
  engine.setForcedValue('%Q0.0', true, true)
  engine.runCyclicScan()
  check('Forced output reaches the process image', (engine.piq[0] & 1) !== 0, true)
  engine.clearAllForcedValues()
  engine.runCyclicScan()
  check('Releasing the force returns control to the program', (engine.piq[0] & 1) !== 0, false)
}

// --- Memory limits --------------------------------------------------------------------
{
  const engine = new PlcRuntimeEngine(project())
  check('Process image follows the CPU profile', engine.pii.length, 1024)
  check('Bit memory follows the CPU profile', engine.merker.length, 8192)
  engine.setVariable('%Q2000.0', true)
  check('Out-of-range write is reported', engine.getDiagnostics().some((d) => d.message.includes('outside')), true)
}

// --- Timers ------------------------------------------------------------------------------
{
  const mem = new S7BinaryMemory()
  mem.updateTonTimer('TON', true, 100, 0)
  mem.updateTonTimer('TON', true, 100, 3)
  check('TON elapsed follows the clock, not a minimum step', mem.getTimer('TON').ET, 3)

  let pulses = 0
  let prevQ = false
  for (let t = 0; t <= 5000; t += 10) {
    const s = mem.updateTpTimer('TP', true, 100, t)
    if (s.Q && !prevQ) pulses++
    prevQ = s.Q
  }
  check('TP gives one pulse while IN stays high', pulses, 1)
  mem.updateTpTimer('TP', false, 100, 5010)
  const again = mem.updateTpTimer('TP', true, 100, 5020)
  check('TP restarts on a new rising edge', again.Q, true)
}

// --- Time literals ------------------------------------------------------------------------
check('T#1.5s', parseS7Time('T#1.5s'), 1500)
check('T#1h', parseS7Time('T#1h'), 3600000)
check('T#1h30m', parseS7Time('T#1h30m'), 5400000)
check('T#0s', parseS7Time('T#0s'), 0)
check('TIME#500ms', parseS7Time('TIME#500ms'), 500)
check('T#1d_2h', parseS7Time('T#1d_2h'), 93600000)
check('Garbage is rejected', parseS7Time('T#abc'), null)
check('Preset T#1.5s', parseTimePresetMs('T#1.5s'), 1500)
check('Preset T#0s', parseTimePresetMs('T#0s'), 0)

// --- Comparator and MOVE with literal operands ----------------------------------------------
{
  const lad: LadBlockDefinition = {
    blockType: 'OB',
    blockNumber: 1,
    name: 'Main',
    fileName: 'Main.lad.json',
    optimizedAccess: true,
    interface: emptyInterface(),
    schemaVersion: '1',
    networks: [
      {
        networkNumber: 1,
        title: 'n',
        nodes: [
          { id: 'cmp', kind: 'comparator', comparatorType: 'CMP_GT', op1: '%MW10', op2: '5' } as never,
          { id: 'q', kind: 'coil', coilType: 'OUTPUT_COIL', operand: '%M70.0' } as never
        ]
      }
    ]
  }
  const { engine } = boot(project({ ladBlocks: [lad] }))
  engine.setVariable('%MW10', 3)
  engine.runCyclicScan()
  check('Comparator uses a literal operand (3 > 5 is false)', engine.getVariable('%M70.0'), false)
  engine.setVariable('%MW10', 9)
  engine.runCyclicScan()
  check('Comparator uses a literal operand (9 > 5 is true)', engine.getVariable('%M70.0'), true)
}

// --- Faults and watchdog --------------------------------------------------------------------
{
  const { engine } = boot(project({ sclBlocks: [scl('OB', 1, 'Main', `WHILE TRUE DO\n  %M0.0 := TRUE;\nEND_WHILE;`)] }))
  engine.runCyclicScan()
  check('Endless loop stops the CPU with an error', engine.getState(), 'ERROR')
  check('The reason is reported', engine.getDiagnostics().some((d) => d.message.includes('watchdog')), true)
}
{
  const { engine } = boot(project({ sclBlocks: [scl('OB', 1, 'Main', `"Nope"(A := 1);`)] }))
  engine.runCyclicScan()
  check('Calling a missing block stops the CPU', engine.getState(), 'ERROR')
}
{
  const { engine } = boot(project({ sclBlocks: [scl('OB', 80, 'TimeErr', `%M80.0 := TRUE;`)] }))
  engine.checkWatchdog(200)
  check('Over the limit: OB80 runs', engine.getVariable('%M80.0'), true)
  check('Over the limit: CPU stays in RUN', engine.getState(), 'RUN')
  engine.checkWatchdog(301)
  check('Over twice the limit: CPU stops', engine.getState(), 'ERROR')
}

// --- Layout ------------------------------------------------------------------------------------
{
  const layout = buildLayout([
    { name: 'A', dataType: 'Bool' },
    { name: 'B', dataType: 'Bool' },
    { name: 'C', dataType: 'Int' },
    { name: 'D', dataType: 'Byte' },
    { name: 'E', dataType: 'Real' },
    { name: 'F', dataType: 'String[4]' },
    { name: 'G', dataType: 'Array[0..2] of Int' }
  ])
  const at = (n: string): string => {
    const m = layout.byName.get(n.toLowerCase())!
    return `${m.byteOffset}.${m.bitOffset}`
  }
  check('Bits pack in one byte', at('B'), '0.1')
  check('INT aligns to an even byte', at('C'), '2.0')
  check('BYTE follows without padding', at('D'), '4.0')
  check('REAL aligns to an even byte', at('E'), '6.0')
  check('STRING aligns to an even byte', at('F'), '10.0')
  check('ARRAY aligns to an even byte', at('G'), '16.0')
  check('Total size', layout.byteSize, 22)
}

// --- SCL source declarations -----------------------------------------------------------------
{
  const source = `// banner
FUNCTION_BLOCK "FB_Motor"
TITLE = Motor
{ S7_Optimized_Access := 'FALSE' }
VERSION : 1.2
VAR_INPUT
  Start : Bool; // start request
END_VAR
VAR
  Cfg : Struct
    Limit : Real := 5.0;
  END_STRUCT;
  Hours : DInt := 3;
END_VAR
VAR_TEMP
  x : Int;
END_VAR
BEGIN
  #x := 1;
END_FUNCTION_BLOCK
`
  const parsed = parseSourceBlock(source)
  check('Source header kind', parsed.kind, 'FB')
  check('Source header name', parsed.name, 'FB_Motor')
  check('Optimized attribute', parsed.optimizedAccess, false)
  check('Version', parsed.version, '1.2')
  check('Input comment', parsed.interface.input[0].comment, 'start request')
  check('Struct members', parsed.interface.static[0].members?.[0].name, 'Limit')
  check('Start value', parsed.interface.static[1].defaultValue, '3')
  check('Body', parsed.body.trim(), '#x := 1;')
  check('No errors', parsed.errors, [])

  const block = scl('FB', 1, 'FB_Motor', source)
  const iface = { ...parsed.interface, input: [...parsed.interface.input, v('Stop', 'Bool')] }
  const rewritten = rewriteSourceInterface(block, iface)
  check('Interface edit is written to the source', parseSourceBlock(rewritten).interface.input[1]?.name, 'Stop')
  check('Interface edit keeps the body', parseSourceBlock(rewritten).body.trim(), '#x := 1;')
  check('Interface edit keeps the banner', rewritten.startsWith('// banner'), true)

  const fragment = scl('FC', 2, 'FC_X', '#a := 1;')
  fragment.interface = { ...emptyInterface(), temp: [v('a', 'Int')] }
  const full = toFullSource(fragment)
  check('A fragment gains a complete block on save', parseSourceBlock(full).interface.temp[0]?.name, 'a')
  check('A full source is kept as written', toFullSource(block), source)
}

// --- Bad statements are parse errors instead of being skipped ---------------------------------
{
  const { engine } = boot(project({ sclBlocks: [scl('OB', 1, 'Main', `%M0.0 TRUE;`)] }))
  engine.runCyclicScan()
  check('A malformed statement stops the CPU instead of doing nothing', engine.getState(), 'ERROR')
}

console.log(`\nPHASE 13 SUMMARY: ${passed} PASSED, ${failed} FAILED`)
process.exit(failed > 0 ? 1 : 0)
