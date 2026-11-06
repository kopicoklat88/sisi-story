# Layanan AI dan kunci API

Semua panggilan ke layanan luar dilakukan di **proses utama** (`src/main/services/`). Renderer tidak pernah
memegang kunci API.

## Kunci API (BYOK)

Pengguna memasukkan kuncinya sendiri di **Pengaturan › Layanan AI dan kunci**.

- Disimpan di tabel `secrets` setelah dienkripsi dengan Electron `safeStorage`. Di Windows ini memakai DPAPI,
  terikat ke akun Windows pengguna, jadi salinan `studio.db` di komputer lain tidak bisa membuka kuncinya.
- Kunci kriptonya dibuat saat startup (`warmUpEncryption`) supaya tidak hilang kalau aplikasi ditutup paksa tepat
  setelah menyimpan kunci pertama.
- `requireSecret(provider)` melempar error berbahasa Indonesia kalau kunci belum ada.
- `revealSecret` hanya dipanggil tombol "tampilkan kunci" di Pengaturan.
- **Jangan pernah** menulis kunci ke log, pesan error, file, URL, atau mengirimnya ke layanan lain.
- Mengganti kunci Higgsfield menghapus cache estimasi kredit (`forgetEstimates`).

| Penyedia (`ApiProvider`) | Dipakai untuk |
|---|---|
| `higgsfield` | gambar, lembar karakter, video |
| `gemini` | LLM (naskah/visual), Gemini TTS, dan visual (Nano Banana + Omni Flash) |
| `elevenlabs` | TTS |
| `openrouter`, `groq`, `custom`, `openai` | LLM lewat API kompatibel OpenAI |
| ChatGPT Web (tanpa kunci) | visual gambar saja, lewat browser |
| `openai` | visual gambar saja, lewat Images API resmi |
| `custom` | visual gambar saja, lewat endpoint OpenAI-compatible sendiri (misal 9Router) |

## Visual (`services/visual.ts`, `services/gemini-visual.ts`, `services/chatgpt-web.ts`, `shared/visual.ts`)

- Gambar dan video AI dibuat lewat satu adapter (`VisualAdapter`): `higgsfield`, `gemini`, `chatgpt-web`, `openai`, atau `custom`, dipilih per proyek
  (`project.visualProvider`, kolom `visual_provider`; proyek lama tanpa kolom dibaca sebagai `higgsfield`, dan nilai di luar daftar itu juga jatuh ke `higgsfield`).
  `generation.ts` tidak lagi memanggil Higgsfield langsung.
- Higgsfield: seperti sebelumnya — gambar lewat `submitImage`, video lewat `submitVideo`, hasil diunduh dari URL,
  estimasi kredit dari endpoint `estimate`.
- Gemini: lewat **Interactions API** (REST mentah, `POST /v1beta/interactions`, header `Api-Revision: 2026-05-20`),
  bukan SDK. Gambar: Nano Banana (`gemini-nano-banana-2.1` bawaan, plus `gemini-3-pro-image`,
  `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`); video: Omni Flash
  (`gemini-omni-1.2-flash`, 3–15 detik, audio asli). Referensi dikirim inline sebagai base64 (maksimal 6 gambar);
  gambar bisa memakai beberapa referensi, video memakai gambar klip sebagai first frame. Hasil diambil dengan
  polling (`GET /interactions/{id}`, interval 10 detik) dari `steps[]` → `model_output` → `content` bertipe
  `image`/`video` (base64). **Background wajib `store: true`** — dengan `store: false` API menolaknya
  (HTTP 400, "store=true is required for background interactions").
- Gemini tidak punya endpoint estimasi: `estimate` selalu mengembalikan null, dan UI menampilkan catatan tagihan
  per pemakaian, bukan kredit. Gemini juga tidak punya endpoint pembatalan: `cancel` adalah no-op dan menghentikan
  polling di sisi kita.
- Semua gambar Gemini membawa watermark SynthID.
- **OpenAI: GPT Image lewat Images API resmi** (`POST /v1/images/generations` JSON; dengan referensi, `POST /v1/images/edits`
  multipart dengan `image[]`, sampai 16 gambar, `input_fidelity: high`). Model: GPT Image 1.5 (bawaan) dan GPT Image 2 —
  gpt-image-1 dan gpt-image-1-mini sudah pensiun, jadi tidak masuk katalog. Kualitas `medium`, ukuran mengikuti aspek
  (16:9 → 1536x1024, 9:16 → 1024x1536), hasil selalu base64 (`b64_json`, PNG). Tagihan per pemakaian (~$0,01–0,05 per
  gambar menengah), jadi `estimate` selalu null dan UI menampilkan catatan tagihan. Kunci yang sama juga dipakai sebagai
  penyedia LLM (GPT-5 dkk. lewat `/v1/chat/completions` dan daftar model dari `GET /v1/models`).
