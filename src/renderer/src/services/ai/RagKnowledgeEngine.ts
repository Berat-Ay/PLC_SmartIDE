/**
 * Rungline 3-Layer Self-Learning RAG Knowledge Engine
 * Layer 1: Dynamic Context Injector (S7 ASTs, memory map, CPU constraints)
 * Layer 2: Embedded Siemens S7 & MEB Automation Curriculum Reference Library (Canonical Rules & Examples)
 * Layer 3: User Standard Library & Semantic Vectorizer (TF-IDF Cosine Similarity)
 */

import { useProjectStore } from '../../stores/useProjectStore'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useHardwareStore } from '../../stores/useHardwareStore'

export interface StandardLibraryItem {
  id: string
  name: string
  category: 'motor' | 'analog' | 'sequencing' | 'safety' | 'communication'
  description: string
  blockType: 'LAD' | 'SCL' | 'UDT' | 'DB'
  contentJson: string
  dslExample?: string
  rulesList?: string[]
  createdAt: number
}

export interface RetrievedRagRule {
  item: StandardLibraryItem
  score: number
  relevanceRank: number
}

const RAG_STORAGE_KEY = 'antigravity_user_standards_rag_v1'

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

  // Canonical Seeded MEB Automation Curriculum Golden Rules
  private static readonly CANONICAL_MEB_RULES: StandardLibraryItem[] = [
    {
      id: 'rule_meb_motor_seal_in',
      name: 'MEB_Motor_StartStop_SealIn',
      category: 'motor',
      description: 'MEB Automation Standard: Canonical 3-wire motor start/stop seal-in latch. Start PB (%I0.0) in parallel with motor NO latch (%Q0.0), series with NC Stop PB (%I0.1) and thermal overload trip.',
      blockType: 'LAD',
      dslExample: `# NETWORK 1: Motor Seal-In
NW 1 "Motor Start/Stop Seal-In": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), COIL(Motor_Run) )`,
      rulesList: [
        'Motor auxiliary contact (Motor_Run NO) seals in parallel with Start_Btn NO',
        'Stop_Btn must be wired as NC_CONTACT in series with coil path',
        'Zero dummy intermediate %M coils for primary motor control'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Canonical Motor Start-Stop Seal-In Standard',
        inputs: ['Start_Btn (%I0.0)', 'Stop_Btn (%I0.1)'],
        outputs: ['Motor_Run (%Q0.0)']
      }),
      createdAt: 1700000000000
    },
    {
      id: 'rule_meb_timer_t1q_cutoff',
      name: 'MEB_Timer_T1Q_Cutoff',
      category: 'motor',
      description: 'MEB Automation Standard: Direct native timer sub-bit (T1.Q) addressing without dummy %M helper coils. TON timer T1 is energized directly by motor run contact; when PT expires, native NC T1.Q cuts power to motor coil.',
      blockType: 'LAD',
      dslExample: `# NETWORK 1: Motor Seal-In with T1.Q Cutoff
NW 1 "Motor Start with T1.Q Auto-Stop": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_Run) ), NC(Stop_Btn), NC(T1.Q), COIL(Motor_Run) )
# NETWORK 2: TON Timer Box (No trailing dummy coil)
NW 2 "10-Second Auto-Stop Timer": SERIES( NO(Motor_Run), TON(T1, PT=T#10s) )`,
      rulesList: [
        'STRICT BAN ON DUMMY %M TIMER COILS: Timers terminate cleanly at rung end without trailing coils',
        'Native sub-bit addressing: downstream rungs read T1.Q directly',
        'IEC preset time formatting: T#10s, T#5s, T#500ms'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Timer T1.Q Direct Trip Standard',
        timer: 'TON T1',
        tripBit: 'T1.Q'
      }),
      createdAt: 1700000000001
    },
    {
      id: 'rule_meb_star_delta',
      name: 'MEB_Star_Delta_Starter',
      category: 'motor',
      description: 'MEB Automation Standard: Star-Delta (Y-Δ) induction motor starter with TON transition timer (5s) and reciprocal software & hardware interlocks between Star (%Q0.1) and Delta (%Q0.2) contactors.',
      blockType: 'LAD',
      dslExample: `NW 1 "Main Contactor Latch": SERIES( PARALLEL( NO(Start_Btn), NO(Main_K1) ), NC(Stop_Btn), COIL(Main_K1) )
NW 2 "Star-to-Delta Transition Timer": SERIES( NO(Main_K1), TON(T_Star, PT=T#5s) )
NW 3 "Star Contactor (Interlocked with Delta)": SERIES( NO(Main_K1), NC(T_Star.Q), NC(Delta_K3), COIL(Star_K2) )
NW 4 "Delta Contactor (Interlocked with Star)": SERIES( NO(Main_K1), NO(T_Star.Q), NC(Star_K2), COIL(Delta_K3) )`,
      rulesList: [
        'Star contactor (K2) and Delta contactor (K3) must have reciprocal NC interlocks',
        'Main contactor (K1) remains continuously energized during transition',
        'Timer T_Star.Q switches from Star to Delta cleanly without shoot-through'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Star-Delta Starter Standard',
        main: '%Q0.0',
        star: '%Q0.1',
        delta: '%Q0.2'
      }),
      createdAt: 1700000000002
    },
    {
      id: 'rule_meb_fwd_rev_interlock',
      name: 'MEB_Forward_Reverse_Interlock',
      category: 'motor',
      description: 'MEB Automation Standard: Bi-directional forward/reverse motor circuit with cross-electrical interlocking. NC Forward contact guards Reverse coil; NC Reverse contact guards Forward coil.',
      blockType: 'LAD',
      dslExample: `NW 1 "Forward Direction": SERIES( PARALLEL( NO(Fwd_Btn), NO(Fwd_K1) ), NC(Stop_Btn), NC(Rev_K2), NC(Fwd_Limit), COIL(Fwd_K1) )
NW 2 "Reverse Direction": SERIES( PARALLEL( NO(Rev_Btn), NO(Rev_K2) ), NC(Stop_Btn), NC(Fwd_K1), NC(Rev_Limit), COIL(Rev_K2) )`,
      rulesList: [
        'Cross electrical interlocks prevent simultaneous activation of Forward and Reverse contactors',
        'Independent limit switches (NC) provide physical end-of-travel protection',
        'Stop button de-energizes both directions unconditionally'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Forward-Reverse Motor Interlock Standard',
        forward: '%Q0.0',
        reverse: '%Q0.1'
      }),
      createdAt: 1700000000003
    },
    {
      id: 'rule_meb_sequential_staging',
      name: 'MEB_Sequential_Motor_Staging',
      category: 'sequencing',
      description: 'MEB Automation Standard: Cascade sequential motor staging (M1 -> M2 -> M3). Motor 1 starts first. Motor 2 only starts after Motor 1 is confirmed and timer T1 expires. Motor 3 follows Motor 2.',
      blockType: 'LAD',
      dslExample: `NW 1 "Motor 1 Start": SERIES( PARALLEL( NO(Start_Btn), NO(Motor_1) ), NC(Stop_Btn), COIL(Motor_1) )
NW 2 "Delay Timer T1 (M1 to M2)": SERIES( NO(Motor_1), TON(T1, PT=T#5s) )
NW 3 "Motor 2 Start (Permissive from M1 & T1.Q)": SERIES( NO(Motor_1), NO(T1.Q), COIL(Motor_2) )`,
      rulesList: [
        'Downstream motors must have permissive series NO contacts from preceding stages',
        'Cascade stop: stopping M1 automatically stops M2 and M3 safely',
        'Individual timers provide staggered inrush current mitigation'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Sequential Motor Staging Standard'
      }),
      createdAt: 1700000000004
    },
    {
      id: 'rule_meb_two_timer_flasher',
      name: 'MEB_Two_Timer_Flasher',
      category: 'sequencing',
      description: 'MEB Automation Standard: Dual-timer symmetric or asymmetric flasher loop using two TON timers (T1 for ON duration, T2 for OFF duration) to drive alarm beacons or sirens.',
      blockType: 'LAD',
      dslExample: `NW 1 "Flasher Timer 1 (ON Pulse)": SERIES( NC(T2.Q), TON(T1, PT=T#1s) )
NW 2 "Flasher Timer 2 (OFF Interval)": SERIES( NO(T1.Q), TON(T2, PT=T#1s) )
NW 3 "Warning Beacon Output": SERIES( NO(T1.Q), COIL(Beacon_Lamp) )`,
      rulesList: [
        'Self-resetting dual timer oscillator: T2.Q NC resets T1',
        'Pulse duty cycle is easily tuned via T1 and T2 PT parameters',
        'No external clock memory required'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Two-Timer Flasher Circuit Standard'
      }),
      createdAt: 1700000000005
    },
    {
      id: 'rule_meb_counter_batch',
      name: 'MEB_Counter_Packaging_Batch',
      category: 'sequencing',
      description: 'MEB Automation Standard: Packaging batch counter using IEC CTU. Proximity sensor increments C1 up to PV=10; C1.QU trips part feeder and pulses packaging ejector piston.',
      blockType: 'LAD',
      dslExample: `NW 1 "Part Increment CTU": SERIES( NO(Part_Sensor), CTU(C1, PV=10, R=Batch_Reset) )
NW 2 "Batch Complete Trip": SERIES( NO(C1.QU), COIL(Ejector_Piston) )`,
      rulesList: [
        'Count Up (CTU) triggered by proximity sensor NO edge',
        'Native sub-bit C1.QU signals batch completion directly',
        'Reset pin R clears accumulator CV back to 0'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Counter Packaging Batch Standard'
      }),
      createdAt: 1700000000006
    },
    {
      id: 'rule_meb_analog_norm_scale',
      name: 'MEB_Analog_NormX_ScaleX',
      category: 'analog',
      description: 'MEB Automation Standard: Siemens S7-1200 analog sensor signal conditioning pipeline. Raw integer (%IW64, 0..27648) normalized to 0.0..1.0 REAL via NORM_X, then mapped to engineering units via SCALE_X.',
      blockType: 'SCL',
      dslExample: `// Siemens S7-1200 Analog Normalization & Scaling
#NormVal := NORM_X(MIN := 0, VALUE := #Raw_IW64, MAX := 27648);
#EngineeringVal := SCALE_X(MIN := 0.0, VALUE := #NormVal, MAX := 10.0);`,
      rulesList: [
        'Raw S7-1200 analog input range is strictly 0..27648 for unipolar 0-10V / 4-20mA',
        'NORM_X normalizes raw INT to 0.0..1.0 REAL',
        'SCALE_X maps normalized REAL to user engineering units (Bar, °C, Liters)'
      ],
      contentJson: JSON.stringify({
        title: 'MEB Analog NORM_X / SCALE_X Pipeline Standard'
      }),
      createdAt: 1700000000007
    }
  ]

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
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
        }
      }
    } catch {
      // fallback
    }

    return [...RagKnowledgeEngine.CANONICAL_MEB_RULES]
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
    const docs = this.userStandards.map((item) => ({
      id: item.id,
      text: `${item.name} ${item.category} ${item.description} ${item.dslExample || ''} ${(item.rulesList || []).join(' ')}`
    }))
    this.vectorizer.fit(docs)
  }

  public getStandards(): StandardLibraryItem[] {
    return [...this.userStandards]
  }

  public saveStandardBlock(item: Omit<StandardLibraryItem, 'id' | 'createdAt'>): StandardLibraryItem {
    const newItem: StandardLibraryItem = {
      ...item,
      id: `std_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
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

  /**
   * Retrieves the Top K most relevant MEB & Standard Library rules via TF-IDF Cosine Similarity
   */
  public retrieveTopKRules(queryText: string, k = 4): RetrievedRagRule[] {
    const scores = this.vectorizer.query(queryText)
    const ranked: RetrievedRagRule[] = []

    for (const item of this.userStandards) {
      const score = scores.get(item.id) || 0
      ranked.push({
        item,
        score: Math.round(score * 100) / 100,
        relevanceRank: 0
      })
    }

    // Sort descending by cosine similarity score
    ranked.sort((a, b) => b.score - a.score)

    // If query has matches with score > 0, take top k
    const matching = ranked.filter((r) => r.score > 0.05)
    const finalSelection = matching.length > 0 ? matching.slice(0, k) : ranked.slice(0, Math.min(k, 2))

    return finalSelection.map((r, idx) => ({
      ...r,
      relevanceRank: idx + 1
    }))
  }

  /**
   * Formats retrieved rules into LLM prompt context injection block
   */
  public formatRetrievedRulesForPrompt(retrieved: RetrievedRagRule[]): string {
    if (!retrieved || retrieved.length === 0) return ''

    const ruleBlocks = retrieved.map((r) => {
      const item = r.item
      const dsl = item.dslExample ? `\nDSL Reference:\n${item.dslExample}` : ''
      const rules = item.rulesList && item.rulesList.length > 0
        ? `\nKey Constraints:\n- ${item.rulesList.join('\n- ')}`
        : ''
      return `[RULE ${r.relevanceRank}: ${item.name} (Relevance Score: ${r.score.toFixed(2)})]
Description: ${item.description}${rules}${dsl}`
    })

    return `\n[RETRIEVED MEB RAG RULES & DSL EXAMPLES]
The following verified MEB Automation Curriculum rules and DSL circuit patterns were semantically retrieved for this request. Strictly follow these topologies:

${ruleBlocks.join('\n\n')}
[/RETRIEVED MEB RAG RULES & DSL EXAMPLES]\n`
  }

  /**
   * Layer 1: Build dynamic context prompt from active project state + Top matching RAG rules
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

    let ragSection = ''
    if (query) {
      const topRules = this.retrieveTopKRules(query, 4)
      ragSection = this.formatRetrievedRulesForPrompt(topRules)
    }

    return `[S7_PROJECT_CONTEXT]
Target CPU: ${proj.metadata?.targetCpu || 'SIMATIC S7-1200 (CPU 1214C DC/DC/DC V4.6)'}
Clock Memory: %MB0 (8 Square waves 0.1Hz..10Hz)
System Memory: %MB1 (FirstScan %M1.0, DiagStatus %M1.1, AlwaysTrue %M1.2, AlwaysFalse %M1.3)
OB30 Cyclic Interrupt: ${ob30?.cycleTimeMs || 100}ms
Onboard I/O: DI 14x24VDC (%IB0..%IB1), DQ 10x24VDC (%QB0..%QB1), AI 2x10V (%IW64..%IW66)
Declared Tags: [${allTags.slice(0, 15).join(', ')}${allTags.length > 15 ? '...' : ''}]
Declared UDTs: [${udts.join(', ')}]
Declared DBs: [${dataBlocks.join(', ')}]
LAD Blocks: [${ladBlocks.join(', ')}]
SCL Blocks: [${sclBlocks.join(', ')}]
Siemens S7 Architecture & MEB Curriculum Rules:
1. STRICT BAN ON DUMMY %M TIMER/COUNTER HELPER COILS: Never create or attach dummy intermediate marker coils (e.g. %M2.0, Aux_TimerDone) directly after a timer or counter box. In authentic Siemens S7-1200 / MEB programming, IEC Timers and Counters expose their own direct instance bits (e.g., T1.Q, T1.ET, C1.QU, C1.CV). Downstream networks or interlock rungs MUST read T1.Q directly.
2. STANDARD MEB SEAL-IN TOPOLOGY: Motor start/stop circuits MUST follow the canonical 3-wire latch.
3. PRESET TIME SYNTAX: Preset time PT must use authentic IEC format like T#10s, T#500ms, T#1m.
4. ZERO REDUNDANT %M TAGS: Do not add useless %M helper tags into tag tables when timers are used.
5. All S7 blocks MUST use { S7_Optimized_Access := 'TRUE' } unless explicitly declared standard.
6. Analog scaling must use NORM_X (0..27648 to 0.0..1.0) and SCALE_X (0.0..1.0 to Eng Units).
7. Timers/Counters require IEC instance DBs (TON, TOF, TP, CTU, CTD).
8. Edge triggers require dedicated M or DB bit flags (P_TRIG, N_TRIG).
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
