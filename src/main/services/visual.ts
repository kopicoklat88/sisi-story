import { getImageModel, getVideoModel, imageBody, videoBody, type HfModel } from '@shared/higgsfield'
import { hfModelOf, type VisualModel, type VisualProvider } from '@shared/visual'
import type { AspectRatio, CreditEstimate, KeyTestResult } from '@shared/types'
import * as geminiVisual from './gemini-visual'
import * as hf from './higgsfield'
import { downloadTo } from './http'
import { getSecret } from '../secrets'
import { getSettings } from '../settings'

/**
 * The visual provider boundary. Generation asks for an image or a video through this interface
 * and never touches a provider API directly, so adding a provider means one adapter here plus
 * a catalog in shared/visual.ts — no changes to generation, jobs, or the pickers.
 *
 * Results are always bytes: Higgsfield answers with a URL (downloaded here), Gemini with
 * base64 inside the interaction, ChatGPT Web with a file downloaded from the browser reply.
 * References travel as local bytes; only Higgsfield needs a public URL for them, which
 * generation fills in before submitting. ChatGPT Web writes reference bytes to temp files for
 * the browser's file picker.
 */
export interface VisualRef {
  /** Local bytes (Gemini reads references inline; Higgsfield fetches them by URL instead). */
  bytes?: Buffer
  mime: string
  /** Public URL, filled in for Higgsfield (it fetches references by URL). */
  publicUrl?: string
}

export interface VisualInput {
  model: VisualModel
  prompt: string
  aspect: AspectRatio
  /** Clip length in seconds, for video. */
  seconds?: number
  resolution?: string | null
  /** First frame (video) or reference images (image). */
  refs?: VisualRef[]
}

export interface VisualOutput {
  images?: { bytes: Buffer; mime: string }[]
  video?: { bytes: Buffer; mime: string }
  /** Where the result can be fetched again (Higgsfield only; reused as a reference URL while fresh). */
  remoteUrl?: string
}

export interface VisualAdapter {
  submitImage(input: VisualInput, signal?: AbortSignal): Promise<string>
  submitVideo(input: VisualInput, signal?: AbortSignal): Promise<string>
  waitForResult(
    remoteId: string,
    kind: 'image' | 'video',
    onTick: (status: string, elapsedMs: number) => void,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<VisualOutput>
  cancel(remoteId: string): Promise<void>
  /** Turns a local file into a public URL the provider can fetch (Higgsfield only; Gemini reads bytes inline). */
  uploadReference?(absPath: string, signal?: AbortSignal): Promise<string>
  estimate(kind: 'image' | 'video', modelId: string, aspect: AspectRatio, seconds?: number, resolution?: string | null): Promise<CreditEstimate | null>
  testCredentials(cred?: string): Promise<KeyTestResult>
}

function higgsfieldAdapter(): VisualAdapter {
  const body = (m: HfModel, input: VisualInput): Record<string, unknown> =>
    input.model.kind === 'image'
      ? imageBody(m, input.prompt, input.aspect, (input.refs ?? []).map((r) => r.publicUrl ?? ''))
      : videoBody(m, input.prompt, input.refs?.[0]?.publicUrl ?? '', input.seconds ?? 5, input.aspect, input.resolution)
  return {
    submitImage: (input, signal) => hf.submit(input.model.id, body(hfModelOf(input.model), input), signal),
    submitVideo: (input, signal) => hf.submit(input.model.id, body(hfModelOf(input.model), input), signal),
    waitForResult: async (remoteId, kind, onTick, signal, timeoutMs) => {
      const result = await hf.waitForResult(remoteId, onTick, signal, timeoutMs)
      if (kind === 'video') {
        const url = result.video?.url
        if (!url) throw new Error('Higgsfield selesai tanpa file hasil')
        const { bytes, contentType } = await downloadTo(url, signal)
        return { video: { bytes, mime: contentType }, remoteUrl: url }
      }
      const url = result.images?.[0]?.url
      if (!url) throw new Error('Higgsfield selesai tanpa file hasil')
      const { bytes, contentType } = await downloadTo(url, signal)
      return { images: [{ bytes, mime: contentType }], remoteUrl: url }
    },
    cancel: (remoteId) => hf.cancelRequest(remoteId),
    uploadReference: (absPath, signal) => hf.uploadFile(absPath, signal),
    estimate: (kind, modelId, aspect, seconds, resolution) => {
      const m = kind === 'image' ? getImageModel(modelId) : getVideoModel(modelId)
      const b =
        kind === 'image'
          ? imageBody(m, 'estimate', aspect, [])
          : videoBody(m, 'estimate', 'https://example.com/frame.png', seconds ?? 5, aspect, resolution)
      return hf.estimate(modelId, b)
    },
    testCredentials: (cred) => hf.testCredentials(cred)
  }
}

function geminiAdapter(): VisualAdapter {
  return {
    // Gemini inlines references as bytes; a reference without bytes cannot be sent, so it is dropped.
    submitImage: (input, signal) =>
      geminiVisual.submitImage(
        input.model.id,
        input.prompt,
        input.aspect,
        (input.refs ?? []).filter((r) => r.bytes).map((r) => ({ bytes: r.bytes as Buffer, mime: r.mime })),
        signal
      ),
    submitVideo: (input, signal) =>
      geminiVisual.submitVideo(
        input.model.id,
        input.prompt,
        input.aspect,
        input.seconds ?? 5,
        (input.refs ?? []).filter((r) => r.bytes).map((r) => ({ bytes: r.bytes as Buffer, mime: r.mime })),
        signal
      ),
    waitForResult: async (remoteId, kind, onTick, signal, timeoutMs) => {
      if (kind === 'video') return { video: await geminiVisual.waitForVideo(remoteId, onTick, signal, timeoutMs) }
      return { images: [await geminiVisual.waitForImage(remoteId, onTick, signal, timeoutMs)] }
    },
    // The Interactions API exposes no cancel; aborting the poll stops our side and the
    // server-side generation is discarded (same as a Higgsfield job already processing).
    cancel: async () => {},
    // Gemini bills per use, not per credit, and has no estimate endpoint.
    estimate: async () => null,
    testCredentials: (cred) => geminiVisual.testCredentials(cred)
  }
}

export function adapter(provider: VisualProvider): VisualAdapter {
  if (provider === 'gemini') return geminiAdapter()
  if (provider === 'custom') return customVisualAdapter()
  return higgsfieldAdapter()
}

/**
 * Custom image endpoint: any OpenAI-compatible Images API, driven with the user's own key.
 * Generations are a JSON call; with references it is a multipart /edits call (up to 16 images).
 * The request body stays minimal (no quality, no input_fidelity, no output_format — those are
 * OpenAI-only, and a generic endpoint may reject parameters it does not know). The answer may
 * come back as base64 or as a hosted URL (downloaded). Billing follows the user's endpoint.
 */
function customSize(aspect: AspectRatio): string {
  if (aspect === '9:16') return '1024x1536'
  if (aspect === '16:9') return '1536x1024'
  return '1024x1024'
}

function friendlyCustom(status: number, body: string): string {
  let message = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } }
    message = parsed.error?.message ?? ''
  } catch {
    message = ''
  }
  if (status === 401) return 'Kunci custom ditolak. Periksa kunci + alamat endpoint custom di Pengaturan.'
  if (status === 429 || /insufficient_quota|billing/i.test(message)) {
    return 'Endpoint custom menolak permintaan (kuota atau saldo habis?). Cek penyedia API kamu.'
  }
  return message ? `Endpoint custom: ${message}` : `Endpoint custom menjawab dengan status ${status}.`
}

