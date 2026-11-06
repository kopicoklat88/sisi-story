import { DEFAULT_VISUAL_MODELS, getVisualImageModel, getVisualVideoModel, type VisualProvider } from '@shared/visual'
import type { AppSettings } from '@shared/types'
import { getDb } from './db'

export const DEFAULT_SETTINGS: AppSettings = {
  defaultTtsProvider: 'gemini',
  defaultLanguage: 'id',
  exportFolder: null,
  llmProvider: 'gemini',
  llmModels: { gemini: 'gemini-3.8-flash', openrouter: '', groq: '', custom: '', openai: '' },
  customBaseUrl: '',
  geminiTtsModel: 'gemini-3.8-flash-tts',
  elevenModel: 'eleven_multilingual_v2',
  visualProvider: 'higgsfield',
  visualModels: { ...DEFAULT_VISUAL_MODELS },
  imageModel: DEFAULT_VISUAL_MODELS.higgsfield.image,
  videoModel: DEFAULT_VISUAL_MODELS.higgsfield.video,
  whisperAuto: true
}

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: AppSettings = { ...DEFAULT_SETTINGS, llmModels: { ...DEFAULT_SETTINGS.llmModels }, visualModels: { ...DEFAULT_SETTINGS.visualModels } }
  for (const r of rows) {
    if (!(r.key in out)) continue
    const value = JSON.parse(r.value)
    if (r.key === 'llmModels') out.llmModels = { ...out.llmModels, ...value }
    else if (r.key === 'visualModels') out.visualModels = { ...out.visualModels, ...value }
    else (out as unknown as Record<string, unknown>)[r.key] = value
  }
  // A provider that no longer exists (e.g. from an older build) falls back to Gemini.
  if (!(out.llmProvider in DEFAULT_SETTINGS.llmModels)) out.llmProvider = 'gemini'
  // A provider that no longer exists (e.g. from an older build) falls back to Higgsfield.
  if (!(out.visualProvider in DEFAULT_SETTINGS.visualModels)) out.visualProvider = 'higgsfield'
  // The old flat image/video model settings are the Higgsfield pair; keep them in sync.
  out.visualModels.higgsfield = {
    image: getVisualImageModel('higgsfield', out.visualModels.higgsfield?.image ?? out.imageModel).id,
    video: getVisualVideoModel('higgsfield', out.visualModels.higgsfield?.video ?? out.videoModel)!.id
  }
  out.imageModel = out.visualModels.higgsfield.image
  out.videoModel = out.visualModels.higgsfield.video
  // Models dropped from a provider's catalog fall back to that provider's defaults.
  const gemini = out.visualModels.gemini ?? DEFAULT_SETTINGS.visualModels.gemini
  out.visualModels.gemini = {
    image: getVisualImageModel('gemini', gemini.image).id,
    video: getVisualVideoModel('gemini', gemini.video)!.id
  }
  // ChatGPT Web is image-only; its video slot stays empty.
  const chatgptWeb = out.visualModels['chatgpt-web'] ?? DEFAULT_SETTINGS.visualModels['chatgpt-web']
  out.visualModels['chatgpt-web'] = {
    image: getVisualImageModel('chatgpt-web', chatgptWeb.image).id,
    video: ''
  }
  // OpenAI Images API is image-only too.
  const openai = out.visualModels.openai ?? DEFAULT_SETTINGS.visualModels.openai
  out.visualModels.openai = {
    image: getVisualImageModel('openai', openai.image).id,
    video: ''
  }
  return out
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  // Picking models in the Idea step saves the flat pair; mirror it into the provider map so
  // each provider keeps its own last-picked models. Built incrementally: one patch can carry
  // both models, and the second must not overwrite the first.
  let visualModels = current.visualModels
  getDb().transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue
      if ((k === 'imageModel' || k === 'videoModel') && patch.visualProvider) {
        const provider = patch.visualProvider as VisualProvider
        visualModels = {
          ...visualModels,
          [provider]: { ...visualModels[provider], [k === 'imageModel' ? 'image' : 'video']: v as string }
        }
        stmt.run('visualModels', JSON.stringify(visualModels))
      }
      const value =
        k === 'llmModels' ? { ...current.llmModels, ...(v as object) } : k === 'visualModels' ? { ...visualModels, ...(v as object) } : v
      stmt.run(k, JSON.stringify(value))
    }
  })()
  return getSettings()
}

// ---------- small key/value cache (model lists) ----------

export function readCache<T>(key: string): { value: T; updatedAt: number } | null {
  const row = getDb().prepare('SELECT value, updated_at FROM cache WHERE key = ?').get(key) as
    | { value: string; updated_at: number }
    | undefined
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null
}

export function writeCache(key: string, value: unknown): number {
  const now = Date.now()
  getDb()
    .prepare('INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now)
  return now
}

export function dropCache(prefix: string): void {
  getDb().prepare('DELETE FROM cache WHERE key LIKE ?').run(`${prefix}%`)
}
