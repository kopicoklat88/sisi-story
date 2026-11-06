import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { estimateWordTimings } from '@shared/captions'
import { stripVoiceTags } from '@shared/speech'
import {
  getVisualImageModel,
  getVisualVideoModel,
  maxVisualRefs,
  visualPromptLimit,
  type VisualModel,
  type VisualProvider
} from '@shared/visual'
import { getStyle } from '@shared/styles'
import type { AspectRatio, Asset, Character, Clip, CreditEstimate, Job, Project, WordTiming } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { assetAbsPath } from './paths'
import {
  activeJobFor,
  charactersOf,
  clipsOf,
  getAsset,
  getCharacter,
  getClip,
  getJob,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  setCharacterSheet,
  touchProject,
  unfinishedJobs,
  updateAssetMeta,
  updateJob
} from './repo'
import { dropCache, getSettings, readCache, writeCache } from './settings'
import { probeDurationMs, probeSize } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import { sleep } from './services/http'
import { adapter, type VisualInput, type VisualRef } from './services/visual'

const DAY = 24 * 60 * 60 * 1000

function extFromMime(mime: string, fallback: string): string {
  if (/png/.test(mime)) return '.png'
  if (/jpe?g/.test(mime)) return '.jpg'
  if (/webp/.test(mime)) return '.webp'
  if (/mp4/.test(mime)) return '.mp4'
  return fallback
}

function mimeFor(absPath: string): string {
  switch (extname(absPath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.mp4':
      return 'video/mp4'
    default:
      return 'image/png'
  }
}

function saveFile(projectId: string, folder: string, ext: string, bytes: Buffer): string {
  const rel = `${folder}/${randomUUID()}${ext}`
  const abs = assetAbsPath(projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return rel
}

/** A URL Higgsfield can fetch for a stored asset: its own recent result URL, or a fresh upload. */
async function publicUrlFor(asset: Asset, signal: AbortSignal): Promise<string> {
  if (asset.remoteUrl && asset.provider === 'higgsfield' && Date.now() - asset.createdAt < 6 * DAY) return asset.remoteUrl
  const up = asset.meta.uploadedUrl as string | undefined
  const at = asset.meta.uploadedAt as number | undefined
  if (up && at && Date.now() - at < 0.5 * DAY) return up
  const url = await adapter('higgsfield').uploadReference!(assetAbsPath(asset.projectId, asset.localPath), signal)
  updateAssetMeta(asset.id, { ...asset.meta, uploadedUrl: url, uploadedAt: Date.now() })
  return url
}

function providerLabel(provider: VisualProvider): string {
  return provider === 'gemini'
    ? 'Gemini'
    : provider === 'chatgpt-web'
      ? 'ChatGPT Web'
      : provider === 'openai'
        ? 'OpenAI'
        : provider === 'custom'
          ? 'Custom'
          : 'Higgsfield'
}

function imageProgress(ctx: TaskCtx, what: string, provider: VisualProvider) {
  return (status: string, elapsed: number): void => {
    if (status === 'queued') ctx.progress(0.12, `Mengantre di ${providerLabel(provider)}`)
    else ctx.progress(0.15 + 0.75 * (1 - Math.exp(-elapsed / 45_000)), what)
  }
}

// ---------- prompts ----------

function characterLine(c: Character): string {
  return `${c.name}: ${c.description}`
}

/** Splits the storyboard's "Avoid:" line off the scene, so it can be phrased as a clear instruction. */
function splitAvoid(visual: string): { scene: string; avoid: string } {
  const lines = visual.split('\n')
  const i = lines.findIndex((l) => /^\s*avoid\s*:/i.test(l))
  if (i < 0) return { scene: visual.trim(), avoid: '' }
  const avoid = lines[i].replace(/^\s*avoid\s*:\s*/i, '').replace(/\.$/, '').trim()
  lines.splice(i, 1)
  return { scene: lines.join('\n').trim(), avoid }
}

/**
 * The image prompt for a clip. The scene comes first so the model gets the content right, then who the
 * characters are, then the art style. Clothing follows the scene's Wardrobe line when it has one, so a
 * character can change out of the outfit on their reference sheet (no spacesuit indoors).
 */
function clipPrompt(project: Project, clip: Clip, chars: Character[], refNames: string[], limit: number): string {
  const style = getStyle(project.styleId)
  const { scene, avoid } = splitAvoid(clip.visualPrompt)
  const wardrobe = /^\s*wardrobe\s*:/im.test(scene)
  const parts = [`Scene:\n${scene}`]
  if (chars.length)
    parts.push(
      `Recurring characters in this scene. Keep each one's body, face, hair and skin exactly as described${refNames.length ? ' and as on their reference sheet' : ''}.` +
        (wardrobe
          ? ' Their clothing follows the Wardrobe line of the scene: the default outfit only where it says so, otherwise the custom outfit.'
          : ' They wear their default outfit.') +
        `\n${chars.map(characterLine).join('\n')}`
    )
  if (refNames.length)
    parts.push(
      `Reference images are character sheets, in this order: ${refNames.join(', ')}. Use them for each character's identity, proportions and colors. ` +
        (wardrobe ? 'Copy the costume from a sheet only for characters whose Wardrobe line says "default outfit". ' : 'Match the costume to the sheet. ') +
        'Do not copy the sheet layout, poses or plain background.'
    )
  parts.push(`Art style: ${style.prompt}`)
  if (avoid) parts.push(`Must not appear in the image: ${avoid}.`)
  parts.push(`Frame format ${project.aspectRatio}, full-bleed composition.`)
  const full = parts.join('\n\n')
  if (full.length <= limit) return full
  // Models with short prompt limits get the scene first, so trimming only loses style detail.
  return [scene, chars.map(characterLine).join('; '), avoid && `Must not appear: ${avoid}.`, style.prompt].filter(Boolean).join('\n\n')
}

function sheetPrompt(project: Project, c: Character): string {
  const style = getStyle(project.styleId)
  return [
    style.prompt,
    `Character reference sheet for "${c.name}": ${c.description}. The character is ${style.characterHint}.`,
    'Show the SAME character three times side by side: front view, three-quarter view and side view, full body, neutral standing pose, evenly spaced, on a plain light neutral background (this overrides any background instruction above). Consistent proportions, costume and colors in all three views.'
  ].join('\n\n')
}

// ---------- waiting for character sheets ----------

async function waitForSheets(characterIds: string[], signal: AbortSignal): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    const pending = characterIds.some((id) => activeJobFor({ characterId: id }, 'sheet'))
    if (!pending) return
    await sleep(2000, signal)
  }
}

