# Browser Automation Bridge

A production-style **browser-automation stack** that drives a web app the way a
human would — with *trusted* OS-level input events — and orchestrates jobs
across multiple workers reliably.

It has three parts:

| Part | What it is | Highlight |
|------|-----------|-----------|
| `extension/` | A Manifest V3 Chrome extension | Drives the page via the **Chrome DevTools Protocol** (`chrome.debugger`) for *trusted* mouse/keyboard events and native-dialog-free file uploads |
| `server/` | A ~120-line FastAPI + WebSocket **bridge** | Streams jobs to the extension and collects results/errors over HTTP callbacks |
| `core/` | Reusable **orchestration primitives** | A sha1-sharded SQLite queue, a self-healing worker loop, and cross-process flock coordination |

> This is a sanitized reference/portfolio build. It targets a **generic web app**
> (placeholder origin `target-app.example`) and contains **no secrets and no
> credentials**. Adapt the config to your own target and bridge.

---

## Why it's interesting

Most "browser automation" uses synthetic DOM events (`element.click()`,
dispatching `MouseEvent`). Modern web apps ignore or distrust those:
`event.isTrusted === false`. This project instead uses the **same input channel a
real user has** — the Chrome DevTools Protocol — so the app cannot tell the
difference.

### Standout techniques (in `extension/`)

1. **Trusted input via CDP.** `background.js` attaches `chrome.debugger` to the
   tab and issues `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. These
   produce `isTrusted: true` events with realistic press→release timing and a few
   pixels of positional jitter. See `DEBUGGER_CLICK` and `SEND_KEY`.

2. **File upload with no native file dialog.** The classic blocker for headless-ish
   automation is the OS file picker. Here (`UPLOAD_FILE` handler):
   - the content script hands the background a `blob:` URL,
   - the background saves it to disk with `chrome.downloads.download`,
   - it enables `Page.setInterceptFileChooserDialog`, clicks the upload control,
     waits for the `Page.fileChooserOpened` event, and answers with
     `Page.handleFileChooser({ action: 'accept', files: [path] })`.

   The dialog never appears; the file is attached programmatically yet through the
   app's real upload path.

3. **Human-like typing.** `typePrompt()` types a short "head" burst via
   `beforeinput/insertText`, pauses for several seconds, then inserts the rest as a
   single `insertFromPaste` — mimicking type-a-bit-then-paste behaviour instead of
   an instantaneous full-string set.

4. **Resilient find-by-visible-text.** Rather than brittle CSS selectors,
   `findByText` / `findVisible` locate controls by their rendered text and
   visibility (`offsetParent`, viewport position). UI refactors that keep labels
   keep working. All target-specific labels live in one `CFG` block at the top of
   `content.js`.

5. **Robust completion detection.** Generation results are detected by *multiple*
   independent signals (URL transition, new media element count, new media `src`
   not present in a pre-submit baseline) with long polling timeouts.

### Reusable orchestration primitives (in `core/`)

- **`db.py` — sha1-sharded queue.** `next_pending(shard, nshards)` lets N workers
  drain one SQLite queue with **no locking and no double-processing**: a job's
  owner is `sha1(job_id) % nshards`. No claim column, no `SELECT ... FOR UPDATE`.

- **`worker.py` — self-healing worker.** A crashed browser tab "poisons" a
  long-lived CDP session so every later job fails identically. The worker detects
  those signatures, **requeues the current job** (nothing lost) and exits cleanly
  so a supervisor (systemd `Restart=always`) respawns a fresh context. A
  **storm-guard** prevents crash-loops (if poisoning recurs within 120s it stops
  exiting and just fails the one job). Plug in your work via a `handle_job`
  callable or the `JOB_HANDLER` env var.

- **`flowlock.py` — cross-process flock.** `account_lock(cdp_url)` serialises
  submits against a shared browser session keyed by its CDP port, across every
  process/codebase; `instance_lock(name)` is a single-instance guard. Locks free
  themselves on process death (kernel drops the flock fd).

---

## Architecture

```
 producer ──POST /job/submit──▶  Bridge (FastAPI)  ──WS "job"──▶  Extension (MV3)
                                      ▲                                │
                                      │                                │ CDP: trusted
   POST /result/{id}  (multipart) ◀───┤                                │ clicks, typing,
   POST /error/{id}   (json)      ◀───┘                                ▼ file upload
                                                              Target web app tab

   core/  ── optional worker-side: sharded queue + self-healing loop + flock
```

The extension keeps a resilient WebSocket to the bridge (auto-reconnect, keepalive
alarm, ping/pong). Job payloads carry callback URLs; the extension POSTs the
finished artifact back to `result_*_url` or reports failure to `error_url`.

---

## Setup

### 1. Run the bridge

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# optional shared secret:
export BRIDGE_TOKEN=change-me
uvicorn bridge:app --host 0.0.0.0 --port 8000
```

Check it: `curl localhost:8000/health` → `{"ok": true, ...}`.

### 2. Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Point it at your bridge and (optionally) set the token from the extension's
   service-worker console — no token is hardcoded:

   ```js
   chrome.storage.local.set({
     bridgeUrl: 'wss://localhost:8000/ws',   // or ws:// for local http
     bridgeToken: 'change-me'                // omit if BRIDGE_TOKEN unset
   });
   ```

4. Edit `manifest.json` (`host_permissions` + `content_scripts.matches`) and the
   `CFG` block / `TARGET_URL_PATTERN` to match the web app you are automating.
5. Open the target app in a tab. The popup shows the bridge connection status.

### 3. Submit a job

```bash
curl -X POST localhost:8000/job/submit \
  -H 'Content-Type: application/json' \
  -d '{"step":"image","prompt":"a red bicycle","cover_url":"https://.../ref.png"}'
```

The bridge pushes it to the connected extension, which performs the flow in the
browser and POSTs the result back. Poll `GET /job/{id}` for status.

### 4. (Optional) worker-side orchestration

```python
from core import db, worker

def handle_job(job):
    # do your work; return a JSON-serialisable result
    return {"ok": True}

db.add_job("image", {"prompt": "hello"})
worker.run(handle_job)          # sharded via WORKER_SHARD / WORKER_NSHARDS env
```

Run two shards under a supervisor:

```
WORKER_SHARD=0 WORKER_NSHARDS=2 python -m core.worker
WORKER_SHARD=1 WORKER_NSHARDS=2 python -m core.worker
```

---

## Layout

```
browser-automation-bridge/
├── extension/          # MV3 Chrome extension (the star)
│   ├── manifest.json
│   ├── background.js   # WS client + CDP click/upload/key handlers
│   ├── content.js      # in-page flow: find-by-text, typing, upload, result wait
│   ├── popup.html / popup.js
│   └── icon16/48/128.png
├── server/
│   ├── bridge.py       # FastAPI + WebSocket hub
│   └── requirements.txt
├── core/               # reusable primitives (framework-agnostic)
│   ├── db.py           # sha1-sharded SQLite queue
│   ├── worker.py       # self-healing worker loop
│   ├── flowlock.py     # flock advisory locks
│   └── config.py
├── .gitignore
└── README.md
```

## Notes & ethics

Automate only applications you own or are authorised to automate, and respect the
target's Terms of Service and rate limits. The CDP/debugger permission is
powerful — treat the extension as privileged software and keep the bridge behind
authentication.
```
