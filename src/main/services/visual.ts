import { getImageModel, getVideoModel, imageBody, videoBody, type HfModel } from '@shared/higgsfield'
import { hfModelOf, type VisualModel, type VisualProvider } from '@shared/visual'
import type { AspectRatio, CreditEstimate, KeyTestResult } from '@shared/types'
import * as chatgptWeb from './chatgpt-web'
import { createExtensionJob, extensionStatus, getExtensionJob } from './chatgpt-extension-server'
import * as geminiVisual from './gemini-visual'
import * as hf from './higgsfield'
import { downloadTo } from './http'
import { getSecret } from '../secrets'

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
  if (provider === 'openai') return openaiAdapter()
  return higgsfieldAdapter()
}

// ChatGPT Web runs live in the module (submit and wait run on different adapter instances),
// so their promises live here, not on the adapter.
const chatGptRuns = new Map<string, { promise: Promise<{ bytes: Buffer; mime: string }>; onTick: (status: string, elapsedMs: number) => void }>()

/**
 * Waits for an extension job to finish: polls the bridge every 2 seconds until the extension
 * reports the image (or an error), or 10 minutes pass. A job that never leaves 'pending' means
 * the extension never picked it up — the tab is closed or the extension is off — and the error
 * says so instead of timing out silently.
 */
async function waitForExtensionJob(
  id: string,
  onTick: (status: string, elapsedMs: number) => void,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; mime: string }> {
  const started = Date.now()
  for (;;) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    onTick('in_progress', Date.now() - started)
    const job = await getExtensionJob(id)
    if (!job) throw new Error('Job ekstensi ChatGPT tidak ditemukan (aplikasi dimulai ulang?).')
    if (job.status === 'done' && job.image) {
      return { bytes: Buffer.from(job.image.split(',')[1] ?? '', 'base64'), mime: job.mime ?? 'image/png' }
    }
    if (job.status === 'error') {
      throw new Error(job.error ?? 'Ekstensi ChatGPT gagal membuat gambar.')
    }
    if (Date.now() - started > 10 * 60 * 1000) {
      throw new Error(
        job.status === 'pending'
          ? 'Ekstensi ChatGPT tidak mengambil tugasnya. Buka chatgpt.com di Chrome dan pastikan ekstensi Bang Story aktif, lalu coba lagi.'
          : 'ChatGPT web tidak membalas gambar dalam 10 menit. Coba lagi nanti.'
      )
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/**
 * OpenAI Images API (GPT Image as a real backend — the same model family as ChatGPT web, but no
 * browser, no bot check, no profile). gpt-image-1 and gpt-image-1-mini are retired, so the catalog
 * starts at 1.5. Generations are a JSON call; with references it is a multipart /edits call
 * (up to 16 images, input_fidelity high so character sheets stay faithful). The API always
 * answers with base64, and bills per use (~$0,01–0,05 per image at medium quality).
 */
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'

function openaiSize(aspect: AspectRatio): string {
  if (aspect === '9:16') return '1024x1536'
  if (aspect === '16:9') return '1536x1024'
  return '1024x1024'
}

function friendlyOpenai(status: number, body: string): string {
  let message = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } }
    message = parsed.error?.message ?? ''
  } catch {
    message = ''
  }
  if (status === 401) return 'Kunci OpenAI ditolak. Periksa kunci di Pengaturan › Gambar dan video.'
  if (status === 429 || /insufficient_quota|billing/i.test(message)) {
    return 'OpenAI menolak permintaan (kuota atau saldo habis?). Cek billing di platform.openai.com.'
  }
  return message ? `OpenAI: ${message}` : `OpenAI menjawab dengan status ${status}.`
}

const openaiRuns = new Map<string, Promise<{ bytes: Buffer; mime: string }>>()

