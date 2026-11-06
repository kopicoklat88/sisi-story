import { GoogleGenAI } from '@google/genai'
import { GEMINI_LIBRARY_VOICES, GEMINI_VOICES, geminiVoiceName, geminiVoiceTone } from '@shared/models'
import type { KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
import { getSecret, requireSecret } from '../secrets'
import { getSettings, readCache, writeCache } from '../settings'
import { isWav, pcmToWav } from './audio'
import { extractJson } from './json'

function client(key?: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey: key ?? requireSecret('gemini') })
}

export function friendly(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e)
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(msg))
    return new Error('Kunci Gemini ditolak. Periksa kunci di Pengaturan.')
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) return new Error('Kuota Gemini habis atau terlalu banyak permintaan. Coba lagi sebentar.')
  if (/not found|404/i.test(msg)) return new Error(`Model Gemini tidak tersedia untuk kunci ini: ${msg}`)
  return new Error(`Gemini gagal: ${msg}`)
}

export async function testKey(key?: string): Promise<KeyTestResult> {
  const k = key ?? getSecret('gemini')
  if (!k) return { ok: false, message: 'Kunci belum diatur' }
  try {
    const pager = await client(k).models.list({ config: { pageSize: 50 } })
    return { ok: true, message: `Terhubung · ${pager.page.length}+ model tersedia` }
  } catch (e) {
    return { ok: false, message: friendly(e).message }
  }
}

const NOT_TEXT = /tts|embedding|imagen|image|veo|native-audio|live|aqa|transcribe|robotics|computer-use|lyria/i

/** Live model list: 'text' models for writing stories, or 'tts' models for narration. */
export async function listModels(kind: 'text' | 'tts'): Promise<ModelOption[]> {
  const out: ModelOption[] = []
  try {
    const pager = await client().models.list({ config: { pageSize: 200 } })
    for await (const m of pager) {
      const id = (m.name ?? '').replace(/^models\//, '')
      if (!id) continue
      const actions = m.supportedActions ?? []
      if (!actions.includes('generateContent')) continue
      const isTts = /tts/i.test(id)
      if (kind === 'tts' ? !isTts : NOT_TEXT.test(id)) continue
      out.push({
        id,
        name: m.displayName || id,
        description: m.description?.slice(0, 280),
        contextLength: m.inputTokenLimit ?? null,
        priceIn: null,
        priceOut: null,
        tags: kind === 'text' && id.startsWith('gemini') ? ['JSON'] : []
      })
    }
  } catch (e) {
    throw friendly(e)
  }
  // Gemini models first, newest versions first (3.8 before 3.5 before 2.5).
  return out.sort((a, b) => {
    const ga = a.id.startsWith('gemini') ? 0 : 1
    const gb = b.id.startsWith('gemini') ? 0 : 1
    return ga - gb || b.id.localeCompare(a.id, 'en', { numeric: true })
  })
}

/** Structured JSON output; falls back to schema-in-prompt for models without JSON mode (e.g. Gemma). */
export async function generateJson(model: string, system: string, prompt: string, schema: object): Promise<unknown> {
  const ai = client()
  try {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: schema }
    })
    return JSON.parse(res.text ?? '')
  } catch (e) {
    const msg = (e as Error)?.message ?? ''
    if (!/json|schema|mime|not supported|INVALID_ARGUMENT|Unexpected token|Expected/i.test(msg)) throw friendly(e)
  }
  try {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: `${system}\n\nReply with ONE JSON object only (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`
      }
    })
    return extractJson(res.text ?? '')
  } catch (e) {
    throw friendly(e)
  }
}

/** Speaks one narration line. Returns a WAV file (24 kHz mono 16-bit). */
export async function speak(text: string, voice: string, languageCode: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    const res = await client().models.generateContent({
      model: getSettings().geminiTtsModel,
      contents: [
        {
          role: 'user',
          parts: [{ text, speechMetadata: { style: 'natural storytelling narrator, clear and engaging, steady pace' } }]
        }
      ],
      config: {
        abortSignal: signal,
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode,
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
        }
      }
    })
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
    if (!part?.inlineData?.data) throw new Error('Gemini tidak mengirim audio')
    const bytes = Buffer.from(part.inlineData.data, 'base64')
    if (isWav(bytes)) return bytes
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000)
    return pcmToWav(bytes, rate)
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

interface LibraryVoice {
  id?: string
  name?: string
  display_name?: string
  displayName?: string
  description?: string
  persona?: string | string[]
  language_code?: string
  languageCode?: string
}

/**
 * Prebuilt voices from Gemini's Voice Library (GET /v1beta/voices), kept for a day. Falls back to the
 * voices the app ships samples for, plus the classic 30, when the list cannot be fetched.
 */
export async function listVoices(): Promise<VoiceOption[]> {
  const cached = readCache<VoiceOption[]>('voices:gemini')
  if (cached && Date.now() - cached.updatedAt < 24 * 60 * 60 * 1000 && cached.value.length) return cached.value
  const fallback = (): VoiceOption[] => [
    ...GEMINI_LIBRARY_VOICES.map((v) => ({ id: v.id, name: v.name, description: v.tone })),
    ...GEMINI_VOICES.map((v) => ({ id: v.id, name: v.id, description: v.tone }))
  ]
  try {
    const out: VoiceOption[] = []
    let page = ''
    for (let i = 0; i < 10; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/voices?type=prebuilt&page_size=1000${page ? `&page_token=${encodeURIComponent(page)}` : ''}`
      const res = await fetch(url, { headers: { 'x-goog-api-key': requireSecret('gemini') } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { voices?: LibraryVoice[]; next_page_token?: string; nextPageToken?: string }
      for (const v of body.voices ?? []) {
        const id = (v.id ?? v.name ?? '').replace(/^voices\//, '')
        if (!id) continue
        const persona = Array.isArray(v.persona) ? v.persona.join(', ') : v.persona
        out.push({ id, name: v.display_name ?? v.displayName ?? geminiVoiceName(id), description: geminiVoiceTone(id) ?? persona ?? v.description?.slice(0, 80) ?? '' })
      }
      page = body.next_page_token ?? body.nextPageToken ?? ''
      if (!page) break
    }
    if (!out.length) return fallback()
    // Voices with a bundled sample first, then the classic set, then the rest of the library.
    const rank = (id: string): number => (GEMINI_LIBRARY_VOICES.some((v) => v.id === id) ? 0 : GEMINI_VOICES.some((v) => v.id === id) ? 1 : 2)
    out.sort((a, b) => rank(a.id) - rank(b.id))
    writeCache('voices:gemini', out)
    return out
  } catch (e) {
    console.warn('[gemini] voice list:', (e as Error).message)
    return fallback()
  }
}