async function referenceRefs(
  provider: VisualProvider,
  model: VisualModel,
  chars: Character[],
  signal: AbortSignal
): Promise<{ refs: VisualRef[]; names: string[] }> {
  const limit = maxVisualRefs(model)
  if (limit === 0) return { refs: [], names: [] }
  await waitForSheets(
    chars.map((c) => c.id),
    signal
  )
  const refs: VisualRef[] = []
  const names: string[] = []
  for (const c of chars) {
    const fresh = getCharacter(c.id)
    const sheet = getAsset(fresh.sheetAssetId)
    if (!sheet || refs.length >= limit) continue
    const abs = assetAbsPath(sheet.projectId, sheet.localPath)
    // Gemini and ChatGPT Web read the sheet inline; Higgsfield fetches it from a public URL.
    const ref: VisualRef = { mime: mimeFor(abs) }
    if (provider === 'gemini' || provider === 'chatgpt-web') ref.bytes = await readFile(abs)
    else ref.publicUrl = await publicUrlFor(sheet, signal)
    refs.push(ref)
    names.push(fresh.name)
  }
  return { refs, names }
}

/** The clip image as a video reference: first frame for either provider. */
async function imageRef(provider: VisualProvider, asset: Asset, signal: AbortSignal): Promise<VisualRef> {
  const abs = assetAbsPath(asset.projectId, asset.localPath)
  const ref: VisualRef = { mime: mimeFor(abs) }
  if (provider === 'gemini' || provider === 'chatgpt-web') ref.bytes = await readFile(abs)
  else ref.publicUrl = await publicUrlFor(asset, signal)
  return ref
}

// ---------- finishing a visual request (also used to resume after a restart) ----------

interface VisualPayload {
  target: 'clip-image' | 'sheet' | 'clip-video'
  provider: VisualProvider
  model: string
  prompt: string
}

