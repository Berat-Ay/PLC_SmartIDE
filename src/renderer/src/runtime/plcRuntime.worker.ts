/// <reference lib="webworker" />
import { attachRuntimeWorkerHost, MainToWorkerMessage, WorkerToMainMessage } from './workerProtocol'

attachRuntimeWorkerHost(
  self as unknown as {
    postMessage: (msg: WorkerToMainMessage) => void
    onmessage: ((event: { data: MainToWorkerMessage }) => void) | null
  }
)
