/** The AI settings: their defaults, the stored copy without API keys, and the order of Gemini models */

import { AiConfig, DiscoveredModel } from './aiTypes'

const STORAGE_KEY = 'antigravity_ai_config_v1'

export const GEMINI_MODEL_BLACKLIST = [
  'tts',
  'audio',
  'image',
  'imagen',
  'vision',
  'banana',
  'lyria',
  'veo',
  'robotics',
  'research',
  'thinking-exp',
  'embedding',
  'computer-use',
  'live',
  'aqa',
  'whisper'
]

export function isStrictGeminiTextModel(id: string): boolean {
  if (!id) return false
  const lower = id.toLowerCase().replace(/^models\//, '')
  if (!lower.startsWith('gemini-')) return false
  return !GEMINI_MODEL_BLACKLIST.some((term) => lower.includes(term))
}

export const defaultAiConfig: AiConfig = {
  provider: 'gemini',
  geminiApiKey: '',
  openaiApiKey: '',
  openaiEndpoint: 'https://api.openai.com/v1',
  ollamaEndpoint: 'http://localhost:11434',
  selectedModelId: 'gemini-2.5-flash',
  availableModels: [
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview' },
    { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }
  ],
  lastDiscoveryStatus: null,
  fastModel: 'gemini-2.5-flash',
  deepModel: 'gemini-2.5-pro',
  language: 'auto',
  openaiModel: '',
  openaiModels: [],
  requestTimeoutSec: 180,
  testFirst: false,
  acceptanceGate: 'report'
}

// Newer versions first. At one version: flash, then pro (slow), then flash-lite (weakest); a release before its preview
function geminiModelRank(id: string): number[] | null {
  const m = id
    .toLowerCase()
    .replace(/^models\//, '')
    .match(/^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)(.*)$/)
  if (!m) return null
  const family = m[2] === 'flash' ? 0 : m[2] === 'pro' ? 1 : 2
  const release = m[3] === '' ? 0 : /preview|exp/.test(m[3]) ? 2 : 1
  return [-parseFloat(m[1]), family, release]
}

export function sortGeminiModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const ra = geminiModelRank(a.id)
    const rb = geminiModelRank(b.id)
    if (ra && rb) {
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
    } else if (ra) {
      return -1
    } else if (rb) {
      return 1
    }
    return a.id.localeCompare(b.id)
  })
}

/** The text models in a Gemini model list (GET /v1beta/models), best first */
export function geminiTextModels(
  rawModels: Array<{ name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }>
): DiscoveredModel[] {
  // Only models that support 'generateContent', and only text models (no speech, image or research models)
  const models: DiscoveredModel[] = rawModels
    .filter(
      (m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        isStrictGeminiTextModel(m.name.replace(/^models\//, ''))
    )
    .map((m) => {
      const id = m.name.replace(/^models\//, '')
      return { id, displayName: m.displayName || id, description: m.description }
    })
  return sortGeminiModels(models)
}

/** The settings stored by this or an older version, or the defaults */
export function loadStoredAiConfig(): AiConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = { ...defaultAiConfig, ...JSON.parse(saved) }
      // Settings saved by older versions may name the removed offline engine
      if (!parsed.provider || parsed.provider === 'offline_local') parsed.provider = 'gemini'
      // Sanitize selectedModelId and availableModels: purge retired 1.5 and invalid 3.8
      if (parsed.provider === 'gemini') {
        if (
          !isStrictGeminiTextModel(parsed.selectedModelId) ||
          parsed.selectedModelId.includes('1.5')
        ) {
          parsed.selectedModelId = 'gemini-2.5-flash'
        }
        if (Array.isArray(parsed.availableModels)) {
          parsed.availableModels = parsed.availableModels.filter((m: { id: string }) =>
            isStrictGeminiTextModel(m.id) && !m.id.includes('1.5')
          )
          if (parsed.availableModels.length === 0) {
            parsed.availableModels = defaultAiConfig.availableModels
          }
        }
      }
      return parsed
    }
  } catch {
    // fallback to default
  }
  return { ...defaultAiConfig }
}

/** Stores the settings. API keys never go to localStorage; they are held in the main process, encrypted by the OS */
export function storeAiConfig(config: AiConfig): void {
  try {
    const { geminiApiKey: _gemini, openaiApiKey: _openai, ...withoutKeys } = config
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withoutKeys))
  } catch {
    // ignore
  }
}
