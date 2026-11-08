/**
 * Runs the agent on a scenario in a new project and judges what the user is left with by the scenario's
 * acceptance tests. One run is one sample: a model answers differently each time, so a scenario is run
 * several times and the results are counted, not read one by one.
 */
import { ProjectLoadPayload } from '@shared/types/ipc'
import { LadderNetwork } from '@shared/types/ladder'
import { AgentExecutionResponse } from '../ai/AiModelRouter'
import { PlcAgentTools, StagedFileChange } from '../ai/PlcAgentTools'
import { LadderDslCompiler } from '../compiler/LadderDslCompiler'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { useProjectStore } from '../../stores/useProjectStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useTagStore } from '../../stores/useTagStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { evaluateScenario, Scenario } from './ScenarioAcceptance'

/**
 * applied: the agent changed the project. offered: nothing was applied, but a circuit that failed only the
 * model's own test was staged for review; it is scored as if the user approved it. nothing: the project was
 * not changed. error: the request itself failed.
 */
export type BenchOutcome = 'applied' | 'offered' | 'nothing' | 'error'

export interface BenchRun {
  scenario: string
  run: number
  outcome: BenchOutcome
  specPassed: number
  specTotal: number
  interpretationPassed: number
  interpretationTotal: number
  failedChecks: string[]
  /** Model replies in this request */
  rounds: number
  /** The model that answered each round */
  models: string[]
  /** Models that were busy, timed out or failed and were skipped */
  fallbacks: string[]
  durationMs: number
  reply: string
  /** The circuit that was scored, as DSL */
  dsl: string
}

/** A new, empty LAD project on the default CPU, as the user gets it from "New project" */
export function newBenchProject(): void {
  useProjectStore.getState().createNewProject({ name: 'Benchmark', cpuProfileId: 'cpu-1214c', defaultLanguage: 'LAD' })
}

/** The project as it stands in the stores */
export function currentProject(): ProjectLoadPayload {
  const blocks = useBlockStore.getState()
  const project = useProjectStore.getState()
  return {
    projectPath: project.projectPath || '',
    metadata: project.metadata,
    hardware: useHardwareStore.getState().config,
    tagTables: useTagStore.getState().tagTables,
    udts: blocks.udts,
    dataBlocks: blocks.dataBlocks,
    ladBlocks: blocks.ladBlocks,
    sclBlocks: blocks.sclBlocks
  } as ProjectLoadPayload
}

const ob1Of = (project: ProjectLoadPayload): ProjectLoadPayload['ladBlocks'][number] | undefined =>
  project.ladBlocks.find((b) => b.blockType === 'OB' && b.blockNumber === 1)

const hasLogic = (project: ProjectLoadPayload): boolean => (ob1Of(project)?.networks || []).some((n) => (n.nodes || []).length > 0)

export async function runBenchCase(
  scenario: Scenario,
  run: number,
  execute: () => Promise<AgentExecutionResponse>
): Promise<BenchRun> {
  newBenchProject()
  const models: string[] = []
  const fallbacks: string[] = []
  const unsubscribe = BlackBoxLogger.getInstance().subscribe((entry) => {
    const answered = entry.category === 'AI_RAW_RESPONSE' && entry.summary.match(/received from (\S+)/)
    if (answered) models.push(answered[1])
    if (entry.category === 'AI_FALLBACK_OR_RETRY' && /^Candidate model/.test(entry.summary)) fallbacks.push(entry.summary)
  })
  const started = Date.now()
  let outcome: BenchOutcome
  let reply = ''
  try {
    const response = await execute()
    reply = response.replyText
    if (response.isError && response.stagedChangeset?.length) {
      PlcAgentTools.getInstance().applyStagedChangeset(response.stagedChangeset as StagedFileChange[])
      outcome = 'offered'
    } else if (hasLogic(currentProject())) {
      outcome = 'applied'
    } else {
      // No model answered at all (a wrong key, no quota, every model busy): the request failed, the agent did not
      outcome = response.isError && models.length === 0 ? 'error' : 'nothing'
    }
  } catch (err) {
    reply = err instanceof Error ? err.message : String(err)
    outcome = 'error'
  } finally {
    unsubscribe()
  }

  const project = currentProject()
  const results = evaluateScenario(scenario, project)
  const spec = results.filter((r) => r.check.kind === 'spec')
  const interpretation = results.filter((r) => r.check.kind === 'interpretation')
  const tags = project.tagTables.flatMap((t) => t.tags)
  return {
    scenario: scenario.id,
    run,
    outcome,
    specPassed: spec.filter((r) => r.passed).length,
    specTotal: spec.length,
    interpretationPassed: interpretation.filter((r) => r.passed).length,
    interpretationTotal: interpretation.length,
    failedChecks: results.filter((r) => !r.passed).map((r) => r.check.id),
    rounds: models.length,
    models,
    fallbacks,
    durationMs: Date.now() - started,
    reply,
    dsl: hasLogic(project) ? LadderDslCompiler.generateLadderDslFromAst((ob1Of(project)?.networks || []) as LadderNetwork[], tags) : ''
  }
}

const percent = (part: number, whole: number): string => (whole ? `${Math.round((100 * part) / whole)}%` : '-')

/** One line per scenario: what the user was left with, and how much of the specification it met */
export function formatBenchSummary(runs: BenchRun[]): string {
  const scenarios = Array.from(new Set(runs.map((r) => r.scenario)))
  const header = ['Senaryo', 'Koşu', 'Uygulandı', 'Öneri', 'Boş', 'Hata', 'Tam geçen', 'Ort. spec', 'Ort. tur']
  const rows = scenarios.map((id) => {
    const mine = runs.filter((r) => r.scenario === id)
    const count = (o: BenchOutcome): number => mine.filter((r) => r.outcome === o).length
    const full = mine.filter((r) => r.specPassed === r.specTotal && r.outcome !== 'nothing' && r.outcome !== 'error')
    const fullApplied = full.filter((r) => r.outcome === 'applied').length
    const meanSpec = mine.reduce((sum, r) => sum + r.specPassed / r.specTotal, 0) / mine.length
    const meanRounds = mine.reduce((sum, r) => sum + r.rounds, 0) / mine.length
    return [
      id,
      String(mine.length),
      String(count('applied')),
      String(count('offered')),
      String(count('nothing')),
      String(count('error')),
      `${full.length}/${mine.length}` + (full.length !== fullApplied ? ` (${fullApplied} uygulanan)` : ''),
      `${Math.round(meanSpec * 100)}%`,
      meanRounds.toFixed(1)
    ]
  })
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  const all = runs.length
  const fullAll = runs.filter((r) => r.specPassed === r.specTotal && (r.outcome === 'applied' || r.outcome === 'offered')).length
  const models = Array.from(new Set(runs.flatMap((r) => r.models)))
  const fellBack = runs.filter((r) => r.fallbacks.length > 0).length
  const mixed = models.length > 1 ? ' Birden fazla model cevap verdi: sonuçlar tek bir modelin değil.' : ''
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    `Toplam: ${all} koşu, spesifikasyonun tamamını karşılayan ${fullAll} (${percent(fullAll, all)}).`,
    `Cevap veren modeller: ${models.join(', ') || '-'}` + (fellBack ? `. ${fellBack} koşuda model en az bir kez meşgul, hız sınırında ya da yavaştı.` : '') + mixed,
    'Ort. spec: boş ve hatalı koşular da ortalamaya girer; boş program hiçbir kontrolü geçmez.'
  ].join('\n')
}
