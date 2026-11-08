// Runs the agent on the benchmark scenarios with the real Gemini API and scores the results.
// Usage (PowerShell):
//   $env:GEMINI_API_KEY = "..."; npm run bench -- --runs 3 --model gemini-3.5-flash
// Options:
//   --runs N             runs per scenario (default 3)
//   --model ID           Gemini model (default: the app's default fast model)
//   --scenario a,b       only these scenarios; a scenario left out of the benchmark is run only when named
//   --test-first         let the agent write and freeze the test before the circuit (approved without a person)
// Results go to bench-results/<time>-<model>.json, a summary to the console.
import * as fs from 'fs'
import * as path from 'path'
import { AiModelRouter } from '../src/renderer/src/services/ai/AiModelRouter'
import { SCENARIOS } from '../src/renderer/src/services/scenarios/scenarios'
import { BlackBoxLogger } from '../src/renderer/src/services/diagnostics/BlackBoxLogger'
import { BenchRun, formatBenchSummary, runBenchCase } from '../src/renderer/src/services/scenarios/Benchmark'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
// A mistyped flag would otherwise be ignored and the run would measure something else than asked
const withValue = ['--runs', '--model', '--scenario']
const known = [...withValue, '--test-first']
const strange = args.filter((a, i) => a.startsWith('--') && !known.includes(a) && !withValue.includes(args[i - 1]))
if (strange.length) {
  console.error(`Bilinmeyen seçenek: ${strange.join(', ')}. Seçenekler: ${known.join(', ')}`)
  process.exit(2)
}
const runs = Number(option('runs') || 3)
const named = option('scenario')?.split(',').map((s) => s.trim())
const testFirst = args.includes('--test-first')
const key = process.env.GEMINI_API_KEY?.trim()
if (!key) {
  console.error('GEMINI_API_KEY ortam değişkeni yok. PowerShell: $env:GEMINI_API_KEY = "anahtar"; npm run bench')
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
router.updateConfig({ provider: 'gemini', geminiApiKey: key, testFirst, pinModel: true, ...(model ? { selectedModelId: model } : {}) })
const modelName = model || router.getConfig().selectedModelId || router.getConfig().fastModel

// A wait for a busy model is shown, so a long pause does not look like a hang
BlackBoxLogger.getInstance().subscribe((entry) => {
  if (/^Pinned model: waiting/.test(entry.summary)) process.stdout.write(`[${entry.summary.replace('Pinned model: waiting', 'model meşgul, bekleniyor:').replace(' before asking again', '')}] `)
})

async function main(): Promise<void> {
  let quotaGone = false
  const results: BenchRun[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.resolve('bench-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${stamp}-${modelName.replace(/[^\w.-]/g, '_')}${testFirst ? '-testfirst' : ''}.json`)

  for (const scenario of scenarios) {
    const prompt = fs.readFileSync(path.join(promptsDir, `${scenario.id}.txt`), 'utf-8')
    for (let run = 1; run <= runs; run++) {
      process.stdout.write(`${scenario.id} ${run}/${runs} ... `)
      router.cancelPendingTest()
      const result = await runBenchCase(scenario, run, async () => {
        const first = await router.executePrompt(prompt, 'fast-flash', 'auto-apply')
        // Test first: the test is approved as it is, as no one reads it here
        return first.pendingTest ? router.approvePendingTest('auto-apply') : first
      })
      results.push(result)
      console.log(
        `${result.outcome}, spec ${result.specPassed}/${result.specTotal}, ${result.rounds} tur, ${Math.round(result.durationMs / 1000)} s` +
          (result.failedChecks.length ? ` (kalan: ${result.failedChecks.join(', ')})` : '')
      )
      // Written after every run, so an interrupted benchmark keeps what it measured
      fs.writeFileSync(outFile, JSON.stringify({ model: modelName, testFirst, runsPerScenario: runs, results }, null, 2))
      // With the daily quota used up every further run would only fail, and the summary would mean nothing
      if (result.outcome !== 'applied' && result.outcome !== 'offered' && /PerDay|per day/i.test(result.reply)) {
        quotaGone = true
        break
      }
    }
    if (quotaGone) break
  }
  if (quotaGone) {
    console.log(`
Günlük istek kotası bitti (${modelName}). Benchmark durduruldu; ölçülen ${results.length} koşu ${outFile} dosyasında.`)
    console.log('Ücretsiz planda model başına günde yaklaşık 20 istek var; bir tam benchmark bundan fazlasını ister.')
  }

  console.log(`\nModel: ${modelName}${testFirst ? ', önce test' : ''}\n`)
  console.log(formatBenchSummary(results))
  console.log(`\nAyrıntılar: ${outFile}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
