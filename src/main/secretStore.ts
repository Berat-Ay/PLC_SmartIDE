// Stores API keys encrypted with the operating system's key store, outside the renderer.
import { app, safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'

const ALLOWED_KEYS = new Set(['geminiApiKey', 'openaiApiKey'])

function storePath(): string {
  return path.join(app.getPath('userData'), 'secrets.json')
}

async function readStore(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf-8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // A damaged file must not block saving a key again for good
    if (err instanceof SyntaxError) {
      console.warn('secrets.json is damaged, so stored API keys must be entered again')
      return {}
    }
    throw err
  }
}

// Saves run one at a time. Two saves at once could lose a key or leave a damaged file.
let saveQueue: Promise<unknown> = Promise.resolve()

function assertAllowed(key: string): void {
  if (!ALLOWED_KEYS.has(key)) throw new Error(`Unknown secret '${key}'`)
}

export async function getSecret(key: string): Promise<string | null> {
  assertAllowed(key)
  if (!safeStorage.isEncryptionAvailable()) return null
  const stored = (await readStore())[key]
  if (!stored) return null
  return safeStorage.decryptString(Buffer.from(stored, 'base64'))
}

/** Returns false when the OS offers no encryption; the caller then keeps the key for this session only. */
export async function setSecret(key: string, value: string): Promise<boolean> {
  assertAllowed(key)
  if (!safeStorage.isEncryptionAvailable()) return false
  const save = saveQueue.then(async () => {
    const store = await readStore()
    if (value) store[key] = safeStorage.encryptString(value).toString('base64')
    else delete store[key]
    // The rename means a reader or a crash never meets a half-written file
    const tempPath = `${storePath()}.tmp`
    await fs.writeFile(tempPath, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tempPath, storePath())
    return true
  })
  saveQueue = save.catch(() => undefined)
  return save
}
