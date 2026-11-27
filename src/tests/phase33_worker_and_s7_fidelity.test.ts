// Phase 33 regression suite: Web Worker lifecycle/fallback/sync + S7 runtime & SCL/LAD fidelity.
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { S7BinaryMemory } from '../renderer/src/runtime/S7BinaryMemory'
import { PlcRuntimeWorkerClient } from '../renderer/src/runtime/PlcRuntimeWorkerClient'
import {
  attachRuntimeWorkerHost,
  MainToWorkerMessage,
  WorkerPortLike,
  WorkerToMainMessage
} from '../renderer/src/runtime/workerProtocol'
import { applyStartValues, buildLayout, parseStartValue, parseTypeName, readValue, reinitNonRetain, writeValue } from '../shared/s7/typeLayout'
import { parseS7LTimeNs, parseS7Time } from '../shared/s7/time'
import { parseOnlineValue } from '../shared/s7/onlineValueParser'
import { SclInterpreter } from '../renderer/src/runtime/SclInterpreter'
import { CPU_1214C_PROFILE, CPU_1516_PROFILE } from '../shared/constants/cpuProfiles'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'
import { buildInitialProjectPayload } from '../shared/project/createProjectPayload'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useRuntimeStore } from '../renderer/src/stores/useRuntimeStore'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import type { ProjectLoadPayload } from '../shared/types/ipc'
import type { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '../shared/types/blocks'
import { emptyInterface } from '../shared/scl/sourceBlock'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`✅ PASS: ${name}`)
  } else {
    failed++
    console.error(`❌ FAIL: ${name}${detail !== undefined ? ` - ${JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}` : ''}`)
  }
}

function makeProject(overrides: Partial<ProjectLoadPayload> = {}): ProjectLoadPayload {
  const base = buildInitialProjectPayload({
    name: 'Phase33Proj',
    targetPath: 'C:/Projects/Phase33Proj',
    cpuProfileId: 'cpu-1214c',
    defaultLanguage: 'SCL'
  })
  return {
    ...base,
    ladBlocks: [],
    sclBlocks: [],
    ...overrides
  }
}

function sclBlock(blockType: 'OB' | 'FB' | 'FC', blockNumber: number, name: string, code: string): SclBlockDefinition {
  return {
    blockType,
    blockNumber,
    name,
    fileName: `${name}.scl`,
    code,
    optimizedAccess: false,
    interface: emptyInterface()
  }
}

function createPairedPort(): {
  clientPort: WorkerPortLike
  hostPort: {
    postMessage: (msg: WorkerToMainMessage) => void
    onmessage: ((event: { data: MainToWorkerMessage }) => void) | null
  }
} {
  const clientPort: WorkerPortLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: unknown) {
      hostPort.onmessage?.({ data: msg as MainToWorkerMessage })
    },
    terminate() {
      clientPort.onmessage = null
      clientPort.onerror = null
      hostPort.onmessage = null
    }
  }
  const hostPort = {
    onmessage: null as ((event: { data: MainToWorkerMessage }) => void) | null,
    postMessage(msg: WorkerToMainMessage) {
      clientPort.onmessage?.({ data: msg })
    }
  }
  return { clientPort, hostPort }
}

