import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// API keys are stored ENCRYPTED AT REST via the OS keychain (macOS Keychain /
// Windows DPAPI / libsecret), never as plaintext in renderer localStorage and
// never in a WebSocket URL that could be logged. The renderer only ever learns
// whether a key is set — the raw key stays in the main process.

export type SecretName = 'gemini' | 'openai' | 'anthropic'

type Store = Partial<Record<SecretName, string>> // base64 of encrypted bytes

const secretsFile = (): string => join(app.getPath('userData'), 'subtl-secrets.json')

function load(): Store {
  try {
    const f = secretsFile()
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Store) : {}
  } catch {
    return {}
  }
}

function persist(store: Store): void {
  try {
    writeFileSync(secretsFile(), JSON.stringify(store), { mode: 0o600 })
  } catch (e) {
    console.error('[secrets] write failed:', e)
  }
}

/** Encryption is unavailable on a misconfigured Linux (no keyring); guard it. */
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** Save (or, with an empty value, clear) a key. Throws if encryption is off. */
export function setSecret(name: SecretName, value: string): void {
  const store = load()
  if (!value) {
    delete store[name]
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable; refusing to store the key in plaintext.')
    }
    store[name] = safeStorage.encryptString(value).toString('base64')
  }
  persist(store)
}

export function getSecret(name: SecretName): string {
  const enc = load()[name]
  if (!enc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return '' // corrupt/undecryptable (e.g. keychain changed) → treat as unset
  }
}

export function secretStatus(): Record<SecretName, boolean> {
  const store = load()
  return { gemini: !!store.gemini, openai: !!store.openai, anthropic: !!store.anthropic }
}