function openaiAdapter(): VisualAdapter {
  return {
    submitImage: (input, signal) => {
      const key = getSecret('openai')
      if (!key) return Promise.reject(new Error('Isi kunci OpenAI dulu di Pengaturan › Gambar dan video.'))
      const size = openaiSize(input.aspect)
      const refs = (input.refs ?? []).filter((r) => r.bytes).slice(0, 16)
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      const call =
        refs.length > 0
          ? (() => {
              // Edits: references travel as multipart files; input_fidelity high keeps the
              // character sheets faithful instead of drifting.
              const form = new FormData()
              refs.forEach((r, i) => form.append('image[]', new File([r.bytes as Buffer], `ref-${i + 1}.png`, { type: r.mime })))
              form.append('prompt', input.prompt)
              form.append('model', input.model.id)
              form.append('size', size)
              form.append('quality', 'medium')
              form.append('input_fidelity', 'high')
              form.append('output_format', 'png')
              return fetch(`${OPENAI_BASE_URL}/images/edits`, { method: 'POST', headers, body: form, signal })
            })()
          : fetch(`${OPENAI_BASE_URL}/images/generations`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: input.prompt, model: input.model.id, size, quality: 'medium', n: 1, output_format: 'png' }),
              signal
            })
      const id = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const promise = call
        .then(async (res) => {
          if (!res.ok) throw new Error(friendlyOpenai(res.status, await res.text()))
          const data = (await res.json()) as { data?: { b64_json?: string }[] }
          const b64 = data.data?.[0]?.b64_json
          if (!b64) throw new Error('OpenAI tidak mengembalikan gambar.')
          return { bytes: Buffer.from(b64, 'base64'), mime: 'image/png' }
        })
        .catch((e) => {
          if ((e as Error).name === 'AbortError') throw new Error('Dibatalkan')
          throw e
        })
      openaiRuns.set(id, promise)
      void promise.catch(() => {}).finally(() => openaiRuns.delete(id))
      return Promise.resolve(id)
    },
    submitVideo: () => Promise.reject(new Error('OpenAI Images API hanya bisa membuat gambar. Pilih Higgsfield atau Gemini untuk video AI.')),
    waitForResult: async (remoteId, kind, onTick, signal) => {
      if (kind === 'video') throw new Error('OpenAI Images API hanya bisa membuat gambar.')
      const run = openaiRuns.get(remoteId)
      if (!run) throw new Error('Job OpenAI tidak ditemukan (mungkin aplikasi dimulai ulang).')
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
      const key = cred ?? getSecret('openai')
      if (!key) return { ok: false, message: 'Isi kunci OpenAI dulu di Pengaturan › Gambar dan video.' }
      try {
        const res = await fetch(`${OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } })
        if (!res.ok) return { ok: false, message: friendlyOpenai(res.status, await res.text()) }
        const data = (await res.json()) as { data?: unknown[] }
        return { ok: true, message: `Terhubung · ${data.data?.length ?? 0} model tersedia` }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    }
  }
}

function chatGptWebAdapter(): VisualAdapter {
  return {
    submitImage: async (input) => {
      // First choice: the Chrome extension, when it is connected and its tab is logged in. It
      // runs inside the user's real browser, so there is no profile, flag, or bot check involved.
      // References travel as data URLs inside the job; the content script turns them into files.
      const ext = await extensionStatus().catch(() => ({ connected: false, loggedIn: false }))
      if (ext.connected && ext.loggedIn) {
        const refs = (input.refs ?? [])
          .filter((r) => r.bytes)
          .map((r) => ({ dataUrl: `data:${r.mime};base64,${(r.bytes as Buffer).toString('base64')}`, mime: r.mime }))
        const id = await createExtensionJob(input.prompt, refs)
        return `ext:${id}`
      }
      // Fallback: the Playwright driver (CDP, real profile, or a fresh profile).
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
      return id
    },
    submitVideo: () => Promise.reject(new Error('ChatGPT Web hanya bisa membuat gambar. Pilih Higgsfield atau Gemini untuk video AI.')),
    waitForResult: async (remoteId, kind, onTick, signal) => {
      if (kind === 'video') throw new Error('ChatGPT Web hanya bisa membuat gambar.')
      if (remoteId.startsWith('ext:')) {
        const result = await waitForExtensionJob(remoteId.slice(4), onTick, signal)
        return { images: [result] }
      }
      const entry = chatGptRuns.get(remoteId)
      if (!entry) throw new Error('Job ChatGPT Web tidak ditemukan (mungkin aplikasi dimulai ulang).')
      entry.onTick = onTick
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
      const ext = await extensionStatus().catch(() => ({ connected: false, loggedIn: false }))
      if (ext.connected) {
        return ext.loggedIn
          ? { ok: true, message: 'Terhubung · ekstensi ChatGPT aktif, login ChatGPT aktif' }
          : { ok: false, message: 'Ekstensi ChatGPT terhubung, tapi belum login. Login ChatGPT di Chrome dulu.' }
      }
      const { loggedIn } = await chatgptWeb.chatGptWebStatus()
      return loggedIn
        ? { ok: true, message: 'Terhubung · login ChatGPT aktif' }
        : { ok: false, message: 'Belum login ChatGPT. Buka Pengaturan › ChatGPT Web, login dulu.' }
    }
  }
}
