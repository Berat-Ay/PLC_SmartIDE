/**
 * Rungline AI Model Router
 * Sends prompts to a real model: Gemini, an OpenAI-compatible API or a local Ollama server.
 * There is no built-in answer engine. Without a usable provider the agent reports an error.
 * The router keeps the settings and the state between turns; the provider clients, the agent loop and the
 * handling of generated circuits are in the modules imported below.
 */

import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { RagKnowledgeEngine } from './RagKnowledgeEngine'
import { aiHttp } from './aiHttp'
import { AgentExecutionResponse, AiCircuitSynthesisPayload, AiConfig, AiProvider, AiTier, DiscoveredModel, GeminiContent } from './aiTypes'
import { geminiTextModels, loadStoredAiConfig, storeAiConfig } from './aiConfig'
import { buildAgentInstruction, sanitizeUserPrompt } from './AgentInstruction'
import { AgentModelReply, extractValidJsonBlock, interpretModelReply } from './ModelReply'
import { applyCircuitPayload } from './ApplyCircuit'
import { sanitizeAndAllocateUniqueAddresses } from './GeneratedCircuit'
import { PendingTest, runAgentLoop, runTestStage, TurnPlan } from './AgentTurn'
import { createGeminiRequester } from './GeminiClient'
import { apiErrorMessage, createOpenAiRequester, openAiBaseUrl } from './OpenAiClient'
import { callOllamaApi } from './OllamaClient'

// The app, the benchmark and the tests import these from the router
export type { AgentExecutionResponse, AiCircuitSynthesisPayload, AiConfig, AiProvider, AiTier, DiscoveredModel } from './aiTypes'
export { isStrictGeminiTextModel, sortGeminiModels } from './aiConfig'
export { sanitizeUserPrompt } from './AgentInstruction'
export { escapeControlCharsInJsonStrings } from './ModelReply'
export { normalizeAiGeneratedNetworks } from './GeneratedCircuit'

export class AiModelRouter {
  private static instance: AiModelRouter | null = null
  /** Models that cannot answer this key until the app restarts: no quota at all on this plan, or no longer served */
  private unavailableModels = new Map<string, string>()
  /** How long one model may take to answer before the next one is tried */
  private modelTimeoutMs = 180000
  /** Test first: the test the user has not approved yet, with the conversation that made it */
  private pendingTest?: PendingTest
  /** What the next agent turn does. Set by executePrompt and approvePendingTest, read once by runAgentTurn */
  private turnPlan?: TurnPlan
  // Models that answer HTTP 400 to thinkingConfig
  private noThinkingConfig = new Set<string>()
  // OpenAI-compatible endpoint + model that accept JSON mode but never answer in it (a reasoning model that only
  // thinks until the timeout, or ends with no text). Each costs one timeout, so it is remembered until the app restarts
  private noJsonMode = new Set<string>()
  private config: AiConfig

  private constructor() {
    this.config = loadStoredAiConfig()
    this.modelTimeoutMs = (this.config.requestTimeoutSec || 180) * 1000
  }

  public static getInstance(): AiModelRouter {
    if (!AiModelRouter.instance) {
      AiModelRouter.instance = new AiModelRouter()
    }
    return AiModelRouter.instance
  }

  /** Gives each colliding tag a free address and rewires the networks (see GeneratedCircuit) */
  public static readonly sanitizeAndAllocateUniqueAddresses = sanitizeAndAllocateUniqueAddresses

  public getConfig(): AiConfig {
    return { ...this.config }
  }

  public updateConfig(newConfig: Partial<AiConfig>): void {
    this.config = { ...this.config, ...newConfig }
    if (newConfig.requestTimeoutSec) this.modelTimeoutMs = Math.max(10, newConfig.requestTimeoutSec) * 1000
    this.saveConfig()
  }

  // Null until stored keys are loaded. Saving earlier would erase them with the still empty values.
  private savedSecrets: Record<'geminiApiKey' | 'openaiApiKey', string> | null = null

  private persistSecrets(): void {
    const api = typeof window !== 'undefined' ? window.electronApi : undefined
    if (!api?.setSecret || !this.savedSecrets) return
    const failed = (): void => console.warn('API key is kept for this session only: encrypted storage is unavailable')
    for (const key of ['geminiApiKey', 'openaiApiKey'] as const) {
      const value = this.config[key] || ''
      if (value === this.savedSecrets[key]) continue
      this.savedSecrets[key] = value
      api.setSecret(key, value).then((stored) => {
        if (!stored && this.config[key]) failed()
      }, failed)
    }
  }

