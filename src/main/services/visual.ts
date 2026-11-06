import { getImageModel, getVideoModel, imageBody, videoBody, type HfModel } from '@shared/higgsfield'
import { hfModelOf, type VisualModel, type VisualProvider } from '@shared/visual'
import type { AspectRatio, CreditEstimate, KeyTestResult } from '@shared/types'
import * as chatgptWeb from './chatgpt-web'
import * as geminiVisual from './gemini-visual'
import * as hf from './higgsfield'
import { downloadTo } from './http'

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
  if (provider === 'chatgpt-web') return chatGptWebAdapter()
  if (provider === 'pollinations') return pollinationsAdapter()
  return higgsfieldAdapter()
}

/**
 * Pollinations: free FLUX images, no key, no login, no browser. The image URL itself is the job id,
 * so a restart can resume by re-fetching the same URL (the service caches by URL, so the same image
 * comes back). References cannot be sent — Pollinations takes them only as public URLs — so the
 * prompt's character descriptions in text are what keep a character recognizable. The images can
 * carry a small pollinations.ai watermark even with nologo=true.
 */
function pollinationsAdapter(): VisualAdapter {
  const sizeFor = (aspect: AspectRatio): { width: number; height: number } =>
    aspect === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 }
  const urlFor = (input: VisualInput): string => {
    const { width, height } = sizeFor(input.aspect)
    const seed = Math.floor(Math.random() * 1_000_000)
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt)}?width=${width}&height=${height}&model=flux&nologo=true&seed=${seed}`
  }
  return {
    submitImage: (input) => Promise.resolve(urlFor(input)),
    submitVideo: () => Promise.reject(new Error('Pollinations hanya bisa membuat gambar. Pilih Higgsfield atau Gemini untuk video AI.')),
    waitForResult: async (remoteId, kind, onTick, signal) => {
      if (kind === 'video') throw new Error('Pollinations hanya bisa membuat gambar.')
      onTick('in_progress', 0)
      const { bytes, contentType } = await downloadTo(remoteId, signal)
      if (!/^image\//.test(contentType) && bytes.length < 1000)
        throw new Error('Pollinations tidak mengirim gambar. Coba lagi sebentar.')
      return { images: [{ bytes, mime: contentType || 'image/jpeg' }] }
    },
    cancel: async () => {},
    // Free, no estimate endpoint.
    estimate: async () => null,
    testCredentials: async () => ({ ok: true, message: 'Gratis · tanpa kunci, tanpa login' })
  }
}

// ChatGPT Web runs live in the module (submit and wait run on different adapter instances),
// so their promises live here, not on the adapter.
const chatGptRuns = new Map<string, { promise: Promise<{ bytes: Buffer; mime: string }>; onTick: (status: string, elapsedMs: number) => void }>()

function chatGptWebAdapter(): VisualAdapter {
  return {
    submitImage: (input) => {
      // References go to the browser as files; a reference without bytes cannot be sent.
      const refs = (input.refs ?? []).filter((r) => r.bytes).map((r) => ({ bytes: r.bytes as Buffer, mime: r.mime }))
      const files = chatgptWeb.writeRefFiles(refs)
      const id = `chatgpt-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const entry = {
        promise: chatgptWeb
          .chatGptWebImage(input.prompt, files, (s, e) => entry.onTick(s, e))
          .finally(() => chatgptWeb.removeRefFiles(files)),
        onTick: (_s: string, _e: number) => {}
      }
      chatGptRuns.set(id, entry)
      void entry.promise.catch(() => {}).finally(() => chatGptRuns.delete(id))
      return Promise.resolve(id)
    },
    submitVideo: () => Promise.reject(new Error('ChatGPT Web hanya bisa membuat gambar. Pilih Higgsfield atau Gemini untuk video AI.')),
    waitForResult: async (remoteId, kind, onTick, signal) => {
      const entry = chatGptRuns.get(remoteId)
      if (!entry) throw new Error('Job ChatGPT Web tidak ditemukan (mungkin aplikasi dimulai ulang).')
      entry.onTick = onTick
      if (kind === 'video') throw new Error('ChatGPT Web hanya bisa membuat gambar.')
      const result = signal
        ? await Promise.race([
            entry.promise,
            new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Dibatalkan')), { once: true }))
          ])
        : await entry.promise
      return { images: [result] }
    },
    // The browser keeps generating after a cancel; the result is discarded and the driver's
    // serial queue moves on to the next image.
    cancel: async () => {},
    // Free ChatGPT quota, no estimate endpoint.
    estimate: async () => null,
    testCredentials: async () => {
      const { loggedIn } = await chatgptWeb.chatGptWebStatus()
      return loggedIn
        ? { ok: true, message: 'Terhubung · login ChatGPT aktif' }
        : { ok: false, message: 'Belum login ChatGPT. Buka Pengaturan › ChatGPT Web, login dulu.' }
    }
  }
}
