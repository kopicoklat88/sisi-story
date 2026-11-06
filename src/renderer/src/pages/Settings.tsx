import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Info,
  KeyRound,
  Mic,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { visualImageModels, visualVideoModels } from '@shared/visual'
import { LANGUAGES, LLM_PROVIDERS } from '@shared/models'
import type { ApiProvider, AppSettings, KeyStatus, KeyTestResult, LlmProvider, TtsProvider } from '@shared/types'
import { Logo } from '../components/Logo'
import { ModelLogo } from '../components/ModelLogo'
import { ModelPicker } from '../components/ModelPicker'
import { ProviderLogo, type ProviderLogoId } from '../components/ProviderLogo'
import { Select } from '../components/Select'
import { AboutSection } from './AboutSection'
import { WhisperSection } from './WhisperSection'
import { Badge, Button, Field, IconButton, confirmDialog, cx, inputCls } from '../components/ui'
import { errorText, relativeTime } from '../lib/format'
import { useModels } from '../lib/useModels'
import { useApp } from '../store/app'

type Tab = 'services' | 'general' | 'about'

interface ProviderOption<T extends string> {
  id: T
  name: string
  note: string
  logo: ProviderLogoId
  status?: KeyStatus
}

function StatusBadge({ status }: { status?: KeyStatus }) {
  if (!status?.configured) return <Badge tone="draft">Belum diatur</Badge>
  if (status.lastOk === false) return <Badge tone="bad">Gagal terhubung</Badge>
  if (status.lastOk)
    return (
      <Badge tone="ok">
        <Check className="size-3" strokeWidth={3} />
        Terhubung
      </Badge>
    )
  return <Badge tone="info">Tersimpan</Badge>
}

