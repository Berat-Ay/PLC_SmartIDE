// Regression tests for SoftPLC Runtime Web Worker Isolation & Mirror Synchronization.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlcRuntimeEngine, ExternalRuntimeWriteCmd } from '../renderer/src/runtime/PlcRuntimeEngine'
import { PlcRuntimeWorkerClient } from '../renderer/src/runtime/PlcRuntimeWorkerClient'
import {
  attachRuntimeWorkerHost,
  MainToWorkerMessage,
  WorkerPortLike,
  WorkerToMainMessage
} from '../renderer/src/runtime/workerProtocol'
import { CPU_1214C_PROFILE } from '../shared/constants/cpuProfiles'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'
import type { ProjectLoadPayload } from '../shared/types/ipc'

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

function createPairedMemoryPort(): { clientPort: WorkerPortLike; hostPort: { postMessage: (msg: WorkerToMainMessage) => void; onmessage: ((event: { data: MainToWorkerMessage }) => void) | null } } {
  const clientPort: WorkerPortLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: unknown) {
      hostPort.onmessage?.({ data: msg as MainToWorkerMessage })
    },
    terminate() {
      clientPort.onmessage = null
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
  console.log('=== PHASE 31: SOFTPLC WEB WORKER ISOLATION ===\n')

  const { clientPort, hostPort } = createPairedMemoryPort()
  const workerEngine = attachRuntimeWorkerHost(hostPort)
  const client = new PlcRuntimeWorkerClient(() => clientPort)
  const mirrorEngine = new PlcRuntimeEngine()

  let now = 1000
  workerEngine.setClock(() => now)

  const stateEvents: string[] = []
  const batches: Array<Extract<WorkerToMainMessage, { type: 'snapshotBatch' }>> = []

  client.setOnStateChange((s) => stateEvents.push(s))
  client.setOnSnapshotBatch((b) => {
    batches.push(b)
    mirrorEngine.ingestWorkerFrame(b.snapshot, b.historyDelta, b.metrics, b.timerStates, b.counterStates)
  })

  // Forward mirror external writes directly to worker client just like useRuntimeStore does
  const forwardedCmds: ExternalRuntimeWriteCmd[] = []
  mirrorEngine.setExternalWriteSink((cmd) => {
    forwardedCmds.push(cmd)
    if (cmd.kind === 'setVariable') client.post({ type: 'setVariable', symbolOrAddress: cmd.symbolOrAddress, value: cmd.value })
    else if (cmd.kind === 'setBit') client.post({ type: 'setBit', area: cmd.area, byte: cmd.byte, bit: cmd.bit, value: cmd.value })
    else if (cmd.kind === 'setForcedValue') client.post({ type: 'setForcedValue', addressOrSymbol: cmd.addressOrSymbol, value: cmd.value, active: cmd.active })
    else if (cmd.kind === 'setTraceRecording') client.post({ type: 'setTraceRecording', active: cmd.active })
  })

  const payload: ProjectLoadPayload = {
    projectPath: '/tmp/worker_proj',
    metadata: {
      id: 'wrk_1',
      name: 'WorkerTest',
      targetCpu: 'Virtual S7-1200',
      firmwareVersion: CPU_1214C_PROFILE.firmwareVersion,
      schemaVersion: '1.0.0',
      author: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectPath: '/tmp/worker_proj'
    },
    hardware: getDefaultCpuConfig(),
    tagTables: [
      {
        id: 'tt_1',
        name: 'Default',
        fileName: 'Default.tags.json',
        tags: [
          { id: 't_in', name: 'Start_Btn', dataType: 'BOOL', address: '%I0.0' },
          { id: 't_out', name: 'Motor_Run', dataType: 'BOOL', address: '%Q0.0' },
          { id: 't_fault', name: 'Diag_Latched', dataType: 'BOOL', address: '%M2.0' }
        ]
      }
    ],
    udts: [],
    dataBlocks: [],
    ladBlocks: [
      {
        blockType: 'OB',
        blockNumber: 1,
        name: 'OB1_Main',
        fileName: 'OB1_Main.lad.json',
        optimizedAccess: true,
        schemaVersion: '2.0',
        interface: { input: [], output: [], inOut: [], static: [], temp: [], constant: [] },
        networks: [
          {
            id: 'n1',
            networkNumber: 1,
            title: 'Start Motor',
            nodes: [
              { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Start_Btn' },
              { id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor_Run' }
            ]
          }
        ]
      },
      {
        blockType: 'OB',
        blockNumber: 82,
        name: 'OB82_Diag',
        fileName: 'OB82_Diag.lad.json',
        optimizedAccess: true,
        schemaVersion: '2.0',
        interface: { input: [], output: [], inOut: [], static: [], temp: [], constant: [] },
        networks: [
          {
            id: 'n82',
            networkNumber: 1,
            title: 'Fault Latch',
            nodes: [
              { id: 's82', kind: 'coil', coilType: 'SET_COIL', operand: 'Diag_Latched' }
            ]
          }
        ]
      }
    ],
    sclBlocks: []
  }

  client.ensureStarted()
  mirrorEngine.loadProject(payload)
  client.post({ type: 'loadProject', payload })
  client.post({ type: 'setMonitoring', enabled: true })

  // Start worker cyclic engine & immediately kill its setInterval so test drives deterministic cycles cleanly
  client.post({ type: 'start' })
  // Stop real interval inside workerEngine while keeping state === 'RUN' and driving cyclic ticks deterministically
  if ((workerEngine as unknown as { intervalHandle: NodeJS.Timeout | null }).intervalHandle) {
    clearInterval((workerEngine as unknown as { intervalHandle: NodeJS.Timeout | null }).intervalHandle!)
    ;(workerEngine as unknown as { intervalHandle: NodeJS.Timeout | null }).intervalHandle = null
  }
  for (const h of (workerEngine as unknown as { interruptHandles: NodeJS.Timeout[] }).interruptHandles || []) {
    clearInterval(h)
  }

  check(
    'Worker transitions to RUN state upon start message',
    stateEvents.includes('RUN') && workerEngine.getState() === 'RUN',
    { stateEvents, workerState: workerEngine.getState() }
  )

  // Cycle 1 with Start_Btn=false emits initial snapshotBatch (Motor_Run=false)
  ;(workerEngine as unknown as { runCyclicScan: (forceEmit?: boolean) => void }).runCyclicScan(false)
  check(
    'Initial cyclic scan in worker emits baseline snapshotBatch to mirror',
    batches.length === 1 && batches[0].snapshot.cycleNumber === 1 && mirrorEngine.getBit('Q', 0, 0) === false,
    { batches: batches.length, q0: mirrorEngine.getBit('Q', 0, 0) }
  )

  // External write through mirrorEngine propagates to worker via externalWriteSink
  mirrorEngine.setBit('I', 0, 0, true)
  mirrorEngine.setTraceRecordingActive(true)
  check(
    'External setBit and setTraceRecording propagate through externalWriteSink into worker',
    forwardedCmds.some((c) => c.kind === 'setBit' && c.area === 'I' && c.byte === 0 && c.bit === 0 && c.value === true) &&
      forwardedCmds.some((c) => c.kind === 'setTraceRecording' && c.active === true) &&
      workerEngine.getBit('I', 0, 0) === true,
    forwardedCmds
  )

  // Execute unemitted cyclic scan (cycle 2 -> 0-to-1 rising edge!) followed by UI-emitted scan (cycle 3)
  now += 10
  ;(workerEngine as unknown as { runCyclicScan: (forceEmit?: boolean) => void }).runCyclicScan(false)
  now += 10
  ;(workerEngine as unknown as { runCyclicScan: (forceEmit?: boolean) => void }).runCyclicScan(true)

  const lastBatch = batches[batches.length - 1]
  const edgeSnap = mirrorEngine.jumpToLastEdge('Motor_Run')
  check(
    'Worker snapshotBatch carries all missed cyclic historyDelta frames + liveTagValues to mirror ring buffer',
    lastBatch.historyDelta.length === 2 &&
      mirrorEngine.getBit('Q', 0, 0) === true &&
      Boolean(lastBatch.liveTagValues['t_out']) === true &&
      edgeSnap?.cycleNumber === 2,
    {
      deltaLen: lastBatch.historyDelta.length,
      mirrorQ0: mirrorEngine.getBit('Q', 0, 0),
      liveQ0: lastBatch.liveTagValues['t_out'],
      edgeCycle: edgeSnap?.cycleNumber
    }
  )

  // OB82 hardware fault injection across worker boundary
  client.post({ type: 'injectFault', channel: '%IW64' })
  check(
    'injectFault message triggers OB82 inside worker and updates mirror memory',
    mirrorEngine.getBit('M', 2, 0) === true,
    mirrorEngine.getBit('M', 2, 0)
  )

  // Stop & Reset across worker boundary
  client.post({ type: 'stop' })
  client.post({ type: 'reset' })
  check(
    'stop and reset messages synchronize STOP state back to main client',
    stateEvents[stateEvents.length - 1] === 'STOP' && workerEngine.getState() === 'STOP',
    stateEvents
  )

  client.dispose()

  // Static audit of CSP & .gitignore
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const viteConfig = readFileSync(path.join(repoRoot, 'electron.vite.config.ts'), 'utf8')
  const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')

  check(
    'electron.vite.config.ts includes worker-src CSP directive and plcRuntime.worker.ts exists',
    viteConfig.includes("worker-src 'self' blob:") &&
      existsSync(path.join(repoRoot, 'src/renderer/src/runtime/plcRuntime.worker.ts')) &&
      gitignore.includes('graphify-out/')
  )

  console.log(`\nPhase 31 Summary: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error('Fatal test failure:', err)
  process.exit(1)
})