async function finishVisual(ctx: TaskCtx, job: Job, remoteId: string, payload: VisualPayload): Promise<string> {
  const isVideo = payload.target === 'clip-video'
  const out = await adapter(payload.provider).waitForResult(
    remoteId,
    isVideo ? 'video' : 'image',
    imageProgress(
      ctx,
      isVideo ? 'Membuat video' : payload.target === 'sheet' ? 'Membuat lembar karakter' : 'Membuat gambar',
      payload.provider
    ),
    ctx.signal,
    isVideo ? 30 * 60 * 1000 : 15 * 60 * 1000
  )
  const file = isVideo ? out.video : out.images?.[0]
  if (!file) throw new Error(`${providerLabel(payload.provider)} selesai tanpa file hasil`)
  ctx.progress(0.93, 'Menyimpan hasil')
  const rel = saveFile(job.projectId, isVideo ? 'videos' : 'images', extFromMime(file.mime, isVideo ? '.mp4' : '.png'), file.bytes)
  const abs = assetAbsPath(job.projectId, rel)
  const size = await probeSize(abs)
  const durationMs = isVideo ? await probeDurationMs(abs).catch(() => null) : null
  const asset = insertAsset({
    projectId: job.projectId,
    clipId: job.clipId,
    characterId: job.characterId,
    kind: isVideo ? 'video' : 'image',
    provider: payload.provider,
    model: payload.model,
    prompt: payload.prompt,
    remoteId,
    remoteUrl: out.remoteUrl ?? null,
    localPath: rel,
    durationMs,
    width: size?.width ?? null,
    height: size?.height ?? null
  })
  emit.asset(asset)
  if (payload.target === 'sheet' && job.characterId) {
    setCharacterSheet(job.characterId, asset.id)
    emit.character({ characterId: job.characterId, patch: { sheetAssetId: asset.id } })
  } else if (payload.target === 'clip-image' && job.clipId) {
    patchClip(job.clipId, { imageAssetId: asset.id })
    emit.clip({ clipId: job.clipId, patch: { imageAssetId: asset.id } })
    const project = getProject(job.projectId)
    const first = clipsOf(job.projectId)[0]
    if (!project.coverAssetId || first?.id === job.clipId) touchProject(job.projectId, { coverAssetId: asset.id })
  } else if (payload.target === 'clip-video' && job.clipId) {
    const patch = { videoAssetId: asset.id, motionType: 'video' as const, mediaInMs: 0 }
    patchClip(job.clipId, patch)
    emit.clip({ clipId: job.clipId, patch })
  }
  touchProject(job.projectId)
  return asset.id
}

function startVisual(job: Job, build: (ctx: TaskCtx) => Promise<{ input: VisualInput; payload: VisualPayload }>): Job {
  emit.job(job)
  return runJob(job, 'visual', async (ctx) => {
    ctx.progress(0.04, 'Menyiapkan prompt')
    const { input, payload } = await build(ctx)
    ctx.progress(0.08, `Mengirim ke ${providerLabel(payload.provider)}`)
    const remoteId =
      payload.target === 'clip-video'
        ? await adapter(payload.provider).submitVideo(input, ctx.signal)
        : await adapter(payload.provider).submitImage(input, ctx.signal)
    ctx.setRemote(remoteId)
    updateJobPayload(job.id, payload)
    return finishVisual(ctx, job, remoteId, payload)
  })
}

function updateJobPayload(jobId: string, payload: VisualPayload): void {
  getDb().prepare('UPDATE jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), jobId)
}

// ---------- public entry points ----------

export function generateClipImage(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'image')
  if (existing) return existing
  const clip = getClip(clipId)
  const provider = getProject(clip.projectId).visualProvider
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'image', provider })
  return startVisual(job, async (ctx) => {
    const fresh = getClip(clipId)
    const project = getProject(fresh.projectId)
    const model = getVisualImageModel(project.visualProvider, project.imageModel)
    const chars = charactersOf(project.id).filter((c) => fresh.characterIds.includes(c.id))
    const refs = await referenceRefs(project.visualProvider, model, chars, ctx.signal)
    const prompt = clipPrompt(project, fresh, chars, refs.names, visualPromptLimit(model))
    return {
      input: { model, prompt, aspect: project.aspectRatio, refs: refs.refs },
      payload: { target: 'clip-image', provider: project.visualProvider, model: model.id, prompt }
    }
  })
}

