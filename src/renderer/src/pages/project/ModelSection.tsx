import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Film, Image as ImageIcon, Move, Users } from 'lucide-react'
import {
  DEFAULT_VISUAL_MODELS,
  VISUAL_PROVIDERS,
  effectiveVisualResolution,
  fitVisualDuration,
  getVisualImageModel,
  getVisualVideoModel,
  maxVisualRefs,
  visualModelOptions,
  visualResolutionOptions
} from '@shared/visual'
import type { CreditEstimate, ModelOption, Project, VisualProvider } from '@shared/types'
import { ModelLogo } from '../../components/ModelLogo'
import { ModelPicker } from '../../components/ModelPicker'
import { Segmented, Spinner } from '../../components/ui'
import { creditLabel } from '../../lib/format'
import { useEstimate, useEstimates } from '../../lib/useEstimate'

const TAG_FILTERS: Record<VisualProvider, string[]> = {
  higgsfield: ['Rekomendasi', 'Referensi', 'GPT Image', 'Soul', 'Recraft', '4K'],
  gemini: ['Rekomendasi', 'Murah'],
  custom: ['Rekomendasi', 'Referensi']
}

/** Adds each model's estimated credits to its picker row once a Higgsfield key is known to exist. */
function withCosts(options: ModelOption[], costs: Record<string, CreditEstimate | null>, unit: (id: string) => string, on: boolean): ModelOption[] {
  if (!on) return options
  return options.map((o) => ({
    ...o,
    credits: o.id in costs ? (costs[o.id]?.credits ?? null) : undefined,
    usd: costs[o.id]?.usd ?? null,
    creditUnit: unit(o.id)
  }))
}

function Cost({
  value,
  hasKey,
  provider,
  children
}: {
  value: CreditEstimate | null | undefined
  hasKey: boolean | null
  provider: VisualProvider
  children: (credits: number) => ReactNode
}) {
  if (provider === 'gemini')
    return <span className="text-muted">Harga mengikuti pemakaian Gemini (bukan kredit), lihat tagihan di Google AI Studio.</span>
  if (provider === 'custom')
    return <span className="text-muted">Tagihan mengikuti endpoint custom kamu.</span>
  if (hasKey === false) return <span className="text-muted">Perkiraan kredit muncul setelah kunci Higgsfield diisi di Pengaturan.</span>
  if (value === undefined)
    return (
      <span className="flex items-center gap-1.5 text-muted">
        <Spinner className="size-3" />
        Menghitung kredit…
      </span>
    )
  if (value === null) return <span className="text-muted">Perkiraan kredit belum tersedia.</span>
  return <span>{children(value.credits)}</span>
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line-2 bg-surface p-3">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
        {icon}
        {title}
      </span>
      {children}
    </div>
  )
}

