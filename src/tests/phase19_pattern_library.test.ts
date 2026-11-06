/**
 * The agent's circuit patterns. A pattern is only worth anything if it really runs as it says, and its
 * timeline is only worth anything if it notices a broken circuit, so both are checked here.
 */
import assert from 'node:assert'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { runBehaviorTest, BehaviorResult, BehaviorTest } from '../renderer/src/services/ai/CircuitBehaviorTest'
import { CIRCUIT_PATTERNS, findPattern } from '../renderer/src/services/ai/PatternLibrary'
import { PlcAgentTools } from '../renderer/src/services/ai/PlcAgentTools'
import { RagKnowledgeEngine } from '../renderer/src/services/ai/RagKnowledgeEngine'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'

console.log('\n=== PHASE 19: PATTERN LIBRARY ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const demo = DemoProjectSeeder.createDemoProject()
useProjectStore.getState().setProject(demo)
useHardwareStore.getState().setConfig(demo.hardware)

const router = AiModelRouter.getInstance() as unknown as {
  interpretModelReply(raw: string): { circuit?: unknown; problems: string[] }
  applyCircuitPayload(circuit: unknown, mode: 'auto-apply'): unknown
}
const tools = PlcAgentTools.getInstance()

function resetProject(): void {
  useBlockStore.setState({
    ladBlocks: structuredClone(demo.ladBlocks).filter((b) => b.blockType === 'OB' && b.blockNumber === 1),
    sclBlocks: [],
    dataBlocks: [],
    udts: []
  })
  useTagStore.getState().setTagTables([{ id: 'table_default', name: 'default_tags', fileName: 'default_tags.tags.json', tags: [] }] as never)
}

function runDsl(dsl: string, test: BehaviorTest): BehaviorResult & { compileErrors: string[]; rejected: boolean } {
  resetProject()
  const reply = router.interpretModelReply(JSON.stringify({ explanation: 'x', operationMode: 'replace_ob1_networks', dsl }))
  if (!reply.circuit) {
    return { checks: 0, failures: reply.problems, pulses: [], timeline: '', compileErrors: [], rejected: true }
  }
  router.applyCircuitPayload(reply.circuit, 'auto-apply')
  const blocks = useBlockStore.getState()
  const project = { ...demo, tagTables: useTagStore.getState().tagTables, ladBlocks: blocks.ladBlocks, sclBlocks: [], dataBlocks: [], udts: [] }
  const result = runBehaviorTest(test, project as never)
  return { ...result, compileErrors: tools.runCompilerVerification().errors, rejected: false }
}

// ---- Every pattern runs as it says ----
for (const pattern of CIRCUIT_PATTERNS) {
  const result = runDsl(pattern.dsl, pattern.test)
  const detail = `${pattern.id}\n${result.failures.join('\n')}\n${result.pulses.join('\n')}\n${result.compileErrors.join('\n')}\n${result.timeline}`
  assert.strictEqual(result.rejected, false, `The circuit is understood: ${detail}`)
  assert.deepStrictEqual(result.compileErrors, [], `It compiles: ${detail}`)
  assert.deepStrictEqual(result.failures, [], `It follows its timeline: ${detail}`)
  assert.deepStrictEqual(result.pulses, [], `No output is a one-scan pulse: ${detail}`)
  assert.ok(result.checks >= 3, `It checks enough: ${detail}`)
  assert.ok(pattern.pitfalls.length > 0, `It names a pitfall: ${pattern.id}`)
}
ok(`All ${CIRCUIT_PATTERNS.length} patterns compile and follow their timelines`)

// ---- Every timeline notices a broken circuit ----
const survivors: string[] = []
for (const pattern of CIRCUIT_PATTERNS) {
  const lines = pattern.dsl.split('\n')
  const networks = lines.filter((l) => l.startsWith('NW '))
  for (const network of networks) {
    const result = runDsl(lines.filter((l) => l !== network).join('\n'), pattern.test)
    if (!result.rejected && result.failures.length === 0) survivors.push(`${pattern.id}: ${network}`)
  }
}
assert.deepStrictEqual(survivors, [], 'Removing any one network must fail the timeline')
ok('Removing any network of any pattern fails its timeline')

// ---- The self-reset mistake fails the ring's own timeline ----
const ring = findPattern('timer_ring')
assert.ok(ring)
const selfReset = ring.dsl.replace('SERIES( NO(Running), NC(T3.Q), TON(T1, PT=T#10s) )', 'SERIES( NO(Running), NC(T1.Q), TON(T1, PT=T#10s) )')
assert.notStrictEqual(selfReset, ring.dsl)
const broken = runDsl(selfReset, ring.test)
assert.ok(broken.failures.length > 0, 'A timer that resets itself fails the timeline')
ok('A timer that resets itself fails the timer ring timeline')

// ---- What the model is told ----
const rag = RagKnowledgeEngine.getInstance()
const top = (query: string): string | undefined => rag.retrieveTopKRules(query, 3)[0]?.item.name
assert.strictEqual(top('bana basit bir trafik lambası devresi yaz'), 'timer_ring', 'A traffic light finds the timer ring')
assert.strictEqual(top('yıldız üçgen yol verme'), 'star_delta')
assert.strictEqual(top('ileri geri motor elektriksel kilitleme'), 'forward_reverse')
assert.strictEqual(top('otopark doluluk giriş çıkış sayacı'), 'up_down_counter')
assert.deepStrictEqual(rag.retrieveTopKRules('merhaba nasılsın', 3), [], 'No match means no pattern, not the first ones in the list')
ok('A request finds its pattern, and an unrelated one finds nothing')

const section = rag.formatRetrievedRulesForPrompt(rag.retrieveTopKRules('trafik lambası', 3))
assert.ok(section.includes('timer_ring'), 'The section has the pattern')
assert.ok(section.includes('T3.Q') && section.includes('"atMs"'), 'The circuit and its timeline are included')
assert.ok(section.includes('not been run on a real CPU'), 'The model is told how far they are proven')
const everything = `${section}\n${rag.patternCatalogForPrompt()}\n${JSON.stringify(CIRCUIT_PATTERNS)}`
assert.ok(!/\bMEB\b/.test(everything), 'No claim about a curriculum')
for (const pattern of CIRCUIT_PATTERNS) assert.ok(rag.patternCatalogForPrompt().includes(pattern.id), `Catalog lists ${pattern.id}`)
ok('The model gets the circuit, the timeline and the limits, with no claim about a curriculum')

// ---- The CPU the model is told about comes from the hardware configuration ----
const config = structuredClone(useHardwareStore.getState().config)
config.clockMemory.byteAddress = 20
config.clockMemory.enabled = true
useHardwareStore.getState().setConfig(config)
const description = JSON.parse(tools.describeProjectForModel())
assert.strictEqual(description.clockMemory, '%MB20')
assert.ok(rag.buildDynamicContextPrompt().includes('%MB20'), 'The context follows the configuration')
assert.ok(!rag.buildDynamicContextPrompt().includes('0.1Hz'), 'There is no 0.1 Hz clock bit on an S7-1200')
assert.match(description.outputs, /^%Q0\.0\.\.%Q/, 'Outputs come from the channels')
config.clockMemory.byteAddress = 0
useHardwareStore.getState().setConfig(config)
ok('The model is told the real clock memory and I/O of this CPU')

async function main(): Promise<void> {
  // ---- read_pattern ----
  const found = await tools.executeToolBatch([{ tool: 'read_pattern', params: { id: 'timer_ring' } }] as never, 'auto-apply')
  assert.ok(found.results[0].success && JSON.stringify(found.results[0].data).includes('T3.Q'), 'read_pattern returns the pattern')
  const missing = await tools.executeToolBatch([{ tool: 'read_pattern', params: { id: 'nothing' } }] as never, 'auto-apply')
  assert.ok(!missing.results[0].success && missing.results[0].message.includes('timer_ring'), 'An unknown id lists the real ones')
  ok('read_pattern returns a pattern and lists the ids for an unknown one')

  // ---- A helper coil is only removed when that keeps the behaviour ----
  resetProject()
  const reply = router.interpretModelReply(
    JSON.stringify({
      explanation: 'x',
      operationMode: 'replace_ob1_networks',
      dsl: 'TAG In %I0.0 BOOL "i"\nTAG Latched %M10.0 BOOL "m"\nTAG Out %Q0.0 BOOL "q"\nNW 1 "A": SERIES( NO(In), TON(T1, PT=T#1s), SET(Latched) )\nNW 2 "B": SERIES( NO(Latched), COIL(Out) )'
    })
  ) as { circuit?: { networks: Array<{ nodes: Array<{ kind: string; coilType?: string; operand?: string }> }> } }
  const coil = reply.circuit?.networks[0].nodes.find((n) => n.kind === 'coil')
  assert.strictEqual(coil?.coilType, 'SET_COIL', 'A SET coil after a timer stays, because it latches and T1.Q does not')
  assert.strictEqual(reply.circuit?.networks[1].nodes[0].operand, 'Latched', 'The contact still reads the latch')
  ok('A latching coil after a timer is kept')

  console.log(`\nPhase 19: ${passed} passed, 0 failed\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
