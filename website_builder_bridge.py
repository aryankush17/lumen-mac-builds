#!/usr/bin/env python3
"""
Website Builder bridge for Lumen.

This is Lumen-owned glue. It does NOT modify the bundled website builder
(the Node "audit-platform" in ./website_builder). It just runs it locally and
makes it embeddable inside the Lumen console:

  1. Launches the website builder's own Node/Express backend
     (website_builder/server/dist/index.js) on 127.0.0.1:5001, exactly as the
     tool ships, with cwd = server/ so it finds its .env, data/ and templates/.
  2. Serves the tool's prebuilt client (website_builder/client/dist) on
     127.0.0.1:3001 and reverse-proxies /api/* to the Node backend, so the
     single-page app keeps working with its relative /api calls and absolute
     /assets paths, with no CORS and no edits to the tool.

Lumen's "Website Builder" view embeds http://127.0.0.1:3001/ in an iframe.

Ports can be overridden with LUMEN_WB_NODE_PORT / LUMEN_WB_BRIDGE_PORT.
"""

import json
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
NODE_PORT = int(os.environ.get("LUMEN_WB_NODE_PORT", "5001"))
BRIDGE_PORT = int(os.environ.get("LUMEN_WB_BRIDGE_PORT", "3001"))

_lock = threading.RLock()
_node_proc = None
_node_ready = False
_bridge_started = False
_httpd = None


# --------------------------------------------------------------------------- #
# paths
# --------------------------------------------------------------------------- #
def _candidate_dirs():
    if getattr(sys, "frozen", False):
        return [
            getattr(sys, "_MEIPASS", None),
            os.path.dirname(os.path.abspath(sys.executable)),
            os.path.dirname(os.path.abspath(sys.argv[0])),
        ]
    return [os.path.dirname(os.path.abspath(__file__))]


def app_dir():
    for c in _candidate_dirs():
        if c and os.path.isdir(os.path.join(c, "website_builder")):
            return c
    return os.path.dirname(os.path.abspath(__file__))


def wb_root():
    return os.path.join(app_dir(), "website_builder")


def server_dir():
    return os.path.join(wb_root(), "server")


def client_dist():
    return os.path.join(wb_root(), "client", "dist")


# --------------------------------------------------------------------------- #
# node backend
# --------------------------------------------------------------------------- #
def _find_node():
    # 1) A Node runtime bundled next to the app (website_builder/node/) wins, so
    #    an installed build is fully self-contained and works even when the user
    #    has no system Node. build.bat stages this; installer.iss ships it.
    node_dir = os.path.join(wb_root(), "node")
    for b in (os.path.join(node_dir, "node.exe"),
              os.path.join(node_dir, "bin", "node"),
              os.path.join(node_dir, "node")):
        if os.path.isfile(b):
            return b
    # 2) System Node on PATH.
    for name in ("node", "node.exe", "nodejs"):
        p = shutil.which(name)
        if p:
            return p
    # 3) Common explicit install locations as a last fallback.
    guesses = [
        "/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node",
        os.path.expanduser("~/.nvm/current/bin/node"),
        r"C:\Program Files\nodejs\node.exe",
    ]
    for g in guesses:
        if os.path.isfile(g):
            return g
    return None


