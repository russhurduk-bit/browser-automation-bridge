"""Minimal configuration for the orchestration primitives.

Everything is overridable via environment variables so the same code runs in a
demo, a test, or production without edits.
"""
import os
from pathlib import Path

# SQLite queue location.
DB_PATH = Path(os.getenv("QUEUE_DB", str(Path(__file__).resolve().parent / "queue.db")))

# Random sleep window (seconds) inserted between jobs to space out activity.
_lo = int(os.getenv("BETWEEN_JOBS_MIN", "30"))
_hi = int(os.getenv("BETWEEN_JOBS_MAX", "90"))
BETWEEN_JOBS_SEC = (_lo, _hi)
