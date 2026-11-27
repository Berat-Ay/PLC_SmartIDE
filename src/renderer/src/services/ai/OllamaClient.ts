/** Asks a local Ollama server via /api/chat (with /api/generate fallback when /api/chat route is unavailable). */

import { AgentCancelledError, AiConfig, AiTier, GeminiContent } from './aiTypes'
import { isStrictGeminiTextModel } from './aiConfig'
import { toChatMessages } from './aiClientUtils'
import { aiHttp } from './aiHttp'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'

export interface OllamaRequestOptions {
  prompt: string
  tier: AiTier
  mode: 'auto-apply' | 'diff-view'
  systemInstruction: string
  signal?: AbortSignal
  config: AiConfig
  timeoutMs: number
  /** Endpoint + model pairs that refused or hung in JSON mode. Shared across turns */
  noJsonMode?: Set<string>
}

function parseOllamaError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string }
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
  } catch {
    // not JSON
  }
  return body.slice(0, 300)
}

/** Resolves the configured Ollama model without falling back to Gemini model IDs. */
export function resolveOllamaModel(config: AiConfig): string {
  const dedicated = (config.ollamaModel || '').trim()
  if (dedicated) return dedicated
  const legacySelected = (config.selectedModelId || '').trim()
  if (legacySelected && !isStrictGeminiTextModel(legacySelected)) return legacySelected
  return 'qwen2.5-coder:7b'
}

/**
 * Sends multi-turn conversation history to a local Ollama server (/api/chat, with automatic
 * fallback to /api/generate when /api/chat returns route 404, or retry without JSON mode on 400/timeout/empty).
 */
export function createOllamaRequester(
  options: OllamaRequestOptions
): (contents: GeminiContent[]) => Promise<string> {
  const { prompt, tier, mode, systemInstruction, signal, config, timeoutMs, noJsonMode } = options
  const endpoint = (config.ollamaEndpoint || 'http://localhost:11434').replace(/\/+$/, '')
  const model = resolveOllamaModel(config)

  BlackBoxLogger.getInstance().log('AI_REQUEST', `Ollama API request (${model})`, {
    prompt,
    model,
    endpoint,
    tier,
    mode
  })

  const jsonModeKey = `ollama:${endpoint}|${model}`
  let jsonMode = !(noJsonMode?.has(jsonModeKey))
  let useGenerateFallback = false

  const dropJsonMode = (why: string): void => {
    BlackBoxLogger.getInstance().log(
      'AI_FALLBACK_OR_RETRY',
      `Ollama ${model} ${why}. Retrying without format:'json'`,
      { endpoint, model }
    )
    jsonMode = false
    noJsonMode?.add(jsonModeKey)
  }

  const requestModel = async (contents: GeminiContent[], allowJsonRetry = true): Promise<string> => {
    if (signal?.aborted) {
      throw new AgentCancelledError()
    }
    const startMs = Date.now()

    const sendChat = () => {
      const messages = toChatMessages(systemInstruction, contents)
      return aiHttp(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          ...(jsonMode ? { format: 'json' } : {}),
          options: { temperature: 0.1 }
        }),
        timeoutMs,
        signal,
        allowPrivateNetwork: config.allowPrivateNetwork
      })
    }

    const sendGenerate = () => {
      const transcript = contents
        .map((c) => `${c.role === 'model' ? 'ASSISTANT' : 'USER'}:\n${c.parts.map((p) => p.text).join('\n')}`)
        .join('\n\n')
      return aiHttp(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          system: systemInstruction,
          prompt: transcript,
          stream: false,
          ...(jsonMode ? { format: 'json' } : {}),
          options: { temperature: 0.1 }
        }),
        timeoutMs,
        signal,
        allowPrivateNetwork: config.allowPrivateNetwork
      })
    }

    let res = useGenerateFallback ? await sendGenerate() : await sendChat()

    if (res.error === 'cancelled' || signal?.aborted) {
      throw new AgentCancelledError()
    }

    if (!useGenerateFallback && res.status === 404) {
      const errDetail = parseOllamaError(res.body)
      if (/model\b.*not found/i.test(errDetail)) {
        throw new Error(`Ollama model '${model}' is not installed (${errDetail}). Pull it with 'ollama pull ${model}'.`)
      }
      BlackBoxLogger.getInstance().log(
        'AI_FALLBACK_OR_RETRY',
        `Ollama /api/chat returned 404 for ${model}; falling back to /api/generate`,
        { endpoint, model }
      )
      useGenerateFallback = true
      res = await sendGenerate()
      if (res.error === 'cancelled' || signal?.aborted) {
        throw new AgentCancelledError()
      }
    }

    if (res.status === 400 && jsonMode && !signal?.aborted) {
      dropJsonMode(`refused JSON format (HTTP 400: ${res.body.slice(0, 200)})`)
      res = useGenerateFallback ? await sendGenerate() : await sendChat()
    }

    if (res.error === 'cancelled' || signal?.aborted) {
      throw new AgentCancelledError()
    }
    if (res.error === 'timeout' && jsonMode && allowJsonRetry) {
      dropJsonMode(`timed out after ${Math.round(timeoutMs / 1000)} s in JSON mode`)
      return requestModel(contents, false)
    }
    if (res.error === 'timeout') {
      throw new Error(`Ollama model ${model} at ${endpoint} did not answer in ${Math.round(timeoutMs / 1000)} s.`)
    }
    if (res.error) {
      throw new Error(`Could not reach Ollama at ${endpoint}: ${res.message}`)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Ollama HTTP ${res.status}: ${parseOllamaError(res.body) || res.statusText}`)
    }

    let rawText = ''
    let hasThinkingOnly = false
    try {
      const data = JSON.parse(res.body) as {
        message?: { content?: string; thinking?: string }
        response?: string
        thinking?: string
      }
      rawText =
        typeof data.message?.content === 'string'
          ? data.message.content
          : typeof data.response === 'string'
            ? data.response
            : ''
      hasThinkingOnly =
        !rawText.trim() &&
        Boolean((typeof data.message?.thinking === 'string' && data.message.thinking.trim()) || (typeof data.thinking === 'string' && data.thinking.trim()))
    } catch {
      throw new Error(`Ollama at ${endpoint} answered with invalid JSON: ${res.body.slice(0, 200)}`)
    }

    if (!rawText.trim() && jsonMode && allowJsonRetry) {
      dropJsonMode(hasThinkingOnly ? 'returned thinking tokens without answer text in JSON mode' : 'returned empty text in JSON mode')
      return requestModel(contents, false)
    }
    if (!rawText.trim()) {
      throw new Error(`Ollama model ${model} answered without any text.`)
    }

    BlackBoxLogger.getInstance().log(
      'AI_RAW_RESPONSE',
      `Ollama API response from ${model} (${Date.now() - startMs}ms, ${rawText.length} chars)`,
      { model, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
    )
    return rawText
  }

  return (contents) => requestModel(contents, true)
}
