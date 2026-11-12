// Runs the agent on the benchmark scenarios with the real Gemini API and scores the results.
// Usage (PowerShell):
//   $env:GEMINI_API_KEY = "..."; npm run bench -- --runs 3 --model gemini-3.5-flash
//   $env:OPENAI_API_KEY = "..."; npm run bench -- --provider openai --endpoint https://host/v1 --model NAME
// Options:
//   --runs N             runs per scenario (default 3)
//   --provider P         gemini (default) or openai: any OpenAI-compatible API, key in OPENAI_API_KEY
//   --endpoint URL       base URL of the OpenAI-compatible API, up to /v1 (default https://api.openai.com/v1)
//   --model ID           model (Gemini default: the app's default fast model; required for openai)
//   --scenario a,b       only these scenarios; a scenario left out of the benchmark is run only when named
//   --test-first         let the agent write and freeze the test before the circuit (approved without a person)
//   --gate G             off (default), report or enforce: how the agent uses the scenario's acceptance tests.
//                        enforce sends their failures to the model, so its runs are an upper bound, reported apart
//   --rpm N              at most N model requests per minute: requests start at least 60/N s apart. For a plan
//                        whose per-minute limit is low, so runs are not lost to HTTP 429
// With --provider openai every run asks with its own seed, so a server that caches answers still answers each run anew.
//   --resume FILE        go on with an earlier result file, e.g. the next day after the daily quota ran out. Runs
//                        already in it are skipped and new ones are added to it. Refused if the agent's code or a
//                        setting that changes the measurement (model, provider, endpoint, --test-first, --gate) differs
// Results go to bench-results/<time>-<model>.json, a summary to the console.
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { AiModelRouter } from '../src/renderer/src/services/ai/AiModelRouter'
import { SCENARIOS } from '../src/renderer/src/services/scenarios/scenarios'
import { AcceptanceGate, matchScenario } from '../src/renderer/src/services/scenarios/ScenarioAcceptance'
import { BlackBoxLogger } from '../src/renderer/src/services/diagnostics/BlackBoxLogger'
import { BenchRun, formatBenchSummary, runBenchCase } from '../src/renderer/src/services/scenarios/Benchmark'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
// A mistyped flag would otherwise be ignored and the run would measure something else than asked
const withValue = ['--runs', '--model', '--scenario', '--provider', '--endpoint', '--gate', '--rpm', '--resume']
const known = [...withValue, '--test-first']
const strange = args.filter((a, i) => a.startsWith('--') && !known.includes(a) && !withValue.includes(args[i - 1]))
if (strange.length) {
  console.error(`Bilinmeyen seçenek: ${strange.join(', ')}. Seçenekler: ${known.join(', ')}`)
  process.exit(2)
}
const runs = Number(option('runs') || 3)
const named = option('scenario')?.split(',').map((s) => s.trim())
const testFirst = args.includes('--test-first')
const gate = (option('gate') || 'off') as AcceptanceGate
if (!['off', 'report', 'enforce'].includes(gate)) {
  console.error('--gate off, report ya da enforce olmalı.')
  process.exit(2)
}
const rpm = option('rpm') === undefined ? undefined : Number(option('rpm'))
if (rpm !== undefined && !(Number.isFinite(rpm) && rpm > 0)) {
  console.error('--rpm pozitif bir sayı olmalı (dakikadaki en çok istek).')
  process.exit(2)
}
// Every request of the agent goes out through fetch here (no Electron), so spacing fetch calls limits them all,
// retries after a 429 or 503 included. Spacing, not a sliding window: no 60 s ever holds more than N requests,
// and a wait is never longer than one interval, so it does not eat the request's own timeout
if (rpm !== undefined) {
  const intervalMs = Math.ceil(60000 / rpm) + 500
  const realFetch = globalThis.fetch
  let nextSlot = 0
  globalThis.fetch = (async (...fetchArgs: Parameters<typeof fetch>) => {
    const now = Date.now()
    const start = Math.max(now, nextSlot)
    nextSlot = start + intervalMs
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now))
    return realFetch(...fetchArgs)
  }) as typeof fetch
}
const provider = option('provider') || 'gemini'
if (provider !== 'gemini' && provider !== 'openai') {
  console.error('--provider gemini ya da openai olmalı.')
  process.exit(2)
}
// A server that caches answers gives every run of a scenario the first run's answer, so the runs are not
// independent samples. Each run asks with its own seed, which such a cache keys on; the text the model reads is unchanged
let runSeed: number | undefined
if (provider === 'openai') {
  const innerFetch = globalThis.fetch
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (runSeed !== undefined && String(input).endsWith('/chat/completions') && typeof init?.body === 'string') {
      init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), seed: runSeed }) }
    }
    return innerFetch(input, init)
  }) as typeof fetch
}
const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'
const key = process.env[keyName]?.trim()
if (!key) {
  console.error(`${keyName} ortam değişkeni yok. PowerShell: $env:${keyName} = "anahtar"; npm run bench`)
  process.exit(2)
}
if (provider === 'openai' && !option('model')) {
  console.error('OpenAI uyumlu API için --model gerekli (sunucunun model adı).')
  process.exit(2)
}
if (!Number.isInteger(runs) || runs < 1) {
  console.error('--runs pozitif bir tam sayı olmalı.')
  process.exit(2)
}
const unknown = (named || []).filter((id) => !SCENARIOS.some((s) => s.id === id))
if (unknown.length) {
  console.error(`Bilinmeyen senaryo: ${unknown.join(', ')}. Var olanlar: ${SCENARIOS.map((s) => s.id).join(', ')}`)
  process.exit(2)
}
const scenarios = named ? SCENARIOS.filter((s) => named.includes(s.id)) : SCENARIOS.filter((s) => !s.notInBenchmark)
for (const s of SCENARIOS.filter((s) => s.notInBenchmark && !named?.includes(s.id))) {
  console.log(`Atlandı: ${s.id} (${s.notInBenchmark})`)
}

