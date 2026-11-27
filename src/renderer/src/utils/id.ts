let monotonicSeq = 0

/**
 * Generates collision-free identifiers across batch operations and fast successive clicks.
 */
export function generateId(prefix: string): string {
  monotonicSeq = (monotonicSeq + 1) >>> 0
  const uuid = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : null
  if (uuid) {
    return `${prefix}_${uuid.slice(0, 8)}_${monotonicSeq}`
  }
  return `${prefix}_${Date.now().toString(36)}_${monotonicSeq}`
}
