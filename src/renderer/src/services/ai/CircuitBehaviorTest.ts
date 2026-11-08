/**
 * Runs a program on a private copy of the simulator and compares it with a timeline.
 * A compiler can only say that a circuit is valid. This says whether it does what was asked.
 *
 * Limit: cyclic interrupt OBs (OB30..OB38) do not run here, only the main cycle and startup OBs.
 */
import { ProjectLoadPayload } from '@shared/types/ipc'
import { parseS7Address } from '@shared/constants/s7rules'
import { PlcRuntimeEngine } from '../../runtime/PlcRuntimeEngine'
import { LadderEvaluator } from '../../runtime/LadderEvaluator'
import { SclInterpreter } from '../../runtime/SclInterpreter'

type BehaviorValue = boolean | number

export interface BehaviorStep {
  atMs: number
  /** Inputs that change at this moment. */
  set?: Record<string, BehaviorValue>
  /** Values that must hold at this moment. */
  expect?: Record<string, BehaviorValue>
}

export interface BehaviorTest {
  steps: BehaviorStep[]
}

export interface BehaviorResult {
  checks: number
  /** The program does not do what the timeline says. */
  failures: string[]
  /** Outputs that were on too briefly to do anything. Rarely wanted, but not always wrong. */
  pulses: string[]
  /** What the program really did, for the model to reason about. */
  timeline: string
  /** Watched values that were on (non-zero) in at least one scan, as named in the test. A one-scan pulse shows here */
  seenOn: string[]
}

const MAX_TEST_MS = 300_000
// The test blocks the UI while it runs. This keeps the longest test under about two seconds
const MAX_SCANS = 3_000
const MIN_SCAN_MS = 10
const MAX_TIMELINE_ENTRIES = 40
const PULSE_SCANS = 2
/** A failed check is watched this many scans more, to tell a late value from a wrong one */
const LATE_SCANS = 3
const INSTANCE_FIELD = /^[A-Za-z0-9_]+\.(Q|ET|QU|QD|CV)$/i

/** Checks the shape of a test from the model. A wrong test is the model's to fix. */
export function parseBehaviorTest(raw: unknown): { test?: BehaviorTest; problems: string[] } {
  const steps = (raw as BehaviorTest | undefined)?.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    return { problems: ['"verification" needs a non-empty "steps" list.'] }
  }

  const isValueMap = (map: unknown): boolean =>
    map === undefined ||
    (typeof map === 'object' &&
      map !== null &&
      Object.values(map).every((v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))))

  const problems: string[] = []
  let previous = -1
  steps.forEach((step: BehaviorStep, index) => {
    const at = step?.atMs
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      problems.push(`verification step ${index + 1}: "atMs" must be a number of milliseconds.`)
      return
    }
    if (at < previous) problems.push(`verification step ${index + 1}: steps must be in time order.`)
    if (at > MAX_TEST_MS) problems.push(`verification step ${index + 1}: a test can last at most ${MAX_TEST_MS} ms.`)
    if (!isValueMap(step.set) || !isValueMap(step.expect)) {
      problems.push(`verification step ${index + 1}: "set" and "expect" map names to true, false or a number.`)
    }
    previous = at
  })
  if (!steps.some((s: BehaviorStep) => s?.expect && Object.keys(s.expect).length > 0)) {
    problems.push('"verification" must expect at least one value.')
  }
  return problems.length > 0 ? { problems } : { test: { steps }, problems: [] }
}

