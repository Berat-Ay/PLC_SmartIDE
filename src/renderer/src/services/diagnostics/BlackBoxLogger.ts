/**
 * Black-Box Flight Recorder & Diagnostic Telemetry Logger
 *
 * Captures high-frequency diagnostic events across AI orchestration,
 * LLM raw responses, AST compilation, tag synchronization, and softPLC runtime.
 * Provides 1-click comprehensive markdown diagnostic export for troubleshooting.
 */

export type BlackBoxCategory =
  | 'AI_REQUEST'
  | 'AI_RAW_RESPONSE'
  | 'AI_FALLBACK_OR_RETRY'
  | 'AI_PARSE_ERROR'
  | 'AI_PARSE_AND_AST_INJECTION'
  | 'AI_ERROR'
  | 'AST_COMPILE'
  | 'TAG_SYNC'
  | 'RUNTIME_TICK'
  | 'RUNTIME_STATE_SNAPSHOT'
  | 'UI_ACTION'

export interface BlackBoxLogEntry {
  id: string
  timestamp: string // ISO 8601
  elapsedMs: number
  category: BlackBoxCategory
  summary: string
  details?: any
}

export interface DiagnosticStoreReaders {
  getOb1: () => unknown
  getTagTables: () => unknown
  getRuntimeSummary: () => unknown
}

const SENSITIVE_KEY_NAMES = new Set([
  'apikey',
  'geminiapikey',
  'openaiapikey',
  'authorization',
  'x-goog-api-key',
  'token',
  'secret',
  'password'
])

function maskSecretString(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length <= 4) return '***'
  return `...${trimmed.slice(-4)}`
}

function sanitizeString(input: string): string {
  return input
    .replace(/key=([a-zA-Z0-9_-]{10,})/g, (_m, key: string) => `key=...${key.slice(-4)}`)
    .replace(/(Bearer\s+)([a-zA-Z0-9._-]{8,})/gi, (_m, prefix: string, token: string) => `${prefix}${maskSecretString(token)}`)
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,})\b/g, (token: string) => maskSecretString(token))
    .replace(/\b(AIza[a-zA-Z0-9_-]{12,})\b/g, (token: string) => maskSecretString(token))
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 8) return value
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_NAMES.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) {
      out[k] = maskSecretString(v)
    } else {
      out[k] = sanitizeValue(v, depth + 1)
    }
  }
  return out
}

export class BlackBoxLogger {
  private static instance: BlackBoxLogger | null = null
  private static storeReaders: DiagnosticStoreReaders | null = null
  private logs: BlackBoxLogEntry[] = []
  private maxEntries: number = 500
  private startTime: number = Date.now()
  private listeners: Set<(entry: BlackBoxLogEntry) => void> = new Set()
  private lastAiTrace: {
    request?: BlackBoxLogEntry
    rawResponse?: BlackBoxLogEntry
    parse?: BlackBoxLogEntry
    error?: BlackBoxLogEntry
  } = {}

  private constructor() {
    this.startTime = Date.now()
  }

  public static registerStoreReaders(readers: DiagnosticStoreReaders): void {
    BlackBoxLogger.storeReaders = readers
  }

  public static getInstance(): BlackBoxLogger {
    if (!BlackBoxLogger.instance) {
      BlackBoxLogger.instance = new BlackBoxLogger()
    }
    return BlackBoxLogger.instance
  }

  /**
   * Records a new structured telemetry event
   */
  public log(category: BlackBoxCategory, summary: string, details?: any): BlackBoxLogEntry {
    const entry: BlackBoxLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startTime,
      category,
      summary: sanitizeString(summary),
      details: details !== undefined ? this.sanitizeDetails(details) : undefined
    }

    this.logs.push(entry)
    if (this.logs.length > this.maxEntries) {
      this.logs.shift()
    }

    // Track AI trace sequence
    if (category === 'AI_REQUEST') {
      this.lastAiTrace = { request: entry }
    } else if (category === 'AI_RAW_RESPONSE') {
      this.lastAiTrace.rawResponse = entry
    } else if (category === 'AI_PARSE_AND_AST_INJECTION' || category === 'AI_PARSE_ERROR') {
      this.lastAiTrace.parse = entry
    } else if (category === 'AI_ERROR') {
      this.lastAiTrace.error = entry
    }

