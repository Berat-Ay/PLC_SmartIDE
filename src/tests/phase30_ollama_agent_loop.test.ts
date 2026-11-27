// Regression tests for wiring Local Ollama Provider into runAgentTurn (compiler + simulator loop & test-first).
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { createOllamaRequester } from '../renderer/src/services/ai/OllamaClient'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`✅ PASS: ${name}`)
  } else {
    failed++
    console.error(`❌ FAIL: ${name}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`)
  }
}

async function run(): Promise<void> {
  console.log('=== PHASE 30: OLLAMA PROVIDER IN RUN_AGENT_TURN ===\n')

  const realFetch = globalThis.fetch

  try {
    // 1. Test createOllamaRequester: /api/chat + 400 retry without format:'json' + 404 fallback to /api/generate
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    let modeStage = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ url, body })

      if (modeStage === 0) {
        // First call: HTTP 400 with format:'json', succeeds on retry without format
        if (body.format === 'json') {
          return new Response(JSON.stringify({ error: 'json format unsupported' }), { status: 400 })
        }
        return new Response(JSON.stringify({ message: { content: '{"explanation":"chat retry ok"}' } }), { status: 200 })
      }

      // Stage 1: /api/chat returns 404 -> falls back to /api/generate
      if (url.endsWith('/api/chat')) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(JSON.stringify({ response: '{"explanation":"generate fallback ok"}' }), { status: 200 })
    }) as typeof fetch

    const router = AiModelRouter.getInstance()
    const baseCfg = {
      ...router.getConfig(),
      provider: 'ollama' as const,
      ollamaEndpoint: 'http://localhost:11434',
      selectedModelId: 'qwen2.5-coder:7b'
    }

    const req1 = createOllamaRequester({
      prompt: 'test',
      tier: 'fast-flash',
      mode: 'auto-apply',
      systemInstruction: 'SYS',
      config: baseCfg,
      timeoutMs: 10000
    })

    const out1 = await req1([{ role: 'user', parts: [{ text: 'hello' }] }])
    check(
      'createOllamaRequester hits /api/chat and retries without format:json on HTTP 400',
      out1.includes('chat retry ok') &&
        calls.length === 2 &&
        calls[0].url.endsWith('/api/chat') &&
        calls[0].body.format === 'json' &&
        calls[1].body.format === undefined,
      calls
    )

    modeStage = 1
    calls.length = 0
    const req2 = createOllamaRequester({
      prompt: 'test',
      tier: 'fast-flash',
      mode: 'auto-apply',
      systemInstruction: 'SYS',
      config: baseCfg,
      timeoutMs: 10000
    })
    const out2 = await req2([
      { role: 'user', parts: [{ text: 'turn1' }] },
      { role: 'model', parts: [{ text: 'reply1' }] },
      { role: 'user', parts: [{ text: 'turn2' }] }
    ])
    check(
      'createOllamaRequester falls back to /api/generate when /api/chat returns 404',
      out2.includes('generate fallback ok') &&
        calls[0].url.endsWith('/api/chat') &&
        calls[1].url.endsWith('/api/generate') &&
        String(calls[1].body.prompt || '').includes('ASSISTANT:\nreply1'),
      calls
    )

    // 2. End-to-end executePrompt with provider:'ollama' running runAgentLoop self-heal across rounds
    const demo = DemoProjectSeeder.createDemoProject('/tmp/ollama_loop_proj')
    useProjectStore.getState().setProject(demo)
    useTagStore.getState().setTagTables(demo.tagTables)
    useBlockStore.getState().setBlocks({
      udts: demo.udts,
      dataBlocks: demo.dataBlocks,
      ladBlocks: demo.ladBlocks,
      sclBlocks: demo.sclBlocks
    })
    useHardwareStore.getState().setConfig(demo.hardware)

    let agentRound = 0
    const roundPrompts: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: Array<{ role: string; content: string }> }) : {}
      const lastMsg = body.messages?.[body.messages.length - 1]?.content || ''
      roundPrompts.push(lastMsg)
      agentRound++

      if (agentRound === 1) {
        // Round 1: uninstantiated T99.Q -> triggers [S7-TMR-004] compiler error so runAgentLoop must reject and ask Ollama to fix
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                explanation: 'Round 1 broken circuit',
                operationMode: 'replace_ob1_networks',
                dsl: 'NW 1 "Broken": SERIES( NO(T99.Q), COIL(Motor_Out) )',
                verification: {
                  steps: [{ atMs: 100, set: { 'T99.Q': true }, expect: { Motor_Out: true } }]
                }
              })
            }
          }),
          { status: 200 }
        )
      }

      // Round 2: self-heals into valid start/stop motor latch
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              explanation: 'Motor latch synthesized & healed by Ollama',
              operationMode: 'replace_ob1_networks',
              dsl: [
                'TAG Start_Cmd %I0.0 BOOL "Start"',
                'TAG Stop_Cmd %I0.1 BOOL "Stop"',
                'TAG Motor_Out %Q0.0 BOOL "Motor"',
                'NW 1 "Latch": SERIES( PARALLEL( NO(Start_Cmd), NO(Motor_Out) ), NC(Stop_Cmd), COIL(Motor_Out) )'
              ].join('\n'),
              verification: {
                steps: [
                  { atMs: 0, name: 'idle', set: { Start_Cmd: false, Stop_Cmd: false }, expect: { Motor_Out: false } },
                  { atMs: 50, name: 'start', set: { Start_Cmd: true, Stop_Cmd: false }, expect: { Motor_Out: true } },
                  { atMs: 100, name: 'latch', set: { Start_Cmd: false, Stop_Cmd: false }, expect: { Motor_Out: true } },
                  { atMs: 150, name: 'stop', set: { Start_Cmd: false, Stop_Cmd: true }, expect: { Motor_Out: false } }
                ]
              }
            })
          }
        }),
        { status: 200 }
      )
    }) as typeof fetch

    router.updateConfig({
      provider: 'ollama',
      ollamaEndpoint: 'http://localhost:11434',
      selectedModelId: 'qwen2.5-coder:7b',
      testFirst: false,
      acceptanceGate: 'strict'
    })

    const loopRes = await router.executePrompt('Create motor start/stop latch', 'fast-flash', 'auto-apply')
    const ob1 = useBlockStore.getState().ladBlocks.find((b) => b.name === 'OB1_Main')

    check(
      'Ollama runs multi-round runAgentLoop: catches compiler error in round 1, self-heals in round 2, passes simulator verification',
      agentRound === 2 &&
        loopRes.providerUsed === 'ollama' &&
        !loopRes.isError &&
        roundPrompts[1].includes('S7-TMR-004') &&
        ob1?.networks?.length === 1 &&
        ob1.networks[0].title === 'Latch',
      { agentRound, isError: loopRes.isError, replyText: loopRes.replyText.slice(0, 200) }
    )

    // 3. Ollama also participates in testFirst mode (proposes test awaiting approval)
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              explanation: 'Proposed test for pump latch',
              tagsToUpsert: [
                { name: 'Start_Btn', dataType: 'BOOL', address: '%I0.0' },
                { name: 'Motor_Out', dataType: 'BOOL', address: '%Q0.0' }
              ],
              verification: {
                steps: [
                  { atMs: 0, name: 'idle_set', set: { Start_Btn: false } },
                  { atMs: 100, name: 'idle_check', expect: { Motor_Out: false } },
                  { atMs: 200, name: 'press_start', set: { Start_Btn: true } },
                  { atMs: 300, name: 'motor_on', expect: { Motor_Out: true } }
                ]
              }
            })
          }
        }),
        { status: 200 }
      )) as typeof fetch

    router.updateConfig({ testFirst: true })
    const testStageRes = await router.executePrompt('Create pump latch with Start_Btn and Motor_Out', 'fast-flash', 'auto-apply')
    check(
      'Ollama participates in testFirst stage and returns pendingTest for approval',
      testStageRes.providerUsed === 'ollama' &&
        !!testStageRes.pendingTest &&
        router.hasPendingTest() === true &&
        !testStageRes.isError,
      testStageRes
    )
    router.cancelPendingTest()
  } finally {
    globalThis.fetch = realFetch
    AiModelRouter.getInstance().updateConfig({ provider: 'gemini', testFirst: false })
  }

  console.log(`\nPhase 30 Summary: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error('Fatal test failure:', err)
  process.exit(1)
})
