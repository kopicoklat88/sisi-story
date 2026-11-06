import type { AspectRatio, KeyTestResult } from '@shared/types'
import { getSecret, requireSecret } from '../secrets'
import { friendly } from './gemini'
import { readError, sleep } from './http'

/**
 * Gemini visual generation through the Interactions API (REST), the current interface for
 * Nano Banana images and Omni Flash video. Imagen was shut down 2026-08-17 and Veo 3.1 preview
 * on 2026-10-22, so neither is used here; the old generateVideos/getVideosOperation surface is
 * gone with them.
 *
 * A generation is created with background=true, then polled until the interaction completes;
 * the image/video bytes come back base64 inside the interaction steps (the output_image /
 * output_video convenience fields are SDK-only). No reference upload is needed: reference
 * images travel inline as base64 parts.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
// Sent by the image-generation docs; harmless for video calls too.
const API_REVISION = '2026-05-20'

const NO_MUSIC = 'Silent clip: no background music, no soundtrack, no singing or humming.'

export interface GeminiRef {
  bytes: Buffer
  mime: string
}

interface InteractionContent {
  type: string
  mime_type?: string
  data?: string
  text?: string
}

interface InteractionStep {
  type: string
  content?: InteractionContent[]
}

interface Interaction {
  id: string
  status?: string
  steps?: InteractionStep[]
  errors?: { message?: string; code?: string }[]
}

function headers(key: string): Record<string, string> {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json', 'Api-Revision': API_REVISION }
}

async function call<T>(path: string, init: RequestInit & { key?: string } = {}): Promise<T> {
  const key = init.key ?? requireSecret('gemini')
  const url = path.startsWith('http') ? path : `${BASE}/${path.replace(/^\//, '')}`
  let res: Response
  try {
    res = await fetch(url, { ...init, headers: { ...headers(key), ...(init.headers ?? {}) } })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new Error(`Tidak bisa terhubung ke Gemini: ${(e as Error).message}`)
  }
  if (!res.ok) throw friendly({ message: `HTTP ${res.status}: ${await readError(res)}` } as Error)
  return (await res.json()) as T
}

/** The cheapest authenticated call the API offers; a 200 proves the key works. */
export async function testCredentials(cred?: string): Promise<KeyTestResult> {
  const c = cred ?? getSecret('gemini')
  if (!c) return { ok: false, message: 'Kunci belum diatur' }
  try {
    await call('models?pageSize=1', { key: c })
    return { ok: true, message: 'Terhubung · kunci Gemini valid untuk gambar (Nano Banana) dan video (Omni Flash)' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

type InputPart = { type: 'text'; text: string } | { type: 'image'; mime_type: string; data: string }

function parts(prompt: string, refs: GeminiRef[]): InputPart[] {
  return [
    { type: 'text', text: prompt },
    ...refs.map((r): InputPart => ({ type: 'image', mime_type: r.mime, data: r.bytes.toString('base64') }))
  ]
}

async function createInteraction(body: Record<string, unknown>, signal?: AbortSignal): Promise<Interaction> {
  return call<Interaction>('interactions', { method: 'POST', body: JSON.stringify(body), signal })
}

/** Polls a background interaction until it completes, fails, or times out. */
export async function pollInteraction(
  interactionId: string,
  onTick: (status: string, elapsedMs: number) => void,
  signal?: AbortSignal,
  timeoutMs = 15 * 60 * 1000
): Promise<Interaction> {
  const started = Date.now()
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('Gemini terlalu lama merespons. Coba lagi nanti.')
    const it = await call<Interaction>(`interactions/${encodeURIComponent(interactionId)}`, { signal })
    const status = it.status ?? 'in_progress'
    onTick(status === 'completed' ? 'completed' : 'in_progress', Date.now() - started)
    if (status === 'completed') return it
    if (status === 'failed') {
      // The server says why: usually quota (RESOURCE_EXHAUSTED), not the prompt — surface its words.
      const first = it.errors?.[0]
      throw friendly(new Error(first ? `${first.code ?? ''} ${first.message ?? ''}`.trim() : 'Gemini gagal membuat hasil'))
    }
    if (status === 'cancelled' || status === 'canceled') throw new Error('Dibatalkan')
    await sleep(10_000, signal)
  }
}

function outputOf(it: Interaction, kind: 'image' | 'video'): { bytes: Buffer; mime: string } {
  for (const step of it.steps ?? []) {
    if (step.type !== 'model_output') continue
    for (const c of step.content ?? []) {
      if (c.type === kind && c.data) return { bytes: Buffer.from(c.data, 'base64'), mime: c.mime_type ?? (kind === 'image' ? 'image/png' : 'video/mp4') }
    }
  }
  throw new Error(`Gemini selesai tanpa file ${kind === 'image' ? 'gambar' : 'video'}`)
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return (space > limit * 0.8 ? cut.slice(0, space) : cut).trim()
}

/** Submits an image generation; returns the interaction id to poll. */
export async function submitImage(
  model: string,
  prompt: string,
  aspect: AspectRatio,
  refs: GeminiRef[],
  signal?: AbortSignal
): Promise<string> {
  const it = await createInteraction(
    {
      model,
      input: parts(prompt, refs),
      response_format: { type: 'image', aspect_ratio: aspect, image_size: '2K' },
      background: true,
      // Background interactions must be stored server-side, or the API rejects the request (HTTP 400).
      store: true
    },
    signal
  )
  if (it.status === 'completed') return it.id
  return it.id
}

/** Submits a video generation; refs[0] is the first frame, the rest are character references (max 6 total). */
export async function submitVideo(
  model: string,
  prompt: string,
  aspect: AspectRatio,
  seconds: number,
  refs: GeminiRef[],
  signal?: AbortSignal
): Promise<string> {
  const text = `${clip(prompt.trim(), 2500 - NO_MUSIC.length - 1)} ${NO_MUSIC}`
  const it = await createInteraction(
    {
      model,
      input: parts(text, refs.slice(0, 6)),
      response_format: { type: 'video', aspect_ratio: aspect, duration: `${Math.min(15, Math.max(3, Math.round(seconds)))}s` },
      background: true,
      // Background interactions must be stored server-side, or the API rejects the request (HTTP 400).
      store: true
    },
    signal
  )
  return it.id
}

export async function waitForImage(
  interactionId: string,
  onTick: (status: string, elapsedMs: number) => void,
  signal?: AbortSignal,
  timeoutMs = 15 * 60 * 1000
): Promise<{ bytes: Buffer; mime: string }> {
  const it = await pollInteraction(interactionId, onTick, signal, timeoutMs)
  return outputOf(it, 'image')
}

export async function waitForVideo(
  interactionId: string,
  onTick: (status: string, elapsedMs: number) => void,
  signal?: AbortSignal,
  timeoutMs = 30 * 60 * 1000
): Promise<{ bytes: Buffer; mime: string }> {
  const it = await pollInteraction(interactionId, onTick, signal, timeoutMs)
  return outputOf(it, 'video')
}
