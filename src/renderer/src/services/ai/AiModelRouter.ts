/**
 * Rungline AI Model Router
 * Sends prompts to a real model: Gemini, an OpenAI-compatible API or a local Ollama server.
 * There is no built-in answer engine. Without a usable provider the agent reports an error.
 */

import { PlcAgentTools, AgentToolCall, AgentToolResult } from './PlcAgentTools'
import { useTagStore } from '../../stores/useTagStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { BehaviorTest, parseBehaviorTest, runBehaviorTest } from './CircuitBehaviorTest'
import { TagDefinition } from '@shared/types/tags'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { useBlockStore } from '../../stores/useBlockStore'
import { useUIStore } from '../../stores/useUIStore'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { LadderDslCompiler, DslCompilerOptions } from '../compiler/LadderDslCompiler'
import { RagKnowledgeEngine } from './RagKnowledgeEngine'
import { aiHttp } from './aiHttp'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { approvedTagsMoved, approvedTestRequest, formatTestForUser, ProposedTag, TEST_FIRST_REQUEST, validateTestProposal } from './TestFirst'
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
  /** The model an OpenAI-compatible API is asked for. Kept apart from the Gemini models */
  openaiModel: string
  openaiModels: DiscoveredModel[]
  /** How long one model request may take. Long ladder answers need minutes */
  requestTimeoutSec: number
  /** The model writes the simulation test first; the user approves it before the circuit is written */
  testFirst: boolean
}

const MAX_AGENT_ROUNDS = 6
const READ_ONLY_TOOLS = new Set(['read_project_overview', 'read_block', 'read_pattern'])

const LADDER_RULES = `LADDER RULES:
1. Read a timer or counter through its instance: T1.Q, T1.ET, C1.QU, C1.QD, C1.CV. A timer or counter box ends its rung, and a coil that only copies its Q adds nothing. Use %M bits freely for real program state, such as a running flag or a sequence step.
2. A timer whose own Q is in the path to its IN is TRUE for one scan only. Never use that to hold a lamp, a motor or a stage of a cycle. For a repeating cycle chain the timers and let the last one reset the first (pattern timer_ring).
3. Drive each output coil from one network. If two networks write the same coil, the last one wins.
4. FIELD WIRING: A contact tests the input bit, not the physical button. A stop button wired normally closed reads 1 at rest, so it needs an NO contact in ladder. Use an NC contact for it only when the button is wired normally open. If the wiring is not stated, assume normally closed and say so.
5. Give different signals different addresses.
6. A program does not replace hard-wired safety. Say so when a circuit has an emergency stop or contactors that must never close together.
7. Write a tag without quotes: NO(Start). A DB variable is "DB_Name".Variable, and the DB must exist or be created in the same reply.
8. SEQUENCES: networks run top to bottom in one scan, so a step SET in one network is already on in the networks below it. If the next step's condition is already true (a robot's "done/home" signal is 1 at rest), the sequence runs through several steps in one scan and the steps between never show. Make each transition wait for something that happens after its step started: the rising edge of the done signal (P_TRIG), or the signal going off and on again.

WHAT THIS IDE CANNOT DO: ladder cannot call an FB or FC (the DSL has no CALL), so an FB or FC you create is never executed. There is no motion control or technology object (servo, cam, axis), no safety program (F-CPU, F-blocks) and no way to add an OB or change the hardware. When a request needs one of these, build only what works without it and say plainly in "explanation" what was not done and why, in every reply, because the user sees only the last one. Never present a part that does not run as finished. A step that should wait for a missing block (MC_Home.Done, MC_MoveAbsolute.Done) still has to wait: stand in for that Done with a TON named after the move, for example TON(T_MovePick, PT=T#2S), and go on when its Q is on, so the sequence does not jump through the moves in one scan and the test can run through them.`
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

/** Test first: write the test (or correct it), or write the circuit to an approved test */
type TurnPlan =
  | { stage: 'test'; correctionOf?: { contents: GeminiContent[]; correction: string } }
  | { stage: 'circuit'; test: BehaviorTest; tags: ProposedTag[] }

const MAX_TEST_ROUNDS = 3

interface AgentModelReply {
  behaviorTest?: BehaviorTest
  explanation: string
  toolCalls: AgentToolCall[]
  circuit?: AiCircuitSynthesisPayload
  problems: string[]
  rawJson?: string
  /** Tags the DSL compiler gave another address */
  addressMoves?: AddressMove[]
}

/** Escapes line breaks, tabs and other control characters that stand inside JSON strings */
export function escapeControlCharsInJsonStrings(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        out += ch + (text[i + 1] ?? '')
        i++
        continue
      }
      if (ch === '"') inString = false
      else if (ch === '\n') {
        out += '\\n'
        continue
      } else if (ch === '\r') {
        out += '\\r'
        continue
      } else if (ch === '\t') {
        out += '\\t'
        continue
      } else if (ch.charCodeAt(0) < 0x20) {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
        continue
      }
    } else if (ch === '"') {
      inString = true
    }
    out += ch
  }
  return out
}

/** A tag that was given another address, because its own was taken */
interface AddressMove {
  name: string
  from: string
  to: string
  takenBy: string
}

const RESERVED_BYTE_OCCUPANT = 'CPU system or clock memory'

function walkLadder(nodes: LadderSeriesNode[] | undefined, visit: (n: LadderNode) => void): void {
  for (const node of nodes || []) {
    if (node.kind === 'parallel') node.branches.forEach((b) => walkLadder(b, visit))
    else visit(node)
  }
}

function listNames(names: string[], max = 12): string {
  return names.length > max ? `${names.slice(0, max).join(', ')} (+${names.length - max})` : names.join(', ')
}

/** I/O bit addresses written in the user's request, as %I0.0 / %Q1.2 */
function ioAddressesInPrompt(prompt: string): string[] {
  const found = new Set<string>()
  for (const m of prompt.matchAll(/(^|[^A-Za-z0-9_.%])%?([IQ])(\d{1,3})\.([0-7])(?![0-9])/gi)) {
    found.add(`%${m[2].toUpperCase()}${Number(m[3])}.${m[4]}`)
  }
  return Array.from(found)
}

