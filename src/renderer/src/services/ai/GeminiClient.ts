/**
 * Asks Gemini. The selected model goes first; when it is busy, rate limited, slow or not served, the next
 * candidate is asked, unless the model is pinned.
 */

import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { AgentCancelledError, AiConfig, AiTier, GeminiContent } from './aiTypes'
import { geminiTextModels, sortGeminiModels } from './aiConfig'
import { abortableSleep } from './aiClientUtils'
import { aiHttp } from './aiHttp'

/** How often a pinned model is asked again after a busy, rate limited or slow answer */
const PINNED_MODEL_RETRIES = 6
/** A longer wait than this is not waited for: the request fails and says why */
const PINNED_MODEL_MAX_WAIT_MS = 120000

export interface GeminiRequestOptions {
  prompt: string
  tier: AiTier
  mode: 'auto-apply' | 'diff-view'
  systemInstruction: string
  signal?: AbortSignal
  /** The router's live settings. A model list found on the way, or the model that answered, is stored in them */
  getConfig: () => AiConfig
  saveConfig: () => void
  /** Models that cannot answer this key until the app restarts: no quota at all on this plan, or no longer served */
  unavailableModels: Map<string, string>
  /** Models that answer HTTP 400 to thinkingConfig */
  noThinkingConfig: Set<string>
  /** How long one model may take to answer before the next one is tried */
  timeoutMs: number
  /** True when the key is stored in main-process encrypted storage and should be injected by main aiHttp */
  useStoredSecret?: boolean
}

