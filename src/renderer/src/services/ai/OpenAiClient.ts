/** Asks an OpenAI-compatible API (OpenAI, or a custom server with /v1/chat/completions), streamed where it allows */

import { aiHttp } from './aiHttp'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { AiConfig, AiTier, GeminiContent } from './aiTypes'

/** The text of a streamed (server-sent events) chat answer, or null when the body is not a stream */
function readStreamedChat(body: string): { text: string | null; error?: string } {
  if (!/^\s*data:/m.test(body)) return { text: null }
  const partText = (content: unknown): string =>
    Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text || '')).join('')
      : typeof content === 'string'
        ? content
        : ''
  let text = ''
  for (const line of body.split(/\r?\n/)) {
    const data = line.match(/^\s*data:\s?(.*)$/)?.[1]?.trim()
    if (!data || data === '[DONE]') continue
    let chunk: { error?: { message?: string } | string; choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> }
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (chunk.error) return { text, error: typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'unknown error' }
    const choice = chunk.choices?.[0]
    text += partText(choice?.delta?.content) + partText(choice?.message?.content)
  }
  return { text }
}

/** The API's base URL, ending before /chat/completions */
export function openAiBaseUrl(config: AiConfig): string {
  return (config.openaiEndpoint || 'https://api.openai.com/v1')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
}

/** The message of an OpenAI-style error body, or the start of the body */
export function apiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message
    if (message) return message
  } catch {
    // not JSON
  }
  // A proxy's error page: its title says what happened
  const title = body.match(/<title>([^<]*)<\/title>/i)
  if (title) return title[1].trim()
  return body.slice(0, 300)
}

export interface OpenAiRequestOptions {
  prompt: string
  tier: AiTier
  mode: 'auto-apply' | 'diff-view'
  systemInstruction: string
  signal?: AbortSignal
  config: AiConfig
  /** Endpoint + model pairs that accept JSON mode but never answer in it. Each costs one timeout */
  noJsonMode: Set<string>
  timeoutMs: number
}

/**
 * A function that sends the conversation to an OpenAI-compatible API and returns the text of the answer. Throws
 * at once when no model is set.
 */