  /** Loads stored keys. A key still in the old localStorage entry is moved to encrypted storage. */
  public async hydrateSecrets(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.electronApi : undefined
    if (!api?.getSecret) return
    const stored = { geminiApiKey: '', openaiApiKey: '' }
    try {
      stored.geminiApiKey = (await api.getSecret('geminiApiKey')) || ''
      stored.openaiApiKey = (await api.getSecret('openaiApiKey')) || ''
    } finally {
      this.savedSecrets = stored
      if (stored.geminiApiKey && !this.config.geminiApiKey) this.config.geminiApiKey = stored.geminiApiKey
      if (stored.openaiApiKey && !this.config.openaiApiKey) this.config.openaiApiKey = stored.openaiApiKey
      this.saveConfig()
    }
  }

  private saveConfig(): void {
    storeAiConfig(this.config)
    this.persistSecrets()
  }

  /**
   * Fetches installed local models directly from Ollama service (GET /api/tags)
   */
  public async fetchOllamaModels(endpoint?: string): Promise<DiscoveredModel[]> {
    const targetEndpoint = (endpoint || this.config.ollamaEndpoint || 'http://localhost:11434').replace(/\/$/, '')
    try {
      const res = await fetch(`${targetEndpoint}/api/tags`)
      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`)
      }
      const data = await res.json()
      const raw = (data.models || []) as Array<{
        name: string
        model?: string
        size?: number
        details?: { parameter_size?: string; family?: string; format?: string }
      }>

      const filtered: DiscoveredModel[] = raw.map((m) => {
        const paramSize = m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''
        return {
          id: m.name,
          displayName: `${m.name}${paramSize}`,
          description: `${m.details?.family || 'Local'} model (${Math.round((m.size || 0) / (1024 * 1024))} MB)`
        }
      })

      if (filtered.length === 0) {
        filtered.push(
          { id: 'qwen2.5-coder:7b', displayName: 'qwen2.5-coder:7b (Local Fallback)' },
          { id: 'deepseek-coder:6.7b', displayName: 'deepseek-coder:6.7b' }
        )
      }

      this.config.availableModels = filtered
      if (!filtered.some((m) => m.id === this.config.selectedModelId)) {
        this.config.selectedModelId = filtered[0].id
      }
      this.config.ollamaEndpoint = targetEndpoint
      this.config.provider = 'ollama'
      this.config.lastDiscoveryStatus = {
        success: true,
        message: `Ollama Connected — ${filtered.length} Local Models Loaded`,
        timestamp: Date.now()
      }
      this.saveConfig()
      return filtered
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Ollama Connection Error: ${msg}. Verify that 'ollama serve' is running at ${targetEndpoint}.`
      this.config.lastDiscoveryStatus = {
        success: false,
        message: errorMsg,
        timestamp: Date.now()
      }
      this.saveConfig()
      throw new Error(errorMsg)
    }
  }

