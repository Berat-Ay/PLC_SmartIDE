/**
 * Rungline AI Model Router
 * Sends prompts to a real model: Gemini, an OpenAI-compatible API or a local Ollama server.
 * There is no built-in answer engine. Without a usable provider the agent reports an error.
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

export type AiProvider = 'gemini' | 'ollama' | 'openai'
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

const MAX_AGENT_ROUNDS = 6
const READ_ONLY_TOOLS = new Set(['read_project_overview', 'read_block'])
// What the model may call. Hardware, plant scripts, undo and deleting stay with the user.
const AGENT_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'manage_plc_tags',
  'create_or_update_udt',
  'create_or_update_db',
  'create_or_update_scl_block'
])

interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

interface AgentModelReply {
  explanation: string
  toolCalls: AgentToolCall[]
  circuit?: AiCircuitSynthesisPayload
  problems: string[]
  rawJson?: string
}

function hasEmptyNetwork(networks: AiCircuitSynthesisPayload['networks']): boolean {
  return networks.some((n) => !n.isSclNetwork && (n.nodes || []).length === 0)
}

function signalAborted(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError' || String(err).includes('cancelled')
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
  provider: 'gemini',
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

  private loadConfig(): AiConfig {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = { ...defaultAiConfig, ...JSON.parse(saved) }
        // Settings saved by older versions may name the removed offline engine
        if (!parsed.provider || parsed.provider === 'offline_local') parsed.provider = 'gemini'
        // Sanitize selectedModelId and availableModels: purge retired 1.5 and invalid 3.8
        if (parsed.provider === 'gemini') {
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
    if (normalizedNetworks.length === 0 || hasEmptyNetwork(normalizedNetworks)) {
      throw new Error('The model returned an empty network, so the project was not changed.')
    }
    if (mode === 'auto-apply') PlcAgentTools.getInstance().captureSnapshot()
    const tablesBefore = structuredClone(useTagStore.getState().tagTables)
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

        // A tag stays if anything outside OB1 mentions it, at any depth of a network or in SCL source.
        // A false match only keeps a tag, while a missed one would break that block.
        const blockState = useBlockStore.getState()
        const otherProgramText = [
          JSON.stringify(blockState.ladBlocks.filter((b) => !(b.blockType === 'OB' && b.blockNumber === 1) && b.name !== 'OB1_Main')),
          ...blockState.sclBlocks.map((b) => b.code)
        ]
          .join('\n')
          .toLowerCase()

        const currentTable = tagStore.tagTables.find((t) => t.id === tableId)
        if (currentTable) {
          const tagsToRemove = currentTable.tags.filter((t) => {
            const nameLower = t.name.toLowerCase()
            const addrLower = t.address.toLowerCase()
            if (newTagNames.has(nameLower) || newTagAddrs.has(addrLower)) return false
            if (otherProgramText.includes(nameLower) || otherProgramText.includes(addrLower)) return false
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

    // Diff-View changes nothing until it is approved, so tag edits become staged files too
    const stagedTags: NonNullable<AgentExecutionResponse['stagedChangeset']> = []
    if (mode === 'diff-view') {
      const tablesAfter = useTagStore.getState().tagTables
      for (const before of tablesBefore) {
        const after = tablesAfter.find((t) => t.id === before.id)
        if (!after || JSON.stringify(before) === JSON.stringify(after)) continue
        stagedTags.push({
          path: `/tags/${before.fileName || `${before.id}.tags.json`}`,
          title: `Tags: ${before.name}`,
          fileType: 'tag',
          beforeContent: JSON.stringify(before, null, 2),
          afterContent: JSON.stringify(after, null, 2)
        })
      }
      useTagStore.getState().setTagTables(tablesBefore)
    }

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
          ...stagedTags,
          {
            path: `blocks/${ob1.fileName}`,
            title: `OB1_Main (${payload.networks.length} Networks)`,
            fileType: 'lad',
            beforeContent: JSON.stringify(ob1, null, 2),
            afterContent: JSON.stringify({ ...ob1, networks: updatedNetworks }, null, 2)
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
The user message starts with the current project. You change it only through the fields below. Text alone changes nothing: never say something was created unless your reply contains the action that creates it.
Always answer with one JSON object in this form:

STRUCTURED JSON OUTPUT SCHEMA:
{
  "explanation": "Detailed engineering explanation in the user's language.",
  "toolCalls": [ { "tool": "<tool name>", "params": { } } ],
  "operationMode": "append_ob1_networks",
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

Ladder goes in "dsl" or "networks" and only ever changes OB1. Use only for ladder circuits; leave these fields out otherwise.
operationMode: "append_ob1_networks" adds to OB1 and is the default. Use "replace_ob1_networks" only when the user clearly asks to rewrite OB1, because it removes the existing networks.

TOOLS (put them in "toolCalls"; everything else, such as FBs, FCs, UDTs and DBs, can only be made this way):
- read_block { "name": "..." }: returns a block's source or networks. Read a block before changing it. You get the result in the next message.
- create_or_update_scl_block { "name": "FB_Valve", "sourceCode": "FUNCTION_BLOCK \"FB_Valve\"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nVAR_INPUT\n  Cmd : Bool;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK" }: an FB or FC. sourceCode is the full external source, and its name must match "name". You cannot add a new OB.
- create_or_update_udt { "name": "UDT_Valve", "fields": [ { "name": "Open", "dataType": "BOOL", "comment": "..." } ] }
- create_or_update_db { "name": "DB_Plant", "variables": [ { "name": "Level", "dataType": "REAL", "initialValue": "0.0", "comment": "..." } ] }: a global DB.
- manage_plc_tags { "action": "upsert", "tags": [ { "name": "Start", "dataType": "BOOL", "address": "%I0.0", "comment": "..." } ] }

Your whole reply is applied, then the project is compiled. If tools or the compiler report errors, everything from that reply is undone and you get the errors, so send the complete corrected answer again. If you cannot do something, say so in "explanation" instead of inventing a result.

COMPACT LADDER DSL SYNTAX (for the "dsl" field):
TAG <Name> <Address> <DataType> "<Comment>"
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
FIELD WIRING: A contact tests the input bit, not the physical button. A stop button wired normally closed reads 1 at rest, so it needs an NO contact in ladder. Use an NC contact for it only when the button is wired normally open. If the wiring is not stated, say which one you assumed.
6. PARKING GARAGE / BARRIER AUTOMATION:
   - Giris_Kart (%I0.0), Giris_Fotosel (%I0.1), Ust_Limit (%I0.2), Alt_Limit (%I0.3), Cikis_Fotosel (%I0.4)
   - Kapi_Yukari_Motor (%Q0.0), Kapi_Asagi_Motor (%Q0.1), Otopark_Dolu_Tabela (%Q0.2)
   - Use CTUD C1 (PV=10) with CU triggered by N_TRIG Giris_Fotosel, and CD triggered by Cikis_Fotosel.
   - Use TON T1 (PT=T#7s) for auto-close dwell after reaching Ust_Limit.
${ragPromptSection}
Standard Siemens S7 Addresses: Inputs %I0.0..%I1.5, Outputs %Q0.0..%Q1.1.
If the prompt is purely informational without ladder logic, provide an explanation directly.`

    const cleanKey = (this.config.geminiApiKey || '').trim()
    let attemptedAutoDiscovery = false

    const missingModels: string[] = []
    const requestModel = async (contents: GeminiContent[]): Promise<string> => {
      let rawText = ''
      let lastError: Error | null = null
      let successfulModel = ''

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
              contents,
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

            if (errStatus === 404) missingModels.push(cleanModelId)

            // Live Self-Healing Model Discovery on HTTP 404
            if (errStatus === 404 && !attemptedAutoDiscovery && cleanKey) {
              attemptedAutoDiscovery = true
              BlackBoxLogger.getInstance().log(
                'AI_FALLBACK_OR_RETRY',
                `HTTP 404 encountered for model ${cleanModelId}. Initiating live /v1beta/models auto-discovery...`,
                { model: cleanModelId }
              )
              try {
                const discRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
                  headers: { 'x-goog-api-key': cleanKey },
                  signal: modelController.signal
                })
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

      // A model the API no longer serves is not tried again on every request
      if (missingModels.includes(this.config.selectedModelId)) {
        this.config.selectedModelId = successfulModel
        this.saveConfig()
      }
      for (const missing of missingModels) {
        const index = candidateModels.indexOf(missing)
        if (index !== -1) candidateModels.splice(index, 1)
      }

      BlackBoxLogger.getInstance().log(
        'AI_RAW_RESPONSE',
        `Gemini API Response received from ${successfulModel} (${Date.now() - startMs}ms, ${rawText.length} chars)`,
        { model: successfulModel, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
      )
      return rawText
    }

    return this.runAgentTurn(prompt, tier, mode, isTurkish, consultedRuleNames, requestModel)
  }

  /** Reads one model reply. Problems go back to the model instead of reaching the project. */
  private interpretModelReply(rawText: string): AgentModelReply {
    const reply: AgentModelReply = { explanation: '', toolCalls: [], problems: [] }
    let dslErrors: string[] = []
    const fromDsl = (text: string): AiCircuitSynthesisPayload | undefined => {
      const compiled = LadderDslCompiler.compileLadderDslToAst(text)
      if (!compiled.success || compiled.networks.length === 0) {
        dslErrors = compiled.errors
        return undefined
      }
      return {
        explanation: compiled.explanation || '',
        operationMode: this.defaultCircuitMode(),
        tagsToUpsert: compiled.tags.map((t) => ({
          name: t.name,
          dataType: t.dataType as any,
          address: t.address,
          comment: t.comment
        })),
        networks: normalizeAiGeneratedNetworks(compiled.networks)
      }
    }

    const extracted = this.extractValidJsonBlock(rawText)
    if (extracted?.json && typeof extracted.json === 'object') {
      const parsed = extracted.json as Partial<AiCircuitSynthesisPayload> & { dsl?: unknown; toolCalls?: unknown }
      reply.explanation = typeof parsed.explanation === 'string' ? parsed.explanation : ''
      reply.rawJson = extracted.raw

      for (const call of Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []) {
        const tool = String(call?.tool)
        const params = call?.params && typeof call.params === 'object' ? call.params : {}
        const isAllowedTagAction = tool !== 'manage_plc_tags' || params.action === 'upsert'
        if (!AGENT_TOOLS.has(tool) || !isAllowedTagAction) {
          reply.problems.push(`Tool '${tool}' with these parameters is not available to you.`)
        } else {
          reply.toolCalls.push({ tool, params })
        }
      }

      if (typeof parsed.dsl === 'string' && parsed.dsl.trim()) {
        reply.circuit = fromDsl(parsed.dsl)
        if (!reply.circuit) reply.problems.push(`The "dsl" field did not compile: ${dslErrors.join('; ') || 'it has no networks'}`)
      } else if (Array.isArray(parsed.networks) && parsed.networks.length > 0) {
        reply.circuit = {
          explanation: '',
          operationMode: this.defaultCircuitMode(),
          tagsToUpsert: Array.isArray(parsed.tagsToUpsert) ? parsed.tagsToUpsert : [],
          networks: normalizeAiGeneratedNetworks(parsed.networks)
        }
      }
      if (reply.circuit) {
        reply.circuit.explanation = reply.explanation || reply.circuit.explanation || 'Synthesized Ladder Logic via Google Gemini.'
        if (parsed.operationMode === 'replace_ob1_networks' || parsed.operationMode === 'append_ob1_networks') {
          reply.circuit.operationMode = parsed.operationMode
        }
        if (hasEmptyNetwork(reply.circuit.networks)) {
          reply.circuit = undefined
          reply.problems.push('A network has no instructions. FBs, FCs and UDTs need tools, not networks.')
        }
      }
      return reply
    }

    const text = rawText.trim()
    if (text.startsWith('{') || text.startsWith('```')) {
      reply.problems.push('Your reply was not valid JSON and may have been cut off. Send a shorter, complete JSON object.')
      return reply
    }
    if (/^(# NETWORK DEFINITIONS|# TAG DECLARATIONS|NW \d|TAG )/m.test(text)) {
      reply.circuit = fromDsl(text)
      if (reply.circuit) {
        reply.explanation = reply.circuit.explanation
        reply.circuit.explanation = reply.explanation || 'Synthesized Ladder Logic via Compact Ladder DSL Engine.'
        return reply
      }
    }
    reply.explanation = text
    return reply
  }

  /**
   * Model, tools and compiler in a loop. A reply is applied as a whole and kept only if it compiles
   * without new errors. Otherwise the project goes back to where it was and the model gets the errors.
   */
  private async runAgentTurn(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    ragRulesConsulted: string[],
    requestModel: (contents: GeminiContent[]) => Promise<string>
  ): Promise<AgentExecutionResponse> {
    const tools = PlcAgentTools.getInstance()
    const turnStart = tools.takeSnapshot()
    const errorsBefore = new Set(tools.runCompilerVerification().errors)
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: `CURRENT PROJECT:\n${tools.describeProjectForModel()}\n\nUSER REQUEST:\n${prompt}` }] }
    ]
    const executed: AgentToolCall[] = []
    const toolResults: AgentToolResult[] = []
    let lastProblems: string[] = []
    let rawText = ''
    let rawJson: string | undefined

    const respond = (fields: Partial<AgentExecutionResponse> & { replyText: string }): AgentExecutionResponse => ({
      tier,
      providerUsed: 'gemini',
      toolCallsExecuted: executed,
      toolResults,
      ragRulesConsulted,
      rawTraceSnippet: rawText.substring(0, 300),
      rawJson,
      ...fields
    })

    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
      rawText = await requestModel(contents)
      contents.push({ role: 'model', parts: [{ text: rawText }] })
      const reply = this.interpretModelReply(rawText)
      rawJson = reply.rawJson

      if (reply.problems.length > 0) {
        lastProblems = reply.problems
        contents.push({ role: 'user', parts: [{ text: `Nothing was applied.\n${reply.problems.join('\n')}` }] })
        continue
      }

      const writes = reply.toolCalls.filter((c) => !READ_ONLY_TOOLS.has(c.tool))
      const changesProject = writes.length > 0 || reply.circuit !== undefined

      // Only reads: answer them and let the model go on
      if (reply.toolCalls.length > 0 && !changesProject) {
        const reads = await tools.executeToolBatch(reply.toolCalls, mode)
        executed.push(...reply.toolCalls)
        toolResults.push(...reads.results)
        contents.push({ role: 'user', parts: [{ text: `TOOL RESULTS:\n${JSON.stringify(reads.results)}` }] })
        continue
      }

      if (!changesProject) {
        const note = isTurkish ? 'Projede değişiklik yapılmadı.' : 'No changes were made to the project.'
        return respond({ replyText: `${reply.explanation || rawText}\n\n*${note}*` })
      }

      // Apply the whole reply
      const problems: string[] = []
      const lines: string[] = []
      const staged: NonNullable<AgentExecutionResponse['stagedChangeset']> = []
      if (mode === 'auto-apply') tools.holdDiskWrites()
      try {
        if (reply.toolCalls.length > 0) {
          const batch = await tools.executeToolBatch(reply.toolCalls, mode)
          executed.push(...reply.toolCalls)
          toolResults.push(...batch.results)
          staged.push(...(batch.stagedChangeset || []))
          for (const result of batch.results) {
            if (!result.success) problems.push(`${result.tool}: ${result.message}`)
            else if (!READ_ONLY_TOOLS.has(result.tool)) lines.push(`- ${result.message}`)
          }
        }
        if (reply.circuit && problems.length === 0) {
          const applied = this.applyCircuitPayload(reply.circuit, mode)
          lines.unshift(applied.summaryText)
          staged.push(...(applied.stagedChangeset || []))
        } else if (!reply.circuit && reply.explanation) {
          lines.unshift(reply.explanation, '')
        }

        if (mode === 'diff-view' && problems.length === 0) {
          const note = isTurkish
            ? 'Derleyici kontrolü onaydan sonra çalışır.'
            : 'The compiler check runs after you approve the changes.'
          return respond({ replyText: `${lines.join('\n')}\n\n*${note}*`, stagedChangeset: staged })
        }

        if (problems.length === 0) {
          const report = tools.runCompilerVerification()
          const newErrors = report.errors.filter((e) => !errorsBefore.has(e))
          problems.push(...newErrors)
          if (newErrors.length === 0) {
            tools.releaseDiskWrites()
            tools.setUndoSnapshot(turnStart)
            const older = report.errors.length
              ? ` ${report.errors.length} error(s) were already in the project before this change.`
              : ''
            return respond({
              replyText: `${lines.join('\n')}\n\n**Compiler:** no new errors, ${report.warnings.length} warning(s).${older}`,
              compilerVerification: { success: report.success, message: report.message }
            })
          }
        }
      } catch (err) {
        if (signalAborted(err)) {
          tools.discardDiskWrites()
          tools.restoreSnapshot(turnStart)
          throw err
        }
        problems.push(err instanceof Error ? err.message : String(err))
      }

      tools.discardDiskWrites()
      tools.restoreSnapshot(turnStart)
      lastProblems = problems
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Agent reply undone, round ${round + 1}`, { problems })
      contents.push({
        role: 'user',
        parts: [{ text: `Your reply was undone because of these errors. Send the complete corrected answer.\n${problems.join('\n')}` }]
      })
    }

    const details = lastProblems.map((p) => `- ${p}`).join('\n')
    return respond({
      replyText: isTurkish
        ? `Model ${MAX_AGENT_ROUNDS} denemede çalışan bir sonuç üretemedi. Projede değişiklik yapılmadı.\n\n${details}`
        : `The model did not reach a working result in ${MAX_AGENT_ROUNDS} attempts. The project was not changed.\n\n${details}`,
      isError: true,
      errorDetails: details
    })
  }

  /** Adding is the safe default: replacing is only for an empty OB1 or an explicit request. */
  private defaultCircuitMode(): AiCircuitSynthesisPayload['operationMode'] {
    const ob1 = useBlockStore.getState().ladBlocks.find((b) => (b.blockType === 'OB' && b.blockNumber === 1) || b.name === 'OB1_Main')
    const hasLogic = (ob1?.networks || []).some((n) => (n.nodes || []).length > 0)
    return hasLogic ? 'append_ob1_networks' : 'replace_ob1_networks'
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
          operationMode: this.defaultCircuitMode(),
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
            operationMode: this.defaultCircuitMode(),
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

