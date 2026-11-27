import type {
  MainToWorkerMessage,
  WorkerPortLike,
  WorkerToMainMessage
} from './workerProtocol'

type SnapshotBatchMsg = Extract<WorkerToMainMessage, { type: 'snapshotBatch' }>
type StateChangeMsg = Extract<WorkerToMainMessage, { type: 'stateChange' }>

/**
 * Manages the lifecycle and message passing for the off-thread SoftPLC Web Worker.
 */
export class PlcRuntimeWorkerClient {
  private port: WorkerPortLike | null = null
  private portFactory: () => WorkerPortLike
  private hasCustomPortFactory: boolean
  private onStateChangeCb?: (state: StateChangeMsg['state']) => void
  private onSnapshotBatchCb?: (batch: SnapshotBatchMsg) => void
  private onErrorCb?: (message: string) => void

  constructor(portFactory?: () => WorkerPortLike) {
    this.hasCustomPortFactory = Boolean(portFactory)
    this.portFactory =
      portFactory ||
      (() =>
        new Worker(new URL('./plcRuntime.worker.ts', import.meta.url), {
          type: 'module'
        }) as unknown as WorkerPortLike)
  }

  public isAvailable(): boolean {
    return typeof Worker !== 'undefined' || this.hasCustomPortFactory
  }

  public isRunning(): boolean {
    return this.port !== null
  }

  public ensureStarted(): boolean {
    if (this.port) return true
    if (!this.isAvailable()) return false
    try {
      const port = this.portFactory()
      port.onmessage = (event) => {
        const msg = event.data as WorkerToMainMessage
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'stateChange') {
          this.onStateChangeCb?.(msg.state)
        } else if (msg.type === 'snapshotBatch') {
          this.onSnapshotBatchCb?.(msg)
        } else if (msg.type === 'error') {
          this.onErrorCb?.(msg.message)
        }
      }
      port.onerror = (err) => {
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err !== null
              ? (err as { message?: string; error?: { message?: string } }).message ||
                (err as { error?: { message?: string } }).error?.message ||
                'Worker crashed unexpectedly'
              : String(err)
        this.dispose()
        this.onErrorCb?.(message)
      }
      this.port = port
      return true
    } catch {
      return false
    }
  }

  public post(msg: MainToWorkerMessage): void {
    if (!this.port && !this.ensureStarted()) return
    this.port?.postMessage(msg)
  }

  public setOnStateChange(cb: (state: StateChangeMsg['state']) => void): void {
    this.onStateChangeCb = cb
  }

  public setOnSnapshotBatch(cb: (batch: SnapshotBatchMsg) => void): void {
    this.onSnapshotBatchCb = cb
  }

  public setOnError(cb: (message: string) => void): void {
    this.onErrorCb = cb
  }

  public dispose(): void {
    if (this.port) {
      this.port.onmessage = null
      this.port.onerror = null
      this.port.terminate?.()
      this.port = null
    }
  }
}
