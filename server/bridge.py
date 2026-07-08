"""Bridge server — a minimal WebSocket + HTTP hub between a job producer and the
browser-automation Chrome extension.

Flow:
  1. The extension connects to  ws://<host>/ws  (optionally with ?token=...).
  2. A producer POSTs a job to   /job/submit .
  3. The bridge pushes the job over the WS to a connected extension.
  4. The extension does the work in the browser and POSTs the artifact back to
     the per-job callback URL (/result/{job_id}) or reports failure (/error/{job_id}).

This is a self-contained reference stub — no external services, no secrets.
Run:  uvicorn bridge:app --host 0.0.0.0 --port 8000
"""
import asyncio
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Request, HTTPException

# Optional shared secret. Set BRIDGE_TOKEN in the environment to require it; the
# extension supplies it via chrome.storage.local -> ?token=... on the WS URL.
BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN")
RESULTS_DIR = Path(os.getenv("BRIDGE_RESULTS", "./results")).resolve()
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Browser Automation Bridge")

clients: set[WebSocket] = set()   # connected extensions
jobs: dict[str, dict] = {}        # job_id -> {status, error, result_path, ...}


@app.get("/health")
async def health():
    return {"ok": True, "extensions": len(clients), "jobs": len(jobs)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if BRIDGE_TOKEN and ws.query_params.get("token") != BRIDGE_TOKEN:
        await ws.close(code=4401)
        return
    await ws.accept()
    clients.add(ws)
    await ws.send_json({"type": "hello", "role": "bridge"})

    async def keepalive():
        while True:
            await asyncio.sleep(20)
            await ws.send_json({"type": "ping"})

    ka = asyncio.create_task(keepalive())
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "hello":
                print(f"[bridge] extension connected, version={msg.get('version')}")
            elif mtype == "pong":
                pass  # heartbeat ack
            else:
                print(f"[bridge] <- extension: {mtype}")
    except WebSocketDisconnect:
        pass
    finally:
        ka.cancel()
        clients.discard(ws)


@app.post("/job/submit")
async def submit_job(req: Request):
    """Accept a job spec and dispatch it to a connected extension.

    Body (JSON): {"step": "image"|"video", "prompt": "...", "slug": "...",
                  "cover_url": "...", "startframe_url": "..."}
    """
    if not clients:
        raise HTTPException(503, "no extension connected")
    spec = await req.json()
    job_id = uuid.uuid4().hex[:8]
    base = str(req.base_url).rstrip("/")
    job = {
        "type": "job",
        "job_id": job_id,
        "step": spec.get("step", "image"),
        "slug": spec.get("slug", ""),
        "prompt": spec.get("prompt", ""),
        "cover_url": spec.get("cover_url"),
        "startframe_url": spec.get("startframe_url"),
        # callbacks the extension posts back to
        "result_image_url": f"{base}/result/{job_id}",
        "result_video_url": f"{base}/result/{job_id}",
        "error_url": f"{base}/error/{job_id}",
    }
    jobs[job_id] = {"status": "dispatched", "spec": spec}
    await next(iter(clients)).send_json(job)   # send to first available extension
    return {"job_id": job_id, "status": "dispatched"}


@app.post("/result/{job_id}")
async def post_result(job_id: str, file: UploadFile = File(...)):
    dest = RESULTS_DIR / f"{job_id}_{file.filename}"
    dest.write_bytes(await file.read())
    jobs.setdefault(job_id, {})
    jobs[job_id].update(status="done", result_path=str(dest))
    print(f"[bridge] job {job_id} done -> {dest}")
    return {"ok": True, "job_id": job_id, "path": str(dest)}


@app.post("/error/{job_id}")
async def post_error(job_id: str, req: Request):
    body = await req.json()
    jobs.setdefault(job_id, {})
    jobs[job_id].update(status="failed", error=body.get("error", "unknown"))
    print(f"[bridge] job {job_id} FAILED: {jobs[job_id]['error']}")
    return {"ok": True}


@app.get("/job/{job_id}")
async def job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "unknown job")
    return {"job_id": job_id, **jobs[job_id]}