/** One dropdown to choose which provider a section uses; only that provider's settings are shown below it. */
function ProviderSelect<T extends string>({ value, options, onChange }: { value: T; options: ProviderOption<T>[]; onChange: (id: T) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const cur = options.find((o) => o.id === value) ?? options[0]
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          'flex w-full items-center gap-3 rounded-2xl border-[1.5px] border-ink bg-surface px-4 py-3 text-left transition-shadow',
          open ? 'shadow-none' : 'shadow-ink hover:shadow-ink-md'
        )}
      >
        <ProviderLogo id={cur.logo} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-bold">{cur.name}</span>
          <span className="truncate text-[13px] text-ink-2">{cur.note}</span>
        </span>
        <StatusBadge status={cur.status} />
        <ChevronDown className={cx('size-5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="listbox" className="absolute inset-x-0 top-full z-40 mt-1.5 flex flex-col gap-0.5 rounded-2xl border-[1.5px] border-ink bg-surface p-1.5 shadow-ink-lg">
          {options.map((o) => {
            const on = o.id === value
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  setOpen(false)
                  if (!on) onChange(o.id)
                }}
                className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left', on ? 'bg-accent-soft' : 'hover:bg-sand')}
              >
                <ProviderLogo id={o.logo} size={36} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-semibold">{o.name}</span>
                  <span className="truncate text-[13px] text-ink-2">{o.note}</span>
                </span>
                <StatusBadge status={o.status} />
                <span className="flex size-5 shrink-0 items-center justify-center">{on && <Check className="size-4 text-accent" strokeWidth={2.6} />}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** API key field(s) with save, test and delete. The custom endpoint also takes a base URL. */
function KeyForm({
  provider,
  name,
  status,
  label = 'API key',
  placeholder = 'Tempel API key',
  hint,
  help,
  link,
  linkLabel,
  customUrl,
  onChanged,
  onSaved
}: {
  provider: ApiProvider
  name: string
  status?: KeyStatus
  label?: string
  placeholder?: string
  hint?: ReactNode
  help: string
  link: string | null
  linkLabel: string
  customUrl?: string
  onChanged: () => void
  onSaved?: (r: KeyTestResult) => void
}) {
  const { toast } = useApp()
  const configured = !!status?.configured
  const isCustom = provider === 'custom'
  const preview = status?.preview ?? null
  const [editing, setEditing] = useState(!preview)
  const [key, setKey] = useState('')
  const [url, setUrl] = useState(customUrl ?? '')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [showTyped, setShowTyped] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)

  // A newly saved or removed key puts the field back in its resting state.
  useEffect(() => {
    setEditing(!preview)
    setKey('')
    setRevealed(null)
  }, [preview])

  // The stored key is shown masked; the custom endpoint keeps an editable (optional) key field.
  const showStored = !isCustom && !editing && !!preview
  const urlChanged = isCustom && url.trim() !== (customUrl ?? '').trim()
  const canSave = isCustom ? !!url.trim() && (urlChanged || !!key.trim() || !configured) : !showStored && !!key.trim()
  // A pasted key only counts once it is saved; Enter saves it too.
  const unsaved = !isCustom && !showStored && !!key.trim() && busy !== 'save'
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || !canSave || busy) return
    e.preventDefault()
    void save()
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    try {
      const r = isCustom ? await window.api.settings.setCustom(url, key) : await window.api.settings.setKey(provider, key)
      toast(r.ok ? 'success' : 'error', `${name}: ${r.message}`)
      setKey('')
      setEditing(false)
      onChanged()
      onSaved?.(r)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleEye = async (): Promise<void> => {
    if (!showStored) {
      setShowTyped(!showTyped)
      return
    }
    setRevealed(revealed ? null : await window.api.settings.revealKey(provider))
  }
  const visible = showStored ? !!revealed : showTyped

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      const r = await window.api.settings.testKey(provider)
      toast(r.ok ? 'success' : 'error', `${name}: ${r.message}`)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const clear = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Hapus ${isCustom ? 'endpoint' : 'kunci'} ${name}?`,
      body: 'Data ini akan dihapus dari komputer ini. Kamu bisa menambahkannya lagi kapan saja.',
      confirm: 'Hapus',
      danger: true
    })
    if (!ok) return
    await window.api.settings.clearKey(provider)
    setUrl('')
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        {isCustom && (
          <Field label="Alamat endpoint (base URL)" className="flex-[1.3]">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onEnter}
              placeholder="http://localhost:11434/v1"
              spellCheck={false}
              className={cx(inputCls, 'h-11 font-mono text-sm')}
            />
          </Field>
        )}
        <Field label={isCustom ? 'API key (opsional)' : label} className="flex-1">
          <div className="relative">
            {showStored ? (
              <input
                readOnly
                value={revealed ?? preview ?? ''}
                aria-label={`${label} tersimpan`}
                className={cx(inputCls, 'h-11 cursor-default bg-paper pr-11 font-mono text-sm')}
              />
            ) : (
              <input
                type={showTyped ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoFocus={!isCustom && !!preview}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={onEnter}
                placeholder={
                  isCustom ? (preview ? `Tersimpan (${preview}) · isi untuk mengganti` : 'Kosongkan untuk server lokal') : placeholder
                }
                className={cx(inputCls, 'h-11 pr-11')}
              />
            )}
            {(showStored || key.length > 0) && (
              <button
                type="button"
                aria-label={visible ? 'Sembunyikan kunci' : 'Tampilkan kunci'}
                title={visible ? 'Sembunyikan kunci' : 'Tampilkan kunci'}
                onClick={() => void toggleEye()}
                className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-sand hover:text-ink"
              >
                {visible ? <EyeOff className="size-[17px]" /> : <Eye className="size-[17px]" />}
              </button>
            )}
          </div>
        </Field>
        {showStored ? (
          <Button
            className="h-11"
            onClick={() => {
              setEditing(true)
              setRevealed(null)
            }}
          >
            Ganti
          </Button>
        ) : (
          <Button variant="accent" className="h-11" disabled={!canSave} loading={busy === 'save'} onClick={() => void save()}>
            Simpan dan tes
          </Button>
        )}
        {!isCustom && editing && !!preview && (
          <Button
            variant="ghost"
            className="h-11"
            onClick={() => {
              setEditing(false)
              setKey('')
            }}
          >
            Batal
          </Button>
        )}
        {configured && (
          <>
            <Button className="h-11" loading={busy === 'test'} onClick={() => void test()}>
              Tes
            </Button>
            <IconButton label={`Hapus ${name}`} size={44} className="text-bad-ink" onClick={() => void clear()}>
              <Trash2 className="size-[18px]" />
            </IconButton>
          </>
        )}
      </div>
      {unsaved && <p className="-mt-1 text-[13px] font-semibold text-accent-dark">Kunci belum tersimpan. Tekan Enter atau klik Simpan dan tes.</p>}
      {hint && <p className="-mt-1 text-[13px] text-ink-2">{hint}</p>}
      <div className="flex items-center gap-2 text-[13px] text-ink-2">
        <span className={cx('flex-1', configured && status?.lastOk === false && 'text-bad-ink')}>
          {configured && status?.lastMessage
            ? `${status.lastMessage}${status.checkedAt && !status.unreadable ? ` · dicek ${relativeTime(status.checkedAt)}` : ''}`
            : help}
        </span>
        {link && (
          <button
            type="button"
            onClick={() => void window.api.app.openExternal(link)}
            className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent-dark hover:underline"
          >
            {linkLabel}
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-5 py-[18px]">{children}</section>
}

function SectionTitle({ icon, title, sub }: { icon: ReactNode; title: string; sub: ReactNode }) {
  return (
    <div className="mt-5 flex items-start gap-3">
      <span className="mt-1 text-ink">{icon}</span>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[22px] font-bold leading-tight">{title}</h2>
        <p className="text-sm text-ink-2">{sub}</p>
      </div>
    </div>
  )
}

function LlmSection({ settings, statusOf, onChanged, onSettings }: { settings: AppSettings; statusOf: (p: ApiProvider) => KeyStatus | undefined; onChanged: () => void; onSettings: (s: AppSettings) => void }) {
  const { toast } = useApp()
  const provider = settings.llmProvider
  const spec = LLM_PROVIDERS.find((p) => p.id === provider)!
  const status = statusOf(provider)
  const configured = !!status?.configured
  const [openPicker, setOpenPicker] = useState(false)
  const models = useModels(provider, configured && status?.lastOk !== false, provider === 'custom' ? settings.customBaseUrl : '')
  const model = settings.llmModels[provider]
  const selected = models.models.find((m) => m.id === model)

  const options: ProviderOption<LlmProvider>[] = LLM_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    note: p.note,
    logo: p.id,
    status: statusOf(p.id)
  }))

  return (
    <>
      <SectionTitle
        icon={<Cpu className="size-5" />}
        title="Penyusun cerita (AI LLM)"
        sub="Pilih satu penyedia untuk menyusun klip, naskah, dan pemeran. Hanya penyedia yang dipilih yang dipakai."
      />
      <ProviderSelect
        value={provider}
        options={options}
        onChange={async (id) => {
          setOpenPicker(false)
          onSettings(await window.api.settings.set({ llmProvider: id }))
        }}
      />
      <Card key={provider}>
        <KeyForm
          provider={provider}
          name={spec.name}
          status={status}
          help={provider === 'custom' ? 'Contoh: http://localhost:11434/v1 untuk Ollama, http://localhost:1234/v1 untuk LM Studio, https://api.x.ai/v1 untuk Grok.' : 'Setelah kunci disimpan, daftar model diambil langsung dari penyedianya.'}
          hint={provider === 'gemini' && settings.defaultTtsProvider === 'gemini' ? 'Kunci ini dipakai bersama untuk suara narator Gemini TTS dan visual (Nano Banana + Omni Flash).' : undefined}
          link={spec.link}
          linkLabel={spec.linkLabel}
          customUrl={settings.customBaseUrl}
          onChanged={onChanged}
          onSaved={async (r) => {
            if (!r.ok) return
            onSettings(await window.api.settings.get())
            if (configured) void models.refresh()
            if (!model) setOpenPicker(true)
          }}
        />
        {configured && status?.lastOk !== false && (
          <div className="flex flex-col gap-1.5 border-t border-dashed border-line pt-4">
            <span className="text-sm font-semibold">Model untuk menyusun cerita</span>
            <ModelPicker
              value={model}
              models={models.models}
              loading={models.loading}
              error={models.error}
              fetchedAt={models.fetchedAt}
              onChange={async (id) => {
                setOpenPicker(false)
                onSettings(await window.api.settings.set({ llmModels: { ...settings.llmModels, [provider]: id } }))
                toast('success', `Cerita akan disusun oleh ${spec.name} · ${id}`)
              }}
              onRefresh={() => void models.refresh()}
              allowCustom={provider === 'custom'}
              defaultOpen={openPicker}
              placeholder="Pilih model dari daftar"
            />
            {selected?.description && <p className="line-clamp-2 text-[13px] text-muted">{selected.description}</p>}
            {selected && provider === 'openrouter' && !selected.tags.includes('JSON') && (
              <p className="text-[13px] text-sun-ink">
                Model ini tidak mendukung output JSON terstruktur. Aplikasi tetap mencoba, tapi model berlabel JSON biasanya lebih stabil.
              </p>
            )}
          </div>
        )}
      </Card>
    </>
  )
}

function TtsSection({ settings, statusOf, onChanged, onSettings }: { settings: AppSettings; statusOf: (p: ApiProvider) => KeyStatus | undefined; onChanged: () => void; onSettings: (s: AppSettings) => void }) {
  const provider = settings.defaultTtsProvider
  const status = statusOf(provider)
  const ready = !!status?.configured && status.lastOk !== false
  const models = useModels(provider === 'gemini' ? 'gemini-tts' : 'elevenlabs', ready)
  const options: ProviderOption<TtsProvider>[] = [
    {
      id: 'gemini',
      name: 'Gemini TTS',
      note: 'Suara Google Gemini, 30 pilihan suara, mendukung bahasa Indonesia.',
      logo: 'gemini',
      status: statusOf('gemini')
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      note: 'Suara sangat natural dengan waktu kata yang presisi untuk caption karaoke.',
      logo: 'elevenlabs',
      status: statusOf('elevenlabs')
    }
  ]
  const value = provider === 'gemini' ? settings.geminiTtsModel : settings.elevenModel
  return (
    <>
      <SectionTitle
        icon={<Mic className="size-5" />}
        title="Suara narator (TTS)"
        sub="Penyedia suara bawaan untuk proyek baru. Setiap proyek tetap bisa memilih sendiri di langkah Ide cerita."
      />
      <ProviderSelect value={provider} options={options} onChange={async (id) => onSettings(await window.api.settings.set({ defaultTtsProvider: id }))} />
      <Card key={provider}>
        <KeyForm
          provider={provider}
          name={provider === 'gemini' ? 'Google Gemini' : 'ElevenLabs'}
          status={status}
          help={provider === 'gemini' ? 'Kunci Gemini dari Google AI Studio.' : 'Kunci API dari akun ElevenLabs.'}
          hint={provider === 'gemini' && settings.llmProvider === 'gemini' ? 'Kunci ini dipakai bersama dengan penyusun cerita Gemini dan visual (Nano Banana + Omni Flash).' : undefined}
          link={provider === 'gemini' ? 'https://aistudio.google.com/apikey' : 'https://elevenlabs.io/app/settings/api-keys'}
          linkLabel={provider === 'gemini' ? 'Buat kunci di Google AI Studio' : 'Buat kunci di ElevenLabs'}
          onChanged={onChanged}
          onSaved={(r) => r.ok && void models.refresh()}
        />
        {ready && (
          <div className="flex flex-col gap-1.5 border-t border-dashed border-line pt-4">
            <span className="text-sm font-semibold">Model suara</span>
            <ModelPicker
              value={value}
              models={models.models}
              loading={models.loading}
              error={models.error}
              fetchedAt={models.fetchedAt}
              onChange={async (id) => onSettings(await window.api.settings.set(provider === 'gemini' ? { geminiTtsModel: id } : { elevenModel: id }))}
              onRefresh={() => void models.refresh()}
            />
          </div>
        )}
      </Card>
    </>
  )
}

function HiggsfieldSection({ statusOf, onChanged }: { statusOf: (p: ApiProvider) => KeyStatus | undefined; onChanged: () => void }) {
  const status = statusOf('higgsfield')
  const openaiStatus = statusOf('openai')
  return (
    <>
      <SectionTitle
        icon={<ImageIcon className="size-5" />}
        title="Gambar dan video"
        sub="Higgsfield dan OpenAI membuat gambar klip, lembar karakter, dan (Higgsfield) video AI."
      />
      <Card>
        <div className="flex items-center gap-3">
          <ProviderLogo id="openai" />
          <div className="flex flex-1 flex-col">
            <span className="text-base font-bold">OpenAI</span>
            <span className="text-[13px] text-ink-2">GPT Image lewat API resmi — model yang sama seperti di ChatGPT web, tapi sebagai backend sungguhan: tanpa browser, tanpa verifikasi bot</span>
          </div>
          <StatusBadge status={openaiStatus} />
        </div>
        <KeyForm
          provider="openai"
          name="OpenAI"
          status={openaiStatus}
          placeholder="Tempel kunci API OpenAI (sk-…)"
          hint={
            <>
              Di <strong className="text-ink">platform.openai.com/api-keys</strong>, buat kunci baru lalu tempel di sini. Kunci ini butuh saldo
              (isi $5 sekali, cukup untuk ratusan gambar — sekitar $0,01–0,05 per gambar). Kunci yang sama juga bisa dipakai untuk naskah
              (pilih OpenAI di bagian Naskah di atas).
            </>
          }
          help="Kunci dicek dengan daftar model, tanpa biaya."
          link="https://platform.openai.com/api-keys"
          linkLabel="Buka OpenAI API keys"
          onChanged={onChanged}
        />
        <p className="flex items-start gap-2.5 border-t border-dashed border-line pt-4 text-[13px] leading-relaxed text-ink-2">
          <Film className="mt-0.5 size-4 shrink-0" />
          <span>
            OpenAI Images API hanya membuat gambar (tanpa video), dengan referensi sampai 16 lembar karakter — paling banyak dari semua penyedia.
            Model yang tersedia: GPT Image 1.5 dan GPT Image 2.
          </span>
        </p>
      </Card>
      <Card>
        <div className="flex items-center gap-3">
          <ProviderLogo id="higgsfield" />
          <div className="flex flex-1 flex-col">
            <span className="text-base font-bold">Higgsfield</span>
            <span className="text-[13px] text-ink-2">GPT Image 2.5, Kling, Seedance, dan model lain dari akun Higgsfield kamu</span>
          </div>
          <StatusBadge status={status} />
        </div>
        <KeyForm
          provider="higgsfield"
          name="Higgsfield"
          status={status}
          placeholder="Tempel hasil tombol Copy API key"
          hint={
            <>
              Di console Higgsfield, buka API Keys lalu klik <strong className="text-ink">Copy API key</strong> dan tempel di sini. Formatnya{' '}
              <code className="rounded bg-sand px-1 font-mono text-xs">KEY_ID:KEY_SECRET</code>. Kalau kamu memegang Key ID dan Secret terpisah, gabungkan
              dengan titik dua.
            </>
          }
          help="Kunci dicek dengan permintaan estimasi biaya, tanpa memakai kredit."
          link="https://higgsfield.ai/s/higgsfield-api-yt-bangtutorial-lPMrHK"
          linkLabel="Buka console Higgsfield"
          onChanged={onChanged}
        />
        <p className="flex items-start gap-2.5 border-t border-dashed border-line pt-4 text-[13px] leading-relaxed text-ink-2">
          <Film className="mt-0.5 size-4 shrink-0" />
          <span>
            Semua {visualImageModels('higgsfield').length} model gambar dan {visualVideoModels('higgsfield').length} model video Higgsfield bisa dipakai.
            Alternatifnya, pilih <strong className="text-ink">Gemini</strong> sebagai penyedia visual ({visualImageModels('gemini').length} model gambar Nano
            Banana dan {visualVideoModels('gemini').length} model video Omni Flash) — pakai kunci Gemini yang sama — atau{' '}
            <strong className="text-ink">ChatGPT Web</strong> untuk gambar gratis lewat kuota free akun ChatGPT (tanpa kunci API, tanpa video).
            Modelnya dipilih per proyek di langkah <strong className="text-ink">Ide cerita</strong>, bagian Model AI.
          </span>
        </p>
      </Card>
    </>
  )
}

/**
 * ChatGPT Web: no API key — the app drives chatgpt.com in a browser (Google Chrome must be
 * installed) and spends the account's free image quota. The login lives in the browser profile
 * and is checked live; the button below opens the browser for the user to log in.
 */
function ChatGptWebSection() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [driver, setDriver] = useState<'cdp' | 'real-profile' | 'fresh' | 'extension' | null>(null)
  const [extDir, setExtDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    let live = true
    void window.api.chatgptWeb
      .status()
      .then((s) => {
        if (live) {
          setLoggedIn(s.loggedIn)
          setDriver(s.driver)
        }
      })
      .catch(() => {
        if (live) setLoggedIn(false)
      })
    void window.api.chatgptWeb
      .extensionDir()
      .then((d) => {
        if (live) setExtDir(d)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const login = async (): Promise<void> => {
    setBusy(true)
    setNote('Browser ChatGPT terbuka — login di sana, lalu kembali ke sini.')
    try {
      const s = await window.api.chatgptWeb.login()
      setLoggedIn(s.loggedIn)
      setNote(s.loggedIn ? 'Login berhasil. Gambar klip bisa dibuat lewat ChatGPT Web.' : 'Login belum selesai (waktu habis). Coba lagi.')
    } catch (e) {
      setLoggedIn(false)
      setNote(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  /** One click: the app drives the user's real Chrome profile (already logged in, no bot check).
   * Chrome closes once and its tabs come back inside the driver browser — no debug flag, no
   * Terminal command. */
  const attachAndLogin = async (): Promise<void> => {
    setBusy(true)
    setNote('Chrome kamu ditutup sebentar, lalu dibuka lagi sebagai browser kerja (tab pulih kembali)…')
    try {
      await window.api.chatgptWeb.attach()
      await login()
      const s = await window.api.chatgptWeb.status()
      setDriver(s.driver)
    } catch (e) {
      setBusy(false)
      setNote(errorText(e))
    }
  }

  /** Closes the driver browser and hands the user's Chrome back. */
  const release = async (): Promise<void> => {
    setBusy(true)
    setNote('Mengembalikan Chrome kamu…')
    try {
      await window.api.chatgptWeb.release()
      setDriver(null)
      setLoggedIn(false)
      setNote('Chrome kamu sudah kembali. Klik "Pakai Chrome yang sudah login" lagi kalau mau membuat gambar.')
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <ModelLogo family="chatgpt" size={40} />
        <div className="flex flex-1 flex-col">
          <span className="text-base font-bold">ChatGPT Web</span>
          <span className="text-[13px] text-ink-2">GPT Image lewat browser chatgpt.com · kuota free akun ChatGPT, tanpa kunci API</span>
        </div>
        {loggedIn === null ? <Badge tone="draft">Mengecek…</Badge> : loggedIn ? <Badge tone="ok">Login aktif</Badge> : <Badge tone="draft">Belum login</Badge>}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">
        Gambar dibuat satu per satu di browser (butuh Google Chrome terpasang). Lembar karakter ikut dilampirkan supaya tokoh tetap sama.
        Hanya gambar — video AI tidak tersedia di penyedia ini, dan kalau ChatGPT menampilkan pemeriksaan bot atau tampilannya berubah,
        pembuatan gambar gagal dan bisa dicoba lagi setelah login ulang. Kalau Chrome kamu sudah login, pakai tombol kedua: aplikasi
        memakai profil Chrome kamu sendiri sebagai browser kerja — sudah login, tanpa verifikasi bot, tanpa perintah terminal.
        Selama browser kerja itu jalan, Chrome biasa tidak bisa dibuka; tombol ketiga mengembalikannya.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void login()} disabled={busy}>
          {busy ? 'Menunggu login di browser…' : loggedIn ? 'Buka browser & login ulang' : 'Buka browser & login'}
        </Button>
        <Button onClick={() => void attachAndLogin()} disabled={busy}>
          Pakai Chrome yang sudah login
        </Button>
        {driver === 'real-profile' && (
          <Button onClick={() => void release()} disabled={busy}>
            Kembalikan Chrome
          </Button>
        )}
        {note && <span className="text-[13px] text-ink-2">{note}</span>}
      </div>
      <div className="flex flex-col gap-2 border-t border-dashed border-line pt-4">
        <span className="text-sm font-semibold">
          Cara paling andal: ekstensi Chrome {driver === 'extension' && <Badge tone="ok">Ekstensi aktif</Badge>}
        </span>
        <p className="text-[13px] leading-relaxed text-ink-2">
          Ekstensi ini jalan di dalam Chrome kamu sendiri — tanpa profil, tanpa flag, tanpa verifikasi bot. Sekali pasang, gambar
          dibuat lewat tab chatgpt.com yang sudah kamu buka. Caranya: buka chrome://extensions, nyalakan Developer mode, klik
          “Load unpacked”, lalu pilih folder ini:
        </p>
        {extDir && <span className="break-all font-mono text-[12px] text-ink-2">{extDir}</span>}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void window.api.chatgptWeb.openExtensionDir()}>Buka folder ekstensi</Button>
          <Button onClick={() => void window.api.chatgptWeb.openChromeExtensions()}>Buka chrome://extensions</Button>
        </div>
      </div>
    </Card>
  )
}

export function Settings() {
  const { go, route } = useApp()
  const back = route.name === 'settings' && route.back ? route.back : ({ name: 'home' } as const)
  const [tab, setTab] = useState<Tab>('services')
  const [keys, setKeys] = useState<KeyStatus[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [folder, setFolder] = useState('')

  const reload = (): void => {
    void window.api.settings.keys().then(setKeys)
    void window.api.settings.get().then(setSettings)
  }
  useEffect(() => {
    reload()
    void window.api.exporter.defaultFolder().then(setFolder)
  }, [])

  const statusOf = (p: ApiProvider): KeyStatus | undefined => keys.find((k) => k.provider === p)

  const NAV: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'services', label: 'Layanan AI dan kunci', icon: <KeyRound className="size-[18px]" /> },
    { id: 'general', label: 'Umum', icon: <SlidersHorizontal className="size-[18px]" /> },
    { id: 'about', label: 'Tentang aplikasi', icon: <Info className="size-[18px]" /> }
  ]

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[68px] shrink-0 items-center gap-3.5 border-b border-line bg-surface px-8">
        <button type="button" onClick={() => go({ name: 'home' })}>
          <Logo />
        </button>
        <span className="text-xl text-line-3">/</span>
        <span className="font-semibold">Pengaturan</span>
        <div className="flex-1" />
        <Button icon={<ArrowLeft className="size-[18px]" />} onClick={() => go(back)}>
          {back.name === 'project' ? 'Kembali ke proyek' : 'Kembali ke beranda'}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <nav aria-label="Bagian pengaturan" className="flex flex-col gap-1 border-r border-line pl-6 pr-4 pt-7">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={tab === n.id ? 'page' : undefined}
              onClick={() => setTab(n.id)}
              className={cx(
                'flex h-11 items-center gap-3 rounded-xl px-3.5 text-left text-[15px]',
                tab === n.id ? 'bg-ink font-semibold text-paper' : 'font-medium text-ink hover:bg-sand'
              )}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <main className="scroll-thin overflow-y-auto">
          <div className="flex max-w-[900px] flex-col gap-3.5 px-14 pb-24 pt-8">
            {tab === 'services' && settings && (
              <>
                <div>
                  <h1 className="font-display text-[34px] font-bold tracking-[-0.015em]">Layanan AI dan kunci</h1>
                  <p className="mt-2 max-w-[700px] text-[15px] text-ink-2">
                    Bang Story memakai akun layanan milikmu sendiri. Kunci disimpan terenkripsi di komputer ini dan hanya dikirim langsung ke
                    layanan yang bersangkutan.
                  </p>
                </div>
                <LlmSection settings={settings} statusOf={statusOf} onChanged={reload} onSettings={setSettings} />
                <TtsSection settings={settings} statusOf={statusOf} onChanged={reload} onSettings={setSettings} />
                <HiggsfieldSection statusOf={statusOf} onChanged={reload} />
                <ChatGptWebSection />
                <WhisperSection settings={settings} onSettings={setSettings} />
              </>
            )}

            {tab === 'general' && settings && (
              <>
                <div>
                  <h1 className="font-display text-[34px] font-bold tracking-[-0.015em]">Umum</h1>
                  <p className="mt-2 text-[15px] text-ink-2">Pilihan bawaan untuk proyek baru.</p>
                </div>
                <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6">
                  <Field label="Bahasa default naskah dan suara">
                    <Select
                      label="Bahasa default naskah dan suara"
                      value={settings.defaultLanguage}
                      onChange={async (v) => setSettings(await window.api.settings.set({ defaultLanguage: v }))}
                      options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                      className="max-w-[320px]"
                    />
                  </Field>
                  <Field label="Folder ekspor">
                    <div className="flex gap-2">
                      <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-line bg-sand px-3.5 font-mono text-[13px]">
                        <FolderOpen className="size-[17px] shrink-0 text-ink-2" />
                        <span className="truncate">{folder}</span>
                      </div>
                      <Button
                        className="h-11"
                        onClick={async () => {
                          const f = await window.api.exporter.pickFolder()
                          if (f) setFolder(f)
                        }}
                      >
                        Ganti folder
                      </Button>
                    </div>
                  </Field>
                </section>
              </>
            )}

            {tab === 'about' && <AboutSection />}
          </div>
        </main>
      </div>
    </div>
  )
}