- **Custom: endpoint gambar OpenAI-compatible sendiri** (misal 9Router) — adapter yang sama dengan OpenAI, tapi alamat +
  kunci diambil dari pengaturan custom (yang sama dengan naskah), dan body permintaan sengaja minimal (tanpa `quality`,
  `input_fidelity`, `output_format`) supaya router generik tidak menolak parameter yang tidak dikenalnya. ID model gambar
  diketik pengguna di picker (bawaan `gpt-image-1.5`); jawaban boleh base64 (`b64_json`) atau URL (diunduh). Tagihan
  mengikuti router pengguna, jadi `estimate` selalu null.
- ChatGPT Web: **tanpa API** — ChatGPT web tidak punya API gambar publik, jadi driver (`services/chatgpt-web.ts`,
  Playwright) menyetir chatgpt.com di browser sungguhan: login sekali (sesi tersimpan di folder profil
  `chatgpt-web` di data aplikasi), tiap gambar dibuat di chat baru dengan prompt diketik, lembar karakter
  dilampirkan lewat file picker (maksimal 3), lalu gambar hasil diunduh dari balasan. Butuh Google Chrome terpasang
  (Playwright memakai `channel: 'chrome'`, tanpa unduh browser tambahan). Satu gambar dalam satu waktu (antre
  serial), browser tampil supaya pengguna bisa melihat dan menyelamatkan kalau ada pemeriksaan bot. Hanya gambar
  (GPT Image 1) — video AI tidak tersedia, dan UI menampilkannya sebagai catatan, bukan pilihan model. Tidak ada
  estimasi biaya (kuota free akun ChatGPT) dan tidak ada pembatalan sungguhan (`cancel` no-op; hasil yang sudah
  berjalan di browser dibuang). **Empat jalur browser, dari yang paling andal:** (1) **ekstensi Chrome** ("Bang Story —
  ChatGPT", `resources/chatgpt-extension`) — jalan di dalam Chrome pengguna sendiri sebagai kode first-party, jadi
  tanpa profil, tanpa flag debug, tanpa verifikasi bot, dan tanpa menutup Chrome; ekstensi mengambil tugas gambar
  dari server lokal aplikasi (`http://127.0.0.1:18097`, `services/chatgpt-extension-server.ts`), mengerjakannya di
  tab chatgpt.com, lalu mengirim hasilnya kembali. Sekali pasang lewat "Load unpacked" di chrome://extensions, dan
  selama ekstensinya terhubung, adapter memakai jalur ini dulu. (2) Kalau Chrome pengguna berjalan dengan remote
  debugging (port 9222, `CHATGPT_WEB_CDP_URL`), driver menumpang Chrome itu lewat CDP — sudah login, tanpa
  verifikasi bot, dan browser pengguna tidak pernah ditutup driver; (3) kalau tidak, tombol "Pakai Chrome yang
  sudah login" di Pengaturan menjalankan driver dengan **profil Chrome asli pengguna** — Chrome ditutup sekali,
  lalu dibuka lagi sebagai browser kerja dengan tab yang pulih, sudah login dan sudah dipercaya, tanpa flag debug
  sama sekali. Selama browser kerja itu jalan, Chrome biasa tidak bisa dibuka; tombol "Kembalikan Chrome" menutup
  driver dan membuka lagi Chrome pengguna secara normal. Status check dan pembuatan gambar tidak pernah menutup
  Chrome pengguna sendiri. (4) Kalau tidak ada profil Chrome, driver meluncurkan profil baru yang diperkeras
  (`--disable-blink-features=AutomationControlled` + init script sembunyikan `navigator.webdriver`) supaya
  pemeriksaan bot biasanya lolos sendiri.
- Menambah penyedia visual baru: tambahkan ke `VisualProvider` (`types.ts`), katalog di `shared/visual.ts`,
  adapter di `services/visual.ts`, dan `DEFAULT_SETTINGS.visualModels`.

## LLM (`services/llm.ts`, `services/gemini.ts`)

- `generateJson({ system, prompt, schema, name })` memanggil penyedia aktif (`settings.llmProvider` +
  `llmModels[provider]`).
  - Gemini: `@google/genai` dengan `responseJsonSchema` (dan cadangan: skema ditulis di system instruction).
  - Lainnya: `/chat/completions`, dicoba berurutan `json_schema` (strict) → `json_object` → teks biasa, lalu JSON
    diambil dari teks (`extractJson`) untuk model yang tidak mendukung structured output.
- `listModels(source)`: daftar model live dari penyedia, dicache di tabel `cache` dan disegarkan saat basi.
- **Menambah penyedia LLM baru** yang kompatibel OpenAI: tambahkan ke `LlmProvider` dan `ApiProvider`
  (`types.ts`), `LLM_PROVIDERS` (`shared/models.ts`), konfigurasi base URL di `llm.ts`, dan `DEFAULT_SETTINGS.llmModels`.

## TTS

| Penyedia | File | Catatan |
|---|---|---|
| Gemini TTS | `services/gemini.ts` | PCM 24 kHz → WAV; daftar suara dari Voice Library (`listVoices`, cache 24 jam) dengan cadangan statis di `shared/models.ts`; contoh suara bawaan di `renderer/src/assets/voices` |
| ElevenLabs | `services/elevenlabs.ts` | memakai endpoint with-timestamps untuk waktu per kata; tag `<...>` diubah ke `[tag]` untuk model v3, atau ke `<break>` untuk model lama (`toElevenLabsText`) |

Narasi selalu dibuat satu rekaman utuh lalu dipotong. Lihat [alur-produksi.md](alur-produksi.md#4-narasi-srcmainnarrationts).

## Higgsfield (`services/higgsfield.ts`, `shared/higgsfield.ts`)

- Base URL `https://api.higgsfield.ai`, header `Authorization: Key <kunci>`.
- Alur: `submit(endpoint, body)` → polling `getStatus` → unduh hasil. `uploadFile` mengunggah gambar referensi
  (lembar karakter, gambar klip untuk video).
- `estimate(endpoint, body)` memanggil `/estimate/<endpoint>` → `{ credits, usd }`, dicache 24 jam di tabel `cache`.
  Endpoint ini gratis (tidak memakai kredit). API Higgsfield tidak punya daftar harga maupun endpoint saldo, jadi
  biaya per model selalu diambil dari sini.
- Pesan error dibuat ramah (`friendly`): kunci salah, kredit habis, terlalu banyak proses, model tidak tersedia.
- Untuk pengembangan, `STUDIO_HF_BASE` bisa diarahkan ke server tiruan (mock) supaya UI bisa diuji tanpa kredit.

### Katalog model (`src/shared/higgsfield-catalog.json`)

48 model: 14 model gambar (teks ke gambar) dan 34 model video yang bisa menganimasikan gambar klip. Model yang butuh
video masukan (edit video, motion control) atau hanya teks-ke-video sengaja tidak dimasukkan. Seedream belum tersedia
di API Higgsfield (hanya di aplikasi webnya). Satu entri:

```json
{
  "id": "kling-video/v3.0/std/image-to-video",
  "name": "Kling 3.0 · Standard · Image to video",
  "family": "Kling",
  "kind": "video",
  "input": { "field": "image_url", "mode": "first-frame", "max": 1 },
  "required": ["image_url"],
  "props": { "prompt": { "type": "string" }, "duration": { "type": "integer", "minimum": 3, "maximum": 15 }, "sound": { "enum": ["on", "off"] } },
  "durations": { "min": 3, "max": 15 },
  "tags": ["Kling"]
}
```

- `input.field`/`mode`/`max`: tempat gambar referensi atau frame pertama dikirim, dan berapa banyak.
- `props`: skema parameter dari dokumentasi Higgsfield. `imageBody`/`videoBody` di `shared/higgsfield.ts`
  mengisinya secara umum: rasio, resolusi, kualitas, durasi, mematikan `enhance_prompt`, `prompt_extend`, dan audio.
- `durations`: rentang (`min`/`max`) atau daftar (`values`) durasi video.
- **Menambah model**: tambahkan entri baru dengan format yang sama dari dokumentasi API Higgsfield
  (`https://docs.higgsfield.ai/docs/llms.txt`), lalu pastikan `imageBody`/`videoBody` tidak melempar error
  "butuh <field>" (`checkRequired`). Ikon keluarga model diatur di `components/ModelLogo.tsx`.
- Model bawaan: `DEFAULT_IMAGE_MODEL` dan `DEFAULT_VIDEO_MODEL` di `shared/higgsfield.ts`.

## Whisper lokal (`src/main/whisper.ts`)

- Biner: `resources/whisper/whisper-cli.exe` + DLL (whisper.cpp, lisensi MIT). Saat ini hanya untuk Windows.
- Model: `ggml-small.bin` (sekitar 488 MB) dari Hugging Face (`ggerganov/whisper.cpp`), diunduh di Pengaturan ke
  `<folder data>\models\whisper`, bisa dijeda dan dilanjutkan (HTTP Range), lalu dicek SHA-256. Untuk pengembangan, `STUDIO_WHISPER_URL` bisa menunjuk salinan lokal.
- Dijalankan di antrean `whisper` (satu per satu). Detail argumennya di [alur-produksi.md](alur-produksi.md#5-caption-akurat-whisper-lokal).

## YouTube (halaman About)

Video tutorial diputar lewat iframe `https://www.youtube.com/embed/<id>`. Sejak 2025 YouTube mewajibkan pemutar
embed mengirim identitas lewat header HTTP Referer (tanpa itu: Error 153). Aplikasi yang memuat halaman dari
`file://` tidak mengirim Referer, jadi `identifyToYouTube()` (`src/main/index.ts`) menambahkan
`Referer: https://id.bangtutorial.bangstory/` (ID aplikasi) hanya untuk permintaan embed. Iframe tanpa
autoplay, supaya putaran dari pengguna terhitung sebagai view.

## Membuka tautan

`app:openExternal` hanya menerima URL `https://` dan membukanya di browser bawaan. Pakai ini untuk semua tautan
ke luar (dokumentasi penyedia, channel YouTube, Suno, dan lainnya).
