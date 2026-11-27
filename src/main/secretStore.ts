// Stores API keys encrypted with the operating system's key store, outside the renderer.
import { app, safeStorage } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { SecretStatus } from '../shared/types/ipc'

const ALLOWED_KEYS = new Set(['geminiApiKey', 'openaiApiKey'])
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function storePath(): string {
  return path.join(app.getPath('userData'), 'secrets.json')
}

async function readStore(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(storePath(), 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('secrets.json is not an object, ignoring contents')
      return {}
    }
    return parsed as Record<string, string>
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

/** Internal to main process only; plaintext keys are never returned over IPC. */
export async function getSecret(key: string): Promise<string | null> {
  assertAllowed(key)
  if (!safeStorage.isEncryptionAvailable()) return null
  const stored = (await readStore())[key]
  if (typeof stored !== 'string' || !stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (err) {
    console.warn(`Failed to decrypt stored secret '${key}':`, (err as Error).message)
    return null
  }
}

export async function getSecretStatus(): Promise<SecretStatus> {
  const encryptionAvailable = safeStorage.isEncryptionAvailable()
  if (!encryptionAvailable) {
    return { geminiApiKey: false, openaiApiKey: false, encryptionAvailable: false }
  }
  const [gemini, openai] = await Promise.all([getSecret('geminiApiKey'), getSecret('openaiApiKey')])
  return {
    geminiApiKey: Boolean(gemini),
    openaiApiKey: Boolean(openai),
    encryptionAvailable: true
  }
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
    const tempPath = `${storePath()}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(tempPath, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 })
    const delays = [50, 100, 200]
    try {
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          await fs.rename(tempPath, storePath())
          return true
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (attempt < delays.length && code && RETRYABLE_RENAME_CODES.has(code)) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
            continue
          }
          throw err
        }
      }
      return true
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {})
      throw err
    }
  })
  saveQueue = save.catch(() => undefined)
  return save
}