/** The text of a streamed (server-sent events) chat answer, or null when the body is not a stream */
export function readStreamedChat(body: string): { text: string | null; error?: string } {
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

function countExpectations(test: BehaviorTest): number {
  return test.steps.reduce((sum, step) => sum + Object.keys(step.expect || {}).length, 0)
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
  /** Test first: a test that waits for the user's approval before the circuit is written */
  pendingTest?: { test: BehaviorTest; tags: ProposedTag[] }
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
  language: 'auto',
  openaiModel: '',
  openaiModels: [],
  requestTimeoutSec: 180,
  testFirst: false
}

// Newer versions first. At one version: flash, then pro (slow), then flash-lite (weakest); a release before its preview
function geminiModelRank(id: string): number[] | null {
  const m = id
    .toLowerCase()
    .replace(/^models\//, '')
    .match(/^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)(.*)$/)
  if (!m) return null
  const family = m[2] === 'flash' ? 0 : m[2] === 'pro' ? 1 : 2
  const release = m[3] === '' ? 0 : /preview|exp/.test(m[3]) ? 2 : 1
  return [-parseFloat(m[1]), family, release]
}

export function sortGeminiModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const ra = geminiModelRank(a.id)
    const rb = geminiModelRank(b.id)
    if (ra && rb) {
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
    } else if (ra) {
      return -1
    } else if (rb) {
      return 1
    }
    return a.id.localeCompare(b.id)
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
  /** Models that cannot answer this key until the app restarts: no quota at all on this plan, or no longer served */
  private unavailableModels = new Map<string, string>()
  /** How long one model may take to answer before the next one is tried */
  private modelTimeoutMs = 180000
  // Tags the last applied circuit could not keep at the address the model gave
  private lastAddressMoves: AddressMove[] = []
  /** Test first: the test the user has not approved yet, with the conversation that made it */
  private pendingTest?: { prompt: string; tier: AiTier; test: BehaviorTest; tags: ProposedTag[]; contents: GeminiContent[] }
  /** What the next agent turn does. Set by executePrompt and approvePendingTest, read once by runAgentTurn */
  private turnPlan?: TurnPlan
  // Models that answer HTTP 400 to thinkingConfig
  private noThinkingConfig = new Set<string>()
  private config: AiConfig

  private constructor() {
    this.config = this.loadConfig()
    this.modelTimeoutMs = (this.config.requestTimeoutSec || 180) * 1000
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
            parsed.selectedModelId.includes('1.5')
          ) {
            parsed.selectedModelId = 'gemini-2.5-flash'
          }
          if (Array.isArray(parsed.availableModels)) {
            parsed.availableModels = parsed.availableModels.filter((m: { id: string }) =>
              isStrictGeminiTextModel(m.id) && !m.id.includes('1.5')
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
      const endpoint = this.openAiBaseUrl()
      try {
        const res = await aiHttp(`${endpoint}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key.trim()}` },
          timeoutMs: 30000
        })
        if (res.error) throw new Error(`Could not reach ${endpoint}: ${res.message}`)
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`HTTP ${res.status} from ${endpoint}/models: ${this.apiErrorMessage(res.body) || res.statusText}`)
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

  /**
   * Removes a plain %M coil that only copies a timer's or counter's Q, and reads the instance bit instead.
   * Other coil types stay: a SET coil latches and a negated coil inverts, so they are not the same as Q.
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

        if (
          (current.kind === 'timer' || current.kind === 'counter') &&
          next?.kind === 'coil' &&
          (next as LadderCoilNode).coilType === 'OUTPUT_COIL'
        ) {
          const t = current as LadderTimerNode | LadderCounterNode
          const c = next as LadderCoilNode
          const declared = (payload.tagsToUpsert || []).find((tag) => tag.name.toLowerCase() === c.operand.toLowerCase())
          if (/^%?[IQ]/i.test(c.address || declared?.address || '')) {
            newNodes.push(current)
            continue
          }
          const instName = t.instanceDb || (current.kind === 'timer' ? 'T1' : 'C1')
          const countsDown = current.kind === 'counter' && (current as LadderCounterNode).counterType === 'CTD'
          const nativeBit = current.kind === 'timer' ? `${instName}.Q` : `${instName}.${countsDown ? 'QD' : 'QU'}`

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

    // 3. Drop the tags of the coils removed above
    const cleanedTags = (payload.tagsToUpsert || []).filter(
      (tag) => !strippedCoilMap.has(tag.name.toLowerCase()) && !strippedCoilMap.has(tag.address.toLowerCase())
    )

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
    const strict = this.extractStrictJsonBlock(text)
    if (strict) return strict
    // Models often write real line breaks inside a JSON string (the "dsl" text). JSON forbids them, but the
    // reply is complete: escape them and read it again
    const repaired = escapeControlCharsInJsonStrings(text)
    return repaired === text ? null : this.extractStrictJsonBlock(repaired)
  }

  private extractStrictJsonBlock(text: string): { json: any; raw: string } | null {

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
    existingTags: Array<{ id: string; name: string; address: string; dataType: string }> = [],
    reservedMerkerBytes: number[] = []
  ): {
    tags: Array<{ name: string; dataType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME'; address: string; comment?: string }>
    networks: LadderNetwork[]
    moved: AddressMove[]
  } {
    const moved: AddressMove[] = []
    const usedAddresses = new Map<string, string>() // normalizedAddr -> tagName
    const addressRewrites = new Map<string, string>() // oldNormalizedAddr -> newNormalizedAddr
    const nameToAddressMap = new Map<string, string>() // tagName.toLowerCase() -> newNormalizedAddr

    for (const byte of reservedMerkerBytes) {
      for (let bit = 0; bit < 8; bit++) usedAddresses.set(`%M${byte}.${bit}`, RESERVED_BYTE_OCCUPANT)
    }

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
        moved.push({ name: tag.name, from: formattedAddr, to: safeAddr, takenBy: existingOccupant })
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
      networks: rewiredNetworks,
      moved
    }
  }

  /** Merker bytes the configured CPU writes itself. */
  private reservedMerkerBytes(): number[] {
    const config = useHardwareStore.getState().config
    const bytes: number[] = []
    if (config?.clockMemory?.enabled) bytes.push(config.clockMemory.byteAddress)
    if (config?.systemMemory?.enabled) bytes.push(config.systemMemory.byteAddress)
    return bytes
  }

  /**
   * Replacing OB1 removes the tags only OB1 used, so their addresses are free for the new program.
   * A tag stays if it is in another table or anything outside OB1 mentions it, at any depth of a network or
   * in SCL source. A false match only keeps a tag, while a missed one would break that block.
   */
  private tagsKeptWhenReplacingOb1(): TagDefinition[] {
    const { tagTables } = useTagStore.getState()
    const blocks = useBlockStore.getState()
    const otherProgramText = [
      JSON.stringify(blocks.ladBlocks.filter((b) => !(b.blockType === 'OB' && b.blockNumber === 1) && b.name !== 'OB1_Main')),
      ...blocks.sclBlocks.map((b) => b.code)
    ]
      .join('\n')
      .toLowerCase()
    return tagTables.flatMap((table, index) =>
      table.tags.filter(
        (t) => index > 0 || otherProgramText.includes(t.name.toLowerCase()) || otherProgramText.includes(t.address.toLowerCase())
      )
    )
  }

  private dslOptions(operationMode: AiCircuitSynthesisPayload['operationMode'] = this.defaultCircuitMode()): DslCompilerOptions {
    const allTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
    const reservedMerkerBytes = this.reservedMerkerBytes()
    if (operationMode !== 'replace_ob1_networks') return { existingTags: allTags, reservedMerkerBytes }
    const keptTags = this.tagsKeptWhenReplacingOb1()
    return { keptTags, releasedTags: allTags.filter((t) => !keptTags.includes(t)), reservedMerkerBytes }
  }

  /** Adds the JSON tag list to the DSL text as TAG lines. A tag already declared in the DSL wins. */
  private dslWithDeclaredTags(dsl: string, tags: unknown): string {
    if (!Array.isArray(tags)) return dsl
    const inDsl = new Set(Array.from(dsl.matchAll(/^\s*TAG\s+(\S+)/gim)).map((m) => m[1].toLowerCase()))
    const lines = tags
      .filter(
        (t) =>
          typeof t?.name === 'string' &&
          typeof t?.address === 'string' &&
          t.address.trim() &&
          /^[A-Za-z]*$/.test(String(t.dataType || '')) &&
          !inDsl.has(t.name.toLowerCase())
      )
      .map((t) => `TAG ${t.name} ${t.address} ${t.dataType || 'BOOL'} "${String(t.comment || '').replace(/["\r\n]/g, ' ')}"`)
    return [...lines, dsl].join('\n')
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
    const normalizedNetworks = normalizeAiGeneratedNetworks(payload.networks || [])
    if (normalizedNetworks.length === 0 || hasEmptyNetwork(normalizedNetworks)) {
      throw new Error('The model returned an empty network, so the project was not changed.')
    }
    if (mode === 'auto-apply' && !options.trialRun) PlcAgentTools.getInstance().captureSnapshot()
    const tablesBefore = structuredClone(useTagStore.getState().tagTables)
    const effectivePayload = this.optimizeAndCleanGeneratedAst({
      ...payload,
      networks: normalizedNetworks
    })
    const isReplacing = effectivePayload.operationMode === 'replace_ob1_networks'
    // The new networks may use an existing tag by name without declaring it again, as the DSL may.
    // Such a tag stays, and keeps its address, when OB1 is replaced. Titles and comments are words, not uses of a tag
    const newProgramText = JSON.stringify(effectivePayload.networks || [], (key, value) =>
      key === 'title' || key === 'comment' ? undefined : value
    )
    const namesInNewProgram = new Set((newProgramText.match(/[\p{L}_][\p{L}\p{N}_]*/gu) || []).map((w) => w.toLowerCase()))
    const usedByNewProgram = (name: string): boolean => namesInNewProgram.has(name.toLowerCase())
    const allLiveTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
    const existingLiveTags = isReplacing ? allLiveTags.filter((t) => usedByNewProgram(t.name)) : allLiveTags
    const sanitized = AiModelRouter.sanitizeAndAllocateUniqueAddresses(
      effectivePayload.tagsToUpsert || [],
      effectivePayload.networks || [],
      existingLiveTags,
      this.reservedMerkerBytes()
    )
    effectivePayload.tagsToUpsert = sanitized.tags
    effectivePayload.networks = sanitized.networks
    this.lastAddressMoves = sanitized.moved
    const tagsCreatedNames: string[] = []

    // 1. Upsert Tags (and prune orphaned tags on replacement)
    try {
      const tagStore = useTagStore.getState()
      const tableId = tagStore.tagTables[0]?.id || 'tbl_default'
      const existingTags = tagStore.tagTables.flatMap((t) => t.tags)

      // Prune orphaned tags if completely replacing OB1 networks to prevent collision duplicates (%Q0.0, %I0.0)
      if (effectivePayload.operationMode === 'replace_ob1_networks') {
        const newTagNames = new Set((effectivePayload.tagsToUpsert || []).map((t) => t.name.toLowerCase()))
        const kept = new Set(this.tagsKeptWhenReplacingOb1())
        const currentTable = tagStore.tagTables.find((t) => t.id === tableId)
        if (currentTable) {
          const tagsToRemove = currentTable.tags.filter(
            (t) => !newTagNames.has(t.name.toLowerCase()) && !kept.has(t) && !usedByNewProgram(t.name)
          )
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
        if (!options.trialRun) {
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
            ? `API hatası (${this.openAiBaseUrl()}): ${errMsg}. Projede değişiklik yapılmadı.`
            : `API error (${this.openAiBaseUrl()}): ${errMsg}. The project was not changed.`,
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

  /** The system instruction of the agent loop, the same for every provider that runs it */
  private buildAgentInstruction(prompt: string): { text: string; consultedRuleNames: string[] } {
    const ragEngine = RagKnowledgeEngine.getInstance()
    const topRules = ragEngine.retrieveTopKRules(prompt, 3)
    const ragPromptSection = ragEngine.formatRetrievedRulesForPrompt(topRules)
    const consultedRuleNames = topRules.map((r) => r.item.name)

    const systemInstructionText = `You are an expert Siemens S7-1200/1500 PLC programmer in the Rungline IDE.
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
  "dsl": "optional Compact Ladder DSL text",
  "verification": { "steps": [ ] }
}

Ladder goes in "dsl" or "networks" and only ever changes OB1. Use only for ladder circuits; leave these fields out otherwise.
operationMode: "append_ob1_networks" adds to OB1 and is the default. Use "replace_ob1_networks" only when the user clearly asks to rewrite OB1, because it removes the existing networks.

TOOLS (put them in "toolCalls"; everything else, such as FBs, FCs, UDTs and DBs, can only be made this way):
- read_block { "name": "..." }: returns a block's source or networks. Read a block before changing it. You get the result in the next message.
- read_pattern { "id": "..." }: returns a circuit pattern with its timeline and pitfalls, from the list below.
- create_or_update_scl_block { "name": "FB_Valve", "sourceCode": "FUNCTION_BLOCK \"FB_Valve\"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nVAR_INPUT\n  Cmd : Bool;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK" }: an FB or FC. sourceCode is the full external source, and its name must match "name". You cannot add a new OB.
- create_or_update_udt { "name": "UDT_Valve", "fields": [ { "name": "Open", "dataType": "BOOL", "comment": "..." } ] }
- create_or_update_db { "name": "DB_Plant", "variables": [ { "name": "Level", "dataType": "REAL", "initialValue": "0.0", "comment": "..." } ] }: a global DB.
- manage_plc_tags { "action": "upsert", "tags": [ { "name": "Start", "dataType": "BOOL", "address": "%I0.0", "comment": "..." } ] }

Your whole reply is applied, compiled and run on the simulator. If tools, the compiler or the test report errors, everything from that reply is undone and you get the errors, so send the complete corrected answer again. If you cannot do something, say so in "explanation" instead of inventing a result.

SIMULATION TEST ("verification"): every ladder circuit needs one. It says what the circuit must do over time, starting from the moment the CPU goes to RUN with all inputs at 0:
"verification": { "steps": [
  { "atMs": 0, "set": { "Stop": true } },
  { "atMs": 100, "set": { "Start": true } },
  { "atMs": 300, "set": { "Start": false }, "expect": { "Motor": true } },
  { "atMs": 5300, "expect": { "Motor": false } }
] }
- "set" changes inputs only. An NC-wired stop button is 1 at rest, so set it to true at the start.
- "expect" can read tags and instance bits such as T1.Q. Check 200 ms or more away from a timer's expiry.
- Follow the behaviour the user described, not your circuit: cover the whole cycle, at least one repeat of a cycle, and stopping.
- If it fails you get the real timeline of the program. Find the cause in the circuit before changing anything. Do not change the expected behaviour to match a wrong circuit.

COMPACT LADDER DSL SYNTAX (for the "dsl" field):
TAG <Name> <Address> <DataType> "<Comment>"
NW 1 "<Title>": <EXPRESSION>
NW 2 "<Title>": <EXPRESSION>

DSL Elements:
- Contacts: NO(operand), NC(operand), P_TRIG(operand), N_TRIG(operand), each with one value. P_TRIG and N_TRIG keep their own edge memory
- Coils: COIL(operand), NEG_COIL(operand), SET(operand), RESET(operand), each with one value
- Timers: TON(T_Name, PT=T#10s), TOF(...), TP(...)
- Counters: CTU(C_Name, PV=10), CTD(...), CTUD(C_Name, PV=10, CD=...)
- Comparators: CMP_EQ(in1, in2), CMP_NE, CMP_GT, CMP_LT, CMP_GE, CMP_LE. Add REAL as a third value to compare REALs
- Math: ADD(in1, in2, out), SUB, MUL, DIV with the same three values; MOVE(in, out) with two; NORM_X(value, min, max, out) and SCALE_X(value, min, max, out) with four
- Combinators: SERIES(elem1, elem2, ...), PARALLEL(branch1, branch2, ...)

${LADDER_RULES}

CIRCUIT PATTERNS you can read with read_pattern:
${ragEngine.patternCatalogForPrompt()}
${ragPromptSection}
The current project lists this CPU's inputs, outputs, clock memory and system memory. Use those.
Give every new tag its address, either as a TAG line in "dsl" or in "tagsToUpsert". A tag that already exists keeps its address if you do not declare it again. Never use the CPU's clock or system memory bytes for your own bits.
If the prompt is purely informational without ladder logic, provide an explanation directly.`
    return { text: systemInstructionText, consultedRuleNames }
  }

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
      ...sortGeminiModels(this.config.availableModels || [])
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

    const { text: systemInstructionText, consultedRuleNames } = this.buildAgentInstruction(prompt)

    const cleanKey = (this.config.geminiApiKey || '').trim()
    let attemptedAutoDiscovery = false

    const missingModels: string[] = []
    const requestModel = async (contents: GeminiContent[]): Promise<string> => {
      let rawText = ''
      let lastError: Error | null = null
      let successfulModel = ''
      let modelStartMs = Date.now()

      const usable = candidateModels.filter((m) => !this.unavailableModels.has(m) && !failedThisTurn.has(m))
      // When every model has failed once, try them again rather than give up without a request
      const queue = usable.length > 0 ? usable : candidateModels.filter((m) => !this.unavailableModels.has(m))
      if (queue.length === 0) {
        const reasons = Array.from(this.unavailableModels.entries()).map(([m, why]) => `${m}: ${why}`)
        throw new Error(`No Gemini model can answer with this key. ${reasons.join('; ')}`)
      }
      for (let i = 0; i < queue.length; i++) {
        const modelToTry = queue[i]
        if (signal?.aborted) throw new Error('Synthesis cancelled by user.')

        const cleanModelId = modelToTry.trim().replace(/^models\//i, '')
        const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}:generateContent`
        modelStartMs = Date.now()

        // Fresh 90-second timeout controller per candidate model attempt
        const modelController = new AbortController()
        let modelTimedOut = false
        const modelTimeoutId = setTimeout(() => {
          modelTimedOut = true
          modelController.abort()
        }, this.modelTimeoutMs)

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
          const sendThinking = !this.noThinkingConfig.has(cleanModelId)
          let response = await attemptFetch(sendThinking)

          // If HTTP 400 occurred and thinkingConfig was passed, retry once without thinkingConfig
          if (response.status === 400 && sendThinking) {
            const errBody = await response.text()
            BlackBoxLogger.getInstance().log(
              'AI_FALLBACK_OR_RETRY',
              `Candidate model ${cleanModelId} rejected thinkingConfig (HTTP 400). Retrying without thinkingConfig...`,
              { model: cleanModelId, status: 400, errorBody: errBody }
            )
            response = await attemptFetch(false)
            if (response.ok) this.noThinkingConfig.add(cleanModelId)
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

            if (errStatus === 404) {
              missingModels.push(cleanModelId)
              this.unavailableModels.set(cleanModelId, 'not served (HTTP 404)')
            } else if (errStatus === 429 && /limit:\s*0\b/.test(errorBodyText)) {
              // The plan has no quota for this model at all. Waiting will not help
              this.unavailableModels.set(cleanModelId, 'no quota on this plan (HTTP 429, limit 0)')
            } else if (errStatus !== 503 && errStatus !== 429) {
              // Busy (503) and rate limited (429) pass, so the next round asks this model again
              failedThisTurn.add(cleanModelId)
            }

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
                        if (!this.unavailableModels.has(dm.id)) queue.push(dm.id)
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
          failedThisTurn.add(cleanModelId)
        } catch (fetchErr: unknown) {
          if (
            signal?.aborted ||
            (fetchErr as { name?: string })?.name === 'AbortError' ||
            String(fetchErr).includes('cancelled')
          ) {
            if (modelTimedOut && !signal?.aborted) {
              // A slow model is no reason to stop: the next one may answer
              failedThisTurn.add(cleanModelId)
              lastError = new Error(`Gemini API call to model ${cleanModelId} timed out after ${this.modelTimeoutMs / 1000} seconds.`)
              BlackBoxLogger.getInstance().log(
                'AI_FALLBACK_OR_RETRY',
                `Candidate model ${cleanModelId} timed out after ${this.modelTimeoutMs / 1000} s. Trying the next one`,
                { model: cleanModelId }
              )
              continue
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
          candidateModels: queue,
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
        `Gemini API Response received from ${successfulModel} (${Date.now() - modelStartMs}ms, ${rawText.length} chars)`,
        { model: successfulModel, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
      )
      return rawText
    }

    return this.runAgentTurn(prompt, tier, mode, isTurkish, consultedRuleNames, requestModel)
  }

  /** Reads one model reply. Problems go back to the model instead of reaching the project. */
  private interpretModelReply(rawText: string, ignoreVerification = false): AgentModelReply {
    const reply: AgentModelReply = { explanation: '', toolCalls: [], problems: [] }
    let dslErrors: string[] = []
    const fromDsl = (text: string, operationMode = this.defaultCircuitMode()): AiCircuitSynthesisPayload | undefined => {
      const compiled = LadderDslCompiler.compileLadderDslToAst(text, this.dslOptions(operationMode))
      if (!compiled.success || compiled.networks.length === 0) {
        dslErrors = compiled.errors
        return undefined
      }
      reply.addressMoves = compiled.addressMoves
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
      const parsed = extracted.json as Partial<AiCircuitSynthesisPayload> & {
        dsl?: unknown
        toolCalls?: unknown
        verification?: unknown
      }
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

      // Models sometimes put the DSL inside a network. With no nodes beside it, it is still the DSL
      if (!(typeof parsed.dsl === 'string' && parsed.dsl.trim()) && Array.isArray(parsed.networks)) {
        const rawNetworks = parsed.networks as Array<{ dsl?: unknown; nodes?: unknown }>
        const nested = rawNetworks.map((n) => (typeof n?.dsl === 'string' ? n.dsl.trim() : '')).filter(Boolean)
        const noNodes = rawNetworks.every((n) => !Array.isArray(n?.nodes) || n.nodes.length === 0)
        if (nested.length > 0 && noNodes) parsed.dsl = nested.join('\n')
      }
      if (typeof parsed.dsl === 'string' && parsed.dsl.trim()) {
        reply.circuit = fromDsl(this.dslWithDeclaredTags(parsed.dsl, parsed.tagsToUpsert), parsed.operationMode)
        if (!reply.circuit) reply.problems.push(`The "dsl" field did not compile: ${dslErrors.join('; ') || 'it has no networks'}`)
      } else if (Array.isArray(parsed.networks) && parsed.networks.length > 0) {
        reply.circuit = {
          explanation: '',
          operationMode: this.defaultCircuitMode(),
          tagsToUpsert: Array.isArray(parsed.tagsToUpsert) ? parsed.tagsToUpsert : [],
          networks: normalizeAiGeneratedNetworks(parsed.networks)
        }
      }
      // With an approved test the model's own test is not read: it could not change anything
      if (parsed.verification !== undefined && !ignoreVerification) {
        const verification = parseBehaviorTest(parsed.verification)
        reply.behaviorTest = verification.test
        reply.problems.push(...verification.problems)
      }
      if (reply.circuit) {
        reply.circuit.explanation = reply.explanation || reply.circuit.explanation || 'Synthesized Ladder Logic via Google Gemini.'
        if (parsed.operationMode === 'replace_ob1_networks' || parsed.operationMode === 'append_ob1_networks') {
          reply.circuit.operationMode = parsed.operationMode
        }
        if (hasEmptyNetwork(reply.circuit.networks)) {
          reply.circuit = undefined
          reply.problems.push(
            'A network has no instructions: its "nodes" is empty. Write the ladder in "nodes", or in the top-level "dsl" field and leave "networks" out. FBs, FCs and UDTs need tools, not networks.'
          )
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
   * Runs the reply's test on the project as it stands now. A wrong behaviour always goes back to the model.
   * A missing test or a very short output pulse is raised once, and accepted with a note if the model repeats it.
   */
  private checkCircuitBehavior(
    test: BehaviorTest | undefined,
    askedOnce: Set<string>,
    isTurkish: boolean,
    circuit?: AiCircuitSynthesisPayload,
    /** The user approved the test, so how much it checks is not the model's to answer for */
    approvedTest = false
  ): { problems: string[]; note: string } {
    const askOnce = (kind: string, problems: string[], note: string): { problems: string[]; note: string } => {
      if (askedOnce.has(kind)) return { problems: [], note }
      askedOnce.add(kind)
      return { problems, note: '' }
    }

    if (!test) {
      return askOnce(
        'missing test',
        ['A ladder circuit needs a "verification" timeline, so it can be run on the simulator. Send the complete answer with one.'],
        isTurkish
          ? '**Simülasyon testi:** Model test göndermedi, devrenin davranışı doğrulanmadı.'
          : '**Simulation test:** The model sent no test, so the behaviour was not verified.'
      )
    }

    const blocks = useBlockStore.getState()
    const metadata = useProjectStore.getState().metadata
    const result = runBehaviorTest(test, {
      projectPath: metadata?.projectPath || '',
      metadata,
      hardware: useHardwareStore.getState().config,
      tagTables: useTagStore.getState().tagTables,
      udts: blocks.udts,
      dataBlocks: blocks.dataBlocks,
      ladBlocks: blocks.ladBlocks,
      sclBlocks: blocks.sclBlocks
    } as ProjectLoadPayload)
    BlackBoxLogger.getInstance().log('AI_PARSE_AND_AST_INJECTION', `Simulation test: ${result.checks} checks, ${result.failures.length} failed`, {
      failures: result.failures,
      pulses: result.pulses,
      timeline: result.timeline
    })

    const whatHappened = result.timeline ? [`What the program really did:\n${result.timeline}`] : []
    // A test cannot set it and no rung writes it, so every rung that needs it is dead
    const unwritten = circuit ? this.readsNothingWrites(circuit.networks) : []
    if (result.failures.length > 0) {
      // A dead read is often why the test failed (an edge contact on a bit nothing writes never fires)
      const deadReads = unwritten.length
        ? [`Your circuit reads ${unwritten.join(', ')}, but nothing in OB1 writes it, so the rungs that need it never work. P_TRIG and N_TRIG take the signal itself: P_TRIG(Signal).`]
        : []
      // A value that arrives a scan or two after the check is a matter of timing, not of a wrong circuit
      const late = result.failures.some((f) => f.includes('scan(s) later'))
      const lateAdvice = !late
        ? []
        : approvedTest
          ? ['Some values come one or a few scans later than the approved test expects. Make the circuit set them sooner: a value written in a network below the one that needs it, or through an extra step bit, lags a scan.']
          : ['Some values come one or a few scans late. If that delay is right, check this value later in the test and keep the circuit.']
      return {
        problems: [`The simulation test failed:`, ...result.failures, ...lateAdvice, ...result.pulses, ...deadReads, ...whatHappened],
        note: ''
      }
    }
    if (unwritten.length > 0 && !askedOnce.has('unwritten read')) {
      askedOnce.add('unwritten read')
      return {
        problems: [
          `Your circuit reads ${unwritten.join(', ')}, but nothing in OB1 writes it and a test cannot set it, so the rungs that need it never work. Write it from the logic, or use an input (%I) tag for a signal that comes from outside. If an HMI or another device really writes it, send the same answer again.`,
          ...whatHappened
        ],
        note: ''
      }
    }
    // A test that passes but checks almost nothing shows nothing
    const checked = new Set(
      test.steps.flatMap((step) => Object.keys(step.expect || {})).map((k) => k.replace(/"/g, '').trim().toLowerCase())
    )
    const writtenNames = new Set<string>()
    const untested: string[] = []
    let untestedOutput = false
    for (const net of circuit?.networks || []) {
      walkLadder(net.nodes, (n) => {
        if (n.kind !== 'coil' || !n.operand) return
        const name = n.operand.replace(/"/g, '').trim()
        writtenNames.add(name.toLowerCase())
        if (checked.has(name.toLowerCase()) || checked.has((n.address || '').trim().toLowerCase())) return
        if (/^%Q/i.test((n.address || '').trim())) untestedOutput = true
        if (!untested.includes(name)) untested.push(name)
      })
    }
    // An internal bit the outputs already show need not be checked. An output nobody looks at, or a test that
    // looks at a few values of many, is thin
    const thinTest =
      untestedOutput || (writtenNames.size >= 4 && (writtenNames.size - untested.length) * 3 < writtenNames.size)
    if (!thinTest) untested.length = 0
    if (untested.length > 0 && !approvedTest && !askedOnce.has('untested writes')) {
      askedOnce.add('untested writes')
      return {
        problems: [
          `Your test passed, but it never checks ${listNames(untested, 30)}, which your circuit writes. A test that checks ${result.checks} value(s) does not show the circuit does what the user asked. Run the timeline through the whole behaviour (every step, every output, the fault, E-stop and reset paths) and expect these values on the way. If some of them really cannot be checked, send the same answer again.`,
          ...whatHappened
        ],
        note: ''
      }
    }
    const untestedNote = untested.length
      ? isTurkish
        ? `\n\n**Test kapsamı:** Test şunları hiç kontrol etmedi: ${listNames(untested)}. Bunların davranışı doğrulanmadı.`
        : `\n\n**Test coverage:** The test never checked ${listNames(untested)}. Their behaviour was not verified.`
      : ''
    const unwrittenNote = unwritten.length
      ? isTurkish
        ? `\n\n**Uyarı:** ${unwritten.join(', ')} okunuyor ama OB1'de hiçbir şey yazmıyor. HMI veya başka bir cihaz yazmazsa bunlara bağlı satırlar hiç çalışmaz ve test edilmedi.`
        : `\n\n**Warning:** ${unwritten.join(', ')} is read but nothing in OB1 writes it. Unless an HMI or another device writes it, the rungs that need it never work, and they were not tested.`
      : ''
    const passed =
      (isTurkish
        ? `**Simülasyon testi${approvedTest ? ' (onaylı)' : ''}:** ${result.checks} kontrolün hepsi geçti.`
        : `**Simulation test${approvedTest ? ' (approved)' : ''}:** all ${result.checks} checks passed.`) +
      untestedNote +
      unwrittenNote
    if (result.pulses.length > 0) {
      const asked = askOnce(
        'short pulse',
        [
          ...result.pulses,
          'A timer whose own Q output resets its IN gives a one-scan pulse. Fix the circuit. If such a short pulse is really wanted, send the same answer again.',
          ...whatHappened
        ],
        `${passed}\n\n${result.pulses.map((p) => `- ${p}`).join('\n')}`
      )
      return asked
    }
    return { problems: [], note: passed }
  }

  /**
   * Values the new networks read that are not inputs, constants or system bits, and that no rung of OB1 writes.
   * S7 allows them (an HMI may write them), so the model is asked about them, not stopped.
   */
  private readsNothingWrites(newNetworks: LadderNetwork[]): string[] {
    const key = (op: string | undefined): string => (op || '').replace(/"/g, '').trim().toLowerCase()
    const walk = (nodes: LadderSeriesNode[] | undefined, visit: (n: LadderNode) => void): void => {
      for (const node of nodes || []) {
        if (node.kind === 'parallel') node.branches.forEach((b) => walk(b, visit))
        else visit(node)
      }
    }

    const tags = new Map(useTagStore.getState().tagTables.flatMap((t) => t.tags).map((t) => [t.name.toLowerCase(), t]))
    const constants = new Set<string>()
    for (const db of useBlockStore.getState().dataBlocks) {
      for (const v of db.variables || []) {
        const start = (v.defaultValue || '').trim().toLowerCase()
        if (start && !['0', '0.0', 'false'].includes(start)) constants.add(`${db.name}.${v.name}`.toLowerCase())
      }
    }
    const { clockMemory, systemMemory } = useHardwareStore.getState().config
    const systemBytes = [clockMemory?.enabled ? clockMemory.byteAddress : null, systemMemory?.enabled ? systemMemory.byteAddress : null]
      .filter((b) => b !== null && b !== undefined)
      .map((b) => `%m${b}.`)

    const ob1 = useBlockStore.getState().ladBlocks.find((b) => (b.blockType === 'OB' && b.blockNumber === 1) || b.name === 'OB1_Main')
    const written = new Set<string>()
    const write = (op: string | undefined, address?: string): void => {
      if (key(op)) written.add(key(op))
      if (key(address)) written.add(key(address))
    }
    for (const net of ob1?.networks || []) {
      walk(net.nodes, (n) => {
        if (n.kind === 'coil') write(n.operand, n.address)
        else if (n.kind === 'math') write(n.out)
        else if (n.kind === 'timer') [n.instanceDb, n.qOperand, n.etOperand].forEach((o) => write(o))
        else if (n.kind === 'counter') [n.instanceDb, n.qOperand, n.cvOperand, n.quOperand, n.qdOperand].forEach((o) => write(o))
        else if (n.kind === 'contact' && n.edgeTag) write(n.edgeTag)
      })
    }

    const found = new Map<string, string>()
    const read = (op: string | undefined, address?: string): void => {
      const k = key(op)
      if (!k || /^[-+]?\d/.test(k) || /^[a-z]+#/.test(k) || k === 'true' || k === 'false') return
      if (written.has(k) || constants.has(k)) return
      // A timer or counter field belongs to its instance
      const dot = k.indexOf('.')
      if (dot > 0 && (written.has(k.slice(0, dot)) || /\.(q|et|in|pt|cv|pv|qu|qd)$/.test(k))) return
      const tag = tags.get(k)
      if (!tag && dot < 0 && !k.startsWith('%')) return // unknown names are the compiler's errors
      const where = key(tag?.address || address || (k.startsWith('%') ? k : ''))
      if (where.startsWith('%i') || written.has(where) || systemBytes.some((b) => where.startsWith(b))) return
      const shown = (op || '').trim()
      const at = (tag?.address || address || '').trim()
      found.set(k, at.startsWith('%') && at.toLowerCase() !== k ? `${shown} (${at})` : shown)
    }
    for (const net of newNetworks) {
      walk(net.nodes, (n) => {
        if (n.kind === 'contact') read(n.operand, n.address)
        else if (n.kind === 'comparator') [n.op1, n.op2].forEach((o) => read(o))
        else if (n.kind === 'math') [n.in1, n.in2, n.value, n.min, n.max].forEach((o) => read(o))
      })
    }
    return Array.from(found.values())
  }

  /**
   * Test first, step one: the model writes the test from the request (or corrects it after the user's word),
   * and the user is asked to approve it. Nothing in the project changes here.
   */
  private async runTestStage(
    prompt: string,
    tier: AiTier,
    mode: 'auto-apply' | 'diff-view',
    isTurkish: boolean,
    ragRulesConsulted: string[],
    requestModel: (contents: GeminiContent[]) => Promise<string>,
    plan: Extract<TurnPlan, { stage: 'test' }>
  ): Promise<AgentExecutionResponse> {
    const tools = PlcAgentTools.getInstance()
    const contents: GeminiContent[] = plan.correctionOf
      ? [
          ...plan.correctionOf.contents,
          {
            role: 'user',
            parts: [{ text: `The user did not approve this test and says:\n${plan.correctionOf.correction}\n\nSend the corrected test in the same form.` }]
          }
        ]
      : [{ role: 'user', parts: [{ text: `CURRENT PROJECT:\n${tools.describeProjectForModel()}\n\nUSER REQUEST:\n${prompt}\n\n${TEST_FIRST_REQUEST}` }] }]
    const existingTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
    const userIo = ioAddressesInPrompt(prompt)
    const askedOnce = new Set<string>()
    const executed: AgentToolCall[] = []
    const toolResults: AgentToolResult[] = []
    let rawText = ''
    let problems: string[] = []
    const respond = (fields: Partial<AgentExecutionResponse> & { replyText: string }): AgentExecutionResponse => ({
      tier,
      providerUsed: this.config.provider,
      toolCallsExecuted: executed,
      toolResults,
      ragRulesConsulted,
      rawTraceSnippet: rawText.substring(0, 300),
      ...fields
    })

    for (let round = 0; round < MAX_TEST_ROUNDS; round++) {
      rawText = await requestModel(contents)
      contents.push({ role: 'model', parts: [{ text: rawText }] })
      const extracted = this.extractValidJsonBlock(rawText)
      const parsed = extracted?.json && typeof extracted.json === 'object' ? (extracted.json as Record<string, unknown>) : undefined
      if (!parsed) {
        const text = rawText.trim()
        // A plain answer to a question
        if (!text.startsWith('{') && !text.startsWith('```')) return respond({ replyText: text })
        problems = ['Your reply was not valid JSON and may have been cut off. Send a shorter, complete JSON object.']
      } else {
        const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : ''
        const calls = (Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []) as AgentToolCall[]
        const reads = calls.filter((c) => READ_ONLY_TOOLS.has(String(c?.tool)))
        const changingTools = calls.length - reads.length
        const hasCircuit =
          (typeof parsed.dsl === 'string' && parsed.dsl.trim() !== '') || (Array.isArray(parsed.networks) && parsed.networks.length > 0)
        if (reads.length > 0 && parsed.verification === undefined && !hasCircuit) {
          const result = await tools.executeToolBatch(reads, mode)
          executed.push(...reads)
          toolResults.push(...result.results)
          contents.push({ role: 'user', parts: [{ text: `TOOL RESULTS:\n${JSON.stringify(result.results)}` }] })
          continue
        }
        if (parsed.verification === undefined && !hasCircuit && changingTools === 0) {
          const note = isTurkish ? 'Projede değişiklik yapılmadı.' : 'No changes were made to the project.'
          return respond({ replyText: `${explanation || rawText}\n\n*${note}*` })
        }
        const proposal = validateTestProposal(parsed, existingTags, userIo, askedOnce)
        problems = [
          ...(hasCircuit
            ? ['Do not write the circuit yet: send only "explanation", "tagsToUpsert" and "verification". The circuit comes after the user approves the test.']
            : []),
          ...(changingTools > 0 ? ['Do not use tools that change the project yet. Only the test is asked for now.'] : []),
          ...proposal.problems
        ]
        if (problems.length === 0 && proposal.test) {
          this.pendingTest = { prompt, tier, test: proposal.test, tags: proposal.tags, contents }
          BlackBoxLogger.getInstance().log('AI_PARSE_AND_AST_INJECTION', `Test proposed for approval: ${countExpectations(proposal.test)} checks`, {
            test: proposal.test,
            tags: proposal.tags
          })
          return respond({
            replyText: formatTestForUser(explanation, proposal.test, proposal.tags, isTurkish),
            pendingTest: { test: proposal.test, tags: proposal.tags }
          })
        }
      }
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Test proposal rejected, round ${round + 1}`, { problems })
      contents.push({ role: 'user', parts: [{ text: `The test was not accepted:\n${problems.join('\n')}` }] })
    }

    // A failed correction keeps the test that was waiting, so the user can still approve it
    const details = problems.map((p) => `- ${p}`).join('\n')
    return respond({
      replyText: isTurkish
        ? `Model ${MAX_TEST_ROUNDS} denemede onaylanabilir bir test yazamadı. Projede değişiklik yapılmadı.\n\n${details}`
        : `The model did not write a test that can be approved in ${MAX_TEST_ROUNDS} attempts. The project was not changed.\n\n${details}`,
      isError: true,
      errorDetails: details
    })
  }

  /**
   * Model, tools, compiler and simulator in a loop. A reply is applied as a whole and kept only if it compiles
   * without new errors and behaves as its test says. Otherwise the project goes back to where it was and the
   * model gets the errors.
   */
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
    if (plan?.stage === 'test') return this.runTestStage(prompt, tier, mode, isTurkish, ragRulesConsulted, requestModel, plan)
    // Test first: the approved test judges the circuit, and the model's own test is ignored
    const approved = plan?.stage === 'circuit' ? plan : undefined
    const tools = PlcAgentTools.getInstance()
    const turnStart = tools.takeSnapshot()
    // Motion control is not in this IDE. The user must hear it even when the last reply forgets to say so
    const motionBlocks = Array.from(new Set(prompt.match(/\bMC_[A-Za-z]+\b/g) || []))
    const motionNote =
      motionBlocks.length > 0 || /teknoloji objesi|technology object|\bTO_Axis/i.test(prompt)
        ? isTurkish
          ? `**Yapılamayan:** İstek motion kontrolü istiyor (${motionBlocks.join(', ') || 'teknoloji objesi'}). Bu IDE'de teknoloji objesi ve MC_ blokları yok: devrede bulunmuyorlar, eksen hiç hareket ettirilmiyor ve bu kısım simülatörde test edilmedi. MC bloklarını TIA Portal'da eklemeniz ve adım geçişlerini onların Done çıkışlarına bağlamanız gerekir.`
          : `**Not done:** The request needs motion control (${motionBlocks.join(', ') || 'technology object'}). This IDE has no technology objects or MC_ blocks: they are not in the circuit, no axis is moved and this part was not tested. Add the MC blocks in TIA Portal and make the steps wait for their Done outputs.`
        : ''
    const addressMovesNote = (fromDsl: AddressMove[] = []): string => {
      const moves = [...fromDsl, ...this.lastAddressMoves]
      if (moves.length === 0) return ''
      const why = (m: AddressMove): string =>
        m.takenBy === RESERVED_BYTE_OCCUPANT
          ? isTurkish
            ? "CPU'nun clock/system memory baytı"
            : 'clock/system memory byte of the CPU'
          : isTurkish
            ? `${m.takenBy} kullanıyordu`
            : `used by ${m.takenBy}`
      const list = moves.map((m) => `- ${m.name}: ${m.from} → ${m.to} (${why(m)})`).join('\n')
      return isTurkish
        ? `**Adres değişikliği:** Bazı etiketler modelin verdiği adreste tutulamadı:\n${list}`
        : `**Address change:** Some tags could not keep the address the model gave:\n${list}`
    }
    const userIo = ioAddressesInPrompt(prompt)
    const userIoNotUsed = (): string[] => {
      const used = new Set(
        useTagStore
          .getState()
          .tagTables.flatMap((t) => t.tags)
          .map((t) => `%${(t.address || '').replace(/[\s%]/g, '').toUpperCase()}`)
      )
      return userIo.filter((a) => !used.has(a))
    }
    const reportBefore = tools.runCompilerVerification()
    const errorsBefore = new Set(reportBefore.errors)
    const warningsBefore = new Set(reportBefore.warnings)
    // Things that are unusual but can be right: the model is asked once and believed if it repeats them
    const askedOnce = new Set<string>()
    // The most checks any test of this turn had. A retry should fix the circuit, not drop checks
    let strongestTest = 0
    const approvedPart = approved ? `\n\n${approvedTestRequest(approved.test, approved.tags)}` : ''
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: `CURRENT PROJECT:\n${tools.describeProjectForModel()}\n\nUSER REQUEST:\n${prompt}${approvedPart}` }] }
    ]
    const executed: AgentToolCall[] = []
    const toolResults: AgentToolResult[] = []
    let lastProblems: string[] = []
    let rawText = ''
    let rawJson: string | undefined
    // The last circuit that compiled cleanly and failed only its simulation test. The test may be what is wrong,
    // so when the rounds run out it is offered for review instead of being lost
    let candidate: { circuit: AiCircuitSynthesisPayload; problems: string[]; round: number } | undefined

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
      const reply = this.interpretModelReply(rawText, !!approved)
      rawJson = reply.rawJson
      const behaviorTest = approved ? approved.test : reply.behaviorTest

      let weakerTestNote = ''
      if (reply.behaviorTest) {
        const checks = countExpectations(reply.behaviorTest)
        if (reply.problems.length === 0 && reply.circuit && checks < strongestTest) {
          if (!askedOnce.has('weaker test')) {
            askedOnce.add('weaker test')
            reply.problems.push(
              `Your test checks ${checks} values, your earlier test checked ${strongestTest}. Do not remove checks to make a test pass: fix the circuit. If an earlier check was really wrong, send the same answer again.`
            )
          } else {
            weakerTestNote = isTurkish
              ? `**Uyarı:** Model testi denemeler arasında zayıflattı (${strongestTest} kontrolden ${checks} kontrole). Kaldırılan davranışlar doğrulanmadı.`
              : `**Warning:** The model weakened its test between attempts (from ${strongestTest} to ${checks} checks). The removed behaviour was not verified.`
          }
        }
        strongestTest = Math.max(strongestTest, checks)
      }

      if (reply.problems.length > 0) {
        lastProblems = reply.problems
        BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Agent reply rejected before applying, round ${round + 1}`, {
          problems: reply.problems
        })
        contents.push({ role: 'user', parts: [{ text: `Nothing was applied.\n${reply.problems.join('\n')}` }] })
        continue
      }

      const writes = reply.toolCalls.filter((c) => !READ_ONLY_TOOLS.has(c.tool))
      // Ladder has no call instruction, so a block the agent writes runs nowhere
      const neverCalledNote = writes.some((c) => c.tool === 'create_or_update_scl_block')
        ? isTurkish
          ? '**Not:** Oluşturulan FB/FC hiçbir yerden çağrılmıyor, çünkü bu IDE\'de ladder FB veya FC çağıramaz. Simülatörde çalışmaz ve test edilmedi. TIA\'da OB1\'den çağırmanız gerekir.'
          : '**Note:** The FB/FC that was created is not called from anywhere, because ladder in this IDE cannot call an FB or FC. It does not run on the simulator and was not tested. Call it from OB1 in TIA.'
        : ''
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
        this.lastAddressMoves = []
        if (reply.circuit && problems.length === 0) {
          const applied = this.applyCircuitPayload(reply.circuit, mode)
          lines.unshift(applied.summaryText)
          staged.push(...(applied.stagedChangeset || []))
        } else if (!reply.circuit && reply.explanation) {
          lines.unshift(reply.explanation, '')
        }

        if (mode === 'diff-view' && problems.length === 0) {
          // Try the staged circuit on the project for a moment. New tools are not applied yet, so it cannot run with them
          let behaviorNote = ''
          if (reply.circuit && writes.length === 0) {
            tools.holdDiskWrites()
            this.applyCircuitPayload(reply.circuit, 'auto-apply', { trialRun: true })
            const moved = approved ? approvedTagsMoved(approved.tags, useTagStore.getState().tagTables.flatMap((t) => t.tags)) : []
            const behavior = moved.length
              ? { problems: moved, note: '' }
              : this.checkCircuitBehavior(behaviorTest, askedOnce, isTurkish, reply.circuit, !!approved)
            tools.discardDiskWrites()
            tools.restoreSnapshot(turnStart)
            problems.push(...behavior.problems)
            if (behavior.problems.length > 0) candidate = { circuit: reply.circuit, problems: behavior.problems, round: round + 1 }
            behaviorNote = behavior.note
          } else if (reply.circuit) {
            behaviorNote = isTurkish
              ? '**Simülasyon testi:** Bu yanıt yeni blok veya etiket de oluşturduğu için onaydan önce çalıştırılamadı, devrenin davranışı doğrulanmadı.'
              : '**Simulation test:** This reply also creates blocks or tags, so it could not run before approval and the behaviour was not verified.'
          }
          if (problems.length === 0) {
            const note = isTurkish
              ? 'Derleyici kontrolü onaydan sonra çalışır.'
              : 'The compiler check runs after you approve the changes.'
            const parts = [lines.join('\n'), behaviorNote, weakerTestNote, neverCalledNote, motionNote, addressMovesNote(reply.addressMoves), `*${note}*`].filter(Boolean)
            return respond({ replyText: parts.join('\n\n'), stagedChangeset: staged })
          }
        }

        if (problems.length === 0) {
          const report = tools.runCompilerVerification()
          const newErrors = report.errors.filter((e) => !errorsBefore.has(e))
          // TIA accepts a bit with no channel and overlapping tags, so these are questions and not errors
          const newAddressWarnings = report.warnings.filter(
            (w) => (w.includes('[S7-IO-009]') || w.includes('[S7-MEM-001]')) && !warningsBefore.has(w)
          )
          problems.push(...newErrors)
          // The approved test's tags are fixed, so a moved one is an error, not a question
          if (newErrors.length === 0 && reply.circuit && approved) {
            problems.push(...approvedTagsMoved(approved.tags, useTagStore.getState().tagTables.flatMap((t) => t.tags)))
          }
          // The user's I/O list is the plant's wiring. A channel the CPU lacks then needs a signal module, not a new address
          const userAsked = (warning: string): boolean => {
            const used = warning.match(/uses %([IQM]\d+\.\d+)/i)
            if (!used) return false
            return new RegExp(`(^|[^A-Za-z0-9_.])%?${used[1].replace('.', '\\.')}(?![0-9])`, 'i').test(prompt)
          }
          const warningsToAsk = newAddressWarnings.filter((w) => !userAsked(w))
          if (newErrors.length === 0 && warningsToAsk.length > 0 && !askedOnce.has('address warning')) {
            askedOnce.add('address warning')
            problems.push(
              ...warningsToAsk,
              'Use a free address that exists on this CPU. If the user asked for this address, has an expansion module or really wants two tags on one address, send the same answer again.'
            )
          }
          // The user's I/O list is the wiring. A signal moved off it (often to M, when the CPU lacks the channel) is not wired
          const userIoMissing = reply.circuit ? userIoNotUsed() : []
          if (problems.length === 0 && userIoMissing.length > 0 && !askedOnce.has('user io')) {
            askedOnce.add('user io')
            problems.push(
              `The user's I/O list names ${userIoMissing.join(', ')}, but no tag uses these addresses. Keep every signal on the address the user gave, even one this CPU lacks: a signal module gives that channel, while a signal moved to M is wired to nothing. If the user really does not need these signals, send the same answer again.`
            )
          }
          const userIoNote = userIoMissing.length
            ? isTurkish
              ? `**Adres:** Listenizdeki ${userIoMissing.join(', ')} adreslerini hiçbir etiket kullanmıyor. Bu sinyaller devrede yok ya da başka bir adrese (ör. M bitine) taşındı; fiziksel olarak bağlı değiller.`
              : `**Address:** No tag uses ${userIoMissing.join(', ')} from your I/O list. These signals are missing or were moved to another address (for example an M bit), so they are not wired.`
            : ''
          let behaviorNote = ''
          if (problems.length === 0 && reply.circuit) {
            const behavior = this.checkCircuitBehavior(behaviorTest, askedOnce, isTurkish, reply.circuit, !!approved)
            problems.push(...behavior.problems)
            behaviorNote = behavior.note ? `\n\n${behavior.note}` : ''
            // A reply that also writes blocks or tags cannot be offered as one staged circuit
            if (behavior.problems.length > 0 && writes.length === 0) {
              candidate = { circuit: reply.circuit, problems: behavior.problems, round: round + 1 }
            }
          }
          if (problems.length === 0) {
            tools.releaseDiskWrites()
            tools.setUndoSnapshot(turnStart)
            const older = report.errors.length
              ? ` ${report.errors.length} error(s) were already in the project before this change.`
              : ''
            const moduleNote = newAddressWarnings.some(userAsked)
              ? isTurkish
                ? '\n\n**Adres:** İstediğiniz adreslerin bazıları bu CPU\'nun kendi kanallarında yok. Gerçek sistemde bir sinyal modülü (SM) gerekir; donanım yapılandırmasına ekleyin.'
                : '\n\n**Address:** Some addresses you asked for are not channels of this CPU. A real system needs a signal module (SM); add it to the hardware configuration.'
              : ''
            const addressNote = newAddressWarnings.length
              ? `${moduleNote}\n\n${newAddressWarnings.map((w) => `- ${w}`).join('\n')}`
              : ''
            return respond({
              replyText: [
                `${lines.join('\n')}\n\n**Compiler:** no new errors, ${report.warnings.length} warning(s).${older}${addressNote}${behaviorNote}`,
                weakerTestNote,
                neverCalledNote,
                motionNote,
                userIoNote,
                addressMovesNote(reply.addressMoves)
              ]
                .filter(Boolean)
                .join('\n\n'),
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
    if (candidate) {
      let staged: AgentExecutionResponse['stagedChangeset']
      try {
        staged = this.applyCircuitPayload(candidate.circuit, 'diff-view').stagedChangeset
      } catch {
        staged = undefined
      }
      if (staged && staged.length > 0) {
        const failed = candidate.problems.map((p) => `- ${p}`).join('\n')
        return respond({
          replyText: isTurkish
            ? `Model ${MAX_AGENT_ROUNDS} denemede kendi simülasyon testini geçemedi. **Projede değişiklik yapılmadı.**\n\n` +
              `${candidate.round}. denemenin devresi derleyiciden hatasız geçti, yalnızca testte kaldı. Hata devrede de olabilir, modelin testinde de. ` +
              `Bu devre onay penceresinde öneri olarak duruyor: aşağıdaki kontrolleri okuyup kendiniz karar verin.\n\n${failed}`
            : `The model did not pass its own simulation test in ${MAX_AGENT_ROUNDS} attempts. **The project was not changed.**\n\n` +
              `The circuit of attempt ${candidate.round} compiled without errors and failed only the test. The fault may be in the circuit or in the model's test. ` +
              `It is offered for review in the approval window: read the checks below and decide yourself.\n\n${failed}`,
          stagedChangeset: staged,
          isError: true,
          errorDetails: details
        })
      }
    }
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

  /** The API's base URL, ending before /chat/completions */
  private openAiBaseUrl(): string {
    return (this.config.openaiEndpoint || 'https://api.openai.com/v1')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/i, '')
  }

  /** The message of an OpenAI-style error body, or the start of the body */
  private apiErrorMessage(body: string): string {
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
    const base = this.openAiBaseUrl()
    const isOpenAi = /api\.openai\.com/i.test(base)
    const model = (this.config.openaiModel || '').trim() || (isOpenAi ? (tier === 'fast-flash' ? 'gpt-4o-mini' : 'gpt-4o') : '')
    if (!model) {
      throw new Error('No model is set for this API. Fetch the models or type a model name in the AI settings.')
    }
    const key = (this.config.openaiApiKey || '').trim()
    const { text: systemInstructionText, consultedRuleNames } = this.buildAgentInstruction(prompt)
    BlackBoxLogger.getInstance().log('AI_REQUEST', `OpenAI-compatible API request (${model})`, { prompt, model, endpoint: base, tier, mode })

    // Not every server knows response_format. One that refuses it is asked without it from then on
    let jsonMode = true
    // Streamed, the first bytes come at once: a proxy such as Cloudflare cuts a request that is silent for 100 s (HTTP 524)
    let streamMode = true
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
            temperature: 0.1,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
            ...(streamMode ? { stream: true } : {})
          }),
          timeoutMs: this.modelTimeoutMs,
          signal
        })

      let res = await send()
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
      if (res.error === 'timeout') throw new Error(`${model} at ${base} did not answer in ${this.modelTimeoutMs / 1000} s.`)
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
        throw new Error(`HTTP ${res.status} from ${base}: ${this.apiErrorMessage(res.body) || res.statusText}.${proxyTimeout}`)
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
      if (!rawText.trim()) throw new Error(`${model} answered without any text.`)
      BlackBoxLogger.getInstance().log(
        'AI_RAW_RESPONSE',
        `OpenAI-compatible API response from ${model} (${Date.now() - startMs}ms, ${rawText.length} chars)`,
        { model, rawSnippet: rawText.substring(0, 500), rawFull: rawText }
      )
      return rawText
    }

    const result = await this.runAgentTurn(prompt, tier, mode, isTurkish, consultedRuleNames, requestModel)
    return { ...result, providerUsed: 'openai' }
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

    const ragEngine = RagKnowledgeEngine.getInstance()
    const topRules = ragEngine.retrieveTopKRules(prompt, 3)
    const ragPromptSection = ragEngine.formatRetrievedRulesForPrompt(topRules)
    const consultedRuleNames = topRules.map((r) => r.item.name)

    const systemInstructionText = `You are an expert Siemens S7-1200/1500 PLC programmer.
When asked to synthesize, create, or modify PLC Ladder logic, circuits, timers, motors, or I/O configurations, output your response strictly in Compact Ladder DSL:

# EXPLANATION
Detailed engineering explanation in the user's language.

# TAG DECLARATIONS
TAG <Name> <Address> <DataType> "<Comment>"

# NETWORK DEFINITIONS
NW 1 "<Title>": <EXPRESSION>
NW 2 "<Title>": <EXPRESSION>

Compact Ladder DSL Syntax:
- Contacts: NO(operand), NC(operand), P_TRIG(operand), N_TRIG(operand), each with one value. P_TRIG and N_TRIG keep their own edge memory
- Coils: COIL(operand), NEG_COIL(operand), SET(operand), RESET(operand), each with one value
- Timers: TON(T_Name, PT=T#10s), TOF(...), TP(...)
- Counters: CTU(C_Name, PV=10), CTD(...)
- Comparators: CMP_EQ(in1, in2), CMP_NE, CMP_GT, CMP_LT, CMP_GE, CMP_LE. Add REAL as a third value to compare REALs
- Math: ADD(in1, in2, out), SUB, MUL, DIV with the same three values; MOVE(in, out) with two; NORM_X(value, min, max, out) and SCALE_X(value, min, max, out) with four
- Combinators: SERIES(elem1, elem2, ...), PARALLEL(branch1, branch2, ...)

${LADDER_RULES}
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

        const dslResult = LadderDslCompiler.compileLadderDslToAst(cleanDsl, this.dslOptions())
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

