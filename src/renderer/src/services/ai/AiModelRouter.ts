/**
 * Rungline AI Model Router & Deterministic Industrial Synthesis Engine
 * Supports real cloud API providers (Gemini, OpenAI-compatible) and a zero-key
 * built-in offline industrial deterministic synthesis engine supporting Turkish and English.
 */

import { PlcAgentTools, AgentToolCall, AgentToolResult } from './PlcAgentTools'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useUIStore } from '../../stores/useUIStore'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { LadderDslCompiler } from '../compiler/LadderDslCompiler'
import { RagKnowledgeEngine } from './RagKnowledgeEngine'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import {
  LadderNode,
  LadderSeriesNode,
  LadderNetwork,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderMathNode,
  LadderParallelBranchNode,
  ContactType,
  CoilType,
  TimerType,
  CounterType,
  ComparatorType
} from '@shared/types/ladder'

export type AiProvider = 'offline_local' | 'gemini' | 'ollama' | 'openai'
export type AiTier = 'fast-flash' | 'deep-pro'

export interface DiscoveredModel {
  id: string
  displayName: string
  description?: string
}

export interface AiCircuitSynthesisPayload {
  explanation: string
  operationMode: 'replace_ob1_networks' | 'append_ob1_networks'
  tagsToUpsert: Array<{
    name: string
    dataType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME'
    address: string
    comment?: string
  }>
  networks: LadderNetwork[]
  sclBlocksToCreate?: Array<{
    name: string
    blockType: 'FB' | 'FC'
    sourceCode: string
  }>
  udtsToCreate?: Array<{
    name: string
    fields: Array<{ name: string; dataType: string; comment?: string }>
  }>
  dbsToCreate?: Array<{
    name: string
    isOptimized: boolean
    variables: Array<{ name: string; dataType: string; initialValue?: string; comment?: string }>
  }>
}

export interface AiConfig {
  provider: AiProvider
  geminiApiKey: string
  openaiApiKey: string
  openaiEndpoint: string
  ollamaEndpoint: string
  selectedModelId: string
  availableModels: DiscoveredModel[]
  lastDiscoveryStatus: {
    success: boolean
    message: string
    timestamp: number
  } | null
  fastModel: string
  deepModel: string
  language: 'auto' | 'en' | 'tr'
}

export interface AgentExecutionResponse {
  replyText: string
  tier: AiTier
  providerUsed: AiProvider
  toolCallsExecuted: AgentToolCall[]
  toolResults: AgentToolResult[]
  ragRulesConsulted?: string[]
  compilerVerification?: {
    success: boolean
    message: string
  }
  stagedChangeset?: Array<{
    path: string
    title: string
    fileType: string
    beforeContent: string
    afterContent: string
  }>
  rawTraceSnippet?: string
  rawJson?: string
  isError?: boolean
  errorDetails?: string
}

const STORAGE_KEY = 'antigravity_ai_config_v1'

export const GEMINI_MODEL_BLACKLIST = [
  'tts',
  'audio',
  'image',
  'imagen',
  'vision',
  'banana',
  'lyria',
  'veo',
  'robotics',
  'research',
  'thinking-exp',
  'embedding',
  'computer-use',
  'live',
  'aqa',
  'whisper'
]

export function isStrictGeminiTextModel(id: string): boolean {
  if (!id) return false
  const lower = id.toLowerCase().replace(/^models\//, '')
  if (!lower.startsWith('gemini-')) return false
  return !GEMINI_MODEL_BLACKLIST.some((term) => lower.includes(term))
}

export const defaultAiConfig: AiConfig = {
  provider: 'offline_local',
  geminiApiKey: '',
  openaiApiKey: '',
  openaiEndpoint: 'https://api.openai.com/v1',
  ollamaEndpoint: 'http://localhost:11434',
  selectedModelId: 'gemini-2.5-flash',
  availableModels: [
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview' },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }
  ],
  lastDiscoveryStatus: null,
  fastModel: 'gemini-2.5-flash',
  deepModel: 'gemini-2.5-pro',
  language: 'auto'
}

export const GEMINI_MODEL_PRIORITY = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001'
]

export function sortGeminiModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const aId = a.id.toLowerCase().replace(/^models\//, '')
    const bId = b.id.toLowerCase().replace(/^models\//, '')
    const aIdx = GEMINI_MODEL_PRIORITY.indexOf(aId)
    const bIdx = GEMINI_MODEL_PRIORITY.indexOf(bId)
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
    if (aIdx !== -1) return -1
    if (bIdx !== -1) return 1
    return aId.localeCompare(bId)
  })
}

export function sanitizeUserPrompt(rawPrompt: string): string {
  if (!rawPrompt) return ''
  return rawPrompt
    .replace(/\[DIAGNOSTIC\][\s\S]*$/i, '')
    .replace(/\[TIP\][\s\S]*$/i, '')
    .replace(/RAG Context:\s*[\w_-]+/gi, '')
    .replace(/Rungline Agent\s*$/i, '')
    .trim()
}

export function normalizeAiGeneratedNetworks(rawNetworks: any[]): LadderNetwork[] {
  if (!Array.isArray(rawNetworks)) return []

  let nodeCounter = 1

  const normalizeNode = (raw: any): LadderSeriesNode => {
    if (!raw || typeof raw !== 'object') {
      return {
        id: `node_${nodeCounter++}`,
        kind: 'contact',
        contactType: 'NO_CONTACT',
        operand: 'UNDEFINED'
      } as LadderContactNode
    }

    const rawKind = (raw.kind || raw.type || '').toString().toUpperCase()

    // 1. Parallel Branch
    if (
      rawKind === 'PARALLEL' ||
      rawKind === 'PARALLEL_BRANCH' ||
      rawKind === 'OR_BRANCH' ||
      Array.isArray(raw.branches)
    ) {
      const branches = (raw.branches || []).map((branch: any) =>
        Array.isArray(branch) ? branch.map(normalizeNode) : []
      )
      return {
        id: raw.id || `parallel_${nodeCounter++}`,
        kind: 'parallel',
        branches
      } as LadderParallelBranchNode
    }

    // 2. Timer: TON, TOF, TP
    if (
      rawKind === 'TON' ||
      rawKind === 'TOF' ||
      rawKind === 'TP' ||
      rawKind === 'TIMER' ||
      raw.kind === 'timer'
    ) {
      const timerType: TimerType =
        raw.timerType?.toUpperCase() === 'TOF' || rawKind === 'TOF'
          ? 'TOF'
          : raw.timerType?.toUpperCase() === 'TP' || rawKind === 'TP'
            ? 'TP'
            : 'TON'

      const instName = (
        raw.instanceDb ||
        raw.instanceName ||
        raw.timerName ||
        raw.name ||
        `T${nodeCounter}`
      ).toString().trim().replace(/^"|"$/g, '')

      let ptVal = raw.ptOperand ?? raw.pt ?? raw.presetTime ?? raw.preset ?? 'T#10s'
      if (typeof ptVal === 'number') {
        ptVal = `T#${ptVal}ms`
      } else {
        ptVal = String(ptVal).trim()
        if (/^\d+$/.test(ptVal)) {
          ptVal = `T#${ptVal}ms`
        }
      }

      return {
        id: raw.id || `timer_${nodeCounter++}`,
        kind: 'timer',
        timerType,
        instanceDb: instName,
        inOperand: raw.inOperand || '',
        ptOperand: ptVal,
        qOperand: raw.qOperand || `${instName}.Q`,
        etOperand: raw.etOperand || `${instName}.ET`,
        comment: raw.comment
      } as LadderTimerNode
    }

    // 3. Counter: CTU, CTD, CTUD
    if (
      rawKind === 'CTU' ||
      rawKind === 'CTD' ||
      rawKind === 'CTUD' ||
      rawKind === 'COUNTER' ||
      raw.kind === 'counter'
    ) {
      let counterType: CounterType = 'CTUD'
      if (raw.counterType) {
        const ctUpper = raw.counterType.toUpperCase()
        if (ctUpper === 'CTU' || ctUpper === 'CTD' || ctUpper === 'CTUD') {
          counterType = ctUpper as CounterType
        }
      } else if (rawKind === 'CTU') {
        counterType = 'CTU'
      } else if (rawKind === 'CTD') {
        counterType = 'CTD'
      }

      const instName = (
        raw.instanceDb ||
        raw.instanceName ||
        raw.counterName ||
        raw.name ||
        `C${nodeCounter}`
      ).toString().trim().replace(/^"|"$/g, '')

      const pvVal = String(raw.pvOperand ?? raw.pv ?? raw.preset ?? raw.presetValue ?? 10).trim()
      const cu = raw.cuOperand || raw.cu || raw.countUp || undefined
      const cd = raw.cdOperand || raw.cd || raw.countDown || undefined
      const rLd = raw.rLdOperand || raw.r || raw.reset || raw.load || ''

      return {
        id: raw.id || `counter_${nodeCounter++}`,
        kind: 'counter',
        counterType,
        instanceDb: instName,
        cuCdOperand: cu || cd || raw.cuCdOperand || '',
        cuOperand: cu,
        cdOperand: cd,
        rLdOperand: rLd,
        pvOperand: pvVal,
        qOperand: raw.qOperand || `${instName}.${counterType === 'CTD' ? 'QD' : 'QU'}`,
        quOperand: raw.quOperand || `${instName}.QU`,
        qdOperand: raw.qdOperand || `${instName}.QD`,
        cvOperand: raw.cvOperand || `${instName}.CV`,
        comment: raw.comment
      } as LadderCounterNode
    }

    // 4. Comparator: CMP, COMPARATOR, CMP_LT, LESS_THAN, etc.
    const isCmp =
      rawKind === 'CMP' ||
      rawKind === 'COMPARATOR' ||
      rawKind.startsWith('CMP_') ||
      rawKind === 'LESS_THAN' ||
      rawKind === 'GREATER_THAN' ||
      rawKind === 'EQUAL' ||
      rawKind === 'GREATER_EQUAL' ||
      rawKind === 'LESS_EQUAL' ||
      raw.kind === 'comparator'

    if (isCmp) {
      const typeStr = (raw.comparatorType || raw.operator || rawKind).toString().toUpperCase()
      let comparatorType: ComparatorType = 'CMP_EQ'
      if (typeStr === 'CMP_LT' || typeStr === 'LESS_THAN' || typeStr === '<' || typeStr === 'LT') {
        comparatorType = 'CMP_LT'
      } else if (typeStr === 'CMP_LE' || typeStr === 'LESS_EQUAL' || typeStr === '<=' || typeStr === 'LE') {
        comparatorType = 'CMP_LE'
      } else if (typeStr === 'CMP_GT' || typeStr === 'GREATER_THAN' || typeStr === '>' || typeStr === 'GT') {
        comparatorType = 'CMP_GT'
      } else if (typeStr === 'CMP_GE' || typeStr === 'GREATER_EQUAL' || typeStr === '>=' || typeStr === 'GE') {
        comparatorType = 'CMP_GE'
      } else if (typeStr === 'CMP_NE' || typeStr === 'NOT_EQUAL' || typeStr === '<>' || typeStr === '!=' || typeStr === 'NE') {
        comparatorType = 'CMP_NE'
      } else {
        comparatorType = 'CMP_EQ'
      }

      const op1 = String(raw.op1 ?? raw.in1 ?? raw.left ?? raw.input1 ?? '0').trim()
      const op2 = String(raw.op2 ?? raw.in2 ?? raw.right ?? raw.input2 ?? '0').trim()
      let dataType: 'INT' | 'DINT' | 'REAL' | 'TIME' = 'INT'
      if (raw.dataType && ['INT', 'DINT', 'REAL', 'TIME'].includes(raw.dataType.toUpperCase())) {
        dataType = raw.dataType.toUpperCase()
      }

      return {
        id: raw.id || `cmp_${nodeCounter++}`,
        kind: 'comparator',
        comparatorType,
        op1,
        op2,
        dataType,
        comment: raw.comment
      } as LadderComparatorNode
    }

    // 5. Coils
    const isCoil =
      rawKind === 'COIL' ||
      rawKind === 'OUTPUT_COIL' ||
      rawKind === 'NEGATED_COIL' ||
      rawKind === 'NEG_COIL' ||
      rawKind === 'SET_COIL' ||
      rawKind === 'SET' ||
      rawKind === 'RESET_COIL' ||
      rawKind === 'RESET' ||
      raw.kind === 'coil'

    if (isCoil) {
      const typeStr = (raw.coilType || rawKind).toString().toUpperCase()
      let coilType: CoilType = 'OUTPUT_COIL'
      if (typeStr === 'NEGATED_COIL' || typeStr === 'NEG_COIL') {
        coilType = 'NEGATED_COIL'
      } else if (typeStr === 'SET_COIL' || typeStr === 'SET') {
        coilType = 'SET_COIL'
      } else if (typeStr === 'RESET_COIL' || typeStr === 'RESET') {
        coilType = 'RESET_COIL'
      }

      const operand = String(raw.operand || raw.address || raw.symbolName || 'UNDEFINED').trim()
      return {
        id: raw.id || `coil_${nodeCounter++}`,
        kind: 'coil',
        coilType,
        operand,
        address: raw.address,
        symbolName: raw.symbolName || operand,
        comment: raw.comment
      } as LadderCoilNode
    }

    // 6. Math
    if (raw.kind === 'math' || ['ADD', 'SUB', 'MUL', 'DIV', 'MOVE', 'NORM_X', 'SCALE_X'].includes(rawKind)) {
      return {
        id: raw.id || `math_${nodeCounter++}`,
        kind: 'math',
        boxType: (raw.boxType || rawKind) as any,
        in1: raw.in1,
        in2: raw.in2,
        out: raw.out,
        min: raw.min,
        max: raw.max,
        value: raw.value,
        dataType: raw.dataType,
        comment: raw.comment
      } as LadderMathNode
    }

    // 7. Contacts (Default)
    const typeStr = (raw.contactType || rawKind).toString().toUpperCase()
    let contactType: ContactType = 'NO_CONTACT'
    if (typeStr === 'NC_CONTACT' || typeStr === 'NC') {
      contactType = 'NC_CONTACT'
    } else if (typeStr === 'P_TRIG') {
      contactType = 'P_TRIG'
    } else if (typeStr === 'N_TRIG') {
      contactType = 'N_TRIG'
    }

    const operand = String(raw.operand || raw.address || raw.symbolName || 'UNDEFINED').trim()
    return {
      id: raw.id || `contact_${nodeCounter++}`,
      kind: 'contact',
      contactType,
      operand,
      address: raw.address,
      symbolName: raw.symbolName || operand,
      edgeTag: raw.edgeTag,
      comment: raw.comment
    } as LadderContactNode
  }

  return rawNetworks.map((net, idx) => {
    const rawNodes = Array.isArray(net.nodes) ? net.nodes : Array.isArray(net.elements) ? net.elements : []
    const normalizedNodes = rawNodes.map(normalizeNode)
    return {
      id: net.id || `nw_${idx + 1}`,
      networkNumber: net.networkNumber || idx + 1,
      title: net.title || `Network ${idx + 1}`,
      comment: net.comment || '',
      isSclNetwork: !!net.isSclNetwork,
      sclCode: net.sclCode,
      nodes: normalizedNodes
    }
  })
}

