import type { CrossReferenceItem } from '../../../shared/types/crossref'
import type { DataBlockDefinition } from '../../../shared/types/blocks'

/**
 * Removes one or more trailing `.db.json` suffixes so canonical names and legacy
 * doubled filenames normalize cleanly.
 */
export function stripDbExtension(raw: string): string {
  return (raw || '').trim().replace(/(\.db\.json)+$/i, '')
}

/**
 * Returns `<base>.db.json` with exactly one `.db.json` extension.
 */
export function normalizeDbFileName(raw: string): string {
  const base = stripDbExtension(raw)
  return base ? `${base}.db.json` : ''
}

export interface ResolvedDbTab {
  id: string
  title: string
  type: 'db'
  targetId: string
}

/**
 * Resolves a DB Cross-Reference entry to the exact EditorTab shape expected by
 * ProjectTree / EditorWorkspace (`tab_db_<db.fileName>`), even if the DB was renamed
 * (`db.name !== db.fileName`) or a legacy reference carries `.db.json.db.json`.
 */
export function resolveDbCrossReferenceTab(
  ref: Pick<CrossReferenceItem, 'sourceObject' | 'sourceObjectId'>,
  dataBlocks: DataBlockDefinition[] | Record<string, DataBlockDefinition>
): ResolvedDbTab {
  const candidates = [ref.sourceObjectId, ref.sourceObject].filter(Boolean) as string[]
  const normalizedCandidates = new Set<string>()
  for (const c of candidates) {
    normalizedCandidates.add(c.toLowerCase())
    normalizedCandidates.add(stripDbExtension(c).toLowerCase())
    normalizedCandidates.add(normalizeDbFileName(c).toLowerCase())
  }

  const allDbs = Array.isArray(dataBlocks) ? dataBlocks : Object.values(dataBlocks)
  const matched = allDbs.find((db) => {
    const keys = [
      db.fileName,
      stripDbExtension(db.fileName),
      db.id,
      db.id ? stripDbExtension(db.id) : '',
      db.name,
      stripDbExtension(db.name)
    ]
      .filter((k): k is string => Boolean(k))
      .map((k) => k.toLowerCase())
    return keys.some((k) => normalizedCandidates.has(k))
  })

  if (matched) {
    return {
      id: `tab_db_${matched.fileName}`,
      title: matched.name,
      type: 'db',
      targetId: matched.fileName
    }
  }

  const fallbackFileName = normalizeDbFileName(ref.sourceObjectId || ref.sourceObject)
  return {
    id: `tab_db_${fallbackFileName}`,
    title: ref.sourceObject || stripDbExtension(fallbackFileName),
    type: 'db',
    targetId: fallbackFileName
  }
}