export function generateCharacterSheet(characterId: string): Job {
  const existing = activeJobFor({ characterId }, 'sheet')
  if (existing) return existing
  const c = getCharacter(characterId)
  const provider = getProject(c.projectId).visualProvider
  const job = insertJob({ projectId: c.projectId, characterId, kind: 'sheet', provider })
  return startVisual(job, async () => {
    const project = getProject(c.projectId)
    const model = getVisualImageModel(project.visualProvider, project.imageModel)
    const prompt = sheetPrompt(project, getCharacter(characterId))
    return {
      input: { model, prompt, aspect: '16:9', refs: [] },
      payload: { target: 'sheet', provider: project.visualProvider, model: model.id, prompt }
    }
  })
}

export function generateClipVideo(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'video')
  if (existing) return existing
  const clip = getClip(clipId)
  if (!clip.imageAssetId) throw new Error('Buat gambar klip ini dulu sebelum membuat video AI.')
  const provider = getProject(clip.projectId).visualProvider
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'video', provider })
  return startVisual(job, async (ctx) => {
    const fresh = getClip(clipId)
    const image = getAsset(fresh.imageAssetId)
    if (!image) throw new Error('Gambar klip tidak ditemukan')
    const project = getProject(fresh.projectId)
    const model = getVisualVideoModel(project.visualProvider, project.videoModel)
    if (!model) throw new Error('ChatGPT Web hanya bisa membuat gambar. Pilih Higgsfield atau Gemini untuk video AI.')
    ctx.progress(0.05, 'Menyiapkan gambar awal')
    const chars = charactersOf(project.id).filter((c) => fresh.characterIds.includes(c.id))
    const sheets = await referenceRefs(project.visualProvider, model, chars, ctx.signal)
    const refs = [await imageRef(project.visualProvider, image, ctx.signal), ...sheets.refs]
    let prompt =
      fresh.videoPrompt.trim() ||
      `${splitAvoid(fresh.visualPrompt).scene.replace(/\.$/, '')}. Subtle natural motion of the characters and environment, the camera slowly pushes in. Keep the art style of the first frame.`
    if (model.inputMode === 'reference')
      prompt = `Open on the exact scene of the reference image and keep its art style, characters and composition. ${prompt}`
    return {
      input: {
        model,
        prompt,
        aspect: project.aspectRatio,
        seconds: fresh.durationMs / 1000,
        resolution: project.videoResolution,
        refs
      },
      payload: { target: 'clip-video', provider: project.visualProvider, model: model.id, prompt }
    }
  })
}

export function generateClipTts(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'tts')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'tts', provider: project.ttsProvider })
  emit.job(job)
  return runJob(job, 'tts', async (ctx) => {
    const fresh = getClip(clipId)
    const p = getProject(fresh.projectId)
    const text = fresh.narration.trim()
    if (!text) throw new Error('Naskah klip ini masih kosong')
    ctx.progress(0.2, 'Membuat suara')
    let rel: string
    let words: WordTiming[] | undefined
    let estimated = false
    const voice = p.ttsVoice || (p.ttsProvider === 'gemini' ? 'Charon' : '')
    if (p.ttsProvider === 'elevenlabs') {
      if (!voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
      const out = await eleven.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.mp3', out.audio)
      words = out.words
    } else {
      const wav = await gemini.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.wav', wav)
    }
    ctx.progress(0.85, 'Mengukur durasi')
    const audioMs = await probeDurationMs(assetAbsPath(p.id, rel))
    if (!words?.length) {
      words = estimateWordTimings(stripVoiceTags(text), audioMs / 1000)
      estimated = true
    }
    const asset = insertAsset({
      projectId: p.id,
      clipId,
      kind: 'audio',
      provider: p.ttsProvider,
      model: p.ttsProvider === 'gemini' ? getSettings().geminiTtsModel : getSettings().elevenModel,
      prompt: text,
      localPath: rel,
      durationMs: audioMs,
      meta: { words, estimatedTimings: estimated, voice }
    })
    emit.asset(asset)
    const durationMs = Math.max(1500, audioMs + 400)
    const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
    patchClip(clipId, patch)
    emit.clip({ clipId, patch })
    touchProject(p.id)
    return asset.id
  })
}

