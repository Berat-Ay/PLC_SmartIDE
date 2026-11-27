/** Types shared by the AI router, the provider clients and the agent loop */

import { AgentToolCall, AgentToolResult } from './PlcAgentTools'
import { BehaviorTest } from './CircuitBehaviorTest'
import { AcceptanceGate, AcceptanceSummary } from '../scenarios/ScenarioAcceptance'
import { ProposedTag } from './TestFirst'
import { LadderNetwork } from '@shared/types/ladder'

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
  /** The model an OpenAI-compatible API is asked for. Kept apart from the Gemini models */
  openaiModel: string
  openaiModels: DiscoveredModel[]
  /** The model a local Ollama server is asked for. Kept apart from the Gemini models */
  ollamaModel?: string
  ollamaModels?: DiscoveredModel[]
  /** How long one model request may take. Long ladder answers need minutes */
  requestTimeoutSec: number
  /** The model writes the simulation test first; the user approves it before the circuit is written */
  testFirst: boolean
  /**
   * When the request is one of the built-in scenarios: show its acceptance result (report), also send failed
   * spec checks back to the model and undo the circuit (enforce), or do nothing (off). See AcceptanceGate.
   */
  acceptanceGate: AcceptanceGate
  /**
   * Ask only the selected model, and wait and ask it again when it is busy or rate limited, instead of
   * moving to another model. For measurements, where an answer from another model would be counted as its.
   */
  pinModel?: boolean
  /** Allow private RFC1918 LAN IP endpoints (10.x / 172.16-31.x / 192.168.x) for local Ollama/OpenAI servers */
  allowPrivateNetwork?: boolean
}

/** One message of the conversation with the model, in Gemini's form. The other clients convert it */
export interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

/** A tag that was given another address, because its own was taken */
export interface AddressMove {
  name: string
  from: string
  to: string
  takenBy: string
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
  /** Test first: a test that waits for the user's approval before the circuit is written */
  pendingTest?: { test: BehaviorTest; tags: ProposedTag[] }
  /** The acceptance result of the circuit this reply is about, when the request is a built-in scenario */
  acceptanceReport?: AcceptanceSummary
}

/** Explicit cancellation error thrown when an agent turn or HTTP call is aborted by the user. */
export class AgentCancelledError extends Error {
  public readonly isAgentCancelled = true
  constructor(message = 'Synthesis cancelled by user.') {
    super(message)
    this.name = 'AbortError'
  }
}

/** True only when the turn was aborted by an AbortSignal or explicit AbortError/AgentCancelledError. */
export function isAgentAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof AgentCancelledError) return true
  if (err && typeof err === 'object') {
    const rec = err as { name?: string; isAgentCancelled?: boolean }
    if (rec.isAgentCancelled) return true
    if (rec.name === 'AbortError') return true
  }
  return false
}