/** Which provider's models draw and animate this project's clips. */
export function ModelSection({
  project,
  clipCount,
  perClip,
  onChange
}: {
  project: Project
  clipCount: number
  perClip: number
  onChange: (patch: { visualProvider?: VisualProvider; imageModel?: string; videoModel?: string; videoResolution?: string | null }) => void
}) {
  const provider = project.visualProvider
  const image = getVisualImageModel(provider, project.imageModel)
  const video = getVisualVideoModel(provider, project.videoModel)
  const seconds = video ? fitVisualDuration(video, perClip) ?? perClip : perClip
  const imageCost = useEstimate(provider, 'image', image.id, project.aspectRatio)
  const resolutions = video ? visualResolutionOptions(video) : []
  const resolution = video ? effectiveVisualResolution(video, project.videoResolution) : null
  const videoCost = useEstimate(provider, 'video', video?.id ?? '', project.aspectRatio, perClip, resolution)
  const [hasKey, setHasKey] = useState<boolean | null>(null)

  useEffect(() => {
    // Custom visual reuses the custom LLM endpoint + key: both must be set.
    if (provider === 'custom') {
      void Promise.all([window.api.settings.keys(), window.api.settings.get()])
        .then(([keys, s]) => setHasKey(!!keys.find((k) => k.provider === 'custom')?.configured && !!s.customBaseUrl))
        .catch(() => setHasKey(false))
      return
    }
    void window.api.settings.keys().then((keys) => setHasKey(!!keys.find((k) => k.provider === provider)?.configured))
  }, [provider])

  const imageOptions = useMemo(() => visualModelOptions(provider, 'image'), [provider])
  const videoOptions = useMemo(() => visualModelOptions(provider, 'video'), [provider])
  // Costs only exist for Higgsfield; Gemini bills per use, so its pickers never ask.
  const imageCosts = useEstimates(provider, 'image', imageOptions.map((o) => o.id), project.aspectRatio, undefined, provider === 'higgsfield' && hasKey === true)
  const videoCosts = useEstimates(provider, 'video', videoOptions.map((o) => o.id), project.aspectRatio, perClip, provider === 'higgsfield' && hasKey === true)
  const imageModels = useMemo(
    () => withCosts(imageOptions, imageCosts, () => '', provider === 'higgsfield' && hasKey === true),
    [imageOptions, imageCosts, provider, hasKey]
  )
  const videoModels = useMemo(
    () =>
      withCosts(
        videoOptions,
        videoCosts,
        (id) => {
          const m = getVisualVideoModel(provider, id)
          return m ? `${fitVisualDuration(m, perClip)} dtk` : ''
        },
        provider === 'higgsfield' && hasKey === true
      ),
    [videoOptions, videoCosts, provider, perClip, hasKey]
  )

  const switchProvider = (next: VisualProvider): void => {
    if (next === provider) return
    // Each provider keeps its own last-picked models; a fresh switch starts from its defaults.
    onChange({
      visualProvider: next,
      imageModel: DEFAULT_VISUAL_MODELS[next].image,
      videoModel: DEFAULT_VISUAL_MODELS[next].video,
      videoResolution: null
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold">Model AI</span>
        <span className="text-[13px] text-muted">
          {imageOptions.length} model gambar dan {videoOptions.length} model video dari {VISUAL_PROVIDERS.find((p) => p.id === provider)?.label ?? provider}
        </span>
        <Segmented
          size="sm"
          value={provider}
          onChange={(v) => switchProvider(v as VisualProvider)}
          options={VISUAL_PROVIDERS.map((p) => ({ id: p.id, label: p.label }))}
          className="ml-auto"
        />
      </div>
      {provider === 'gemini' && hasKey === false && (
        <p className="text-[12.5px] leading-snug text-muted">
          Isi kunci Gemini dulu di Pengaturan — kunci yang sama dipakai untuk naskah, suara, dan visual. Tanpa kunci, gambar dan video tidak bisa dibuat.
        </p>
      )}
      {provider === 'custom' && hasKey === false && (
        <p className="text-[12.5px] leading-snug text-muted">
          Isi alamat endpoint + kunci custom dulu di Pengaturan (bagian Penyusun cerita) — endpoint yang sama dipakai untuk naskah dan gambar.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Card icon={<ImageIcon className="size-4" />} title="Gambar klip">
          <ModelPicker
            value={image.id}
            models={imageModels}
            footerNote={provider === 'higgsfield' && hasKey ? 'kredit per gambar, perkiraan Higgsfield untuk akunmu' : undefined}
            renderIcon={(m) => <ModelLogo family={m.family} />}
            detail="description"
            tagFilters={TAG_FILTERS[provider]}
            menuClassName="w-[430px]"
            // Custom endpoints serve any image model id, so the user types their router's id.
            allowCustom={provider === 'custom'}
            placeholder={provider === 'custom' ? 'Ketik ID model gambar dari routermu' : undefined}
            onChange={(id) => onChange({ visualProvider: provider, imageModel: id })}
          />
          <p className="text-[12.5px] leading-snug text-ink-2">
            <Cost value={imageCost} hasKey={hasKey} provider={provider}>
              {(c) => (
                <>
                  ≈ {creditLabel(c)} kredit per gambar · {clipCount} gambar ≈ <b className="font-semibold text-ink">{creditLabel(c * clipCount)} kredit</b>
                </>
              )}
            </Cost>
          </p>
          <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
            <Users className="mt-px size-3.5 shrink-0" />
            {maxVisualRefs(image)
              ? 'Pakai lembar karakter, jadi wajah dan kostum tokoh tetap sama di tiap klip.'
              : 'Tanpa lembar karakter, jadi tampilan tokoh bisa sedikit berubah antar klip.'}
          </p>
        </Card>
        <Card icon={<Film className="size-4" />} title="Video AI">
          {!video ? (
            <p className="text-[12.5px] leading-snug text-ink-2">
              Penyedia ini hanya bisa membuat gambar — tidak ada video AI. Pilih Higgsfield atau Gemini kalau klip mau dianimasikan jadi video.
            </p>
          ) : (
            <>
              <ModelPicker
                value={video.id}
                models={videoModels}
                footerNote={provider === 'higgsfield' && hasKey ? `kredit per video untuk klip ±${perClip} detik` : undefined}
                renderIcon={(m) => <ModelLogo family={m.family} />}
                detail="description"
                tagFilters={TAG_FILTERS[provider]}
                align="right"
                menuClassName="w-[430px]"
                onChange={(id) => onChange({ visualProvider: provider, videoModel: id })}
              />
              {resolutions.length > 1 ? (
                <div className="flex items-center gap-2.5">
                  <span className="shrink-0 text-[12.5px] font-medium text-ink-2">Resolusi</span>
                  <Segmented
                    size="sm"
                    value={resolution ?? resolutions[0]}
                    onChange={(v) => onChange({ visualProvider: provider, videoResolution: v })}
                    options={resolutions.map((r) => ({ id: r, label: r.toUpperCase() === '4K' || r.toUpperCase() === '2K' ? r.toUpperCase() : r }))}
                    className="min-w-0 flex-1"
                  />
                </div>
              ) : resolution ? (
                <p className="text-[12.5px] text-ink-2">Resolusi {resolution} (satu-satunya pilihan model ini)</p>
              ) : (
                <p className="text-[12.5px] text-ink-2">Resolusi otomatis (Omni Flash memilih sendiri)</p>
              )}
              <p className="text-[12.5px] leading-snug text-ink-2">
                <Cost value={videoCost} hasKey={hasKey} provider={provider}>
                  {(c) => (
                    <>
                      ≈ {creditLabel(c)} kredit per video {seconds} detik{resolution ? `, ${resolution}` : ''}
                    </>
                  )}
                </Cost>
              </p>
            </>
          )}
          <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
            <Move className="mt-px size-3.5 shrink-0" />
            Hanya untuk klip yang kamu jadikan Video AI. Gerak kamera tetap gratis.
          </p>
        </Card>
      </div>
    </div>
  )
}
