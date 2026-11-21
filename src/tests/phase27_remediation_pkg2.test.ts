// Regression tests for Remediation Blueprint 2/3:
// O(1) ring buffer & throttling, no direct tag mutation, jumpToLastEdge symbolic resolution,
// stale ladPowerState clearing, ghost timer prevention, LadderEvaluator zero/CTUD/edge isolation,
// unified S7OffsetCalculator -> typeLayout.ts, and AgentTurn / PatternLibrary consistency.
import { buildLayout, LayoutVariable } from '../shared/s7/typeLayout'
import { buildInitialProjectPayload } from '../shared/project/createProjectPayload'
import { LadderNetwork } from '../shared/types/ladder'
import { BlockVariable } from '../shared/types/blocks'
import { UdtDefinition } from '../shared/types/types'
import { TagTable } from '../shared/types/tags'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { LadderEvaluator, parseTimePresetMs } from '../renderer/src/runtime/LadderEvaluator'
import { S7BinaryMemory } from '../renderer/src/runtime/S7BinaryMemory'
import { S7OffsetCalculator } from '../renderer/src/services/S7OffsetCalculator'
import { runAgentLoop } from '../renderer/src/services/ai/AgentTurn'
import { findPattern } from '../renderer/src/services/ai/PatternLibrary'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'

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