/** A function that sends the conversation to Gemini and returns the text of the answer */
export function createGeminiRequester(options: GeminiRequestOptions): (contents: GeminiContent[]) => Promise<string> {
  const { prompt, tier, mode, signal, getConfig, saveConfig, unavailableModels, noThinkingConfig, timeoutMs, useStoredSecret } = options
  const systemInstructionText = options.systemInstruction
  const primaryModel = (
    getConfig().selectedModelId || (tier === 'fast-flash' ? getConfig().fastModel : getConfig().deepModel)
  )
    .trim()
    .replace(/^models\//i, '')

  const candidateModels = getConfig().pinModel
    ? [primaryModel]
    : [
        primaryModel,
        ...sortGeminiModels(getConfig().availableModels || [])
          .slice(0, 6)
          .map((m) => m.id),
        'gemini-2.5-flash',
        'gemini-3-flash-preview',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.0-flash'
      ].filter((m, idx, arr) => m && arr.indexOf(m) === idx)
  // A model that failed in this request is not asked again in its later rounds
  const failedThisTurn = new Set<string>()

  BlackBoxLogger.getInstance().log('AI_REQUEST', `Gemini API Request (${primaryModel})`, {
    prompt,
    model: primaryModel,
    candidateModels,
    tier,
    mode
  })

  const cleanKey = (getConfig().geminiApiKey || '').trim()
  const authSecret = !cleanKey && useStoredSecret ? ('geminiApiKey' as const) : undefined
  let attemptedAutoDiscovery = false

  const missingModels: string[] = []
  const requestModel = async (contents: GeminiContent[]): Promise<string> => {
    let rawText = ''
    let lastError: Error | null = null
    let successfulModel = ''
    let modelStartMs = Date.now()

    const usable = candidateModels.filter((m) => !unavailableModels.has(m) && !failedThisTurn.has(m))
    // When every model has failed once, try them again rather than give up without a request
    const queue = usable.length > 0 ? usable : candidateModels.filter((m) => !unavailableModels.has(m))
    if (queue.length === 0) {
      const reasons = Array.from(unavailableModels.entries()).map(([m, why]) => `${m}: ${why}`)
      throw new Error(`No Gemini model can answer with this key. ${reasons.join('; ')}`)
    }
    // A pinned model that is busy, rate limited or slow is asked again after a pause, a few times
    let pinnedRetries = 0
    const waitForPinnedModel = async (status: number, body: string): Promise<boolean> => {
      if (signal?.aborted) return false
      if (!getConfig().pinModel || pinnedRetries >= PINNED_MODEL_RETRIES) return false
      if (status !== 0 && status !== 429 && status !== 503) return false
      if (status === 429 && /limit:\s*0\b/.test(body)) return false
      // A daily quota comes back in hours: waiting would only look like a hang
      if (status === 429 && /PerDay/i.test(body)) return false
      pinnedRetries++
      // Gemini says how long to wait on a 429 ("retryDelay": "23s")
      const suggested = Number(body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1])
      const waitMs = Number.isFinite(suggested) && suggested > 0 ? (suggested + 1) * 1000 : 5000 * 2 ** (pinnedRetries - 1)
      if (waitMs > PINNED_MODEL_MAX_WAIT_MS) return false
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Pinned model: waiting ${Math.round(waitMs / 1000)} s before asking again`, {
        status,
        retry: pinnedRetries
      })
      return abortableSleep(waitMs, signal)
    }

    for (let i = 0; i < queue.length; i++) {
      const modelToTry = queue[i]
      if (signal?.aborted) throw new AgentCancelledError()

      const cleanModelId = modelToTry.trim().replace(/^models\//i, '')
      const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}:generateContent`
      modelStartMs = Date.now()

      const attemptFetch = async (includeThinkingConfig: boolean) => {
        const generationConfig: Record<string, unknown> = {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
        if (includeThinkingConfig) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 }
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (cleanKey) headers['x-goog-api-key'] = cleanKey

        return aiHttp(requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemInstructionText }]
            },
            contents,
            generationConfig
          }),
          timeoutMs,
          signal,
          authSecret
        })
      }

      const sendThinking = !noThinkingConfig.has(cleanModelId)
      let res = await attemptFetch(sendThinking)

      // If HTTP 400 occurred and thinkingConfig was passed, retry once without thinkingConfig
      if (res.status === 400 && sendThinking) {
        BlackBoxLogger.getInstance().log(
          'AI_FALLBACK_OR_RETRY',
          `Candidate model ${cleanModelId} rejected thinkingConfig (HTTP 400). Retrying without thinkingConfig...`,
          { model: cleanModelId, status: 400, errorBody: res.body }
        )
        res = await attemptFetch(false)
        if (res.status >= 200 && res.status < 300) noThinkingConfig.add(cleanModelId)
      }

      if (res.error === 'cancelled' || signal?.aborted) {
        throw new AgentCancelledError()
      }

      if (res.error === 'timeout') {
        failedThisTurn.add(cleanModelId)
        lastError = new Error(`Gemini API call to model ${cleanModelId} timed out after ${timeoutMs / 1000} seconds.`)
        BlackBoxLogger.getInstance().log(
          'AI_FALLBACK_OR_RETRY',
          `Candidate model ${cleanModelId} timed out after ${timeoutMs / 1000} s. Trying the next one`,
          { model: cleanModelId }
        )
        if (await waitForPinnedModel(0, '')) {
          failedThisTurn.delete(cleanModelId)
          i--
        }
        continue
      }

      if (res.error) {
        BlackBoxLogger.getInstance().log(
          'AI_FALLBACK_OR_RETRY',
          `Candidate model ${cleanModelId} failed: ${res.message}. Retrying next in chain...`,
          { model: cleanModelId, error: res.message }
        )
        lastError = new Error(res.message || 'Network error')
        continue
      }

      if (res.status < 200 || res.status >= 300) {
        const errStatus = res.status
        const errorBodyText = res.body
        BlackBoxLogger.getInstance().log(
          'AI_FALLBACK_OR_RETRY',
          `Candidate model ${cleanModelId} returned HTTP ${errStatus}`,
          {
            model: cleanModelId,
            status: errStatus,
            url: requestUrl,
            errorBody: errorBodyText
          }
        )

        if (errStatus === 404) {
          missingModels.push(cleanModelId)
          unavailableModels.set(cleanModelId, 'not served (HTTP 404)')
        } else if (errStatus === 429 && /limit:\s*0\b/.test(errorBodyText)) {
          // The plan has no quota for this model at all. Waiting will not help
          unavailableModels.set(cleanModelId, 'no quota on this plan (HTTP 429, limit 0)')
        } else if (errStatus !== 503 && errStatus !== 429) {
          // Busy (503) and rate limited (429) pass, so the next round asks this model again
          failedThisTurn.add(cleanModelId)
        }

        // Live Self-Healing Model Discovery on HTTP 404
        if (errStatus === 404 && !attemptedAutoDiscovery && (cleanKey || authSecret)) {
          attemptedAutoDiscovery = true
          BlackBoxLogger.getInstance().log(
            'AI_FALLBACK_OR_RETRY',
            `HTTP 404 encountered for model ${cleanModelId}. Initiating live /v1beta/models auto-discovery...`,
            { model: cleanModelId }
          )
          try {
            const discRes = await aiHttp('https://generativelanguage.googleapis.com/v1beta/models', {
              method: 'GET',
              headers: cleanKey ? { 'x-goog-api-key': cleanKey } : {},
              authSecret,
              timeoutMs: 30000,
              signal
            })
            if (!discRes.error && discRes.status >= 200 && discRes.status < 300) {
              const discData = JSON.parse(discRes.body)
              const sorted = geminiTextModels(discData.models || [])
              if (sorted.length > 0) {
                getConfig().availableModels = sorted
                saveConfig()

                for (const dm of sorted) {
                  if (getConfig().pinModel) break
                  if (!candidateModels.includes(dm.id)) {
                    candidateModels.push(dm.id)
                    if (!unavailableModels.has(dm.id)) queue.push(dm.id)
                  }
                }

                BlackBoxLogger.getInstance().log(
                  'AI_FALLBACK_OR_RETRY',
                  `Auto-discovery healed models: ${sorted.length} models loaded. Top model: ${sorted[0].id}`,
                  { topModels: sorted.slice(0, 5).map((m) => m.id) }
                )
              }
            }
          } catch (discErr) {
            console.warn('Live model auto-discovery failed:', discErr)
          }
        }

        lastError = new Error(`Gemini API HTTP Error on ${cleanModelId}: ${errStatus} ${errorBodyText}`)
        if (await waitForPinnedModel(errStatus, errorBodyText)) i--
        continue
      }

      try {
        const data = JSON.parse(res.body) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
        }
        const parts = data.candidates?.[0]?.content?.parts || []
        const answerParts = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text as string)
        rawText = answerParts.length > 0 ? answerParts.join('') : parts[0]?.text || ''
      } catch {
        lastError = new Error(`Gemini API returned invalid JSON from ${cleanModelId}`)
        failedThisTurn.add(cleanModelId)
        continue
      }

      if (rawText) {
        successfulModel = cleanModelId
        break
      }
      failedThisTurn.add(cleanModelId)
    }

    if (!rawText) {
      const finalErr = lastError || new Error('No candidate Gemini model produced a response.')
      BlackBoxLogger.getInstance().log('AI_ERROR', `All candidate Gemini models failed: ${finalErr.message}`, {
        candidateModels: queue,
        error: String(finalErr)
      })
      throw finalErr
    }

    // A model the API no longer serves is not tried again on every request
    if (missingModels.includes(getConfig().selectedModelId)) {
      getConfig().selectedModelId = successfulModel
      saveConfig()
    }
    for (const missing of missingModels) {
      const index = candidateModels.indexOf(missing)
      if (index !== -1) candidateModels.splice(index, 1)
    }

    BlackBoxLogger.getInstance().log(
      'AI_RAW_RESPONSE',
      `Gemini API Response received from ${successfulModel} (${Date.now() - modelStartMs}ms, ${rawText.length} chars)`,
      { model: successfulModel, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
    )
    return rawText
  }

  return requestModel
}