def _health_ok():
    try:
        url = "http://%s:%d/api/health" % (HOST, NODE_PORT)
        with urllib.request.urlopen(url, timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def start_node():
    """Start the Node backend if not already healthy. Returns True when ready."""
    global _node_proc, _node_ready
    if _node_ready and _health_ok():
        return True
    with _lock:
        if _node_ready and _health_ok():
            return True
        if _health_ok():                       # something already listening
            _node_ready = True
            return True

        node = _find_node()
        entry = os.path.join(server_dir(), "dist", "index.js")
        if not node or not os.path.isfile(entry):
            return False

        env = dict(os.environ)
        runtime = os.path.expanduser("~/Library/Application Support/Lumen/website-builder")
        os.makedirs(runtime, exist_ok=True)
        env["LUMEN_STUDIO_DATA_DIR"] = runtime
        env["PORT"] = str(NODE_PORT)           # dotenv won't override an existing env var
        log_path = os.path.join(runtime, "lumen-node.log")
        try:
            logf = open(log_path, "ab", buffering=0)
        except Exception:
            logf = subprocess.DEVNULL

        kwargs = {"cwd": server_dir(), "env": env, "stdout": logf, "stderr": logf}
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000   # CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True

        try:
            _node_proc = subprocess.Popen([node, entry], **kwargs)
        except Exception:
            return False

        for _ in range(80):                    # up to ~40s for cold start
            if _health_ok():
                _node_ready = True
                return True
            if _node_proc.poll() is not None:  # process died
                return False
            time.sleep(0.5)
        return _health_ok()


# --------------------------------------------------------------------------- #
# bridge http server: static client + /api proxy
# --------------------------------------------------------------------------- #
_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
        "content-length"}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # -- /api/* -> node backend -------------------------------------------- #
    def _proxy(self):
        start_node()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        url = "http://%s:%d%s" % (HOST, NODE_PORT, self.path)
        req = urllib.request.Request(url, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() in ("host", "content-length", "connection", "accept-encoding"):
                continue
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=185) as resp:
                data = resp.read()
                self._respond(resp.status, dict(resp.headers), data)
        except urllib.error.HTTPError as e:           # backend returned 4xx/5xx
            data = e.read()
            self._respond(e.code, dict(e.headers), data)
        except Exception:
            self._json(502, {"error": "Website builder backend is not reachable."})

    def _respond(self, status, headers, data):
        self.send_response(status)
        sent_ct = False
        for k, v in headers.items():
            if k.lower() in _HOP:
                continue
            if k.lower() == "content-type":
                sent_ct = True
            self.send_header(k, v)
        if not sent_ct:
            self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # -- static client (SPA) ----------------------------------------------- #
    def _static(self):
        dist = os.path.normpath(client_dist())
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.normpath(os.path.join(dist, rel))
        if not (full == dist or full.startswith(dist + os.sep)):
            self.send_error(403); return
        if not os.path.isfile(full):
            # extensionless path = client-side route -> serve the SPA shell
            if os.path.splitext(rel)[1]:
                self.send_error(404); return
            full = os.path.join(dist, "index.html")
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404); return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api"):
            self._proxy()
        else:
            self._static()

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if self.path.startswith("/api"):
            self._proxy()
        else:
            self.send_error(404)

    def do_PUT(self):
        self.do_POST()

    def do_DELETE(self):
        self.do_POST()

    def do_PATCH(self):
        self.do_POST()


def _bridge_alive():
    """True if something is actually accepting connections on the bridge port."""
    try:
        with socket.create_connection((HOST, BRIDGE_PORT), timeout=0.8):
            return True
    except Exception:
        return False


def start_bridge():
    """Start the static+proxy server (idempotent, self-healing). Returns True on success.

    The port may have been owned by another Lumen process (e.g. an older
    instance on a different Flask port). If that process exits, the bridge
    dies with it - so never trust the started flag alone: verify the port is
    live and rebind when it is not.
    """
    global _bridge_started, _httpd
    with _lock:
        if _bridge_started and _httpd is not None:
            return True
        if _bridge_started and _bridge_alive():        # another process serves it
            return True
        _bridge_started = False                        # stale flag - rebind below
        if not os.path.isdir(client_dist()):
            return False
        try:
            _httpd = ThreadingHTTPServer((HOST, BRIDGE_PORT), _Handler)
        except OSError:
            # already bound by a live process right now -> usable
            _bridge_started = _bridge_alive()
            return _bridge_started
        _httpd.daemon_threads = True
        threading.Thread(target=_httpd.serve_forever, daemon=True).start()
        _bridge_started = True
        return True


def ensure():
    """Bring up bridge + node. Returns True only when both are ready."""
    if not start_bridge():
        return False
    return start_node()


def prewarm():
    """Fire-and-forget background boot so the first click is instant."""
    threading.Thread(target=ensure, daemon=True).start()


def status():
    return {
        "node": _node_ready and _health_ok(),
        "bridge": _bridge_started,
        "node_port": NODE_PORT,
        "bridge_port": BRIDGE_PORT,
        "node_found": _find_node() is not None,
        "client_dist": os.path.isdir(client_dist()),
    }
