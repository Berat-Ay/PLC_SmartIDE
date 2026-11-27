import type { PlantPhysicsEngine } from './PlantPhysicsEngine'
import type { PlcRuntimeEngine } from './PlcRuntimeEngine'

const DEFAULT_WATCHED_VARS = [
  '%Q0.0',
  '%Q0.1',
  '%Q0.2',
  'HydraulicPump_Run',
  'MainConveyor_Run',
  'TankHeater_Enable'
]

interface StepPatch {
  physicsPatch?: {
    tankLevelRaw?: number
    reactorTempRaw?: number
    conveyorPosition?: number
  }
  bitWrites?: Array<{ area: string; byte: number; bit: number; value: boolean }>
  varWrites?: Array<{ name: string; value: unknown }>
}

function extractScenarioBody(code: string): string {
  const headerMatch = code.match(/export\s+default\s+function\s*\w*\s*\([^)]*\)\s*\{/)
  if (!headerMatch || headerMatch.index === undefined) {
    return code
  }
  const afterOpen = code.slice(headerMatch.index + headerMatch[0].length)
  const lastBrace = afterOpen.lastIndexOf('}')
  return lastBrace >= 0 ? afterOpen.slice(0, lastBrace) : afterOpen
}

function extractWatchedVars(code: string): string[] {
  const vars = new Set<string>(DEFAULT_WATCHED_VARS)
  const regex = /\bruntime\.getVariable\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(code)) !== null) {
    if (m[2]) vars.add(m[2])
  }
  return Array.from(vars)
}

