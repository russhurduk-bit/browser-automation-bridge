/* [bridge-bg] Background service worker — Browser Automation Bridge */

const VERSION = '1.0.0';

/* Default bridge endpoint. Override the base URL and (optionally) the auth token
 * from chrome.storage.local:
 *   chrome.storage.local.set({ bridgeUrl: 'wss://localhost:8000/ws', bridgeToken: '<token>' })
 * No token is hardcoded. If a token is present it is appended as ?token=... */
const DEFAULT_WS_URL = 'wss://localhost:8000/ws';

/* URL pattern of the target web app tab that jobs are dispatched to.
 * Keep this in sync with the content_scripts match in manifest.json. */
const TARGET_URL_PATTERN = 'https://target-app.example/*';

let ws = null;
let wsAlive = false;
let currentJob = null;

/* ---- WebSocket ---- */

async function resolveWsUrl() {
  const { bridgeUrl, bridgeToken } = await chrome.storage.local.get(['bridgeUrl', 'bridgeToken']);
  const base = bridgeUrl || DEFAULT_WS_URL;
  return bridgeToken ? `${base}?token=${encodeURIComponent(bridgeToken)}` : base;
}

async function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = await resolveWsUrl();
  console.log('[bridge-bg] Connecting…');
  ws = new WebSocket(url);

  ws.onopen = () => {
    wsAlive = true;
    console.log('[bridge-bg] WS open');
    ws.send(JSON.stringify({ type: 'hello', version: VERSION }));
    broadcastState();
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'hello') { console.log('[bridge-bg] ← bridge: hello'); return; }
    if (msg.type === 'job') { handleJob(msg); return; }
    console.log('[bridge-bg] ← bridge:', msg.type);
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    wsAlive = false; ws = null;
    console.log('[bridge-bg] WS closed, reconnect 5s');
    broadcastState();
    setTimeout(connectWS, 5000);
  };
}

chrome.alarms.create('ws-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ws-keepalive' && (!ws || ws.readyState !== WebSocket.OPEN)) connectWS();
});

/* ---- Job dispatch ---- */

async function handleJob(job) {
  console.log(`[bridge-bg] Job: ${job.step} #${job.job_id} slug=${job.slug}`);
  currentJob = job;
  broadcastState();

  const tabs = await chrome.tabs.query({ url: TARGET_URL_PATTERN });
  if (!tabs.length) {
    reportErrorHTTP(job, 'No target app tab open');
    currentJob = null;
    broadcastState();
    return;
  }

  try {
    // Forward FULL job payload to content script
    chrome.tabs.sendMessage(tabs[0].id, { type: 'EXECUTE_JOB', job });
  } catch (e) {
    reportErrorHTTP(job, 'Content script unreachable: ' + e.message);
    currentJob = null;
    broadcastState();
  }
}

/* ---- Debugger click (CDP Input.dispatchMouseEvent) ---- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DEBUGGER_CLICK') {
    const tabId = sender.tab.id;
    (async () => {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
          { type: 'mousePressed', x: msg.x, y: msg.y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 30 + Math.random() * 60));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: msg.x, y: msg.y, button: 'left', clickCount: 1 });
        await chrome.debugger.detach({ tabId });
        sendResponse({ ok: true });
      } catch (e) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // UPLOAD_FILE: save blob to disk via downloads API, then use CDP file chooser interception
  if (msg.type === 'UPLOAD_FILE') {
    const tabId = sender.tab.id;
    (async () => {
      try {
        // 1. Save blob to temp file via downloads API
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download({
            url: msg.blobUrl, // blob:// URL from content script
            filename: msg.filename,
            conflictAction: 'overwrite',
            saveAs: false
          }, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          });
        });

        // Wait for download to complete
        const filePath = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('download timeout')), 15000);
          const check = () => {
            chrome.downloads.search({ id: downloadId }, (items) => {
              if (!items || !items.length) return;
              if (items[0].state === 'complete') {
                clearTimeout(timeout);
                resolve(items[0].filename); // absolute path on disk
              } else if (items[0].state === 'interrupted') {
                clearTimeout(timeout);
                reject(new Error('download interrupted'));
              } else {
                setTimeout(check, 200);
              }
            });
          };
          check();
        });

        console.log(`[bridge-bg] File saved: ${filePath}`);

        // 2. Attach debugger, intercept file chooser, click upload button, set file
        await chrome.debugger.attach({ tabId }, '1.3');
        await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true });

        // Click the upload button
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
          { type: 'mousePressed', x: msg.clickX, y: msg.clickY, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: msg.clickX, y: msg.clickY, button: 'left', clickCount: 1 });

        // Wait for file chooser event
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(listener);
            reject(new Error('file chooser not opened'));
          }, 10000);

          const listener = (source, method, params) => {
            if (source.tabId === tabId && method === 'Page.fileChooserOpened') {
              clearTimeout(timeout);
              chrome.debugger.onEvent.removeListener(listener);
              chrome.debugger.sendCommand({ tabId }, 'Page.handleFileChooser', {
                action: 'accept',
                files: [filePath]
              }).then(() => resolve({ ok: true, path: filePath }))
                .catch(e => reject(e));
            }
          };
          chrome.debugger.onEvent.addListener(listener);
        });

        await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false });
        await chrome.debugger.detach({ tabId });

        // Clean up temp file
        chrome.downloads.removeFile(downloadId, () => {});

        sendResponse(result);
      } catch (e) {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
          await chrome.debugger.detach({ tabId });
        } catch (_) {}
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'SEND_KEY') {
    const tabId = sender.tab.id;
    const keyMap = { 'Escape': {code:'Escape',vk:27}, 'Enter': {code:'Enter',vk:13} };
    const ki = keyMap[msg.key] || {code:msg.key, vk:0};
    (async () => {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        const mods = (msg.ctrl ? 8 : 0); // 8 = ctrl modifier
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent',
          { type: 'keyDown', key: msg.key, code: ki.code, windowsVirtualKeyCode: ki.vk, modifiers: mods });
        await new Promise(r => setTimeout(r, 50));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent',
          { type: 'keyUp', key: msg.key, code: ki.code, windowsVirtualKeyCode: ki.vk, modifiers: mods });
        await chrome.debugger.detach({ tabId });
        sendResponse({ ok: true });
      } catch (e) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'JOB_DONE') {
    console.log(`[bridge-bg] Job #${msg.job_id} done`);
    currentJob = null;
    broadcastState();
  }

  if (msg.type === 'JOB_FAILED') {
    console.log(`[bridge-bg] Job #${msg.job_id} failed: ${msg.error}`);
    currentJob = null;
    broadcastState();
  }

  if (msg.type === 'GET_STATE') {
    sendResponse({ wsAlive, currentJob: currentJob ? { job_id: currentJob.job_id, step: currentJob.step, slug: currentJob.slug } : null, version: VERSION });
    return false;
  }
});

/* ---- Helpers ---- */

async function reportErrorHTTP(job, error) {
  if (!job.error_url) return;
  try {
    await fetch(job.error_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error })
    });
  } catch (e) {
    console.error('[bridge-bg] reportError HTTP failed:', e);
  }
}

function broadcastState() {
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE', wsAlive,
    currentJob: currentJob ? { job_id: currentJob.job_id, step: currentJob.step, slug: currentJob.slug } : null,
    version: VERSION
  }).catch(() => {});
}

connectWS();
console.log(`[bridge-bg] v${VERSION} started`);
