"""Self-healing worker loop over the sharded queue (see db.py).

Standout technique — POISON DETECTION + CLEAN SELF-HEAL:
When you drive a browser via a long-lived CDP/Playwright session, a single tab
crash "poisons" the process: every subsequent job fails with the same low-level
signature. Retrying in-process is useless. This worker detects those signatures,
returns the current job to `pending` (nothing is lost), and exits cleanly so a
process supervisor (systemd `Restart=always`) respawns it with a fresh browser
context. A storm-guard prevents a crash-loop: if poisoning recurs within 120s of
a restart, we DON'T exit again (the browser is durably broken) — we just fail the
one job and keep serving, so the queue isn't hammered.

Plug in your own work by passing a `handle_job(job: dict) -> dict | None` callable
to `run()` (or set the JOB_HANDLER import path via env). The default handler is a
no-op that marks jobs done — replace it.
"""
import importlib
import logging
import os
import random
import time
from pathlib import Path

from . import config, db
from .flowlock import instance_lock

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worker")

# Low-level signatures that indicate the browser/CDP session is unrecoverable.
_POISON = ("Sync API inside the asyncio loop", "Target crashed",
           "connect_over_cdp", "has been closed", "Browser closed",
           "Target page, context or browser has been closed")


def _default_handler(job: dict) -> dict | None:
    """Replace me. Return a JSON-serialisable result dict, or None."""
    log.info("default handler: no-op for job %s (%s)", job["id"], job.get("kind"))
    return {"note": "no-op default handler"}


def process_job(job: dict, handler):
    job_id = job["id"]
    log.info("Job %s (%s)", job_id, job.get("kind"))
    db.update_status(job_id, "processing")
    try:
        import json
        result = handler(job)
        db.update_status(job_id, "done", result=json.dumps(result or {}))
        log.info("Job %s: DONE", job_id)
    except Exception as e:  # noqa: BLE001
        emsg = str(e)
        log.error("Job %s failed: %s", job_id, e, exc_info=True)
        # SELF-HEAL: a poisoned browser session fails all following jobs the same
        # way. Return this job to the queue (don't lose it) and exit cleanly so the
        # supervisor respawns a fresh worker. Only on the known signatures below.
        # Storm-guard: if poisoning recurs <120s after a restart, the browser is
        # durably broken — don't exit again, just fail this job and stay alive.
        if any(p in emsg for p in _POISON):
            mark = f"/tmp/worker_poison_{os.getenv('WORKER_SHARD', 's')}.ts"
            recent = os.path.exists(mark) and (time.time() - os.path.getmtime(mark)) < 120
            if not recent:
                try:
                    Path(mark).write_text(str(time.time()))
                    db.update_status(job_id, "pending")  # requeue, don't lose it
                except Exception:  # noqa: BLE001
                    pass
                log.error("POISONED session — job %s back to pending, exiting for a "
                          "clean supervisor restart", job_id)
                os._exit(3)
            log.error("POISON recurred <120s — NOT restarting (storm-guard), failing job")
        db.update_status(job_id, "failed", error=emsg[:300])


def _resolve_handler(handler):
    if handler is not None:
        return handler
    path = os.getenv("JOB_HANDLER")  # e.g. "mypkg.mymod:handle_job"
    if path:
        mod, fn = path.split(":")
        return getattr(importlib.import_module(mod), fn)
    return _default_handler


def run(handler=None):
    handler = _resolve_handler(handler)
    # Single-instance guard per role/shard: a stray orphan can't drain the queue
    # in parallel with the healthy worker.
    shard_env = os.getenv("WORKER_SHARD", "solo")
    guard = instance_lock(f"worker_{shard_env}")
    if guard is None:
        log.error("Another worker for shard %s is already running — exiting.", shard_env)
        return

    # Shard pinning via env (WORKER_SHARD / WORKER_NSHARDS). Each worker drains
    # only its own shard of the queue (see db.next_pending).
    shard = os.getenv("WORKER_SHARD")
    nshards = os.getenv("WORKER_NSHARDS")
    shard = int(shard) if shard not in (None, "", "solo") else None
    nshards = int(nshards) if nshards not in (None, "") else None
    if shard is not None and nshards:
        log.info("Worker SHARD %d/%d — polling...", shard, nshards)
    else:
        log.info("Worker (solo) started, polling queue...")

    while True:
        job = db.next_pending(shard=shard, nshards=nshards)
        if job:
            process_job(job, handler)
            lo, hi = config.BETWEEN_JOBS_SEC
            delay = random.randint(lo, hi)
            log.info("Sleeping %ds before next job...", delay)
            time.sleep(delay)
        else:
            time.sleep(5)


if __name__ == "__main__":
    run()
