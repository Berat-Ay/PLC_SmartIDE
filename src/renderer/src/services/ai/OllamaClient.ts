/** Asks a local Ollama server for Compact Ladder DSL. It does not run the agent loop: its circuit is applied as it is */

import { LadderDslCompiler } from '../compiler/LadderDslCompiler'
import { AgentExecutionResponse, AiCircuitSynthesisPayload, AiConfig, AiTier } from './aiTypes'
import { buildOllamaInstruction } from './AgentInstruction'
import { applyCircuitPayload } from './ApplyCircuit'
import { defaultCircuitMode, dslOptions } from './ProjectContext'

export async function callOllamaApi(
  prompt: string,
  tier: AiTier,
  mode: 'auto-apply' | 'diff-view',
  config: AiConfig,
  signal?: AbortSignal
): Promise<AgentExecutionResponse> {
  const endpoint = (config.ollamaEndpoint || 'http://localhost:11434').replace(/\/$/, '')
  const model = config.selectedModelId || 'qwen2.5-coder'

  const { text: systemInstructionText, consultedRuleNames } = buildOllamaInstruction(prompt)

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

      const dslResult = LadderDslCompiler.compileLadderDslToAst(cleanDsl, dslOptions())
      if (dslResult.success && dslResult.networks.length > 0) {
        const circuitPayload: AiCircuitSynthesisPayload = {
          explanation: dslResult.explanation || 'Synthesized Ladder Logic via Local Ollama Model.',
          operationMode: defaultCircuitMode(),
          tagsToUpsert: dslResult.tags.map((t) => ({
            name: t.name,
            dataType: t.dataType as any,
            address: t.address,
            comment: t.comment
          })),
          networks: dslResult.networks
        }
        const result = applyCircuitPayload(circuitPayload, mode)
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
