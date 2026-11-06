import {
  DEFAULT_IMAGE_MODEL as HF_DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL as HF_DEFAULT_VIDEO_MODEL,
  HF_IMAGE_MODELS,
  HF_VIDEO_MODELS,
  describeModel,
  effectiveResolution,
  getImageModel as getHfImageModel,
  getVideoModel as getHfVideoModel,
  resolutionOptions,
  type HfModel
} from './higgsfield'
import type { ModelOption, VisualProvider } from './types'

/**
 * Who draws the clip images and animates them. Higgsfield is the original provider; Gemini
 * (Nano Banana images + Omni Flash video, through the Interactions API) is the second one, ChatGPT Web
 * (GPT Image in the browser) the third, and Pollinations (free FLUX images, no key, no login) the
 * fourth — it is also the automatic fallback when the chosen provider fails, so a dead quota or a
 * refused key degrades to a free image instead of an error. Any later provider only needs a catalog
 * here plus an adapter in main/services/visual.ts.
 */
export type { VisualProvider } from './types'

export const VISUAL_PROVIDERS: { id: VisualProvider; label: string; note: string }[] = [
  { id: 'higgsfield', label: 'Higgsfield', note: '14 model gambar, 34 model video · bayar per kredit' },
  { id: 'gemini', label: 'Gemini', note: 'Nano Banana + Omni Flash · pakai kunci Gemini yang sama, bayar per pemakaian' },
  { id: 'chatgpt-web', label: 'ChatGPT Web', note: 'GPT Image lewat browser · kuota free akun ChatGPT, tanpa kunci API' },
  { id: 'pollinations', label: 'Pollinations', note: 'Gratis · tanpa kunci, tanpa login — Flux, jadi jaring pengaman kalau penyedia utama gagal' }
]

/** One image or video model from either provider, in the shape pickers and generation share. */
export interface VisualModel {
  id: string
  provider: VisualProvider
  name: string
  family: string
  kind: 'image' | 'video'
  description: string
  tags: string[]
  /** Where the clip image (video) or the character sheets (image) go in the request. */
  inputMode: 'none' | 'first-frame' | 'reference'
  /** How many character sheets the model takes as references (0 = none). */
  maxRefs: number
  promptLimit: number
  /** Allowed video lengths in seconds: fixed values, or a min–max range. Null for images. */
  durations: { values: number[] } | { min: number; max: number } | null
  /** Resolutions the picker offers for video; null when the provider picks it. */
  resolutions: string[] | null
}

/**
 * Gemini image models (Nano Banana family, via the Interactions API — Imagen was shut down
 * 2026-08-17 and Veo 3.1 preview on 2026-10-22, so neither is listed). Reference counts follow
 * the docs: 2 Lite is not built for multiple references, the others keep characters consistent.
 */
const GEMINI_IMAGE_MODELS: VisualModel[] = [
  {
    id: 'gemini-nano-banana-2.1',
    provider: 'gemini',
    name: 'Nano Banana 2.1',
    family: 'gemini',
    kind: 'image',
    description: 'Gambar utama Gemini · cepat, kualitas bagus, sampai 6 gambar referensi',
    tags: ['Rekomendasi'],
    inputMode: 'reference',
    maxRefs: 6,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'gemini',
    name: 'Nano Banana Pro',
    family: 'gemini',
    kind: 'image',
    description: 'Paling teliti mengikuti instruksi dan teks di gambar · sampai 6 gambar referensi',
    tags: [],
    inputMode: 'reference',
    maxRefs: 6,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  },
  {
    id: 'gemini-3.1-flash-image',
    provider: 'gemini',
    name: 'Nano Banana 2',
    family: 'gemini',
    kind: 'image',
    description: 'Generasi sebelumnya · tetap kuat untuk banyak referensi',
    tags: [],
    inputMode: 'reference',
    maxRefs: 6,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    provider: 'gemini',
    name: 'Nano Banana 2 Lite',
    family: 'gemini',
    kind: 'image',
    description: 'Paling cepat dan murah · kurang cocok untuk banyak referensi',
    tags: ['Murah'],
    inputMode: 'reference',
    maxRefs: 1,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  },
  {
    id: 'gemini-2.5-flash-image',
    provider: 'gemini',
    name: 'Nano Banana',
    family: 'gemini',
    kind: 'image',
    description: 'Model lama Nano Banana · masih jalan, tapi disarankan pindah ke 2.1',
    tags: [],
    inputMode: 'reference',
    maxRefs: 3,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  }
]