export function generateMissingImages(projectId: string): Job[] {
  const jobs: Job[] = []
  const project = getProject(projectId)
  const model = getVisualImageModel(project.visualProvider, project.imageModel)
  if (maxVisualRefs(model) > 0) {
    const needed = new Set(clipsOf(projectId).flatMap((c) => c.characterIds))
    for (const c of charactersOf(projectId)) {
      if (needed.has(c.id) && !c.sheetAssetId) jobs.push(generateCharacterSheet(c.id))
    }
  }
  for (const clip of clipsOf(projectId)) {
    if (!clip.imageAssetId) jobs.push(generateClipImage(clip.id))
  }
  return jobs
}

/** Turns every clip that has an image but no AI video yet into a video. */
export function generateMissingVideos(projectId: string): Job[] {
  const clips = clipsOf(projectId)
  if (clips.some((c) => !c.imageAssetId)) throw new Error('Buat gambar semua klip dulu sebelum menjadikannya video.')
  return clips.filter((c) => !c.videoAssetId).map((c) => generateClipVideo(c.id))
}

export function generateMissingTts(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.audioAssetId && c.narration.trim())
    .map((c) => generateClipTts(c.id))
}

/** After a restart, keep polling visual requests that were already submitted; fail the rest. */
export function resumeJobs(): void {
  for (const row of unfinishedJobs()) {
    const payload = JSON.parse(row.payload_json || '{}') as Partial<VisualPayload>
    if ((row.provider === 'higgsfield' || row.provider === 'gemini') && row.remote_id && payload.target) {
      const job = getJob(row.id)!
      runJob(job, 'visual', (ctx) => finishVisual(ctx, job, row.remote_id, payload as VisualPayload))
    } else {
      emit.job(updateJob(row.id, { status: 'failed', error: 'Terhenti karena aplikasi ditutup. Coba lagi.', message: null }))
    }
  }
}

export async function setActiveAsset(clipId: string, assetId: string): Promise<void> {
  const asset = getAsset(assetId)
  if (!asset || asset.clipId !== clipId) throw new Error('Aset tidak cocok dengan klip ini')
  const patch: Partial<Clip> =
    asset.kind === 'image'
      ? { imageAssetId: asset.id }
      : asset.kind === 'video'
        ? { videoAssetId: asset.id, mediaInMs: 0 }
        : asset.kind === 'audio'
          ? { audioAssetId: asset.id, durationMs: Math.max(1500, (asset.durationMs ?? 0) + 400), voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
          : {}
  patchClip(clipId, patch)
  emit.clip({ clipId, patch })
}

/** Estimates that failed recently (no key, or a model the account cannot use), so pickers do not keep asking. */
const failedEstimates = new Map<string, number>()

/**
 * Credits for one image, or one clip video of about `seconds`. The model pickers ask for every model,
 * so answers are kept for a day and failures for ten minutes. Gemini has no estimate endpoint and
 * bills per use, so it always answers null (the picker says so instead of showing a price).
 */
export async function estimateCredits(
  provider: VisualProvider,
  kind: 'image' | 'video',
  modelId: string,
  aspect: AspectRatio,
  seconds = 5,
  resolution?: string | null
): Promise<CreditEstimate | null> {
  if (provider === 'gemini' || provider === 'chatgpt-web' || provider === 'openai' || provider === 'custom') return null
  const model = kind === 'image' ? getVisualImageModel(provider, modelId) : getVisualVideoModel(provider, modelId)
  if (!model) return null
  const key = `estimate:${provider}:${model.id}:${aspect}:${seconds}:${resolution ?? ''}`
  const hit = readCache<CreditEstimate>(key)
  if (hit && Date.now() - hit.updatedAt < DAY) return hit.value
  const failedAt = failedEstimates.get(key)
  if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) return null
  const value = await adapter(provider).estimate(kind, model.id, aspect, seconds, resolution)
  if (value) writeCache(key, value)
  else failedEstimates.set(key, Date.now())
  return value
}

/** Prices can differ per account, so a new Higgsfield key starts from fresh estimates. */
export function forgetEstimates(): void {
  failedEstimates.clear()
  dropCache('estimate:')
}
