/**
 * Test first: the model writes the simulation test from the request before any circuit, the user approves it,
 * and the circuit is then judged by that fixed test. A test the model writes next to its own circuit comes from
 * the same reading as the circuit, so it can be wrong in the same way, and the model can bend it to the circuit.
 * An approved test is an independent judge, and a wrong reading shows before any ladder is written.
 */
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { BehaviorTest, parseBehaviorTest } from './CircuitBehaviorTest'

export interface ProposedTag {
  name: string
  address: string
  dataType: string
  comment?: string
}

export interface TestProposal {
  test?: BehaviorTest
  tags: ProposedTag[]
  problems: string[]
}

/** Appended to the request in the test step */
export const TEST_FIRST_REQUEST = `TEST FIRST: do not write the circuit yet. If the request needs a ladder circuit, reply with only:
- "explanation": how you understood the behaviour, step by step, in the user's language. Name every assumption.
- "tagsToUpsert": every tag your test uses, with its address and data type. Use the addresses the user gave.
- "verification": the simulation test, as described above. It is shown to the user for approval and then fixed: the circuit will be written to pass it and cannot change it.
Write the test from the request, not from a circuit you have in mind: the whole cycle, a repeat of the cycle, stopping, faults and resets the user describes.
Test only tags: inputs you set, and outputs and memory bits you expect. Timers and counters do not exist yet.
Expect a value at least 100 ms after the input change that causes it, never in the same step: a PLC reacts over the following scans.
If the request needs no circuit, answer in "explanation" only.`

