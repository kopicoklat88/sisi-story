import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { chromium, type BrowserContext, type Page } from 'playwright-core'

/**
 * GPT Image through chatgpt.com in a real browser, spending the ChatGPT account's free image
 * quota instead of an API key. ChatGPT web has no public image API, so this drives the web UI
 * with Playwright: the user logs in once (the session persists in a profile folder), then each
 * image is a fresh chat with the prompt typed in, references attached, and the generated image
 * downloaded from the reply.
 *
 * This is deliberately the fragile provider: if OpenAI changes the composer, shows a bot check,
 * or the account is logged out, generation fails with a plain message and the user retries after
 * logging in again. Image only, one generation at a time, headed browser so the user can see
 * (and rescue) what is happening.
 */

const CHATGPT_URL = process.env.CHATGPT_WEB_URL ?? 'https://chatgpt.com/'
const LOGIN_WAIT_MS = 10 * 60 * 1000
const IMAGE_TIMEOUT_MS = 10 * 60 * 1000

export function defaultProfileDir(): string {
  return join(app.getPath('userData'), 'chatgpt-web')
}

/** Chromium to drive: the user's installed Chrome when present, else an explicit path. */
function launchOptions(executablePath?: string): { channel?: string; executablePath?: string } {
  if (executablePath) return { executablePath }
  if (process.env.CHATGPT_WEB_CHROME_PATH) return { executablePath: process.env.CHATGPT_WEB_CHROME_PATH }
  return { channel: 'chrome' }
}

let context: BrowserContext | null = null
let page: Page | null = null
let starting: Promise<Page> | null = null
/** Generations run one at a time: the web UI has a single composer. */
let queue: Promise<unknown> = Promise.resolve()

async function ensurePage(profileDir: string, executablePath?: string): Promise<Page> {
  if (page) return page
  if (!starting) {
    starting = (async () => {
      mkdirSync(profileDir, { recursive: true })
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          headless: false,
          viewport: { width: 1280, height: 900 },
          // Never send loopback traffic through a proxy (the test mock, and any local page).
          args: ['--proxy-bypass-list=<-loopback>'],
          ...launchOptions(executablePath)
        })
      } catch (e) {
        starting = null
        throw new Error(
          'Tidak bisa membuka browser untuk ChatGPT Web. Pasang Google Chrome dulu, lalu coba lagi. ' +
            `(${(e as Error).message})`
        )
      }
      const p = context.pages()[0] ?? (await context.newPage())
      page = p
      return p
    })()
  }
  return starting
}

async function composer(p: Page): Promise<ReturnType<Page['locator']>> {
  const byId = p.locator('#prompt-textarea').first()
  if (await byId.count()) return byId
  return p.locator('div[contenteditable="true"]').last()
}

async function isLoggedIn(p: Page): Promise<boolean> {
  try {
    const c = await composer(p)
    return await c.isVisible({ timeout: 5000 })
  } catch {
    return false
  }
}

export async function chatGptWebStatus(profileDir = defaultProfileDir(), executablePath?: string): Promise<{ loggedIn: boolean }> {
  const p = await ensurePage(profileDir, executablePath)
  if (!p.url().startsWith(CHATGPT_URL)) await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  return { loggedIn: await isLoggedIn(p) }
}