  /**
   * Fetches active models for the provided API key directly from Google Gemini, OpenAI, or Ollama
   */
  public async fetchActiveModels(
    apiKey: string,
    provider: AiProvider = this.config.provider
  ): Promise<DiscoveredModel[]> {
    if (provider === 'ollama') {
      return this.fetchOllamaModels(apiKey)
    }

    const key = apiKey.trim()
    if (!key) {
      const err = 'API key cannot be empty'
      this.config.lastDiscoveryStatus = { success: false, message: err, timestamp: Date.now() }
      this.saveConfig()
      throw new Error(err)
    }

    if (provider === 'gemini') {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models'
      try {
        const res = await fetch(url, { headers: { 'x-goog-api-key': key } })
        if (!res.ok) {
          let errorMsg = `HTTP ${res.status}: ${res.statusText}`
          try {
            const errJson = await res.json()
            if (errJson?.error?.message) {
              errorMsg = errJson.error.message
            }
          } catch {
            // ignore
          }
          this.config.lastDiscoveryStatus = {
            success: false,
            message: `API Key verification failed: ${errorMsg}`,
            timestamp: Date.now()
          }
          this.saveConfig()
          throw new Error(this.config.lastDiscoveryStatus.message)
        }

        const data = await res.json()
        const sorted = geminiTextModels(data.models || [])
        if (sorted.length === 0) {
          throw new Error('No generateContent models returned for this API key.')
        }

        this.config.availableModels = sorted
        if (!sorted.some((m) => m.id === this.config.selectedModelId)) {
          this.config.selectedModelId = sorted[0].id
        }
        this.config.geminiApiKey = key
        this.config.provider = 'gemini'
        this.config.lastDiscoveryStatus = {
          success: true,
          message: `API Key Verified — ${sorted.length} Active Models Loaded`,
          timestamp: Date.now()
        }
        this.saveConfig()
        return sorted
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.config.lastDiscoveryStatus = {
          success: false,
          message: msg,
          timestamp: Date.now()
        }
        this.saveConfig()
        throw err
      }
    } else if (provider === 'openai') {
      const endpoint = openAiBaseUrl(this.config)
      try {
        const res = await aiHttp(`${endpoint}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key.trim()}` },
          timeoutMs: 30000
        })
        if (res.error) throw new Error(`Could not reach ${endpoint}: ${res.message}`)
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`HTTP ${res.status} from ${endpoint}/models: ${apiErrorMessage(res.body) || res.statusText}`)
        }
        const raw = ((JSON.parse(res.body) as { data?: Array<{ id?: string }> }).data || []).filter((m) => typeof m?.id === 'string')
        // Every model the server lists: a custom server names its models as it likes
        const models: DiscoveredModel[] = raw.map((m) => ({ id: m.id as string, displayName: m.id as string }))
        if (models.length === 0) throw new Error(`${endpoint}/models listed no models. Type the model name by hand.`)

        this.config.openaiModels = models
        if (!models.some((m) => m.id === this.config.openaiModel)) this.config.openaiModel = models[0].id
        this.config.openaiApiKey = key
        this.config.provider = 'openai'
        this.config.lastDiscoveryStatus = {
          success: true,
          message: `API key accepted: ${models.length} models`,
          timestamp: Date.now()
        }
        this.saveConfig()
        return models
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.config.lastDiscoveryStatus = { success: false, message: msg, timestamp: Date.now() }
        this.saveConfig()
        throw err
      }
    }

    return this.config.availableModels
  }

  /** The JSON object in a model reply, also when the model wrote raw line breaks inside its strings */
  public extractValidJsonBlock(text: string): ReturnType<typeof extractValidJsonBlock> {
    return extractValidJsonBlock(text)
  }

  /** Reads one model reply. Problems go back to the model instead of reaching the project. */
  public interpretModelReply(rawText: string, ignoreVerification = false): AgentModelReply {
    return interpretModelReply(rawText, ignoreVerification)
  }

  /**
   * Applies the synthesized circuit payload into Tag Tables, LAD Block (OB1), and opens workspace tab
   */
  public applyCircuitPayload(
    payload: AiCircuitSynthesisPayload,
    mode: 'auto-apply' | 'diff-view',
    options: { trialRun?: boolean } = {}
  ): {
    summaryText: string
    stagedChangeset?: Array<{
      path: string
      title: string
      fileType: string
      beforeContent: string
      afterContent: string
    }>
  } {
    return applyCircuitPayload(payload, mode, options)
  }

  /**
   * Main dispatch for prompt execution
   */
  public async executePrompt(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    // Ollama does not run the agent loop, so it has no test step
    if (!this.config.testFirst || this.config.provider === 'ollama') {
      this.pendingTest = undefined
      return this.runPrompt(prompt, tier, mode, signal)
    }
    // While a test waits for approval, a message from the user is a correction of that test
    const pending = this.pendingTest
    if (pending) {
      return this.runPrompt(pending.prompt, pending.tier, mode, signal, {
        stage: 'test',
        correctionOf: { contents: pending.contents, correction: sanitizeUserPrompt(prompt).trim() }
      })
    }
    return this.runPrompt(prompt, tier, mode, signal, { stage: 'test' })
  }

  /** Test first: a test waits for the user's approval */
  public hasPendingTest(): boolean {
    return !!this.pendingTest
  }

  public cancelPendingTest(): void {
    this.pendingTest = undefined
  }

  /** Test first: the user approved the test, so the circuit is written to it */
  public async approvePendingTest(mode: 'auto-apply' | 'diff-view', signal?: AbortSignal): Promise<AgentExecutionResponse> {
    const pending = this.pendingTest
    if (!pending) throw new Error('No test is waiting for approval.')
    this.pendingTest = undefined
    return this.runPrompt(pending.prompt, pending.tier, mode, signal, { stage: 'circuit', test: pending.test, tags: pending.tags })
  }

  private async runPrompt(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    signal?: AbortSignal,
    plan?: TurnPlan
  ): Promise<AgentExecutionResponse> {
    this.turnPlan = plan
    const sanitized = sanitizeUserPrompt(prompt)
    const trimmed = sanitized.trim()
    const isTurkish = this.detectTurkish(trimmed)

    if (signal?.aborted) {
      throw new Error('Synthesis cancelled by user.')
    }

    const provider = this.config.provider
    const apiKey = provider === 'gemini' ? this.config.geminiApiKey : provider === 'openai' ? this.config.openaiApiKey : 'none'
    if (!apiKey?.trim()) {
      const providerName = provider === 'gemini' ? 'Gemini' : 'OpenAI'
      const message = isTurkish
        ? `Yapay zekâ ajanı için ${providerName} API anahtarı gerekli. Anahtarı AI ayarlarından girin. Projede hiçbir şey değiştirilmedi.`
        : `The AI agent needs a ${providerName} API key. Enter it in the AI settings. Nothing in the project was changed.`
      return {
        replyText: message,
        tier,
        providerUsed: provider,
        toolCallsExecuted: [],
        toolResults: [],
        isError: true,
        errorDetails: message,
        rawTraceSnippet: message
      }
    }

    let response: AgentExecutionResponse | null = null

    // Check if Ollama provider is selected
    if (this.config.provider === 'ollama') {
      try {
        response = await callOllamaApi(trimmed, tier, mode, this.config, signal)
      } catch (err) {
        if (signal?.aborted || (err as { name?: string })?.name === 'AbortError' || String(err).includes('cancelled')) {
          throw err
        }
        console.warn('Ollama API call failed, reporting honest error:', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        BlackBoxLogger.getInstance().log('AI_ERROR', `Ollama synthesis error: ${errMsg}`, { error: errMsg, prompt: trimmed })
        return {
          replyText: isTurkish
            ? `Ollama bağlantı hatası oluştu: ${errMsg}. Tuval değiştirilmedi.`
            : `Ollama connection error: ${errMsg}. Ladder canvas was not modified.`,
          tier,
          providerUsed: 'ollama',
          toolCallsExecuted: [],
          toolResults: [],
          isError: true,
          errorDetails: (err instanceof Error ? err.stack : undefined) || errMsg,
          rawTraceSnippet: errMsg
        }
      }
    } else if (this.config.provider === 'gemini') {
      try {
        response = await this.callGeminiApi(trimmed, tier, mode, isTurkish, signal)
      } catch (err) {
        if (signal?.aborted || (err as { name?: string })?.name === 'AbortError' || String(err).includes('cancelled')) {
          throw err
        }
        console.warn('Gemini API call failed, reporting honest error without fake fallback:', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        BlackBoxLogger.getInstance().log('AI_ERROR', `Gemini synthesis error: ${errMsg}`, { error: errMsg, prompt: trimmed })
        return {
          replyText: isTurkish
            ? `Gemini API ile devre sentezi gerçekleştirilemedi: ${errMsg}.\n\nTuvaldeki mevcut devreler korunmuştur (hiçbir sahte şablon yüklenmedi). Uçuş Kaydedici (Black-Box Telemetry) üzerinden hatayı inceleyebilirsiniz.`
            : `Gemini API synthesis failed: ${errMsg}.\n\nExisting ladder canvas was preserved (no fake fallback circuits applied). Check Flight Log for full telemetry trace.`,
          tier,
          providerUsed: 'gemini',
          toolCallsExecuted: [],
          toolResults: [],
          isError: true,
          errorDetails: (err instanceof Error ? err.stack : undefined) || errMsg,
          rawTraceSnippet: errMsg
        }
      }
    } else {
      try {
        response = await this.callOpenAiApi(trimmed, tier, mode, isTurkish, signal)
      } catch (err) {
        if (signal?.aborted || (err as { name?: string })?.name === 'AbortError' || String(err).includes('cancelled')) {
          throw err
        }
        console.warn('OpenAI API call failed, reporting honest error:', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        BlackBoxLogger.getInstance().log('AI_ERROR', `OpenAI synthesis error: ${errMsg}`, { error: errMsg, prompt: trimmed })
        return {
          replyText: isTurkish
            ? `API hatası (${openAiBaseUrl(this.config)}): ${errMsg}. Projede değişiklik yapılmadı.`
            : `API error (${openAiBaseUrl(this.config)}): ${errMsg}. The project was not changed.`,
          tier,
          providerUsed: 'openai',
          toolCallsExecuted: [],
          toolResults: [],
          isError: true,
          errorDetails: (err instanceof Error ? err.stack : undefined) || errMsg,
          rawTraceSnippet: errMsg
        }
      }
    }

    if (signal?.aborted) {
      throw new Error('Synthesis cancelled by user.')
    }

    if (!response) {
      throw new Error(`Provider '${this.config.provider}' returned no response.`)
    }

    // Ensure RAG consulted rules are always populated from Semantic Vectorizer
    if (!response.ragRulesConsulted || response.ragRulesConsulted.length === 0) {
      const topRules = RagKnowledgeEngine.getInstance().retrieveTopKRules(trimmed, 4)
      response.ragRulesConsulted = topRules.map((r) => r.item.name)
    }

    return response
  }

  /**
   * Simple Turkish language detector
   */
  public detectTurkish(text: string): boolean {
    if (this.config.language === 'tr') return true
    if (this.config.language === 'en') return false

    const trRegex =
      /[ğüşıöçĞÜŞİÖÇ]|pompa|hidrofor|vana|çakışma|cakisma|bobin|bellek|çöz|coz|ekle|oluştur|olustur|neden|çalış|calis|dursun|duran|yansın|yansin|saniye|devre|mühür|muhur|buton|hata|seviye|basınç|basinc|sıcaklık|sicaklik|arıza|ariza/i
    return trRegex.test(text)
  }

  /** One agent turn, as the plan set by executePrompt or approvePendingTest says (see AgentTurn) */
  private async runAgentTurn(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    ragRulesConsulted: string[],
    requestModel: (contents: GeminiContent[]) => Promise<string>
  ): Promise<AgentExecutionResponse> {
    const plan = this.turnPlan
    this.turnPlan = undefined
    const turn = {
      prompt,
      tier,
      mode,
      isTurkish,
      ragRulesConsulted,
      requestModel,
      provider: this.config.provider,
      acceptanceGate: this.config.acceptanceGate,
      onTestProposed: (pending: PendingTest) => {
        this.pendingTest = pending
      }
    }
    if (plan?.stage === 'test') return runTestStage(turn, plan)
    return runAgentLoop(turn, plan?.stage === 'circuit' ? plan : undefined)
  }

  /** Gemini runs the agent loop; the client falls back to other models when the selected one cannot answer */
  private async callGeminiApi(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const { text, consultedRuleNames } = buildAgentInstruction(prompt)
    const requestModel = createGeminiRequester({
      prompt,
      tier,
      mode,
      systemInstruction: text,
      signal,
      getConfig: () => this.config,
      saveConfig: () => this.saveConfig(),
      unavailableModels: this.unavailableModels,
      noThinkingConfig: this.noThinkingConfig,
      timeoutMs: this.modelTimeoutMs
    })
    return this.runAgentTurn(prompt, tier, mode, isTurkish, consultedRuleNames, requestModel)
  }

  /**
   * An OpenAI-compatible API (OpenAI, or a custom server with /v1/chat/completions). It runs the same agent
   * loop as Gemini: the reply is applied, compiled, tested on the simulator and undone if it fails.
   */
  private async callOpenAiApi(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const { text, consultedRuleNames } = buildAgentInstruction(prompt)
    const requestModel = createOpenAiRequester({
      prompt,
      tier,
      mode,
      systemInstruction: text,
      signal,
      config: this.config,
      noJsonMode: this.noJsonMode,
      timeoutMs: this.modelTimeoutMs
    })
    const result = await this.runAgentTurn(prompt, tier, mode, isTurkish, consultedRuleNames, requestModel)
    return { ...result, providerUsed: 'openai' }
  }
}
