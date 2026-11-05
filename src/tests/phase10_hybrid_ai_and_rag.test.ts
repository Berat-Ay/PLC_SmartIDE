import assert from 'node:assert'
import {
  RagKnowledgeEngine,
  TfIdfSemanticVectorizer,
  normalizeTechnicalTokens
} from '../renderer/src/services/ai/RagKnowledgeEngine'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { CoilDiagnosticEngine } from '../renderer/src/services/ai/CoilDiagnosticEngine'
import { LadBlockDefinition } from '@shared/types/blocks'
import { LadderNetwork } from '@shared/types/ladder'
import { useRuntimeStore } from '../renderer/src/stores/useRuntimeStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'

// Mock global localStorage for Node.js test environment if undefined
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, val),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear()
  }
}

// Mock window for dispatchEvent
if (typeof globalThis.window === 'undefined') {
  ;(globalThis as any).window = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

console.log('\n=== RUNNING PHASE 10 HYBRID AI (OLLAMA + GEMINI) & SEMANTIC RAG TEST SUITE ===\n')

// -----------------------------------------------------------------------------
// 1. Semantic Tokenizer & TF-IDF Cosine Similarity Vectorizer
// -----------------------------------------------------------------------------
console.log('--- 1. Testing Semantic Tokenizer & Normalization ---')

const trText = '10 saniye sonra duran mühürlemeli motor ve yıldız üçgen devresi için zamanlayıcı'
const trTokens = normalizeTechnicalTokens(trText)
console.log('Turkish Normalized Tokens:', trTokens)

assert(trTokens.includes('timer'), 'Alias mapping should convert "saniye" / "zamanlayici" to "timer"')
assert(trTokens.includes('motor'), 'Tokens should include "motor"')
assert(trTokens.includes('sealin'), 'Alias mapping should convert "muhurlemeli" to "sealin"')
assert(trTokens.includes('stardelta'), 'Alias mapping should convert "yildiz" / "ucgen" to "stardelta"')

console.log('✓ Turkish & English technical token normalization passed.')

// -----------------------------------------------------------------------------
// 2. TF-IDF Semantic Vectorizer Fit & Query
// -----------------------------------------------------------------------------
console.log('\n--- 2. Testing TF-IDF Cosine Similarity Vectorizer ---')

const vectorizer = new TfIdfSemanticVectorizer()
vectorizer.fit([
  { id: 'doc_timer', text: 'Zamanlayıcı TON T1 10 saniye süre motor durdurma' },
  { id: 'doc_stardelta', text: 'Yıldız üçgen motor starter contactor interlock K1 K2 K3' },
  { id: 'doc_analog', text: 'Analog giriş sıcaklık basınç NORM_X SCALE_X 0..27648' }
])

const timerScores = vectorizer.query('motor 10 sn zamanlayıcı ton')
console.log('Query: "motor 10 sn zamanlayıcı ton" -> Scores:', Object.fromEntries(timerScores))
assert((timerScores.get('doc_timer') || 0) > (timerScores.get('doc_stardelta') || 0), 'Timer doc should have highest score')
assert((timerScores.get('doc_timer') || 0) > (timerScores.get('doc_analog') || 0), 'Timer doc should beat analog doc')

const analogScores = vectorizer.query('sıcaklık ölçümü analog ölçekleme')
console.log('Query: "sıcaklık ölçümü analog ölçekleme" -> Scores:', Object.fromEntries(analogScores))
assert((analogScores.get('doc_analog') || 0) > 0.3, 'Analog doc should have strong positive score')

console.log('✓ TF-IDF Cosine Similarity calculation & ranking verified.')

// -----------------------------------------------------------------------------
// 3. MEB Automation Golden Rulebook RAG Engine Retrieval
// -----------------------------------------------------------------------------
console.log('\n--- 3. Testing RAG Knowledge Engine & MEB Rule Retrieval ---')

const ragEngine = RagKnowledgeEngine.getInstance()
const allStandards = ragEngine.getStandards()
console.log(`Loaded ${allStandards.length} persistent standard rules in RAG Engine:`)
allStandards.forEach((s, idx) => console.log(`  ${idx + 1}. [${s.category}] ${s.name}`))

assert(allStandards.length >= 8, 'Should have at least 8 canonical MEB curriculum standards')
assert(allStandards.some((s) => s.name === 'MEB_Motor_StartStop_SealIn'), 'Should contain MEB_Motor_StartStop_SealIn')
assert(allStandards.some((s) => s.name === 'MEB_Timer_T1Q_Cutoff'), 'Should contain MEB_Timer_T1Q_Cutoff')
assert(allStandards.some((s) => s.name === 'MEB_Star_Delta_Starter'), 'Should contain MEB_Star_Delta_Starter')
assert(allStandards.some((s) => s.name === 'MEB_Forward_Reverse_Interlock'), 'Should contain MEB_Forward_Reverse_Interlock')
assert(allStandards.some((s) => s.name === 'MEB_Sequential_Motor_Staging'), 'Should contain MEB_Sequential_Motor_Staging')
assert(allStandards.some((s) => s.name === 'MEB_Two_Timer_Flasher'), 'Should contain MEB_Two_Timer_Flasher')
assert(allStandards.some((s) => s.name === 'MEB_Counter_Packaging_Batch'), 'Should contain MEB_Counter_Packaging_Batch')
assert(allStandards.some((s) => s.name === 'MEB_Analog_NormX_ScaleX'), 'Should contain MEB_Analog_NormX_ScaleX')

// Test 3a: Timer Auto-Stop Motor Query
const timerQueryResults = ragEngine.retrieveTopKRules('10 saniye sonra otomatik duran mühürlemeli motor devresi', 4)
console.log('\nTop 4 Rules for Timer Motor Query:')
timerQueryResults.forEach((r) => console.log(`  Rank ${r.relevanceRank}: ${r.item.name} (Score: ${r.score})`))
const topRuleNames = timerQueryResults.map((r) => r.item.name)
assert(
  topRuleNames.includes('MEB_Timer_T1Q_Cutoff') || topRuleNames.includes('MEB_Motor_StartStop_SealIn'),
  'Timer motor query must retrieve MEB_Timer_T1Q_Cutoff or MEB_Motor_StartStop_SealIn'
)

// Test 3b: Star-Delta Query
const starDeltaResults = ragEngine.retrieveTopKRules('yıldız üçgen yol verme motor devresi', 4)
console.log('\nTop 4 Rules for Star-Delta Query:')
starDeltaResults.forEach((r) => console.log(`  Rank ${r.relevanceRank}: ${r.item.name} (Score: ${r.score})`))
assert(
  starDeltaResults[0].item.name === 'MEB_Star_Delta_Starter',
  'Star-delta query must rank MEB_Star_Delta_Starter first'
)

// Test 3c: Forward-Reverse Interlock Query
const fwdRevResults = ragEngine.retrieveTopKRules('ileri geri motor devresi elektriksel kilitleme', 4)
console.log('\nTop 4 Rules for Forward-Reverse Query:')
fwdRevResults.forEach((r) => console.log(`  Rank ${r.relevanceRank}: ${r.item.name} (Score: ${r.score})`))
assert(
  fwdRevResults[0].item.name === 'MEB_Forward_Reverse_Interlock',
  'Forward-reverse query must rank MEB_Forward_Reverse_Interlock first'
)

// Test 3d: Format Prompt Injection
const promptSection = ragEngine.formatRetrievedRulesForPrompt(timerQueryResults)
assert(promptSection.includes('[RETRIEVED MEB RAG RULES & DSL EXAMPLES]'), 'Must include RAG section open tag')
assert(promptSection.includes('[/RETRIEVED MEB RAG RULES & DSL EXAMPLES]'), 'Must include RAG section close tag')
assert(promptSection.includes('DSL Reference:'), 'Must include DSL reference snippets')
console.log('✓ RAG prompt injection block successfully generated.')

// Test 3e: User Textbook Rule Ingestion & Re-indexing
const newCustomRule = ragEngine.saveStandardBlock({
  name: 'MEB_Custom_Conveyor_Jam_Detector',
  category: 'safety',
  description: 'Proximity sensor jam timer: if sensor remains HIGH for over 3 seconds, stop conveyor and activate horn.',
  blockType: 'LAD',
  dslExample: 'NW 1 "Jam Timer": SERIES( NO(Sensor_Jam), TON(T_Jam, PT=T#3s) )\nNW 2 "Horn Trip": SERIES( NO(T_Jam.Q), COIL(Horn) )'
})
assert(newCustomRule.id.startsWith('std_'), 'New rule must have std_ prefix')

const jamQueryResults = ragEngine.retrieveTopKRules('conveyor jam sensor 3 seconds stop horn', 4)
console.log('\nTop Rule for Jam Query:', jamQueryResults[0]?.item.name)
assert(
  jamQueryResults[0]?.item.name === 'MEB_Custom_Conveyor_Jam_Detector',
  'Newly trained custom rule must be immediately indexed and retrievable'
)

// Clean up custom test rule
ragEngine.removeStandard(newCustomRule.id)
assert(!ragEngine.getStandards().some((s) => s.id === newCustomRule.id), 'Custom test rule removed')
console.log('✓ Custom RAG textbook rule ingestion, retrieval, and removal verified.')

// -----------------------------------------------------------------------------
// 4. AiModelRouter Local Ollama & Hybrid Multi-Provider Verification
// -----------------------------------------------------------------------------
console.log('\n--- 4. Testing AiModelRouter Hybrid Provider Configuration ---')

const router = AiModelRouter.getInstance()
const initialConfig = router.getConfig()

assert(initialConfig.ollamaEndpoint === 'http://localhost:11434', 'Default ollamaEndpoint must be http://localhost:11434')
assert(typeof router.fetchOllamaModels === 'function', 'AiModelRouter must provide fetchOllamaModels')

// Test Ollama Provider Switch
router.updateConfig({
  provider: 'ollama',
  ollamaEndpoint: 'http://localhost:11434',
  selectedModelId: 'qwen2.5-coder:7b'
})
const ollamaConfig = router.getConfig()
assert.strictEqual(ollamaConfig.provider, 'ollama')
assert.strictEqual(ollamaConfig.selectedModelId, 'qwen2.5-coder:7b')
console.log('✓ Provider switched to Local Ollama successfully.')

// Test Mock Ollama Discovery Parsing
const originalFetch = globalThis.fetch
;(globalThis as any).fetch = async (url: string) => {
  if (url.includes('/api/tags')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: 'qwen2.5-coder:7b',
            model: 'qwen2.5-coder:7b',
            size: 4683074560,
            details: { format: 'gguf', family: 'qwen2', parameter_size: '7.6B' }
          },
          {
            name: 'deepseek-coder:6.7b',
            model: 'deepseek-coder:6.7b',
            size: 3820000000,
            details: { format: 'gguf', family: 'deepseek', parameter_size: '6.7B' }
          },
          {
            name: 'llama3:8b',
            model: 'llama3:8b',
            size: 4900000000,
            details: { format: 'gguf', family: 'llama', parameter_size: '8.0B' }
          }
        ]
      })
    }
  }
  return { ok: false, status: 404, statusText: 'Not Found' }
}