    // Notify active subscribers
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch (err) {
        console.error('Error in BlackBoxLogger listener:', err)
      }
    }

    return entry
  }

  /**
   * Retrieves log entries optionally filtered by category
   */
  public getLogs(category?: BlackBoxCategory | 'ALL'): BlackBoxLogEntry[] {
    if (!category || category === 'ALL') {
      return [...this.logs]
    }
    return this.logs.filter((l) => l.category === category)
  }

  /**
   * Clears the ring buffer
   */
  public clearLogs(): void {
    this.logs = []
    this.lastAiTrace = {}
  }

  /**
   * Subscribes to live incoming log entries
   */
  public subscribe(listener: (entry: BlackBoxLogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Sanitizes sensitive information (e.g. API keys, Bearer tokens) before storing
   */
  private sanitizeDetails(details: any): any {
    if (!details) return details
    try {
      return sanitizeValue(details)
    } catch {
      return details
    }
  }

  /**
   * Exports a full Markdown diagnostic dump ready for 1-click copy-paste
   */
  public exportDiagnosticReport(): string {
    const nowIso = new Date().toISOString()
    const last50 = this.logs.slice(-50).reverse()

    let activeOb1Json = 'N/A'
    let activeTagsJson = 'N/A'
    let runtimeStateJson = 'N/A'

    const readers = BlackBoxLogger.storeReaders
    if (readers) {
      try {
        activeOb1Json = JSON.stringify(readers.getOb1(), null, 2) ?? 'N/A'
      } catch (e) {
        activeOb1Json = `Error reading blockStore: ${e}`
      }
      try {
        activeTagsJson = JSON.stringify(readers.getTagTables(), null, 2) ?? 'N/A'
      } catch (e) {
        activeTagsJson = `Error reading tagStore: ${e}`
      }
      try {
        runtimeStateJson = JSON.stringify(readers.getRuntimeSummary(), null, 2) ?? 'N/A'
      } catch (e) {
        runtimeStateJson = `Error reading runtimeStore: ${e}`
      }
    } else if (typeof window !== 'undefined') {
      try {
        const blockStore = (window as any).plcTestContext?.useBlockStore?.getState?.()
        if (blockStore) {
          const ob1 = blockStore.ladBlocks?.find((b: any) => b.number === 1 || b.name === 'OB1_Main') || blockStore.ladBlocks?.[0]
          activeOb1Json = JSON.stringify(ob1, null, 2)
        }
      } catch (e) {
        activeOb1Json = `Error reading blockStore: ${e}`
      }

      try {
        const tagStore = (window as any).plcTestContext?.useTagStore?.getState?.()
        if (tagStore) {
          activeTagsJson = JSON.stringify(tagStore.tagTables, null, 2)
        }
      } catch (e) {
        activeTagsJson = `Error reading tagStore: ${e}`
      }

      try {
        const rtStore = (window as any).plcTestContext?.useRuntimeStore?.getState?.()
        if (rtStore) {
          runtimeStateJson = JSON.stringify(
            {
              state: rtStore.state,
              isMonitoring: rtStore.isMonitoring,
              cycleCount: rtStore.engine?.getMetrics?.()?.cycleNumber || 0,
              lastCycleMs: rtStore.engine?.getMetrics?.()?.lastCycleDurationMs || 0
            },
            null,
            2
          )
        }
      } catch (e) {
        runtimeStateJson = `Error reading runtimeStore: ${e}`
      }
    }

    const aiTrace = this.lastAiTrace

    return `=== RUNGLINE BLACK-BOX DIAGNOSTIC DUMP ===
Exported At: ${nowIso}
Total Events Captured: ${this.logs.length}
Flight Recorder Start: ${new Date(this.startTime).toISOString()}

## 1. LAST AI ORCHESTRATION TRACE
### AI Request:
${aiTrace.request ? JSON.stringify(aiTrace.request, null, 2) : 'No recent AI request'}

### AI Raw Response (Uncut):
${aiTrace.rawResponse ? JSON.stringify(aiTrace.rawResponse, null, 2) : 'No recent raw response'}

### AI Parse / AST Injection Status:
${aiTrace.parse ? JSON.stringify(aiTrace.parse, null, 2) : 'No parse record'}

### AI Error (if any):
${aiTrace.error ? JSON.stringify(aiTrace.error, null, 2) : 'None'}

## 2. ACTIVE OB1_MAIN LADDER AST
\`\`\`json
${activeOb1Json}
\`\`\`

## 3. S7 TAG TABLE (SYMBOL TABLE)
\`\`\`json
${activeTagsJson}
\`\`\`

## 4. SOFTPCL RUNTIME STATE
\`\`\`json
${runtimeStateJson}
\`\`\`

## 5. RECENT 50 TELEMETRY EVENTS
${last50
  .map(
    (e) =>
      `[${e.timestamp}] [${e.category}] ${e.summary}${
        e.details ? `\nDetails: ${JSON.stringify(e.details, null, 2)}` : ''
      }`
  )
  .join('\n\n')}

=== END OF DIAGNOSTIC REPORT ===`
  }
}
