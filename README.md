<div align="center">

<img src="docs/images/logo.svg" width="88" alt="Logo Bang Story">

# Bang Story

**Ubah ide cerita jadi video YouTube, langsung dari komputermu.**

AI menyusun naskah dan visual, Higgsfield, Gemini, atau ChatGPT Web membuat gambar dan video, narator AI mengisi suara,<br>
lalu kamu merapikannya di editor timeline dan mengekspor MP4.

[![Versi](https://img.shields.io/badge/versi-1.0.0-c93a1b?style=flat-square)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-1f1d1a?style=flat-square)](#kebutuhan)
[![Lisensi MIT](https://img.shields.io/badge/lisensi-MIT-2e7d32?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org)
[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![YouTube](https://img.shields.io/badge/YouTube-Bang%20Tutorial-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://youtube.com/bangtutorial)

[Fitur](#fitur) · [Tampilan](#tampilan) · [Tutorial](#tutorial) · [Mulai cepat](#mulai-cepat) · [Kunci API](#kunci-api) · [Pengembangan](#pengembangan) · [Dokumentasi](docs/README.md)

<img src="docs/images/editor.webp" width="100%" alt="Editor Bang Story: pratinjau dengan caption karaoke, panel pengaturan klip, dan timeline berisi klip, caption, suara narasi, dan musik">

</div>

## Tentang

Bang Story adalah aplikasi desktop untuk kreator konten. Tulis satu ide, misalnya *"Bagaimana rasanya hidup di Batavia tahun 1700-an?"*, lalu aplikasi akan:

- menyusun naskah per adegan;
- membuat gambar dan video AI;
- merekam narasi dan menyamakan caption dengan suaranya;
- merangkai semuanya di editor.

Hasilnya video MP4 yang siap diunggah ke YouTube, Shorts, Reels, atau TikTok.

Semua proyek, gambar, video, dan suara disimpan di komputermu. Kamu memakai kunci API sendiri (*bring your own key*), jadi biaya AI dibayar langsung ke penyedianya, tanpa server perantara.

## Fitur

**1. Ide cerita**
- Tulis ide atau sinopsis, lalu atur:
  - durasi (30 detik sampai 10 menit);
  - bahasa dan format (16:9 atau 9:16);
  - gaya visual (2D, 3D, atau realistis);
  - suara narator.
- Pilih model gambar dan video per proyek (Higgsfield, Gemini, atau ChatGPT Web), lengkap dengan perkiraan kredit.

**2. Naskah**
- AI menulis alur dan narasi (VO) setiap adegan. Adegan bisa diubah, ditambah, dihapus, dan diurutkan ulang.
- Narasi boleh memakai tag ekspresi suara seperti `<short pause>`, `<chuckles>`, atau `<whispers>`.

**3. Storyboard**
- Dari naskah final, AI menyiapkan untuk tiap adegan:
  - prompt visual;
  - pemeran beserta lembar karakter;
  - gerak kamera dan transisi;
  - arahan gerak untuk video AI.
- Tersedia 14 model gambar dan 34 model video dari Higgsfield, plus Nano Banana dan Omni Flash dari Gemini, plus GPT Image lewat ChatGPT Web (kuota free akun ChatGPT, gambar saja).
- Narasi direkam dalam satu rekaman utuh (Gemini TTS atau ElevenLabs), lalu dipotong otomatis per adegan. Suara dan intonasinya jadi konsisten.

**4. Editor**
- Timeline seperti editor video biasa:
  - tarik tepi klip untuk mengubah durasinya;
  - **Potong** (S) dan **Hapus** (Delete);
  - geser suara, caption, musik, dan overlay.
- Transisi per sambungan klip, dengan pratinjau langsung.
- Gerak kamera untuk klip gambar maupun video.
- Caption karaoke yang mengikuti suara asli lewat Whisper lokal. Pilih dari 15 font, lalu atur warna, ukuran, dan kotak latarnya.
- Musik latar yang otomatis mengecil saat narasi. Tersedia juga pembuat prompt musik untuk Suno atau AI musik lain.
- Overlay logo, watermark, dan teks yang bisa digeser langsung di pratinjau.

**5. Ekspor**
- MP4 dirender dengan FFmpeg di komputermu, sama dengan yang terlihat di pratinjau.
- Resolusi 720p, 1080p, atau 4K, dengan 30 atau 60 fps.
- Caption langsung di video, dan bisa juga disimpan sebagai file `.srt`.
- Volume suara disamakan ke −14 LUFS, standar YouTube.

## Tampilan

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/images/beranda.webp" alt="Beranda: kolom ide cerita dan daftar proyek"><br><b>Beranda</b>: tulis ide dan buka proyekmu</td>
    <td width="50%" valign="top"><img src="docs/images/ide-cerita.webp" alt="Langkah Ide cerita: durasi, bahasa, format, suara narator, dan gaya visual"><br><b>Ide cerita</b>: durasi, format, suara, dan gaya visual</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="docs/images/naskah.webp" alt="Langkah Naskah: alur dan narasi tiap adegan"><br><b>Naskah</b>: periksa alur dan narasi tiap adegan</td>
    <td width="50%" valign="top"><img src="docs/images/storyboard.webp" alt="Langkah Storyboard: gambar, pemeran, dan narasi tiap klip"><br><b>Storyboard</b>: gambar, video, pemeran, dan suara tiap klip</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="docs/images/transisi.webp" alt="Panel Transisi di editor dengan pratinjau transisi geser ke kiri"><br><b>Transisi</b>: pilih per sambungan dan lihat pratinjaunya</td>
    <td width="50%" valign="top"><img src="docs/images/caption.webp" alt="Panel Caption di editor dengan daftar font yang langsung menampilkan contoh hurufnya"><br><b>Caption</b>: gaya, font, warna, dan ukuran</td>
  </tr>
</table>

## Tutorial

<a href="https://youtu.be/5EbWJo3VnRA"><img src="https://img.youtube.com/vi/5EbWJo3VnRA/maxresdefault.jpg" width="560" alt="Tonton tutorial Bang Story di YouTube"></a>

Cara membuat video dari ide sampai ekspor: [tonton di YouTube](https://youtu.be/5EbWJo3VnRA). Video ini juga bisa diputar dari **Pengaturan › Tentang** di dalam aplikasi.

## Mulai cepat

### Kebutuhan

- **Windows 10/11 64-bit.** Aplikasi juga bisa dijalankan dari kode sumber di macOS, tapi belum diuji penuh. Caption akurat (Whisper) dan installer baru tersedia untuk Windows.
- **Kunci API** (lihat [Kunci API](#kunci-api)) untuk:
  - Higgsfield;
  - satu penyusun cerita;
  - satu penyedia suara narator.
- **Node.js 22 atau lebih baru**, hanya kalau menjalankan dari kode sumber.

### Cara termudah: klik 2x START

Butuh [Node.js](https://nodejs.org) versi LTS dan koneksi internet saat pertama kali dibuka.

- **Windows:** klik 2x `START - WIN.bat`.
- **macOS:** klik 2x `START - MAC.command`. Kalau muncul pesan tidak punya izin, buka Terminal di folder ini dan jalankan `chmod +x "START - MAC.command"` sekali. Kalau macOS memblokirnya, klik kanan file itu › Open.

Saat pertama kali dibuka, START memasang semua kebutuhan (`npm install`), mengunduh Electron, dan menyusun aplikasinya. Ini butuh beberapa menit. Setelah itu aplikasi langsung terbuka setiap kali START diklik. Kalau folder ini dipindah ke OS lain, START otomatis memasang ulang kebutuhannya.

Kalau kode di `src` diubah, hapus folder `out` (atau jalankan `npm run build`) supaya START menyusun ulang aplikasinya.

### Menjalankan dari kode sumber

```bash
npm install
npm run dev
```

### Membuat installer Windows

```bash
npm run dist
```

Hasilnya ada di `dist/BangStory-Setup-<versi>.exe`. Untuk folder siap jalan tanpa installer, jalankan `npx electron-builder --win --dir`.

Setelah aplikasi terbuka, isi kunci API di **Pengaturan › Layanan AI dan kunci**. Lalu tulis idemu di beranda dan klik **Mulai**.

## Kunci API

Setiap bagian (penyusun cerita, suara narator) punya satu dropdown penyedia. Hanya penyedia yang dipilih yang dipakai, kecuali kalau penyedia itu gagal — saat itu aplikasi otomatis mencoba Pollinations gratis sebagai cadangan (gambar dan naskah), supaya kerjaan jalan terus. Kunci dienkripsi dengan Windows DPAPI (`safeStorage`) dan hanya dikirim ke layanannya masing-masing.

| Layanan | Dipakai untuk | Wajib |
|---|---|---|
| [Pollinations](https://pollinations.ai) (gratis, tanpa kunci, tanpa login) | Gambar (Flux) dan naskah — juga cadangan otomatis kalau penyedia utama gagal | Tidak |
| [Higgsfield](https://higgsfield.ai) (satu kunci dari tombol **Copy API key**, format `KEY_ID:KEY_SECRET`) | Gambar, lembar karakter, video AI | Ya, kecuali memakai Gemini sebagai penyedia visual |
| Penyusun cerita, pilih satu: Google Gemini, OpenRouter, Groq, atau endpoint custom yang kompatibel dengan OpenAI | Naskah, rencana visual, pemeran | Ya, salah satu |
| Google Gemini | Suara narator Gemini TTS; gambar (Nano Banana) dan video (Omni Flash) kalau dipilih sebagai penyedia visual | Kalau memakai Gemini TTS atau visual Gemini |
| ElevenLabs | Suara narator dengan waktu per kata yang presisi | Opsional |

- **Daftar model penyusun cerita** diambil langsung dari penyedia setelah kuncinya disimpan, lalu dipilih lewat dropdown yang bisa dicari.
- **Endpoint custom** menerima server apa pun yang kompatibel dengan OpenAI API, misalnya:
  - Ollama (`http://localhost:11434/v1`);
  - LM Studio, vLLM, atau DeepSeek;
  - xAI Grok (`https://api.x.ai/v1`).

## Pertanyaan umum

<details>
<summary><b>Apakah Bang Story gratis?</b></summary>

Ya. Aplikasinya gratis dan kodenya terbuka dengan lisensi MIT. Yang berbayar hanya pemakaian layanan AI. Biayanya kamu bayar langsung ke penyedia, dengan kunci API milikmu:
- kredit Higgsfield untuk gambar dan video;
- biaya Gemini, OpenRouter, Groq, atau ElevenLabs sesuai paket akunmu.
- **Pollinations gratis** (tanpa kunci, tanpa login) bisa dipakai untuk gambar dan naskah, dan otomatis jadi cadangan kalau penyedia utama gagal.

Perkiraan kredit tiap model Higgsfield ditampilkan sebelum membuat gambar atau video. Perkiraannya diambil dari endpoint `estimate` Higgsfield, yang tidak memakai kredit.
</details>

<details>
<summary><b>Di mana proyek saya disimpan?</b></summary>

Di folder `%APPDATA%\Bang Story`: database SQLite (`studio.db`) dan folder `projects` berisi gambar, video, dan suara. Proyek tersimpan otomatis, atau langsung dengan Ctrl+S. Data dari nama lama aplikasi (Studio Cerita) dipindahkan otomatis.
</details>

<details>
<summary><b>Apa saja yang dikirim ke internet?</b></summary>

Hanya permintaan ke layanan AI yang kamu pakai, dengan kunci milikmu. Render video (FFmpeg) dan pengenalan suara untuk caption (Whisper) berjalan di komputermu.
</details>

<details>
<summary><b>Kenapa caption kadang tidak pas dengan suara?</b></summary>

Gemini TTS tidak mengirim waktu per kata, jadi tanpa Whisper waktunya hanya perkiraan. Unduh model **Whisper Small** (sekitar 488 MB) di **Pengaturan › Caption akurat**. Setelah itu, caption mengikuti suara asli dengan selisih sekitar 0,1–0,2 detik. Klip lama bisa disinkronkan ulang dari tab Caption di editor. ElevenLabs sudah mengirim waktu per kata, jadi tidak butuh Whisper.
</details>

<details>
<summary><b>Kenapa model Seedream tidak ada?</b></summary>

Seedream belum tersedia di API Higgsfield, hanya di aplikasi web mereka. Model bawaannya:
- gambar: GPT Image 2.5 Sunburst;
- video: Kling 3.0 Standard.

Model lain bisa dipilih per proyek.
</details>

## Pengembangan

```bash
npm install          # pasang dependensi
npm run dev          # mode pengembangan dengan hot reload
npm run typecheck    # pemeriksaan TypeScript (strict)
npm run build        # build ke folder out/
npm run dist         # installer Windows ke folder dist/
```

| Bagian | Teknologi |
|---|---|
| Aplikasi desktop | Electron 44, electron-vite 5, Vite 7 |
| Tampilan | React 19, Tailwind CSS 4, Zustand |
| Penyimpanan | SQLite (better-sqlite3) dan file lokal |
| Video dan audio | FFmpeg (ffmpeg-static), caption ASS/libass |
| Caption akurat | whisper.cpp dengan model Whisper Small |
| Layanan AI | Higgsfield, Google Gemini, OpenRouter, Groq, ElevenLabs |

```
src/
  main/       proses utama: database, layanan AI, FFmpeg, Whisper, file
  preload/    jembatan aman window.api
  shared/     aturan yang dipakai pratinjau dan ekspor (gerak kamera, caption, timeline, model)
  renderer/   tampilan React
resources/    font caption, whisper.cpp, file lisensi
docs/         dokumentasi pengembang
```

Ingin mengembangkan sendiri, atau dibantu AI agent seperti Claude Code, Codex, atau Cursor? Mulai dari sini:

- [AGENTS.md](AGENTS.md): ringkasan proyek, perintah, peta kode, dan aturan yang tidak boleh dilanggar. Claude Code membacanya lewat [CLAUDE.md](CLAUDE.md).
- [docs/](docs/README.md):
  - arsitektur dan model data;
  - alur produksi, editor, dan ekspor;
  - layanan AI dan cara menguji;
  - konvensi, keputusan teknis, dan masalah yang diketahui.
- [CHANGELOG.md](CHANGELOG.md): riwayat versi.

## Kontribusi

Laporan bug, ide fitur, dan pull request sangat diterima.

1. Baca [AGENTS.md](AGENTS.md) dan [docs/konvensi.md](docs/konvensi.md) dulu.
2. Buat perubahan yang kecil dan fokus. Pastikan `npm run typecheck` dan `npm run build` bersih.
3. Uji perubahan tampilan atau ekspor dengan dev harness ([docs/pengembangan.md](docs/pengembangan.md)).
4. Catat perubahan di [CHANGELOG.md](CHANGELOG.md), dan catat keputusan teknis baru di [docs/keputusan-teknis.md](docs/keputusan-teknis.md).

## Lisensi

Kode Bang Story memakai [lisensi MIT](LICENSE). Komponen pihak ketiga yang ikut terpasang memakai lisensinya sendiri:

| Komponen | Lisensi |
|---|---|
| FFmpeg (lewat ffmpeg-static) | GPL v3 |
| whisper.cpp | MIT |
| Model Whisper Small (diunduh terpisah) | MIT |
| 15 font caption dari Google Fonts | SIL Open Font License 1.1 dan Apache 2.0 |
| LobeHub Icons (logo penyedia) | MIT |

Teks lisensinya ada di `resources/licenses`. Lisensi FFmpeg disalin dari paket `ffmpeg-static` saat installer dibuat. Logo penyedia layanan adalah merek milik pemiliknya masing-masing.

---

<div align="center">

Dibuat oleh **[Bang Tutorial](https://youtube.com/bangtutorial)**. Tutorial dan tips lainnya ada di channel YouTube-nya.

</div>