const discoveredOllama = await router.fetchOllamaModels('http://localhost:11434')
console.log('Discovered Ollama Models from Mock Service:', discoveredOllama)
assert.strictEqual(discoveredOllama.length, 3, 'Must parse 3 models from Ollama /api/tags')
assert(discoveredOllama[0].displayName.includes('7.6B'), 'Must include parameter size in display name')
assert(discoveredOllama[1].id === 'deepseek-coder:6.7b')

// Verify router saved discovery status
const updatedCfg = router.getConfig()
assert(updatedCfg.lastDiscoveryStatus?.success === true, 'Discovery status must be success')
assert(updatedCfg.lastDiscoveryStatus?.message.includes('3 Local Models Loaded'))
console.log('✓ Ollama model auto-discovery parser verified.')

// Restore original fetch
;(globalThis as any).fetch = originalFetch

// Test Prompt Execution Attaches RAG Rules
router.updateConfig({ provider: 'offline_local' })
const execResponse = await router.executePrompt(
  '10 saniye sonra duran mühürlemeli motor devresi',
  'fast-flash',
  'auto-apply'
)

console.log('\nAgent Execution Reply Text Length:', execResponse.replyText.length)
console.log('Agent Execution RAG Rules Consulted:', execResponse.ragRulesConsulted)

