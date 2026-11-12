import { AiHttpRequest, AiHttpResponse } from '../shared/types/ipc'

// Requests to AI APIs go out from here. The renderer is a browser and drops the answer of a server that
// sends no CORS headers; Node has no such rule. Only http and https, only GET and POST
const running = new Map<string, AbortController>()
const MAX_TIMEOUT_MS = 10 * 60 * 1000

export async function sendAiHttpRequest(request: AiHttpRequest): Promise<AiHttpResponse> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return { status: 0, statusText: '', body: '', error: 'network', message: `Not a valid URL: ${request.url}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { status: 0, statusText: '', body: '', error: 'network', message: 'Only http and https URLs are allowed' }
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return { status: 0, statusText: '', body: '', error: 'network', message: 'Only GET and POST are allowed' }
  }

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(
    () => {
      timedOut = true
      controller.abort()
    },
    Math.min(Math.max(request.timeoutMs || 0, 1000), MAX_TIMEOUT_MS)
  )
  running.set(request.id, controller)
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'POST' ? request.body : undefined,
      signal: controller.signal
    })
    return { status: response.status, statusText: response.statusText, body: await response.text() }
  } catch (err) {
    if (controller.signal.aborted) {
      return timedOut
        ? { status: 0, statusText: '', body: '', error: 'timeout', message: `No answer in ${Math.round(request.timeoutMs / 1000)} s` }
        : { status: 0, statusText: '', body: '', error: 'cancelled', message: 'Cancelled' }
    }
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause
    return {
      status: 0,
      statusText: '',
      body: '',
      error: 'network',
      message: [String((err as Error)?.message || err), cause?.code, cause?.message].filter(Boolean).join(': ')
    }
  } finally {
    clearTimeout(timeout)
    running.delete(request.id)
  }
}

export function cancelAiHttpRequest(id: string): void {
  running.get(id)?.abort()
}
