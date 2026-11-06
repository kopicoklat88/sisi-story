// Opens a chatgpt.com tab on install and on browser startup, so the content script can pick
// up image jobs from the Bang Story app. The content script does the actual work; this worker
// only makes sure a tab exists. The user can also open chatgpt.com by hand.
const CHATGPT_URL = 'https://chatgpt.com/'

async function ensureTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' })
    if (!tabs.length) await chrome.tabs.create({ url: CHATGPT_URL, active: false })
  } catch {
    // The user can open chatgpt.com by hand; the content script starts polling then.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureTab()
})
chrome.runtime.onStartup.addListener(() => {
  void ensureTab()
})
chrome.action.onClicked.addListener(() => {
  void ensureTab()
})