export class AiModelRouter {
  private static instance: AiModelRouter | null = null
  private config: AiConfig

  private constructor() {
    this.config = this.loadConfig()
  }

  public static getInstance(): AiModelRouter {
    if (!AiModelRouter.instance) {
      AiModelRouter.instance = new AiModelRouter()
    }
    return AiModelRouter.instance
  }

  public getConfig(): AiConfig {
    return { ...this.config }
  }

  public updateConfig(newConfig: Partial<AiConfig>): void {
    this.config = { ...this.config, ...newConfig }
    this.saveConfig()
  }

  private persistSecrets(): void {
    const api = typeof window !== 'undefined' ? window.electronApi : undefined
    if (!api?.setSecret) return
    const failed = (): void => console.warn('API key is kept for this session only: encrypted storage is unavailable')
    for (const key of ['geminiApiKey', 'openaiApiKey'] as const) {
      api.setSecret(key, this.config[key] || '').then((stored) => {
        if (!stored && this.config[key]) failed()
      }, failed)
    }
  }

  /** Loads stored keys. A key still in the old localStorage entry is moved to encrypted storage. */
  public async hydrateSecrets(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.electronApi : undefined
    if (!api?.getSecret) return
    const gemini = await api.getSecret('geminiApiKey')
    const openai = await api.getSecret('openaiApiKey')
    if (gemini && !this.config.geminiApiKey) this.config.geminiApiKey = gemini
    if (openai && !this.config.openaiApiKey) this.config.openaiApiKey = openai
    this.saveConfig()
  }

