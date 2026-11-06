/**
 * What the agent knows besides the project.
 * - The CPU context (memory map and limits from the hardware configuration)
 * - The circuit patterns in PatternLibrary.ts, which are tested on the simulator
 * - The user's own notes and saved blocks, which are not tested
 * Requests are matched to them with TF-IDF cosine similarity.
 */

import { useProjectStore } from '../../stores/useProjectStore'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { CIRCUIT_PATTERNS, CircuitPattern } from './PatternLibrary'

export interface StandardLibraryItem {
  id: string
  name: string
  category: 'motor' | 'analog' | 'sequencing' | 'safety' | 'communication'
  description: string
  blockType: 'LAD' | 'SCL' | 'UDT' | 'DB'
  contentJson: string
  dslExample?: string
  rulesList?: string[]
  keywords?: string
  /** Set on a built-in pattern. Anything without it comes from the user and is not tested. */
  pattern?: CircuitPattern
  createdAt: number
}

export interface RetrievedRagRule {
  item: StandardLibraryItem
  score: number
  relevanceRank: number
}

const RAG_STORAGE_KEY = 'antigravity_user_standards_rag_v1'
const USER_ITEM_PREFIX = 'std_'
const MAX_USER_TEXT_IN_PROMPT = 1500

function patternToItem(pattern: CircuitPattern): StandardLibraryItem {
  return {
    id: `pattern_${pattern.id}`,
    name: pattern.id,
    category: pattern.category,
    description: pattern.summary,
    blockType: 'LAD',
    contentJson: '',
    dslExample: pattern.dsl,
    rulesList: pattern.pitfalls,
    keywords: pattern.keywords,
    pattern,
    createdAt: 0
  }
}

/** The text of a user's entry. Notes saved by older versions keep the note in contentJson next to fixed rules. */
function userText(item: StandardLibraryItem): string {
  if (!item.contentJson) return item.description
  try {
    const notes = JSON.parse(item.contentJson)?.notes
    if (typeof notes === 'string') return notes
  } catch {
    // SCL source is not JSON
  }
  return `${item.description}\n${item.contentJson}`
}

/**
 * Normalizes and stems Turkish and English technical terms for zero-dependency semantic matching
 */
export function normalizeTechnicalTokens(text: string): string[] {
  if (!text) return []

  // Turkish character normalization
  const trNormalized = text
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .replace(/Ğ/g, 'g')
    .replace(/ğ/g, 'g')
    .replace(/Ü/g, 'u')
    .replace(/ü/g, 'u')
    .replace(/Ş/g, 's')
    .replace(/ş/g, 's')
    .replace(/Ö/g, 'o')
    .replace(/ö/g, 'o')
    .replace(/Ç/g, 'c')
    .replace(/ç/g, 'c')
    .replace(/ı/g, 'i')
    .toLowerCase()

  // Match alphanumeric tokens and underscores
  const rawTokens = trNormalized.match(/[a-z0-9_]{2,}/g) || []

  const stopwords = new Set([
    've', 'ile', 'veya', 'bir', 'bu', 'da', 'de', 'icin', 'icin', 'the',
    'and', 'or', 'a', 'an', 'to', 'in', 'of', 'for', 'with', 'is', 'at', 'on', 'by'
  ])

  // Alias / Semantic Stemming Map
  const aliasMap: Record<string, string> = {
    // Timer aliases
    zamanlayici: 'timer',
    zamanlayicisi: 'timer',
    zaman: 'timer',
    sure: 'timer',
    sn: 'timer',
    saniye: 'timer',
    delay: 'timer',
    ton: 'timer',
    tof: 'timer',
    tp: 'timer',
    t1: 'timer',
    t2: 'timer',
    // Counter aliases
    sayici: 'counter',
    sayicisi: 'counter',
    sayac: 'counter',
    adet: 'counter',
    tane: 'counter',
    paket: 'counter',
    batch: 'counter',
    ctu: 'counter',
    ctd: 'counter',
    c1: 'counter',
    // Seal-in aliases
    muhur: 'sealin',
    muhurleme: 'sealin',
    muhurlemeli: 'sealin',
    latch: 'sealin',
    latching: 'sealin',
    seal: 'sealin',
    // Star-Delta aliases
    yildiz: 'stardelta',
    ucgen: 'stardelta',
    star: 'stardelta',
    delta: 'stardelta',
    // Direction aliases
    ileri: 'fwdrev',
    geri: 'fwdrev',
    forward: 'fwdrev',
    reverse: 'fwdrev',
    yon: 'fwdrev',
    // Sequencing aliases
    sirali: 'sequential',
    ardisik: 'sequential',
    kademe: 'sequential',
    sequence: 'sequential',
    cascade: 'sequential',
    // Flasher aliases
    flasor: 'flasher',
    yanip: 'flasher',
    sonen: 'flasher',
    sinyal: 'flasher',
    ikaz: 'flasher',
    beacon: 'flasher',
    buzzer: 'flasher',
    // Analog aliases
    sicaklik: 'analog',
    basinc: 'analog',
    seviye: 'analog',
    debi: 'analog',
    analog: 'analog',
    norm_x: 'analog',
    scale_x: 'analog',
    sensor: 'analog',
    olcum: 'analog',
    // Interlock aliases
    kilit: 'interlock',
    kilitleme: 'interlock',
    interlock: 'interlock',
    emniyet: 'interlock'
  }

  const tokens: string[] = []
  for (const raw of rawTokens) {
    if (stopwords.has(raw)) continue
    const canonical = aliasMap[raw] || raw
    tokens.push(canonical)
  }

  return tokens
}