assert(Array.isArray(execResponse.ragRulesConsulted), 'Response must have ragRulesConsulted array')
assert(execResponse.ragRulesConsulted.length > 0, 'Response must have consulted at least 1 RAG rule')
assert(
  execResponse.ragRulesConsulted.includes('MEB_Timer_T1Q_Cutoff') ||
    execResponse.ragRulesConsulted.includes('MEB_Motor_StartStop_SealIn'),
  'Consulted rules must include MEB_Timer_T1Q_Cutoff or MEB_Motor_StartStop_SealIn'
)
console.log('✓ Agent prompt execution with Semantic RAG Consultation Badge verified.')

// -----------------------------------------------------------------------------
// 5. CoilDiagnosticEngine Live Backward-Trace & Force-Bit Verification
// -----------------------------------------------------------------------------
console.log('\n--- 5. Testing CoilDiagnosticEngine & Force Bit ---')

// Set up a mock LAD block with an unenergized motor coil
const diagBlock: LadBlockDefinition = {
  id: 'lad_ob1',
  fileName: 'OB1_Main.lad',
  name: 'OB1_Main',
  blockNumber: 1,
  type: 'OB',
  networks: [
    {
      id: 'net_1',
      networkNumber: 1,
      title: 'Motor Start/Stop',
      nodes: [
        {
          id: 'c_start',
          kind: 'contact',
          contactType: 'NO_CONTACT',
          operand: 'Start_Btn',
          address: '%I0.0',
          symbolName: 'Start_Btn'
        },
        {
          id: 'c_stop',
          kind: 'contact',
          contactType: 'NC_CONTACT',
          operand: 'Stop_Btn',
          address: '%I0.1',
          symbolName: 'Stop_Btn'
        },
        {
          id: 'coil_motor',
          kind: 'coil',
          coilType: 'OUTPUT_COIL',
          operand: 'Motor_Run',
          address: '%Q0.0',
          symbolName: 'Motor_Run'
        }
      ]
    }
  ]
}