const promptsDir = path.resolve('src/renderer/src/services/scenarios/prompts')
const router = AiModelRouter.getInstance()
const model = option('model')
// Only the named model answers: a busy model is waited for, not replaced by another one
if (provider === 'gemini') {
  router.updateConfig({ provider: 'gemini', geminiApiKey: key, testFirst, acceptanceGate: gate, pinModel: true, ...(model ? { selectedModelId: model } : {}) })
} else {
  // An OpenAI-compatible API is asked with the one model it is given; there is no fallback to pin against
  router.updateConfig({
    provider: 'openai',
    openaiApiKey: key,
    openaiEndpoint: option('endpoint') || 'https://api.openai.com/v1',
    openaiModel: model,
    testFirst,
    acceptanceGate: gate
  })
}
const modelName = model || router.getConfig().selectedModelId || router.getConfig().fastModel
const endpoint = provider === 'openai' ? router.getConfig().openaiEndpoint : undefined

// The code the agent runs on: the folders the benchmark imports from (prompts, patterns and scenarios included).
// Runs measured on other code must not be summed with these, so a resumed file has to carry the same hash
const AGENT_SOURCE = ['src/renderer/src/services', 'src/renderer/src/stores', 'src/renderer/src/runtime', 'src/shared']
function agentSourceHash(): string {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  AGENT_SOURCE.forEach((dir) => walk(path.resolve(dir)))
  const hash = crypto.createHash('sha256')
  for (const file of files.map((f) => path.relative(process.cwd(), f).replace(/\\/g, '/')).sort()) {
    // Line endings are left out, so a checkout with CRLF gives the same hash as one with LF
    hash.update(file).update('\0').update(fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')).update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
const sourceHash = agentSourceHash()

interface ResultFile {
  model: string
  provider?: string
  endpoint?: string
  testFirst: boolean
  gate: AcceptanceGate
  sourceHash?: string
  seedPerRun?: boolean
  results: BenchRun[]
}
const resumeFile = option('resume')
let resumed: BenchRun[] = []
if (resumeFile) {
  let earlier: ResultFile
  try {
    earlier = JSON.parse(fs.readFileSync(path.resolve(resumeFile), 'utf-8'))
  } catch (err) {
    console.error(`--resume: ${resumeFile} okunamadı (${(err as Error).message}).`)
    process.exit(2)
  }
  const mismatch: string[] = []
  if (!earlier.sourceHash) mismatch.push('dosyada kod özeti yok (--resume eklenmeden önce yazılmış)')
  else if (earlier.sourceHash !== sourceHash) mismatch.push(`ajanın kodu değişmiş (${earlier.sourceHash} → ${sourceHash})`)
  if (earlier.model !== modelName) mismatch.push(`model ${earlier.model} → ${modelName}`)
  if ((earlier.provider ?? 'gemini') !== provider) mismatch.push(`sağlayıcı ${earlier.provider ?? 'gemini'} → ${provider}`)
  if (earlier.endpoint !== endpoint) mismatch.push(`uç ${earlier.endpoint} → ${endpoint}`)
  if (earlier.testFirst !== testFirst) mismatch.push(`--test-first ${earlier.testFirst} → ${testFirst}`)
  if (earlier.gate !== gate) mismatch.push(`--gate ${earlier.gate} → ${gate}`)
  if (provider === 'openai' && !earlier.seedPerRun) mismatch.push('dosyadaki koşular seed olmadan soruldu, önbellekten gelmiş olabilirler')
  if (mismatch.length) {
    console.error(`--resume reddedildi, bu koşular eskilerle aynı şeyi ölçmez:\n  ${mismatch.join('\n  ')}\nYeni bir benchmark başlat.`)
    process.exit(2)
  }
  // A run no model answered measured nothing (no API, service down), so it is run again rather than kept as a failure
  resumed = earlier.results.filter((r) => r.outcome !== 'error')
  const dropped = earlier.results.length - resumed.length
  console.log(`Sürdürülüyor: ${resumed.length} koşu ${resumeFile} dosyasından${dropped ? `, ${dropped} cevapsız koşu yeniden yapılacak` : ''}.`)
}

// A wait for a busy model is shown, so a long pause does not look like a hang
BlackBoxLogger.getInstance().subscribe((entry) => {
  if (/^Pinned model: waiting/.test(entry.summary)) process.stdout.write(`[${entry.summary.replace('Pinned model: waiting', 'model meşgul, bekleniyor:').replace(' before asking again', '')}] `)
})

async function main(): Promise<void> {
  let quotaGone = false
  const results: BenchRun[] = [...resumed]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.resolve('bench-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = resumeFile
    ? path.resolve(resumeFile)
    : path.join(outDir, `${stamp}-${modelName.replace(/[^\w.-]/g, '_')}${testFirst ? '-testfirst' : ''}${gate === 'off' ? '' : `-gate-${gate}`}.json`)
  const done = new Set(resumed.map((r) => `${r.scenario}#${r.run}`))
  const save = (): void => {
    const file: ResultFile & { rpm?: number; runsPerScenario: number } = {
      // A resume with fewer --runs keeps the runs already measured, so the file says how many it may hold
      model: modelName, provider, endpoint, testFirst, gate, sourceHash, seedPerRun: provider === 'openai', rpm, runsPerScenario: Math.max(runs, ...results.map((r) => r.run)), results
    }
    fs.writeFileSync(outFile, JSON.stringify(file, null, 2))
  }

  for (const scenario of scenarios) {
    const prompt = fs.readFileSync(path.join(promptsDir, `${scenario.id}.txt`), 'utf-8')
    // Under a gate the agent finds the scenario from the prompt. If it finds another one or none, the gate measures nothing
    if (gate !== 'off' && matchScenario(prompt, SCENARIOS).scenario?.id !== scenario.id) {
      console.error(`${scenario.id}: istem bu senaryoyla eşleşmiyor, kapı uygulanmazdı. Durduruldu.`)
      process.exit(2)
    }
    for (let run = 1; run <= runs; run++) {
      if (done.has(`${scenario.id}#${run}`)) continue
      process.stdout.write(`${scenario.id} ${run}/${runs} ... `)
      router.cancelPendingTest()
      runSeed = crypto.randomInt(1, 2 ** 31 - 1)
      const result = await runBenchCase(scenario, run, async () => {
        const first = await router.executePrompt(prompt, 'fast-flash', 'auto-apply')
        // Test first: the test is approved as it is, as no one reads it here
        return first.pendingTest ? router.approvePendingTest('auto-apply') : first
      }, gate)
      // With the daily quota used up every further run would only fail, and the summary would mean nothing.
      // The run the quota cut off measured the quota, not the agent, so it is not kept: --resume runs it again
      if (result.outcome !== 'applied' && result.outcome !== 'offered' && /PerDay|per day/i.test(result.reply)) {
        console.log('günlük kota bitti, bu koşu sayılmadı')
        quotaGone = true
        break
      }
      results.push(result)
      console.log(
        `${result.outcome}, spec ${result.specPassed}/${result.specTotal}, ${result.rounds} tur, ${Math.round(result.durationMs / 1000)} s` +
          (result.failedChecks.length ? ` (kalan: ${result.failedChecks.join(', ')})` : '')
      )
      // Written after every run, so an interrupted benchmark keeps what it measured
      save()
    }
    if (quotaGone) break
  }
  if (quotaGone) {
    console.log(`\nGünlük istek kotası bitti (${modelName}). Benchmark durduruldu.`)
    console.log('Ücretsiz planda model başına günde yaklaşık 20 istek var; bir tam benchmark bundan fazlasını ister.')
    // Without a file there is nothing to resume: the quota was gone before the first run
    if (fs.existsSync(outFile)) {
      console.log(`Ölçülen ${results.length} koşu ${outFile} dosyasında.`)
      console.log(`Kota yenilenince aynı seçeneklerle ve kodu değiştirmeden sürdür: --resume "${path.relative(process.cwd(), outFile)}"`)
    }
  }
  if (!results.length) {
    console.log('Ölçülen koşu yok.')
    return
  }

  console.log(`\nModel: ${modelName}${testFirst ? ', önce test' : ''}${gate === 'off' ? '' : `, kabul kapısı: ${gate}`}${rpm ? `, en çok ${rpm} istek/dk` : ''}\n`)
  console.log(formatBenchSummary(results))
  // A model that samples does not write the same long answer twice. Identical answers point to a cache, and then
  // the runs counted as several are one
  const repeated: string[] = []
  for (const id of new Set(results.map((r) => r.scenario))) {
    const answered = results.filter((r) => r.scenario === id && r.outcome !== 'error' && r.dsl)
    const copies = answered.length - new Set(answered.map((r) => `${r.reply}\0${r.dsl}`)).size
    if (copies) repeated.push(`${id} (${answered.length} koşudan ${copies} tanesi bir öncekinin aynısı)`)
  }
  if (repeated.length) {
    console.log(`\nUyarı: aynı senaryonun koşuları birebir aynı cevabı verdi: ${repeated.join(', ')}.`)
    console.log('Sunucu cevapları önbellekten veriyor olabilir; o zaman bu koşular bağımsız örnek değildir.')
  }
  console.log(`\nAyrıntılar: ${outFile}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
