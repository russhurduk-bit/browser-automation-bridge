"""Cross-process coordination for shared browser accounts via advisory flock.

PROBLEM: Several worker processes may drive automation against the SAME small
pool of browser sessions (each reachable on its own CDP port, e.g. 9555/9556).
Two concurrent submits against one session corrupt its shared UI state (upload
races) and look like parallel activity to anti-fraud. Requirement: at most one
submit at a time per session, across ALL processes.

SOLUTION: an advisory `flock` keyed by the CDP port. The lock file path is shared
by every process (/run/lock/session_cdp_<port>.lock), so `account_lock` serialises
submits regardless of which codebase or PID holds it. The lock is released on
`with`-exit — or automatically when the process dies (the kernel drops the flock
when the fd closes).
"""
import fcntl
import logging
import os
import re
import time

log = logging.getLogger("flowlock")
LOCK_DIR = "/run/lock"


def _port(cdp_url: str) -> str:
    m = re.search(r":(\d+)", cdp_url or "")
    return m.group(1) if m else "default"


class account_lock:
    """Context manager: exclusive lock on one browser session (by CDP port).

    Blocks until released by another process (poll). After `timeout` it logs and
    PROCEEDS without the lock (degrade rather than hang forever). Auto-released on
    `with`-exit and on process death (flock fd).
    """
    def __init__(self, cdp_url: str, timeout: int = 1500, poll: float = 3.0):
        self.port = _port(cdp_url)
        self.timeout = timeout
        self.poll = poll
        self.path = os.path.join(LOCK_DIR, f"session_cdp_{self.port}.lock")
        self.fd = None
        self.locked = False

    def __enter__(self):
        try:
            os.makedirs(LOCK_DIR, exist_ok=True)
            self.fd = open(self.path, "w")
        except Exception as e:  # noqa: BLE001
            log.warning("account_lock open failed (%s) — proceeding without lock", e)
            return self
        start = time.monotonic()
        waited = False
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.locked = True
                try:
                    self.fd.seek(0); self.fd.truncate()
                    self.fd.write(f"{os.getpid()} cdp:{self.port}\n"); self.fd.flush()
                except Exception:  # noqa: BLE001
                    pass
                if waited:
                    log.info("acquired account lock cdp:%s after wait", self.port)
                return self
            except BlockingIOError:
                waited = True
                if time.monotonic() - start > self.timeout:
                    log.warning("account lock cdp:%s busy >%ds — PROCEEDING without lock",
                                self.port, self.timeout)
                    return self
                time.sleep(self.poll)

    def __exit__(self, *exc):
        try:
            if self.fd:
                if self.locked:
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
                self.fd.close()
        except Exception:  # noqa: BLE001
            pass
        return False


def instance_lock(name: str):
    """Single-instance guard. Returns an fd (keep the reference alive!) if the lock
    was taken, else None — meaning another instance is running and you should exit."""
    try:
        os.makedirs(LOCK_DIR, exist_ok=True)
        fd = open(os.path.join(LOCK_DIR, f"{name}.lock"), "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd.write(f"{os.getpid()}\n"); fd.flush()
        return fd
    except BlockingIOError:
        return None
    except Exception as e:  # noqa: BLE001
        log.warning("instance_lock(%s) error (%s) — skipping guard", name, e)
        return "skip"