async function run(): Promise<void> {
  console.log('=== PHASE 33: WORKER & S7 RUNTIME FIDELITY ===\n')

  // 1. DB split-brain fix + bounds guards
  {
    const db1: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 1,
      name: 'DB1',
      fileName: 'DB1.db.json',
      dbType: 'Global',
      optimizedAccess: false,
      variables: [
        { id: 'v1', name: 'Setpoint', dataType: 'INT', defaultValue: '42', retain: false, accessibleFromHMI: true }
      ]
    }
    const eng = new PlcRuntimeEngine(makeProject({ dataBlocks: [db1] }))
    // Buffer for 1 INT is < 1024B. Accessing %DB1.DBW0 must read and mutate the exact same buffer!
    check('Small DB symbolic start value visible via %DB1.DBW0', eng.getVariable('%DB1.DBW0') === 42, eng.getVariable('%DB1.DBW0'))
    eng.setVariable('%DB1.DBW0', 1234)
    check('Absolute write %DB1.DBW0 updates symbolic DB member', eng.getVariable('"DB1".Setpoint') === 1234, eng.getVariable('"DB1".Setpoint'))
    eng.setVariable('"DB1".Setpoint', 777)
    check('Symbolic write updates absolute %DB1.DBW0', eng.getVariable('%DB1.DBW0') === 777, eng.getVariable('%DB1.DBW0'))

    // Bounds & DB0 guard
    const mem = new S7BinaryMemory()
    mem.writeBit('DB', 0, 0, true, 0)
    mem.writeWord('Q', -2, 99)
    check('DB0 access rejected cleanly without throwing or aliasing DB1', mem.getDbBuffer(0) === undefined && mem.readWord('I', -4) === 0 && mem.readBit('M', 0, 9) === false)
  }

  // 2. typeLayout: 64-bit unsigned, Infinity/NaN guard, STRING[N] clamp, nested retain, start values
  {
    const lwordType = parseTypeName('LWORD')
    const lwordBuf = new Uint8Array(8)
    const lwordView = new DataView(lwordBuf.buffer)
    writeValue(lwordBuf, lwordView, lwordType, 0, 0, 0xffffffffffffffffn)
    check('LWORD writes unsigned 64-bit max cleanly', lwordView.getBigUint64(0, false) === 0xffffffffffffffffn)

    let threwOnInf = false
    try {
      writeValue(lwordBuf, lwordView, parseTypeName('LINT'), 0, 0, Infinity)
      writeValue(lwordBuf, lwordView, parseTypeName('LINT'), 0, 0, NaN)
    } catch {
      threwOnInf = true
    }
    check('writeElementary guards Infinity/NaN without BigInt RangeError', !threwOnInf)

    const str300 = parseTypeName('STRING[300]')
    check('STRING[300] clamps maxLength to 254', str300.kind === 'string' && str300.maxLength === 254)

    const arrStrLayout = buildLayout([{ name: 'Msgs', dataType: 'Array[0..1] of String[10]' }])
    const arrBuf = new Uint8Array(arrStrLayout.byteSize)
    const arrView = new DataView(arrBuf.buffer)
    applyStartValues(arrBuf, arrView, arrStrLayout)
    check('Array of String initializes maxLength header bytes', arrBuf[0] === 10 && arrBuf[12] === 10, [arrBuf[0], arrBuf[12]])

    const structRetainLayout = buildLayout([
      {
        name: 'Cfg',
        dataType: 'Struct',
        members: [
          { name: 'KeepMe', dataType: 'INT', defaultValue: '1' },
          { name: 'ResetMe', dataType: 'INT', defaultValue: '5' }
        ]
      }
    ])
    ;(structRetainLayout.members[0].type as { members: Array<{ source?: { retain?: boolean } }> }).members[0].source = { retain: true }
    const stBuf = new Uint8Array(structRetainLayout.byteSize)
    const stView = new DataView(stBuf.buffer)
    applyStartValues(stBuf, stView, structRetainLayout)
    writeValue(stBuf, stView, structRetainLayout, 0, 0, { Cfg: { KeepMe: 999, ResetMe: 888 } })
    reinitNonRetain(stBuf, stView, structRetainLayout)
    const afterReinit = readValue(stBuf, stView, structRetainLayout, 0, 0) as { Cfg: { KeepMe: number; ResetMe: number } }
    check('reinitNonRetain preserves nested retain inside non-retain Struct', afterReinit.Cfg.KeepMe === 999 && afterReinit.Cfg.ResetMe === 5, afterReinit)

    check('parseStartValue handles INT#-5, 1_000, CHAR', parseStartValue('INT#-5', parseTypeName('INT')) === -5 && parseStartValue('1_000', parseTypeName('INT')) === 1000 && parseStartValue("'A'", parseTypeName('CHAR')) === 65)
  }

  // 3. Retentive Merker clamping across CPU profile downgrade (S7-1500 -> S7-1200)
  {
    const hw = getDefaultCpuConfig()
    hw.general.profileId = CPU_1214C_PROFILE.id
    hw.general.cpuName = CPU_1214C_PROFILE.name
    hw.general.targetCpu = 'Virtual S7-1200'
    hw.general.retentiveMemory = { startByte: 10000, byteCount: 512 } // > 8192 bytes on 1214C
    const eng = new PlcRuntimeEngine(makeProject({ hardware: hw }))
    let clampedOk = true
    try {
      eng.start({ manualScans: true })
      eng.stop()
    } catch {
      clampedOk = false
    }
    check('Retentive merker startByte > merker.length does not throw RangeError', clampedOk)

    // Profile switch to 1516 then back to 1214C
    hw.general.profileId = CPU_1516_PROFILE.id
    hw.general.targetCpu = 'Virtual S7-1500'
    eng.refreshLiveProjectState(hw)
    check('refreshLiveProjectState updates memory geometry for S7-1500', eng.merker.length === CPU_1516_PROFILE.merkerBytes)
  }

  // 4. Worker protocol: error extraction/dispose, dbBytes sync, syncLiveProject DB+HW, fault sink
  {
    const { clientPort, hostPort } = createPairedPort()
    const workerEngine = attachRuntimeWorkerHost(hostPort)
    const client = new PlcRuntimeWorkerClient(() => clientPort)
    const mirror = new PlcRuntimeEngine()
    const errs: string[] = []
    client.setOnError((m) => errs.push(m))
    client.setOnSnapshotBatch((b) => {
      mirror.ingestWorkerFrame(b.snapshot, b.historyDelta, b.metrics, b.timerStates, b.counterStates, b.dbBytes)
    })
    mirror.setExternalWriteSink((cmd) => {
      if (cmd.kind === 'injectHardwareFault') client.post({ type: 'injectFault', channel: cmd.channel })
      else if (cmd.kind === 'clearHardwareFault') client.post({ type: 'clearFault', channel: cmd.channel })
      else if (cmd.kind === 'setVariable') client.post({ type: 'setVariable', symbolOrAddress: cmd.symbolOrAddress, value: cmd.value })
    })

    const db1: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 1,
      name: 'DB1',
      fileName: 'DB1.db.json',
      dbType: 'Global',
      optimizedAccess: false,
      variables: [{ id: 'x', name: 'Count', dataType: 'INT', defaultValue: '1', retain: false, accessibleFromHMI: true }]
    }
    const ob1 = sclBlock('OB', 1, 'Main', `"DB1".Count := "DB1".Count + 1;`)
    const ob82 = sclBlock('OB', 82, 'Diag', `%M4.0 := TRUE;`)
    const payload = makeProject({ dataBlocks: [db1], sclBlocks: [ob1, ob82] })

    client.ensureStarted()
    mirror.loadProject(payload)
    client.post({ type: 'loadProject', payload })
    client.post({ type: 'start' })
    const handles = workerEngine as unknown as { intervalHandle: NodeJS.Timeout | null; interruptHandles: NodeJS.Timeout[]; runCyclicScan: (f?: boolean) => void }
    if (handles.intervalHandle) clearInterval(handles.intervalHandle)
    for (const h of handles.interruptHandles || []) clearInterval(h)

    handles.runCyclicScan(true)
    check('Worker dbBytes synchronizes live DB edits to mirrorEngine', mirror.getVariable('"DB1".Count') === 2 && mirror.getVariable('%DB1.DBW0') === 2, mirror.getVariable('"DB1".Count'))

    // Fault injection through mirror routes to worker OB82 cleanly
    mirror.injectHardwareFault('%IW64')
    check('Mirror injectHardwareFault forwards via externalWriteSink to worker OB82', mirror.getBit('M', 4, 0) === true && workerEngine.getVariable('%IW64') === 32767)
    mirror.clearHardwareFault('%IW64')
    check('Mirror clearHardwareFault clears diagnostic bit & channel on worker', workerEngine.getVariable('%IW64') === 0)

    // syncLiveProject propagates new DB + hardware
    const db2: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 2,
      name: 'DB2',
      fileName: 'DB2.db.json',
      dbType: 'Global',
      optimizedAccess: false,
      variables: [{ id: 'y', name: 'Limit', dataType: 'INT', defaultValue: '55', retain: false, accessibleFromHMI: true }]
    }
    const nextHw = getDefaultCpuConfig()
    nextHw.general.cycleWatchdogTimeMs = 222
    client.post({
      type: 'syncLiveProject',
      tagTables: payload.tagTables,
      ladBlocks: [],
      sclBlocks: [ob1, ob82],
      dataBlocks: [db1, db2],
      udts: [],
      hardware: nextHw
    })
    check('syncLiveProject syncs new DBs and hardware inside worker', workerEngine.getVariable('"DB2".Limit') === 55 && workerEngine.getMetrics().watchdogLimitMs === 222)

    // Worker port.onerror triggers cleanup & readable error
    clientPort.onerror?.({ message: 'Out of memory in worker' })
    check('Worker onerror extracts message and disposes port cleanly', errs[0] === 'Out of memory in worker' && !client.isRunning(), errs)
  }

  // 5. Project close / switch clears forces and blocks/tags
  {
    const projA = makeProject({ projectPath: 'C:/Projects/ProjA' })
    const projB = makeProject({ projectPath: 'C:/Projects/ProjB' })
    useProjectStore.getState().setProject(projA)
    useRuntimeStore.getState().forceValue('%M0.0', true, true)
    check('Force registered before switch', useRuntimeStore.getState().forceOverrides.size === 1)

    useProjectStore.getState().setProject(projB)
    check('Switching projects clears previous project forces', useRuntimeStore.getState().forceOverrides.size === 0 && useRuntimeStore.getState().engine.forceOverrides.size === 0)

    useRuntimeStore.getState().forceValue('%M0.1', true, true)
    useProjectStore.getState().closeProject()
    check(
      'closeProject clears blocks, tags, forces, and runtime state',
      !useProjectStore.getState().isLoaded &&
        useBlockStore.getState().dataBlocks.length === 0 &&
        useTagStore.getState().tagTables.length === 0 &&
        useHardwareStore.getState().config.general.cpuName === getDefaultCpuConfig().general.cpuName &&
        useRuntimeStore.getState().forceOverrides.size === 0
    )
  }

  // 6. IEC Timers (TON PT=0, TOF ET hold, TP PT lock, TONR) & Counters (CTD.Q, PV<=0 reset, PV clamp)
  {
    const mem = new S7BinaryMemory()
    const ton0 = mem.updateTonTimer('T_ZERO', true, 0, 100)
    check('TON with PT=0 sets Q=true on first scan', ton0.Q === true && ton0.ET === 0)

    mem.updateTofTimer('T_TOF', true, 100, 0)
    mem.updateTofTimer('T_TOF', false, 100, 10)
    const tofExpired = { ...mem.updateTofTimer('T_TOF', false, 100, 120) }
    const tofHeld = { ...mem.updateTofTimer('T_TOF', false, 100, 200) }
    const tofReset = { ...mem.updateTofTimer('T_TOF', true, 100, 210) }
    check('TOF holds ET=PT while IN stays FALSE after expiry, clears on rising IN', tofExpired.Q === false && tofHeld.ET === 100 && tofReset.ET === 0 && tofReset.Q === true)

    mem.updateTpTimer('T_TP', true, 100, 0)
    const tpMid = { ...mem.updateTpTimer('T_TP', true, 500, 50) }
    const tpDone = { ...mem.updateTpTimer('T_TP', false, 500, 110) }
    check('TP locks PT mid-pulse and resets ET=0 when pulse completes while IN=FALSE', tpMid.PT === 100 && tpMid.Q === true && tpDone.Q === false && tpDone.ET === 0)

    mem.updateTonrTimer('T_RET', true, false, 100, 0)
    const r1 = { ...mem.updateTonrTimer('T_RET', true, false, 100, 60) }
    const rPause = { ...mem.updateTonrTimer('T_RET', false, false, 100, 200) }
    mem.updateTonrTimer('T_RET', true, false, 100, 200)
    const rDone = { ...mem.updateTonrTimer('T_RET', true, false, 100, 250) }
    const rReset = { ...mem.updateTonrTimer('T_RET', true, true, 100, 260) }
    check('TONR accumulates across IN drops and resets on R=TRUE', r1.ET === 60 && !rPause.Q && rPause.ET === 60 && rDone.Q && rReset.ET === 0 && !rReset.Q)

    // CTD.Q must equal QD, not QU
    const ctdOb = sclBlock(
      'OB',
      1,
      'Main',
      `"C_Dn"(CD := %M0.0, LD := %M0.1, PV := 2);\n%Q0.0 := "C_Dn".Q;`
    )
    const ctdDb: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 3,
      name: 'C_Dn',
      fileName: 'C_Dn.db.json',
      dbType: 'Instance',
      parentFbName: 'CTD',
      optimizedAccess: true,
      variables: []
    }
    const ctdEng = new PlcRuntimeEngine(makeProject({ dataBlocks: [ctdDb], sclBlocks: [ctdOb] }))
    ctdEng.start({ manualScans: true })
    ctdEng.setVariable('%M0.1', true) // Load PV=2 -> QD=FALSE, QU=TRUE
    ctdEng.scanOnce()
    const qAfterLoad = ctdEng.getVariable('%Q0.0')
    ctdEng.setVariable('%M0.1', false)
    ctdEng.setVariable('%M0.0', true)
    ctdEng.scanOnce() // CV=1
    ctdEng.setVariable('%M0.0', false)
    ctdEng.scanOnce()
    ctdEng.setVariable('%M0.0', true)
    ctdEng.scanOnce() // CV=0 -> QD=TRUE
    const qAtZero = ctdEng.getVariable('%Q0.0')
    ctdEng.stop()
    check('CTD.Q tracks QD (FALSE at CV=2, TRUE at CV=0) instead of QU', qAfterLoad === false && qAtZero === true, { qAfterLoad, qAtZero })

    const ctu0 = mem.updateCtuCounter('C_ZERO', false, true, 0)
    const pvClamped = mem.updateCtuCounter('C_CLAMP', false, false, 99999)
    check('CTU reset with PV<=0 sets QU=TRUE and clamps PV to 32767', ctu0.QU === true && pvClamped.PV === 32767)
  }

  // 7. CPU STOP/PIQ zero, OB80 absent watchdog fault, OB82 gated to RUN, unforce preserves live memory, uncalled R_TRIG
  {
    const ob1 = sclBlock('OB', 1, 'Main', `%Q0.0 := TRUE;`)
    const ob82 = sclBlock('OB', 82, 'Diag', `%M9.0 := TRUE;`)
    const fbScl = sclBlock(
      'FB',
      1,
      'FB_EdgeTest',
      `FUNCTION_BLOCK "FB_EdgeTest"
VAR
  Trig : R_TRIG;
END_VAR
BEGIN
  #Trig(CLK := %M1.7);
END_FUNCTION_BLOCK`
    )
    const dbFb: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 10,
      name: 'DB_Edge',
      fileName: 'DB_Edge.db.json',
      dbType: 'Instance',
      parentFbName: 'FB_EdgeTest',
      optimizedAccess: false,
      variables: []
    }
    const eng = new PlcRuntimeEngine(makeProject({ dataBlocks: [dbFb], sclBlocks: [ob1, ob82, fbScl] }))
    eng.injectHardwareFault('%IW64')
    check('OB82 does not execute when CPU is in STOP', eng.getVariable('%M9.0') === false)

    // Uncalled R_TRIG.Q must NOT create a phantom timer in timerStates
    const edgeQ = eng.getVariable('"DB_Edge".Trig.Q')
    check('Reading uncalled R_TRIG.Q returns FALSE without creating phantom timer', edgeQ === false && !eng.memory.timerStates.has('DB_EDGE.TRIG'))

    eng.start({ manualScans: true })
    eng.scanOnce()
    check('Output %Q0.0 is TRUE while RUN', eng.getVariable('%Q0.0') === true)
    eng.stop()
    check('Outputs (PIQ) are cleared when CPU transitions to STOP', eng.getVariable('%Q0.0') === false)

    // Unforcing must NOT overwrite live memory value
    eng.setVariable('%MW20', 500)
    eng.setForcedValue('MW20', 999, true)
    check('Normalized force key I/M/Q resolves MW20 and %MW20 consistently', eng.getVariable('%MW20') === 999)
    eng.setVariable('%MW20', 777) // write directly to live buffer while force is active (unforced view = 777)
    eng.setForcedValue('%MW20', 0, false)
    check('Unforcing removes override without overwriting live memory with stale arg', eng.getVariable('%MW20') === 777, eng.getVariable('%MW20'))

    // Watchdog overrun without OB80 transitions CPU to ERROR
    eng.start({ manualScans: true })
    ;(eng as unknown as { checkWatchdog: (ms: number) => void }).checkWatchdog(200)
    check('Watchdog overrun without OB80 faults CPU to ERROR', eng.getState() === 'ERROR')
  }

  // 8. SCL interpreter, edge isolation between engines, time & onlineValueParser
  {
    // Run via FB inside engine so typed locals apply
    const fb = sclBlock(
      'FB',
      2,
      'FB_SclChecks',
      `FUNCTION_BLOCK "FB_SclChecks"
VAR
  w : Word := 16#0001;
  signedInt : Int := -4;
  shiftedWord : Word;
  notWord : Word;
  signedShr : Int;
  s : String := 'Hi';
  ltCmp : Bool;
  arr : Array[0..1] of Int;
  idx : Int := 0;
  shortGuard : Bool := FALSE;
END_VAR
BEGIN
  #shiftedWord := SHL(IN := #w, N := 4) AND 16#FF;
  #notWord := NOT #w;
  #signedShr := SHR(IN := #signedInt, N := 1);
  #s := #s + '!';
  #ltCmp := 'abc' < 'abd';
  IF (#idx >= 0) OR (#arr[99] = 1) THEN
    #shortGuard := TRUE;
  END_IF;
END_FUNCTION_BLOCK`
    )
    const db: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 11,
      name: 'DB_Scl',
      fileName: 'DB_Scl.db.json',
      dbType: 'Instance',
      parentFbName: 'FB_SclChecks',
      optimizedAccess: false,
      variables: []
    }
    const ob1 = sclBlock('OB', 1, 'Main', `"DB_Scl"();`)
    const eng = new PlcRuntimeEngine(makeProject({ dataBlocks: [db], sclBlocks: [ob1, fb] }))
    eng.start({ manualScans: true })
    eng.scanOnce()
    eng.stop()
    check(
      'SCL SHL AND bitwise, NOT WORD, signed SHR, STRING +, <, and OR short-circuit work accurately',
      eng.getVariable('"DB_Scl".shiftedWord') === 16 &&
        eng.getVariable('"DB_Scl".notWord') === 0xfffe &&
        eng.getVariable('"DB_Scl".signedShr') === -2 &&
        eng.getVariable('"DB_Scl".s') === 'Hi!' &&
        eng.getVariable('"DB_Scl".ltCmp') === true &&
        eng.getVariable('"DB_Scl".shortGuard') === true,
      {
        shifted: eng.getVariable('"DB_Scl".shiftedWord'),
        notW: eng.getVariable('"DB_Scl".notWord'),
        shr: eng.getVariable('"DB_Scl".signedShr'),
        s: eng.getVariable('"DB_Scl".s'),
        lt: eng.getVariable('"DB_Scl".ltCmp'),
        sc: eng.getVariable('"DB_Scl".shortGuard')
      }
    )

    // FOR BY 0 faults CPU cleanly instead of infinite loop or silent 1
    const zeroStepOb = sclBlock('OB', 1, 'Main', `FOR %MW0 := 1 TO 5 BY 0 DO\n  %MW2 := 1;\nEND_FOR;`)
    const engStep0 = new PlcRuntimeEngine(makeProject({ sclBlocks: [zeroStepOb] }))
    engStep0.start({ manualScans: true })
    engStep0.scanOnce()
    check('FOR loop BY 0 trips CPU error instead of running with step=1', engStep0.getState() === 'ERROR')

    // validateSyntax catches unclosed REPEAT
    check('validateSyntax catches missing END_REPEAT', !SclInterpreter.validateSyntax(`REPEAT\n  %MW0 := 1;\nUNTIL FALSE;`).valid)

    // Two engines do NOT share R_TRIG / P_TRIG edge states
    const edgeOb = sclBlock('OB', 1, 'Main', `R_TRIG(CLK := %M0.0, Q => %Q0.0);`)
    const eng1 = new PlcRuntimeEngine(makeProject({ sclBlocks: [edgeOb] }))
    const eng2 = new PlcRuntimeEngine(makeProject({ sclBlocks: [edgeOb] }))
    eng1.start({ manualScans: true })
    eng2.start({ manualScans: true })
    eng1.setVariable('%M0.0', true)
    eng1.scanOnce() // eng1 sees rising edge on line 1
    eng2.setVariable('%M0.0', true)
    eng2.scanOnce() // eng2 must ALSO see its own rising edge!
    check('Independent PlcRuntimeEngine instances isolate R_TRIG edge states', eng1.getVariable('%Q0.0') === true && eng2.getVariable('%Q0.0') === true)
    eng1.stop()
    eng2.stop()

    // Ladder TONR support
    const tonrLad: LadBlockDefinition = {
      blockType: 'OB',
      blockNumber: 1,
      name: 'Main',
      fileName: 'Main.lad.json',
      optimizedAccess: true,
      interface: emptyInterface(),
      schemaVersion: '1',
      networks: [
        {
          id: 'n1',
          networkNumber: 1,
          title: 'TONR',
          nodes: [
            { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: '%M0.0' },
            { id: 'tm', kind: 'timer', timerType: 'TONR', instanceDb: 'T_LAD_RET', inOperand: '', rOperand: '%M0.1', ptOperand: 'T#100ms', qOperand: '%Q0.0', etOperand: '' }
          ]
        }
      ]
    }
    let ladNow = 1000
    const ladEng = new PlcRuntimeEngine(makeProject({ ladBlocks: [tonrLad] }))
    ladEng.setClock(() => ladNow)
    ladEng.start({ manualScans: true })
    ladEng.setVariable('%M0.0', true)
    ladEng.scanOnce()
    ladNow += 60
    ladEng.scanOnce()
    ladEng.setVariable('%M0.0', false)
    ladNow += 100
    ladEng.scanOnce()
    ladEng.setVariable('%M0.0', true)
    ladEng.scanOnce()
    ladNow += 50
    ladEng.scanOnce()
    const qAfterRetain = ladEng.getVariable('%Q0.0')
    ladEng.setVariable('%M0.1', true)
    ladEng.scanOnce()
    const qAfterReset = ladEng.getVariable('%Q0.0')
    ladEng.stop()
    check('Ladder TONR accumulates elapsed time and resets on rOperand', qAfterRetain === true && qAfterReset === false, { qAfterRetain, qAfterReset })

    // time.ts & onlineValueParser
    check('parseS7Time supports us/ns in ms', parseS7Time('T#500us') === 0.5 && parseS7Time('T#1ms_500us') === 1.5)
    check('parseS7LTimeNs parses nanoseconds accurately', parseS7LTimeNs('LTIME#1s_500ns') === 1_000_000_500n)
    check(
      'onlineValueParser handles SINT, USINT, UINT, CHAR, STRING[4], LTIME and rejects T#999d',
      parseOnlineValue('-120', 'SINT').ok &&
        !parseOnlineValue('200', 'SINT').ok &&
        parseOnlineValue('65535', 'UINT').ok &&
        parseOnlineValue("'Z'", 'CHAR').ok &&
        !parseOnlineValue("'HELLO'", 'STRING[4]').ok &&
        parseOnlineValue('LTIME#5ms', 'LTIME').ok &&
        !parseOnlineValue('T#999d', 'TIME').ok
    )
  }

  console.log(`\nPhase 33 Summary: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
