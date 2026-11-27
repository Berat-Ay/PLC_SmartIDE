/**
 * The agent loop of one turn: model, tools, compiler and simulator. A reply is applied as a whole and kept only
 * if it compiles without new errors and behaves as its test says. Test first adds a stage before it, in which
 * the model writes only the test and the user approves it.
 */

import { PlcAgentTools, AgentToolCall, AgentToolResult } from './PlcAgentTools'
import { BehaviorTest } from './CircuitBehaviorTest'
import { useTagStore } from '../../stores/useTagStore'
import { BlackBoxLogger } from '../diagnostics/BlackBoxLogger'
import { AcceptanceGate, AcceptanceSummary, formatAcceptanceLine, matchScenario, Scenario } from '../scenarios/ScenarioAcceptance'
import { SCENARIOS } from '../scenarios/scenarios'
import { approvedTagsMoved, approvedTestRequest, formatTestForUser, ProposedTag, TEST_FIRST_REQUEST, validateTestProposal } from './TestFirst'
import { AddressMove, AgentExecutionResponse, AiCircuitSynthesisPayload, AiProvider, AiTier, GeminiContent, isAgentAbortError } from './aiTypes'
import { extractBitAddresses } from './aiClientUtils'
import { READ_ONLY_TOOLS } from './AgentInstruction'
import { extractValidJsonBlock, interpretModelReply } from './ModelReply'
import { checkCircuitBehavior, judgeAcceptance } from './BehaviorCheck'
import { applyCircuitPayload } from './ApplyCircuit'
import { RESERVED_BYTE_OCCUPANT } from './GeneratedCircuit'

const MAX_AGENT_ROUNDS = 6
const MAX_TEST_ROUNDS = 3
const MAX_READ_ROUNDS = 4

/** Test first: write the test (or correct it), or write the circuit to an approved test */
export type TurnPlan =
  | { stage: 'test'; correctionOf?: { contents: GeminiContent[]; correction: string } }
  | { stage: 'circuit'; test: BehaviorTest; tags: ProposedTag[] }

/** Test first: a test that waits for the user's approval, with the conversation that made it */
export interface PendingTest {
  prompt: string
  tier: AiTier
  test: BehaviorTest
  tags: ProposedTag[]
  contents: GeminiContent[]
}

/** One turn: the request, and how its model is asked */
export interface AgentTurnContext {
  prompt: string
  tier: AiTier
  mode: 'auto-apply' | 'diff-view'
  isTurkish: boolean
  ragRulesConsulted: string[]
  /** Sends the conversation to the model and returns the text of its answer */
  requestModel: (contents: GeminiContent[]) => Promise<string>
  provider: AiProvider
  acceptanceGate: AcceptanceGate
  signal?: AbortSignal
  /** Test first: the model wrote a test that can be shown for the user's approval */
  onTestProposed: (pending: PendingTest) => void
}

function countExpectations(test: BehaviorTest): number {
  return test.steps.reduce((sum, step) => sum + Object.keys(step.expect || {}).length, 0)
}

/** Merges multiple staged changes to the same path (e.g. manage_plc_tags + circuit both editing default_tags) */
export function coalesceStagedChangeset(
  staged: NonNullable<AgentExecutionResponse['stagedChangeset']>
): NonNullable<AgentExecutionResponse['stagedChangeset']> {
  const result: NonNullable<AgentExecutionResponse['stagedChangeset']> = []
  const byPath = new Map<string, number>()

  for (const item of staged) {
    const normPath = item.path.startsWith('/') ? item.path : `/${item.path}`
    const existingIdx = byPath.get(normPath)
    if (existingIdx === undefined) {
      byPath.set(normPath, result.length)
      result.push({ ...item, path: normPath })
      continue
    }

    const prev = result[existingIdx]
    if (item.fileType === 'tag') {
      try {
        const prevParsed = JSON.parse(prev.afterContent) as { id?: string; tags?: Array<Record<string, unknown>> }
        const nextParsed = JSON.parse(item.afterContent) as { id?: string; tags?: Array<Record<string, unknown>> }
        if (prevParsed && Array.isArray(prevParsed.tags) && nextParsed && Array.isArray(nextParsed.tags)) {
          const mergedTags = [...prevParsed.tags]
          for (const t of nextParsed.tags) {
            const tName = typeof t.name === 'string' ? t.name.toLowerCase() : ''
            const idx = mergedTags.findIndex(
              (m) => (t.id && m.id === t.id) || (tName && typeof m.name === 'string' && m.name.toLowerCase() === tName)
            )
            if (idx !== -1) mergedTags[idx] = { ...mergedTags[idx], ...t }
            else mergedTags.push(t)
          }
          result[existingIdx] = {
            ...prev,
            title: `${prev.title} + ${item.title}`,
            afterContent: JSON.stringify({ ...prevParsed, ...nextParsed, tags: mergedTags }, null, 2)
          }
          continue
        }
      } catch {
        // Fallback to overwriting with latest
      }
    }
    result[existingIdx] = { ...item, path: normPath, beforeContent: prev.beforeContent }
  }
  return result
}

