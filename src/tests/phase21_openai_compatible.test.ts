/**
 * A custom OpenAI-compatible API: its requests go out from the main process, where a server without CORS
 * headers still answers, and it runs the same agent loop as Gemini (compile, simulate, undo, retry).
 */
import assert from 'node:assert'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { AiModelRouter } from '../renderer/src/services/ai/AiModelRouter'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { sendAiHttpRequest } from '../main/aiHttp'

console.log('\n=== PHASE 21: OPENAI-COMPATIBLE API ===\n')

let passed = 0
function ok(label: string): void {
  console.log(`  ok  ${label}`)
  passed++
}

const demo = DemoProjectSeeder.createDemoProject()
useProjectStore.getState().setProject(demo)
useHardwareStore.getState().setConfig(demo.hardware)

type Router = {
  updateConfig(config: object): void
  getConfig(): { availableModels: Array<{ id: string }>; openaiModels: Array<{ id: string }>; openaiModel: string }
  fetchActiveModels(key: string, provider: string): Promise<unknown>
  executePrompt(prompt: string, tier: string, mode: string): Promise<{ replyText: string; isError?: boolean; providerUsed: string }>
}
const router = AiModelRouter.getInstance() as unknown as Router

function resetProject(): void {
  useBlockStore.setState({
    ladBlocks: structuredClone(demo.ladBlocks)
      .filter((b) => b.blockType === 'OB' && b.blockNumber === 1)
      .map((b) => ({ ...b, networks: [] })),
    sclBlocks: [],
    dataBlocks: [],
    udts: []
  })
  useTagStore.getState().setTagTables([
    {
      id: 'table_default',
      name: 'default_tags',
      fileName: 'default_tags.tags.json',
      tags: [
        { id: 't0', name: 'Start', dataType: 'BOOL', address: '%I0.0' },
        { id: 't1', name: 'Lamp', dataType: 'BOOL', address: '%Q0.0' },
        { id: 't2', name: 'Horn', dataType: 'BOOL', address: '%Q0.1' }
      ]
    }
  ] as never)
}

type Call = { url: string; headers: Record<string, string>; body: any }
const realFetch = globalThis.fetch
function mockServer(handler: (call: Call, index: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  ;(globalThis as any).fetch = async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    const call = { url: String(url), headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return calls
}
const chat = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 })

const lampReply = (coil: string): string =>
  JSON.stringify({
    explanation: 'Start yakar',
    operationMode: 'append_ob1_networks',
    dsl: `NW 1 "Lamp": SERIES( NO(Start), COIL(${coil}) )`,
    verification: { steps: [{ atMs: 100, set: { Start: true } }, { atMs: 300, expect: { Lamp: true } }] }
  })