/**
 * Gemini video model: Omni Flash 1.2 is the only video model in the Gemini API since Veo 3.1
 * preview shut down. 3–15 detik per klip, audio bawaan, bisa mulai dari gambar klip dan memakai
 * sampai 6 gambar referensi untuk menjaga tokoh tetap sama.
 */
const GEMINI_VIDEO_MODELS: VisualModel[] = [
  {
    id: 'gemini-omni-1.2-flash',
    provider: 'gemini',
    name: 'Gemini Omni Flash 1.2',
    family: 'gemini',
    kind: 'video',
    description: 'Video 3–15 dtk + audio bawaan · dari gambar klip, sampai 6 gambar referensi',
    tags: ['Rekomendasi'],
    inputMode: 'first-frame',
    maxRefs: 6,
    promptLimit: 2500,
    durations: { min: 3, max: 15 },
    resolutions: null
  }
]

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1'
export const DEFAULT_GEMINI_VIDEO_MODEL = 'gemini-omni-1.2-flash'

/**
 * ChatGPT Web image model: GPT Image 1 driven through chatgpt.com in a real browser (see
 * main/services/chatgpt-web.ts). No API key — it spends the ChatGPT account's free image quota.
 * Image only: ChatGPT web video (Sora) is a separate product and is not covered here.
 */
const CHATGPT_WEB_IMAGE_MODELS: VisualModel[] = [
  {
    id: 'gpt-image-1-web',
    provider: 'chatgpt-web',
    name: 'GPT Image 1 (web)',
    family: 'chatgpt',
    kind: 'image',
    description: 'Gambar lewat chatgpt.com di browser · kuota free akun ChatGPT, tanpa kunci API',
    tags: ['Rekomendasi'],
    inputMode: 'reference',
    maxRefs: 3,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  }
]

export const DEFAULT_CHATGPT_WEB_IMAGE_MODEL = 'gpt-image-1-web'

/**
 * Pollinations image model: FLUX.1-schnell, free, no key, no login, no browser. The prompt carries
 * the character descriptions in text — Pollinations takes reference images only as public URLs, which
 * the app cannot provide for local sheets, so maxRefs is 0 and consistency comes from the text.
 * The images can carry a small pollinations.ai watermark even with nologo=true.
 */
const POLLINATIONS_IMAGE_MODELS: VisualModel[] = [
  {
    id: 'pollinations-flux',
    provider: 'pollinations',
    name: 'Flux Schnell (gratis)',
    family: 'pollinations',
    kind: 'image',
    description: 'Gambar gratis tanpa kunci dan tanpa login · kualitas bagus untuk kartun dan storyboard',
    tags: ['Gratis'],
    inputMode: 'none',
    maxRefs: 0,
    promptLimit: 4000,
    durations: null,
    resolutions: null
  }
]

export const DEFAULT_POLLINATIONS_IMAGE_MODEL = 'pollinations-flux'

export const DEFAULT_VISUAL_MODELS: Record<VisualProvider, { image: string; video: string }> = {
  higgsfield: { image: HF_DEFAULT_IMAGE_MODEL, video: HF_DEFAULT_VIDEO_MODEL },
  gemini: { image: DEFAULT_GEMINI_IMAGE_MODEL, video: DEFAULT_GEMINI_VIDEO_MODEL },
  // ChatGPT Web has no video model; the empty video id means "no video for this provider".
  'chatgpt-web': { image: DEFAULT_CHATGPT_WEB_IMAGE_MODEL, video: '' },
  // Pollinations is image-only too.
  pollinations: { image: DEFAULT_POLLINATIONS_IMAGE_MODEL, video: '' }
}