function makeSimpleContext(vars: Map<string, unknown>) {
  return {
    getVar: (sym: string) => vars.get(sym.replace(/"/g, '').trim()),
    setVar: (sym: string, val: unknown) => {
      vars.set(sym.replace(/"/g, '').trim(), val)
    },
    hasSymbol: (sym: string) => vars.has(sym.replace(/"/g, '').trim()),
    onError: (msg: string) => {
      throw new Error(msg)
    }
  }
}

async function run(): Promise<void> {
  console.log('=== PHASE 27: REMEDIATION BLUEPRINT 2/3 ===\n')

  // ---------------------------------------------------------------------------
  // 1. O(1) Ring Buffer, 25 FPS UI Throttling, No Direct tag.monitorValue Mutation
  // ---------------------------------------------------------------------------
  const baseProj = buildInitialProjectPayload({
    name: 'RuntimePerfTest',
    targetPath: '/tmp/RuntimePerfTest',
    cpuProfileId: 'cpu-1214c',
    defaultLanguage: 'LAD'
  })
  const tagTables: TagTable[] = [
    {
      id: 't1',
      name: 'default_tags',
      fileName: 'default_tags.tags.json',
      tags: [
        { id: 'tag_start', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.0' },
        { id: 'tag_motor', name: 'Motor', dataType: 'BOOL', address: '%Q0.0' }
      ]
    }
  ]
  baseProj.tagTables = tagTables
  baseProj.ladBlocks[0].networks = [
    {
      id: 'net_1',
      networkNumber: 1,
      title: 'Motor Latch',
      nodes: [
        { id: 'c_start', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Start_Btn' },
        { id: 'q_motor', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor' }
      ]
    }
  ]

  const engine = new PlcRuntimeEngine(baseProj)
  engine.start({ manualScans: true })
  for (let i = 0; i < 1050; i++) {
    engine.scanOnce()
  }
  const fullHistory = engine.getHistory()
  check('Ring buffer caps at 1000 snapshots', fullHistory.length === 1000, fullHistory.length)
  check(
    'Ring buffer preserves chronological order after wrap',
    fullHistory[0].cycleNumber === 51 && fullHistory[999].cycleNumber === 1050,
    [fullHistory[0]?.cycleNumber, fullHistory[999]?.cycleNumber]
  )
  const recent5 = engine.getRecentHistory(5)
  check(
    'getRecentHistory(5) returns last 5 cycles in order',
    recent5.map((s) => s.cycleNumber).join(',') === '1046,1047,1048,1049,1050',
    recent5.map((s) => s.cycleNumber)
  )
  const since1047 = engine.getHistorySince(1047)
  check(
    'getHistorySince(1047) returns cycles 1048..1050',
    since1047.map((s) => s.cycleNumber).join(',') === '1048,1049,1050',
    since1047.map((s) => s.cycleNumber)
  )
  engine.stop()

  // Verify no direct tag.monitorValue mutation and liveTagValues map works
  const engineNoMutate = new PlcRuntimeEngine(baseProj)
  engineNoMutate.start({ manualScans: true })
  engineNoMutate.setVariable('%I0.0', true)
  engineNoMutate.scanOnce()
  check('tag.monitorValue is NOT mutated directly on tag store objects', tagTables[0].tags[1].monitorValue === undefined, tagTables[0].tags[1].monitorValue)
  const liveTagMap = engineNoMutate.getLiveTagValues()
  check('getLiveTagValues() reports Motor = true by tag id', liveTagMap['tag_motor'] === true && liveTagMap['tag_start'] === true, liveTagMap)
  engineNoMutate.stop()

  // Verify cyclic mode throttles UI callbacks while preserving 100 Hz ring buffer
  const throttleProj = buildInitialProjectPayload({
    name: 'ThrottleTest',
    targetPath: '/tmp/ThrottleTest',
    cpuProfileId: 'cpu-1214c',
    defaultLanguage: 'LAD'
  })
  throttleProj.dataBlocks = [
    {
      blockType: 'DB',
      blockNumber: 1,
      name: 'DB1_Data',
      fileName: 'DB1_Data.db.json',
      dbType: 'Global',
      optimizedAccess: false,
      variables: [{ id: 'v1', name: 'Val', dataType: 'INT', defaultValue: '7', retain: false, accessibleFromHMI: true }]
    }
  ]
  const cyclicEngine = new PlcRuntimeEngine(throttleProj)
  cyclicEngine.setMonitoringEnabled(false)
  let uiEmits = 0
  cyclicEngine.setOnSnapshot(() => {
    uiEmits++
  })
  cyclicEngine.start()
  await new Promise((r) => setTimeout(r, 150))
  cyclicEngine.stop()
  const cyclicCycles = cyclicEngine.getMetrics().cycleNumber
  const cyclicHistory = cyclicEngine.getHistory()
  check(
    'Free-running cyclic mode throttles UI callbacks vs 100 Hz scan rate',
    cyclicCycles >= 6 && uiEmits < cyclicCycles,
    { cyclicCycles, uiEmits }
  )
  check('100 Hz ring buffer still records every cyclic scan', cyclicHistory.length === cyclicCycles, {
    history: cyclicHistory.length,
    cyclicCycles
  })
  const skippedCloneCount = cyclicHistory.filter((s) => Object.keys(s.dataBlocks).length === 0).length
  check('Idle non-emitted ticks skip expensive DB decoding when monitoring is OFF', skippedCloneCount > 0, skippedCloneCount)

  // ---------------------------------------------------------------------------
  // 2. jumpToLastEdge('Motor') & ('Start_Btn'), Stale ladPowerState, Ghost Timer
  // ---------------------------------------------------------------------------
  const edgeEngine = new PlcRuntimeEngine(baseProj)
  edgeEngine.start({ manualScans: true })
  edgeEngine.scanOnce() // cycle 1: Start_Btn=false, Motor=false
  edgeEngine.setVariable('Start_Btn', true)
  edgeEngine.scanOnce() // cycle 2: Start_Btn=true, Motor=true
  edgeEngine.scanOnce() // cycle 3: Start_Btn=true, Motor=true
  const startEdgeSnap = edgeEngine.jumpToLastEdge('Start_Btn')
  const motorEdgeSnap = edgeEngine.jumpToLastEdge('Motor')
  check('jumpToLastEdge("Start_Btn") returns exact transition snapshot (cycle 2)', startEdgeSnap?.cycleNumber === 2, startEdgeSnap?.cycleNumber)
  check('jumpToLastEdge("Motor") returns exact transition snapshot (cycle 2)', motorEdgeSnap?.cycleNumber === 2, motorEdgeSnap?.cycleNumber)

  // Clear stale ladPowerState when rung/node is deleted
  const prevPowerSnap = edgeEngine.getHistory().slice(-1)[0]
  check('ladPowerState contains c_start when present', prevPowerSnap?.ladPowerState['c_start']?.powered === true)
  baseProj.ladBlocks[0].networks = []
  edgeEngine.scanOnce()
  const afterDeleteSnap = edgeEngine.getHistory().slice(-1)[0]
  check('currentLadPowerStates clears stale entries when networks are removed', Object.keys(afterDeleteSnap.ladPowerState).length === 0, afterDeleteSnap.ladPowerState)
  edgeEngine.stop()

  // Ghost timer prevention: reading C1.Q in Network 1 before CTU(C1) in Network 2
  const counterOrderProj = buildInitialProjectPayload({
    name: 'GhostTimerTest',
    targetPath: '/tmp/GhostTimerTest',
    cpuProfileId: 'cpu-1214c',
    defaultLanguage: 'LAD'
  })
  counterOrderProj.tagTables = [
    {
      id: 't1',
      name: 'default_tags',
      fileName: 'default_tags.tags.json',
      tags: [
        { id: 't_in', name: 'PulseIn', dataType: 'BOOL', address: '%I0.0' },
        { id: 't_out', name: 'DoneOut', dataType: 'BOOL', address: '%Q0.0' }
      ]
    }
  ]
  counterOrderProj.ladBlocks[0].networks = [
    {
      id: 'n1',
      networkNumber: 1,
      title: 'Read C1.Q before counter runs',
      nodes: [
        { id: 'n1_c', kind: 'contact', contactType: 'NO_CONTACT', operand: 'C1.Q' },
        { id: 'n1_q', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'DoneOut' }
      ]
    },
    {
      id: 'n2',
      networkNumber: 2,
      title: 'Count',
      nodes: [
        { id: 'n2_c', kind: 'contact', contactType: 'NO_CONTACT', operand: 'PulseIn' },
        {
          id: 'n2_ctu',
          kind: 'counter',
          counterType: 'CTU',
          instanceDb: 'C1',
          cuCdOperand: '',
          rLdOperand: '',
          pvOperand: '1',
          qOperand: 'C1.QU',
          cvOperand: 'C1.CV'
        }
      ]
    }
  ]
  const ghostEngine = new PlcRuntimeEngine(counterOrderProj)
  ghostEngine.start({ manualScans: true })
  ghostEngine.setVariable('%I0.0', true)
  ghostEngine.scanOnce()
  check('Reading C1.Q before CTU(C1) does NOT create a ghost timer in timerStates', !ghostEngine.memory.timerStates.has('C1'), Array.from(ghostEngine.memory.timerStates.keys()))
  check('C1 counter is properly created in counterStates', ghostEngine.memory.counterStates.has('C1'))
  ghostEngine.stop()

  // ---------------------------------------------------------------------------
  // 3. LadderEvaluator Fixes: T#0ms, PV=0, CTUD incomingPower & LD, NORM_X/SCALE_X, edgeStates isolation
  // ---------------------------------------------------------------------------
  check('parseTimePresetMs(0) === 0', parseTimePresetMs(0) === 0, parseTimePresetMs(0))
  check('parseTimePresetMs("0") === 0', parseTimePresetMs('0') === 0, parseTimePresetMs('0'))
  check('parseTimePresetMs("T#0ms") === 0', parseTimePresetMs('T#0ms') === 0, parseTimePresetMs('T#0ms'))
  check('parseTimePresetMs("") === 10000', parseTimePresetMs('') === 10000, parseTimePresetMs(''))

  // PV = 0, CTUD incomingPower && cuOperand, and ldOperand
  const evalVars = new Map<string, unknown>([
    ['Permit', false],
    ['CuBtn', true],
    ['CdBtn', false],
    ['ResetBtn', false],
    ['LoadBtn', false],
    ['OutQ', false],
    ['OutCv', 0]
  ])
  const evalCtx = makeSimpleContext(evalVars)
  const ctudMem = new S7BinaryMemory()
  const ctudNet: LadderNetwork = {
    id: 'n_ctud',
    networkNumber: 1,
    title: 'CTUD Test',
    nodes: [
      { id: 'c_permit', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Permit' },
      {
        id: 'box_ctud',
        kind: 'counter',
        counterType: 'CTUD',
        instanceDb: 'C_Test',
        cuCdOperand: 'CuBtn',
        cuOperand: 'CuBtn',
        cdOperand: 'CdBtn',
        ldOperand: 'LoadBtn',
        rLdOperand: 'ResetBtn',
        pvOperand: '0',
        qOperand: 'OutQ',
        cvOperand: 'OutCv'
      }
    ]
  }

  // With Permit=false and CuBtn=true, incomingPower=false must block counting
  LadderEvaluator.evaluateNetwork(ctudNet, evalCtx, 100, ctudMem)
  check('CTUD respects incomingPower && cuOperand (blocked when Permit=false)', ctudMem.getCounter('C_Test').CV === 0 && ctudMem.getCounter('C_Test').PV === 0, ctudMem.getCounter('C_Test'))
  check('PV=0 is preserved (not defaulted to 10)', ctudMem.getCounter('C_Test').PV === 0 && ctudMem.getCounter('C_Test').QU === true)

  // Now Permit=true -> counts up to 1
  evalVars.set('Permit', true)
  LadderEvaluator.evaluateNetwork(ctudNet, evalCtx, 200, ctudMem)
  check('CTUD counts up when incomingPower=true and cuOperand=true', ctudMem.getCounter('C_Test').CV === 1, ctudMem.getCounter('C_Test').CV)

  // LD pin loads PV (0) into CV
  evalVars.set('LoadBtn', true)
  LadderEvaluator.evaluateNetwork(ctudNet, evalCtx, 300, ctudMem)
  check('CTUD LD pin loads PV into CV', ctudMem.getCounter('C_Test').CV === 0, ctudMem.getCounter('C_Test').CV)

  // SCALE_X & NORM_X with negative-to-zero range (-10.0 .. 0.0)
  const analogVars = new Map<string, unknown>([
    ['NormIn', 0.5],
    ['ScaledOut', 0],
    ['RawNeg', -5.0],
    ['NormOut', 0]
  ])
  const analogCtx = makeSimpleContext(analogVars)
  const analogNet: LadderNetwork = {
    id: 'n_analog',
    networkNumber: 1,
    title: 'Neg-to-Zero Analog',
    nodes: [
      { id: 'm_scale', kind: 'math', boxType: 'SCALE_X', min: '-10.0', max: '0.0', value: 'NormIn', out: 'ScaledOut' },
      { id: 'm_norm', kind: 'math', boxType: 'NORM_X', min: '-10.0', max: '0.0', value: 'RawNeg', out: 'NormOut' }
    ]
  }
  LadderEvaluator.evaluateNetwork(analogNet, analogCtx, 100, new S7BinaryMemory())
  check('SCALE_X(0.5, -10.0, 0.0) === -5.0 (max=0.0 not replaced by 10)', Math.abs(Number(analogVars.get('ScaledOut')) - -5.0) < 1e-6, analogVars.get('ScaledOut'))
  check('NORM_X(-5.0, -10.0, 0.0) === 0.5 (max=0.0 not replaced by 27648)', Math.abs(Number(analogVars.get('NormOut')) - 0.5) < 1e-6, analogVars.get('NormOut'))

  // Isolated P_TRIG edgeStates per S7BinaryMemory
  const memA = new S7BinaryMemory()
  const memB = new S7BinaryMemory()
  const varsA = new Map<string, unknown>([['Sig', true], ['Out', false]])
  const varsB = new Map<string, unknown>([['Sig', true], ['Out', false]])
  const edgeNet: LadderNetwork = {
    id: 'n_edge',
    networkNumber: 1,
    title: 'Edge Isolation',
    nodes: [
      { id: 'p1', kind: 'contact', contactType: 'P_TRIG', operand: 'Sig' },
      { id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Out' }
    ]
  }
  LadderEvaluator.evaluateNetwork(edgeNet, makeSimpleContext(varsA), 100, memA)
  check('Memory A sees P_TRIG rising edge', varsA.get('Out') === true && memA.edgeStates.size === 1)
  // Memory B evaluates independently and must ALSO see its own first rising edge
  LadderEvaluator.evaluateNetwork(edgeNet, makeSimpleContext(varsB), 100, memB)
  check('Memory B sees its own independent P_TRIG rising edge', varsB.get('Out') === true && memB.edgeStates.size === 1)
  // Second scan on A sees no edge while B doesn't interfere
  LadderEvaluator.evaluateNetwork(edgeNet, makeSimpleContext(varsA), 110, memA)
  check('Memory A clears pulse on scan 2 without interfering with Memory B', varsA.get('Out') === false)

  // ---------------------------------------------------------------------------
  // 4. Unified S7OffsetCalculator === typeLayout.ts
  // ---------------------------------------------------------------------------
  const fbVars: LayoutVariable[] = [
    { name: 'Start', dataType: 'BOOL' },
    { name: 'Speed', dataType: 'REAL' }
  ]
  const fbLookup = new Map<string, LayoutVariable[]>([['FB_Motor', fbVars]])

  const udtChild: UdtDefinition = {
    id: 'udt_child',
    name: 'UDT_Limits',
    fileName: 'UDT_Limits.udt.json',
    members: [
      { id: 'l1', name: 'Active', dataType: 'BOOL' },
      { id: 'l2', name: 'Threshold', dataType: 'REAL' }
    ]
  }
  const udtLookup = new Map<string, UdtDefinition>([['UDT_Limits', udtChild]])

  const complexVars: BlockVariable[] = [
    { id: 'v1', name: 'Label', dataType: 'STRING[20]', retain: false, accessibleFromHMI: true },
    { id: 'v2', name: 'Code', dataType: 'INT', retain: false, accessibleFromHMI: true },
    {
      id: 'v3',
      name: 'Box',
      dataType: 'Struct',
      retain: false,
      accessibleFromHMI: true,
      members: [
        { id: 'm1', name: 'Flag', dataType: 'BOOL', retain: false, accessibleFromHMI: true },
        { id: 'm2', name: 'Reading', dataType: 'REAL', retain: false, accessibleFromHMI: true }
      ]
    },
    { id: 'v4', name: 'Matrix', dataType: 'ARRAY[0..1, 0..2] OF INT', retain: false, accessibleFromHMI: true },
    { id: 'v5', name: 'AfterMatrix', dataType: 'BOOL', retain: false, accessibleFromHMI: true },
    { id: 'v6', name: 'MotorInst', dataType: 'FB_Motor', retain: false, accessibleFromHMI: true }
  ]

  const calcVars = S7OffsetCalculator.calculateVariableOffsets(complexVars, udtLookup, fbLookup)
  const expectedLayout = buildLayout(complexVars as LayoutVariable[], {
    udt: (n) => udtLookup.get(n)?.members as LayoutVariable[] | undefined,
    fb: (n) => fbLookup.get(n)
  })
  const calcOffsets = calcVars.map((v) => v.calculatedOffset)
  const expectedOffsets = expectedLayout.members.map((m) => `${m.byteOffset}.${m.bitOffset}`)
  check('S7OffsetCalculator offsets match typeLayout.ts identically', JSON.stringify(calcOffsets) === JSON.stringify(expectedOffsets), {
    calcOffsets,
    expectedOffsets
  })
  check('STRING[20] at 0.0 -> INT at 22.0', calcVars[0].calculatedOffset === '0.0' && calcVars[1].calculatedOffset === '22.0', calcOffsets)
  check('Nested Struct members receive absolute Byte.Bit offsets', calcVars[2].members?.[0].calculatedOffset === '24.0' && calcVars[2].members?.[1].calculatedOffset === '26.0', calcVars[2].members)
  check('2D ARRAY[0..1, 0..2] OF INT (12B at 30.0) -> AfterMatrix at 42.0', calcVars[3].calculatedOffset === '30.0' && calcVars[4].calculatedOffset === '42.0', calcOffsets)

  // Circular UDT guard does not throw stack overflow
  const circularUdt: UdtDefinition = {
    id: 'udt_cyc',
    name: 'UDT_Cycle',
    fileName: 'UDT_Cycle.udt.json',
    members: [{ id: 'c1', name: 'Self', dataType: 'UDT_Cycle' }]
  }
  const cycMap = new Map<string, UdtDefinition>([['UDT_Cycle', circularUdt]])
  const cycSize = S7OffsetCalculator.calculateUdtSize(circularUdt, cycMap)
  check('Circular UDT size calculation terminates safely', cycSize > 0, cycSize)

  // ---------------------------------------------------------------------------
  // 5. AgentTurn & PatternLibrary Fixes
  // ---------------------------------------------------------------------------
  const demo = DemoProjectSeeder.createDemoProject()
  useProjectStore.getState().setProject(demo)
  useHardwareStore.getState().setConfig(demo.hardware)
  useBlockStore.setState({
    ladBlocks: structuredClone(demo.ladBlocks).filter((b) => b.blockType === 'OB' && b.blockNumber === 1),
    sclBlocks: [],
    dataBlocks: [],
    udts: []
  })
  useTagStore.getState().setTagTables([{ id: 't0', name: 'default_tags', fileName: 'default_tags.tags.json', tags: [] }] as never)

  // providerUsed reflects ctx.provider ('ollama')
  const ollamaReply = JSON.stringify({ explanation: 'Sadece yanit.' })
  const ollamaRes = await runAgentLoop({
    prompt: 'Merhaba',
    tier: 'fast-flash',
    mode: 'auto-apply',
    isTurkish: true,
    ragRulesConsulted: [],
    provider: 'ollama',
    acceptanceGate: 'off',
    onTestProposed: () => {},
    requestModel: async () => ollamaReply
  })
  check('runAgentLoop reports providerUsed === "ollama"', ollamaRes.providerUsed === 'ollama', ollamaRes.providerUsed)

  // Lowest-error candidate kept across retries (round 1 has 1 failed expectation; rounds 2..6 have 3)
  let roundIdx = 0
  const makeBadCircuitReply = (expectCount: number) =>
    JSON.stringify({
      explanation: 'test',
      operationMode: 'replace_ob1_networks',
      dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Lamp %Q0.0 BOOL "l"\nNW 1 "A": SERIES( NO(Start), COIL(Lamp) )',
      verification: {
        steps:
          expectCount === 1
            ? [{ atMs: 100, set: { Start: true }, expect: { Lamp: false } }]
            : [
                { atMs: 100, set: { Start: true }, expect: { Lamp: false } },
                { atMs: 200, expect: { Lamp: false } },
                { atMs: 300, expect: { Lamp: false } }
              ]
      }
    })
  const bestCandidateRes = await runAgentLoop({
    prompt: 'Start lambayi yaksin',
    tier: 'fast-flash',
    mode: 'auto-apply',
    isTurkish: false,
    ragRulesConsulted: [],
    provider: 'openai',
    acceptanceGate: 'off',
    onTestProposed: () => {},
    requestModel: async () => {
      roundIdx++
      return makeBadCircuitReply(roundIdx === 1 ? 1 : 3)
    }
  })
  check(
    'runAgentLoop preserves best (lowest-failure) candidate from round 1 instead of overwriting with worse round 6',
    bestCandidateRes.providerUsed === 'openai' && bestCandidateRes.replyText.includes('attempt 1'),
    bestCandidateRes.replyText
  )

  // Diff-view trial run runs compiler verification and rejects uninstantiated timer (S7-TMR-004)
  const badCompileReply = JSON.stringify({
    explanation: 'compile error test',
    operationMode: 'replace_ob1_networks',
    dsl: 'TAG Start %I0.0 BOOL "s"\nTAG Lamp %Q0.0 BOOL "l"\nNW 1 "Bad": SERIES( NO(Start), NO(T99.Q), COIL(Lamp) )',
    verification: {
      steps: [{ atMs: 100, set: { Start: true }, expect: { Lamp: false } }]
    }
  })
  let diffRounds = 0
  const diffCompileRes = await runAgentLoop({
    prompt: 'Make circuit',
    tier: 'fast-flash',
    mode: 'diff-view',
    isTurkish: false,
    ragRulesConsulted: [],
    provider: 'openai',
    acceptanceGate: 'off',
    onTestProposed: () => {},
    requestModel: async () => {
      diffRounds++
      return badCompileReply
    }
  })
  check(
    'diff-view trial run catches compiler errors and refuses to stage uncompilable circuit',
    diffCompileRes.isError === true && !diffCompileRes.stagedChangeset && diffRounds > 1,
    { isError: diffCompileRes.isError, staged: diffCompileRes.stagedChangeset?.length, diffRounds }
  )

  // PatternLibrary star_delta NW 5 includes NO(Main_K1)
  const starDelta = findPattern('star_delta')
  const nw5 = starDelta?.dsl.split('\n').find((l) => l.startsWith('NW 5'))
  check('star_delta NW 5 "Delta" includes NO(Main_K1)', !!nw5 && nw5.includes('NO(Main_K1)'), nw5)

  console.log(`\nPHASE 27 SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