/**
 * TF-IDF Cosine Similarity Semantic Vectorizer
 */
export class TfIdfSemanticVectorizer {
  private idfMap = new Map<string, number>()
  private docVectors: Array<{ id: string; normVector: Map<string, number> }> = []
  private corpusSize = 0

  public fit(documents: Array<{ id: string; text: string }>): void {
    this.corpusSize = documents.length
    const docTokenFreqs: Array<{ id: string; freqs: Map<string, number>; totalTerms: number }> = []
    const termDocCount = new Map<string, number>()

    // Pass 1: Term frequency per document & document frequency
    for (const doc of documents) {
      const tokens = normalizeTechnicalTokens(doc.text)
      const freqs = new Map<string, number>()
      for (const t of tokens) {
        freqs.set(t, (freqs.get(t) || 0) + 1)
      }
      docTokenFreqs.push({ id: doc.id, freqs, totalTerms: Math.max(tokens.length, 1) })

      for (const term of freqs.keys()) {
        termDocCount.set(term, (termDocCount.get(term) || 0) + 1)
      }
    }

    // Pass 2: Calculate smooth IDF: ln(1 + N / (1 + df)) + 1
    this.idfMap.clear()
    for (const [term, df] of termDocCount.entries()) {
      const idf = Math.log(1 + this.corpusSize / (1 + df)) + 1
      this.idfMap.set(term, idf)
    }

    // Pass 3: Precalculate normalized unit vector for each document
    this.docVectors = []
    for (const item of docTokenFreqs) {
      const unnorm = new Map<string, number>()
      let sumSquares = 0

      for (const [term, count] of item.freqs.entries()) {
        const tf = count / item.totalTerms
        const idf = this.idfMap.get(term) || 1
        const weight = tf * idf
        unnorm.set(term, weight)
        sumSquares += weight * weight
      }

      const mag = Math.sqrt(sumSquares) || 1
      const norm = new Map<string, number>()
      for (const [term, weight] of unnorm.entries()) {
        norm.set(term, weight / mag)
      }

      this.docVectors.push({ id: item.id, normVector: norm })
    }
  }

  public query(queryText: string): Map<string, number> {
    const scores = new Map<string, number>()
    const tokens = normalizeTechnicalTokens(queryText)
    if (tokens.length === 0 || this.corpusSize === 0) {
      return scores
    }

    // Term freq of query
    const qFreqs = new Map<string, number>()
    for (const t of tokens) {
      qFreqs.set(t, (qFreqs.get(t) || 0) + 1)
    }

    // Build normalized query vector
    const qUnnorm = new Map<string, number>()
    let sumSquares = 0
    for (const [term, count] of qFreqs.entries()) {
      const tf = count / tokens.length
      const idf = this.idfMap.get(term) || Math.log(1 + this.corpusSize / 1) + 1
      const weight = tf * idf
      qUnnorm.set(term, weight)
      sumSquares += weight * weight
    }

    const qMag = Math.sqrt(sumSquares) || 1
    const qNorm = new Map<string, number>()
    for (const [term, weight] of qUnnorm.entries()) {
      qNorm.set(term, weight / qMag)
    }

    // Cosine similarity = dot product of normalized vectors
    for (const doc of this.docVectors) {
      let dot = 0
      for (const [term, qWeight] of qNorm.entries()) {
        const dWeight = doc.normVector.get(term)
        if (dWeight) {
          dot += qWeight * dWeight
        }
      }
      scores.set(doc.id, dot)
    }

    return scores
  }
}

export class RagKnowledgeEngine {
  private static instance: RagKnowledgeEngine | null = null
  private userStandards: StandardLibraryItem[] = []
  private vectorizer: TfIdfSemanticVectorizer = new TfIdfSemanticVectorizer()