export function createOpenAiRequester(options: OpenAiRequestOptions): (contents: GeminiContent[]) => Promise<string> {
  const { prompt, tier, mode, signal, config, noJsonMode, timeoutMs } = options
  const systemInstructionText = options.systemInstruction
  const base = openAiBaseUrl(config)
  const isOpenAi = /api\.openai\.com/i.test(base)
  const model = (config.openaiModel || '').trim() || (isOpenAi ? (tier === 'fast-flash' ? 'gpt-4o-mini' : 'gpt-4o') : '')
  if (!model) {
    throw new Error('No model is set for this API. Fetch the models or type a model name in the AI settings.')
  }
  const key = (config.openaiApiKey || '').trim()
  BlackBoxLogger.getInstance().log('AI_REQUEST', `OpenAI-compatible API request (${model})`, { prompt, model, endpoint: base, tier, mode })

  // Not every server knows response_format. One that refuses it is asked without it from then on
  const jsonModeKey = `${base}|${model}`
  let jsonMode = !noJsonMode.has(jsonModeKey)
  // JSON mode accepted but no answer in it: the same request is asked once more without it, and the next ones too
  const dropJsonMode = (why: string): void => {
    BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `${model} ${why} in JSON mode. Asking without response_format`, {
      model,
      endpoint: base
    })
    jsonMode = false
    noJsonMode.add(jsonModeKey)
  }
  // Streamed, the first bytes come at once: a proxy such as Cloudflare cuts a request that is silent for 100 s (HTTP 524)
  let streamMode = true
  // Reasoning models (OpenAI o-series, GPT-5) accept only their default temperature
  let sendTemperature = true
  const requestModel = async (contents: GeminiContent[]): Promise<string> => {
    const startMs = Date.now()
    const messages = [
      { role: 'system', content: systemInstructionText },
      ...contents.map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts.map((p) => p.text).join('\n') }))
    ]
    const send = () =>
      aiHttp(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          ...(sendTemperature ? { temperature: 0.1 } : {}),
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(streamMode ? { stream: true } : {})
        }),
        timeoutMs: timeoutMs,
        signal
      })

    let res = await send()
    if (res.status === 400 && sendTemperature && /temperature/i.test(res.body)) {
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `${model} refused the temperature (HTTP 400). Asking without it`, {
        errorBody: res.body.slice(0, 2000)
      })
      sendTemperature = false
      res = await send()
    }
    if (res.status === 400 && jsonMode) {
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `${model} refused response_format (HTTP 400). Asking without it`, {
        errorBody: res.body.slice(0, 2000)
      })
      jsonMode = false
      res = await send()
    }
    if (res.status === 400 && streamMode) {
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `${model} refused streaming (HTTP 400). Asking without it`, {
        errorBody: res.body.slice(0, 2000)
      })
      streamMode = false
      res = await send()
    }
    // Busy or rate limited: one more try after a short wait
    if ([429, 500, 502, 503, 504].includes(res.status) && !signal?.aborted) {
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `${model} returned HTTP ${res.status}. Trying again in 2 s`, {
        errorBody: res.body.slice(0, 2000)
      })
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (!signal?.aborted) res = await send()
    }
    if (res.error === 'cancelled' || signal?.aborted) throw new Error('Synthesis cancelled by user.')
    if (res.error === 'timeout' && jsonMode) {
      dropJsonMode(`did not answer in ${timeoutMs / 1000} s`)
      return requestModel(contents)
    }
    if (res.error === 'timeout') throw new Error(`${model} at ${base} did not answer in ${timeoutMs / 1000} s.`)
    if (res.error) throw new Error(`Could not reach ${base}: ${res.message}`)
    if (res.status < 200 || res.status >= 300) {
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `${model} returned HTTP ${res.status}`, {
        model,
        status: res.status,
        url: `${base}/chat/completions`,
        errorBody: res.body.slice(0, 2000)
      })
      const proxyTimeout =
        res.status === 524
          ? ' The proxy in front of the server (Cloudflare) closed the request after 100 s without an answer. The server did not stream its answer, so a long answer cannot arrive through it: choose a faster model or ask the server owner to stream.'
          : ''
      throw new Error(`HTTP ${res.status} from ${base}: ${apiErrorMessage(res.body) || res.statusText}.${proxyTimeout}`)
    }

    let content: unknown
    const streamed = readStreamedChat(res.body)
    if (streamed.error) throw new Error(`${base} stopped the answer: ${streamed.error}`)
    if (streamed.text !== null) content = streamed.text
    else {
      try {
        content = (JSON.parse(res.body) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      } catch {
        throw new Error(`${base} answered with something that is not JSON: ${res.body.slice(0, 200)}`)
      }
    }
    // Some servers send the content as parts
    const rawText = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text || '')).join('')
      : typeof content === 'string'
        ? content
        : ''
    if (!rawText.trim() && jsonMode) {
      dropJsonMode('answered without any text')
      return requestModel(contents)
    }
    // JSON mode promises a JSON object. Plain text instead means it does not work on this server: a gateway that
    // puts its own note ("the provider returned nothing") where the answer should be, or one that drops the
    // option. Without JSON mode a plain text answer is the model's own, and is read as such
    const trimmed = rawText.trim()
    if (jsonMode && trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('```')) {
      dropJsonMode('answered with text that is not JSON')
      return requestModel(contents)
    }
    if (!rawText.trim()) throw new Error(`${model} answered without any text.`)
    BlackBoxLogger.getInstance().log(
      'AI_RAW_RESPONSE',
      `OpenAI-compatible API response from ${model} (${Date.now() - startMs}ms, ${rawText.length} chars)`,
      { model, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
    )
    return rawText
  }

  return requestModel
}
