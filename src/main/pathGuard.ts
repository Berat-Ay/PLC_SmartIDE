// Keeps every file write inside a project the user opened in this session.
import * as fs from 'fs/promises'
import * as path from 'path'

const openedRoots = new Set<string>()
const approvedOpenRoots = new Set<string>()
const approvedCreateParents = new Set<string>()

function normalize(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export function approveOpenRoot(dir: string): void {
  approvedOpenRoots.add(normalize(dir))
}

export function approveCreateParent(dir: string): void {
  approvedCreateParents.add(normalize(dir))
}

export function assertApprovedOpenRoot(dir: string): void {
  const norm = normalize(dir)
  if (!approvedOpenRoots.has(norm) && !openedRoots.has(norm)) {
    throw new Error(`'${dir}' was not selected via the Open Project dialog`)
  }
}

export function assertApprovedCreateTarget(targetDir: string): void {
  const normTarget = normalize(targetDir)
  for (const parent of approvedCreateParents) {
    const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep
    if (normTarget === parent || normTarget.startsWith(prefix)) {
      return
    }
  }
  throw new Error(`'${targetDir}' is outside approved project parent directories`)
}

export function registerProjectRoot(dir: string): void {
  openedRoots.add(normalize(dir))
}

export function assertProjectRoot(dir: string): void {
  if (!openedRoots.has(normalize(dir))) {
    throw new Error(`'${dir}' is not an open project`)
  }
}

/** Resolves a project-relative path. A leading slash means the project root, as agent tools write it. */
export function resolveInside(root: string, relativePath: string): string {
  const rootPath = path.resolve(root)
  const cleanRel = relativePath.replace(/^[/\\]+/, '')
  if (!cleanRel) {
    throw new Error(`Path '${relativePath}' cannot be empty`)
  }
  const target = path.resolve(rootPath, cleanRel)
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep
  if (!comparable(target).startsWith(comparable(prefix))) {
    throw new Error(`Path '${relativePath}' is outside the project`)
  }
  return target
}

async function resolveCanonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p)
  let current = resolved
  const missingSegments: string[] = []
  let realAncestor: string | null = null
  while (true) {
    try {
      realAncestor = await fs.realpath(current)
      break
    } catch {
      const parent = path.dirname(current)
      if (parent === current) break
      missingSegments.unshift(path.basename(current))
      current = parent
    }
  }
  return realAncestor ? path.join(realAncestor, ...missingSegments) : resolved
}

/**
 * Resolves a project-relative path and verifies via realpath that neither existing segments nor
 * symlinks/NTFS junctions escape the real project root.
 */
export async function resolveInsideReal(root: string, relativePath: string): Promise<string> {
  const target = resolveInside(root, relativePath)
  const realRoot = await resolveCanonicalPath(root)
  const realTarget = await resolveCanonicalPath(target)
  const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (!comparable(realTarget).startsWith(comparable(realPrefix))) {
    throw new Error(`Path '${relativePath}' escapes the project via symbolic link`)
  }
  return realTarget
}

/** A file name that comes from project data must be a plain name, not a path or Windows reserved device/ADS. */
export function assertPlainFileName(fileName: string): string {
  if (
    typeof fileName !== 'string' ||
    !fileName ||
    fileName !== path.basename(fileName) ||
    fileName === '.' ||
    fileName === '..' ||
    /[/\\:]/.test(fileName) ||
    /[\x00-\x1f]/.test(fileName) ||
    /[. ]$/.test(fileName) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(fileName)
  ) {
    throw new Error(`Invalid file name '${fileName}'`)
  }
  return fileName
}
