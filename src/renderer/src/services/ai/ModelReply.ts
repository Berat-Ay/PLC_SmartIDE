/** Reads a model's reply: the JSON in it, and the circuit, tools and test it asks for */

import { AgentToolCall } from './PlcAgentTools'
import { BehaviorTest, parseBehaviorTest } from './CircuitBehaviorTest'
import { LadderDslCompiler } from '../compiler/LadderDslCompiler'
import { AGENT_TOOLS } from './AgentInstruction'
import { AddressMove, AiCircuitSynthesisPayload } from './aiTypes'
import { hasEmptyNetwork, normalizeAiGeneratedNetworks } from './GeneratedCircuit'
import { defaultCircuitMode, dslOptions } from './ProjectContext'

export interface AgentModelReply {
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

/**
 * Resilient JSON Block Extractor
 * Safely locates and extracts JSON payload blocks from markdown code fences
 * or surrounding conversational text without crashing.
 */
export function extractValidJsonBlock(text: string): { json: any; raw: string } | null {
  if (!text) return null
  const strict = extractStrictJsonBlock(text)
  if (strict) return strict
  // Models often write real line breaks inside a JSON string (the "dsl" text). JSON forbids them, but the
  // reply is complete: escape them and read it again
  const repaired = escapeControlCharsInJsonStrings(text)
  return repaired === text ? null : extractStrictJsonBlock(repaired)
}

function extractStrictJsonBlock(text: string): { json: any; raw: string } | null {
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

/** Adds the JSON tag list to the DSL text as TAG lines. A tag already declared in the DSL wins. */
function dslWithDeclaredTags(dsl: string, tags: unknown): string {
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

/** Reads one model reply. Problems go back to the model instead of reaching the project. */
export function interpretModelReply(rawText: string, ignoreVerification = false): AgentModelReply {
  const reply: AgentModelReply = { explanation: '', toolCalls: [], problems: [] }
  let dslErrors: string[] = []
  const fromDsl = (text: string, operationMode = defaultCircuitMode()): AiCircuitSynthesisPayload | undefined => {
    const compiled = LadderDslCompiler.compileLadderDslToAst(text, dslOptions(operationMode))
    if (!compiled.success || compiled.networks.length === 0) {
      dslErrors = compiled.errors
      return undefined
    }
    reply.addressMoves = compiled.addressMoves
    return {
      explanation: compiled.explanation || '',
      operationMode: defaultCircuitMode(),
      tagsToUpsert: compiled.tags.map((t) => ({
        name: t.name,
        dataType: t.dataType as any,
        address: t.address,
        comment: t.comment
      })),
      networks: normalizeAiGeneratedNetworks(compiled.networks)
    }
  }

  const extracted = extractValidJsonBlock(rawText)
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
      reply.circuit = fromDsl(dslWithDeclaredTags(parsed.dsl, parsed.tagsToUpsert), parsed.operationMode)
      if (!reply.circuit) reply.problems.push(`The "dsl" field did not compile: ${dslErrors.join('; ') || 'it has no networks'}`)
    } else if (Array.isArray(parsed.networks) && parsed.networks.length > 0) {
      reply.circuit = {
        explanation: '',
        operationMode: defaultCircuitMode(),
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