// Set up Tag table
useTagStore.getState().tagTables = [
  {
    id: 'tbl_1',
    name: 'Default Tags',
    tags: [
      { id: 't1', name: 'Start_Btn', address: '%I0.0', dataType: 'BOOL' },
      { id: 't2', name: 'Stop_Btn', address: '%I0.1', dataType: 'BOOL' },
      { id: 't3', name: 'Motor_Run', address: '%Q0.0', dataType: 'BOOL' }
    ]
  }
]

// Runtime memory: Start_Btn is 0 (FALSE), Stop_Btn is 0 (FALSE, so NC is conductive)
useRuntimeStore.getState().engine.setVariable('%I0.0', false)
useRuntimeStore.getState().engine.setVariable('%I0.1', false)
useRuntimeStore.getState().engine.setVariable('%Q0.0', false)

const report = CoilDiagnosticEngine.diagnoseCoil(diagBlock, 1, 'Motor_Run')
console.log('Diagnostic Report:', {
  operand: report.operand,
  isEnergized: report.isEnergized,
  blockingContact: report.blockingContact?.operand,
  evaluatedValue: report.blockingContact?.evaluatedValue,
  reason: report.blockingContact?.reason
})

assert(!report.isEnergized, 'Coil should not be energized')
assert(report.blockingContact !== undefined, 'Must identify blocking contact')
assert.strictEqual(report.blockingContact?.operand, 'Start_Btn', 'Start_Btn must be identified as blocking contact')
assert.strictEqual(report.blockingContact?.evaluatedValue, false)

// Test 1-click Force Bit True
CoilDiagnosticEngine.forceBlockingBitTrue('Start_Btn')
const forcedVal = useRuntimeStore.getState().engine.getVariable('%I0.0')
assert.strictEqual(forcedVal, true, 'Start_Btn address %I0.0 must be forced to TRUE')
console.log('✓ CoilDiagnosticEngine backwards tracing and 1-Click Force Bit verified.')

console.log('\n=============================================================================')
console.log(' PHASE 10 HYBRID AI ENGINE & SEMANTIC VECTOR RAG: ALL TESTS PASSED (100%) ')
console.log('=============================================================================\n')

