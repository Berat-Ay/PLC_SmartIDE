import * as dns from 'dns/promises'
import * as net from 'net'
import { AiHttpRequest, AiHttpResponse } from '../shared/types/ipc'

type SecretReader = (key: string) => Promise<string | null>
let secretReader: SecretReader | null = null

export function setAiHttpSecretReader(reader: SecretReader | null): void {
  secretReader = reader
}

async function readSecret(key: string): Promise<string | null> {
  return secretReader ? secretReader(key) : null
}

// Requests to AI APIs go out from here. The renderer is a browser and drops the answer of a server that
// sends no CORS headers; Node has no such rule. Only http and https, only GET and POST.
const running = new Map<string, AbortController>()
const MAX_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

const BLOCKED_METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data'])

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums
}

function unwrapMappedIpv4(ip: string): string {
  const lower = ip.toLowerCase()
  const v4Match = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Match) return v4Match[1]
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16)
    const lo = parseInt(hexMatch[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return lower
}

function checkIpPolicy(rawIp: string, allowPrivateNetwork: boolean): string | null {
  const ip = unwrapMappedIpv4(rawIp)
  const v4 = parseIpv4(ip)
  if (v4) {
    const [a, b] = v4
    // Loopback (127.0.0.0/8) is permitted for local Ollama / LM Studio / local test mocks
    if (a === 127) return null
    // Always blocked: 0.0.0.0/8, link-local / cloud metadata 169.254.0.0/16, multicast/reserved >= 224
    if (a === 0 || (a === 169 && b === 254) || a >= 224) {
      return `Blocked target IP address: ${rawIp}`
    }
    // Private RFC1918 LAN: blocked unless user explicitly enabled allowPrivateNetwork
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    if (isPrivate && !allowPrivateNetwork) {
      return `Private LAN IP '${rawIp}' is blocked unless 'Allow private LAN AI endpoints' is enabled in AI settings`
    }
    return null
  }

  // IPv6 checks
  const norm = ip.toLowerCase()
  if (norm === '::1' || norm === '0:0:0:0:0:0:0:1') return null
  if (norm === '::' || norm === '0:0:0:0:0:0:0:0') return `Blocked target IP address: ${rawIp}`
  if (/^fe[89ab][0-9a-f]:/i.test(norm) || /^ff[0-9a-f]{2}:/i.test(norm) || norm.startsWith('fd00:ec2::254')) {
    return `Blocked target IP address: ${rawIp}`
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(norm) && !allowPrivateNetwork) {
    return `Private LAN IPv6 '${rawIp}' is blocked unless 'Allow private LAN AI endpoints' is enabled in AI settings`
  }
  return null
}

async function validateTargetUrl(url: URL, allowPrivateNetwork: boolean): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return 'Target host cannot be empty'
  if (BLOCKED_METADATA_HOSTS.has(host)) return `Blocked metadata host: ${host}`

  if (net.isIP(host) !== 0) {
    return checkIpPolicy(host, allowPrivateNetwork)
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return null
  }

  try {
    const records = await dns.lookup(host, { all: true })
    if (records.length === 0) return `Could not resolve host '${host}'`
    for (const rec of records) {
      const err = checkIpPolicy(rec.address, allowPrivateNetwork)
      if (err) return err
    }
    return null
  } catch (err) {
    // Allow Playwright NODE_ENV=test offline fetch mocks for Google Gemini endpoint
    if (process.env.NODE_ENV === 'test' && host === 'generativelanguage.googleapis.com') {
      return null
    }
    return `DNS lookup failed for '${host}': ${(err as Error)?.message || String(err)}`
  }
}

async function readBoundedText(response: Response, maxBytes: number, controller: AbortController): Promise<{ text: string; tooLarge: boolean }> {
  const contentLength = Number(response.headers?.get?.('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort()
    return { text: '', tooLarge: true }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    const chunks: string[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          controller.abort()
          await reader.cancel().catch(() => {})
          return { text: '', tooLarge: true }
        }
        chunks.push(decoder.decode(value, { stream: true }))
      }
    }
    chunks.push(decoder.decode())
    return { text: chunks.join(''), tooLarge: false }
  }

  const text = await response.text()
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    return { text: '', tooLarge: true }
  }
  return { text, tooLarge: false }
}

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

  if (request.authSecret === 'geminiApiKey') {
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'generativelanguage.googleapis.com') {
      return {
        status: 0,
        statusText: '',
        body: '',
        error: 'network',
        message: 'Gemini API key may only be sent to https://generativelanguage.googleapis.com'
      }
    }
  }

  const ssrfError = await validateTargetUrl(url, Boolean(request.allowPrivateNetwork))
  if (ssrfError) {
    return { status: 0, statusText: '', body: '', error: 'network', message: ssrfError }
  }

  const headers: Record<string, string> = { ...(request.headers || {}) }
  if (request.authSecret === 'geminiApiKey') {
    const secret = await readSecret('geminiApiKey')
    if (!secret) {
      return { status: 0, statusText: '', body: '', error: 'network', message: 'Gemini API key is not stored.' }
    }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-goog-api-key') delete headers[k]
    }
    headers['x-goog-api-key'] = secret
  } else if (request.authSecret === 'openaiApiKey') {
    const secret = await readSecret('openaiApiKey')
    if (!secret) {
      return { status: 0, statusText: '', body: '', error: 'network', message: 'OpenAI API key is not stored.' }
    }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') delete headers[k]
    }
    headers['Authorization'] = `Bearer ${secret}`
  }

  const effectiveTimeoutMs = Math.min(Math.max(Number(request.timeoutMs) || 60000, 1000), MAX_TIMEOUT_MS)
  if (running.has(request.id)) {
    running.get(request.id)?.abort()
  }

  const controller = new AbortController()
  let timedOut = false
  let sizeExceeded = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, effectiveTimeoutMs)
  running.set(request.id, controller)

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : undefined,
      redirect: 'error',
      signal: controller.signal
    })
    const bounded = await readBoundedText(response, MAX_RESPONSE_BYTES, controller)
    if (bounded.tooLarge) {
      sizeExceeded = true
      return {
        status: 0,
        statusText: '',
        body: '',
        error: 'network',
        message: `Response exceeded ${Math.round(MAX_RESPONSE_BYTES / (1024 * 1024))} MB limit`
      }
    }
    return { status: response.status, statusText: response.statusText, body: bounded.text }
  } catch (err) {
    if (sizeExceeded) {
      return {
        status: 0,
        statusText: '',
        body: '',
        error: 'network',
        message: `Response exceeded ${Math.round(MAX_RESPONSE_BYTES / (1024 * 1024))} MB limit`
      }
    }
    if (controller.signal.aborted) {
      return timedOut
        ? { status: 0, statusText: '', body: '', error: 'timeout', message: `No answer in ${Math.round(effectiveTimeoutMs / 1000)} s` }
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
    if (running.get(request.id) === controller) {
      running.delete(request.id)
    }
  }
}

export function cancelAiHttpRequest(id: string): void {
  running.get(id)?.abort()
}

export function cancelAllAiHttpRequests(): void {
  for (const controller of running.values()) {
    controller.abort()
  }
  running.clear()
}