/** A tag the test uses, as the test names it */
const clean = (name: string): string => name.replace(/"/g, '').trim()

/** Reads the test step's reply. A problem goes back to the model, an unusual choice is asked about once */
export function validateTestProposal(
  parsed: { verification?: unknown; tagsToUpsert?: unknown },
  existingTags: Array<{ name: string; address: string }>,
  userIo: string[],
  askedOnce: Set<string>
): TestProposal {
  const problems: string[] = []
  const tags: ProposedTag[] = []
  for (const raw of Array.isArray(parsed.tagsToUpsert) ? parsed.tagsToUpsert : []) {
    const tag = raw as Partial<ProposedTag>
    if (typeof tag?.name !== 'string' || typeof tag?.address !== 'string') {
      problems.push('Every entry of "tagsToUpsert" needs a "name" and an "address".')
      continue
    }
    const address = normalizeS7Address(tag.address)
    if (!address.isValid) {
      problems.push(`Tag ${tag.name}: '${tag.address}' is not an S7 address.`)
      continue
    }
    tags.push({ name: clean(tag.name), address: address.address, dataType: tag.dataType || 'BOOL', comment: tag.comment })
  }
  const seen = new Map<string, string>()
  for (const tag of tags) {
    const other = seen.get(tag.address)
    if (other && other.toLowerCase() !== tag.name.toLowerCase()) problems.push(`${tag.name} and ${other} have the same address ${tag.address}.`)
    seen.set(tag.address, tag.name)
  }

  const parsedTest = parseBehaviorTest(parsed.verification)
  problems.push(...parsedTest.problems)
  const test = parsedTest.test
  if (!test) return { tags, problems }

  const tagOf = (name: string): { address: string } | undefined => {
    const n = clean(name).toLowerCase()
    return tags.find((t) => t.name.toLowerCase() === n) || existingTags.find((t) => t.name.toLowerCase() === n)
  }
  // A direct I, Q or M address. "T1.Q" would read as an old timer address, but here it is an instance field
  const isDirectAddress = (name: string): boolean => /^%?[IQM][BWD]?\d+(\.\d+)?$/i.test(clean(name))
  const addressOf = (name: string): string | undefined => {
    const tag = tagOf(name)
    if (tag) return normalizeS7Address(tag.address).address
    return isDirectAddress(name) ? normalizeS7Address(clean(name)).address : undefined
  }
  const unknown = new Set<string>()
  for (const step of test.steps) {
    for (const name of [...Object.keys(step.set || {}), ...Object.keys(step.expect || {})]) {
      if (unknown.has(name)) continue
      if (/\./.test(clean(name)) && !addressOf(name)) {
        problems.push(`'${name}' is a timer, counter or DB field, which does not exist before the circuit. Test the outputs and memory bits it drives instead.`)
        unknown.add(name)
      } else if (!addressOf(name)) {
        problems.push(`'${name}' is not in "tagsToUpsert". Give every tag the test uses with its address.`)
        unknown.add(name)
      }
    }
    for (const name of Object.keys(step.set || {})) {
      const address = addressOf(name)
      if (address && !/^%I/i.test(address)) problems.push(`At ${step.atMs} ms the test sets '${name}' (${address}), but a test can only set inputs (%I).`)
    }
  }
  const sameMoment = test.steps.find((s) => s.set && Object.keys(s.set).length && s.expect && Object.keys(s.expect).length)
  if (sameMoment) {
    problems.push(
      `The step at ${sameMoment.atMs} ms sets inputs and expects values at the same moment. A PLC reacts over the next scans: expect the result in a later step, at least 100 ms after the input changes.`
    )
  }
  if (problems.length > 0) return { tags, problems }

  // Unusual but possibly right: asked once, accepted when the model sends the same again
  const expected = new Set(test.steps.flatMap((s) => Object.keys(s.expect || {})).map((n) => clean(n).toLowerCase()))
  const unchecked = tags.filter((t) => /^%Q/i.test(t.address) && !expected.has(t.name.toLowerCase())).map((t) => t.name)
  if (unchecked.length > 0 && !askedOnce.has('unchecked outputs')) {
    askedOnce.add('unchecked outputs')
    return {
      tags,
      problems: [
        `Your test never expects ${unchecked.join(', ')}. The circuit is judged only by this test, so an output it never checks is never verified. If it really cannot be checked, send the same answer again.`
      ]
    }
  }
  const used = new Set(tags.map((t) => t.address.toUpperCase()))
  const missingIo = userIo.filter((a) => !used.has(a.toUpperCase()))
  if (missingIo.length > 0 && !askedOnce.has('user io')) {
    askedOnce.add('user io')
    return {
      tags,
      problems: [
        `The user's I/O list names ${missingIo.join(', ')}, but no tag of your test has these addresses, so the behaviour that uses them is not tested. If the request really does not need them, send the same answer again.`
      ]
    }
  }
  return { test, tags, problems: [] }
}

const shown = (value: boolean | number): string => (typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
const cell = (map?: Record<string, boolean | number>): string =>
  map && Object.keys(map).length ? Object.entries(map).map(([k, v]) => `${clean(k)}=${shown(v)}`).join(', ') : '–'

/** The test as the user reads it before approving */
export function formatTestForUser(explanation: string, test: BehaviorTest, tags: ProposedTag[], isTurkish: boolean): string {
  const tagRows = tags.map((t) => `| ${t.name} | ${t.address} | ${t.comment || ''} |`)
  const stepRows = test.steps.map((s) => `| ${s.atMs} ms | ${cell(s.set)} | ${cell(s.expect)} |`)
  return isTurkish
    ? [
        '**Önce test:** Devre yazılmadan önce modelin isteği nasıl anladığını kontrol edin.',
        '',
        explanation,
        '',
        '| Etiket | Adres | Açıklama |',
        '|---|---|---|',
        ...tagRows,
        '',
        '| Zaman | Girişler | Beklenen |',
        '|---|---|---|',
        ...stepRows,
        '',
        'Onaylarsanız devre bu teste göre yazılır. Model testi değiştiremez; devre testi geçmeden uygulanmaz. Bir şey yanlışsa ne olması gerektiğini yazın, test düzeltilir.'
      ].join('\n')
    : [
        '**Test first:** Check how the model understood the request before any circuit is written.',
        '',
        explanation,
        '',
        '| Tag | Address | Comment |',
        '|---|---|---|',
        ...tagRows,
        '',
        '| Time | Inputs | Expected |',
        '|---|---|---|',
        ...stepRows,
        '',
        'If you approve, the circuit is written to this test. The model cannot change it, and the circuit is not applied until it passes. If something is wrong, write what should happen and the test is corrected.'
      ].join('\n')
}

/** Appended to the request in the circuit step */
export function approvedTestRequest(test: BehaviorTest, tags: ProposedTag[]): string {
  return `APPROVED TEST: the user approved this simulation test. It is fixed: your circuit must pass it, you cannot change it, and a "verification" in your reply is ignored.
${JSON.stringify(test)}
TAGS of the approved test. Declare them with exactly these names and addresses; you may add other tags:
${tags.map((t) => `TAG ${t.name} ${t.address} ${t.dataType}`).join('\n')}
Now write the circuit.`
}

/** Approved tags the circuit dropped or moved. The test reads tags by name, the plant is wired by address */
export function approvedTagsMoved(tags: ProposedTag[], projectTags: Array<{ name: string; address: string }>): string[] {
  const problems: string[] = []
  for (const tag of tags) {
    const found = projectTags.find((t) => t.name.toLowerCase() === tag.name.toLowerCase())
    if (!found) {
      problems.push(`The approved test uses the tag ${tag.name} (${tag.address}), but your circuit does not declare it.`)
    } else if (normalizeS7Address(found.address).address !== tag.address) {
      problems.push(`${tag.name} must stay at ${tag.address}, as in the approved test, but it is at ${found.address}.`)
    }
  }
  return problems
}
