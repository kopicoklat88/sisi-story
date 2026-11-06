// Runs inside chatgpt.com as first-party code: it IS the user's browser, so there is no bot
// check, no login wall, no automation flag, and no profile to guess — whichever Chrome profile
// the user actually uses, this script runs in it. It polls the Bang Story app on localhost for
// image jobs, performs them in this tab exactly like a user would, and sends the result back.
//
// The app server lives at http://127.0.0.1:18097. The content script is the poller (it stays
// alive as long as the tab is open), so no service-worker wake-up timing is involved.
const APP = 'http://127.0.0.1:18097'
const IMAGE_TIMEOUT_MS = 10 * 60 * 1000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function post(path, body) {
  const res = await fetch(APP + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error('app ' + res.status)
  return res.json().catch(() => ({}))
}

function composer() {
  const byId = document.querySelector('#prompt-textarea')
  if (byId) return byId
  const editable = [...document.querySelectorAll('div[contenteditable="true"]')]
  return editable.length ? editable[editable.length - 1] : null
}

function isLoggedIn() {
  const c = composer()
  return !!c && c.offsetParent !== null
}

async function heartbeat() {
  try {
    await post('/status', { loggedIn: isLoggedIn() })
  } catch {
    // App not running yet; the next poll cycle tries again.
  }
}

async function newChat() {
  const btn = [...document.querySelectorAll('a, button')].find(
    (el) => /new chat/i.test(el.textContent || '') && el.offsetParent !== null
  )
  if (btn) {
    btn.click()
    await sleep(800)
  }
  // No "New chat" button (e.g. the test page): keep generating in the current chat.
}

function dataUrlToFile(dataUrl, name) {
  const [head, b64] = dataUrl.split(',')
  const mime = /data:(.*?);/.exec(head)?.[1] ?? 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

async function runJob(job) {
  const started = Date.now()
  await post(`/jobs/${job.id}/started`, {}).catch(() => {})
  const c = composer()
  if (!c) throw new Error('Composer ChatGPT tidak ketemu (tampilan berubah).')
  await newChat()
  const comp = composer()
  if (!comp) throw new Error('Composer ChatGPT tidak ketemu setelah chat baru.')
  comp.click()
  if (job.refs && job.refs.length) {
    const input = document.querySelector('input[type="file"]')
    if (!input) throw new Error('Tombol lampiran ChatGPT tidak ketemu (tampilan berubah).')
    const dt = new DataTransfer()
    job.refs.forEach((r, i) =>
      dt.items.add(dataUrlToFile(r.dataUrl, `ref-${i}.${r.mime.includes('png') ? 'png' : 'jpg'}`))
    )
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(1500)
  }
  // Type the prompt the way a user does, so the React composer registers it.
  comp.focus()
  const typed = document.execCommand('insertText', false, job.prompt)
  if (!typed || !comp.textContent.includes(job.prompt.slice(0, 20))) {
    comp.textContent = job.prompt
    comp.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }
  const before = document.querySelectorAll('img[src*="oaiusercontent"]').length
  const send = document.querySelector('button[data-testid="send-button"]')
  if (send) send.click()
  else comp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (;;) {
    const imgs = document.querySelectorAll('img[src*="oaiusercontent"]')
    if (imgs.length > before) {
      const src = imgs[imgs.length - 1].getAttribute('src')
      if (!src) throw new Error('Gambar dari ChatGPT tidak bisa diunduh.')
      const r = await fetch(src)
      if (!r.ok) throw new Error('Gambar dari ChatGPT tidak bisa diunduh.')
      const blob = await r.blob()
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(new Error('Gambar tidak bisa dibaca.'))
        fr.readAsDataURL(blob)
      })
      return { image: b64, mime: blob.type || 'image/png' }
    }
    if (Date.now() - started > IMAGE_TIMEOUT_MS) {
      throw new Error('ChatGPT web tidak membalas gambar dalam 10 menit.')
    }
    await sleep(5000)
  }
}

async function loop() {
  for (;;) {
    try {
      const res = await fetch(APP + '/jobs/next?wait=25')
      if (res.status === 200) {
        const job = await res.json()
        try {
          const result = await runJob(job)
          await post(`/jobs/${job.id}/result`, result)
        } catch (e) {
          await post(`/jobs/${job.id}/result`, { error: (e && e.message) || 'Gagal membuat gambar.' }).catch(() => {})
        }
      }
    } catch {
      // App not running or unreachable: wait and try again.
      await sleep(5000)
    }
    await heartbeat()
  }
}

void heartbeat()
void loop()