  private constructor() {
    this.userStandards = this.loadStandards()
    this.rebuildVectorIndex()
  }

  public static getInstance(): RagKnowledgeEngine {
    if (!RagKnowledgeEngine.instance) {
      RagKnowledgeEngine.instance = new RagKnowledgeEngine()
    }
    return RagKnowledgeEngine.instance
  }

  private loadStandards(): StandardLibraryItem[] {
    try {
      const data = localStorage.getItem(RAG_STORAGE_KEY)
      if (data) {
        const parsed = JSON.parse(data)
        // Only the user's entries are stored. Older versions also stored the built-in rules, which hid every later change to them
        if (Array.isArray(parsed)) {
          return parsed.filter((item) => String(item?.id).startsWith(USER_ITEM_PREFIX))
        }
      }
    } catch {
      // fallback
    }

    return []
  }

  private allItems(): StandardLibraryItem[] {
    return [...CIRCUIT_PATTERNS.map(patternToItem), ...this.userStandards]
  }

  private saveStandards(): void {
    try {
      localStorage.setItem(RAG_STORAGE_KEY, JSON.stringify(this.userStandards))
    } catch {
      // ignore
    }
    this.rebuildVectorIndex()
  }

  private rebuildVectorIndex(): void {
    const docs = this.allItems().map((item) => ({
      id: item.id,
      // A pattern's circuit text is the same words everywhere, so it would only blur what the pattern is about
      text: item.pattern
        ? `${item.name.replace(/_/g, ' ')} ${item.description} ${item.keywords}`
        : `${item.name} ${item.category} ${item.description} ${item.dslExample || ''} ${(item.rulesList || []).join(' ')}`
    }))
    this.vectorizer.fit(docs)
  }

  public getStandards(): StandardLibraryItem[] {
    return this.allItems()
  }

