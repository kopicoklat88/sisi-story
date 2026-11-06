import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

/**
 * GPT Image through chatgpt.com in a real browser, spending the ChatGPT account's free image
 * quota instead of an API key. ChatGPT web has no public image API, so this drives the web UI
 * with Playwright: the user logs in once (the session persists in a profile folder), then each
 * image is a fresh chat with the prompt typed in, references attached, and the generated image
 * downloaded from the reply.
 *
 * Two ways to reach that browser. Preferred: attach to the user's own Chrome when it runs
 * with --remote-debugging-port=9222 (CDP). That Chrome is already logged in and already
 * trusted by bot checks, so there is no login and no verification wall; the app only opens
 * its own chatgpt.com tab there and never closes the user's browser. Fallback: launch a
 * fresh profile in the installed Chrome, hardened with --disable-blink-features=
 * AutomationControlled plus an init script that hides navigator.webdriver, so bot checks
 * usually pass on their own after a few seconds; the session then persists in the profile
 * folder and later generations skip login.
 *
 * This is deliberately the fragile provider: if OpenAI changes the composer, shows a bot check,
 * or the account is logged out, generation fails with a plain message and the user retries after
 * logging in again. Image only, one generation at a time, headed browser so the user can see
 * (and rescue) what is happening.
 */

const CHATGPT_URL = process.env.CHATGPT_WEB_URL ?? 'https://chatgpt.com/'
const LOGIN_WAIT_MS = 10 * 60 * 1000
const IMAGE_TIMEOUT_MS = 10 * 60 * 1000
/** Remote-debugging endpoint of the user's own Chrome. When reachable, the app drives that
 * Chrome (already logged in, already trusted by bot checks) instead of launching a fresh,
 * easily-flagged one. Set to an empty string to disable. */
const CDP_URL = process.env.CHATGPT_WEB_CDP_URL ?? 'http://127.0.0.1:9222'
/** Hides the automation flag so bot checks treat the fresh-profile browser more like a normal one. */
const STEALTH_INIT = `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });`

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
let cdpBrowser: Browser | null = null
let cdpContext: BrowserContext | null = null
/** True when the page lives in the user's own Chrome: never close it on cleanup. */
let attachedViaCdp = false
/** Generations run one at a time: the web UI has a single composer. */
let queue: Promise<unknown> = Promise.resolve()

/** Connects to the user's own Chrome when it runs with --remote-debugging-port=9222.
 * Returns null fast when no such Chrome is running. The connection is kept in module state
 * so status checks and later generations reuse it instead of opening a new one each time. */
async function cdpContextOrNull(): Promise<BrowserContext | null> {
  if (cdpContext) return cdpContext
  if (!CDP_URL) return null
  try {
    cdpBrowser = await chromium.connectOverCDP(CDP_URL, { timeout: 3000 })
    const contexts = cdpBrowser.contexts()
    // Prefer the context that already has tabs (the user's main window); the default
    // context of a CDP-attached browser is often empty.
    const ctx = contexts.find((c) => c.pages().length > 0) ?? contexts[0] ?? null
    if (!ctx) return null
    cdpContext = ctx
    return ctx
  } catch {
    return null
  }
}

