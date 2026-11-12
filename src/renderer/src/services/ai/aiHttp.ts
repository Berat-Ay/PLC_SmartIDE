import type { AiHttpResponse } from '@shared/types/ipc'

export type AiHttpResult = AiHttpResponse

interface AiHttpOptions {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  signal?: AbortSignal
}

let requestCounter = 0

/**
 * Sends a request to an AI API. In the app it goes out from the main process, so a server that sends no CORS
 * headers still answers. Without Electron (tests, the browser preview) it is a plain fetch.
 * It never throws: no HTTP answer is status 0 with error set.
 */
export async function aiHttp(url: string, options: AiHttpOptions): Promise<AiHttpResult> {
  const cancelled: AiHttpResult = { status: 0, statusText: '', body: '', error: 'cancelled', message: 'Cancelled' }
  if (options.signal?.aborted) return cancelled

  const api = typeof window !== 'undefined' ? window.electronApi : undefined
  if (api?.aiHttpRequest) {
    const id = `ai_${Date.now()}_${requestCounter++}`
    const onAbort = (): void => {
      void api.aiHttpCancel(id)
    }
    options.signal?.addEventListener('abort', onAbort)
    try {
      return await api.aiHttpRequest({
        id,
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
        timeoutMs: options.timeoutMs
      })
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.method === 'POST' ? options.body : undefined,
      signal: controller.signal
    })
    return { status: response.status, statusText: response.statusText, body: await response.text() }
  } catch (err) {
    if (controller.signal.aborted) {
      return timedOut
        ? { status: 0, statusText: '', body: '', error: 'timeout', message: `No answer in ${Math.round(options.timeoutMs / 1000)} s` }
        : cancelled
    }
    return { status: 0, statusText: '', body: '', error: 'network', message: String((err as Error)?.message || err) }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
