import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * The local bridge between the Bang Story app and its Chrome extension ("Bang Story — ChatGPT",
 * resources/chatgpt-extension). The extension runs inside the user's real browser as first-party
 * code, so it needs no profile path, no debug flag, and no CDP connection — it polls this server
 * for image jobs, performs them in a chatgpt.com tab, and posts the result back.
 *
 * The server binds loopback only and serves only this extension protocol. If the port is taken
 * (another copy of the app, or anything else), startExtensionServer returns false and the
 * ChatGPT Web provider falls back to its Playwright driver; nothing else in the app depends on
 * this server.
 */

export const CHATGPT_EXTENSION_PORT = 18097
const MAX_BODY_BYTES = 20 * 1024 * 1024
const HEARTBEAT_FRESH_MS = 60 * 1000
const JOB_TTL_MS = 30 * 60 * 1000

export interface ExtensionJobRef {
  dataUrl: string
  mime: string
}

export interface ExtensionJob {
  id: string
  prompt: string
  refs: ExtensionJobRef[]
  status: 'pending' | 'running' | 'done' | 'error'
  image?: string
  mime?: string
  error?: string
  createdAt: number
}

let server: Server | null = null
let started = false
const jobs = new Map<string, ExtensionJob>()
let heartbeat: { at: number; loggedIn: boolean } | null = null
let waiter: { res: ServerResponse; timer: NodeJS.Timeout } | null = null

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body terlalu besar.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function nextJob(): ExtensionJob | null {
  for (const job of jobs.values()) {
    if (job.status === 'pending') return job
  }
  return null
}

function answerWaiter(job: ExtensionJob | null): void {
  if (!waiter) return
  const w = waiter
  waiter = null
  clearTimeout(w.timer)
  if (job) sendJson(w.res, 200, { id: job.id, prompt: job.prompt, refs: job.refs })
  else {
    cors(w.res)
    w.res.writeHead(204)
    w.res.end()
  }
}

function pruneJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CHATGPT_EXTENSION_PORT}`)
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const connected = !!heartbeat && Date.now() - heartbeat.at < HEARTBEAT_FRESH_MS
    sendJson(res, 200, { connected, loggedIn: connected ? heartbeat!.loggedIn : false })
    return
  }
  if (req.method === 'POST' && url.pathname === '/status') {
    const body = JSON.parse(await readBody(req)) as { loggedIn?: boolean }
    heartbeat = { at: Date.now(), loggedIn: !!body.loggedIn }
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/jobs/next') {
    pruneJobs()
    const job = nextJob()
    if (job) {
      sendJson(res, 200, { id: job.id, prompt: job.prompt, refs: job.refs })
      return
    }
    // Long poll: hold the response until a job arrives or the wait runs out.
    const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 25), 1), 25) * 1000
    const timer = setTimeout(() => {
      if (waiter?.res === res) waiter = null
      cors(res)
      res.writeHead(204)
      res.end()
    }, waitMs)
    if (waiter) answerWaiter(null)
    waiter = { res, timer }
    req.on('close', () => {
      if (waiter?.res === res) {
        clearTimeout(timer)
        waiter = null
      }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/jobs') {
    const body = JSON.parse(await readBody(req)) as { prompt?: string; refs?: ExtensionJobRef[] }
    if (!body.prompt || typeof body.prompt !== 'string') {
      sendJson(res, 400, { error: 'prompt wajib diisi.' })
      return
    }
    pruneJobs()
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const job: ExtensionJob = {
      id,
      prompt: body.prompt,
      refs: Array.isArray(body.refs) ? body.refs : [],
      status: 'pending',
      createdAt: Date.now()
    }
    jobs.set(id, job)
    const waiting = nextJob()
    if (waiting) answerWaiter(waiting)
    sendJson(res, 201, { id })
    return
  }
  const jobMatch = /^\/jobs\/([^/]+)(?:\/(started|result))?$/.exec(url.pathname)
  if (jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) {
      sendJson(res, 404, { error: 'Job tidak ditemukan.' })
      return
    }
    if (req.method === 'GET' && !jobMatch[2]) {
      sendJson(res, 200, job)
      return
    }
    if (req.method === 'POST' && jobMatch[2] === 'started') {
      job.status = 'running'
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && jobMatch[2] === 'result') {
      const body = JSON.parse(await readBody(req)) as { image?: string; mime?: string; error?: string }
      if (body.error) {
        job.status = 'error'
        job.error = body.error
      } else if (body.image) {
        job.status = 'done'
        job.image = body.image
        job.mime = body.mime ?? 'image/png'
      } else {
        job.status = 'error'
        job.error = 'Ekstensi tidak mengembalikan gambar.'
      }
      sendJson(res, 200, { ok: true })
      return
    }
  }
  sendJson(res, 404, { error: 'Tidak dikenal.' })
}

/** Starts the loopback bridge. False when the port is already taken (the provider falls back). */
export function startExtensionServer(): boolean {
  if (started) return true
  try {
    server = createServer((req, res) => {
      void handle(req, res).catch((e) => {
        if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message })
        else res.end()
      })
    })
    server.on('error', () => {
      server = null
      started = false
    })
    server.listen(CHATGPT_EXTENSION_PORT, '127.0.0.1')
    started = true
    return true
  } catch {
    server = null
    return false
  }
}

export function stopExtensionServer(): void {
  if (server) server.close()
  server = null
  started = false
  if (waiter) {
    clearTimeout(waiter.timer)
    waiter = null
  }
}

/** Where the unpacked extension lives on disk (dev: repo resources; packaged: extraResources). */
export function extensionDir(): string {
  const packaged = join(process.resourcesPath, 'chatgpt-extension')
  if (existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'resources/chatgpt-extension')
}

async function fetchJson(path: string, init?: RequestInit, timeoutMs = 1500): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${CHATGPT_EXTENSION_PORT}${path}`, {
      ...init,
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Whether the extension is connected (heartbeat fresh) and its tab is logged in to ChatGPT. */
export async function extensionStatus(): Promise<{ connected: boolean; loggedIn: boolean }> {
  try {
    const r = (await fetchJson('/status')) as { connected: boolean; loggedIn: boolean }
    return { connected: !!r.connected, loggedIn: !!r.loggedIn }
  } catch {
    return { connected: false, loggedIn: false }
  }
}

export async function createExtensionJob(prompt: string, refs: ExtensionJobRef[]): Promise<string> {
  const r = (await fetchJson(
    '/jobs',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, refs }) },
    5000
  )) as { id: string }
  return r.id
}

export async function getExtensionJob(id: string): Promise<ExtensionJob | null> {
  try {
    return (await fetchJson(`/jobs/${id}`, undefined, 5000)) as ExtensionJob
  } catch {
    return null
  }
}