function fromHf(m: HfModel): VisualModel {
  return {
    id: m.id,
    provider: 'higgsfield',
    name: m.name,
    family: m.family,
    kind: m.kind,
    description: describeModel(m),
    tags: m.tags,
    inputMode: m.input.mode,
    maxRefs: m.kind === 'image' && m.input.mode === 'reference' ? m.input.max : 0,
    promptLimit: m.props.prompt?.maxLength ?? (m.kind === 'video' ? 2500 : 4000),
    durations: m.durations,
    resolutions: m.kind === 'video' ? resolutionOptions(m) : null
  }
}

export function visualImageModels(provider: VisualProvider): VisualModel[] {
  if (provider === 'gemini') return GEMINI_IMAGE_MODELS
  if (provider === 'chatgpt-web') return CHATGPT_WEB_IMAGE_MODELS
  if (provider === 'pollinations') return POLLINATIONS_IMAGE_MODELS
  return HF_IMAGE_MODELS.map(fromHf)
}

export function visualVideoModels(provider: VisualProvider): VisualModel[] {
  if (provider === 'gemini') return GEMINI_VIDEO_MODELS
  // ChatGPT Web and Pollinations are image-only.
  if (provider === 'chatgpt-web' || provider === 'pollinations') return []
  return HF_VIDEO_MODELS.map(fromHf)
}

export function getVisualImageModel(provider: VisualProvider, id: string | null | undefined): VisualModel {
  const list = visualImageModels(provider)
  return list.find((m) => m.id === id) ?? list.find((m) => m.id === DEFAULT_VISUAL_MODELS[provider].image)!
}

/** Null when the provider has no video models (ChatGPT Web). Callers must handle that. */
export function getVisualVideoModel(provider: VisualProvider, id: string | null | undefined): VisualModel | null {
  const list = visualVideoModels(provider)
  if (!list.length) return null
  return list.find((m) => m.id === id) ?? list.find((m) => m.id === DEFAULT_VISUAL_MODELS[provider].video) ?? list[0]
}

/** The video length to request for a clip: the shortest allowed length that covers it, or the longest. */
export function fitVisualDuration(m: VisualModel, seconds: number): number | null {
  const d = m.durations
  if (!d) return null
  const want = Math.max(1, Math.ceil(seconds))
  if ('values' in d) {
    const values = [...d.values].sort((a, b) => a - b)
    return values.find((v) => v >= want) ?? values[values.length - 1]
  }
  return Math.min(d.max, Math.max(d.min, want))
}

export function visualDurationLabel(m: VisualModel): string | null {
  const d = m.durations
  if (!d) return null
  return 'values' in d ? `${d.values.join(' / ')} dtk` : `${d.min}–${d.max} dtk`
}

/** The resolution a project's videos actually use with this model (null = the provider decides). */
export function effectiveVisualResolution(m: VisualModel, want?: string | null): string | null {
  if (m.provider !== 'higgsfield') return null
  const hf = getHfVideoModel(m.id)
  return effectiveResolution(hf, want)
}

/** Resolutions a video model offers, lowest first, as picker values. */
export function visualResolutionOptions(m: VisualModel): string[] {
  if (m.provider !== 'higgsfield') return []
  return resolutionOptions(getHfVideoModel(m.id))
}

/** Picker rows, the default first with a "Rekomendasi" tag so first-time users have a safe choice. */
export function visualModelOptions(provider: VisualProvider, kind: 'image' | 'video'): ModelOption[] {
  const list = kind === 'image' ? visualImageModels(provider) : visualVideoModels(provider)
  const recommended = DEFAULT_VISUAL_MODELS[provider][kind]
  return [...list.filter((m) => m.id === recommended), ...list.filter((m) => m.id !== recommended)].map((m) => ({
    id: m.id,
    name: m.name,
    family: m.family,
    description: m.description,
    tags: m.id === recommended ? ['Rekomendasi', ...m.tags] : m.tags
  }))
}

/** How many character sheets an image model accepts as references. 0 means sheets are not used. */
export function maxVisualRefs(m: VisualModel): number {
  return m.maxRefs
}

/** Longest prompt the model accepts. */
export function visualPromptLimit(m: VisualModel): number {
  return m.promptLimit
}

/** The Higgsfield catalog entry behind a Higgsfield visual model (for request bodies). */
export function hfModelOf(m: VisualModel): HfModel {
  return m.kind === 'image' ? getHfImageModel(m.id) : getHfVideoModel(m.id)
}