export function runBehaviorTest(test: BehaviorTest, project: ProjectLoadPayload): BehaviorResult {
  const failures: string[] = []
  const pulses: string[] = []
  const tags = new Map(project.tagTables.flatMap((t) => t.tags || []).map((t) => [t.name.toLowerCase(), t]))
  const clean = (name: string): string => name.replace(/"/g, '').trim()
  const addressOf = (name: string): string => tags.get(clean(name).toLowerCase())?.address || clean(name)
  const dataBlocks = new Set((project.dataBlocks || []).map((db) => db.name.toLowerCase()))
  // An unknown instance reads as FALSE, so it must really be in the program or a check on it passes by itself
  const programText = JSON.stringify([project.ladBlocks, project.sclBlocks])
  const isInstanceField = (name: string): boolean =>
    INSTANCE_FIELD.test(name) && new RegExp(`\\b${name.split('.')[0]}\\b`, 'i').test(programText)
  const isKnown = (name: string): boolean =>
    tags.has(clean(name).toLowerCase()) ||
    parseS7Address(clean(name)).isValid ||
    isInstanceField(clean(name)) ||
    dataBlocks.has(clean(name).split('.')[0].toLowerCase())
  const inArea = (name: string, area: string): boolean => {
    const parsed = parseS7Address(addressOf(name))
    return parsed.isValid && parsed.area === area
  }

  for (const step of test.steps) {
    for (const name of Object.keys(step.set || {})) {
      if (!inArea(name, 'I')) failures.push(`At ${step.atMs} ms the test sets '${name}', but a test can only set inputs (%I).`)
    }
    for (const name of Object.keys(step.expect || {})) {
      if (!isKnown(name)) failures.push(`At ${step.atMs} ms the test expects '${name}', which does not exist.`)
    }
  }
  if (failures.length > 0) return { checks: 0, failures, pulses, timeline: '', seenOn: [] }

  const expected = new Set(test.steps.flatMap((s) => Object.keys(s.expect || {})))
  const outputs = project.tagTables
    .flatMap((t) => t.tags || [])
    .filter((t) => parseS7Address(t.address || '').area === 'Q' && parseS7Address(t.address || '').sizeCategory === 'BIT')
    .map((t) => t.name)
  const watched = [...new Set([...outputs, ...expected])]

  const end = test.steps[test.steps.length - 1].atMs
  const scanMs = Math.max(MIN_SCAN_MS, Math.ceil(end / MAX_SCANS))

  // The evaluators keep edge memory in statics, which the live CPU is using
  const restoreLadder = LadderEvaluator.saveInternalStates()
  const restoreScl = SclInterpreter.saveEdgeStates()
  const engine = new PlcRuntimeEngine(structuredClone(project))
  try {
    let now = 1000
    const startedAt = now
    engine.setClock(() => now)
    engine.start({ manualScans: true })

    const last = new Map<string, unknown>()
    const onForScans = new Map<string, number>()
    const seenOn = new Set<string>()
    const changes: string[] = []
    let changeCount = 0
    let checks = 0
    const seconds = (): string => ((now - startedAt) / 1000).toFixed(2)
    const read = (name: string): unknown => engine.getVariable(addressOf(name))
    const matches = (actual: unknown, value: BehaviorValue): boolean =>
      typeof value === 'boolean' ? !!actual === value : Math.abs(Number(actual) - value) <= Math.max(1e-6, Math.abs(value) * 1e-4)
    // A failed check whose value arrives a scan or two later is most often a test that looks too early
    const late: Array<{ failure: number; name: string; value: BehaviorValue; scansLeft: number; scans: number }> = []

    const scan = (): void => {
      engine.scanOnce()
      for (let i = late.length - 1; i >= 0; i--) {
        const pending = late[i]
        pending.scans++
        if (matches(read(pending.name), pending.value)) {
          failures[pending.failure] +=
            ` It becomes ${formatValue(pending.value)} ${pending.scans} scan(s) later, at ${now - startedAt} ms.` +
            ' The program reacts in the scans after an input changes. If that delay is right, check this value later in the test and keep the circuit.'
          late.splice(i, 1)
        } else if (--pending.scansLeft === 0) {
          late.splice(i, 1)
        }
      }
      for (const name of watched) {
        const value = read(name)
        if (value !== last.get(name) && (last.has(name) || value)) {
          changeCount++
          if (changes.length < MAX_TIMELINE_ENTRIES) changes.push(`${seconds()}s ${name}=${formatValue(value)}`)
        }
        last.set(name, value)
        if (value) seenOn.add(name)
        if (outputs.includes(name)) {
          if (value) {
            onForScans.set(name, (onForScans.get(name) || 0) + 1)
          } else {
            const scans = onForScans.get(name) || 0
            if (scans > 0 && scans <= PULSE_SCANS && pulses.length < 5) {
              pulses.push(`Output '${name}' was on for only ${scans} scan(s), ending at ${seconds()} s.`)
            }
            onForScans.set(name, 0)
          }
        }
      }
    }

    for (const step of test.steps) {
      while (now - startedAt + scanMs <= step.atMs) {
        now += scanMs
        scan()
      }
      // A new input could cause the value itself, so a late value is only told before the next change
      if (step.set) late.length = 0
      for (const [name, value] of Object.entries(step.set || {})) engine.setVariable(addressOf(name), value)
      if (step.set) {
        now += scanMs
        scan()
      }
      for (const [name, value] of Object.entries(step.expect || {})) {
        checks++
        const actual = read(name)
        if (actual === undefined) {
          failures.push(`At ${step.atMs} ms the test expects '${name}', which does not exist in the running program.`)
          continue
        }
        if (!matches(actual, value)) {
          failures.push(`At ${step.atMs} ms '${name}' should be ${formatValue(value)} but is ${formatValue(actual)}.`)
          late.push({ failure: failures.length - 1, name, value, scansLeft: LATE_SCANS, scans: 0 })
        }
      }
    }

    // A check that failed at the last step still gets its few scans, only to tell whether its value came late
    for (let i = 0; i < LATE_SCANS && late.length > 0; i++) {
      now += scanMs
      scan()
    }

    const state = engine.getState()
    if (state !== 'RUN') failures.push(`The CPU left RUN and is in ${state}.`)
    for (const diagnostic of engine.getDiagnostics()) {
      if (diagnostic.severity === 'error') failures.push(`CPU: ${diagnostic.message}`)
    }

    const more = changeCount > changes.length ? `\n... and ${changeCount - changes.length} more changes` : ''
    return { checks, failures, pulses, timeline: changes.join('\n') + more, seenOn: Array.from(seenOn) }
  } finally {
    engine.stop()
    restoreLadder()
    restoreScl()
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}