/** Opens the browser for the user to log in, and waits until the composer appears. */
export async function chatGptWebLogin(profileDir = defaultProfileDir(), executablePath?: string): Promise<{ loggedIn: boolean }> {
  const p = await ensurePage(profileDir, executablePath)
  await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  const started = Date.now()
  for (;;) {
    if (await isLoggedIn(p)) return { loggedIn: true }
    if (Date.now() - started > LOGIN_WAIT_MS) return { loggedIn: false }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

export interface ChatGptWebImage {
  bytes: Buffer
  mime: string
}

/** Writes reference bytes to temp files for the browser's file picker. Caller deletes them. */
export function writeRefFiles(refs: { bytes: Buffer; mime: string }[]): string[] {
  const dir = join(tmpdir(), `bang-story-chatgpt-refs-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return refs.map((r, i) => {
    const ext = r.mime.includes('png') ? 'png' : r.mime.includes('webp') ? 'webp' : 'jpg'
    const file = join(dir, `ref-${i}.${ext}`)
    appendFileSync(file, r.bytes)
    return file
  })
}

export function removeRefFiles(files: string[]): void {
  for (const f of files) {
    try {
      rmSync(f, { force: true })
    } catch {
      // A leftover temp file is harmless; the OS cleans /tmp.
    }
  }
  try {
    const dir = files[0] ? join(files[0], '..') : ''
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true })
  } catch {
    // Ignore.
  }
}

async function newChat(p: Page): Promise<void> {
  try {
    const btn = p.getByRole('link', { name: 'New chat' }).or(p.getByRole('button', { name: 'New chat' }))
    await btn.first().click({ timeout: 8000 })
  } catch {
    await p.keyboard.press('Control+Shift+o').catch(() => {})
  }
  await p.waitForTimeout(800)
}

async function downloadImage(p: Page, src: string): Promise<ChatGptWebImage> {
  const res = await p.request.get(src).catch(() => null)
  if (res && res.ok()) {
    const body = await res.body()
    return { bytes: Buffer.from(body), mime: res.headers()['content-type']?.split(';')[0] ?? 'image/png' }
  }
  // Same-context fetch as a fallback (signed URLs are usually public, so this rarely runs).
  const dataUrl = await p.evaluate(async (url) => {
    const r = await fetch(url)
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return { base64: btoa(bin), mime: r.headers.get('content-type') ?? 'image/png' }
  }, src)
  if (!dataUrl) throw new Error('Gambar dari ChatGPT tidak bisa diunduh.')
  return { bytes: Buffer.from(dataUrl.base64, 'base64'), mime: dataUrl.mime }
}

/**
 * Generates one image in a fresh chat. Throws a plain Indonesian message when the account is
 * not logged in, the composer cannot be found (UI changed), or no image appears in time.
 */
export async function chatGptWebImage(
  prompt: string,
  refFiles: string[],
  onTick: (status: string, elapsedMs: number) => void,
  profileDir = defaultProfileDir(),
  executablePath?: string
): Promise<ChatGptWebImage> {
  const run = queue.then(async () => {
    const p = await ensurePage(profileDir, executablePath)
    await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
    if (!(await isLoggedIn(p))) {
      throw new Error('Belum login ChatGPT. Buka Pengaturan › ChatGPT Web, login dulu, lalu coba lagi.')
    }
    await newChat(p)
    const c = await composer(p)
    await c.click({ timeout: 10000 })
    if (refFiles.length) {
      const input = p.locator('input[type="file"]').first()
      if ((await input.count()) === 0) throw new Error('Tombol lampiran ChatGPT tidak ketemu (tampilan berubah).')
      await input.setInputFiles(refFiles)
      await p.waitForTimeout(1500)
    }
    await c.fill(prompt).catch(async () => {
      await c.click()
      await p.keyboard.type(prompt)
    })
    const before = await p.locator('img[src*="oaiusercontent"]').count()
    const send = p.locator('button[data-testid="send-button"]').first()
    if (await send.count()) await send.click({ timeout: 10000 })
    else await p.keyboard.press('Enter')
    const started = Date.now()
    for (;;) {
      const count = await p.locator('img[src*="oaiusercontent"]').count()
      onTick('in_progress', Date.now() - started)
      if (count > before) {
        const src = await p.locator('img[src*="oaiusercontent"]').nth(count - 1).getAttribute('src')
        if (!src) throw new Error('Gambar dari ChatGPT tidak bisa diunduh.')
        return downloadImage(p, src)
      }
      if (Date.now() - started > IMAGE_TIMEOUT_MS) {
        throw new Error('ChatGPT web tidak membalas gambar dalam 10 menit. Coba lagi nanti.')
      }
      await p.waitForTimeout(5000)
    }
  })
  queue = run.catch(() => {})
  return run
}

export async function closeChatGptWeb(): Promise<void> {
  const c = context
  context = null
  page = null
  starting = null
  if (c) await c.close().catch(() => {})
}