  public saveStandardBlock(item: Omit<StandardLibraryItem, 'id' | 'createdAt'>): StandardLibraryItem {
    const newItem: StandardLibraryItem = {
      ...item,
      id: `${USER_ITEM_PREFIX}${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      createdAt: Date.now()
    }
    this.userStandards.push(newItem)
    this.saveStandards()
    return newItem
  }

  public removeStandard(id: string): void {
    this.userStandards = this.userStandards.filter((s) => s.id !== id)
    this.saveStandards()
  }

  /** The K most relevant patterns and notes. Nothing relevant means an empty list. */
  public retrieveTopKRules(queryText: string, k = 4): RetrievedRagRule[] {
    const scores = this.vectorizer.query(queryText)
    const ranked: RetrievedRagRule[] = []

    for (const item of this.allItems()) {
      const score = scores.get(item.id) || 0
      ranked.push({
        item,
        score: Math.round(score * 100) / 100,
        relevanceRank: 0
      })
    }

    // Sort descending by cosine similarity score
    ranked.sort((a, b) => b.score - a.score)

    return ranked.filter((r) => r.score > 0.05).slice(0, k).map((r, idx) => ({
      ...r,
      relevanceRank: idx + 1
    }))
  }

  /** One line per pattern, so the model knows what it can ask for with read_pattern. */
  public patternCatalogForPrompt(): string {
    return CIRCUIT_PATTERNS.map((p) => `- ${p.id}: ${p.summary}`).join('\n')
  }

  /** The matched patterns and notes for the prompt, saying how far each of them can be trusted. */
  public formatRetrievedRulesForPrompt(retrieved: RetrievedRagRule[]): string {
    if (!retrieved || retrieved.length === 0) return ''

    const blocks = retrieved.map(({ item }) => {
      if (item.pattern) {
        return `PATTERN ${item.pattern.id}: ${item.pattern.summary}
Circuit:
${item.pattern.dsl}
Timeline it passes:
${JSON.stringify(item.pattern.test)}
Pitfalls:
- ${item.pattern.pitfalls.join('\n- ')}`
      }
      const example = item.dslExample ? `\nCircuit:\n${item.dslExample}` : ''
      return `USER NOTE ${item.name}:\n${userText(item).slice(0, MAX_USER_TEXT_IN_PROMPT)}${example}`
    })

    return `
[RELEVANT PATTERNS AND NOTES]
A PATTERN is written for this IDE and passes its timeline on its simulator. It has not been run on a real CPU. Adapt names, addresses and times to the request, and write the test for what the user asked.
A USER NOTE is the user's own text and has not been tested. Follow it for how this plant works, but it does not excuse a failing test.

${blocks.join('\n\n')}
[/RELEVANT PATTERNS AND NOTES]
`
  }

  /**
   * The project state, the CPU's memory map and the matching patterns as prompt text
   */
  public buildDynamicContextPrompt(query?: string): string {
    const proj = useProjectStore.getState()
    const tags = useTagStore.getState()
    const blocks = useBlockStore.getState()
    const hw = useHardwareStore.getState()

    const allTags = tags.tagTables.flatMap((t) => t.tags).map((t) => `${t.name} (${t.address}, ${t.dataType})`)
    const udts = blocks.udts.map((u) => u.name)
    const dataBlocks = blocks.dataBlocks.map((d) => d.name)
    const ladBlocks = blocks.ladBlocks.map((l) => l.name)
    const sclBlocks = blocks.sclBlocks.map((s) => s.name)

    const ob30 = hw.config.organizationBlocks.find((o) => o.blockNumber === 30)
    const { clockMemory, systemMemory, digitalIO, analogIO } = hw.config
    const channelRange = (channels: Array<{ address: string }>): string =>
      channels.length > 0 ? `${channels[0].address}..${channels[channels.length - 1].address}` : 'none'
    const m = systemMemory.byteAddress

    let ragSection = ''
    if (query) {
      const topRules = this.retrieveTopKRules(query, 4)
      ragSection = this.formatRetrievedRulesForPrompt(topRules)
    }

    return `[S7_PROJECT_CONTEXT]
Target CPU: ${proj.metadata?.targetCpu || 'SIMATIC S7-1200 (CPU 1214C DC/DC/DC V4.6)'}
Clock Memory: ${clockMemory.enabled ? `%MB${clockMemory.byteAddress} (bit 0 to 7: 10, 5, 2.5, 2, 1.25, 1, 0.625, 0.5 Hz)` : 'off'}
System Memory: ${systemMemory.enabled ? `%MB${m} (FirstScan %M${m}.0, DiagStatus %M${m}.1, AlwaysTrue %M${m}.2, AlwaysFalse %M${m}.3)` : 'off'}
OB30 Cyclic Interrupt: ${ob30?.cycleTimeMs || 100}ms
Onboard I/O: DI ${channelRange(digitalIO.diChannels)}, DQ ${channelRange(digitalIO.dqChannels)}, AI ${channelRange(analogIO.aiChannels)}
Declared Tags: [${allTags.slice(0, 15).join(', ')}${allTags.length > 15 ? '...' : ''}]
Declared UDTs: [${udts.join(', ')}]
Declared DBs: [${dataBlocks.join(', ')}]
LAD Blocks: [${ladBlocks.join(', ')}]
SCL Blocks: [${sclBlocks.join(', ')}]
S7 rules:
1. Read IEC timers and counters through their instance bits (T1.Q, T1.ET, C1.QU, C1.CV). A helper coil that only copies one adds nothing.
2. Preset times use the IEC format: T#10s, T#500ms, T#1m.
3. All S7 blocks use { S7_Optimized_Access := 'TRUE' } unless declared standard.
4. Analog scaling uses NORM_X (0..27648 to 0.0..1.0) and SCALE_X (0.0..1.0 to engineering units).
5. Timers and counters need IEC instance DBs (TON, TOF, TP, CTU, CTD).
6. Edge triggers need their own M or DB bit (P_TRIG, N_TRIG).
${ragSection}
[/S7_PROJECT_CONTEXT]`
  }

  /**
   * Backward-compatible query knowledge method
   */
  public queryKnowledge(query: string): {
    matchedStandards: StandardLibraryItem[]
    referenceSummary: string
  } {
    const top = this.retrieveTopKRules(query, 4)
    const matchedStandards = top.map((t) => t.item)

    let referenceSummary = ''
    const q = query.toLowerCase()
    if (q.includes('timer') || q.includes('ton') || q.includes('zamanlayıcı')) {
      referenceSummary = 'Siemens IEC Timers: TON (On-Delay), TOF (Off-Delay), TP (Pulse Timer). Time preset syntax: T#5s, T#100ms. Pins: IN (BOOL), PT (TIME), Q (BOOL), ET (TIME).'
    } else if (q.includes('counter') || q.includes('ctu') || q.includes('sayıcı')) {
      referenceSummary = 'Siemens IEC Counters: CTU (Count Up), CTD (Count Down). Pins: CU/CD (BOOL), R/LD (BOOL), PV (INT), Q (BOOL), CV (INT).'
    } else if (q.includes('analog') || q.includes('norm_x') || q.includes('scale_x')) {
      referenceSummary = 'Siemens Analog Pipeline: %IW64 raw integer range 0..27648. NORM_X converts INT to 0.0..1.0 REAL. SCALE_X maps 0.0..1.0 to engineering units (e.g. 0.0..10.0 Bar).'
    }

    return { matchedStandards, referenceSummary }
  }
}
