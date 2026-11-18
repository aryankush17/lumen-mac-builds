#!/usr/bin/env python3
"""
Agency Brain launcher for Lumen.

Lumen-owned glue. It does NOT modify the bundled Agency Brain app (the Next.js
project under ./agency_brain). It just runs it locally so Lumen can embed it:

  - Starts the Agency Brain Next.js production server on 127.0.0.1:3002 by
    invoking the installed Next binary directly with Node (no pnpm needed at
    run time), with cwd = agency_brain so it finds .env.local, .next and
    .agency-brain-data.
  - Health-checks http://127.0.0.1:3002/api/agency-brain/health until ready.

Lumen's "AI Chat" view embeds http://127.0.0.1:3002/chat in an iframe. Next
serves its own UI and /api on that one origin, so no proxy is required.

The Agency Brain must be installed and built once before first use:
    cd agency_brain && pnpm install && pnpm build
(see RUN_FROM_SCRATCH.md). This launcher only runs `next start`.

Port override: LUMEN_AB_PORT.
"""

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request

HOST = "127.0.0.1"
PORT = int(os.environ.get("LUMEN_AB_PORT", "3002"))

_lock = threading.RLock()
_proc = None
_ready = False


def _candidate_dirs():
    if getattr(sys, "frozen", False):
        return [getattr(sys, "_MEIPASS", None),
                os.path.dirname(os.path.abspath(sys.executable)),
                os.path.dirname(os.path.abspath(sys.argv[0]))]
    return [os.path.dirname(os.path.abspath(__file__))]


def app_dir():
    for c in _candidate_dirs():
        if c and os.path.isdir(os.path.join(c, "agency_brain")):
            return c
    return os.path.dirname(os.path.abspath(__file__))


def brain_dir():
    return os.path.join(app_dir(), "agency_brain")


def _find_node():
    for name in ("node", "node.exe", "nodejs"):
        p = shutil.which(name)
        if p:
            return p
    for g in ("/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node",
              r"C:\Program Files\nodejs\node.exe"):
        if os.path.isfile(g):
            return g
    return None


def _next_bin():
    return os.path.join(brain_dir(), "node_modules", "next", "dist", "bin", "next")


def _health_ok():
    try:
        url = "http://%s:%d/api/agency-brain/health" % (HOST, PORT)
        with urllib.request.urlopen(url, timeout=2.0) as r:
            return r.status == 200
    except Exception:
        return False


def is_built():
    return os.path.isdir(os.path.join(brain_dir(), ".next"))


def is_installed():
    return os.path.isfile(_next_bin())


def start():
    """Start the Next server if not already healthy. Returns True when ready."""
    global _proc, _ready
    if _ready and _health_ok():
        return True
    with _lock:
        if _ready and _health_ok():
            return True
        if _health_ok():
            _ready = True
            return True

        node = _find_node()
        if not node or not is_installed() or not is_built():
            return False

        env = dict(os.environ)
        env["PORT"] = str(PORT)
        env.setdefault("NODE_ENV", "production")
        log_path = os.path.join(brain_dir(), "lumen-agency-brain.log")
        try:
            logf = open(log_path, "ab", buffering=0)
        except Exception:
            logf = subprocess.DEVNULL

        cmd = [node, _next_bin(), "start", "-p", str(PORT)]
        kwargs = {"cwd": brain_dir(), "env": env, "stdout": logf, "stderr": logf}
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True

        try:
            _proc = subprocess.Popen(cmd, **kwargs)
        except Exception:
            return False

        for _ in range(80):            # up to ~40s for cold start
            if _health_ok():
                _ready = True
                return True
            if _proc.poll() is not None:
                return False
            time.sleep(0.5)
        return _health_ok()


def ensure():
    return start()


def prewarm():
    threading.Thread(target=start, daemon=True).start()


def status():
    return {
        "ready": _ready and _health_ok(),
        "port": PORT,
        "node_found": _find_node() is not None,
        "installed": is_installed(),
        "built": is_built(),
    }


if __name__ == "__main__":
    # standalone smoke test
    print("brain_dir:", brain_dir())
    print("installed:", is_installed(), "built:", is_built())
    print("starting...", "ok" if ensure() else "FAILED")
    print("status:", status())