async function ensurePage(profileDir: string, executablePath?: string): Promise<Page> {
  if (page && !page.isClosed()) return page
  if (!starting) {
    starting = (async () => {
      // First choice: the user's own Chrome (already logged in, already trusted by bot checks).
      const cdp = await cdpContextOrNull()
      if (cdp) {
        try {
          context = cdp
          attachedViaCdp = true
          const p = await context.newPage()
          page = p
          return p
        } catch {
          // The attached Chrome went away (e.g. it was restarted): drop the stale
          // connection and fall through to the fresh-profile launch below.
          cdpContext = null
          cdpBrowser = null
          attachedViaCdp = false
        }
      }
      // Fallback: a fresh profile in the user's installed Chrome, hardened against bot checks.
      mkdirSync(profileDir, { recursive: true })
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          headless: false,
          viewport: { width: 1280, height: 900 },
          // Never send loopback traffic through a proxy (the test mock, and any local page).
          args: ['--proxy-bypass-list=<-loopback>', '--disable-blink-features=AutomationControlled'],
          ...launchOptions(executablePath)
        })
      } catch (e) {
        starting = null
        throw new Error(
          'Tidak bisa membuka browser untuk ChatGPT Web. Pasang Google Chrome dulu, lalu coba lagi. ' +
            `(${(e as Error).message})`
        )
      }
      await context.addInitScript(STEALTH_INIT).catch(() => {})
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
  // In the user's own Chrome, look at the tabs they already have; never open a new tab just to check.
  if ((!page || page.isClosed()) && !starting) {
    const cdp = await cdpContextOrNull()
    if (cdp) {
      const tabs = cdp.pages().filter((t) => t.url().startsWith(CHATGPT_URL))
      for (const t of tabs) {
        if (await isLoggedIn(t)) return { loggedIn: true }
      }
      return { loggedIn: false }
    }
  }
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
  const wasCdp = attachedViaCdp
  context = null
  page = null
  starting = null
  attachedViaCdp = false
  cdpContext = null
  cdpBrowser = null
  if (wasCdp) {
    // The browser belongs to the user: only drop our connection, never close their Chrome.
    return
  }
  if (c) await c.close().catch(() => {})
}

/** Runs a command and resolves no matter the outcome (quit helpers are best-effort). */
function runQuiet(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, () => resolve())
  })
}

/** Launches a program detached, so the app never waits on the browser process. */
function launchDetached(file: string, args: string[]): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    if (await check()) return true
    if (Date.now() - started > timeoutMs) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

async function isChromeRunning(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('pgrep', ['-x', 'Google Chrome'], (err) => resolve(!err))
    })
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], (err, stdout) =>
        resolve(!err && stdout.includes('chrome.exe'))
      )
    })
  }
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'google-chrome'], (err) => {
      if (!err) return resolve(true)
      execFile('pgrep', ['-x', 'chrome'], (err2) => resolve(!err2))
    })
  })
}

async function quitChrome(): Promise<void> {
  if (process.platform === 'darwin') {
    await runQuiet('osascript', ['-e', 'tell application "Google Chrome" to quit'])
  } else if (process.platform === 'win32') {
    await runQuiet('taskkill', ['/IM', 'chrome.exe'])
  } else {
    await runQuiet('pkill', ['-f', 'google-chrome'])
  }
}

function findChromeWindows(): string | null {
  const candidates = [
    join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LocalAppData ?? '', 'Google/Chrome/Application/chrome.exe')
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

async function launchChromeWithDebugging(): Promise<void> {
  const args = ['--remote-debugging-port=9222', '--restore-last-session']
  if (process.platform === 'darwin') {
    launchDetached('open', ['-a', 'Google Chrome', '--args', ...args])
  } else if (process.platform === 'win32') {
    const exe = findChromeWindows()
    if (!exe) throw new Error('Google Chrome tidak ketemu di lokasi standar. Pasang Chrome dulu, lalu coba lagi.')
    launchDetached(exe, args)
  } else {
    launchDetached('google-chrome', args)
  }
}

async function waitForCdp(timeoutMs = 30000): Promise<boolean> {
  return waitFor(async () => {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version')
      return res.ok
    } catch {
      return false
    }
  }, timeoutMs)
}

/**
 * Restarts the user's Chrome with remote debugging, so the driver can attach to the session
 * that is already logged in. Tabs come back (--restore-last-session). The user does nothing
 * by hand: one click in Settings does the whole restart and waits until the debug port answers.
 */
export async function chatGptWebAttachChrome(): Promise<{ attached: boolean }> {
  await closeChatGptWeb()
  if (await isChromeRunning()) {
    await quitChrome()
    const gone = await waitFor(async () => !(await isChromeRunning()), 15000)
    if (!gone) throw new Error('Chrome tidak mau tertutup. Tutup Chrome secara manual, lalu coba lagi.')
  }
  await launchChromeWithDebugging()
  const up = await waitForCdp()
  if (!up) {
    throw new Error('Chrome sudah dibuka lagi, tapi port debugging-nya belum siap. Tunggu sebentar lalu coba lagi.')
  }
  return { attached: true }
}