const customRuns = new Map<string, Promise<{ bytes: Buffer; mime: string }>>()

function customVisualAdapter(): VisualAdapter {
  const keyHint = 'Isi alamat endpoint + kunci custom dulu di Pengaturan › Penyusun cerita.'
  return {
    submitImage: (input, signal) => {
      const base = getSettings().customBaseUrl.trim().replace(/\/+$/, '')
      if (!base) return Promise.reject(new Error(keyHint))
      const key = getSecret('custom')
      if (!key) return Promise.reject(new Error(keyHint))
      const size = customSize(input.aspect)
      const refs = (input.refs ?? []).filter((r) => r.bytes).slice(0, 16)
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      const call =
        refs.length > 0
          ? (() => {
              const form = new FormData()
              refs.forEach((r, i) => form.append('image[]', new File([r.bytes as Buffer], `ref-${i + 1}.png`, { type: r.mime })))
              form.append('prompt', input.prompt)
              form.append('model', input.model.id)
              form.append('size', size)
              return fetch(`${base}/images/edits`, { method: 'POST', headers, body: form, signal })
            })()
          : fetch(`${base}/images/generations`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: input.prompt, model: input.model.id, size, n: 1 }),
              signal
            })
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const promise = call
        .then(async (res) => {
          if (!res.ok) throw new Error(friendlyCustom(res.status, await res.text()))
          const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
          const first = data.data?.[0]
          if (first?.b64_json) return { bytes: Buffer.from(first.b64_json, 'base64'), mime: 'image/png' }
          // Some compatible endpoints answer with a hosted URL instead of base64.
          if (first?.url) {
            const downloaded = await downloadTo(first.url, signal)
            return { bytes: downloaded.bytes, mime: downloaded.contentType || 'image/png' }
          }
          throw new Error('Endpoint custom tidak mengembalikan gambar.')
        })
        .catch((e) => {
          if ((e as Error).name === 'AbortError') throw new Error('Dibatalkan')
          throw e
        })
      customRuns.set(id, promise)
      void promise.catch(() => {}).finally(() => customRuns.delete(id))
      return Promise.resolve(id)
    },
    submitVideo: () => Promise.reject(new Error('Endpoint custom hanya bisa membuat gambar. Pilih Higgsfield atau Gemini untuk video AI.')),
    waitForResult: async (remoteId, kind, onTick, signal) => {
      if (kind === 'video') throw new Error('Endpoint ini hanya bisa membuat gambar.')
      const run = customRuns.get(remoteId)
      if (!run) throw new Error('Job gambar tidak ditemukan (mungkin aplikasi dimulai ulang).')
      onTick('in_progress', 0)
      const result = signal
        ? await Promise.race([
            run,
            new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Dibatalkan')), { once: true }))
          ])
        : await run
      return { images: [result] }
    },
    // The in-flight request aborts through the job signal; nothing else to cancel.
    cancel: async () => {},
    // Per-use billing, no estimate endpoint.
    estimate: async () => null,
    testCredentials: async (cred) => {
      const base = getSettings().customBaseUrl.trim().replace(/\/+$/, '')
      const key = cred ?? getSecret('custom')
      if (!key) return { ok: false, message: keyHint }
      if (!base) return { ok: false, message: keyHint }
      try {
        const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
        if (!res.ok) return { ok: false, message: friendlyCustom(res.status, await res.text()) }
        const data = (await res.json()) as { data?: unknown[] }
        return { ok: true, message: `Terhubung · ${data.data?.length ?? 0} model tersedia` }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    }
  }
}