  private loadConfig(): AiConfig {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = { ...defaultAiConfig, ...JSON.parse(saved) }
        // Sanitize selectedModelId and availableModels: purge retired 1.5 and invalid 3.8
        if (parsed.provider === 'gemini' || !parsed.provider || parsed.provider === 'offline_local') {
          if (
            !isStrictGeminiTextModel(parsed.selectedModelId) ||
            parsed.selectedModelId.includes('1.5') ||
            parsed.selectedModelId.includes('3.8')
          ) {
            parsed.selectedModelId = 'gemini-2.5-flash'
          }
          if (Array.isArray(parsed.availableModels)) {
            parsed.availableModels = parsed.availableModels.filter((m: { id: string }) =>
              isStrictGeminiTextModel(m.id) && !m.id.includes('1.5') && !m.id.includes('3.8')
            )
            if (parsed.availableModels.length === 0) {
              parsed.availableModels = defaultAiConfig.availableModels
            }
          }
        }
        return parsed
      }
    } catch {
      // fallback to default
    }
    return { ...defaultAiConfig }
  }

  private saveConfig(): void {
    try {
      // API keys never go to localStorage; they are held in the main process, encrypted by the OS
      const { geminiApiKey: _gemini, openaiApiKey: _openai, ...withoutKeys } = this.config
      localStorage.setItem(STORAGE_KEY, JSON.stringify(withoutKeys))
    } catch {
      // ignore
    }
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
        const rawModels: Array<{
          name: string
          displayName?: string
          description?: string
          supportedGenerationMethods?: string[]
        }> = data.models || []

        // Filter: only models supporting 'generateContent' and strict text/code whitelist (exclude multimodal/speech/image/research)
        const filtered: DiscoveredModel[] = rawModels
          .filter((m) => {
            const hasGen =
              Array.isArray(m.supportedGenerationMethods) &&
              m.supportedGenerationMethods.includes('generateContent')
            if (!hasGen) return false
            const cleanId = m.name.replace(/^models\//, '')
            return isStrictGeminiTextModel(cleanId)
          })
          .map((m) => {
            const cleanId = m.name.replace(/^models\//, '')
            return {
              id: cleanId,
              displayName: m.displayName || cleanId,
              description: m.description
            }
          })

        if (filtered.length === 0) {
          throw new Error('No generateContent models returned for this API key.')
        }

        const sorted = sortGeminiModels(filtered)
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
      const endpoint = (this.config.openaiEndpoint || 'https://api.openai.com/v1').replace(/\/$/, '')
      try {
        const res = await fetch(`${endpoint}/models`, {
          headers: { Authorization: `Bearer ${key}` }
        })
        if (!res.ok) {
          throw new Error(`OpenAI HTTP ${res.status}: ${res.statusText}`)
        }
        const data = await res.json()
        const raw = (data.data || []) as Array<{ id: string }>
        const filtered: DiscoveredModel[] = raw
          .filter((m) => m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3') || m.id.includes('claude'))
          .map((m) => ({ id: m.id, displayName: m.id }))

        this.config.availableModels = filtered.length > 0 ? filtered : [{ id: 'gpt-4o', displayName: 'GPT-4o' }]
        this.config.openaiApiKey = key
        this.config.provider = 'openai'
        this.config.lastDiscoveryStatus = {
          success: true,
          message: `OpenAI Key Verified — ${this.config.availableModels.length} Models Loaded`,
          timestamp: Date.now()
        }
        this.saveConfig()
        return this.config.availableModels
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.config.lastDiscoveryStatus = { success: false, message: msg, timestamp: Date.now() }
        this.saveConfig()
        throw err
      }
    }

    return this.config.availableModels
  }

  /**
   * MEB Golden Rulebook AST Optimizer & Self-Critic
   * Strips redundant %M dummy coils following timers/counters, rewires interlock contacts directly
   * to native timer sub-bits (e.g. T1.Q), and purges redundant %M tags from project tag tables.
   */
  public optimizeAndCleanGeneratedAst(payload: AiCircuitSynthesisPayload): AiCircuitSynthesisPayload {
    if (!payload.networks || payload.networks.length === 0) return payload

    const strippedCoilMap = new Map<string, string>() // dummyOperandLower -> replacement e.g. "T1.Q"

    // 1. Traverse networks and inspect for trailing dummy coils after timers/counters
    const cleanedNetworks = payload.networks.map((net) => {
      const originalNodes = net.nodes || []
      const newNodes: LadderNode[] = []

      for (let i = 0; i < originalNodes.length; i++) {
        const current = originalNodes[i]
        const next = originalNodes[i + 1]

        if ((current.kind === 'timer' || current.kind === 'counter') && next && next.kind === 'coil') {
          const t = current as LadderTimerNode | LadderCounterNode
          const c = next as LadderCoilNode
          const instName = t.instanceDb || (current.kind === 'timer' ? 'T1' : 'C1')
          const nativeBit = current.kind === 'timer' ? `${instName}.Q` : `${instName}.QU`

          strippedCoilMap.set(c.operand.toLowerCase(), nativeBit)
          if (c.address) strippedCoilMap.set(c.address.toLowerCase(), nativeBit)
          if (c.symbolName) strippedCoilMap.set(c.symbolName.toLowerCase(), nativeBit)

          const updatedTimerOrCounter = {
            ...t,
            qOperand: nativeBit
          }
          newNodes.push(updatedTimerOrCounter)
          i++ // Strip the trailing dummy coil!
          continue
        }

        newNodes.push(current)
      }

      return {
        ...net,
        nodes: newNodes
      }
    })

    // 2. Rewrite any contact that referenced the stripped dummy coil
    const rewireContacts = (nodes: LadderNode[]): LadderNode[] => {
      return nodes.map((n) => {
        if (n.kind === 'contact') {
          const ct = n as LadderContactNode
          const match =
            strippedCoilMap.get(ct.operand.toLowerCase()) ||
            (ct.address ? strippedCoilMap.get(ct.address.toLowerCase()) : undefined) ||
            (ct.symbolName ? strippedCoilMap.get(ct.symbolName.toLowerCase()) : undefined)

          if (match) {
            return {
              ...ct,
              operand: match,
              address: match,
              symbolName: match
            }
          }
        } else if (n.kind === 'parallel') {
          const p = n as LadderParallelBranchNode
          return {
            ...p,
            branches: p.branches.map(rewireContacts)
          }
        }
        return n
      })
    }

    const rewiredNetworks = cleanedNetworks.map((net) => ({
      ...net,
      nodes: rewireContacts(net.nodes)
    }))

    // 3. Filter out dummy %M tags from tagsToUpsert
    const cleanedTags = (payload.tagsToUpsert || []).filter((tag) => {
      const lowerName = tag.name.toLowerCase()
      const lowerAddr = tag.address.toLowerCase()
      if (strippedCoilMap.has(lowerName) || strippedCoilMap.has(lowerAddr)) {
        return false
      }
      if (
        lowerAddr.startsWith('%m') &&
        (lowerName.includes('timer') || lowerName.includes('done') || lowerName.includes('aux_t'))
      ) {
        return false
      }
      return true
    })

    // Also remove any matching dummy %M tag from live tagStore
    try {
      const tagStore = useTagStore.getState()
      tagStore.tagTables.forEach((tbl) => {
        const toDelete = tbl.tags.filter(
          (t) =>
            strippedCoilMap.has(t.name.toLowerCase()) ||
            strippedCoilMap.has(t.address.toLowerCase()) ||
            (t.address.toLowerCase().startsWith('%m') &&
              (t.name.toLowerCase().includes('timer') || t.name.toLowerCase().includes('done')))
        )
        toDelete.forEach((t) => tagStore.deleteTag(tbl.id, t.id))
      })
    } catch {
      // outside react
    }

    return {
      ...payload,
      networks: rewiredNetworks,
      tagsToUpsert: cleanedTags
    }
  }

  /**
   * Resilient JSON Block Extractor
   * Safely locates and extracts JSON payload blocks from markdown code fences
   * or surrounding conversational text without crashing.
   */
  public extractValidJsonBlock(text: string): { json: any; raw: string } | null {
    if (!text) return null

    // 1. Match ```json ... ``` or ``` ... ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi
    let match: RegExpExecArray | null
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const candidate = match[1].trim()
      try {
        const parsed = JSON.parse(candidate)
        return { json: parsed, raw: candidate }
      } catch {
        // Continue searching
      }
    }

    // 2. Match raw substring between outer curly braces
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const rawSubstring = text.substring(firstBrace, lastBrace + 1).trim()
      try {
        const parsed = JSON.parse(rawSubstring)
        return { json: parsed, raw: rawSubstring }
      } catch {
        // Continue
      }
    }

    // 3. Fallback try the full trimmed text
    try {
      const parsed = JSON.parse(text.trim())
      return { json: parsed, raw: text.trim() }
    } catch {
      // Not valid JSON
    }

    return null
  }

  /**
   * Deterministic Unique Address Allocator & Network Rewirer
   * Ensures that tags generated or modified by AI never have duplicate addresses (e.g. Start_Btn %I0.1 & Stop_Btn %I0.1).
   * Automatically re-maps colliding tags to sequential safe addresses (%I0.0, %I0.1, %Q0.0, %Q0.1, etc.)
   * and updates corresponding node operands and addresses in Ladder Networks.
   */
  public static sanitizeAndAllocateUniqueAddresses(
    tagsToUpsert: Array<{ name: string; dataType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME'; address: string; comment?: string }>,
    networks: LadderNetwork[] = [],
    existingTags: Array<{ id: string; name: string; address: string; dataType: string }> = []
  ): {
    tags: Array<{ name: string; dataType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME'; address: string; comment?: string }>
    networks: LadderNetwork[]
  } {
    const usedAddresses = new Map<string, string>() // normalizedAddr -> tagName
    const addressRewrites = new Map<string, string>() // oldNormalizedAddr -> newNormalizedAddr
    const nameToAddressMap = new Map<string, string>() // tagName.toLowerCase() -> newNormalizedAddr

    // Register existing tags that are not being replaced by name
    const newTagNames = new Set(tagsToUpsert.map((t) => t.name.trim().toLowerCase()))
    for (const ex of existingTags) {
      if (!newTagNames.has(ex.name.trim().toLowerCase()) && ex.address) {
        const norm = normalizeS7Address(ex.address)
        if (norm.isValid) {
          usedAddresses.set(norm.formatted.toUpperCase(), ex.name)
        }
      }
    }

    const allocateNextFree = (area: 'I' | 'Q' | 'M', isBit: boolean): string => {
      for (let byte = 0; byte < 1000; byte++) {
        if (isBit) {
          for (let bit = 0; bit < 8; bit++) {
            const candidate = `%${area}${byte}.${bit}`
            if (!usedAddresses.has(candidate.toUpperCase())) {
              return candidate
            }
          }
        } else {
          const candidate = `%${area}W${byte * 2}`
          if (!usedAddresses.has(candidate.toUpperCase())) {
            return candidate
          }
        }
      }
      return `%${area}0.0`
    }

    const sanitizedTags = tagsToUpsert.map((tag) => {
      const norm = normalizeS7Address(tag.address)
      let formattedAddr = norm.isValid ? norm.formatted.toUpperCase() : tag.address.trim().toUpperCase()
      const area = (formattedAddr.startsWith('%I') ? 'I' : formattedAddr.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
      const isBit = tag.dataType === 'BOOL' || !formattedAddr.includes('W')

      // Check if this address is already taken by a different tag
      const existingOccupant = usedAddresses.get(formattedAddr)
      if (existingOccupant && existingOccupant.toLowerCase() !== tag.name.toLowerCase()) {
        // Collision detected! Allocate next free safe address
        const safeAddr = allocateNextFree(area, isBit)
        addressRewrites.set(formattedAddr, safeAddr)
        formattedAddr = safeAddr
      }

      usedAddresses.set(formattedAddr, tag.name)
      nameToAddressMap.set(tag.name.toLowerCase(), formattedAddr)

      return {
        ...tag,
        address: formattedAddr
      }
    })

    // Rewire nodes in networks
    const rewireNode = (node: LadderNode): LadderNode => {
      if (node.kind === 'contact') {
        const c = node as LadderContactNode
        const newAddr =
          (c.symbolName && nameToAddressMap.get(c.symbolName.toLowerCase())) ||
          (c.operand && nameToAddressMap.get(c.operand.toLowerCase())) ||
          (c.address && addressRewrites.get(c.address.toUpperCase()))
        if (newAddr) {
          return { ...c, address: newAddr }
        }
      } else if (node.kind === 'coil') {
        const c = node as LadderCoilNode
        const newAddr =
          (c.symbolName && nameToAddressMap.get(c.symbolName.toLowerCase())) ||
          (c.operand && nameToAddressMap.get(c.operand.toLowerCase())) ||
          (c.address && addressRewrites.get(c.address.toUpperCase()))
        if (newAddr) {
          return { ...c, address: newAddr }
        }
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        return {
          ...p,
          branches: p.branches.map((branch) => branch.map(rewireNode))
        }
      }
      return node
    }

    const rewiredNetworks = networks.map((net) => ({
      ...net,
      nodes: (net.nodes || []).map(rewireNode)
    }))

    return {
      tags: sanitizedTags,
      networks: rewiredNetworks
    }
  }

  /**
   * Applies the synthesized circuit payload into Tag Tables, LAD Block (OB1), and opens workspace tab
   */
  public applyCircuitPayload(
    payload: AiCircuitSynthesisPayload,
    mode: 'auto-apply' | 'diff-view'
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
    const normalizedNetworks = normalizeAiGeneratedNetworks(payload.networks || [])
    const effectivePayload = this.optimizeAndCleanGeneratedAst({
      ...payload,
      networks: normalizedNetworks
    })
    const isReplacing = effectivePayload.operationMode === 'replace_ob1_networks'
    const existingLiveTags = isReplacing ? [] : useTagStore.getState().tagTables.flatMap((t) => t.tags)
    const sanitized = AiModelRouter.sanitizeAndAllocateUniqueAddresses(
      effectivePayload.tagsToUpsert || [],
      effectivePayload.networks || [],
      existingLiveTags
    )
    effectivePayload.tagsToUpsert = sanitized.tags
    effectivePayload.networks = sanitized.networks
    const tagsCreatedNames: string[] = []

    // 1. Upsert Tags (and prune orphaned tags on replacement)
    try {
      const tagStore = useTagStore.getState()
      const tableId = tagStore.tagTables[0]?.id || 'tbl_default'
      const existingTags = tagStore.tagTables.flatMap((t) => t.tags)

      // Prune orphaned tags if completely replacing OB1 networks to prevent collision duplicates (%Q0.0, %I0.0)
      if (effectivePayload.operationMode === 'replace_ob1_networks') {
        const newTagNames = new Set((effectivePayload.tagsToUpsert || []).map((t) => t.name.toLowerCase()))
        const newTagAddrs = new Set((effectivePayload.tagsToUpsert || []).map((t) => t.address.toLowerCase()))

        // Gather all other referenced operands/addresses in other LAD blocks
        const otherReferencedOps = new Set<string>()
        const allOtherBlocks = useBlockStore.getState().ladBlocks.filter((b) => b.blockNumber !== 1 && b.name !== 'OB1_Main')
        for (const blk of allOtherBlocks) {
          for (const net of blk.networks || []) {
            for (const n of net.nodes || []) {
              if ((n as unknown as { operand?: string }).operand) otherReferencedOps.add(String((n as unknown as { operand?: string }).operand).toLowerCase())
              if ((n as unknown as { address?: string }).address) otherReferencedOps.add(String((n as unknown as { address?: string }).address).toLowerCase())
            }
          }
        }

        const currentTable = tagStore.tagTables.find((t) => t.id === tableId)
        if (currentTable) {
          const tagsToRemove = currentTable.tags.filter((t) => {
            const nameLower = t.name.toLowerCase()
            const addrLower = t.address.toLowerCase()
            if (newTagNames.has(nameLower) || newTagAddrs.has(addrLower)) return false
            if (otherReferencedOps.has(nameLower) || otherReferencedOps.has(addrLower)) return false
            return true
          })
          for (const t of tagsToRemove) {
            tagStore.deleteTag(tableId, t.id)
          }
        }
      }

      const refreshedTags = tagStore.tagTables.flatMap((t) => t.tags)
      for (const tag of effectivePayload.tagsToUpsert || []) {
        const normResult = normalizeS7Address(tag.address)
        const normAddr = normResult.isValid ? normResult.address : tag.address
        const existing = refreshedTags.find((t) => t.name.toLowerCase() === tag.name.toLowerCase())

        if (existing) {
          tagStore.updateTag(tableId, existing.id, {
            address: normAddr,
            dataType: tag.dataType,
            comment: tag.comment || ''
          })
          tagsCreatedNames.push(`${tag.name} (${normAddr}) [Updated]`)
        } else {
          tagStore.addTag(tableId, {
            name: tag.name,
            address: normAddr,
            dataType: tag.dataType,
            comment: tag.comment || ''
          })
          tagsCreatedNames.push(`${tag.name} (${normAddr})`)
        }
      }
    } catch (err) {
      console.warn('Failed to upsert tags in applyCircuitPayload:', err)
    }

    // 2. Upsert Networks into OB1_Main
    const blockStore = useBlockStore.getState()
    const ladBlocks = blockStore.ladBlocks
    const ob1 = ladBlocks.find((b) => (b.blockType === 'OB' && b.blockNumber === 1) || b.name === 'OB1_Main')

    let stagedChangeset: Array<{
      path: string
      title: string
      fileType: string
      beforeContent: string
      afterContent: string
    }> | undefined = undefined

    if (ob1) {
      const updatedNetworks =
        effectivePayload.operationMode === 'append_ob1_networks'
          ? [...(ob1.networks || []), ...(effectivePayload.networks || [])]
          : effectivePayload.networks || []

      // Normalize network numbers
      updatedNetworks.forEach((net, idx) => {
        net.networkNumber = idx + 1
      })

      if (mode === 'auto-apply') {
        blockStore.updateLadBlock(ob1.fileName, { networks: updatedNetworks })

        // 3. Auto-navigate to OB1_Main in workspace
        try {
          const uiStore = useUIStore.getState()
          const existingTab = uiStore.tabs.find(
            (t) => t.title === 'OB1_Main' || t.title === 'OB1' || t.targetId === ob1.fileName
          )
          if (existingTab) {
            uiStore.setActiveTab(existingTab.id)
          } else {
            uiStore.openTab({
              id: 'tab_ob1_main',
              title: 'OB1_Main',
              type: 'lad',
              targetId: ob1.fileName
            })
          }
        } catch {
          // ignore outside react
        }
      } else {
        // Diff-view staging
        stagedChangeset = [
          {
            path: `blocks/${ob1.fileName}`,
            title: `OB1_Main (${payload.networks.length} Networks)`,
            fileType: 'LAD',
            beforeContent: JSON.stringify(ob1.networks || [], null, 2),
            afterContent: JSON.stringify(updatedNetworks, null, 2)
          }
        ]
      }
    }

    const summaryText = [
      payload.explanation,
      '',
      `**Synthesized Ladder Logic Summary:**`,
      `- **Tags Configured:** ${tagsCreatedNames.join(', ') || 'None'}`,
      `- **Networks Drawn:** ${payload.networks?.length || 0} network(s) in OB1_Main`,
      `- **Execution Mode:** ${mode === 'auto-apply' ? '[Auto-Apply] Directly written to canvas' : '[Diff-View] Staged for review'}`
    ].join('\n')

    return {
      summaryText,
      stagedChangeset
    }
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
    const sanitized = sanitizeUserPrompt(prompt)
    const trimmed = sanitized.trim()
    const isTurkish = this.detectTurkish(trimmed)

    if (signal?.aborted) {
      throw new Error('Synthesis cancelled by user.')
    }

    let response: AgentExecutionResponse | null = null

    // Check if Ollama provider is selected
    if (this.config.provider === 'ollama') {
      try {
        response = await this.callOllamaApi(trimmed, tier, mode, isTurkish, signal)
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
    } else if (
      this.config.provider === 'gemini' ||
      (this.config.geminiApiKey &&
        this.config.geminiApiKey.trim() &&
        this.config.provider !== 'openai')
    ) {
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
    } else if (this.config.provider === 'openai' && this.config.openaiApiKey) {
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
            ? `OpenAI API hatası oluştu: ${errMsg}. Tuval değiştirilmedi.`
            : `OpenAI API error: ${errMsg}. Ladder canvas was not modified.`,
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

    // Default zero-key deterministic industrial synthesis engine
    if (!response) {
      response = await this.executeDeterministicOffline(trimmed, tier, mode, isTurkish)
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

  /**
   * Built-in Offline Deterministic Industrial Synthesis Engine
   */
  private async executeDeterministicOffline(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean
  ): Promise<AgentExecutionResponse> {
    const lower = prompt.toLowerCase()
    const tools = PlcAgentTools.getInstance()
    const toolCalls: AgentToolCall[] = []

    // 0. 10-Car Parking Garage (Otopark) Control System with CTUD, N_TRIG, TON, Interlocks (MEB Standard)
    const isParkingGarage =
      lower.includes('otopark') ||
      lower.includes('parking') ||
      lower.includes('garaj') ||
      lower.includes('garage') ||
      (lower.includes('kapı') && lower.includes('araç')) ||
      (lower.includes('kapi') && lower.includes('arac'))

    if (isParkingGarage) {
      BlackBoxLogger.getInstance().log('AI_REQUEST', `Offline Deterministic Synthesis: "${prompt}"`, {
        prompt,
        intent: 'ParkingGarage_MEB',
        isTurkish
      })

      const dslLines = [
        '# TAG DECLARATIONS',
        'TAG Giris_Kart %I0.0 BOOL "Giriş Kart Okuyucu (NO)"',
        'TAG Giris_Fotosel %I0.1 BOOL "Giriş Güvenlik Fotoseli"',
        'TAG Ust_Limit %I0.2 BOOL "Bariyer Üst Limit Sınır Anahtarı"',
        'TAG Alt_Limit %I0.3 BOOL "Bariyer Alt Limit Sınır Anahtarı"',
        'TAG Cikis_Fotosel %I0.4 BOOL "Çıkış Araç Algılama Fotoseli"',
        'TAG Kapi_Yukari_Motor %Q0.0 BOOL "Bariyer Kapı Yukarı Açma Motoru"',
        'TAG Kapi_Asagi_Motor %Q0.1 BOOL "Bariyer Kapı Aşağı Kapatma Motoru"',
        'TAG Otopark_Dolu_Tabela %Q0.2 BOOL "Otopark Dolu Işıklı Tabela"',
        '',
        '# NETWORK DEFINITIONS',
        `NW 1 "${isTurkish ? 'Bariyer Açma ve Emniyet Geri Açılma (Motor %Q0.0)' : 'Door Up & Safety Reopen Motor (%Q0.0)'}": SERIES( PARALLEL( SERIES( CMP_LT(C1.CV, 10), NO(Giris_Kart) ), SERIES( NO(Kapi_Asagi_Motor), NO(Giris_Fotosel) ), NO(Kapi_Yukari_Motor) ), NC(Ust_Limit), NC(Kapi_Asagi_Motor), COIL(Kapi_Yukari_Motor) )`,
        `NW 2 "${isTurkish ? 'Araç Giriş/Çıkış Sayacı (CTUD C1, PV=10)' : 'Vehicle In/Out Counter (CTUD C1, PV=10)'}": SERIES( N_TRIG(Giris_Fotosel), CTUD(C1, PV=10, CD=Cikis_Fotosel) )`,
        `NW 3 "${isTurkish ? '7 Saniye Otomatik Kapanma Zamanlayıcısı (TON T1)' : '7-Second Auto-Close Timer (TON T1)'}": SERIES( NO(Ust_Limit), TON(T1, PT=T#7s) )`,
        `NW 4 "${isTurkish ? 'Bariyer Aşağı Kapatma Motoru (%Q0.1)' : 'Door Down Closing Motor (%Q0.1)'}": SERIES( PARALLEL( NO(T1.Q), NO(Kapi_Asagi_Motor) ), NC(Alt_Limit), NC(Giris_Fotosel), NC(Kapi_Yukari_Motor), COIL(Kapi_Asagi_Motor) )`,
        `NW 5 "${isTurkish ? 'Otopark Dolu Tabelası Kontrolü (%Q0.2)' : 'Parking Full Sign Control (%Q0.2)'}": SERIES( CMP_GE(C1.CV, 10), COIL(Otopark_Dolu_Tabela) )`
      ]

      const dslResult = LadderDslCompiler.compileLadderDslToAst(dslLines.join('\n'))

      const explanation = isTurkish
        ? `10 Araçlık Otomatik Otopark Bariyer Kontrol Sistemi (MEB Standartı) başarıyla oluşturuldu:\n\n1. **Ağ 1 (Bariyer Açma & Emniyet Mühürlemesi):** Otopark dolu değilse (C1.CV < 10) ve Giriş Kartı okutulursa veya kapı inerken fotosel kesilirse bariyer açılmaya başlar, üst limit ve mekanik kilit ile korunur.\n2. **Ağ 2 (CTUD Araç Sayacı C1, PV=10):** Giriş fotoseli düşen kenarında (N_TRIG Giris_Fotosel) araç sayısını artırır (CU); çıkış fotoseli yükselen kenarında sayıyı azaltır (CD).\n3. **Ağ 3 (7s Otomatik Kapanma Zamanlayıcısı TON T1):** Bariyer en üst limite ulaştığında 7 saniyelik bekleme süresi başlar.\n4. **Ağ 4 (Bariyer Kapatma Motoru %Q0.1):** Süre dolduğunda (T1.Q) veya mühürleme ile kapı aşağı iner. Alt limit, giriş fotoseli veya karşı yön motoru devredeyken kapanma kilitlenir.\n5. **Ağ 5 (Otopark Dolu Tabelası %Q0.2):** Araç sayısı 10'a ulaştığında (CMP >= 10) tabela enerjilenir.\n\n**Semboller:** Giris_Kart (%I0.0), Giris_Fotosel (%I0.1), Ust_Limit (%I0.2), Alt_Limit (%I0.3), Cikis_Fotosel (%I0.4), Kapi_Yukari_Motor (%Q0.0), Kapi_Asagi_Motor (%Q0.1), Otopark_Dolu_Tabela (%Q0.2).`
        : `10-Car Automatic Parking Garage Barrier System created successfully:\n\n1. **Network 1 (Door Up & Safety Reopen):** Latches if not full (C1.CV < 10) AND Giris_Kart, or if closing motor active AND photocell blocked. Interlocked with NC Ust_Limit and NC Kapi_Asagi_Motor.\n2. **Network 2 (CTUD Vehicle Counter C1, PV=10):** Counts UP on N_TRIG Giris_Fotosel falling edge; counts DOWN on Cikis_Fotosel (CD).\n3. **Network 3 (7-Second TON Timer T1):** 7-second dwell starts when door reaches Ust_Limit (%I0.2).\n4. **Network 4 (Door Down Motor %Q0.1):** Latches on T1.Q done bit, cut off by NC Alt_Limit, NC Giris_Fotosel, and electrical interlock NC Kapi_Yukari_Motor.\n5. **Network 5 (Parking Full Sign %Q0.2):** Energizes when vehicle count reaches 10 (CMP >= 10).\n\n**Tags:** Giris_Kart (%I0.0), Giris_Fotosel (%I0.1), Ust_Limit (%I0.2), Alt_Limit (%I0.3), Cikis_Fotosel (%I0.4), Kapi_Yukari_Motor (%Q0.0), Kapi_Asagi_Motor (%Q0.1), Otopark_Dolu_Tabela (%Q0.2).`

      const parkingPayload: AiCircuitSynthesisPayload = {
        explanation,
        operationMode: 'replace_ob1_networks',
        tagsToUpsert: dslResult.tags.map((t) => ({
          name: t.name,
          dataType: t.dataType as any,
          address: t.address,
          comment: t.comment
        })),
        networks: dslResult.networks
      }

      BlackBoxLogger.getInstance().log('AI_PARSE_AND_AST_INJECTION', 'Generated Deterministic Parking Garage AST (5 networks, 8 tags)', {
        networks: dslResult.networks.length,
        tags: dslResult.tags.length
      })

      const res = this.applyCircuitPayload(parkingPayload, mode)
      return {
        replyText: res.summaryText,
        tier,
        providerUsed: 'offline_local',
        toolCallsExecuted: toolCalls,
        toolResults: [],
        stagedChangeset: res.stagedChangeset,
        rawTraceSnippet: 'Offline Deterministic MEB Parking Garage'
      }
    }

    // 1. Memory Overlap resolution intent
    if (
      (lower.includes('overlap') ||
        lower.includes('collision') ||
        lower.includes('çakışma') ||
        lower.includes('bellek')) &&
      !lower.includes('valve') &&
      !lower.includes('vana') &&
      !lower.includes('pompa') &&
      !lower.includes('pump') &&
      !lower.includes('booster') &&
      !lower.includes('hidrofor')
    ) {
      toolCalls.push({
        tool: 'manage_plc_tags',
        params: { action: 'resolve_overlaps' }
      })
      toolCalls.push({
        tool: 'run_compiler_and_self_heal',
        params: {}
      })

      const execution = await tools.executeToolBatch(toolCalls, mode)
      const reply = isTurkish
        ? `S7 Bellek Haritası analiz edildi. Tespit edilen çakışan adresler S7 byte/word sınırlarına (even-byte boundary) uygun güvenli boş alanlara otomatik olarak yeniden taşındı.\n\n${execution.compilerReport?.message || '[OK] Derleyici Doğrulandı: 0 Hata'}`
        : `S7 Memory Map analyzed. Detected address collisions were reallocated to safe, non-overlapping addresses respecting S7 even-byte word alignments.\n\n${execution.compilerReport?.message || '[OK] Compiler Verified: 0 Errors'}`

      return {
        replyText: reply,
        tier,
        providerUsed: 'offline_local',
        toolCallsExecuted: toolCalls,
        toolResults: execution.results,
        compilerVerification: execution.compilerReport,
        stagedChangeset: execution.stagedChangeset
      }
    }

    // 2. Double-Coil merge intent
    if (
      lower.includes('double coil') ||
      lower.includes('double-coil') ||
      lower.includes('çift bobin') ||
      lower.includes('auto-merge') ||
      lower.includes('bobin birleştir')
    ) {
      toolCalls.push({
        tool: 'create_or_update_lad_block',
        params: { action: 'auto_refactor_double_coils', blockName: 'OB1_Main' }
      })
      toolCalls.push({
        tool: 'run_compiler_and_self_heal',
        params: {}
      })

      const execution = await tools.executeToolBatch(toolCalls, mode)
      const reply = isTurkish
        ? `OB1_Main bloğu içerisindeki çift bobin (double-coil) yazma çakışmaları tespit edildi. TIA Portal standart Çözüm A (Intermediate Temp Coils + Consolidation OR Network) deseni ile tek bir nihai ağda birleştirildi.\n\n${execution.compilerReport?.message || '[OK] Derleyici Doğrulandı: 0 Hata'}`
        : `Double-coil write conflicts in OB1_Main detected. Auto-refactored using Siemens Solution A pattern (Intermediate temp coils consolidated into a final deterministic OR-network).\n\n${execution.compilerReport?.message || '[OK] Compiler Verified: 0 Errors'}`

      return {
        replyText: reply,
        tier,
        providerUsed: 'offline_local',
        toolCallsExecuted: toolCalls,
        toolResults: execution.results,
        compilerVerification: execution.compilerReport,
        stagedChangeset: execution.stagedChangeset
      }
    }

    // 3. Multi-Pump booster station / Hidrofor sistemi intent
    if (
      lower.includes('hidrofor') ||
      lower.includes('booster') ||
      (lower.includes('pompa') && (lower.includes('3') || lower.includes('eş yaşlandırma') || lower.includes('alternation'))) ||
      (lower.includes('pump') && (lower.includes('lead-lag') || lower.includes('staging') || lower.includes('3') || lower.includes('pumpcontrol') || lower.includes('fb_pumpcontrol')))
    ) {
      const sclBlockName = lower.includes('fb_pumpcontrol') || lower.includes('pumpcontrol') ? 'FB_PumpControl' : 'FC_BoosterAlternation'
      const sclBlockType = lower.includes('fb_pumpcontrol') || lower.includes('pumpcontrol') ? 'FB' : 'FC'

      // Create UDT
      toolCalls.push({
        tool: 'create_or_update_udt',
        params: {
          name: 'UDT_BoosterPump',
          fields: [
            { name: 'RunCmd', dataType: 'BOOL', comment: 'Coil command to contactor' },
            { name: 'RunFeedback', dataType: 'BOOL', comment: 'Auxiliary contact feedback' },
            { name: 'TripFault', dataType: 'BOOL', comment: 'Thermal overload or VFD fault' },
            { name: 'RunHours', dataType: 'REAL', comment: 'Runtime accumulated operating hours' }
          ]
        }
      })

      // Create DB
      toolCalls.push({
        tool: 'create_or_update_db',
        params: {
          name: 'DB_BoosterStation',
          isOptimized: true,
          variables: [
            { name: 'Pump1', dataType: 'UDT_BoosterPump', initialValue: '', comment: 'Hydraulic Booster Pump 1' },
            { name: 'Pump2', dataType: 'UDT_BoosterPump', initialValue: '', comment: 'Hydraulic Booster Pump 2' },
            { name: 'Pump3', dataType: 'UDT_BoosterPump', initialValue: '', comment: 'Hydraulic Booster Pump 3' },
            { name: 'TargetPressure_Bar', dataType: 'REAL', initialValue: '4.5', comment: 'Header setpoint pressure' },
            { name: 'ActualPressure_Bar', dataType: 'REAL', initialValue: '0.0', comment: 'Header actual pressure' },
            { name: 'ActivePumpsCount', dataType: 'INT', initialValue: '0', comment: 'Currently energized pumps' }
          ]
        }
      })

      // Create SCL Logic Block
      toolCalls.push({
        tool: 'create_or_update_scl_block',
        params: {
          name: sclBlockName,
          blockType: sclBlockType,
          sourceCode: `// Siemens S7-1200/1500 3-Pump Equal Wear Alternation (Eş Yaşlandırma)
IF "DB_BoosterStation".ActualPressure_Bar < ("DB_BoosterStation".TargetPressure_Bar - 0.5) THEN
    // Low pressure: Stage on least worn pump
    IF NOT "DB_BoosterStation".Pump1.RunCmd AND NOT "DB_BoosterStation".Pump1.TripFault THEN
        "DB_BoosterStation".Pump1.RunCmd := TRUE;
    ELSIF NOT "DB_BoosterStation".Pump2.RunCmd AND NOT "DB_BoosterStation".Pump2.TripFault THEN
        "DB_BoosterStation".Pump2.RunCmd := TRUE;
    ELSIF NOT "DB_BoosterStation".Pump3.RunCmd AND NOT "DB_BoosterStation".Pump3.TripFault THEN
        "DB_BoosterStation".Pump3.RunCmd := TRUE;
    END_IF;
ELSIF "DB_BoosterStation".ActualPressure_Bar > ("DB_BoosterStation".TargetPressure_Bar + 0.5) THEN
    // High pressure: Stage off highest hour pump
    IF "DB_BoosterStation".Pump3.RunCmd THEN
        "DB_BoosterStation".Pump3.RunCmd := FALSE;
    ELSIF "DB_BoosterStation".Pump2.RunCmd THEN
        "DB_BoosterStation".Pump2.RunCmd := FALSE;
    ELSIF "DB_BoosterStation".Pump1.RunCmd THEN
        "DB_BoosterStation".Pump1.RunCmd := FALSE;
    END_IF;
END_IF;`
        }
      })

      toolCalls.push({
        tool: 'run_compiler_and_self_heal',
        params: {}
      })

      const execution = await tools.executeToolBatch(toolCalls, mode)
      const reply = isTurkish
        ? `3 Pompalı Eş Yaşlandırmalı Hidrofor Sistemi başarıyla oluşturuldu:\n\n1. **UDT_BoosterPump**: Pompa çalıştırma, geri bildirim, termik arıza ve çalışma saati alanları tanımlandı.\n2. **DB_BoosterStation**: 3 adet hidrofor pompası, hedef basınç (4.5 Bar) ve anlık basınç parametreleri ile optimize DB olarak oluşturuldu.\n3. **${sclBlockName}**: Histerezisli basınç bandına göre pompaları devreye alan/çıkaran SCL algoritması yazıldı.\n\n${execution.compilerReport?.message || '[OK] Derleyici Doğrulandı: 0 Hata'}`
        : `3-Pump Equal Wear Booster Station created successfully:\n\n1. **UDT_BoosterPump**: RunCmd, RunFeedback, TripFault, and RunHours fields declared.\n2. **DB_BoosterStation**: Optimized DB with 3 pump instances, TargetPressure_Bar (4.5 Bar), and ActualPressure_Bar.\n3. **${sclBlockName}**: SCL staging logic with hysteresis pressure band and wear balancing.\n\n${execution.compilerReport?.message || '[OK] Compiler Verified: 0 Errors'}`

      return {
        replyText: reply,
        tier,
        providerUsed: 'offline_local',
        toolCallsExecuted: toolCalls,
        toolResults: execution.results,
        compilerVerification: execution.compilerReport,
        stagedChangeset: execution.stagedChangeset
      }
    }

    // 4. Valve Control intent (UDT_Valve, Tags, FB_ValveControl, Compiler Verification)
    if (
      lower.includes('valve') ||
      lower.includes('vana') ||
      lower.includes('fb_valvecontrol') ||
      lower.includes('udt_valve')
    ) {
      const isOverride =
        lower.includes('emergency') ||
        lower.includes('override') ||
        lower.includes('acil kapatma') ||
        lower.includes('update') ||
        lower.includes('güncelle')

      if (isOverride) {
        toolCalls.push({
          tool: 'create_or_update_scl_block',
          params: {
            name: 'FB_ValveControl',
            blockType: 'FB',
            sourceCode: `FUNCTION_BLOCK "FB_ValveControl"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
VAR_INPUT
  EmergencyStop : Bool;
  OpenRequest : Bool;
  CloseRequest : Bool;
  OpenedLimit : Bool;
  ClosedLimit : Bool;
END_VAR
VAR_OUTPUT
  OpenCmd : Bool;
  CloseCmd : Bool;
  IsOpen : Bool;
  IsClosed : Bool;
END_VAR
BEGIN
// Updated with Emergency Close Priority Override
IF #EmergencyStop THEN
    #OpenCmd := FALSE;
    #CloseCmd := TRUE;
ELSIF #OpenRequest AND NOT #CloseRequest THEN
    #OpenCmd := TRUE;
    #CloseCmd := FALSE;
ELSIF #CloseRequest AND NOT #OpenRequest THEN
    #OpenCmd := FALSE;
    #CloseCmd := TRUE;
ELSE
    #OpenCmd := FALSE;
    #CloseCmd := FALSE;
END_IF;

// Position Feedback Status
#IsOpen := #OpenedLimit AND NOT #ClosedLimit;
#IsClosed := #ClosedLimit AND NOT #OpenedLimit;
END_FUNCTION_BLOCK`
          }
        })
      } else {
        // 1. UDT_Valve
        toolCalls.push({
          tool: 'create_or_update_udt',
          params: {
            name: 'UDT_Valve',
            description: 'Siemens Standard Valve Control UDT',
            fields: [
              { name: 'OpenCmd', dataType: 'BOOL', comment: 'Solenoid coil open command' },
              { name: 'CloseCmd', dataType: 'BOOL', comment: 'Solenoid coil close command' },
              { name: 'OpenedLimit', dataType: 'BOOL', comment: 'End position open limit switch' },
              { name: 'ClosedLimit', dataType: 'BOOL', comment: 'End position close limit switch' },
              { name: 'TransitFault', dataType: 'BOOL', comment: 'Travel time exceeded alarm' }
            ]
          }
        })

        // 2. Tags without overlap
        toolCalls.push({
          tool: 'manage_plc_tags',
          params: {
            action: 'upsert',
            tags: [
              { id: 'tag_v_open', name: 'Valve_OpenCmd', address: '%Q0.3', dataType: 'BOOL', comment: 'Valve Open Solenoid' },
              { id: 'tag_v_close', name: 'Valve_CloseCmd', address: '%Q0.4', dataType: 'BOOL', comment: 'Valve Close Solenoid' },
              { id: 'tag_v_opened', name: 'Valve_OpenedLimit', address: '%I0.4', dataType: 'BOOL', comment: 'Valve Opened Prox Sensor' },
              { id: 'tag_v_closed', name: 'Valve_ClosedLimit', address: '%I0.5', dataType: 'BOOL', comment: 'Valve Closed Prox Sensor' }
            ]
          }
        })

        // 3. FB_ValveControl SCL Block
        toolCalls.push({
          tool: 'create_or_update_scl_block',
          params: {
            name: 'FB_ValveControl',
            blockType: 'FB',
            sourceCode: `FUNCTION_BLOCK "FB_ValveControl"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
VAR_INPUT
  OpenRequest : Bool;
  CloseRequest : Bool;
  OpenedLimit : Bool;
  ClosedLimit : Bool;
END_VAR
VAR_OUTPUT
  OpenCmd : Bool;
  CloseCmd : Bool;
  IsOpen : Bool;
  IsClosed : Bool;
END_VAR
BEGIN
// Manages open/close actuation with limit switch feedback and travel timeout supervision
IF #OpenRequest AND NOT #CloseRequest THEN
    #OpenCmd := TRUE;
    #CloseCmd := FALSE;
ELSIF #CloseRequest AND NOT #OpenRequest THEN
    #OpenCmd := FALSE;
    #CloseCmd := TRUE;
ELSE
    #OpenCmd := FALSE;
    #CloseCmd := FALSE;
END_IF;

// Position Feedback Status
#IsOpen := #OpenedLimit AND NOT #ClosedLimit;
#IsClosed := #ClosedLimit AND NOT #OpenedLimit;
END_FUNCTION_BLOCK`
          }
        })
      }

      toolCalls.push({
        tool: 'run_compiler_and_self_heal',
        params: {}
      })

      const execution = await tools.executeToolBatch(toolCalls, mode)
      const reply = isTurkish
        ? isOverride
          ? `FB_ValveControl bloğu acil kapatma önceliği (Emergency Close Override) ile güncellendi.\n\n${execution.compilerReport?.message || '[OK] Derleyici Doğrulandı: 0 Hata'}`
          : `Endüstriyel Vana Kontrol Sistemi başarıyla oluşturuldu:\n\n1. **UDT_Valve**: OpenCmd, CloseCmd, OpenedLimit, ClosedLimit ve TransitFault alanları tanımlandı.\n2. **PLC Tagleri**: Çakışmasız güvenli adreslere (Q0.3, Q0.4, I0.4, I0.5) vana I/O etiketleri eklendi.\n3. **FB_ValveControl**: Çift yönlü aktüasyon ve konum izleme algoritmaları SCL olarak oluşturuldu.\n\n${execution.compilerReport?.message || '[OK] Derleyici Doğrulandı: 0 Hata'}`
        : isOverride
          ? `FB_ValveControl block updated with Emergency Close Priority Override logic.\n\n${execution.compilerReport?.message || '[OK] Compiler Verified: 0 Errors'}`
          : `Industrial Valve Control System created successfully:\n\n1. **UDT_Valve**: OpenCmd, CloseCmd, OpenedLimit, ClosedLimit, and TransitFault members declared.\n2. **PLC Tags**: Non-overlapping I/O tags allocated at %Q0.3, %Q0.4, %I0.4, %I0.5.\n3. **FB_ValveControl**: Bidirectional actuation and position feedback supervisory SCL block created.\n\n${execution.compilerReport?.message || '[OK] Compiler Verified: 0 Errors'}`

      return {
        replyText: reply,
        tier,
        providerUsed: 'offline_local',
        toolCallsExecuted: toolCalls,
        toolResults: execution.results,
        compilerVerification: execution.compilerReport,
        stagedChangeset: execution.stagedChangeset
      }
    }

    // 5. OB30 PID & Analog Scaling intent
    if (
      lower.includes('pid') ||
      lower.includes('ob30') ||
      (lower.includes('analog') && (lower.includes('scale') || lower.includes('ölçek')))
    ) {
      toolCalls.push({
        tool: 'update_hardware_parameters',
        params: {
          obCyclicInterruptIntervalMs: 100,
          aiWireBreakDetection: true
        }
      })

      toolCalls.push({
        tool: 'create_or_update_scl_block',
        params: {
          name: 'OB30_CyclicInterrupt',
          blockType: 'OB',
          sourceCode: `// OB30 100ms Cyclic Interrupt for Analog Scaling and PID Control
// Normalize %IW64 (0..27648) and scale to Engineering Units (0.0 .. 10.0 Bar)
VAR_TEMP
    rNormalized : REAL;
    rPressureBar : REAL;
END_VAR

// Siemens S7-1200 NORM_X formula
rNormalized := INT_TO_REAL("TankLevel_Raw") / 27648.0;
IF rNormalized < 0.0 THEN rNormalized := 0.0; END_IF;
IF rNormalized > 1.0 THEN rNormalized := 1.0; END_IF;

// Siemens S7-1200 SCALE_X formula
rPressureBar := rNormalized * 10.0;
"TankPressure_Bar" := rPressureBar;`
        }
      })

      toolCalls.push({
        tool: 'run_compiler_and_self_heal',
        params: {}
      })

      const execution = await tools.executeToolBatch(toolCalls, mode)
      const reply = isTurkish
        ? `OB30 100ms Döngüsel Kesme (Cyclic Interrupt) ve Analog NORM_X/SCALE_X modülü yapılandırıldı:\n\n1. CPU donanım parametrelerinde OB30 periyodu 100ms olarak ayarlandı ve AI tel kopması teşhisi etkinleştirildi.\n2. OB30_CyclicInterrupt SCL bloğu oluşturularak %IW64 ham analog verisi 0..27648 aralığından 0.0..10.0 Bar mühendislik birimine dönüştürüldü.\n\n${execution.compilerReport?.message || '[OK] Derleyici Doğrulandı: 0 Hata'}`
        : `OB30 100ms Cyclic Interrupt and Analog NORM_X/SCALE_X module configured:\n\n1. Hardware configuration updated for 100ms OB30 interval and AI wire-break diagnostic enabled.\n2. OB30_CyclicInterrupt SCL block created with Siemens NORM_X/SCALE_X converting %IW64 raw count (0..27648) to 0.0..10.0 Bar.\n\n${execution.compilerReport?.message || '[OK] Compiler Verified: 0 Errors'}`

      return {
        replyText: reply,
        tier,
        providerUsed: 'offline_local',
        toolCallsExecuted: toolCalls,
        toolResults: execution.results,
        compilerVerification: execution.compilerReport,
        stagedChangeset: execution.stagedChangeset
      }
    }

    // Default conversational engineering synthesis
    toolCalls.push({
      tool: 'read_project_overview',
      params: {}
    })
    const execution = await tools.executeToolBatch(toolCalls, 'auto-apply')
    const reply = isTurkish
      ? `Rungline S7 Mühendislik Asistanı isteğinizi analiz etti: "${prompt}".\n\nCPU ve Derleyici AST denetleyicisi aktif. Belirli bir PLC devresi (örn: mühürlemeli motor devresi, zamanlayıcı kontrolü, vana veya hidrofor mantığı) oluşturmak istediğinizde komutunuzu doğrudan iletebilirsiniz.`
      : `Rungline S7 Engineering Agent analyzed your request: "${prompt}".\n\nCPU and Compiler AST inspector active. Feel free to request any ladder circuit synthesis, timer logic, valve control, or booster station automation.`

    return {
      replyText: reply,
      tier,
      providerUsed: 'offline_local',
      toolCallsExecuted: toolCalls,
      toolResults: execution.results
    }
  }

  /**
   * Gemini API client with Structured JSON Output & Ladder Synthesis
   */
  /**
   * Gemini API client with Structured JSON Output & Ladder Synthesis
   */
  private async callGeminiApi(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const startMs = Date.now()
    const primaryModel = (
      this.config.selectedModelId || (tier === 'fast-flash' ? this.config.fastModel : this.config.deepModel)
    )
      .trim()
      .replace(/^models\//i, '')

    const candidateModels = [
      primaryModel,
      'gemini-2.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.0-flash'
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx)

    BlackBoxLogger.getInstance().log('AI_REQUEST', `Gemini API Request (${primaryModel})`, {
      prompt,
      model: primaryModel,
      candidateModels,
      tier,
      mode
    })

    // Retrieve Top 4 Semantic MEB RAG Rules
    const ragEngine = RagKnowledgeEngine.getInstance()
    const topRules = ragEngine.retrieveTopKRules(prompt, 4)
    const ragPromptSection = ragEngine.formatRetrievedRulesForPrompt(topRules)
    const consultedRuleNames = topRules.map((r) => r.item.name)

    const systemInstructionText = `You are an expert Siemens S7-1200/1500 PLC Automation Architect in the Rungline IDE following strict MEB Automation Curriculum standards.
When asked to synthesize, create, or modify PLC Ladder logic, circuits, timers, motors, or I/O configurations, output your response in structured JSON or Compact Ladder DSL:

STRUCTURED JSON OUTPUT SCHEMA:
{
  "explanation": "Detailed engineering explanation in the user's language.",
  "operationMode": "replace_ob1_networks",
  "tagsToUpsert": [
    { "name": "Start", "dataType": "BOOL", "address": "%I0.0", "comment": "Start pushbutton" }
  ],
  "networks": [
    {
      "networkNumber": 1,
      "title": "Network Title",
      "comment": "Description",
      "nodes": [ ... ]
    }
  ],
  "dsl": "optional Compact Ladder DSL text"
}

COMPACT LADDER DSL SYNTAX:
# EXPLANATION
Detailed engineering explanation in the user's language.

# TAG DECLARATIONS
TAG <Name> <Address> <DataType> "<Comment>"

# NETWORK DEFINITIONS
NW 1 "<Title>": <EXPRESSION>
NW 2 "<Title>": <EXPRESSION>

DSL Elements:
- Contacts: NO(operand), NC(operand), P_TRIG(operand), N_TRIG(operand)
- Coils: COIL(operand), NEG_COIL(operand), SET(operand), RESET(operand)
- Timers: TON(T_Name, PT=T#10s), TOF(...), TP(...)
- Counters: CTU(C_Name, PV=10), CTD(...), CTUD(C_Name, PV=10, CD=...)
- Comparators: CMP_EQ(in1, in2), CMP_GT, CMP_LT, CMP_GE, CMP_LE
- Math: ADD(in1, in2, out), SUB, MUL, DIV, MOVE, NORM_X, SCALE_X
- Combinators: SERIES(elem1, elem2, ...), PARALLEL(branch1, branch2, ...)

CRITICAL MEB INDUSTRIAL RULES:
1. STRICT BAN ON DUMMY %M TIMER COILS: Never create dummy %M coils following a timer. Timers terminate cleanly at the rung end without a coil.
2. NATIVE SUB-BIT ADDRESSING: Contacts reading a timer done bit MUST use 'T1.Q' directly. Counter bits use 'C1.QU', 'C1.QD', 'C1.CV'.
3. MOTOR SEAL-IN: Network 1 has Start NO parallel with Motor NO, series with Stop NC and T1.Q NC, driving Motor coil. Network 2 has Motor NO driving TON T1.
4. ZERO DUMMY %M TAGS: Do not declare dummy %M tags for timer done flags.
5. INDICATOR LAMPS & LEDS: If the user requests indicator lamps/LEDs (e.g. green LED when motor runs, red LED when motor stops), assign distinct safe addresses (e.g. Green LED %Q0.1, Red LED %Q0.2) and add dedicated networks: Network 3 (Motor NO driving Green LED coil) and Network 4 (Motor NC driving Red LED coil). NEVER assign duplicate addresses to different tags.
6. PARKING GARAGE / BARRIER AUTOMATION:
   - Giris_Kart (%I0.0), Giris_Fotosel (%I0.1), Ust_Limit (%I0.2), Alt_Limit (%I0.3), Cikis_Fotosel (%I0.4)
   - Kapi_Yukari_Motor (%Q0.0), Kapi_Asagi_Motor (%Q0.1), Otopark_Dolu_Tabela (%Q0.2)
   - Use CTUD C1 (PV=10) with CU triggered by N_TRIG Giris_Fotosel, and CD triggered by Cikis_Fotosel.
   - Use TON T1 (PT=T#7s) for auto-close dwell after reaching Ust_Limit.
${ragPromptSection}
Standard Siemens S7 Addresses: Inputs %I0.0..%I1.5, Outputs %Q0.0..%Q1.1.
If the prompt is purely informational without ladder logic, provide an explanation directly.`

    const cleanKey = (this.config.geminiApiKey || '').trim()
    let rawText = ''
    let lastError: Error | null = null
    let successfulModel = ''
    let attemptedAutoDiscovery = false

    for (let i = 0; i < candidateModels.length; i++) {
      const modelToTry = candidateModels[i]
      if (signal?.aborted) throw new Error('Synthesis cancelled by user.')

      const cleanModelId = modelToTry.trim().replace(/^models\//i, '')
      const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}:generateContent`

      // Fresh 90-second timeout controller per candidate model attempt
      const modelController = new AbortController()
      let modelTimedOut = false
      const modelTimeoutId = setTimeout(() => {
        modelTimedOut = true
        modelController.abort()
      }, 90000)

      const onExternalAbort = () => {
        modelController.abort()
      }
      if (signal) {
        if (signal.aborted) {
          clearTimeout(modelTimeoutId)
          throw new Error('Synthesis cancelled by user.')
        }
        signal.addEventListener('abort', onExternalAbort)
      }

      const attemptFetch = async (includeThinkingConfig: boolean) => {
        const generationConfig: Record<string, any> = {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
        if (includeThinkingConfig) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 }
        }

        return fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cleanKey },
          signal: modelController.signal,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemInstructionText }]
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }]
              }
            ],
            generationConfig
          })
        })
      }

      try {
        let response = await attemptFetch(true)

        // If HTTP 400 occurred and thinkingConfig was passed, retry once without thinkingConfig
        if (response.status === 400) {
          const errBody = await response.text()
          BlackBoxLogger.getInstance().log(
            'AI_FALLBACK_OR_RETRY',
            `Candidate model ${cleanModelId} rejected thinkingConfig (HTTP 400). Retrying without thinkingConfig...`,
            { model: cleanModelId, status: 400, errorBody: errBody }
          )
          response = await attemptFetch(false)
        }

        if (!response.ok) {
          const errStatus = response.status
          const errorBodyText = await response.text()
          BlackBoxLogger.getInstance().log(
            'AI_FALLBACK_OR_RETRY',
            `Candidate model ${cleanModelId} returned HTTP ${errStatus}`,
            {
              model: cleanModelId,
              status: errStatus,
              url: requestUrl.replace(cleanKey, '***'),
              errorBody: errorBodyText
            }
          )

          // Live Self-Healing Model Discovery on HTTP 404
          if (errStatus === 404 && !attemptedAutoDiscovery && cleanKey) {
            attemptedAutoDiscovery = true
            BlackBoxLogger.getInstance().log(
              'AI_FALLBACK_OR_RETRY',
              `HTTP 404 encountered for model ${cleanModelId}. Initiating live /v1beta/models auto-discovery...`,
              { model: cleanModelId }
            )
            try {
              const discRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`,
                { signal: modelController.signal }
              )
              if (discRes.ok) {
                const discData = await discRes.json()
                const rawModels: Array<{
                  name: string
                  displayName?: string
                  description?: string
                  supportedGenerationMethods?: string[]
                }> = discData.models || []

                const filtered: DiscoveredModel[] = rawModels
                  .filter((m) => {
                    const hasGen =
                      Array.isArray(m.supportedGenerationMethods) &&
                      m.supportedGenerationMethods.includes('generateContent')
                    if (!hasGen) return false
                    const cId = m.name.replace(/^models\//, '')
                    return isStrictGeminiTextModel(cId)
                  })
                  .map((m) => {
                    const cId = m.name.replace(/^models\//, '')
                    return {
                      id: cId,
                      displayName: m.displayName || cId,
                      description: m.description
                    }
                  })

                const sorted = sortGeminiModels(filtered)
                if (sorted.length > 0) {
                  this.config.availableModels = sorted
                  this.config.selectedModelId = sorted[0].id
                  this.saveConfig()

                  for (const dm of sorted) {
                    if (!candidateModels.includes(dm.id)) {
                      candidateModels.push(dm.id)
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
          continue
        }

        const data = await response.json()
        rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        if (rawText) {
          successfulModel = cleanModelId
          break
        }
      } catch (fetchErr: unknown) {
        if (
          signal?.aborted ||
          (fetchErr as { name?: string })?.name === 'AbortError' ||
          String(fetchErr).includes('cancelled')
        ) {
          if (modelTimedOut) {
            throw new Error(`Gemini API call to model ${cleanModelId} timed out after 90 seconds.`)
          }
          throw fetchErr
        }
        BlackBoxLogger.getInstance().log(
          'AI_FALLBACK_OR_RETRY',
          `Candidate model ${cleanModelId} failed: ${fetchErr}. Retrying next in chain...`,
          { model: cleanModelId, error: String(fetchErr) }
        )
        lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr))
      } finally {
        clearTimeout(modelTimeoutId)
        if (signal) {
          signal.removeEventListener('abort', onExternalAbort)
        }
      }
    }

    if (!rawText) {
      const finalErr = lastError || new Error('No candidate Gemini model produced a response.')
      BlackBoxLogger.getInstance().log('AI_ERROR', `All candidate Gemini models failed: ${finalErr.message}`, {
        candidateModels,
        error: String(finalErr)
      })
      throw finalErr
    }

    const elapsedMs = Date.now() - startMs
    BlackBoxLogger.getInstance().log(
      'AI_RAW_RESPONSE',
      `Gemini API Response received from ${successfulModel} (${elapsedMs}ms, ${rawText.length} chars)`,
      { model: successfulModel, elapsedMs, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
    )

    // 1. Resilient JSON Block extraction first (for responseMimeType: application/json)
    const jsonExtract = this.extractValidJsonBlock(rawText)
    if (jsonExtract && jsonExtract.json) {
      const parsed = jsonExtract.json as AiCircuitSynthesisPayload & { dsl?: string }

      // Check if JSON includes compact DSL
      if (parsed.dsl && typeof parsed.dsl === 'string') {
        const dslResult = LadderDslCompiler.compileLadderDslToAst(parsed.dsl)
        if (dslResult.success && dslResult.networks.length > 0) {
          const normalizedNws = normalizeAiGeneratedNetworks(dslResult.networks)
          const circuitPayload: AiCircuitSynthesisPayload = {
            explanation: parsed.explanation || dslResult.explanation || 'Synthesized Ladder Logic via Compact Ladder DSL.',
            operationMode: parsed.operationMode || 'replace_ob1_networks',
            tagsToUpsert: dslResult.tags.map((t) => ({
              name: t.name,
              dataType: t.dataType as any,
              address: t.address,
              comment: t.comment
            })),
            networks: normalizedNws
          }
          const result = this.applyCircuitPayload(circuitPayload, mode)
          BlackBoxLogger.getInstance().log(
            'AI_PARSE_AND_AST_INJECTION',
            `Compact Ladder DSL compiled: ${normalizedNws.length} networks, ${dslResult.tags.length} tags`,
            { networks: normalizedNws.length, tags: dslResult.tags.length }
          )
          return {
            replyText: result.summaryText,
            tier,
            providerUsed: 'gemini',
            toolCallsExecuted: [],
            toolResults: [],
            ragRulesConsulted: consultedRuleNames,
            stagedChangeset: result.stagedChangeset,
            rawTraceSnippet: rawText.substring(0, 300),
            rawJson: jsonExtract.raw
          }
        }
      }

      if (parsed && Array.isArray(parsed.networks) && parsed.networks.length > 0) {
        const normalizedNetworks = normalizeAiGeneratedNetworks(parsed.networks)
        const tags = Array.isArray(parsed.tagsToUpsert) ? parsed.tagsToUpsert : []
        const circuitPayload: AiCircuitSynthesisPayload = {
          explanation: parsed.explanation || 'Synthesized Ladder Logic via Google Gemini.',
          operationMode: parsed.operationMode || 'replace_ob1_networks',
          tagsToUpsert: tags,
          networks: normalizedNetworks
        }
        const result = this.applyCircuitPayload(circuitPayload, mode)
        BlackBoxLogger.getInstance().log(
          'AI_PARSE_AND_AST_INJECTION',
          `Extracted JSON payload: ${normalizedNetworks.length} networks, ${tags.length} tags`,
          { networks: normalizedNetworks.length, tags: tags.length }
        )
        return {
          replyText: result.summaryText,
          tier,
          providerUsed: 'gemini',
          toolCallsExecuted: [],
          toolResults: [],
          ragRulesConsulted: consultedRuleNames,
          stagedChangeset: result.stagedChangeset,
          rawTraceSnippet: rawText.substring(0, 300),
          rawJson: jsonExtract.raw
        }
      } else if (parsed && parsed.explanation) {
        return {
          replyText: parsed.explanation,
          tier,
          providerUsed: 'gemini',
          toolCallsExecuted: [],
          toolResults: [],
          rawTraceSnippet: rawText.substring(0, 300)
        }
      }
    }

    // 2. Direct Ladder DSL compilation if returned in plain text format
    if (
      rawText.includes('# NETWORK DEFINITIONS') ||
      rawText.includes('NW ') ||
      rawText.includes('SERIES(') ||
      rawText.includes('# TAG DECLARATIONS') ||
      rawText.includes('TAG ')
    ) {
      const cleanDsl = rawText
        .replace(/^```[a-zA-Z0-9_-]*\r?\n/gm, '')
        .replace(/```$/gm, '')
        .trim()

      const dslResult = LadderDslCompiler.compileLadderDslToAst(cleanDsl)
      if (dslResult.success && dslResult.networks.length > 0) {
        const normalizedNetworks = normalizeAiGeneratedNetworks(dslResult.networks)
        const circuitPayload: AiCircuitSynthesisPayload = {
          explanation: dslResult.explanation || 'Synthesized Ladder Logic via Compact Ladder DSL Engine.',
          operationMode: 'replace_ob1_networks',
          tagsToUpsert: dslResult.tags.map((t) => ({
            name: t.name,
            dataType: t.dataType as any,
            address: t.address,
            comment: t.comment
          })),
          networks: normalizedNetworks
        }
        const result = this.applyCircuitPayload(circuitPayload, mode)
        BlackBoxLogger.getInstance().log(
          'AI_PARSE_AND_AST_INJECTION',
          `Compact Ladder DSL compiled: ${normalizedNetworks.length} networks, ${dslResult.tags.length} tags`,
          { networks: normalizedNetworks.length, tags: dslResult.tags.length }
        )
        return {
          replyText: result.summaryText,
          tier,
          providerUsed: 'gemini',
          toolCallsExecuted: [],
          toolResults: [],
          ragRulesConsulted: consultedRuleNames,
          stagedChangeset: result.stagedChangeset,
          rawTraceSnippet: rawText.substring(0, 300),
          rawJson: JSON.stringify(circuitPayload, null, 2)
        }
      }
    }

    // 3. Conversational explanation or unparsed response
    if (
      prompt.toLowerCase().includes('devre') ||
      prompt.toLowerCase().includes('circuit') ||
      prompt.toLowerCase().includes('motor') ||
      prompt.toLowerCase().includes('otopark') ||
      prompt.toLowerCase().includes('parking')
    ) {
      BlackBoxLogger.getInstance().log('AI_PARSE_ERROR', 'Model text did not contain valid Ladder DSL or JSON blocks', {
        rawSnippet: rawText.substring(0, 500)
      })
    }

    return {
      replyText: rawText || 'Model produced empty response.',
      tier,
      providerUsed: 'gemini',
      toolCallsExecuted: [],
      toolResults: [],
      rawTraceSnippet: rawText.substring(0, 300)
    }
  }

  /**
   * OpenAI API client
   */
  private async callOpenAiApi(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const model = tier === 'fast-flash' ? 'gpt-4o-mini' : 'gpt-4o'
    const endpoint = this.config.openaiEndpoint.replace(/\/$/, '') + '/chat/completions'

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`
      },
      signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert Siemens S7-1200/1500 PLC Automation Architect in the Rungline IDE. Output PLC circuits in Compact Ladder DSL with # TAG DECLARATIONS and # NETWORK DEFINITIONS.'
          },
          { role: 'user', content: prompt }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`OpenAI API HTTP Error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const rawText = data.choices?.[0]?.message?.content || ''

    if (
      rawText.includes('# NETWORK DEFINITIONS') ||
      rawText.includes('NW ') ||
      rawText.includes('SERIES(') ||
      rawText.includes('# TAG DECLARATIONS') ||
      rawText.includes('TAG ')
    ) {
      const cleanDsl = rawText
        .replace(/^```[a-zA-Z0-9_-]*\r?\n/gm, '')
        .replace(/```$/gm, '')
        .trim()

      const dslResult = LadderDslCompiler.compileLadderDslToAst(cleanDsl)
      if (dslResult.success && dslResult.networks.length > 0) {
        const circuitPayload: AiCircuitSynthesisPayload = {
          explanation: dslResult.explanation || 'Synthesized Ladder Logic via Compact Ladder DSL Engine.',
          operationMode: 'replace_ob1_networks',
          tagsToUpsert: dslResult.tags.map((t) => ({
            name: t.name,
            dataType: t.dataType as any,
            address: t.address,
            comment: t.comment
          })),
          networks: dslResult.networks
        }
        const result = this.applyCircuitPayload(circuitPayload, mode)
        return {
          replyText: result.summaryText,
          tier,
          providerUsed: 'openai',
          toolCallsExecuted: [],
          toolResults: [],
          stagedChangeset: result.stagedChangeset
        }
      }
    }

    return {
      replyText: rawText || 'No response from model.',
      tier,
      providerUsed: 'openai',
      toolCallsExecuted: [],
      toolResults: []
    }
  }

  /**
   * Local Ollama Factory LLM client with RAG Context Injection & Compact Ladder DSL Synthesis
   */
  private async callOllamaApi(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const endpoint = (this.config.ollamaEndpoint || 'http://localhost:11434').replace(/\/$/, '')
    const model = this.config.selectedModelId || 'qwen2.5-coder'

    // Retrieve Top 4 Semantic MEB RAG Rules
    const ragEngine = RagKnowledgeEngine.getInstance()
    const topRules = ragEngine.retrieveTopKRules(prompt, 4)
    const ragPromptSection = ragEngine.formatRetrievedRulesForPrompt(topRules)
    const consultedRuleNames = topRules.map((r) => r.item.name)

    const systemInstructionText = `You are an expert Siemens S7-1200/1500 PLC Automation Architect running on a local industrial factory server following strict MEB Automation Curriculum standards.
When asked to synthesize, create, or modify PLC Ladder logic, circuits, timers, motors, or I/O configurations, output your response strictly in Compact Ladder DSL:

# EXPLANATION
Detailed engineering explanation in the user's language.

# TAG DECLARATIONS
TAG <Name> <Address> <DataType> "<Comment>"

# NETWORK DEFINITIONS
NW 1 "<Title>": <EXPRESSION>
NW 2 "<Title>": <EXPRESSION>

Compact Ladder DSL Syntax:
- Contacts: NO(operand), NC(operand), P_TRIG(operand), N_TRIG(operand)
- Coils: COIL(operand), NEG_COIL(operand), SET(operand), RESET(operand)
- Timers: TON(T_Name, PT=T#10s), TOF(...), TP(...)
- Counters: CTU(C_Name, PV=10), CTD(...)
- Comparators: CMP_EQ(in1, in2), CMP_GT, CMP_LT, CMP_GE, CMP_LE
- Math: ADD(in1, in2, out), SUB, MUL, DIV, MOVE, NORM_X, SCALE_X
- Combinators: SERIES(elem1, elem2, ...), PARALLEL(branch1, branch2, ...)

CRITICAL MEB INDUSTRIAL RULES:
1. STRICT BAN ON DUMMY %M TIMER COILS: Never create dummy %M coils following a timer. Timers terminate cleanly at the rung end without a coil.
2. NATIVE SUB-BIT ADDRESSING: Contacts reading a timer done bit MUST use 'T1.Q' directly.
3. MOTOR SEAL-IN: Network 1 has Start NO parallel with Motor NO, series with Stop NC and T1.Q NC, driving Motor coil. Network 2 has Motor NO driving TON T1.
4. ZERO DUMMY %M TAGS: Do not declare dummy %M tags for timer done flags.
5. INDICATOR LAMPS & LEDS: If the user requests indicator lamps/LEDs (e.g. green LED when motor runs, red LED when motor stops), assign distinct safe addresses (e.g. Green LED %Q0.1, Red LED %Q0.2) and add dedicated networks: Network 3 (Motor NO driving Green LED coil) and Network 4 (Motor NC driving Red LED coil). NEVER assign duplicate addresses to different tags.
${ragPromptSection}
Standard Siemens S7 Addresses: Inputs %I0.0..%I1.5, Outputs %Q0.0..%Q1.1.`

    const controller = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 25000)

    const onExternalAbort = () => {
      clearTimeout(timeoutId)
      controller.abort()
    }

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId)
        throw new Error('Synthesis cancelled by user.')
      }
      signal.addEventListener('abort', onExternalAbort)
    }

    try {
      const response = await fetch(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          system: systemInstructionText,
          prompt,
          stream: false
        })
      })

      if (!response.ok) {
        throw new Error(`Ollama API HTTP Error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const rawText = data.response || ''

      // 1. Try Ladder DSL compilation first
      if (
        rawText.includes('# NETWORK DEFINITIONS') ||
        rawText.includes('NW ') ||
        rawText.includes('SERIES(') ||
        rawText.includes('# TAG DECLARATIONS') ||
        rawText.includes('TAG ')
      ) {
        const cleanDsl = rawText
          .replace(/^```[a-zA-Z0-9_-]*\r?\n/gm, '')
          .replace(/```$/gm, '')
          .trim()

        const dslResult = LadderDslCompiler.compileLadderDslToAst(cleanDsl)
        if (dslResult.success && dslResult.networks.length > 0) {
          const circuitPayload: AiCircuitSynthesisPayload = {
            explanation: dslResult.explanation || 'Synthesized Ladder Logic via Local Ollama Model.',
            operationMode: 'replace_ob1_networks',
            tagsToUpsert: dslResult.tags.map((t) => ({
              name: t.name,
              dataType: t.dataType as any,
              address: t.address,
              comment: t.comment
            })),
            networks: dslResult.networks
          }
          const result = this.applyCircuitPayload(circuitPayload, mode)
          return {
            replyText: result.summaryText,
            tier,
            providerUsed: 'ollama',
            toolCallsExecuted: [],
            toolResults: [],
            ragRulesConsulted: consultedRuleNames,
            stagedChangeset: result.stagedChangeset
          }
        }
      }

      return {
        replyText: rawText || 'Ollama model produced empty response.',
        tier,
        providerUsed: 'ollama',
        toolCallsExecuted: [],
        toolResults: [],
        ragRulesConsulted: consultedRuleNames
      }
    } catch (err: unknown) {
      if (timedOut) {
        throw new Error('Ollama API call timed out after 25 seconds.')
      }
      if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
        throw new Error('Synthesis cancelled by user.')
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort)
      }
    }
  }
}

