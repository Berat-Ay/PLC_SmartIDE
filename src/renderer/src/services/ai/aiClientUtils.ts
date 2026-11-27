/** Shared helpers for AI provider clients, ladder AST traversal, and S7 bit address extraction */

import { LadderNode, LadderSeriesNode } from '@shared/types/ladder'
import { GeminiContent } from './aiTypes'

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Converts Gemini multi-turn conversation history + system instruction into OpenAI/Ollama chat messages */
export function toChatMessages(systemInstruction: string, contents: GeminiContent[]): OpenAiChatMessage[] {
  return [
    { role: 'system', content: systemInstruction },
    ...contents.map((c) => ({
      role: (c.role === 'model' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: c.parts.map((p) => p.text).join('\n')
    }))
  ]
}

/** Sleeps for `ms` unless aborted via `signal`. Returns false if aborted before or during the wait. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Walks every leaf LadderNode recursively across nested parallel branches */
export function walkLadderNodes(nodes: LadderSeriesNode[] | undefined, visit: (node: LadderNode) => void): void {
  for (const node of nodes || []) {
    if (node.kind === 'parallel') {
      for (const branch of node.branches || []) {
        walkLadderNodes(branch, visit)
      }
    } else {
      visit(node)
    }
  }
}

/** Extracts normalized S7 bit addresses (%I0.0, %Q1.2, optionally %M20.0) mentioned in text */
export function extractBitAddresses(text: string, areas: 'IQ' | 'IQM' = 'IQM'): Set<string> {
  const found = new Set<string>()
  const pattern =
    areas === 'IQ'
      ? /(^|[^A-Za-z0-9_.%])%?([IQ])(\d{1,3})\.([0-7])(?![0-9])/gi
      : /(^|[^A-Za-z0-9_.%])%?([IQM])(\d{1,3})\.([0-7])(?![0-9])/gi
  for (const m of text.matchAll(pattern)) {
    found.add(`%${m[2].toUpperCase()}${Number(m[3])}.${m[4]}`)
  }
  return found
}