export class SimScenarioSandbox {
  private iframe: HTMLIFrameElement | null = null
  private ready = false
  private readyResolvers: Array<() => void> = []
  private nextId = 1
  private pendingCompile = new Map<number, { resolve: (res: { ok: boolean; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>()
  private inFlightStepId: number | null = null
  private inFlightTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPatch: StepPatch | null = null
  private watchedVars: string[] = [...DEFAULT_WATCHED_VARS]
  private compiled = false
  private onRuntimeError?: (error: string) => void

  private handleMessage = (event: MessageEvent): void => {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return
    const msg = event.data as Record<string, unknown> | null
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'ready') {
      this.ready = true
      const resolvers = this.readyResolvers.splice(0)
      resolvers.forEach((r) => r())
      return
    }

    if (msg.type === 'compileResult') {
      const id = Number(msg.id)
      const pending = this.pendingCompile.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingCompile.delete(id)
      const ok = Boolean(msg.ok)
      this.compiled = ok
      pending.resolve({ ok, error: typeof msg.error === 'string' ? msg.error : undefined })
      return
    }

    if (msg.type === 'stepResult') {
      const id = Number(msg.id)
      if (this.inFlightStepId !== id) return
      this.inFlightStepId = null
      if (this.inFlightTimer) {
        clearTimeout(this.inFlightTimer)
        this.inFlightTimer = null
      }
      if (!msg.ok) {
        this.compiled = false
        this.pendingPatch = null
        const err = typeof msg.error === 'string' ? msg.error : 'Simulation script execution failed'
        this.onRuntimeError?.(err)
        return
      }
      this.pendingPatch = {
        physicsPatch: msg.physicsPatch as StepPatch['physicsPatch'],
        bitWrites: Array.isArray(msg.bitWrites) ? (msg.bitWrites as StepPatch['bitWrites']) : [],
        varWrites: Array.isArray(msg.varWrites) ? (msg.varWrites as StepPatch['varWrites']) : []
      }
    }
  }

  public setOnRuntimeError(cb?: (error: string) => void): void {
    this.onRuntimeError = cb
  }

  private async ensureFrame(): Promise<void> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Simulation sandbox requires a browser DOM environment')
    }
    if (!this.iframe) {
      window.addEventListener('message', this.handleMessage)
      const iframe = document.createElement('iframe')
      iframe.setAttribute('sandbox', 'allow-scripts')
      iframe.setAttribute('data-testid', 'sim-scenario-sandbox-frame')
      iframe.style.display = 'none'
      iframe.style.width = '0'
      iframe.style.height = '0'
      iframe.style.border = '0'
      iframe.src = 'rungline-sim://sandbox/index.html'
      document.body.appendChild(iframe)
      this.iframe = iframe
    }

    if (this.ready) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Simulation sandbox failed to initialize'))
      }, 2500)
      this.readyResolvers.push(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  public async compile(code: string): Promise<{ ok: boolean; error?: string }> {
    this.pendingPatch = null
    this.inFlightStepId = null
    if (this.inFlightTimer) {
      clearTimeout(this.inFlightTimer)
      this.inFlightTimer = null
    }
    this.compiled = false

    try {
      await this.ensureFrame()
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const body = extractScenarioBody(code)
    this.watchedVars = extractWatchedVars(code)
    const id = this.nextId++

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCompile.delete(id)
        resolve({ ok: false, error: 'Simulation script compile timed out' })
      }, 2000)
      this.pendingCompile.set(id, { resolve, timer })
      this.iframe?.contentWindow?.postMessage({ type: 'compile', id, body }, '*')
    })
  }

  public step(physics: PlantPhysicsEngine, runtime: PlcRuntimeEngine, dt: number): void {
    // Apply the latest completed sandbox tick result
    const patch = this.pendingPatch
    if (patch) {
      this.pendingPatch = null
      if (patch.physicsPatch) {
        if (Number.isFinite(patch.physicsPatch.tankLevelRaw)) {
          physics.tankLevelRaw = Number(patch.physicsPatch.tankLevelRaw)
        }
        if (Number.isFinite(patch.physicsPatch.reactorTempRaw)) {
          physics.reactorTempRaw = Number(patch.physicsPatch.reactorTempRaw)
        }
        if (Number.isFinite(patch.physicsPatch.conveyorPosition)) {
          physics.conveyorPosition = Number(patch.physicsPatch.conveyorPosition)
        }
      }
      for (const bw of patch.bitWrites || []) {
        if (bw.area === 'I' || bw.area === 'Q' || bw.area === 'M') {
          runtime.setBit(bw.area, bw.byte, bw.bit, bw.value)
        }
      }
      for (const vw of patch.varWrites || []) {
        if (vw.name) {
          runtime.setVariable(vw.name, vw.value)
        }
      }
    }

    if (!this.compiled || !this.ready || !this.iframe?.contentWindow || this.inFlightStepId !== null) {
      return
    }

    const vars: Record<string, unknown> = {}
    for (const key of this.watchedVars) {
      vars[key] = runtime.getVariable(key)
    }

    const id = this.nextId++
    this.inFlightStepId = id
    this.inFlightTimer = setTimeout(() => {
      if (this.inFlightStepId === id) {
        this.inFlightStepId = null
        this.compiled = false
        this.onRuntimeError?.('Simulation script step timed out (50ms sandbox limit)')
      }
    }, 150)

    this.iframe.contentWindow.postMessage(
      {
        type: 'step',
        id,
        dt,
        physics: {
          tankLevelRaw: physics.tankLevelRaw,
          fillRateRawPerSec: physics.fillRateRawPerSec,
          drainRateRawPerSec: physics.drainRateRawPerSec,
          outflowValvePct: physics.outflowValvePct,
          reactorTempRaw: physics.reactorTempRaw,
          conveyorPosition: physics.conveyorPosition
        },
        vars
      },
      '*'
    )
  }

  public dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleMessage)
    }
    for (const pending of this.pendingCompile.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingCompile.clear()
    if (this.inFlightTimer) {
      clearTimeout(this.inFlightTimer)
      this.inFlightTimer = null
    }
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = null
    }
    this.ready = false
    this.compiled = false
  }
}