async function main(): Promise<void> {
  router.updateConfig({
    provider: 'openai',
    openaiApiKey: 'test-key',
    openaiEndpoint: 'https://custom.example/v1/',
    openaiModel: '',
    openaiModels: []
  })

  // ---- The server's own model names are listed and kept apart from the Gemini models ----
  const geminiBefore = router.getConfig().availableModels.map((m) => m.id)
  const listCalls = mockServer(() => new Response(JSON.stringify({ data: [{ id: 'tedx-coder' }, { id: 'tedx-mini' }] }), { status: 200 }))
  await router.fetchActiveModels('test-key', 'openai')
  assert.strictEqual(listCalls[0].url, 'https://custom.example/v1/models')
  assert.strictEqual(listCalls[0].headers.Authorization, 'Bearer test-key')
  assert.deepStrictEqual(router.getConfig().openaiModels.map((m) => m.id), ['tedx-coder', 'tedx-mini'], 'A model with any name is listed')
  assert.strictEqual(router.getConfig().openaiModel, 'tedx-coder')
  assert.deepStrictEqual(router.getConfig().availableModels.map((m) => m.id), geminiBefore, 'The Gemini models are not replaced')
  ok('The models of a custom server are listed, whatever their names, apart from the Gemini models')

  // ---- The agent loop: a wrong circuit goes back to the model, the corrected one is kept ----
  resetProject()
  const loop = mockServer((_call, i) => chat(lampReply(i === 0 ? 'Horn' : 'Lamp')))
  const fixed = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!fixed.isError, fixed.replyText)
  assert.strictEqual(fixed.providerUsed, 'openai')
  assert.strictEqual(loop.length, 2, 'The failed test went back to the model')
  assert.strictEqual(loop[0].url, 'https://custom.example/v1/chat/completions')
  assert.strictEqual(loop[0].body.model, 'tedx-coder', 'The chosen model is asked')
  assert.strictEqual(loop[0].body.messages[0].role, 'system')
  assert.ok(/SIMULATION TEST/.test(loop[0].body.messages[0].content), 'It gets the same instruction as Gemini')
  assert.deepStrictEqual(loop[0].body.response_format, { type: 'json_object' })
  const roles = loop[1].body.messages.map((m: { role: string }) => m.role)
  assert.deepStrictEqual(roles, ['system', 'user', 'assistant', 'user'], 'The earlier reply goes back as the assistant')
  assert.ok(/simulation test failed/i.test(loop[1].body.messages[3].content), loop[1].body.messages[3].content)
  assert.ok(fixed.replyText.includes('kontrolün hepsi geçti'), fixed.replyText)
  const ob1 = useBlockStore.getState().ladBlocks.find((b) => b.blockNumber === 1)!
  assert.strictEqual((ob1.networks[0].nodes[1] as { operand: string }).operand, 'Lamp', 'The corrected circuit is in OB1')
  ok('A custom API runs the agent loop: a failed simulation test goes back and the fix is kept')

  // ---- A server that does not know response_format is asked without it ----
  resetProject()
  const noJsonMode = mockServer((call) =>
    call.body.response_format
      ? new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 })
      : chat(lampReply('Lamp'))
  )
  const plain = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!plain.isError, plain.replyText)
  assert.strictEqual(noJsonMode.length, 2)
  assert.strictEqual(noJsonMode[1].body.response_format, undefined)
  ok('A server that refuses response_format is asked again without it')

  // ---- A reasoning model that accepts only its default temperature is asked without one ----
  resetProject()
  const noTemperature = mockServer((call) =>
    call.body.temperature !== undefined
      ? new Response(
          '{"error":{"message":"Unsupported value: \'temperature\' does not support 0.1 with this model. Only the default (1) value is supported.","param":"temperature"}}',
          { status: 400 }
        )
      : chat(lampReply('Lamp'))
  )
  const reasoning = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!reasoning.isError, reasoning.replyText)
  assert.strictEqual(noTemperature.length, 2)
  assert.deepStrictEqual(noTemperature[1].body.response_format, { type: 'json_object' }, 'JSON mode stays on')
  ok('A model that refuses the temperature is asked again without it, and keeps JSON mode')

  // ---- A server that accepts JSON mode but never answers in it is asked without it, from then on ----
  // (a reasoning model behind such a server only thinks until the timeout, or ends with no text)
  const routerInternals = router as unknown as { modelTimeoutMs: number }
  const timeoutBefore = routerInternals.modelTimeoutMs
  routerInternals.modelTimeoutMs = 200
  const hangCalls: Call[] = []
  ;(globalThis as any).fetch = (url: string, init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const call = { url: String(url), headers: init?.headers || {}, body: JSON.parse(init!.body!) }
    hangCalls.push(call)
    if (!call.body.response_format) return Promise.resolve(chat(lampReply('Lamp')))
    // JSON mode: no answer until the client gives up
    return new Promise((_resolve, reject) =>
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    )
  }
  router.updateConfig({ openaiModel: 'slow-thinker' })
  resetProject()
  const afterHang = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!afterHang.isError, afterHang.replyText)
  assert.strictEqual(hangCalls.length, 2)
  assert.deepStrictEqual(hangCalls[0].body.response_format, { type: 'json_object' })
  assert.strictEqual(hangCalls[1].body.response_format, undefined, 'The timed-out request is asked again without JSON mode')
  resetProject()
  const nextPrompt = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!nextPrompt.isError, nextPrompt.replyText)
  assert.strictEqual(hangCalls.length, 3, 'The next prompt does not wait for the timeout again')
  assert.strictEqual(hangCalls[2].body.response_format, undefined)
  routerInternals.modelTimeoutMs = timeoutBefore

  // Only reasoning, no text: the stream ends without an answer
  const thinkingOnly =
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning_content: 'Let me think about the latch...' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: ' and the stop button.' }, finish_reason: 'length' }] })}\n\n` +
    'data: [DONE]\n\n'
  router.updateConfig({ openaiModel: 'empty-thinker' })
  resetProject()
  const emptyCalls = mockServer((call) =>
    call.body.response_format
      ? new Response(thinkingOnly, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      : chat(lampReply('Lamp'))
  )
  const afterEmpty = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!afterEmpty.isError, afterEmpty.replyText)
  assert.strictEqual(emptyCalls.length, 2)
  assert.strictEqual(emptyCalls[1].body.response_format, undefined, 'An answer with no text is asked again without JSON mode')

  // A gateway that puts its own note where the JSON answer should be
  router.updateConfig({ openaiModel: 'gateway-note' })
  resetProject()
  const noteCalls = mockServer((call) =>
    call.body.response_format
      ? chat('Saglayicilar bu turda bos yanit dondurdu (gecici durum). Mesaji tekrar gonderirsen yeni bir deneme yapilir.')
      : chat(lampReply('Lamp'))
  )
  const afterNote = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!afterNote.isError && afterNote.replyText.includes('kontrolün hepsi geçti'), afterNote.replyText)
  assert.strictEqual(noteCalls.length, 2)
  assert.strictEqual(noteCalls[1].body.response_format, undefined, 'Plain text in JSON mode is asked again without JSON mode')

  // Without JSON mode, plain text is the model's own answer (a question back) and is shown as it is
  router.updateConfig({ openaiModel: 'asks-back' })
  resetProject()
  const askCalls = mockServer((call) =>
    call.body.response_format ? new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 }) : chat('Lamba hangi çıkışta?')
  )
  const question = await router.executePrompt('Lambayı yak', 'fast-flash', 'auto-apply')
  assert.strictEqual(question.replyText.trim().split('\n')[0], 'Lamba hangi çıkışta?', question.replyText)
  assert.strictEqual(askCalls.length, 2, 'A plain answer without JSON mode is not asked again')

  // Another model on the same server keeps JSON mode
  router.updateConfig({ openaiModel: 'tedx-coder' })
  resetProject()
  const otherModel = mockServer(() => chat(lampReply('Lamp')))
  await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.deepStrictEqual(otherModel[0].body.response_format, { type: 'json_object' }, 'Only the model that hung loses JSON mode')
  ok('A model that hangs, answers nothing or answers plain text in JSON mode is asked without it, and the next prompts skip the wait')

  // ---- Errors say what happened ----
  resetProject()
  mockServer(() => Promise.reject(new TypeError('Failed to fetch')))
  const unreachable = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(unreachable.isError && unreachable.replyText.includes('Could not reach https://custom.example/v1'), unreachable.replyText)
  mockServer(() => new Response('{"error":{"message":"geçersiz veya eksik API anahtarı","type":"invalid_api_key"}}', { status: 401 }))
  const badKey = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(badKey.isError && badKey.replyText.includes('HTTP 401') && badKey.replyText.includes('geçersiz veya eksik API anahtarı'), badKey.replyText)
  router.updateConfig({ openaiModel: '' })
  const noModel = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(noModel.isError && noModel.replyText.includes('No model is set'), noModel.replyText)
  ok('An unreachable server, a refused key and a missing model are reported as they are')

  // ---- The answer is streamed, so a proxy that cuts silent requests after 100 s (HTTP 524) lets it through ----
  router.updateConfig({ openaiModel: 'tedx-coder' })
  resetProject()
  const full = lampReply('Lamp')
  const half = Math.floor(full.length / 2)
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: full.slice(0, half) } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(half) } }] })}\n\n` +
    'data: [DONE]\n\n'
  const streamCalls = mockServer(() => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
  const streamedTurn = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!streamedTurn.isError && streamedTurn.replyText.includes('kontrolün hepsi geçti'), streamedTurn.replyText)
  assert.strictEqual(streamCalls[0].body.stream, true, 'The answer is asked as a stream')
  assert.strictEqual(loop[0].body.stream, true)

  resetProject()
  const noStream = mockServer((call) =>
    call.body.stream ? new Response('{"error":{"message":"stream is not supported"}}', { status: 400 }) : chat(lampReply('Lamp'))
  )
  const unstreamed = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(!unstreamed.isError, unstreamed.replyText)
  assert.strictEqual(noStream.at(-1)!.body.stream, undefined, 'A server that refuses streams is asked without one')

  mockServer(
    () =>
      new Response('<!DOCTYPE html><html><head><title>tedx.wtf | 524: A timeout occurred</title></head><body>...</body></html>', {
        status: 524
      })
  )
  const proxyTimeout = await router.executePrompt('Start butonu lambayı yaksın', 'fast-flash', 'auto-apply')
  assert.ok(
    proxyTimeout.isError && proxyTimeout.replyText.includes('524: A timeout occurred') && proxyTimeout.replyText.includes('Cloudflare'),
    proxyTimeout.replyText
  )
  assert.ok(!proxyTimeout.replyText.includes('<!DOCTYPE'), 'The proxy error page is not dumped on the user')
  ok('The answer is streamed, a server without streams still works, and a proxy timeout (524) is explained')

  ;(globalThis as any).fetch = realFetch

  // ---- The main process gets the answer of a server that sends no CORS headers ----
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(501)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.url === '/slow') return // never answers
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ got: JSON.parse(body || '{}'), auth: req.headers.authorization }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const answer = await sendAiHttpRequest({
    id: 'a',
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
    body: '{"model":"m"}',
    timeoutMs: 5000
  })
  assert.strictEqual(answer.status, 200)
  assert.deepStrictEqual(JSON.parse(answer.body), { got: { model: 'm' }, auth: 'Bearer k' })
  const slow = await sendAiHttpRequest({ id: 'b', url: `http://127.0.0.1:${port}/slow`, method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 })
  assert.strictEqual(slow.error, 'timeout')
  const refused = await sendAiHttpRequest({ id: 'c', url: 'file:///etc/passwd', method: 'GET', headers: {}, timeoutMs: 1000 })
  assert.ok(refused.status === 0 && refused.error === 'network' && /Only http and https/.test(refused.message || ''))
  server.closeAllConnections()
  server.close()
  ok('The main process reads a server without CORS headers, times out, and refuses other protocols')

  router.updateConfig({ provider: 'gemini', openaiApiKey: '', openaiEndpoint: 'https://api.openai.com/v1', openaiModel: '', openaiModels: [] })
  console.log(`\nPhase 21: ${passed} passed, 0 failed\n`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