/**
 * Test first, step one: the model writes the test from the request (or corrects it after the user's word),
 * and the user is asked to approve it. Nothing in the project changes here.
 */
export async function runTestStage(
  ctx: AgentTurnContext,
  plan: Extract<TurnPlan, { stage: 'test' }>
): Promise<AgentExecutionResponse> {
  const { prompt, tier, mode, isTurkish, ragRulesConsulted, requestModel } = ctx
  const tools = PlcAgentTools.getInstance()
  const contents: GeminiContent[] = plan.correctionOf
    ? [
        ...plan.correctionOf.contents,
        {
          role: 'user',
          parts: [{ text: `The user did not approve this test and says:\n${plan.correctionOf.correction}\n\nSend the corrected test in the same form.` }]
        }
      ]
    : [{ role: 'user', parts: [{ text: `CURRENT PROJECT:\n${tools.describeProjectForModel()}\n\nUSER REQUEST:\n${prompt}\n\n${TEST_FIRST_REQUEST}` }] }]
  const existingTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
  const userIo = Array.from(extractBitAddresses(prompt, 'IQ'))
  const askedOnce = new Set<string>()
  const executed: AgentToolCall[] = []
  const toolResults: AgentToolResult[] = []
  let rawText = ''
  let problems: string[] = []
  const respond = (fields: Partial<AgentExecutionResponse> & { replyText: string }): AgentExecutionResponse => ({
    tier,
    providerUsed: ctx.provider,
    toolCallsExecuted: executed,
    toolResults,
    ragRulesConsulted,
    rawTraceSnippet: rawText.substring(0, 300),
    ...fields
  })

  let repairRounds = 0
  let readRounds = 0
  while (repairRounds < MAX_TEST_ROUNDS && repairRounds + readRounds < MAX_TEST_ROUNDS + MAX_READ_ROUNDS) {
    rawText = await requestModel(contents)
    contents.push({ role: 'model', parts: [{ text: rawText }] })
    const extracted = extractValidJsonBlock(rawText)
    const parsed = extracted?.json && typeof extracted.json === 'object' ? (extracted.json as Record<string, unknown>) : undefined
    if (!parsed) {
      const text = rawText.trim()
      // A plain answer to a question
      if (!text.startsWith('{') && !text.startsWith('```')) return respond({ replyText: text })
      problems = ['Your reply was not valid JSON and may have been cut off. Send a shorter, complete JSON object.']
    } else {
      const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : ''
      const calls = (Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []) as AgentToolCall[]
      const reads = calls.filter((c) => READ_ONLY_TOOLS.has(String(c?.tool)))
      const changingTools = calls.length - reads.length
      const hasCircuit =
        (typeof parsed.dsl === 'string' && parsed.dsl.trim() !== '') || (Array.isArray(parsed.networks) && parsed.networks.length > 0)
      if (reads.length > 0 && parsed.verification === undefined && !hasCircuit && readRounds < MAX_READ_ROUNDS) {
        const result = await tools.executeToolBatch(reads, mode, { skipSnapshot: true })
        executed.push(...reads)
        toolResults.push(...result.results)
        contents.push({ role: 'user', parts: [{ text: `TOOL RESULTS:\n${JSON.stringify(result.results)}` }] })
        readRounds++
        continue
      }
      if (parsed.verification === undefined && !hasCircuit && changingTools === 0) {
        const note = isTurkish ? 'Projede değişiklik yapılmadı.' : 'No changes were made to the project.'
        return respond({ replyText: `${explanation || rawText}\n\n*${note}*` })
      }
      const proposal = validateTestProposal(parsed, existingTags, userIo, askedOnce)
      problems = [
        ...(hasCircuit
          ? ['Do not write the circuit yet: send only "explanation", "tagsToUpsert" and "verification". The circuit comes after the user approves the test.']
          : []),
        ...(changingTools > 0 ? ['Do not use tools that change the project yet. Only the test is asked for now.'] : []),
        ...proposal.problems
      ]
      if (problems.length === 0 && proposal.test) {
        ctx.onTestProposed({ prompt, tier, test: proposal.test, tags: proposal.tags, contents })
        BlackBoxLogger.getInstance().log('AI_PARSE_AND_AST_INJECTION', `Test proposed for approval: ${countExpectations(proposal.test)} checks`, {
          test: proposal.test,
          tags: proposal.tags
        })
        return respond({
          replyText: formatTestForUser(explanation, proposal.test, proposal.tags, isTurkish),
          pendingTest: { test: proposal.test, tags: proposal.tags }
        })
      }
    }
    repairRounds++
    BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Test proposal rejected, round ${repairRounds}`, { problems })
    contents.push({ role: 'user', parts: [{ text: `The test was not accepted:\n${problems.join('\n')}` }] })
  }

  // A failed correction keeps the test that was waiting, so the user can still approve it
  const details = problems.map((p) => `- ${p}`).join('\n')
  return respond({
    replyText: isTurkish
      ? `Model ${MAX_TEST_ROUNDS} denemede onaylanabilir bir test yazamadı. Projede değişiklik yapılmadı.\n\n${details}`
      : `The model did not write a test that can be approved in ${MAX_TEST_ROUNDS} attempts. The project was not changed.\n\n${details}`,
    isError: true,
    errorDetails: details
  })
}

/**
 * Model, tools, compiler and simulator in a loop. A reply is applied as a whole and kept only if it compiles
 * without new errors and behaves as its test says. Otherwise the project goes back to where it was and the
 * model gets the errors.
 */
export async function runAgentLoop(
  ctx: AgentTurnContext,
  /** Test first: the approved test judges the circuit, and the model's own test is ignored */
  approved?: Extract<TurnPlan, { stage: 'circuit' }>
): Promise<AgentExecutionResponse> {
  const { prompt, tier, mode, isTurkish, ragRulesConsulted, requestModel } = ctx
  const tools = PlcAgentTools.getInstance()
  const turnStart = tools.takeSnapshot()
  // Motion control is not in this IDE. The user must hear it even when the last reply forgets to say so
  const motionBlocks = Array.from(new Set(prompt.match(/\bMC_[A-Za-z]+\b/g) || []))
  const motionNote =
    motionBlocks.length > 0 || /teknoloji objesi|technology object|\bTO_Axis/i.test(prompt)
      ? isTurkish
        ? `**Yapılamayan:** İstek motion kontrolü istiyor (${motionBlocks.join(', ') || 'teknoloji objesi'}). Bu IDE'de teknoloji objesi ve MC_ blokları yok: devrede bulunmuyorlar, eksen hiç hareket ettirilmiyor ve bu kısım simülatörde test edilmedi. MC bloklarını TIA Portal'da eklemeniz ve adım geçişlerini onların Done çıkışlarına bağlamanız gerekir.`
        : `**Not done:** The request needs motion control (${motionBlocks.join(', ') || 'technology object'}). This IDE has no technology objects or MC_ blocks: they are not in the circuit, no axis is moved and this part was not tested. Add the MC blocks in TIA Portal and make the steps wait for their Done outputs.`
      : ''
  // Tags the last applied circuit could not keep at the address the model gave
  let appliedMoves: AddressMove[] = []
  const addressMovesNote = (fromDsl: AddressMove[] = []): string => {
    const moves = [...fromDsl, ...appliedMoves]
    if (moves.length === 0) return ''
    const why = (m: AddressMove): string =>
      m.takenBy === RESERVED_BYTE_OCCUPANT
        ? isTurkish
          ? "CPU'nun clock/system memory baytı"
          : 'clock/system memory byte of the CPU'
        : isTurkish
          ? `${m.takenBy} kullanıyordu`
          : `used by ${m.takenBy}`
    const list = moves.map((m) => `- ${m.name}: ${m.from} → ${m.to} (${why(m)})`).join('\n')
    return isTurkish
      ? `**Adres değişikliği:** Bazı etiketler modelin verdiği adreste tutulamadı:\n${list}`
      : `**Address change:** Some tags could not keep the address the model gave:\n${list}`
  }
  // A built-in scenario's acceptance tests, when the request is that scenario
  const gate: AcceptanceGate = ctx.acceptanceGate || 'report'
  const scenarioMatch = gate === 'off' ? { ambiguous: [] as Scenario[] } : matchScenario(prompt, SCENARIOS)
  const scenario = scenarioMatch.scenario
  const ambiguousNote = scenarioMatch.ambiguous.length
    ? isTurkish
      ? `**Kabul testi uygulanmadı:** İstek birden çok hazır senaryoya benziyor (${scenarioMatch.ambiguous.map((s) => s.id).join(', ')}).`
      : `**Acceptance test not run:** The request looks like more than one built-in scenario (${scenarioMatch.ambiguous.map((s) => s.id).join(', ')}).`
    : ''
  let acceptance: AcceptanceSummary | undefined
  const userIo = Array.from(extractBitAddresses(prompt, 'IQ'))
  const userIoNotUsed = (): string[] => {
    const used = new Set(
      useTagStore
        .getState()
        .tagTables.flatMap((t) => t.tags)
        .map((t) => `%${(t.address || '').replace(/[\s%]/g, '').toUpperCase()}`)
    )
    return userIo.filter((a) => !used.has(a))
  }
  const userAsked = (warning: string): boolean => {
    const used = warning.match(/uses %([IQM]\d+\.\d+)/i)
    if (!used) return false
    return new RegExp(`(^|[^A-Za-z0-9_.])%?${used[1].replace('.', '\\.')}(?![0-9])`, 'i').test(prompt)
  }
  const reportBefore = tools.runCompilerVerification()
  const errorsBefore = new Set(reportBefore.errors)
  const warningsBefore = new Set(reportBefore.warnings)
  // Things that are unusual but can be right: the model is asked once and believed if it repeats them
  const askedOnce = new Set<string>()
  // The most checks any test of this turn had. A retry should fix the circuit, not drop checks
  let strongestTest = 0
  const approvedPart = approved ? `\n\n${approvedTestRequest(approved.test, approved.tags)}` : ''
  const contents: GeminiContent[] = [
    { role: 'user', parts: [{ text: `CURRENT PROJECT:\n${tools.describeProjectForModel()}\n\nUSER REQUEST:\n${prompt}${approvedPart}` }] }
  ]
  const executed: AgentToolCall[] = []
  const toolResults: AgentToolResult[] = []
  let lastProblems: string[] = []
  let rawText = ''
  let rawJson: string | undefined
  // The last circuit that compiled cleanly and failed only its simulation test. The test may be what is wrong,
  // so when the rounds run out it is offered for review instead of being lost
  let candidate:
    | { circuit: AiCircuitSynthesisPayload; problems: string[]; round: number; acceptance?: AcceptanceSummary }
    | undefined

  const keepBestCandidate = (
    circuit: AiCircuitSynthesisPayload,
    failed: string[],
    roundNum: number,
    acc?: AcceptanceSummary
  ): void => {
    if (!candidate || failed.length <= candidate.problems.length) {
      candidate = { circuit, problems: failed, round: roundNum, acceptance: acc }
    }
  }

  const respond = (fields: Partial<AgentExecutionResponse> & { replyText: string }): AgentExecutionResponse => ({
    tier,
    providerUsed: ctx.provider,
    toolCallsExecuted: executed,
    toolResults,
    ragRulesConsulted,
    rawTraceSnippet: rawText.substring(0, 300),
    rawJson,
    ...fields
  })

  let round = 0
  let readRounds = 0
  while (round < MAX_AGENT_ROUNDS && round + readRounds < MAX_AGENT_ROUNDS + MAX_READ_ROUNDS) {
    rawText = await requestModel(contents)
    contents.push({ role: 'model', parts: [{ text: rawText }] })
    const reply = interpretModelReply(rawText, !!approved)
    rawJson = reply.rawJson
    const behaviorTest = approved ? approved.test : reply.behaviorTest

    let weakerTestNote = ''
    if (reply.behaviorTest) {
      const checks = countExpectations(reply.behaviorTest)
      if (reply.problems.length === 0 && reply.circuit && checks < strongestTest) {
        if (!askedOnce.has('weaker test')) {
          askedOnce.add('weaker test')
          reply.problems.push(
            `Your test checks ${checks} values, your earlier test checked ${strongestTest}. Do not remove checks to make a test pass: fix the circuit. If an earlier check was really wrong, send the same answer again.`
          )
        } else {
          weakerTestNote = isTurkish
            ? `**Uyarı:** Model testi denemeler arasında zayıflattı (${strongestTest} kontrolden ${checks} kontrole). Kaldırılan davranışlar doğrulanmadı.`
            : `**Warning:** The model weakened its test between attempts (from ${strongestTest} to ${checks} checks). The removed behaviour was not verified.`
        }
      }
      strongestTest = Math.max(strongestTest, checks)
    }

    if (reply.problems.length > 0) {
      lastProblems = reply.problems
      round++
      BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Agent reply rejected before applying, round ${round}`, {
        problems: reply.problems
      })
      contents.push({ role: 'user', parts: [{ text: `Nothing was applied.\n${reply.problems.join('\n')}` }] })
      continue
    }

    const writes = reply.toolCalls.filter((c) => !READ_ONLY_TOOLS.has(c.tool))
    // Ladder has no call instruction, so a block the agent writes runs nowhere
    const neverCalledNote = writes.some((c) => c.tool === 'create_or_update_scl_block')
      ? isTurkish
        ? '**Not:** Oluşturulan FB/FC hiçbir yerden çağrılmıyor, çünkü bu IDE\'de ladder FB veya FC çağıramaz. Simülatörde çalışmaz ve test edilmedi. TIA\'da OB1\'den çağırmanız gerekir.'
        : '**Note:** The FB/FC that was created is not called from anywhere, because ladder in this IDE cannot call an FB or FC. It does not run on the simulator and was not tested. Call it from OB1 in TIA.'
      : ''
    const changesProject = writes.length > 0 || reply.circuit !== undefined

    // Only reads: answer them without spending circuit repair rounds (bounded by MAX_READ_ROUNDS)
    if (reply.toolCalls.length > 0 && !changesProject) {
      if (readRounds >= MAX_READ_ROUNDS) {
        round++
        lastProblems = ['Read tool round limit reached; send the circuit or answer now.']
        contents.push({ role: 'user', parts: [{ text: lastProblems[0] }] })
        continue
      }
      const reads = await tools.executeToolBatch(reply.toolCalls, mode, { skipSnapshot: true })
      executed.push(...reply.toolCalls)
      toolResults.push(...reads.results)
      contents.push({ role: 'user', parts: [{ text: `TOOL RESULTS:\n${JSON.stringify(reads.results)}` }] })
      readRounds++
      continue
    }

    if (!changesProject) {
      const note = isTurkish ? 'Projede değişiklik yapılmadı.' : 'No changes were made to the project.'
      return respond({ replyText: `${reply.explanation || rawText}\n\n*${note}*` })
    }

    // Apply the whole reply
    const problems: string[] = []
    const lines: string[] = []
    const staged: NonNullable<AgentExecutionResponse['stagedChangeset']> = []
    const protectedTagNames = new Set<string>([
      ...(approved?.tags || []).map((t) => t.name.toLowerCase()),
      ...(behaviorTest?.steps || []).flatMap((s) => Object.keys(s.expect || {}).map((k) => k.replace(/"/g, '').trim().toLowerCase()))
    ])
    let effectiveCircuit = reply.circuit
    if (mode === 'auto-apply') tools.holdDiskWrites()
    try {
      if (reply.toolCalls.length > 0) {
        const batch = await tools.executeToolBatch(reply.toolCalls, mode, { skipSnapshot: true })
        executed.push(...reply.toolCalls)
        toolResults.push(...batch.results)
        staged.push(...(batch.stagedChangeset || []))
        for (const result of batch.results) {
          if (!result.success) problems.push(`${result.tool}: ${result.message}`)
          else if (!READ_ONLY_TOOLS.has(result.tool)) lines.push(`- ${result.message}`)
        }
      }
      appliedMoves = []
      if (reply.circuit && problems.length === 0) {
        const applied = applyCircuitPayload(reply.circuit, mode, { skipSnapshot: true, protectedTagNames })
        appliedMoves = applied.addressMoves
        effectiveCircuit = applied.effectiveCircuit
        lines.unshift(applied.summaryText)
        staged.push(...(applied.stagedChangeset || []))
      } else if (!reply.circuit && reply.explanation) {
        lines.unshift(reply.explanation, '')
      }

      if (mode === 'diff-view' && problems.length === 0) {
        // Try the staged circuit on the project for a moment. New tools are not applied yet, so it cannot run with them
        let behaviorNote = ''
        let trialUserIoNote = ''
        let trialAddressNote = ''
        if (reply.circuit && writes.length === 0) {
          tools.holdDiskWrites()
          const trialApplied = applyCircuitPayload(reply.circuit, 'auto-apply', { trialRun: true, protectedTagNames })
          appliedMoves = trialApplied.addressMoves
          effectiveCircuit = trialApplied.effectiveCircuit
          const trialReport = tools.runCompilerVerification()
          const trialNewErrors = trialReport.errors.filter((e) => !errorsBefore.has(e))
          const trialNewAddressWarnings = trialReport.warnings.filter(
            (w) => (w.includes('[S7-IO-009]') || w.includes('[S7-MEM-001]')) && !warningsBefore.has(w)
          )
          const trialWarningsToAsk = trialNewAddressWarnings.filter((w) => !userAsked(w))
          const trialUserIoMissing = userIoNotUsed()
          if (trialNewErrors.length > 0) {
            tools.discardDiskWrites()
            tools.restoreSnapshot(turnStart)
            problems.push(...trialNewErrors)
          } else if (trialWarningsToAsk.length > 0 && !askedOnce.has('address warning')) {
            askedOnce.add('address warning')
            tools.discardDiskWrites()
            tools.restoreSnapshot(turnStart)
            problems.push(
              ...trialWarningsToAsk,
              'Use a free address that exists on this CPU. If the user asked for this address, has an expansion module or really wants two tags on one address, send the same answer again.'
            )
          } else if (trialUserIoMissing.length > 0 && !askedOnce.has('user io')) {
            askedOnce.add('user io')
            tools.discardDiskWrites()
            tools.restoreSnapshot(turnStart)
            problems.push(
              `The user's I/O list names ${trialUserIoMissing.join(', ')}, but no tag uses these addresses. Keep every signal on the address the user gave, even one this CPU lacks: a signal module gives that channel, while a signal moved to M is wired to nothing. If the user really does not need these signals, send the same answer again.`
            )
          } else {
            const moved = approved ? approvedTagsMoved(approved.tags, useTagStore.getState().tagTables.flatMap((t) => t.tags)) : []
            const behavior = moved.length
              ? { problems: moved, note: '' }
              : checkCircuitBehavior(behaviorTest, askedOnce, isTurkish, effectiveCircuit, !!approved)
            // The acceptance test runs only on a circuit that passed its own test, as in auto-apply
            const judged = behavior.problems.length === 0 && scenario ? judgeAcceptance(scenario, gate, isTurkish) : undefined
            tools.discardDiskWrites()
            tools.restoreSnapshot(turnStart)
            const failed = [...behavior.problems, ...(judged?.problems || [])]
            problems.push(...failed)
            if (failed.length > 0) keepBestCandidate(effectiveCircuit || reply.circuit, failed, round + 1, judged?.summary)
            if (judged) acceptance = judged.summary
            behaviorNote = [behavior.note, judged?.note].filter(Boolean).join('\n\n')
            if (trialUserIoMissing.length > 0) {
              trialUserIoNote = isTurkish
                ? `**Adres:** Listenizdeki ${trialUserIoMissing.join(', ')} adreslerini hiçbir etiket kullanmıyor. Bu sinyaller devrede yok ya da başka bir adrese (ör. M bitine) taşındı; fiziksel olarak bağlı değiller.`
                : `**Address:** No tag uses ${trialUserIoMissing.join(', ')} from your I/O list. These signals are missing or were moved to another address (for example an M bit), so they are not wired.`
            }
            if (trialNewAddressWarnings.length > 0) {
              const moduleNote = trialNewAddressWarnings.some(userAsked)
                ? isTurkish
                  ? '**Adres:** İstediğiniz adreslerin bazıları bu CPU\'nun kendi kanallarında yok. Gerçek sistemde bir sinyal modülü (SM) gerekir; donanım yapılandırmasına ekleyin.'
                  : '**Address:** Some addresses you asked for are not channels of this CPU. A real system needs a signal module (SM); add it to the hardware configuration.'
                : ''
              trialAddressNote = [moduleNote, trialNewAddressWarnings.map((w) => `- ${w}`).join('\n')].filter(Boolean).join('\n\n')
            }
          }
        } else if (reply.circuit) {
          behaviorNote = isTurkish
            ? '**Simülasyon testi:** Bu yanıt yeni blok veya etiket de oluşturduğu için onaydan önce çalıştırılamadı, devrenin davranışı doğrulanmadı.'
            : '**Simulation test:** This reply also creates blocks or tags, so it could not run before approval and the behaviour was not verified.'
        }
        if (problems.length === 0) {
          const coalesced = coalesceStagedChangeset(staged)
          const note = isTurkish
            ? 'Derleyici kontrolü onaydan sonra çalışır.'
            : 'The compiler check runs after you approve the changes.'
          const parts = [
            lines.join('\n'),
            trialAddressNote,
            behaviorNote,
            ambiguousNote,
            weakerTestNote,
            neverCalledNote,
            motionNote,
            trialUserIoNote,
            addressMovesNote(reply.addressMoves),
            `*${note}*`
          ].filter(Boolean)
          return respond({ replyText: parts.join('\n\n'), stagedChangeset: coalesced, acceptanceReport: acceptance })
        }
      }

      if (problems.length === 0) {
        const report = tools.runCompilerVerification()
        const newErrors = report.errors.filter((e) => !errorsBefore.has(e))
        // TIA accepts a bit with no channel and overlapping tags, so these are questions and not errors
        const newAddressWarnings = report.warnings.filter(
          (w) => (w.includes('[S7-IO-009]') || w.includes('[S7-MEM-001]')) && !warningsBefore.has(w)
        )
        problems.push(...newErrors)
        // The approved test's tags are fixed, so a moved one is an error, not a question
        if (newErrors.length === 0 && reply.circuit && approved) {
          problems.push(...approvedTagsMoved(approved.tags, useTagStore.getState().tagTables.flatMap((t) => t.tags)))
        }
        // The user's I/O list is the plant's wiring. A channel the CPU lacks then needs a signal module, not a new address
        const warningsToAsk = newAddressWarnings.filter((w) => !userAsked(w))
        if (newErrors.length === 0 && warningsToAsk.length > 0 && !askedOnce.has('address warning')) {
          askedOnce.add('address warning')
          problems.push(
            ...warningsToAsk,
            'Use a free address that exists on this CPU. If the user asked for this address, has an expansion module or really wants two tags on one address, send the same answer again.'
          )
        }
        // The user's I/O list is the wiring. A signal moved off it (often to M, when the CPU lacks the channel) is not wired
        const userIoMissing = reply.circuit ? userIoNotUsed() : []
        if (problems.length === 0 && userIoMissing.length > 0 && !askedOnce.has('user io')) {
          askedOnce.add('user io')
          problems.push(
            `The user's I/O list names ${userIoMissing.join(', ')}, but no tag uses these addresses. Keep every signal on the address the user gave, even one this CPU lacks: a signal module gives that channel, while a signal moved to M is wired to nothing. If the user really does not need these signals, send the same answer again.`
          )
        }
        const userIoNote = userIoMissing.length
          ? isTurkish
            ? `**Adres:** Listenizdeki ${userIoMissing.join(', ')} adreslerini hiçbir etiket kullanmıyor. Bu sinyaller devrede yok ya da başka bir adrese (ör. M bitine) taşındı; fiziksel olarak bağlı değiller.`
            : `**Address:** No tag uses ${userIoMissing.join(', ')} from your I/O list. These signals are missing or were moved to another address (for example an M bit), so they are not wired.`
          : ''
        let behaviorNote = ''
        if (problems.length === 0 && reply.circuit) {
          const behavior = checkCircuitBehavior(behaviorTest, askedOnce, isTurkish, effectiveCircuit, !!approved)
          // The circuit passed its own test: now the specification's. Under report the model never hears of it
          const judged = behavior.problems.length === 0 && scenario ? judgeAcceptance(scenario, gate, isTurkish) : undefined
          if (judged) acceptance = judged.summary
          const failed = [...behavior.problems, ...(judged?.problems || [])]
          problems.push(...failed)
          behaviorNote = [behavior.note, judged?.note]
            .filter(Boolean)
            .map((n) => `\n\n${n}`)
            .join('')
          // A reply that also writes blocks or tags cannot be offered as one staged circuit
          if (failed.length > 0 && writes.length === 0) {
            keepBestCandidate(effectiveCircuit || reply.circuit, failed, round + 1, judged?.summary)
          }
        }
        if (problems.length === 0) {
          tools.releaseDiskWrites()
          tools.setUndoSnapshot(turnStart)
          const older = report.errors.length
            ? ` ${report.errors.length} error(s) were already in the project before this change.`
            : ''
          const moduleNote = newAddressWarnings.some(userAsked)
            ? isTurkish
              ? '\n\n**Adres:** İstediğiniz adreslerin bazıları bu CPU\'nun kendi kanallarında yok. Gerçek sistemde bir sinyal modülü (SM) gerekir; donanım yapılandırmasına ekleyin.'
              : '\n\n**Address:** Some addresses you asked for are not channels of this CPU. A real system needs a signal module (SM); add it to the hardware configuration.'
            : ''
          const addressNote = newAddressWarnings.length
            ? `${moduleNote}\n\n${newAddressWarnings.map((w) => `- ${w}`).join('\n')}`
            : ''
          return respond({
            replyText: [
              `${lines.join('\n')}\n\n**Compiler:** no new errors, ${report.warnings.length} warning(s).${older}${addressNote}${behaviorNote}`,
              ambiguousNote,
              weakerTestNote,
              neverCalledNote,
              motionNote,
              userIoNote,
              addressMovesNote(reply.addressMoves)
            ]
              .filter(Boolean)
              .join('\n\n'),
            compilerVerification: { success: report.success, message: report.message },
            acceptanceReport: acceptance
          })
        }
      }
    } catch (err) {
      if (isAgentAbortError(err, ctx.signal)) {
        tools.discardDiskWrites()
        tools.restoreSnapshot(turnStart)
        throw err
      }
      problems.push(err instanceof Error ? err.message : String(err))
    }

    round++
    tools.discardDiskWrites()
    tools.restoreSnapshot(turnStart)
    lastProblems = problems
    BlackBoxLogger.getInstance().log('AI_FALLBACK_OR_RETRY', `Agent reply undone, round ${round}`, { problems })
    contents.push({
      role: 'user',
      parts: [{ text: `Your reply was undone because of these errors. Send the complete corrected answer.\n${problems.join('\n')}` }]
    })
  }

  const details = lastProblems.map((p) => `- ${p}`).join('\n')
  if (candidate) {
    let staged: AgentExecutionResponse['stagedChangeset']
    try {
      staged = applyCircuitPayload(candidate.circuit, 'diff-view').stagedChangeset
    } catch {
      staged = undefined
    }
    if (staged && staged.length > 0) {
      const failed = candidate.problems.map((p) => `- ${p}`).join('\n')
      // Under enforce a circuit can pass its own test and fail the specification's
      const failedSpec = !!candidate.acceptance && candidate.acceptance.failedSpec.length > 0 && gate === 'enforce'
      const intro = isTurkish
        ? failedSpec
          ? `Model ${MAX_AGENT_ROUNDS} denemede spesifikasyonun kabul testini geçemedi (${formatAcceptanceLine(candidate.acceptance as AcceptanceSummary, isTurkish)}). **Projede değişiklik yapılmadı.**\n\n` +
            `${candidate.round}. denemenin devresi derleyiciden ve modelin kendi testinden geçti, kabul testinde kaldı. `
          : `Model ${MAX_AGENT_ROUNDS} denemede kendi simülasyon testini geçemedi. **Projede değişiklik yapılmadı.**\n\n` +
            `${candidate.round}. denemenin devresi derleyiciden hatasız geçti, yalnızca testte kaldı. Hata devrede de olabilir, modelin testinde de. `
        : failedSpec
          ? `The model did not pass the specification's acceptance test in ${MAX_AGENT_ROUNDS} attempts (${formatAcceptanceLine(candidate.acceptance as AcceptanceSummary, isTurkish)}). **The project was not changed.**\n\n` +
            `The circuit of attempt ${candidate.round} compiled and passed the model's own test, but failed the acceptance test. `
          : `The model did not pass its own simulation test in ${MAX_AGENT_ROUNDS} attempts. **The project was not changed.**\n\n` +
            `The circuit of attempt ${candidate.round} compiled without errors and failed only the test. The fault may be in the circuit or in the model's test. `
      return respond({
        replyText: isTurkish
          ? `${intro}Bu devre onay penceresinde öneri olarak duruyor: aşağıdaki kontrolleri okuyup kendiniz karar verin.\n\n${failed}`
          : `${intro}It is offered for review in the approval window: read the checks below and decide yourself.\n\n${failed}`,
        acceptanceReport: candidate.acceptance,
        stagedChangeset: staged,
        isError: true,
        errorDetails: details
      })
    }
  }
  return respond({
    replyText: isTurkish
      ? `Model ${MAX_AGENT_ROUNDS} denemede çalışan bir sonuç üretemedi. Projede değişiklik yapılmadı.\n\n${details}`
      : `The model did not reach a working result in ${MAX_AGENT_ROUNDS} attempts. The project was not changed.\n\n${details}`,
    isError: true,
    errorDetails: details
  })
}
