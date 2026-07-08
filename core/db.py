"""SQLite job queue with deterministic sharding.

The interesting bit is `next_pending(shard, nshards)`: multiple worker processes
can drain the SAME queue with zero locking and zero double-processing. Each job's
shard is `sha1(job_id) % nshards`, so worker N only ever picks jobs whose hash
falls in its shard. No `claim` column, no `SELECT ... FOR UPDATE`, no races.
"""
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone

from . import config


def _shard_of(job_id: str, nshards: int) -> int:
    """Deterministic shard for a job, by its text id (jobs.id = uuid4 hex)."""
    return int(hashlib.sha1(job_id.encode()).hexdigest(), 16) % nshards


_conn = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False, timeout=15)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA busy_timeout=15000")
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT,                       -- e.g. "image" | "video"
        payload TEXT,                    -- JSON job spec (prompt, asset urls, ...)
        status TEXT DEFAULT 'pending',   -- pending|processing|done|failed|cancelled
        batch_id TEXT,
        created_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        result TEXT,                     -- JSON result (paths / urls)
        error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_batch  ON jobs(batch_id);
    """)
    conn.commit()


def add_job(kind: str, payload: dict, batch_id: str | None = None) -> str:
    """Enqueue a job. Returns its id."""
    conn = _get_conn()
    jid = uuid.uuid4().hex[:8]
    conn.execute(
        "INSERT INTO jobs (id, kind, payload, status, batch_id, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (jid, kind, json.dumps(payload or {}), "pending", batch_id,
         datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    return jid


def get_job(job_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _row(row)


def next_pending(shard: int | None = None, nshards: int | None = None) -> dict | None:
    """Next pending job. With shard/nshards, only this worker's shard
    (sha1(id) % nshards == shard): two workers take disjoint jobs with no claim
    column and no locking."""
    conn = _get_conn()
    if shard is not None and nshards:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE status='pending' ORDER BY created_at"
        ).fetchall()
        for r in rows:
            if _shard_of(r["id"], nshards) == shard:
                return _row(r)
        return None
    row = conn.execute(
        "SELECT * FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1"
    ).fetchone()
    return _row(row)


def update_status(job_id: str, status: str, **kw):
    conn = _get_conn()
    sets, vals = ["status=?"], [status]
    if status == "processing":
        sets.append("started_at=?")
        vals.append(datetime.now(timezone.utc).isoformat())
    if status in ("done", "failed"):
        sets.append("finished_at=?")
        vals.append(datetime.now(timezone.utc).isoformat())
    for k, v in kw.items():
        sets.append(f"{k}=?")
        vals.append(v)
    vals.append(job_id)
    conn.execute(f"UPDATE jobs SET {','.join(sets)} WHERE id=?", vals)
    conn.commit()


def count_by_status(batch_id: str | None = None) -> dict:
    conn = _get_conn()
    where = "WHERE batch_id=?" if batch_id else ""
    params = (batch_id,) if batch_id else ()
    rows = conn.execute(
        f"SELECT status, COUNT(*) as cnt FROM jobs {where} GROUP BY status", params,
    ).fetchall()
    return {r["status"]: r["cnt"] for r in rows}


def cancel_pending(batch_id: str | None = None) -> int:
    conn = _get_conn()
    if batch_id:
        cur = conn.execute(
            "UPDATE jobs SET status='cancelled' WHERE batch_id=? AND status='pending'",
            (batch_id,),
        )
    else:
        cur = conn.execute("UPDATE jobs SET status='cancelled' WHERE status='pending'")
    conn.commit()
    return cur.rowcount


def recent_done(limit: int = 10) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM jobs WHERE status='done' ORDER BY finished_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [_row(r) for r in rows]


def _row(row) -> dict | None:
    if not row:
        return None
    d = dict(row)
    for k in ("payload", "result"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except (ValueError, TypeError):
                pass
    return d
