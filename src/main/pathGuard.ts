// Keeps every file write inside a project the user opened in this session.
import * as path from 'path'

const openedRoots = new Set<string>()

function normalize(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
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
  const target = path.resolve(rootPath, relativePath.replace(/^[/\\]+/, ''))
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep
  const comparable = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (!comparable(target).startsWith(comparable(prefix))) {
    throw new Error(`Path '${relativePath}' is outside the project`)
  }
  return target
}

/** A file name that comes from project data must be a plain name, not a path. */
export function assertPlainFileName(fileName: string): string {
  if (!fileName || fileName !== path.basename(fileName) || fileName === '.' || fileName === '..' || /[/\\]/.test(fileName)) {
    throw new Error(`Invalid file name '${fileName}'`)
  }
  return fileName
}
