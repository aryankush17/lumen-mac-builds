#!/usr/bin/env python3
"""
Lead Engine - one local app: collect businesses through the official Google
Places API, find their published contact email, and send a compliant cold
campaign. Runs entirely on this computer; nothing leaves the machine except
(a) the licensed calls you make to Google's own Places API with your own key,
and (b) the emails you choose to send. Settings and credentials are stored only
in config.json on this machine, with secrets encrypted at rest.

Compliance note: this build collects business data only through Google's
licensed Places API (no scraping, no Terms-of-Service circumvention), never
guesses or dictionary-generates email addresses, sends only to a business's own
published address, always includes a mailing address and a working unsubscribe,
and automatically honours "stop"/"unsubscribe" replies. Read LEGAL_AND_USE.txt
before sending. You are the sender and are responsible for using it lawfully in
the markets you choose.

Run (development):
    pip install flask requests cryptography qrcode
    python app.py            # opens http://127.0.0.1:5000

Ship to a student (confidential, single file, no readable source):
    pip install nuitka
    python -m nuitka --onefile --include-package=flask --include-package=qrcode app.py
"""

import base64
import csv
import email as emaillib
import hashlib
import hmac
import imaplib
import io
import json
import math
import os
import platform
import random
import re
import secrets
import shutil
import smtplib
import ssl
import sys
import threading
import time
import uuid
import webbrowser
from email.message import EmailMessage
from email.utils import parseaddr
from urllib.parse import urlparse, quote

import requests
from flask import Flask, abort, jsonify, request, send_from_directory

try:
    from cryptography.fernet import Fernet
    _HAVE_CRYPTO = True
except Exception:                       # pragma: no cover - cryptography missing
    _HAVE_CRYPTO = False

APP_NAME = "Lumen"   # change this one string to rebrand
APP_VERSION = "1.9.3"        # bump shows in terminal + /version so you can confirm the running build

# ===================== DATA LOCATIONS =====================
# Two distinct roots, never conflated:
#   APP_DIR  - where the executable / this script lives. Holds bundled READ-ONLY
#              resources (assets, config.default.json). Never written to.
#   BASE     - a per-user WRITABLE directory. ALL runtime state - config.json,
#              license.json, runs, sheets, imports, logs, the machine-id
#              fallback - lives here. Because the app never reads or writes its
#              config/license inside the install dir, (a) it works when the
#              program folder is read-only, and (b) no dev/runtime state can ever
#              be written into - or shipped from - the installed program folder.
def _app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable)) or os.getcwd()
    return os.path.dirname(os.path.abspath(__file__)) or os.getcwd()


def _user_data_dir():
    # Windows: %LOCALAPPDATA%\Lumen ; macOS: ~/Library/Application Support/Lumen ;
    # Linux: $XDG_DATA_HOME/Lumen (or ~/.local/share/Lumen).
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
    elif sys.platform == "darwin":
        root = os.path.expanduser("~/Library/Application Support")
    else:
        root = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    d = os.path.join(root, "Lumen")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        d = _app_dir()   # last resort only if the per-user dir is unwritable
    return d


APP_DIR = _app_dir()
BASE = _user_data_dir()
# Bundled read-only resources (page images, Chromium) unpack to sys._MEIPASS
# when frozen with PyInstaller ("_internal" for one-folder builds); Nuitka keeps
# them next to the exe (APP_DIR). Never falls back to the writable BASE.
RES_BASE = getattr(sys, "_MEIPASS", APP_DIR)
if getattr(sys, "frozen", False):
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.join(RES_BASE, "ms-playwright"))
CONFIG_PATH = os.path.join(BASE, "config.json")
RUNS_DIR = os.path.join(BASE, "runs")
SHEETS_DIR = os.path.join(BASE, "sheets")
IMPORTS_DIR = os.path.join(BASE, "imports")
SENT_LOG = os.path.join(BASE, "sent_log.csv")
SUPPRESS_CSV = os.path.join(BASE, "unsubscribed.csv")
LICENSE_PATH = os.path.join(BASE, "license.json")
MAX_IMPORT_BYTES = 15 * 1024 * 1024   # sanity cap on an uploaded CSV's size


# ===================== LICENSE =====================
# In a shipped (frozen) build, the license/version endpoints and the LEAD_DEV
# bypass are HARDCODED and the corresponding env overrides are ignored, so a
# student running the compiled exe cannot repoint them at a fake server or
# skip activation. The env overrides only work in an unfrozen dev checkout.
_FROZEN = getattr(sys, "frozen", False)
_PROD_LICENSE_SERVER = "https://vercel-drab-zeta.vercel.app/api/activate"
# Point this at YOUR deployed activation endpoint (Vercel function below).
# Your Airtable token lives ONLY in Vercel's env vars - it is never in this app.
# In dev only, LEAD_LICENSE_URL can override it.
LICENSE_SERVER = _PROD_LICENSE_SERVER if _FROZEN else os.environ.get(
    "LEAD_LICENSE_URL", _PROD_LICENSE_SERVER,
)
# The server is the authority on EVERY launch. Only when it is retryably
# unavailable (unreachable / 429 / 5xx / no verifiable token) may a stored,
# signature-verified token keep the app open - and only this many hours past
# the last fully verified online check. Explicit denials never get this window.
RETRY_GRACE_HOURS = 48
# Second bound on grace: a clock FROZEN just past verified_at defeats the
# rollback check, so time alone can't cap grace. Every fully verified ok grants
# this many grace launches; one is spent per process launch, block at 0.
# Whichever bound (hours or launches) exhausts first wins.
GRACE_LAUNCH_CAP = 20
_GRACE_DECREMENTED = False   # spend at most one launch per process


# ===================== UPDATE CHECK =====================
def _version_url():
    base = LICENSE_SERVER.rsplit("/api/", 1)[0]
    default = base + "/api/version"
    if _FROZEN:                        # frozen build: ignore any env override
        return default
    return os.environ.get("LEAD_VERSION_URL", default)


def _ver_tuple(v):
    out = []
    for part in str(v).split("."):
        try:
            out.append(int(part))
        except Exception:
            out.append(0)
    return tuple(out)


_UPDATE_CACHE = {"checked": 0.0, "data": {"update": False}}


def update_info():
    now = time.time()
    if now - _UPDATE_CACHE["checked"] < 300:   # cache 5 min
        return _UPDATE_CACHE["data"]
    data = {"update": False}
    try:
        r = requests.get(_version_url(), timeout=8)
        d = r.json()
        latest = str(d.get("version", "")).strip()
        url = (d.get("url") or "").strip()
        if latest and url and _ver_tuple(latest) > _ver_tuple(APP_VERSION):
            data = {"update": True, "version": latest, "url": url,
                    "notes": d.get("notes", ""), "mandatory": bool(d.get("mandatory"))}
    except Exception:
        pass
    _UPDATE_CACHE.update(checked=now, data=data)
    return data


# ===================== MACHINE FINGERPRINT (versioned) =====================
# machine_id() binds the license (Airtable MachineId + the signed token's `m`)
# AND derives the Fernet key for config.json secrets, so the ALGORITHM is
# versioned: changing it is a migration, never a silent break (see the re-key
# and re-bind logic). CURRENT_MID_VER selects the live scheme; v1 is kept so the
# old id can be reproduced during migration.
#
#   v1 (legacy): sha256(hostname + MAC + MachineGuid/IOPlatformUUID)[:20]
#                - two inputs forgeable (rename/MAC-spoof) and UNSTABLE (MAC
#                  flaps with docks/NICs/VPNs; hostname on rename).
#   v2 (current): sha256(stable, privileged/hardware-gated signals)[:32]
#                - Windows: MachineGuid + system-drive volume serial + SMBIOS
#                  UUID; macOS: IOPlatformUUID. Hostname/MAC dropped. Each signal
#                  is ALWAYS included (real value or a fixed sentinel on failure)
#                  so a machine's id never flaps between launches.
# The 20-vs-32 hex length also lets the server tell the schemes apart for a
# one-time, scheme-upgrade-only re-bind (no free multi-machine loophole).
CURRENT_MID_VER = 2
_MID_CACHE = {}


def _machine_id_v1():
    """The EXACT legacy algorithm - preserved verbatim so migration can
    reproduce the old id (to re-derive the old Fernet key and prove the old
    binding). Do not change."""
    bits = [platform.node() or "", str(uuid.getnode())]
    if os.name == "nt":
        try:
            import winreg
            k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                               r"SOFTWARE\Microsoft\Cryptography")
            bits.append(winreg.QueryValueEx(k, "MachineGuid")[0])
        except Exception:
            pass
    elif sys.platform == "darwin":
        try:
            import subprocess, re as _re2
            out = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                stderr=subprocess.DEVNULL, timeout=4).decode("utf-8", "ignore")
            m = _re2.search(r'IOPlatformUUID"\s*=\s*"([^"]+)"', out)
            if m:
                bits.append(m.group(1))
        except Exception:
            pass
    return hashlib.sha256("|".join(bits).encode()).hexdigest()[:20]


_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _win_machine_guid():
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                           r"SOFTWARE\Microsoft\Cryptography")
        return (str(winreg.QueryValueEx(k, "MachineGuid")[0]).strip() or "no-guid")
    except Exception:
        return "no-guid"


def _win_volume_serial():
    try:
        import ctypes
        drive = (os.environ.get("SystemDrive") or "C:") + "\\"
        vol = ctypes.create_unicode_buffer(261)
        fs = ctypes.create_unicode_buffer(261)
        serial = ctypes.c_uint(0)
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(drive), vol, 260, ctypes.byref(serial),
            None, None, fs, 260)
        return (str(serial.value) if ok and serial.value else "no-vol")
    except Exception:
        return "no-vol"


def _win_system_uuid():
    """SMBIOS system UUID. Sentinel on any failure so the id stays stable."""
    import subprocess
    _BAD = ("", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "00000000-0000-0000-0000-000000000000")
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID"],
            stderr=subprocess.DEVNULL, timeout=6, creationflags=_NO_WINDOW
        ).decode("utf-8", "ignore").strip()
        if out and out.upper() not in _BAD:
            return out
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            ["wmic", "csproduct", "get", "uuid"],
            stderr=subprocess.DEVNULL, timeout=6, creationflags=_NO_WINDOW
        ).decode("utf-8", "ignore")
        for line in out.splitlines():
            line = line.strip()
            if line and line.lower() != "uuid" and line.upper() not in _BAD:
                return line
    except Exception:
        pass
    return "no-uuid"


def _mac_platform_uuid():
    try:
        import subprocess, re as _re2
        out = subprocess.check_output(
            ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            stderr=subprocess.DEVNULL, timeout=5).decode("utf-8", "ignore")
        m = _re2.search(r'IOPlatformUUID"\s*=\s*"([^"]+)"', out)
        if m and m.group(1):
            return m.group(1)
    except Exception:
        pass
    return "no-uuid"


def _linux_machine_uuid():
    for p in ("/etc/machine-id", "/var/lib/dbus/machine-id",
              "/sys/class/dmi/id/product_uuid"):
        try:
            with open(p) as f:
                v = f.read().strip()
                if v:
                    return v
        except Exception:
            pass
    return "no-uuid"


def _persisted_random_id():
    """Absolute last resort (all hardware signals unreadable - effectively never
    on real Windows/mac). Stable across launches; NEVER per-launch random, which
    would re-wipe secrets every launch."""
    p = os.path.join(BASE, ".machine")
    try:
        if os.path.exists(p):
            v = open(p, encoding="utf-8").read().strip()
            if v:
                return v
    except Exception:
        pass
    v = uuid.uuid4().hex
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(v)
    except Exception:
        pass
    return v


_SENTINELS = ("no-guid", "no-vol", "no-uuid")


def _machine_id_v2():
    if os.name == "nt":
        sigs = [_win_machine_guid(), _win_volume_serial(), _win_system_uuid()]
        tag = "win"
    elif sys.platform == "darwin":
        sigs = [_mac_platform_uuid()]
        tag = "mac"
    else:
        sigs = [_linux_machine_uuid()]
        tag = "linux"
    if all(s in _SENTINELS for s in sigs):        # nothing readable -> stable random
        seed = "rand|" + _persisted_random_id()
    else:
        seed = "|".join(sigs)
    return hashlib.sha256(("lumen-mid-v2|" + tag + "|" + seed).encode()).hexdigest()[:32]


def _machine_id_for_ver(ver):
    """Memoized per scheme version (machine_id is called many times per launch;
    v2's SMBIOS read spawns a subprocess, so compute each scheme at most once)."""
    ver = int(ver or 1)
    if ver not in _MID_CACHE:
        _MID_CACHE[ver] = _machine_id_v1() if ver <= 1 else _machine_id_v2()
    return _MID_CACHE[ver]


def machine_id():
    """A stable, hard-to-forge fingerprint for THIS computer (current scheme)."""
    return _machine_id_for_ver(CURRENT_MID_VER)


# ===================== SECRETS AT REST =====================
# Sensitive values (email/SMTP passwords, your Places API key) are encrypted in
# config.json with a key derived from THIS machine, so the file never holds
# readable credentials. If the file is copied to another computer the secrets
# simply won't decrypt and must be re-entered - which is the safe behaviour.
ENC_PREFIX = "enc::"


def _fernet_for(id_value):
    """Fernet keyed off a SPECIFIC machine-id value. Preserves the exact legacy
    derivation ('lead-engine-secret|' + id) so an old-scheme id reproduces the
    old key - which is what lets migration decrypt-old / re-encrypt-new."""
    if not _HAVE_CRYPTO:
        return None
    raw = hashlib.sha256(("lead-engine-secret|" + str(id_value)).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(raw))


def _fernet():
    return _fernet_for(machine_id())


def enc(value):
    """Encrypt a plaintext string for storage. No-op on empty / already-encrypted."""
    if not value or not isinstance(value, str) or value.startswith(ENC_PREFIX):
        return value
    f = _fernet()
    if not f:
        return value
    try:
        return ENC_PREFIX + f.encrypt(value.encode()).decode()
    except Exception:
        return value


def dec(value):
    """Decrypt a stored value back to plaintext for use in the app."""
    if not value or not isinstance(value, str) or not value.startswith(ENC_PREFIX):
        return value
    f = _fernet()
    if not f:
        return ""
    try:
        return f.decrypt(value[len(ENC_PREFIX):].encode()).decode()
    except Exception:
        return ""   # wrong machine / tampered - drop the secret rather than expose it


SECRET_ACCT_FIELDS = ("app_password", "smtp_password")
SECRET_TOP_FIELDS = ("places_api_key", "groq_api_key")


def _load_lic():
    try:
        with open(LICENSE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_lic(d):
    try:
        with open(LICENSE_PATH, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
    except Exception:
        pass


VALID_ROLES = ("admin", "user")


def _clean_role(role):
    """Single normalization point for the license role. Case-insensitive and
    whitespace-tolerant (Airtable cells may hold "Admin"/"User"/etc). "student"
    is the legacy name for the non-admin role: tokens signed before the rename
    carry it and must keep working without reactivation. Fail-closed: anything
    that isn't exactly the normalized "admin" is the non-admin role."""
    role = (role or "").strip().lower()
    if role == "student":
        role = "user"
    return role if role in VALID_ROLES else "user"


# ===================== SIGNED LICENSE TOKENS =====================
# The activation server signs a license token with an Ed25519 PRIVATE key held
# only in Vercel env. The app embeds only the matching PUBLIC key(s) and verifies
# the signature on EVERY launch (including fully offline) BEFORE trusting role,
# expiry, or machine. A student editing license.json cannot forge these fields.
# Keyed by "kid" so a future key rotation can ship both old and new keys.
LICENSE_PUBLIC_KEYS = {
    1: "N530YqqsvLEbaWTk-zE3UzhhTiP1MD52o21nTGZEF8A",   # raw 32-byte Ed25519, base64url
}
# Explicit server verdicts that block IMMEDIATELY, with no retry grace ever.
# Anything else the server says (or fails to say) is a retryable condition
# handled by _grace_state(), never a denial.
_LIC_DENIALS = frozenset({"invalid", "disabled", "expired", "in_use", "machine_in_use"})


def _b64url_decode(s):
    s = str(s or "")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _verify_token(token):
    """Verify an Ed25519-signed license token. Returns the decoded payload dict
    only if the signature is valid and made by an embedded public key; else None.
    Verification is over the EXACT base64url(payload) bytes as received - the
    payload is never re-serialized, so field order/whitespace cannot break it."""
    if not token or not isinstance(token, str) or not _HAVE_CRYPTO:
        return None
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        b64payload, b64sig = token.split(".", 1)
    except Exception:
        return None
    # Decode the payload only to learn which key id signed it. It is NOT trusted
    # unless the signature over the original base64url string then verifies.
    try:
        payload = json.loads(_b64url_decode(b64payload).decode("utf-8"))
    except Exception:
        return None
    pub_b64 = LICENSE_PUBLIC_KEYS.get(payload.get("kid", 1)) if isinstance(payload, dict) else None
    if not pub_b64:
        return None
    try:
        pub = Ed25519PublicKey.from_public_bytes(_b64url_decode(pub_b64))
        pub.verify(_b64url_decode(b64sig), b64payload.encode("ascii"))
    except Exception:
        return None
    return payload


def _server_check(key, mid, prev_machine=None):
    """Ask the server (the authority on every launch). Returns a 5-tuple:
       (True,  name, expires, role, token)  - server said ok
       (False, denialcode, "", "", "")      - EXPLICIT verdict (_LIC_DENIALS only)
       (None,  'offline', "", "", "")       - retryable: unreachable, non-200,
                                              malformed, or server_error/unknown
    Transport policy: 6s attempt + one 3s retry. A denial is only ever taken
    from a well-formed 200 response whose error is in _LIC_DENIALS - upstream
    failures can never masquerade as "invalid".
    prev_machine (the old-scheme id) is sent only during a machine-id scheme
    migration so the server can perform its one-time, scheme-upgrade re-bind."""
    body = {"key": key, "machine": mid}
    if prev_machine and prev_machine != mid:
        body["prev_machine"] = prev_machine
        body["mid_ver"] = CURRENT_MID_VER
    d = None
    for timeout in (6, 3):
        try:
            r = requests.post(LICENSE_SERVER, json=body, timeout=timeout)
            if r.status_code == 200:
                d = r.json()
                if isinstance(d, dict):
                    break
                d = None
        except Exception:
            pass
    if d is None:
        return None, "offline", "", "", ""
    if d.get("ok"):
        return (True, (d.get("name") or ""), (d.get("expires") or ""),
                _clean_role(d.get("role")), (d.get("token") or ""))
    err = str(d.get("error") or "")
    if err in _LIC_DENIALS:
        return False, err, "", "", ""
    return None, "offline", "", "", ""   # server_error / unknown -> retryable


def _expired(exp):
    return bool(exp) and time.strftime("%Y-%m-%d") > str(exp)[:10]


def _grace_state(lic, mid, stored_ver):
    """The server was RETRYABLY unavailable (unreachable / 429 / 5xx / no
    verifiable token). Never reached on an explicit denial. Open only if ALL of:
      - the stored token passes Ed25519 verification (unforgeable),
      - it is bound to THIS machine (current id, or - migration pending - this
        machine's old-scheme id),
      - not expired,
      - the last fully verified online check is within RETRY_GRACE_HOURS.
    The window is anchored on BOTH license.json's verified_at AND the token's
    signed iat: verified_at is plaintext (editable), iat is inside the signed
    payload, and a fully verified ok always stores a freshly minted token - so
    forging verified_at forward cannot stretch the window. A system clock set
    EARLIER than either anchor blocks (clock rollback would fake freshness).
    Role comes from the verified token."""
    payload = _verify_token(lic.get("token"))
    if not payload:
        return "blocked", "no_server", ""
    tok_m = payload.get("m")
    if tok_m != mid and tok_m != _machine_id_for_ver(stored_ver):
        return "blocked", "another_device", ""
    if _expired(payload.get("exp", "") or ""):
        return "blocked", "expired", ""
    now = time.time()
    try:
        vat = float(lic.get("verified_at") or 0)
    except Exception:
        vat = 0.0
    try:
        iat = float(payload.get("iat") or 0)
    except Exception:
        iat = 0.0
    if not vat or not iat:
        return "blocked", "no_server", ""   # never fully verified on this build
    if now < vat or now < iat:
        return "blocked", "clock", ""
    window = RETRY_GRACE_HOURS * 3600
    if (now - vat) > window or (now - iat) > window:
        return "blocked", "no_server", ""
    # Launch cap (see GRACE_LAUNCH_CAP). Plaintext like verified_at, so it
    # bounds accidents and casual tampering; the signed-iat window above stays
    # the cryptographic backstop. Missing/garbage counter = full allowance
    # (pre-cap license.json whose verified_at was stamped by a verified ok).
    global _GRACE_DECREMENTED
    try:
        remaining = int(lic.get("grace_launches_remaining", GRACE_LAUNCH_CAP))
    except Exception:
        remaining = GRACE_LAUNCH_CAP
    if remaining <= 0:
        return "blocked", "no_server", ""
    if not _GRACE_DECREMENTED:
        _GRACE_DECREMENTED = True
        lic["grace_launches_remaining"] = remaining - 1
        _save_lic(lic)
    return "grace", payload.get("name", ""), _clean_role(payload.get("role"))


def license_state():
    """SERVER-AUTHORITATIVE licensing: every launch asks the activation server
    and obeys its live answer immediately. Returns one of:
       ('ok', name, role)     - live server said ok; fresh signed token verified.
                                Role/status/expiry changes in Airtable take
                                effect on the user's very next launch.
       ('grace', name, role)  - server retryably unavailable; the stored
                                verified token keeps the app open for at most
                                RETRY_GRACE_HOURS after the last verified check
       ('need_key', '', '')   - no license yet, show activation screen
       ('blocked', code, '')  - explicit server denial (immediate, no grace),
                                machine mismatch, or grace unavailable/expired
    """
    mid = machine_id()
    lic = _load_lic()
    # Dev-only activation bypass. Dead in a frozen build: a shipped exe can
    # never take this branch regardless of env, so LEAD_DEV_NAME/LEAD_DEV_ROLE
    # are inert there too.
    if not _FROZEN and os.environ.get("LEAD_DEV") == "1":
        return ("ok", os.environ.get("LEAD_DEV_NAME", "Developer"),
                 _clean_role(os.environ.get("LEAD_DEV_ROLE", "admin")))
    if not lic or not lic.get("key"):
        return "need_key", "", ""
    stored_ver = int(lic.get("mid_ver", 1) or 1)
    # During a scheme migration, offer the server the OLD-scheme id so it can
    # re-bind this same machine from the old id to the new one.
    prev = _machine_id_for_ver(stored_ver) if stored_ver < CURRENT_MID_VER else None

    ok, res, exp, role, token = _server_check(lic["key"], mid, prev)
    if ok:
        # A live "ok" counts ONLY with a verified, machine-bound token: a spoofed
        # server (hosts-file redirect) cannot mint one. Without it this is a
        # retryable condition - e.g. the real server lost its signing key - and
        # the grace window below turns that failure mode into a repair window
        # instead of a fleet lockout.
        payload = _verify_token(token)
        if payload and payload.get("m") == mid:
            role = _clean_role(payload.get("role"))
            name = payload.get("name", "")
            exp = payload.get("exp", "") or ""
            if _expired(exp):
                return "blocked", "expired", ""
            global _GRACE_DECREMENTED
            _GRACE_DECREMENTED = False   # fresh allowance, fresh per-process spend
            lic.update(machine=mid, name=name, expires=exp, role=role,
                       last_ok=time.strftime("%Y-%m-%d"), token=token,
                       kid=payload.get("kid", 1), mid_ver=CURRENT_MID_VER,
                       verified_at=int(time.time()),   # only on a FULL verify
                       grace_launches_remaining=GRACE_LAUNCH_CAP)
            _save_lic(lic)
            return "ok", name, role
        return _grace_state(lic, mid, stored_ver)
    if ok is False:
        return "blocked", res, ""   # explicit verdict: immediate, no grace ever
    return _grace_state(lic, mid, stored_ver)


def activate(key):
    mid = machine_id()
    # A user re-entering their key on the new build may still be bound to the
    # OLD-scheme id in Airtable; offer the old id so the server can re-bind.
    prev = _machine_id_for_ver(1) if CURRENT_MID_VER > 1 else None
    ok, res, exp, role, token = _server_check(key.strip(), mid, prev)
    if not ok:
        return False, ("offline" if ok is None else res)
    # Same bar as license_state: an activation only counts with a verified,
    # machine-bound token, so verified_at is never stamped on unproven data.
    payload = _verify_token(token)
    if not (payload and payload.get("m") == mid):
        return False, "server_error"
    rec = {"key": key.strip(), "machine": mid,
           "name": payload.get("name", ""),
           "expires": payload.get("exp", "") or "",
           "role": _clean_role(payload.get("role")),
           "last_ok": time.strftime("%Y-%m-%d"), "token": token,
           "kid": payload.get("kid", 1), "mid_ver": CURRENT_MID_VER,
           "verified_at": int(time.time()),
           "grace_launches_remaining": GRACE_LAUNCH_CAP}
    _save_lic(rec)
    return True, rec["name"]

# Ships empty - the student fills everything in.
DEFAULT_CONFIG = {
    "niches": [],            # each: {label, term, link}
    "cities": [],
    "places_api_key": "",    # the student's own Google Places API key
    "groq_api_key": "",      # the student's own Groq API key
    # Only collect/send to businesses in these countries. Defaults to markets
    # where opt-out B2B email is workable; the student can edit. Empty = no filter.
    "allowed_countries": ["United States", "United Arab Emirates", "India"],
    "max_per_search": 60,    # Places returns up to 60 results per query (3 pages)
    "sender_accounts": [],   # each: {email, app_password, name, from_addr, smtp_host, smtp_port, smtp_user, smtp_password, imap_host}
    "price": "",
    "physical_address": "",  # REQUIRED in the footer before any live send
    "unsub_url": "",         # optional hosted one-click unsubscribe endpoint (https)
    # Used by the Invoice and Agreement tools. Not secret (these appear on the
    # documents you send), so they are not encrypted.
    "business": {
        "name": "", "address": "", "email": "", "phone": "",
        "gstin": "", "sac": "", "upi": "",
        "payment_link": "", "payment_link_label": "Pay online",
        "payment_link2": "", "payment_link2_label": "",
        "bank_details": "",
        "default_currency": "USD", "terms": "",
    },
    "invoice_seq": 0,        # last invoice counter used this financial year
    "invoice_fy": "",        # financial year the counter belongs to
    "per_account_cap": 20,
    "total_target": 100,
    "min_delay": 45,
    "max_delay": 120,
    "test_mode": True,
    "email_subject": "quick idea for {business}'s website",
    "email_body": (
        "Hi there,\n\n"
        "I put together a sample of what a sharper, higher-converting website "
        "could look like for {business}:\n\n"
        "{link}\n\n"
        "I'd build the whole thing - your branding, services, and photos - for a "
        "flat {price}, one-time, with no monthly fees.\n\n"
        "Worth a quick call to see if it's a fit? Reply with a couple of times "
        "that work for you and I'll set it up - no pressure either way.\n\n"
        "{sender}\n\n"
        "{address}\n"
        "Not interested? Just reply \"stop\" and I won't contact you again."
    ),
}


_CONFIG_MIGRATED = False


def _migrate_config_secrets():
    """One-time, in-place re-key of config.json when the machine-id scheme was
    bumped: decrypt each secret with the OLD-scheme key, re-encrypt with the
    current key. Runs locally (no network). Non-destructive: a field that can't
    be decrypted (e.g. the fingerprint drifted before the update) is left
    untouched, never wiped, and never crashes."""
    if not _HAVE_CRYPTO or not os.path.exists(CONFIG_PATH):
        return
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return
    ver = int(raw.get("_mid_ver", 1) or 1)
    if ver >= CURRENT_MID_VER:
        return
    f_old = _fernet_for(_machine_id_for_ver(ver))
    f_new = _fernet_for(machine_id())
    if not f_old or not f_new:
        return            # crypto unavailable now -> leave version, retry later

    def rekey(val):
        if not (isinstance(val, str) and val.startswith(ENC_PREFIX)):
            return val
        try:
            plain = f_old.decrypt(val[len(ENC_PREFIX):].encode()).decode()
        except Exception:
            return val    # can't decrypt (drifted) -> leave as-is, don't wipe
        try:
            return ENC_PREFIX + f_new.encrypt(plain.encode()).decode()
        except Exception:
            return val

    for fld in SECRET_TOP_FIELDS:
        raw[fld] = rekey(raw.get(fld, ""))
    for a in raw.get("sender_accounts", []) or []:
        for fld in SECRET_ACCT_FIELDS:
            if a.get(fld):
                a[fld] = rekey(a[fld])
    raw["_mid_ver"] = CURRENT_MID_VER
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2)
    except Exception:
        pass


def load_config():
    global _CONFIG_MIGRATED
    if not _CONFIG_MIGRATED:
        _CONFIG_MIGRATED = True
        try:
            _migrate_config_secrets()
        except Exception:
            pass
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                stored = json.load(f)
            for k, v in DEFAULT_CONFIG.items():
                stored.setdefault(k, v)
            cfg = stored
        except Exception:
            pass
    # decrypt secrets for in-app use
    for fld in SECRET_TOP_FIELDS:
        cfg[fld] = dec(cfg.get(fld, ""))
    for a in cfg.get("sender_accounts", []):
        for fld in SECRET_ACCT_FIELDS:
            if a.get(fld):
                a[fld] = dec(a[fld])
    return cfg


def save_config(cfg):
    out = json.loads(json.dumps(cfg))   # deep copy so we never mutate the caller
    for fld in SECRET_TOP_FIELDS:
        out[fld] = enc(out.get(fld, ""))
    for a in out.get("sender_accounts", []):
        for fld in SECRET_ACCT_FIELDS:
            if a.get(fld):
                a[fld] = enc(a[fld])
    out["_mid_ver"] = CURRENT_MID_VER   # secrets are encrypted under the current scheme
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)


def _config_default_template():
    """Path to the shipped clean config template (config.default.json: no
    secrets, no keys, no machine id), or None if it isn't bundled. Looked up next
    to the executable/script and in the frozen resource dir - never in BASE."""
    for d in (APP_DIR, RES_BASE):
        p = os.path.join(d, "config.default.json")
        if os.path.exists(p):
            return p
    return None


def _bootstrap_user_files():
    """First-run setup, entirely inside the per-user data dir (BASE). Never reads
    or writes the install dir, and never treats a bundled license/config as the
    active one:
      - ensure BASE exists;
      - if there is no license.json yet, create an empty (unactivated) one so the
        app shows the activation screen;
      - if there is no config.json yet, seed it from the shipped
        config.default.json template (falling back to built-in defaults if the
        template isn't present)."""
    try:
        os.makedirs(BASE, exist_ok=True)
    except Exception:
        pass
    if not os.path.exists(LICENSE_PATH):
        try:
            with open(LICENSE_PATH, "w", encoding="utf-8") as f:
                json.dump({}, f)          # no "key" -> license_state() -> need_key
        except Exception:
            pass
    if not os.path.exists(CONFIG_PATH):
        tmpl = _config_default_template()
        if tmpl:
            try:
                shutil.copyfile(tmpl, CONFIG_PATH)
            except Exception:
                tmpl = None
        if not tmpl:
            try:
                save_config(DEFAULT_CONFIG)   # clean built-in defaults; secrets empty
            except Exception:
                pass


# ===================== PAGE ARTWORK =====================
# Each page has a header band + a faint full-page wash. By default they use the
# original woodblock-style SVGs below (work offline, ship inside this file).
# Drop a real image named header-targets.jpg / header-outreach.jpg /
# header-run.jpg (or .png/.webp) into the assets folder to override a default.
ASSETS_DIR = os.path.join(RES_BASE, "assets")
ART_PAGES = ("targets", "outreach", "run")
_GRAIN = ("<pattern id='G' width='7' height='7' patternUnits='userSpaceOnUse'>"
          "<line x1='0' y1='0' x2='7' y2='0' stroke='#2A2E26' stroke-width='.6' opacity='.06'/></pattern>")

DEFAULT_ART = {
"targets": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 300' preserveAspectRatio='xMidYMid slice'>"
"<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#BCDEDB'/><stop offset='1' stop-color='#ECE3CE'/></linearGradient>" + _GRAIN + "</defs>"
"<rect width='1200' height='300' fill='url(#s)'/>"
"<g fill='#F2EAD6' opacity='.55'><ellipse cx='250' cy='58' rx='190' ry='13'/><ellipse cx='560' cy='42' rx='120' ry='9'/><ellipse cx='930' cy='64' rx='210' ry='14'/></g>"
"<path d='M470 205 L640 72 L812 205 Z' fill='#7488A2'/><path d='M602 112 L640 72 L690 114 L668 122 L650 104 L634 124 L618 106 L606 120 Z' fill='#F5EEDC'/>"
"<path d='M0 205 Q300 158 600 200 T1200 192 V300 H0 Z' fill='#5E7C66'/>"
"<path d='M0 238 Q360 200 720 238 T1200 235 V300 H0 Z' fill='#3C6B50'/>"
"<path d='M-10 305 Q500 252 645 264 Q820 278 1210 250' fill='none' stroke='#E4D8BD' stroke-width='24' opacity='.92'/>"
"<g fill='#284B38'><path d='M118 252 l15 -44 l15 44 z'/><path d='M126 236 l9 -28 l9 28 z'/><path d='M1052 252 l17 -48 l17 48 z'/><path d='M1064 234 l9 -28 l9 28 z'/></g>"
"<rect width='1200' height='300' fill='url(#G)'/></svg>",

"outreach": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 300' preserveAspectRatio='xMidYMid slice'>"
"<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#BDDEDB'/><stop offset='.6' stop-color='#D9E6D9'/><stop offset='1' stop-color='#EAE2CD'/></linearGradient>"
"<linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#6FB0AD'/><stop offset='1' stop-color='#4C8C8A'/></linearGradient>" + _GRAIN + "</defs>"
"<rect width='1200' height='300' fill='url(#s)'/>"
"<g fill='#F2EAD6' opacity='.5'><ellipse cx='320' cy='52' rx='200' ry='11'/><ellipse cx='860' cy='40' rx='160' ry='9'/></g>"
"<path d='M520 152 L650 94 L782 152 Z' fill='#8094AD' opacity='.7'/>"
"<rect y='152' width='1200' height='150' fill='url(#w)'/>"
"<g stroke='#CFE6E1' stroke-width='2' fill='none' opacity='.5'><path d='M0 184 q70 -6 140 0 t140 0 t140 0 t140 0 t140 0 t140 0 t140 0 t140 0 t140 0'/><path d='M0 216 q70 -6 140 0 t140 0 t140 0 t140 0 t140 0 t140 0 t140 0 t140 0 t140 0'/></g>"
"<g transform='translate(840,198)'><path d='M-46 0 q46 24 92 0 z' fill='#6E5238'/><path d='M-28 0 V-32' stroke='#6E5238' stroke-width='3'/><path d='M-28 -32 L8 -16 L-28 -8 Z' fill='#E9DEC4'/></g>"
"<g fill='#284B38'><path d='M60 152 q66 -10 132 0 V162 H60 Z'/><path d='M118 152 l15 -46 l15 46 z'/><path d='M150 152 l12 -36 l12 36 z'/><path d='M86 152 l11 -32 l11 32 z'/></g>"
"<rect width='1200' height='300' fill='url(#G)'/></svg>",

"run": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 300' preserveAspectRatio='xMidYMid slice'>"
"<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#A2BBB8'/><stop offset='1' stop-color='#CFD7C8'/></linearGradient>"
"<linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#5E8C88'/><stop offset='1' stop-color='#3F6E6B'/></linearGradient>"
"<pattern id='r' width='32' height='44' patternTransform='rotate(13)' patternUnits='userSpaceOnUse'><line x1='0' y1='0' x2='0' y2='44' stroke='#EDE9DC' stroke-width='1.2' opacity='.32'/></pattern>" + _GRAIN + "</defs>"
"<rect width='1200' height='300' fill='url(#s)'/>"
"<rect y='192' width='1200' height='110' fill='url(#w)'/>"
"<path d='M-20 198 Q600 118 1220 198' fill='none' stroke='#6E5238' stroke-width='15'/>"
"<path d='M-20 212 Q600 132 1220 212' fill='none' stroke='#553F2B' stroke-width='6' opacity='.6'/>"
"<g stroke='#4A3A28' stroke-width='3' opacity='.45'><line x1='180' y1='176' x2='180' y2='210'/><line x1='420' y1='158' x2='420' y2='196'/><line x1='720' y1='156' x2='720' y2='196'/><line x1='980' y1='172' x2='980' y2='208'/></g>"
"<rect width='1200' height='300' fill='url(#r)'/>"
"<g fill='#284B38'><path d='M70 192 l16 -48 l16 48 z'/><path d='M82 174 l9 -28 l9 28 z'/></g>"
"<rect width='1200' height='300' fill='url(#G)'/></svg>",
}


def ensure_assets():
    try:
        os.makedirs(ASSETS_DIR, exist_ok=True)
        for page, svg in DEFAULT_ART.items():
            p = os.path.join(ASSETS_DIR, f"header-{page}.svg")
            if not os.path.exists(p):
                with open(p, "w", encoding="utf-8") as f:
                    f.write(svg)
    except Exception:
        pass


EMBED = {
    'targets': 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCAEqA3gDASIAAhEBAxEB/8QAHAAAAQUBAQEAAAAAAAAAAAAAAQACAwQFBgcI/8QAVRAAAQMDAwEFBQQHBQQGBwcFAQIDEQAEIQUSMUEGEyJRYRQycYGRB0KhsRUjM1JiwfBygpLR4RYkU/E0Q3Oys9IIJTZjdJOiFyY1RKPC01RkZYO0/8QAGQEBAQEBAQEAAAAAAAAAAAAAAAECAwQF/8QAJhEBAQACAQQCAwEBAQEBAAAAAAECERIDEyExQVEEImEyFFJxM//aAAwDAQACEQMRAD8A9vkA4FHaeSKUYxiljyNfLezZuBzNEHyJinCTzGKBqGyiRxSwn50ckYH403ZOaGxx8aU0hHAHFLrM1TZRTo84FNHiMU7aAnjmikCAead8uabs9KRmnwySpImm89KcOKEHpNQLiZpTjGKEEc0QfSjQSaWehiiR+NEccVWTdxiOlL4CndKFQDjrQ2g5UJp0jrTTE81oLHQAUo8hTvl60hzUA/Gjz5UIgx86PNAB6ikcGlA8yKG1RPFQOmOIpSYjzpfHnrSrQUmMnim5JnNOxRAFAJ6RRFKJMYoxigFCT0pGaQB5NARMxND0owD0J8qBSBmDWQvL1omkOKW2tAdaXSJo0uBQDd+ND40sE8URzzQCPKl8poniTTSkHgmgP50FTODRKYEZpDFAYgQKXWkMUcUCgdZ5pADypH86QoD4QcijgJ45obiMCKPPNA30iolHxAAVKY5iole9MxWa1CzPlFPGOetMBzk0/wCFCwjxNDp8ad6UPlQIYp0SMChExmKQn1oEJB4owTx0pSfLmjJ+tGQkA+tEjM+dDr5UiJ4+taBweOlDAocGAadtxNA2RNLnNHbRgDrQCM0BEZNOjNDbiDQI8xSjPwpFIIopTAoAJnAmkeaMQZmkeZFAM9BTTxxTvF9350BzWQ2epFGjGZpRNGh3DbxzSjpS2x8qQ4oyXx6UjPHlQJ88TRnPxoFE0pPB5pTORQPn51oLn5UQelAUorIMetD4iaNCtAgCjQ6c0gZkeVQLrR56U2M0YHWoB8qX86RjpS5xWgsRQikAeZonjFAscTRxmDQEUseVAYBORxSiOBxQlXlRkRG7msgjaT8aBAmBGKWAmPOlIjGaAR5CkYGAf9aMmfhSE+YrQUdY5pdZjiiU+lDj51lo0gk4o/ECjjrND4TQLpxSpdJFKgEHoKO2DmiMGjyc1pkhQP506grpigbtHJpRPBinGhB5rIWPKhmYmndOOKW3qa0GhJkhIpxJ6ilGesdKI9aAmemaEdYoQQeelGc56UAIJOJzQmMA0/JEQQKYZGIGKBc85pdKO0kcRS2k1kNPOBNE8YJoZFIfOtAg+dAQeKMDr+NKPSJoABmiUp6CkccGkCPKgBmgJGadzSoByZmjSjqKWaAn1psq4o9OKQETQKPOaUU4jrND5UApfOltpbTHNAtv4URHnxSE8ZpeGcigBmcUpPUHNHxTk4oTmJFAcCkcikTIwKQJ8qBcCKHXinSOtAEGgQ86R86EbetJSes0A60vvGjHhxSSD9KBdMihiYpxnypsZqBUhR/nxQ6AjM1QaUT8qMCl1waBsGciIoxjkU4yeMmhmJgVAB+FE5EUpJ8qOIxJmi6NNMPU+VSFJjFRkGSDipasAec07PWgnqKOZ4oWnU3+VEcZBFERODQCJpx9R60PSkJPNGSoxIwKVOyBjrWgwg+Ues0hMxMU/J5pQJnyoGlI+FICjk0uBPlQKPnQkedIKkeU0tvWOaBEz1pUhtHWkImgR4ogYkmkrCaXSB0oAcHnmlGM0ds80ekGgbH8QH86AB6A0lJEg+VElUQDNQAA9aUf1FKfWlPxqBExmluESetA5EZoiIigQINIkqGenyogAZxSPmKoEUokc8UpnpSJ9aBYpfSgPnSoD04GKWOkYpCgAKoJE8H8KIpdM0o9aARnmjGKQFAnPWoF8aQ+dLen1B9KQjpUXRcCkKRoZqoQk9KOOozSnpFL5UC+NEAeVA8eU0U4GaoUJpAdBwaRnpSCYzUAxPHFGkQZkUoM5qA46immBmaJBnFIczHFUNPnmkPPNE5xikDFRoCRHPNKlJPEeUUqAyJ5+NKYURPFIpSRAPNHYK0yAIIgfnQ90+I08J2g5oQDyDQKc0jzj60TEQKSeM9KBog4IinJjijwcAUutAutCcSaaskDAmjO77uPjQEKTOTxxQKhmJobQo4EmnJ4niKBszBEiaUKnxEZ8qcqZkGPhSBkZJx+NABnmlxgUJ8Qp3UzOaBqpPNGMRSPOAMUgfjQDjpNHpNDpSM7ZigRpQB86SeM0tucmgUgiln60QkRQM8GgIB/nQ/riiN0xHNI+ExIk0CnPNGMZNN5yadAIoFIUY8qQ6zTdsEQad0+NATQKRzMUenxphGM0DgoEUehigCCIiKM0A84jFCPwo8jNIqM0CBHTFKJzNKBHrTcnrxQOHwFH5UkgwaXFADnEUlcUp9DS9YoGkxABpZ5opjqJppmYJxUAlSlRuwKcT4ZoD4UIO05FQO8jSg/ICgD8aM+XxqhcwATNIDbg0uBgxNLHGTQAwTyc0eByc0toBEUAYMelRotkxM4yKSpSYAk0dwiUyaXJkgwelA1QVjco0IkEYMedSKggCIpsFJx/wAqWBqZjpSKswDzSUqCJnJ8qRI2yCM0CkzBEz60ROcUUgbJPXzoj4UCikeaMSfhTjxkUSmwTBFEg8RTQozA6U8TzNVDEkSQOlOoECZFAmVRVDsUDMYFI4obvDiouhSYBg0iQCIoYnKYo46VEAxukzmjuTGBxSPypGraEo4oBWcHJpTPzpbRjzFGiIWVYMRSnoTRkzxQ2JVmIiqg8c00ehwaSgAMCPOkkdfpQKQM/wBGlOJBoKiOKQEjyqKJpZ5o7Z60FfOgPrPFCaAHkaJijIyI5oE+U0seXNHwgfGgHHHWkJnNLE+dEEZmBQDiKWAYJomFTkChu9JqA0ppECMDmgJPQ1oI0cxgDFAqFHBGDRYUkcgUgQeOlCSnjrQnrWVOn50seVNH40ZHU0CMR8KUCkPIUMgZomjhHQUhJE8U1KgDJ+FHcABnnmkDpgYPFIcSTTd6TBTmKW/zqg7s+VLd50klJ560lYzQ0OScUJ5BNIER8aG8GoHYE0JABmm707QSTinFWIHFAMhUClRC5VkilVUZ8UATSSoHrTVbhAMGeakSkJEnmjILwI86SRt8jSMk9OJojHQYoFkigT0o4Ioc4JqgGU8YmjtMf1iiCKRwJFAwmeM05PhTHnQABMzk807jjM0DYgzRAM5PxowCYzSHINAlHoMU2KcrBpGIxmgU+HdtzFNAJUTNOKgFnGJowfOgasjGOKAkiKKoBz1pZGeKBR8M0DATE5oqJIxQRByrB6UBgjEU1U+VPBg8zFNJlUgUCCcCfpRKR5UM7pUaIyZFAcAgkzTAEzOZH4U7xUgD1igUAmjB9KEfhSjMdfjQIpjJNAHyowKGOc5oHH3abBwaSjiiI2Sc1PId8qHNJKRu/GlImqBHrQJiRTjxE803bOPKsgJM9aORMZoEbSIM0ZIVRo5JPWlEnNLkzNBRxxVZLb6nNAj40QqZxFIAdVVQpkxQVEwKHWeYpGSYNS0LANInwmQKXWPKgecVFgpAiZ5p0eVNB/CnA9eKqlBAkCmrORkVIDOKjUk7uKoIVA4GKaSCsginR9eajg7uazQ9ODgfGiZJmaaiZJgGpMnjNADPBNMHrOaconBihuxAxQDdmAJpBIPIHFNmOop6T1NA0YzJp6oHFNIkQKKYWrBFEEDGaCvF8qRUUiIzQ3J3ZUB86LqnDiiBJoApI94UtyZ5GKu01Rng+VDgQKaFJ/eTigXEjAVJqbXR4ASQTmlJT7vWo1PITyqgblr96hqpZKuYxSkCq6rtI91Cj+FRm7MyGx8zTa8bVuZIijMVU9sKclA+Rp3tjf3gU/OabONWAok4ApbsYHNVC7bLydwoBxnkOkT6GizFdKgkEmhOZrPKwIle7rQLni3BZzTZwaKlA4JAjigFJAyoVnFw+c0tyozTZwaBUkGSofWhvTOCM1nhXUHnzpd6QrpRZg0AsRE0ipM8iqAdjHNHvN3En40OC+CAJJoKcbTEqFUStQwevnRSuQoQDihw+Vr2hJHFBLwnKTmqZVB459aIWoYnmhxWu/RGRBNLv0zhOKq95j4celN7yTE0tXgtqdxgCkHcTuyarFRSnMZozIEpPxqLxWO+/jIpd8f3zmqveBOAYmj3piabNRZ7zHJ9aHekGDOard4oKzE0VPkYCQZ6zVTSyXMTvNM70xg81FtuFolCUmfWmlD6Uz3ZPwqLqLHeqgkmh3kiTUEPESGlZ9KcGLhSfcE9ZNXymof3hnmnBQImVfWmptXt0GAD60G7d2YI/wBKhdJEwowQTPnToGYEDmmqt1dHDI6U/uVpbAJJomwnMAmfzpBROJxNPShRCQYxU4GZPNNM7Vwspxu58qQVJ4FT7Ub4UhM8YFJSED7sxV0cogUSFQDzSUoRgKmptqBkIAn0pxT4fSmjaIJURBSQCOtFLRG6QTJnnipBIEjzonODJom0SWylU0qfuAUPFj40qGzk4zSSvdxkDrSiTH1o7h/KiaIDM80iQKYoGM4+FFKBOcnzNDRxAOZppPQgGnGQOlNgH5VpDoBEjikqdvpSBI+dCZFAoHGaM+GYFLE9aXpUAQckk0eKaOeOKcJnNUIwo5EUh5gcUOsUZ8qAJBiPKjI4mm5J5iKdA6jigCjjIoflQUTjMxS6R1FQOB4Pn0oE5zSztA8qaVEDwpn0qhyiBwKbJB4p42hPIJoEg8QIougEq+VOEDmmbhHFInMAUQ7d+9n8KUjoKQEgyDQgHoagdwOeaQnk00gDIHrRSqcZoui3ScjAo5HFM64micn4VUOJnzxQOQMUpNDP1oHhQmSaA6xQJSkZ60iQc+VF0HWiOYmJpEzQlPU1lBMDAyaSjNNJ8omkPOinAzz0pw859aZNIkk1TQkgZigobscdaIoT0qGgXO7BwaBUYMnmnH1oECfPyppTd0kAfOnZA5psQRRUJ5NEOHIgYoqJBgAUxtInJpypHAn8KGy2564p24dKbuUTApmyVAzBqqdOQBNI+6DzNHlJ4pnKiTNQOSdxkipJqITJjrT+kCaAqymTTQJE8U/G2KZ0nyoGCTjNPCTwKacKozC045qgqBiMVEppbiZDq0mpozxzS90AA1Dav7JJlayaYqzITCFD51bBmkcSRVXdUF2j4UnCTI6dKBYuE47n8a0UZ8RzNHBVk8VNLzrM9muFcpj4ml7LcjokfOtEGT8aCoBPNNHOs72a5jKB9aHsd1OCn61p7eCRSI8v86aOdZfsd2TEp/xU02dyk8IP9+tUDMkDFAhOSRTRzrL9luerXHrTFW9wnKmV/IVrgYnFImOJpqL3GIsrHLak/EGmF4EwT8premRmmltqfEhJ+IppecYiXBHIol1CTBV+NbJab3bgykR/CKcEpAPhEeVNHOMPvxOFSfjS78KTkqxW5tSOKG1J95IPXNNHOMU3AAMKo+0AIyZnIrYDbSThtOPSido4ATPkKaOcY7aiRKApXwFPh1Rjul/StULxzFHcocmI6U4s82SrekQUr+YpodJBJSRI6itckqBggfGhKlCQAAKai82OHlRAA+eKJeUfLNa6kpUSFomOihUXs7I4aFNLzjL7w53GaKVqEx1rVDDQH7JH0pqrVictiD5U0vcjNKpPvkn4UdwI99QrQVZWm2dn41GfYGSRLUjpumpo5SqROcfnQKgBuJz8avC7sogONZ9KabnT+qm8+lDf8UiRBhRobhthKlT0q6bnTwBBSfgKep3T1AAlEfDNXS8v4z9ziUyhS5pyLi4bVuC1kn97Iq0VWG2EQfmagWq3UCQ2E+szU0vv4SDUXhyhGeead+kVlWUIAqostqODzTMZUkq+lNnGL6NSXmWwY8jFI6irdJbGfWs8JIBjpRWIHvUOMXU6i6peA38xS9ueXB3JT57RWfJEgHmpdpPjj5A0OMXBduplReVzHE0fbnYHjSfKUVQPeqa3CYT8qXeeOO9BIMfGhxi+nUnd/iQj8qS9TeKfChA+OaoKUSJ3YGKC3AW1HJPSm14xofpN4GClvHxojUbhQw0jPxrPlKxwZHNBTqkyAFBKsZNDjGgnUnlK27QknGBmonFOKWf2ilD7qpqu24tIKkjI4BorceCyoqVj16UOMS7sEd3kfvdKVQ71b1L3E7RuM+VKiuhwRIn50IyTJmnwetMV6Cq8wAlRg04e9x+NNHiPHFSDB4BmgSsQd1NwCdoJoJge8acAAlQBNEHEdaB4kUyQkZPymmF1MnrTa6TDJgxS461EgmJ4oFzEAE02aSmQoweaWAPInFRl8YGxcj0pqn4ThJHxq7JEu4cU7j1qruUc7ophcUk+FczU2vFckngUhjkVS7xavvHFBLypjcZps41cUOMc0eomqRfXPNH2hSOs9KbONXTAGTTBnPpUHfLPlxQN0RKQBjGOtNnBKt1IO/mOlMW+PLmoUuDfKiAPMimkknCgqeIHNRqYpi4Rjic0C6tR5iotsnConzpPI2kQv40WYpA+sGJp/tCuCYqpvJV5x1o7kpV4uPMUXite0Gcq49KeLluYgVTJRyN1DvW5wVY5xROK77QkqMmj36DiTVKRG6FAecUO8SD73zocI0O8REhVO7xscqrO3HmPWKHengChMF0up6Z6U03JSPcH+dUgtRVMwKPfEASowKLMFv2pRGEpzQN0se6lPlVRTipmnDPKhmhxiY3SpEpGfSnJuiVZA+tVFSPdM06QAOCRTZxi6m6RHiBEYp4fbPX8KzQ6mDBzzR3Knn503Tg0w+2cTTe+QeFCs4EqEg59TQG0KJKj8BmjPBohxEe8M+tHdjlMj1rNJSOD0pm7Mjpz60ODTLifMUi6jbO8VnKclMCmhZjz+ApteDRTctpMzTvakT4ZNZ3egwkj8KcrfEpSofKm6cYve0J6AmfKgq5SBIQc+tUQHCraEn51P3DndlRVPyomonRcwIKfxoi4QroU/GoEsOJJ8JIo904E4bHzNXyaiwHETKVjzqUrbjwkfI1R9mcnIH1p4tFnG4Zp5TjFrcP3hj1oY2+8M1WTarOSRngRTksEKndznim04xNOYnk4pwMZio9u3zP8qfng0Q7gSKOCcimp4NIEyTFUIEboAoFYJ2TknjzojmfOlsTO6BNRCnakAYojAzQxME0jxCaBJB586J3BQNNkg0lKV0EmiHYnHWkTAmKH4T1okiT60XRc0AATnilwmKMYNEAggnrSI6UEqzBPFHpigGInpQ6EEU4ieuKByc1dhCQACTQOfKkqIiTQk7fdGKKJEmRRPHH+tYOtdtuzXZ+7Ta6pq7FtckBXcZW5njwpBIrkrz7Yrdbik6ToN5dIAlL1wpLCD8sq/CumPSyy9Od6mOPt6QqYmDFcn2o+0PR+zZXapc/SWpg7RY2igpwH+PolPqa4PVvtC7R6zbdwks6M2snd7IouOqH/AGhAj5D51y1vbMWrYZaTG8yVHJJPUk8n1r1dP8b/ANPPn+R/5dK59pXbV99TiHdJsWlZDAtlO7R/bKhP0qRj7T+19qr/AHqz0e+H9+3x/wDVXNp3EEkEhX739etINtpV4yTJ+lentYfTy93Pft17P2qdpTcbnNE0lbSfeSi5cSvj97afypPfab2nuVJVb2Ok2SEmShSlvkj1V4fyrkStKVZMeZEjrRDyV5JcTnzip2cPo7+b1fR/tR0K6Ybb1t9GiXoADguJSyo+aHD4Y+MGptY+0rRNOHd6aoa3ceVm4ktJ/tO8fSa8kU6hzwSVg5OOaCXAnwJAyIAAkCsf82G9un/Tlp7Bof2jaJrKxbvLOmXhMdzdEJC/7K+DXU70rTIIWk8Eda+dHW0PfqXNjmMfX/nUuk3d1olyl/Sbx6zeQfCgrUppfotBMEf0CK5dT8WX/LWH5P8A6fQi2grCh8qoHREEYdUPikVQ7K9srHtNbITKLbUQmXbNSvF/aR+8n1+sGukwROcV4ssLjfL34Z7m4y0aGAPE9/8ATSVoqZEPn/DWliN2KcCYxmMVlvnWWNHIEpuB/hofokkT7RP93/Wr7jjbIl1aUJJgFZ2yfL408pPO0irqk6jKXpTwB2PJV8ZFBrTHjuJdSifLNa6siZwaQTAk8VNbXnWWNIXBJuOOITxS/RIKj+uP+GtXEYHwpTB6Zpo51no0hvkvOH4CKcNJYUcrdx61ezR3Z4NVOVUf0S2Bh1ykNJbnxPO/gKvTJiDiiMjBocsmc5prRhJcd2+W6ab+iWv+I5860sg560kjxSQKmjnVBGlIJkuLx0p36OZQogIWsHqVcVoAbTHNDpV0cqonTUESpxSR6H/SonNLWoeF8R/EK0lHpVDVta0zREpXqN61apX7gVMq+QzSTfoudntA3pjyTlxvjHNJWkuqb2l5uB5TUlh2g0bU3Amy1O3uF/8ADC4X/hOa01SFYEGnGwnVt9MtOlvpMB5OcFQHSlWiAqSk7sdaVNL3Klmm/Ch8Zo1GQRJVBp8YOaajJ3HEU7I+dUNUATxUSrcKBhZzUijnFFJIJ4p4IrqtVJyFjzodwoxKqtJwc5pGJnmpo5VTNmome95pKtXkiQQr51ZBgcUjIGFEU0syqp3dwBwY+NMUHo91X0q8CYzFIKzyaai8lGXeClWfSgEOK91KselXxxmcetE8A00c2cpt6RCVfSill4zCDPWr08nOKKTzimjnVH2V4CQkGec0PZHiqIj51dMEZj6U4yOYimiZ1SUy6ETE/Oq4UlIggg1pJEghUR6igEtzAQkA+lNLMmcFlRhKDmj3bp8IbVI5rSEcpA9KQJnkAU0c2f7Ncq5THzp6bN8klSkirpE+c0kzmYpInKqXsTgBlRPltNQrt3EpICHFT1rVA9BihPkM+hpomdZClbEyoKHTIpu5BGQR862N0iMUwstK95pOfKmmpmzApZTCd0eU0pVM7ZB+daqWm0JhKEj0pQkZ2imjnGWhapygqNNUraowQJrWgKVtSMelV3gw2TvbH0pomahJKSeY9aSlKUBKceQqf2yyCoLZx5JqdOoWgTAMR/DU1GuX8U0hxahAKvlTdymnCHESav8At7G7kgH+GmK1K33QlKz1MJ4q6TlVIOmeAfLNIqVE7hPkBVheoskeG33K6BUVXau20rnuEx/aqNz/AOHBzaJIn4U5IUtMhpZHmmno1C3jxsAfCpf0mgGA0Y+Qozuom025Er3IUfu+XxqVLdoTIUTHOaiVe2znvtKB9KqLLbjpDaoT0BoSWtZtNvPhCcedOU9bhUKWifKRWHvKRyoT5dKH6tSiogZps4NrvLbcYU3TvaGBkuoAPUGufWUg/wAqXhiQrdPNNr23Qi4ZUoDvkfUU5TiAZLiAPjXO7kqVtJTPEgcUipCl7O7JH8QptntujLqP+Ij/ABU0utzBWmeY3VzyUDvRDY2kxQVEzsTA9OKbXtukF00rw94jPqKiW+2FA98IPzrCaSlxJ91IHFJakbiQrZP7pMxS2r226l/cr3k/XFTpUIERJ9a51K4cE3IwM1P7QUKJSsemJFNs9tvAegoQeY9Rmsdu9dS2R3hO0+9HNIam8kk95ujptzV2z261jzTiayVamYUQsD4opib99Uwd3ltTzTZ2611Exg00qUBJTI+tZKb15KsOkgnympxqK4Hgz8qHCri7jYf2S4HWim7ZVyrb8aqe3v7I2Iz96agXduvYVtEdYFNrMGql1tRkrT9aelQJ8JH1rB95UGQAJkHipErQpxJhU9VJOcU2t6fhrLebQfEtIxxTRdMzPeCRWctLfe7j3qcydwgUz9X3kl7HJiiTBql5sJ98GfKmm7QkcT+FZqnBu2pfWUn5VXWEqAUFKJ6gqmpteDY/SDe7aR9DRVeNSJP41jqSlIPjBjpTce9gR9Ku14RtIu2XVhOQf4sVIpxATu3p+tYyUgD/AD5rJ1ntXpGgJ/3y6SXzIbtWvE64r91KfP4/GtY43L055SY+3V+1sj3nNp8vWnJcbUmUrSRXhep9pu0+tOOLb1BeiWqlfq2LPaXAP43DMnr4ao+39okjajtjqqEp4ACNx+ezNeifjZV5r18Y+hcHrJHlXEdt+37OjhzSdFcRc60pOVct2v8AEs/veSea8w1DUe1N9b9052s1JxpGdqdjU/FTYSr8apWzF000Wm3LJlIV4lBpZ+J97n1Nden+Pr/Tjn19zUSs2ym1OOLdXc3Lq1LddXlalnMmih4Obi0Ur2KjwkY9KCrBt4zdPruZ+6uEo+O0e985qw20hKUoQgJAGEJG0V7Y8du0LbiVz4grb+7mnRJjbEGCR0odwhIJbSNp57tQH+lOY0vTUyXm7p9ZyUm6WpP0Jj8KbNHFI++VeFPyGKYsKIHhVJ4/0rZtdK0x60LNvaoaaKwpSUDYQrzMVm6ppX6HUNQt1L9kUEi4QtZPd+TgngZhXpnpnMyhxQoRevuOIYt7dwJyd9yULWMcDZH40xkt3CT+qUy42otuIVhaFjkH+szVlKoU24ysBaSCjGJqK9S486u/t0LU5j2m2CdyiAI7xvzMRKTmBjiDd3bOi7tJjdJnNPtrVV6xcpyna0UoWkwErI8Jx8PwplsWbpgrtXG3Ep5U2qYPlW3oaWToN54e7eSv9Y2vER7v1pctJY520cFyy08UlO5CXNqsc5qVbhBQ0n/eHXPC2lOSoj+VPZsVl1aNyUNtrVPhO5OcBI/r4Vq2enWmmOIcbX3jj0JU88dyynywISPQRUuQx3U92pJumlsPNqlCvdcSqYCkKSefhXS6V9pevaalVu87b6wpI8KbuWXk5n3gnI9SifU01q2tbjUE3y2kLdT+zWroYiR0HlgTFWrq0sdTJYu2WLgohWxQCi36+lc8tZe2sOpcfTorX7WtHdBbv7K8tLjlDTbftHeeidmf8QFQX3bjXr19Telabb2DBgC4vT3jpP8A2aYA+aqwmrfTtJQGmm7e170k7D4d3nnrVO81kMtKRahReON0eEeavX5VxnRxldMvyM7DNZSm6dCtZde1q7CYPtC9rbYn7qEwlPyE8Zpmi9oe0HZ9aFWupOXbCB4rK8WXEKx0UZUjrmazcqJUQckmTmfPPWonrpDDxZQl124U2XA2hOSAYOeB8z1rtxjhM8t+3sGh/aNoGtOC1fuBpuoYm3u1bZ/sr91f1n0rpnHW2bcvvPNoZSJLilQkfOvntNuu5SkXzNshteEtqc7wn04AB+ZqdvTLVu3Q2lpLqGvdQtW8Ax0BwPlXC9CXy9M/LsnmPZbPtp2dv9R9itdVYeeV7nKUr/srPhV8jW4oD5jpFfP9zbt3TIZeZC0HJQoDHyrV0btT2g7PKSzb3Htlmg/9FulFUDySvlP48VjL8f6bw/L3/qPasec0k+ZmuF037VtHfRs1G1vdMdGPG13jfThSf8q7BvVdNXZIvRf2wtXTCXVOgJnynzrz3p5Y+3sx6uOU8Vc6mkJxB59K5u97a6cz4bBl3UnDgKbG1sf31Y+kmsJ3tD2kuNxXe21olRkJtbfKRMxuXM/GK1j0rWM+vji9DzHQUBAMmvMEXeptOFbWuakl1XvqLu8K/uqEfSro7VdoglDPe2KEo5e7oqW5PGJhNbvSvw5z8nF6FunnHzpRmD08q83d7Xatpae8f1Jh5DioSH7cKKj5JCCCfxp6u0+v6ta+z7Bp7av2lwlotOqT+62kklP9o/Idaz2q1/0Yt3tD2tTaPO6ZpATdakn9oT+zt/7Z8/4frXJM2ZQtVy8o3l4vK7h3K59J90egq21at2zIbtkBtHP6tPP1obMpClpkj613xwmLx9TqXOq15p1veyl1lIWRhaTCh86v22p65pyUFvVV3Ccwi8SFIj5UWmwkbuARA60EpZ3kqVgE4J/0q2Ss45ZY+qOo6vqOsNdzeXbVvaqHjZtgU95/aUcx6ClTnG2UyE7lJPKuYpVOMaued+XoXzil0MzSUgqGDxSXJ6RXhfWOQIHOTQWSBANNSYSc0iQUg1UOAgTRMcxFIgRAVxQzHoKKHPSjnrQ3ZiMUCrOQarI7fXmgpWOOafyOaYRI+NAhJTxS254pDwiimY85rIA5pHn4U5KYBmozhXWtKcVTwOPlUTr7TEd6oJPlUsBSSk8GqqtMtlGdikn0UazWpr5M/SlqDBWT67cUf0pbAYWpXptzS/RrBwrcR8aCtJY+6tz5qp5X9Tf0oyoyQv4QP86f+kLcI5OeMUDpDG3C1fHFVl6W8JCChwH97pTysmKx+k2EtEpbdUB/DUY1ZKxKbdyPXAqv+jbyPcSPiqmq0+/gSEkDjNPLXHFMdUcUgkNISoDM5qBd/dKz3xT6JiBRGl3xUZ2JCvM1Yb0WBLj5k/uiov6RTN7cFOLpfyqVvULlI/ahwDkKHNWzozKiJcXSOjsAftHAD61dVOWBqdVEjcyoHzChRGqo4LSx86P6IbSB+tWPhFOGltBO3vV/hRP1RnVjugW5UPPdSGqKjNqPm5Uw0lkcuLxUStHSTIuFfShvFEdUdiEtpH40wahducLSM9E/51OdJPR8/NNMVpj/APxEU8tTirLLjiQHFiR1gUwhKR75mrP6MuQcLQqfWh+jrmPEkmfUVGplFQbjMyQPI1Ihpxa4CFkK9DU401/dgAEfxVMLG7SkjvI3eSjQuUVhbXAg90QeZineyvEylkgCrabe6H/XQB5mamCboCS6ggfvCqxyZTzLjaZUwoRUCigjdlCj5iuiQFFIkDPUUVIBOAPpTROo5ouok8R50lOIggHk/QV0ZYZX7zKD8qaLW3SZDCP8NNHcjnlLAWQYg/Sm46FJ9K6MstTJbT/hpJShGAlKfgIpo7kc5IjCQadBJjZG7yFdJgCcUFmU88UO45wMuKc8DKvLCTUht7lfvIcnoSDW8hA8jFOCUjEH61OJ3HPhp4e8ysDzCetAWril7AuR/ZrokgAiPzppTPyqzE7jIt7JYIO0A+ZHBpO2a1PKShobTng5rW2/rN565pDcFhKj+dTSc6xFWqwkpCFAdRsNO9lfCAUsK+lbUhM7nAPOTTFPsgn9YmfIVbF7lYqGX0mAyokDk1IG7jaVKtzA5rW9qYTgKAn0NMF8zuPiV9Kml52sdYBE90UyPhFJJBV0getbHtzBP7T8KHtFqoZUkx5ppomdY6lJUCpsbdsEiaAMgEqHEZitoCzUMBqT0NIM2XJQz8zV0c/4xSlHBWCD1mmhsYJVFbwNqkBO5hPwinBVrBIU1kZOKaOf8c+lAUgQv8DRSgAyCYFb3eWqkxuaz8DRDVrulLbX4U0c2GkPuzsClzg9amFtcxAZKZztA4rZTEQkiPQikY3T/Oppm5sdOnXRklBTPrzS/R9wSJbJjFbB9DTS42EklxIjzUKsjPPJk/o94o/YketBVq8lvcGjCeVH7taj93Z2zDj9xcsMst5WtxYSlHxPSvJe3fbVfaYL0fRHlJ0pZi5vEn/pKeqW/wCHpurrh0rlWM+vxiPVvtMuHnHGez7DbykObPanAdg81evlAmuXZYKX3Li7eU9dvftHimJ9APu/D6zUttbgNJaZShCEp2hMwlPp/KnKT3VyCZO0QAkV9PDpzB83Pq5ZkpRkK6K4KvPipi4EAd40nJ95RJNVnXFoBW8pQT5QJNVVLvH1LDbhYTx4QCs/XAro5bXFbGdzi1JbbRyVGAKzHdSW6Y09ldyY/bKV3bKf7x5/ug/GrHszT7yX3kqecSZSXPFt+HQfLyp7t2xb5VcJW4OG0EKcPyptULVveu7Fu3ivDnYw3sR+Mk1Hb3TiLr2S5b2PE+HaqEOxEkeR9D68006s+F7l6a7CurbjalD4jH50QUa3ZLKEuM7j4QpJSplaePnx6H4VNjpUabZ6gypakuMPt/8A5hlW1ZEGJHCv7wNVl6desPIbLablsz+uZwJ/iScj8eOmKHZV24uLULfA9pQo29whORuHB+EbT8DXQgr2pAAEdYiuVy01xc7b3fst93fDiffbPMfAirzJffR3/fKPeTAJ3JOfL5VoXVqzdo23DAWUjwKGFo+CqisbJy1a7pZ71MmCBWeWzi5y7s0abrTTFqgN2d0ytfdDAZUhSNwT/Cd4x6VdaU6ypDiCd4yOlT6rb3TvdutWxWWSfCnJKSIIz8En5VmI1BhXvhxhXQPNrZPp7wFdJXPKVo3SWlakzeNoCTetFtwp/eT4gD54K/pTbZYt3b1ClqU5cJb2jptBVP5/jVV55z2VaG4VtKXWwP3k9B8RI+dWISXAdxIVwY6c1PbOgbHjdEADCufQVZDS3i23tUhagAr+EE/61AlKWlLSXAr4VYcvmrW1/wB3CTevEiVQe6HmenlHnUpInv7pFm03Zafh/elDiwZDKYlRk43QPWJBPkcj2G0ecLymGS5ypeCqZznk+c0fZ9qTCiieu4+fU88ip2bU3lou5ffFrpoB8SVbVv8Ao35Tkbh8vMRqRVbU/cOuLtbV+8WnEoBIVyNveKhP44qVlA966cE5/VtQQP7xGfw+dWl3q7pSVtJQyynwtso8KUDoBUVwVJZWpCAohBITxOMfWrKWKynAl3amTvClA/CJ/OobhC03DLzLQU4jcncT7gV8/ODjyohsPItnm3PADv8APekpP+lPV3xfbYt9qXnArxk+4kcqA68jHrV2xIYlRRd7Qfab4p8alkBLaf8A9oxwOes8iXc/alDd6e5LhIQ4lJCHYE4J4P8ADz8a6LR9IbtmRKRM7zPJ4yfMmotWv2XWXNOabafaOHVO+NGPugHn+X5Z5fTfb3PLMySAFY80j3qd3eSraZNU+8GnNKDoWbdCZC1OSW46EnpGQSfOr1nZXupsh1Shp9qR4VqAW65/ZTGPifpWt6c50rVO5urKzda9qukWy1Hakb8rHlHX6UGru1TeH2O5Uy+obihJAPx2H4+VdXY6XZWBcdtWil0iFOqMuKEmJV5ZPpmjqNha6sx7NfMh9M+EqmUGOUq5SfUVyucd50NMVOvX7QhbLVyMmUr2L/yNTDtNBA/Rd7tHl3Z//dULmk3do+lDKXLlgD3nCJBnIMfnUibDUHkJPsSlT4RKk/hNa3K53CtTT9Us9TChavAuD3m1gpWD6pOav91+rUELDS1iEq96DGDFcle2brTYcvdKuVstme8Q2HSPgEEr+g+lS2uo6tZhL1o+u5YUP2F5uz8FnxD5zWdJxro7PTWbV4vuXDt1eKG0vvRPJwnHhFXSspclLufjxWPpvaXTr1vu1qRaXI8KmLjwKB9Dwa1koSpQVJCYxGazqrpItx2FjvlIQTiDUHdEn9qN/HHFOU2EAGYT5qrI1HtBp2ma3baXdOJQ6804+XCRtbSgHKvjtV/hNPa622fH3kBrcnrCoqnba3pt3o6tXt3QbBIUrvZO3aklKjx5g15b2l7euaprzF1oj71vb29utoKdSclz3ztnoIieorD/AEve23Y287PWrxNpcbSUKOU7TJCfLdAn/U1riutPdnXxs2uJCFL/AFaNyozn+vlSrxXW+1Gqa4NPtbh5LAsP1yHGfCtTgwlR9QPzpVeBqPrSSBim5UczT9uecGgSAcivnPr7N2kDAoTkAkH4U8kEAzQgAGAPKobJSP4qSRHWltjFEJBPNQ2EbcmimT0An8aSgIiaCQRyc1pR4nPNCcz50YBOTQAJJBFGR3CmgkGRyacQB5U3E8iaB2SMjimkkZFOSfXmmrSNpBNAMgkzPSinOKaI2wKcnFZaKcedAE8GiAM0vgK0ybBPnRyBAp0A8GlA9aASOYE0DM9KREnGIp0TUU0qxIoZmOlGExgU4JkzUDQTug9KPB4460iDPxo9ODWlNzkmkOMUDnFHZAgLImgUmMUhuP3TSCSlQO9ZHlFFHOFfGp5QDM8USDAiir3ojmgJ84qoaSuD4RUZcVugoAqZRB5mgQKjW0O5zASEj+dNUt8cBJmp9qTwKRSkedTS7V911PCRRBuJwEmpygedAo89xom4rl99Jy2Pkmi3dKKjuI+lWAkDANIpQcEAk0XcM74ke8impWuSZT9akLLce6JNMLEmQo4q+TcNU6sdKYVK6ECKkU1AwePM1F3JBzJqa2u4aXH+QUmPOml24BEBOORVXUta03Sz3b78vRPcN+Nwj+yOPiazGO3WkLO25Rd2ax911gmfmma1MMqxepjG0u6uUjLQA84molak8B7oSo9I5rEue2rrqtulWSQ2f+uugU7vUN8x6mKZadtUtPoa1u0S2hRhNyyJQPiOnxrfay9szrYem/8ApG4MgKT5YTmmG8f+8+R9Kupsbd8JWyQ6gjlJlJqXuGkJO1tM+uJrnqu3PBm+0uzPfqNNL6le86T9avQ83u22rAA8lVEzepuUKWwi2fSnlTawoD6U1avKKXh3bjHzM1IHcCAPhVs3DqRllKQfTmgLpUAKbBrNb5RCl6TJSR1gUznKcn0mrRuona2j4xTVXC1CJAkdBQlV9hVBAPzoraUgRA+Rp25RPun+hRCCVfE9aaNmbVFWBE9SKHdmYARnrUqUuqH6sGD8xSc22zCri5UhlpsStbigkJHqelXSXKGlgjjaaaplfEfSsn/bDTEufqTc3LH332mSUJ+fX5Vr2d/aX7YVaXrD4ImG3AT9KvGsd2UNqo9zj1pBtXJj0qw4ltpouOuobQnlSyEp+prEuO01k2oi0Q9efxNp2o+quflVmFpepjPbTDfUjjzowvzMelYI7VNJdJubU2rKQT3jjoj51jah9qVuhojRtIuL50mA5cf7uyM8yfEfkK3OlnWO/g7F+4TaW6333tjKMqWo4FcdqH2lWOzu9Etl6q+SR/w20ET7yv5CuS1PVtU14lWr3pebPFuynYyjy9VfM/KqvdpDcNHYhOAnyr1dP8ee8nl6n5N9YnX69Q1y577Xbw35TBTbJ8Ns2fRuc/FUmpGlW+xSO770kbUgcD1NVgguLSlAWQrokVa7sphKXEJWROxIED5165Jj6eO22+TFSpBgpEqgpAwc1CpaGUjesI3ZG7k/AcmrbSbZlKnLwqWoYSyn3lepPQU13UFFR7phFsnp3ecepPNXaKT7dytXeLbSwyON6vGf7vT5moXbhmza3vvbUE7YiSo+QHJ+AqRzUrVDfed6l48IbYhSlGPIfmcDzqi1buXD6b2+CS8EQlCfdZT5Dz9T6Vm5aXSB3vL0hbwWkHOwKwKKLYNQEbEIGNqUx/XFaDVstxRbQAsgYz/nUj2mX7ClH2Zxaf3mwF4+VZ2umZ32wjvRsGQFdOfOmbHLW5NzarT4x+saUPA7A59Fev8AQvBtTSylSVIPkRH51UdCLNYfQUhsmHE52jyV6f61ZUadjdOvqU9aOG3fgd4zcCQrynPr7wP1iK6Oz1Np1xLd40q2dUfCqdzavgofHgwa5Bxlq4QA4ndmRmIM+lBTbitqV3l5tQfCnvilOP7MVLjtZXoa0SCmDNIKO3ZJ8eQAa4BCDu3mUuqkFxOD5TIzW/oOtPOXiLG8cU8p2e5eX70/uH5cHrFc7jpuVuv27VyNjraFzxKZiePzrOasRpyl2N06bnS357v2lW8snP6tU8pPSfh5VtbCghSUDccVFd2/tVi8yoJAUImJG6sSt2Mg9lba0Xu0532RpRksbdzfxSOnyxWdes3umuj2tCFtKwl9r3N3QKByknpk+U8T0ljc94ypCxsda8CkHpT760dvNOuWWwjvXEEArPhB5Gfl+NamevDHGVzaHcpmcj5Corg9ynchpx11agkNsplS1eQq/aac/dJwAhCvecV7s+lbltZM2JJaHiPvLVlRrVz0xMN1zSdJuEFDupMhYVlNok+BUj7x6/l6da32bNm1tnbi9UHXlDhfiCP3QkedXFKQ2S6RkDJ6x5VSurJNxvfun1BlvKUjCWxWOW3SYac7bICWphaVrznmpYKj4SMVPcvtrVstmC0yPIZV601TyEoK1kp2nd6R1rpK5WMq1fDNg64/KEoeeTATHg7xQTHyiB610ui6QGR+krw928tMJQqNrKZmPj5n/KsfS7JzUHm7ssqXbseJhs4+DivlwPWeYjau7hFu5a2mo3KLZ+6JDbJUIcIyfj0qWt44o79y+v8AezbMqYtiPfKtpX/kPlVJOkulW32hpIORyCfkYrh9f7XX2ram4bK7uLexb/Vshp3bvgn9YfMHEA4gCsO5Htz3e3i13b6sKceVuWR6Hp8KTEtny9SDPZ/T7/vtS1O3dW26hptt9Q2NuGCJT+91lXHpWvq/abStGtkO316hsOp3NBA3rWk9QkZI9eK8STbtBX7NIGR4QAeaTbASCAogjCSpRO0dEjyFOGydST09Y/8AtD7OBZSLu6WBwRZOQr0BitnRNWs+0ViLuzLqAlfdLQsBK0Kic5jgg14kkgo8UycSDzVmz1LUNLdW5pl+7ZuLACik7kHoJQfCfzqXDws6j3Mtp3kDOfe61Ip4IA2qzzXin+1vaVeoWt0/qirk23De0NtveYWE+9/KBV9XbrX39Be091aG7lwn/fkK2uBJMwlMQOYmZrHbrfOPXN+4g7iCMeVPDa3hEyRz4p6+deX2/wBp+rpftS/pjDjLaFJeS09tL6ui/EDtiOM8+lbOqfaVaJ0izd0+27+7unFBVm65sU0EDJVtB9I8901njfhqZR1l1pdnepUbi0aWPMo8X+Lmq7PZ9u2P+5XF2wB/w3dyf8KpFcNqn2oXDVlYGyttriSHL4KkwOqEHgyJz0rD7UdpV9p9WFw0t9FkykC3bCighQ5Xg8/lFamOTGVwdLqn2lXmmdpry1Zsm7+yt1JYJS5tUVD9or6mI9K4ztDqTvabWHb28ZQjckIDaBhLYKikHPOc1XtW2Sppop2ImFfCfOpFNlSXnkeBsc/M4/r0rpJI4W/SJqy75h9YIHcjdkxzNRo8IO4iD51oIsi04ybpSmkvyRGSkdCaatlLbi0d4laUKgK4B9asrO1VXclYCTMRBPwpVafDLDrRSoOgJSSSOo5FKmx9fTIgwJoxAyKbA3DHwokZyrivmPrgYFLn5UINJBzGaBysiYpomPU05RjB60JERE/GgQjcAQaOZkg5pKAI4peOMcUCKSelECE55oAZk0VD90fjQM2yTHSht5MTTjIHFJMHk1PldBicUSJBkUjIFIZqmjYAGBTjxTVEg8UckCOtECD9aMR1oZByaWfp50DvhS6Zpu1Q4ijKpgCZ+VF0UQaM9IpvXgilny4qGi25maeOKbNEVUAiDiaGepNE0OtRYauImaMnAig4OgNOxtxUB6EAkSKAkKJJ6zSCsUJ9KqHeuIND04pEkHkUvTmgQ9KRnqKGUjFIGQSYkUAnPx9KMGZoCeaIjpQIDEUQAMk0qaSSfDmKoUHdFI5NEEKTiPSkDOOY61NBE4kmoLi6t7ZsruXm2UfvOL2j8awtS7T98s2+j927t9+8VlpHon98/h61z6mUpd7951VzdL95507lH+QHoIFdcenb5csurI7K61rS7K0F0/f26GVZSrvAd/wjn5Vx2qdqL3XU93Ypf0+wPvOnD74zx+4n8fhVRnSbW3cU4zbISondPQVIW5CQIHrNdscJHDPq2+lZq3ZYStLaAlaz4lnJJ8yaJSUmO6Ug1aQlTKIIEjyFOUO8G2YJrrtw9qSUL3EE7gfuzRKjExg+HA/OrvLakpQlM8hVNhaVqkJSQeQOabTX0qN2jbIUGN9mlR3K7h0tSfgnFOt7rWLVYbZ13UEpSJ2rUhz8VA1OEysEE4/dFN+8B3ZVHRPnFTw1LTL9eoasAm+vnX2RjuU+BB+IHPzquixSy4l60dVYvCAly3PdqHXpzVmFpVHjH70+lJDbR6DBjPwpqLur+n9rb+xSG9QbF+yeHWIDnzSeflXUWfaLRr9Es37EjJbWQhafik5FcWltsjDZOPPn0rHv+0Gi2dwpp65bW8gZbZR3qx8doMfOsXpTL0649bKe3rCXrQHf3rPj4JWM1nax2m0jRLNdzcvNlKcQkzKuAJ6kmIA5ryG87UXLylNaZaC2E/tn0JJP9lAOM9T5cVkbHrl5T93cO3TwMhTxnb6JHCR8K1j+P9tX8ium1j7Rte1W4nTrhWiWic7UNoU+v+0VBQ+QHz6ULH7Qe1dgEoXftXwSci8tgVq+be38q5vcCpJk7h849KSiAPFv84CuteidLDXpwvWyd+39sjbzKGntLOn3ZH6xd04e4SfRxKePjtpXN4O0PdXF7qFtdNRuaZZUAwP4gJO4+pmuCG4KO1ZKfJIz+dRKaYWVbmUHfhctgyeOaz2MZ6XuZX29GSzgKBCpxg1WuLO3uFhS2/1iTIWmUq+ozXC2Ae0m6Xdae8u2C/fbbgtK/uGpg/qjbrjzGr3iXHfeKyHETEYSRCflFS9Njk6W7utI019PtL3eXEbktKUXnj6hOT86r3HapZ8Fnp92XMw4/sS2kxyYUT+Fc1bKvLIKLjDVypWVqZPduLPqFEg/4qsjVrRBi4Yu0lXRbKlR80TWphpbbQNgh64Fxcpcv7tJ/aOeIj+yPujjirjNldOOpS606lA43YA/GpWe0lm6yq2YubWUiSlK4UPlPxovXbqUKdW/sQcqOAlI8/hV3U0mVaWlvCHCFKSPEEklPnUyF2bQ3It25AxuHXNZVrqTV6331rcIfScFTagRzT/FOI4nzJ/qKatPET3V2hTiiy0p7cCVFQx+dQPXF2hJ2MItEER4Ex+eamHeOMhtpULPO5MiPgKovWrqrkMv6qyFqQJbtrcre/NW0fKm9Em0ZXsbW4VoS2iSpa1YSB1Jqkpl/UhkON2UcLEd95lQ/d8h161tt6CwUIVcG5eWnxbbhzeB1nanw1FeNh24Ju30hCcoZQYx6x581LnteOlW1tkvglB3A4Khwqr1w22GAq3tkKUPeTt8REdPOqqbtwxsaS22OkxT1Xi3QtCmg0CMKSvPNYVGpx1Z3IGzd0TiDVnSU3FwtfeKJQiBuKcfA1VDe1IUVkp5lXvGtC3vLlxlu0tGW5bHiWTyepNLTGI77TGLsqRcNlxX/EThScYIVyK51zdZ3fsV8AStENPTi4EeIeh80117um3Pdb0OF5Z94JEf0KoptzqTK7N0NXO9JjvACkkfGkq2OfYsrlu3bS2+2tbeA24gjvE9PF5xGfMVOmzvX2StJRbEYT3iQ4r04V/nXQXnZu37sez3CrB8I8KkqlHzbJgj4Z9aovN3OntqOoWi2EIH7dslTcecjI+KvrWtpxZ7PeF0suNFu4CZUmJSf7J6j6fCprhB7sArLaj7q2zlChwZ6cCjbPlxnu3SFutgStMfrEHhfzj6itxnS7W7YS4w6pM+91APkflS1JNo9H7VS81Y6slTF0obEPj9i8fj91R8j54JroR0JEmcVx95p/dksPtpWF+cFC01Z7K3n6HD2nX76zbrXvt33llSUAwO6JMx6dM/XGWPzHSZfFdCu323KbhB/tJ88f8AKtFDYDAQV5UIUnEfOmjZIKQVScCnL2OJSCVbvhGa5VuSGqJKYIMLE4HPwoISN0KI2pzNP7wODakYASIPQxQKAqUbRHXcam2ooNOqvrnvWCv2NvAUoYdV1io9bS4m2YbBAQ4qFJHJ/wBP9KOu6u12b0J2+dbR+rSUssnw965nages15ovtzr94pXtfsSTsLaC22pIb/i5Mn/KumOLnlZJ5dn4kpgTIgnqTTLvT23bTvL9xLNmyQ4/uMBSB90noCYn0mvMnXLh57vH727W8tGxTyXNqlIHQkRIoJRcOtObV3biCIdIdWoLHMKzkV0scZlHpvajt1b6HbJttP8AZLrUlEAN7tzbIj3l7fMRAnNec6pqFz2i1Fd1qxaW45DQAENspmdqR86QbSxZkv2aWYA2OJMSSeoqJTbbzytqAgdE8x6fWkkiZZ78Ito3EJKCmSJT1FIIStvCXC50SEymKsvWBYtmnVOoh33EGZjoYpXS7JVuhy3Spp0nxIPugVrbG0CmHmVBL7LiFn3dwgmnJchJhKTIgGIj1oB6SgqKlqjE5xT1NBsoSlSSnYlSjyJIzTaGpbClKKicfIxQ2FOCQZ8qkbzBImD5VE5e2zbykOPICuuP50tXVSbVpRIiOaqm43u9wzDi90QBhJ9aeFOXLie5lu3HvOAZX/Z/zq1bpbbW2FoUGRBWlI+71qbX0pItbp91La3hyEpSxjdJ6z+VSsWiLZ5wobWp1fhKirccfGtjS2GCg3ThO9twJSmeCeJ+tUYWptKEOnepxQgDrIjp61Nrbaaoncd0CePT0pN2in3kMNJSCrA6AVdb0x+5uE2qR3WxO4kg4MTn8KfqTzXZli2i1F1cuiPe2mc8c/0KckkUrixftHEoe2AlO47eImKnQ+tiy7kITM7jjrVK/wBccvrxSgLS2CAAlTjhOJ6iB8Khdv323g6t2xUCsNhhK87vj0z6Ub4Vtv79ZumktJPgRtO7EZzT7fSFuN3IJ/WNrAH8XM/nUOi6val5u0UwWLp1wpM+IGEyCFeXFdIkLUJ3D4Vi5aYsYo0MrQwHVhohJ3xnM0q2toI2q8/kaVTkun0h6/hSnExRHEScfjTCM8mK8L62gUiRMmikGeZikeDzSSYOJooqk4SRFIJCTPnRKUmJAzTdsGUisoMAgc0oM8ml8KAV6HFaNDmYJolUCgMmRSOcTRSUok0kxtiKUSaIiKAcmT04pm8leAYqSDMjpQVk/wBYoAFFQyiKIMDM4pTPM0ekyayGyFKmOPOlGeh+NHp/WKaQdwJrQcCoHxAUBMzRk8xNDrmshFRnih1k0QJ4pGAc0AnHHwopOJimkiOKfI2T1qgGeRQn04oFXlQ+dVBPiVEc0h5DNZesa3baS2A6lb1wr9nbt++r19APM1w2p3mp646k6jcLDIJKLW1WpCP755X84HpXTHp3Jyz6sxeiv39la5ub23YnP6x0J/OmtalYupSpu+tVpVwpL6TP415m1pVg2oLasGEKHUNJ3flTxY2m0/7kwd3/ALoV07Lj/wBH8epwogQJ9RRKSBJB+leVJsGG0d22wUI6pbUUJ+gqZhD1qtK7S6u7ZaTPgfUUH4pJhXwIqdlZ1/49P+7JnNDaoJBIFcPbdsNZtwEXWn2l5HLjDimlH+6Z/Orqe26VJBcsHrQ8EvJKwP8ADNc708nWdXGurIJJMVC9d29ura9cstkfvLCfzrzntR9oFlZWYcReKvLh0w1a27u0q9TBwkYkn88V5te9pNZ1PckFnSUKiE2qt7hPq4R+Q+ddMejaxerI+hH9e0m3Z3u6jbhP8K9x/CsS87UP3Y26akMsni4cTK1f2EfzP0rxHT9c1bSbhtzc1qSAfdvB+s/urA/MGu00rt/oV+pLdys6U/PuXngT8lztP1nHFbnRkZvUt9Owb1/Wmk92bhm5x7z7Pj+e0gfhVR5691FG3ULtV0hAw1sCUfMD3vn5U5h+1ugRbutPECSEL3Y+VTpSoYECM+Qpxk+Gd5VWcWsgpIIHkcCKKAktkkEfOrPdBIClEqPSBRVt3HamQetXbGlUlTqwkFII8qZ3ZCoISfOrKWzJ2jaR6DNO2bSRuOMe7TacUBZeCYJifLJPnTe6AymeviFSyndgkAHrioHdT05pkuPXdujO0/revlFa801AVARkGRImKI4kggHnPNZl52rsENj2dDryzjKSgD1M1i3HaO/ecUWe6tknhKUbiK1MLWb4db3YUtO3GJJTNSC3WJKUg1wNxq2pXiNjl66gA8tnuyfmmqzS1sv72lOtOz76VncfnM1udOpt6F3KlRujHlxVa9uGNOAcvHktbpCQvKlxnA61zLfaDUm2tgvXE+qgFEfMis5aHbl0OOKU66qZUpW5XScngTSYX5Nxpa12jev7U29iHLRtf7V7h0pkYR+7Oc8/DmsS0tQm2Qy0yGmUiAEiB9Kuot2Une4QAfKq7zm5QEbQnrmSa6ySM01tCVbwElcidxUaf7OpT+xoyke9IwBVu2tHSEkgpQBMxB54qwlDbTJCE7OYNW5RdMZ5rubhaMlEzmilTbig2cSeBWqLNK95WsrcV58fSoV2qXUkJbBVz6x54pyTXk0Mnud2EhQB938aebRDiklStpH3o/P+utZDnayw07vrJTrj9zbHu+4bTuzBn0icTNZCe2t4NOQg6Q2boETmGSnrGZCvjWbWtOqc0/aod28hxITgJBBFRKQUCTIH8WK5tztvflSSdKbCEqSVw9vJR1A48VW3+3FrIFrZXd22VQpZTtnjj69Y4pyTi14lJ2ubkp4Hl86DzzNuQm4ummt+U73QCo+lZlrddmL1j2jV7/UG1qc2m1ed2BKT12tQFJ8yZ9a7fS9H0nTUH9HWNox4QSpltMkdCSPnWb1NNTCVz7DL+pgqtbLeif2lyC03M9JG4/SD51dsOyrDS2nb9z225a9yRtaaMfcRwPiZPOa3XICtsifM01byLZgl1SUAY56+lcb1LXXHGRmv6Hpt1cKc9nabuVDZ3zQ2L843CqCOzd6063v124UyMqSphreccbtsAesTW43cJXllokf8RY2omKs7SU+PxEDBqcqtkctdadoTV57O/wC0andRBte9W+QP4kTsT8VVq2zRtLItIYttMtkZDaQDj1jAPPE1O7cM6elYYabLqzuKUCJV1KjWM89cXzshCnyjJCAYHy/ritTz7Y3r0s3F+HgttlbgbUZ3EfOB6fjVNu3UpWxCAoq9OtTs6XeOrCNvdIBytXEz+daHs9jpyRvQtx5wTP3uPwq7Zs2zrnTXWkhbi2EyY2pVuUKjbtHLh4pZQXVhIKgDx9atPKl8q7lAQBHdgkJJ/wA61Xu6b0zvbZSEBwidqQPjNTZMXOBsr2pSNy1e6EiTz5V0NotbrXeOWwZUTgREetZSCG1IUkEOohQI55xW+XLgsBDqEoU4BO3iYBiplWsYCE7XTK0oMyrcYqvdaW1drC7ZQQ9948I56+tWu7SAShA3HMKTJI6YPyqNzc46mExuM4930rMretsV6zuHVhKkKcWRBPv/ANc1PYPO2q0svKWlonG7G01rtpS0dyT4jzjn+oqR1oXLawEJhf3FDw1bkzxYGqdnQqb2wbSi5bO9TQACXsZSPIn97ziak7MvsvMOQsjdkbhB8MhQM9QcEVtWlmLVBAfO1XupQSR8prO1PRHA6u90xwM3mCpt1UNux8PcVGNw+YOKcjS3f2jF7bJQTsUg4UBPTIrCurF21GW1LR++lJKauMfpO3fHesPkcqSEz9CK2LV9DwCmypGdnjSQrHpVl4lx5OVYbdtCh21eLaTjYlyU/NE10ml6im+B75oNPgSUzg+qfxqjqz2i2FwgXuoJtHLicYKRlMk9EjxCZrnrvWVi4A0h2zvkgErdS4dhnolQ6ic8+XwWck/y9CUQ0UpISnedgClASZ4/CsDtR2us+y3s4eZU+44qQ2391EiVfjx1rk9X1B7tMhtOo2Kbe3aQA2wV7yVxlwnoYwB0z51ltaQyLlb9w47dKHud8sr2DoPETPWs44ye0vU+mRqOs33aLVnL67DneqKg01M9y2fugD0iT1NWrbQ1OI3vuqQVCQlNadrbLse7t0Ad0kSVxyScD1qvfOWygu1W4lG4QpzdhNdZfpxt2ofolTdw64psC2ZVKyqfENuSKtq1Vn9clslDaG1EECPkKY/riXXnGmkQ2qUpyd1Msbdq6vENuktoUDt24k0/+oi3/pC5YabSdoySoRtnmfgKY5ZO2q/1jKkGOehzXSWuksWJlsq38FSlSatBBUCkpCuhSRM1OejTjfZihLai2QHDCFdDxxVjUre3YvS3boT3KYSVcjdGfnXQ3Flav7PaGwAgbUgqgQKydXVaoCW7RSO6X41lGQSDA/n9asy2jMQl5jYs43J3ZTyDULu22bUtYhMwTByfKKtdze3dw0y3IVGzvHU4ATyn41b0vRLl6/8AaL4pKWZDSW1SN+QVcfL61eSyfbKRbX14sKRaqbZZBdWVEAHaOMHzj6VeS3GgNvvhO9T6lNeAdRz8MGuoZYRbhYCPeUSCBwKY7p1vdJbS42rawrcEjA/5Vjk1phMKtGUKNzaqduMlSd3uZgfjTrZtD7TrAQlkXij3apkCIgVuHR7ZVy8tYKlXQCVIP8vwNTK0q3LlsrapBt42pBx705qXIsYl5pNw1artbdkrSlQWVjBX4f8AMH8Kms7Bmz05l++hC2lFyVTAJxn8K6GE8BJjzn+vOsDUm7rWNXcs2BKLcDrA3f0fwqSmg1zWnNIsG7hm2NwXlhAgxEjBMA1x1kw9c3Lty9ZXV5cvSS53EpCsmUkxHNdhca9oujtmxU46p62hoEMrI3dM+UxXOPa3qt6ylbyXrVt8FsNWoncYmM+IGQa1HSRW/QWpNW1y/dKS6lCIUj2hJfaT1VsyDx+FZyEMraAuEIdZSvu+/aaISlH3j5/SnvWabRJDzqbZakrbW404VgqidjhGM+WeKjQ1bO6Wkot2mnSkFxx53qB0SD+daa01m9c0u3fD2l6G0pYnu1OPAEfBOegrpNL7V2V2pLN9/uV3u2qbVKkwc7t/AHxrI0iz0TtC6LJjTnrF8N94ru1JcZVGMg/HnExWoewSfZzbOakstn7qmRAE4A/Cs3TN06MoRIBM4j0pU5m2Vb2zbHfLf2AJlXvGB5CBSrkw+hDEwBTFN7hJMUJlWJMU4qEQAZ4+FePb6poG3rNIHxUZE569aamCZkGqaSqPh4pkkgER9afg4oQd0JANVPQ4jGTTQAciKRmY2j1pRyd2ayoklOCTmiADx0puepp24xgitJs0kgQKROcDmhuk5MzRMRPlzUtCBzE0sSeaMwelNKlboxUBkcijJMilB2z50PP+pq0kI8YMUJ86W4GRHFAn1FCCSZxSExk0oxJo7TEgHFNAZ86QJzml06n8aY483bpKnlpaR+84dv501TZ8+LpQ3dRGa5297daJayGH3NQc6Js2+9B/ve7+NYF5251W8d2WNo3YNHlx0966ceXuj5zXTHp2sXqYx2WrazY6Pae0XzgSFYQgCVrPkkcmuUuu1d/qDbirdH6Nt5hThIW6r+SfofjXLvqcefcduHVXVyowXXFblR5DoPlUK3HlJnfuAGPhXfHpye3ny6ly8RqovrVsKWtSioqlS3JUtw+ZOTVlFyy43uS6jbHJMT8qwPeVO1SY5g0W2VXFwG2kqdPJATMfOt7nw5cdtv2m1Wr9u0uOMwKaq/t2gFF4dAOtZd+q20RhD2p3Nta7ztQHFeJZ67QOflNQt9rtE27f0rpLWYIXdBKvooCm78LwjZTqlmsmbkJgT4kEVYD1sGluG6ZDaRJVvAA/GuP1rtnp4a2aWkapckSlTWbdP9pz+Sa4i4tnb9e/U7ly+XyULMNj4NjH1mrMbUskd9q32i6ZbJ9n0ZpOrXAwpYUUst/FyPwTJrk3u0GuXD633NbfaUvhu2SlttsemD9arbMJQUjAxtEUzbKIKRArpJGbRSYeWvctTyzuW44orcX8VGSaIVKZ3mfpn4/6Ugg5/dHSfCM0EhXelO9AAOFKx0qp5IoUggpBAA5OZouIIQQSENgEkK4jzp42KSZWoLGIinNEMOb1I3lKpCVQU0GbY+yNaj32nPm0v20yly28CiDGRiFD61oXlxcagylGo3lxfBOIddJ/AYn1jpW8GNO1y19mdSWHvfRAAW2ofeSfnWNf6e9pLiRdtFTUH/eEj9UP7X7nz8PrWdxqy/CTRu0l/oZcs9OvGgyTJtrplTgQRjwAqSR+X411CftNuk220aKz37Yw57aQg+sd3Py/GuMLKHG+7KkrSUxByIqFKWLLc6Sm3Qo8B3an6cU4ypux0q+2Ou3DKmn9TbaKuUW9ultI/skyfx+lKw7W9oLVgN27rd82pEIVdj9j5QR74HkfrWMyx3y+9eMskQhsgQT5nzrQSQJLaQR0g04xd0+67UdqHkrRdIYurVYIKbUd2qM5hRM/WqjWpWqV7VsvtKUQJU0TGB5T/Rq5gicpgTJ/r8K49Wv3N/vUkm2t3DLCkp/WbB/F6+Vaxv0zb9un1PtBp2jJ2XTiy8U70NIBKyMDygdeawB2wufabh5LKV2RIU0lYhaEgZiPPJ9Ky0aelBN000T3nggdTk0o2mSnjp51vdZuTftO1C3FpVcWa0sPXCQ04FCG2zgFQ6mc/AnyrqLdTF068hu6YWWVFKxIOyOZrzlTai2d4BSoRny8qjS0hoOISC2laC2dpiUHBFNrK9Zsre1eZauGSh5LglLgO5Kh/Qqvd3DRAaZSCEqjHE/GvN7bUdSsWVW9nqNxbs8qQiMmOhIx8q27PtbcpKE3Vg08hLe0qbcO9S4HiEwAPT86y1t0zdsu5V3gHP3jV5lhtte4BRWcE8Gucuu2SF6cv2Rh1N8o7e7dAKW88mD5cVVtvtASkJTeaY64oAKLtuRChxu2nrM+GalpJHZqZRvCQMfvyc4qtqV/aaJapu7xYSyFBEATM4/nPyNcq/8AaQC5Fuw3bgf/ANZ4VRxxj86517WBqV9ufvfaniTt3HA+A4qNenT3Xb60Vpe7S2VLv3FgIZfTHh53n0j86wtT1S71HWzqDK/0e6pvuUd2rcUt5kT55n0qBQ8JlJxjikEAcJJIPE09M8jUIS2hKEDahIkCZ6zT1srZWAtJBj3fSns26vbG21kZUkeFQV/XNTXFsUXrjTzwkZ7wjCusGm2UItVqbZWXkbHMBRPu44OKe5ZPW74bcKMjCivB+ZqVqzeeS1sIW06RDiDMfGn6nZBK2S1IZKQkqUcD1qbRTcbcYcLaylS4yEqBx8aWmXS9JvRcWbi7ZxKC3ub2neCPdO6cYGelSvaTcsvpbB3BwSgpGFnyFQrZecUpKnAhY8ISRn4Yq+19O00Xt+h5KG9WtF27qhCnmTuaV8ufwrp7UW14O+S+i5KTE/umeI6V5Y/apXbC8t3ClK1BK2j7zZj8sGrn6d1RCu8sbxVuqICUpBSrETHWscXSZvU1NkGCkqI5x/WYpi2Eqb2ypKeoT19K8ra1nWLU2zSNWuQi1MIacgjGCFdVDk56n0FaOj9s73SHEt6o+9e2izh8gF1k4lXQFHPw+HEuLcyjulWLC3Ud4x7vCd3h55jrV1tpO0YCEgcDgVWXqFnbJZW9fWyA8sIa3ODxqJ8IHxq0Q4kxwD96KxurJCLuN+0mB05+NUHLEOXLjxUNp6AyYrQKDOVyPKmpQN8tgqT8c802tm1RiytUt+JlCj13Z6VI5YttsqYZdUGt5c7qARPxOf8AlVju1TuIIJz6xTUtmQkk4zxzTZrRqLG0buQtoKKwSrd/pUrYK07QkDamUz5YwP8AOm7ktkEuncOnFOX41kJHEczAqXdDsJUlaXU7lD3SPWaq3+uWelpae1F5DXfL2BxQgA+vpArG1LtXbsMOt6W25d3ik/qpaUGCfVyIgc+vAM1gX/eazfuXl6yhBcHdpYCtyW0ckfEqE/TyqyM3PTXHbq3uL8Kt7G4c09CDveLZQ4Dk+FB5AH/e9DUrfbrRS8rv1v2zKSO7dcaVC/WOQBHJxmsTutgAVAHIxSDchO4/Mk/15VfDn3Kvjtjfm4uixZIurVa9tqpLkCBgKV6dcVOz2zf3Mi40oqZH7codz6FCfvDj69YrKDO1UkBUDKelQv37TK1thl+5eQApTbKNxmPpPUZq+E511SO3WgNtoL7jzCo8SFtK3NnE7o4554gEg1BrPa+206+aRZMq1Mq8Lq2DuCf3RI6nPwgTEiuXOnXd+rbdttItxBLTS1K7ziAcDA+c/nft7BFm0lthKGUCBCAAmp4i81JNobtx67v0IVeXeXlABU+SQfIYA+FWUN7QAEpSg8R0q0nYN0KmecfjVQ6xYKvPZ0KUT0UANs/Grvbnbs9xKWwXHCEpEySQAKz7y87xTdvp5JUsblKR0T6eXxpt/b6i8+8pLa1WykYCT4NuJP51BZqePszdlZqbbWod6pDfvnrny5qzSaUXlXjail4uJKVJVEk8e7mn6dpZvbt1l1Sm1NpPTPl/ka6qz08NJV3+1RUQrieI/wBautWrcHu0JRv95SQAT8acyRmNaPbM2KrXuQtKh48ZVTHNIBdtVNKCEWxkJ5kTMTWspsJklQHnFBQmfCZ6TWOVXSFDasGR4elMunEWzQWtewLUGwU58SuKkeC27da1IKghJVtTycVSsLG8cbYuNSWjvgd5b2+5iB/P60n9P4oatZ3GoqeeYKXW7b9XtGVOK5UR9R9DUlr2fNo6HC+hTyUx4k+FJOJ+Umt+3tmbdBQ034Sdxgk5qTaAZ2gesfzq8tejiymrJtlbJSlSlNJKUlWTnJPxx+NT2tsphtSHFKUVLKs9JVMfjV8Nwkk+EJG4+g/r8qwbntZorJQkXFxdJUkLWthkrSgZyT04qTdWRz+o9rLq4cXY21g9ZvKcCAuQtYE/uR1rK1Fq705YtNRv7lTrPi7p17bMiN+CcesmM1o33bZm8bCE6MXLZRTKn3YzPEJycEYn5Vf0+4t7tN3cv9lmHHmWO+TP61aj91PikyYJx5cVuOkjmwWboou0PPBal9084u4cJ2kefO04FXNG1/UNMc7lp1GqMoagNl6Et5EDrxB/xVPp6dG1jX239Ws7TSV7ylNp3S0+0ExtKiobefr18qGpdpm759SR2dsHUIOxlq5b/WoEwSY/7vStVdOj0ntlZ6i+3bLtVs3K/eaCgYPTPXEGtPW064oNDRlsokkvLcAK/SAcdM1g6V2l0TT9N/V6W7Z3ESbZlid6yPuq6jHJra03tLpWpEtF72J8f9TdbUKI805g8HiudmvTGmE32Z1S8cfv9cvVpbSnetu3RLqoHujoPln1o2Gl6HqmotK03Re901ncF3jjriUuKz7qPvnIEn+VdsEESEZj7w6/1/lQCJMBIxwRU5rtgXnZm2VoD+mWYRbNLSrYkDdC+d0k1zHZvQW9Wd010aLbtW1mSi6dUsKLywNpQUjjOc+dd/cONWNi7c3DgaaaG8qPA/rFeXG41PvVPPLuNPGrI9q7m3SsJKuCranxQcnmt43bWK7qHaK+S5e6St+wskNOwVWsMqKZmAsHrifpUNn2y1Rlt1K9StXyVE/r07lJx02xP+tXLPtIm0b3W+g6Q7ZtgbjbrlQEgqweTHn+Ndn7T2e7R2qrFLtldpdTKmUrSVp9RHl5irRndk9cf1ZHs14ykXLae9S82QUOJ3YMDIxH0pVUHZDWtOWhvSu0K7e3KgVpcaG8JHn0UcClWLpl9OKHUKOKCXUboncRRUQenNBO0kgjFeF9M9KlRkExTUgFUAQaW4JMUvWKB5UIlQzRG1JkYmo1mZSCBNOQYEKO+koKkgmZM9Yo+FIxmeDTSucARSAPSBjiiDMiPKlNDPJigPdJ/oUTSN1W0zAmk2leCXDjpRVle6BUdzeW9jaKfunm2GUe+4swBSbrds0nCEnBBxQ2CDEiuXX22Lix7FpNy6zE96+tLIPwBz9QKKe3VqlAVc6VqbHE7WQ7/wBwk/hW+Fc+cdTAk9fjS7oHIJHzrlh26sFJm3sdRuMf8Du5/wAZFQL7bag4SGNHYShQG0vXRmfglB/OrMLWeeMdhBAwTisXXu1Om6AEt3TynLlwfq7Vkb3V/Lp8TWBddo9bvmFILzNghQhSrZG5ceilcfSshq1tGFOuIQA48dzjqiVLWfNSjJNdMel9ueXW+lu67Qa7qhKi6dJtgP2NvCnf7znQ/wBn61RNmpSElFzfJIM703bqVE/HdUi32WElRjHCQajbVfX2GtzLQOXVj8q66keflnlU67+7t0FDmragUkHwe1KP48/jWfcXrN06Fr33LgyC8ouH6qmtFOi2wldwDcLPVU/yqRzSrAJhVo1BP7sf1xU5Rvhl81huXW6UkFEfdB21W1B5Gm6au9uZbYHhSYO5w9Akcmr17rmgaCVd2pu5vEYFtbq752Z45hI+MVzt/wDpHtBqbV/qRbYDAUGWGyVhsK5O48kwMx6fHcrNmjV9otPbbLty5cW4BgbrVxX/AHQauWvaLs4hKVXOuIB/dNu6lceXu1UuWh3RTast96OConb+GetYryNRQ53d6yiExsdtUKKPWcnPxq+0jrUdreyilJDbl87Bjw2rqAfWSPSqzv2im3bLGlaH3KE5Dtw6Eo6dEyTXIKubcCQsyYwMr+gz8qXtQQkLVa3DaOil2ywPyx86TGHKi+5e31+5qGo3Ju71zwlW3altE+6hPQfnTS2gpEq3eucZqZu6auRLS2HCk/cVIn4U8qc3KVJhRrpGN/Zj9m6y2lUo8WNp5HyqFITwudx8j/P61YVCRuWpMJyST/Oo2d1y4GrW0uLhUSFMsq2qx+97v402HNtKCCtSthPCes0xSFKWAEqiryOz+r3Dk+zNWiCJl5zc4P7qf/NU7PZYncb+9edaIju2U9yj6jxfjU5RqYWstti5u3FNWdqt8oMOL3BDbZ8lK8/hNaA7P37akPB20bBzCkqckfGRWtdXLWkaci3tWQ1tBQ0lEbEx6VjG8dU53ryit0GQSTWZbVskUbj2y0cCL+2KGVRDyDuaPlPVPzx61I2lTiFq7tUIO0q24B8jWwzqwSlabpoPoUMcAn4jrVty+05y2Wwkm3mQApBI/Cm6msWChKkESdqkzwcpPFbNjrHgUi7eEgyFEcj+Ksu4toVuQQ42c7kGduOv+dVy5sblCTJ6HmrZtJbFt620d/vnLZQsHk9dv6pzqSUcfPB9apacq1vEG8bZbLhJSXUneD/ZV/y+FUbjUUBws9044oYXPhbCfVRxFZOj31o5rbj3cODcouBaXTCR5qSIG0ZzWpDe3S6hq1npyFKuEpK4Cg0kjeRMYBPrTrrVbKyWhD9yljvUEoCsY/Kua1R9/Wb90WSW32YDbWNvAnnrmR5Zppbbnetbrryk7TvWVbczGeOeKuts70svazqV/ZuMo7q1ZeEShJLm0xjPp1qqiGUIblS0AY6RmmkKUYSBkcVO+5bFoBDCULTHjKsn4+da9MW7Rd+fFBE9FE9fOpHm0ezocDu5SplJ5FRQQrIE9PKiG1KO6CEDrHOKbSmbFmeTJ6VN7KpVgbhIVKHe7VBxG2amsUNG9CX2e/ZUFSnOPWmPNoQ7sQVJbJkJVhXpRZUIC+6S4UqKD98cT8YoK3KTKSR85zPlTkOKSy42lSti/eSTNAtKU4hWEpCpOOeaIlcQ42eUwfvbhPwP40VNuoAdKFQ5JBj8aVtYvPZbZU4DjcB4ePOti/te5AMhbKjG1Rnb1is2+WpGHtbWsKKUqVMAkDHpUnsKrtCk9x3iEZ8InbW3YW1mtpsPWyA5MpVJz15q4F29iRbgbA5nrtFYuSuUHfsJCHW1uJRjvBHHOfhMVK2tpwFSVheOhiun9lR3pcDSEqPJ25qncaNY98p8thlauFI5pKrKT1WIASZmRIzU6rV+/fB3eNYJ7yPDA4n8BUp0V47S26lbZxKhEY5p7drd2Y3pPiWJOz8v69KbUrbT7+3wFpSlzdKgqUjnpTnbG77pm2XctBCljalXUVetO9C1OPuKUuZEDinX11a2rftD62UKg933q+7BV5SaxsVbN1bQfadcFwq33LbXBBJAzT7fUbG7Wyt8JauEGQTgGOs1Do79tqiXLtm27lxCikw4Fgn5VU7UtrZtkXKWW1r3bVKUqFR8OtWDZcYt7i3dLBCFPme8TkEg1V9ncYuLPuUB5tlS0lZE4/0zWH2d19hpv2a5K0pKpbckqx5cYreQ3dJbdt2yGm1e671Oavo0TnsFzcPJcKe/3BC3APFu/wAqe5otodoSpaD6KnrTxp9oAtRBUtwjvHJ5IFToSC53ni3lO30rO0Y7/ZxtYdSw+phbiUbVhHiQtCpCprZ0zWdT0G4cN0bjVbN494twql5lUZgcQYGMR0qXugoSpEiaWzYmQqYqb2vKxuaT2rttRuUMvWtxYuOI3tIdg94nzxwRIwfOugSVBEpOCCQUjmuEHfzKZ3dIOTUyb2/bS8hm6caW8PeTB2nzE4mpqOk6n27PaqRB3HqZqNaApwbiVxyZrk7HVNWtY7+9RftJ6XDSUq+G5AH5Gp9R1ReqAptyE25Ewgg758z5c1NNc42n9W063bWsvoeATJ2/rPyrzvVvtGvLvtEjTNJtwi2XDTguG1NulZmczgcdK1rsLTaOdzdN2qkCQ+pAUEDqYrzXUHkXWutrt75ernBWpf6lSiD7oPlHlW8IxMtvT0J3HbtVFBCUK3eEn1OIrE07VNIsNRRpLJfZuXIVtc3rG7nkn/StxLzDtyu3Q60t5HLW8b/mKlc7D0pbAUBK1zO2ePSipspkbAZz4aelskzAgZx+dPDYykH1wAanlNKSm7m4eSneGWQqSlP7Rfz6f6VOxassMBDaduZJnKj5k+frVnuxO07oHyIzTlIBVhIgnB9KLpUuLi1sG++u3kMN/vLVEn+dUdK1201i+dtLVt892jf3qkBKYn4z9R0p+uXibeyJVYC/BBBTvbGz/EcfSvPdP1G20+9VcqtWXSFS2BdODuxzhSPercx8Lp6ReWN5doWhNyhppSQPdJJMif6FYWq2Vpo1s3dEvr2EeFLchfz+7Rf7ZXNwwy9Z2rexY/Wbp96ehMSIrF1q6/SyGXL60tWr1oiH21rKikHgirjKmnU9mtVXrdi6vu22e4X3WxJk7Y6yBznjyrbZYaYaDbICEJmAmRGK4Hs0dLZtWnbiydNyvhSbzu0meJG4flXeWeo6XdL7q3vrdb8fs0uAn4etYyhInaSpSx44kwAaf3RiCVHcJ8qp6tqH6PtVONtLcdyEbWVuJ+e0YrG7P9qXr6+Fvd29u3IJ3g7II+7HWszG1dOnhKVSAlKk9aCgidwkq8/OoWr+1e1M2CHgblvlG0/P49KWpN3rVuF2txaMgD9Yq6BIj+unrU15RD+k9OXdi29vtu+/4fejfWglspSd4VAryhLtqbxbjqbVSCvxNgbW19PdBHXNdbc9t22NEQ6VWrd0pwNpZ3SAgdds4HSumWH0OqLI5CU7T5GKAQlC+iR0nj8ayNO7Us3lql1+wvGSU7tzds462ocyFJTXH9tdUstXdtnbQOOKnu1l8whIOMIVwfUR6zWZjWtOjvtN7Ratd3VpdNuW9o24VMuWryW0uI6An3p86pW/YO4btnPadUZtmUqUsENd4UJ5y4YEeePnVtrtXbaZ2bYDVq668w2kKbcV4QB/EEnj+zW0289rvZ1tQt2Gjeo2qbfBcQlJ67YG4+hitXcV51eM9nxqTibd/VdWDhSncwtLSXV4wlO2VYIrfZ7MX17ftXVgwvs/7ONgccG953jBTuiPUmuo03S9G7K2SQFhC1jYp907nHf68q0bW5tru3Dzbo2DJ3wggD8qXNdvO+2+n6y1orL19d2t3aWryCpTTJbc/d8yPvenNZT1yLq6urz2dWrXLhCptbcpaHUbts5gnnPwr0r9P6Fc3AtBqlo4tZ7vu94IUfLy61idgFJt0arp6Nie4vnS2gY/VyQI9JQqrL48rGZo/Zti6S03qumauQ4gGXHUhhoEE8JVIAOADJHpV2++z8KebXbXYfbQY7m+RvT0A8SYJjmDPSr99250mxunmHEXLncKKVutthaZHImenFV3/tF0sWyhbM3L90CUC3LZRn1UcD45qftUbSHFaTpa7jVbhlIYSVOOpScJHkKxtT7e6RZhfdd5eOpISkNphCyfJfFUtS1fQ+0unWl5eaw5YPMTus0I76HPPuymSROFeRqG10TQr7QHtQudccW0wQVXTCwEmeE9yQSkiQI5PSpMZ8mmnb/aJpj6bZpVldt3LzyWy3tkZzM9R6c+lUkvapq3b6+vtFVaouLBj2ZpVyFFC07o6cHcHPpWZddm3WnG7l27uNNsYKkO6oltt1TgBKAhIMz1hQHTmndlv0doWsXlzrGurt3rVZY7lKSA9AypREyZUcehrUknpZPlha1o+tWN6/f6rZNWwuHdzlw20lxlKuhEe7PmfOruga1daSojS7TT7kmC+ULlb3z+6OcAGM12XaC//TuoafpGn6na+w6o2sBxqHe8WkSUOJxCfgZnpWBfdme1Z7iwW2W7JgJhTOx/aRwUk7V9Birvx5V03ZftBc65cOs3WnNMdy2FlTTpWJJjyx8KVLs/2q065aXZ3brFhfML2ONOf7vuI4UlKoIkQYPFKuWXtix7MO1TcR+jL/8Awt/+enDtQztk6feyBMQ3/wCeqBClEEIBHODVd3vN4TBAGKzOnit6+cap7Utbv/w29/8A0/8Az04dqkfd029V8C1/56x0FaiUhRM+YqTYJ8YTM+VO1in/AEZtRfaYDbGlXip/ia/89RDtamQP0RfgH1a/89Z3dgDaFwD50th2+EDjHlSdPE/6M2ke1uMaRecfeKIH41GrtY6n3dLfM+bgmqaQomNqDORFN7sg+9M+fWr28U72bQHa1ZwrSbgf300x/traWTQXd2y2QTA3OpqkWkjEZGc9KjctWHUhLjKF/wBpM1Zhid7P7WT28bfaV7Hp6iTgLuLhLSP/ADfhWU532sXDd7qV0i6W2f1TTAhhk+YGZVBjcc+USam/RtkACmyY8we6T/lR/R1ooybNifPuxThJ6a71vsktpTnwp/CnFSQgqSFccx+VRK0TTnR+ssGFAebYpqdC0sggWDMDOBAq8WZ1EqVNpXwJB8OJ/rg0W3Etq8CYBzg5qI9ndKVlWmW0jqUCmJ7O6OJT+jLYAYju6utL3E7rsg7ynYPPiqLirVSvFd26EicBQ6VZToWkogo0+2Ck+bQNWEWdq2Ybt7cRk/qh/lU0ncn0ptP6U2iUXFstU+8XEEn51N7Zarck3bcERhwTVsMsbyfZ2s4J7tORVbVre8f0l5nSXLW3uzGxbzQUgZz059anHbU6v8QXF7a21k9d3Fy03btIK3HCuAkV5nrmqO9p9TU873zWnpT3bFqtSk94Oq3Ez18j/oNe87Hdrbm5Cr72bVG21BbbartLYSrzISykK9JmKf8A7FdoVJH/AKs08Ajheoq/k1mtY4yLepyc+zbtsNlthlDTZyEpRtH4VKhy4AAS46mOnQVrL7D9pis7bTTGwfunUVkf+FSHYntOgAKt9MM//wCQc/8A4a2woNru0p3FJcQrkqq37cyykKLiUFPQqHNaNn2K1PvN1yxpon7vtTqgM/2BWgnsreMeNm30hRBmDuSf8W01mtS/1z36Ut1DwFx1Qx4RVdeqOg7UsgRiFHpXRr7K6jdJhyz0dkjAW2+4fySKhHYXUUphbtktJM+F91vH0NIm3MXq/a2e6uLRk9dykTVNLaG0j3GkA4AKQnnyrtGexl+lUd3ozaAOVqdfJ+sRUquymsqfCu80UJ8+7XNXaePtx7btughTjFq+lEH9ajcARBnmp3tZuLghC7lSAOEo8ANdZ/srqW/vNukPL8yhwVIezeolCkKRpSp8wvH4U2s19uOFwpkI7m6eXnqrEU79Jv27veKKkz59K6pPZW9c3KcY0lE/utKUBUlv2WvrSVIXpcgf8BQiPLNS03/XE3DxvE984tSgE7UqAEeVQJSmcKVE9elejK0bVlqLX/q8t8HctxQOP3dv86qO9iluEqSLNkq5KO8A+lMckuq4dakohO33REFIpzV4EolrYoHqoV2qOw7qVF5VzZuqGQlxlxQ+u+PwouaBrIkJstKfziXVIEf/ACz+dORJPtxiX/1gKYSoyZ65rE1i2urq1ccu7iwtGQRt2oWrnAzIzxiOtemu9nb5aClen6cuenfrH0/V1y/aRGmaMthy/wBM067uW1fqLNN+4orXjlGyMea8CtTJqT+vNhp/tFmtSli47lK9qG0KmQPCR6Hnj6xWq2zZKZtLbSrR9puJvX3ZbKsRtkiT8q0CEqvby+RbMWYunAr2dtW5DfhAgcSeTx1qfuHFHc51HUZre2NqFnaLt71bpflKj4EhEbR0/CrjzbDy0BZUGkT4OATSS0dxLmSrhKc00J3KhJgD51ZUsRN6UH7pSG1pQjlKiR8hWhp+kItrVbtylvvFiYIkpTHFVmwWyC1u3+Yoh24cV3ZuFKCcbUms2pIqX1vYMGWRvWskiPdEH+vrVN1ZUiDM/wBZrVTYB94F15SJ6JEz8vrVe+09DDbHdqcfcceSwEpTtlSvdSJx06mtS6NbUEPFpQWIBBkQa1bTRfbWfaHLtMPJ3Db4iSfPitZ3RbrTrcvXuhPsJbISXIQ98/ASY9YotP2tw0gsPtrbjGxYIrFz2vbsMTp1oiwNomCFDxKOCT+98aqt6DZI3ha3nZ4lQBH+daKNv7oV5VJBj3YH1rHKmmMli+04KTblD7RVIgSR8qiVcX1xb9440VtpJAIT1reDLkAkomqjpuU3MFCUoAwvbuCvWavI0zbe+Q42kukJLU4b4V9aursWriFoUpAXkhOf+VPUHH24S/bLCSDt2Uki4bEKaRnoKWr5SW1uGhBfcdxMdKsKbQ60oQUiZkYimIcRA751DW7A8QE0FvMW7Lj5UF7MwhQJUfLNZNLHdoS0EhTaUAfdBMCuC7SrbRrDdyjUmL1xo+BKQkhmDx1rq9L1ay7Q2a0qZGFQphxaVevHlWF2ouEJtRYWWjulxEnvVWqkpEfuYzxzxWsVkb9ipblm2V3DL7331scHPxNUdZGq3VpcMNIt2bc4XcOPFStnXG3E1Tb0rULTSLxLTlklsI/bMp7p1CwRKTtHT407Q3hr2nPW15euIS1A3JeCC4OSCIn5zV18ih2Ye060url1d7dLeaUpBQlB7tSJ8KoAP407XUWzlv7T7W5dLjbufZDasdAQkfHOKhOkasbi4VpUlhh50NKtVjeIX7q1TPHnPNQadZWLeos+3XqEqJ8TQblaXQY7tc4Anz5q+y/xsW/aBDLdtb2rDFsEjYF3Ds8QOETA9a6u3S4plCnENhahnuzKQY6GuJ9vau7u4Z1a7UplUIabccBbSqJz3acRjgRXU9m7V2209ajeW13ZqBcD7bylbDjGZHnxHwrOSarRLMHKTGJqm7qbKXVtWzD9yttWxRTAQk9ZUflxVi6edFoV6etl14AqG5XhGDBrNsrNdnbKW893lwv9c84oyCsjPyrOjSx+k0i6Qy7avWyXHO7Q44UQTE9FelXwnlISc/M1hXabR9hTF4w6GCQCXrdxAH7p3EDbzg/Q1MWtR9mcsw4gNrXHtHfqLnd9REcwInd60NfbU3NKcU37Q3vRG5IWNyaY++xaWy33CS2B93M/CPjVVjS7Rx1i1tdNZuLhw7WkFAJJjlSjx6qP5mK7JjsA23ahv9KOIKo3tsMNpQD1gR+dZuUntrHC5enm+p3zuqW7KBb3VshDu5YU6EhadvBg1TL36Nd7xgt25CY8Q8CscESK33NKdevbi2abuLrul7EvsWq1IdSrIXxjn4YxIzS0PsantNeSXlJsmpLtwEgnd+4jd188YiCM105STykwyyrkdVu7zULbu7tXtQQorBaV3SY5zBM+lV7dxWovIdvmVO7VqbDLyQqE7Nw6AzPWvW0/ZBppZLSNWv0gAjwtsgHjoEV57eaPqeldpF6c/bLVctOBSClB2OIKVJS5IkJSqJ5xx0pj1McvTVwyxYJU1cawpaxdWLqGwLZDQS0YAOP68zV2xvU2XaJN/d2wZCyIc7lCwlXn0zzkV1bfZ22ZSpbl8+p5UBbngA56JIxzFYWp9mnvbDNwh50eJKU2i3CkSY3QYT1/wmtcpWdWt7Ve0+lsWKlIvwpa5j2dbalgfBRrj9F1V1nWBcPpVG7c4UmN3+FQn8q1tN7M3GoXbOnN7lXTh8SnLYNllGNy1JIBiMieZA612d99ktujTXxp+oXD9wP1iGX0tBCyOhIQCJ85+tY5Y4+G8enbFPSO0Vjq6y0z3qHACva4kZ+BFN7TkosENFd00pxRO5pYQMDKVEjj4VzCbO4atnLlVpdIZSP1j6k7dg6mJ3EdTEiuga7PMXBT7S4++ykDuUpu3CD1Jwcf6Uskrm5C4bS3eqJfbLmGxKxM4wZHPzqBqyLYeU2l1S0rMQgH7qeYxNehu6VaL0s2Btwq2UnbtTMfH4z18xVBrQbRG7vk+0KVAJdASMJj3QI+cT8q3Oomq4psOP6d+vCXClCtqdp3IMnqTGKaq5Ta25Q20pSVIUrvFqn7vSa6637OW9+zcN6cxqXc98oKVbs7kpIMLSJGc/H0qJGg6VZPsWl+xfLdIPdJvLRaUEYBOEbTEjM4mrzi8K5V1LiVNt29larQ02ncp1gqzHmKdpOoXFo6oWzoYeCv+rQB5cA5rf1PsvsubVVhavuNJbKFhNxBbOI8RVPE4qC07KXKnHlOWKk+Pwd7c7TwP3d09eac5RtMdo1r0c29y1fOXSwUB632hQ9Z6HMe7XO2tugXbz50x11ltzIebJn+0pMeLrNbtpoLib5Bunw5bhM90kzKpETgY5+M10lmlNvaqG1LYB+6AAE1zuUnpl5ki/NnesN2rrCVpG9CkSClX9flWve69qV/pS0o1BboaCt7blvvUuZKZkfSlrNrpqiq60/VLVDKAoBrvg2ps9QmQZBjH4EjjNuLRN3vFsxdPXLwhK23FKbOICt4Vt/Gt7l8rGU44q6SpTpS2tBSRCUt8rAmQK1NUeWrS0LSUqS3CoKwoLzA4Gass9jtRVbMuxa27vgC221EEAEKmc59KWrdn9RWHks21y6oAJG0NBKvmM+dXlF0tK1TWLLT2dmqusWzYEhG5MfDmsG+ceullarpa2QQqXE7QfgI8VbD+j6utloMaW4taT4u87rA5wN2PpWhonY8alcM2d8lyyuLgLIab2rUsJHi8Ywkep8wOTTciyOXurZtqwNknu4UoGUsArPlkVssaneuaam3t0MWDEhX+5JWwpXTPi/o11l92C1Bm5aLVi5csuftBbvNlbY+KyiSc10Key+iahZLt0MBp8JM717X2lAxxOM/I+orGXUjUxrzy91R9SRcXBNxctpSlKJz5Z/Mmsy41a61JxFv+qQycuJYdSVqIMz4hBSMeH/lXWs9gLJzVX1Kdd1JbphKW0FlG3iVQc9ZOB6V0V39nlg/dW6W9OC7ZKg66kuI8ahwiNkxOfeHzrNzkamDzux0P9Mp9lsrtTrKRDz5H6qM4CURuPHBwOa0r/s/edmtQtrN9xOmsPhSfaLZW9HdKUlStkwRtITI52lUTXrunWyGhLlm2ysCEJCRiqXbTTWtU7H6hvEO2zS7lhzq24lJUCPpHwNcu7u6dccPDgNV+ymzsLF3VHu0i2WQO9eecYCkKBHMJMkn58157esllISFpdZacG1d6kI7wbevPn19K9Y7I6dbdpuy9xp2qBxdtaXDTjCWnVo7kqYSohJH3RvMAyK6G17GaNpdu85pNhbIvlI2tXF5uuClUfxHj0xXSdTjdU4cvMeH2i7W1cuLu+aU6CIKUPwpDe3oYjdk4ODWvb6Hp1i7bvahqNxZW7DqHgtWmOtPEgymV+7Ofz4r1bRuybLPc3mrIt7nUkjclLLYRbsE87Eef8Rz8Bindr7s2VihtOs6XpS3SfFqDe/cP4QSBTu7uocNe3mnarWOzXaFz283GsvOss7WLdtsNt+IGVbiMdJzmsp9avZxdhSB36Q1cquJSlL6Uc46LQAof2TXeaP2D0zVLJ51vtKu+uVukrfsdiGkKngNgEVzTtzougdqbTTbC+e1PUwru7l8wlkuJ8TYgSAQobcdFqmtzJniZ2R1bsnpaE3l+4oalahxPtRZ2ocTkDbHJKcCc81oK+1RDrT3s+jvOrKj3BDidi0fvK6p+EeldUjsFoWs2/6Rs3LqyF7Dw7hwFIJ8RhJBHx6Vxuq/Zrr1nfPJYbub+2Rlp607lMo/dLale8M5E81nljlfKXCx1lmjTu12j22oO6Wm6YdyC60lfdqGCCaVcVpq+1iNPutK0RWotMWx7ldu820O5MeJG9ZkA7unnSqWJp9BJbG4gK27ROarvslLhUFTmeatFKFISAVA+UUxaQ2QCg+WfOpK4WKyQCuQQfzqQJ2k4GczzT2wUgS1EYNS7iQQEoE4irtJFNTe5RG3jFOA8UQJ5mpdhycmgEKiSkc0SxERAUCmSOKKUJIzMjipO7WVAgDHHpQ7lUyFZH1NXZo0sjaCAfgKZtMYSv4Gpiy7HiUY8qd3DoQPHz61NmlfuirMKJ9absA6HNWW2pA3Kgnp5UwIIJAUMUNIdqjhIMnz60VJAwU8/hUpQTELUZ9KcpsnIBBHNNmkG0KPuzPTzo7c+JNTBuF7Qqj3e4jbPwpskRBRBnZiYoK3bPcT0zU4bVt8KfQ0lJKFZB+XSrs0h7wjgDNHeQBCUz5ipAMcHzkjNENkOe5JIwAKmzSJKTyoA+ppLjKAE5qZCAUyUn+VPIUVRsI+lNrpUCFFI2g4yc08JMAlCjPOKmQhZBgAjjjiiEKCjKve5FLTirLTs5SeOPKhthudsEHBNWkoBO0gifvTRDCx0knjOamziqJbSowERIoBspB8IAPQVaVbgHB3DmKCmQFeFOfM1dnFXhKgRsAz5dadtIyBIHnUgbH7yePOKJQlIwoEn14ps4oY2jKQmcQKK29xmIj1qQpCZTKFT5nml4fupim00jDSduERiOabtAjBz+NTSQdpgRQ27vNRptGHqmvDTLhu3TpWq3zriNwNraKWgZ6r4B9KpudotZgLZ7KXy08gKeQlX0rqCgAmEpjnNEoSRhAHoKu1kZ+nXL19bF240y409aVbe6f2FXxlBIisLVtX7Sfpd2y0rRNlq1tSb19He96evdthQx6k/KurKRukAkgcyaAS3uUskycipyWeHCXep9pNhS+/eMpUIKrXQ3HHAfQysefQ1z57JaM+wTbaVriLgqUpdyLBxt1xRkk+JAH0EV68ClSzJJA4xQIbgQjnPnV26c9fDx5vsspC91ujtInqAbBJ/NFS/oB7esqt+0IMSJsm5/7teubUpQfeMdCJxRQGziM8iKcqcnkQ0BbnhS3rCExMjS1En5wR+FBPY8OL2k9oyQZj2IIB9P2Yr2Da2qClA+Q4poA3TABOcinKpyeWv9krFkJXc6Zq77aT+z9neeSemUpSSRTH7HQXWUoV2avl92PAG9GuElPw8AivVjhWSJ8wBTlKnncTHnUa7n8eMr0nRCfDpnaK2/hTa3YT9Npq/YadpbbrKLew7QlYcLrajbXY2q27dwlMAxivVx4hAgfIU3uTuiQQehmKXR3P44dpu+YAWi31tyDISQFT6eIyPwqlcaIL55b1z2FfdcPK3W7VSlckcuTXpGxSTO1MGooWEkDHp61mRe7Xmo7O6eXFJX2Ju7TyU3boT/4TlMc7P2AdCB2Wv2XAPC+3bEL/APmBX5mvTdo6rI+ooFBMLTBnmrpO7XlrnZZ5xaVCx7ThAPuIct/F8yrd+NXmey1qGilzshqLwTn/AHl5te75F6vQikpMBXHWaaGwnjw5n0ppO5/Hnw7Maek7T2Cgcbu5tT0/7So3Oy9iBtT2NugmcoT3SUf4Q7FeiBsHMSR125qDUNQsNJZLup3FvaoOE94YKj5AdflV1flZ1b9OMt9Nb09lTdr2SeZQpMFLbLHiHr481X1mysbrRSzqek6laWLPjUG2i2kJjqUmuiHaZbjanrbQNQdt4CkqPdNrcT5hC1gjjrB9Kg1HVLPUrH2e57N3uoIMK9ndt24mefGsJ6+dTU37b5ZX4eKNW2mK7Xae/prD9vpL7qUJU68pKkqyDC+h/hk9eOnZWuv2eoPavp/6O1bUre5S33NslJ7wjKF5/wCrRuCT4j1rtXmDfaCvR06HY2FgtJCWy7+yzMpS2mAoK8Ug81zydL7RovdF1N9afbmCdPuTbsJDqmDjvCSpQVkBfAjecVrnjVmOX05nR+yGuvWF4q3fW3fF9bT7T76VIaI43HaVbtuzjmmP/Z4+1rYsLu+Ut51o3SHHLchKlJO1YI5gSg89a7pns+8O0epO3N1qLtndIbeS4i7UxLoGxe8NlM4CD8qk1Ts5ZXl7p7qLVm4Qy6oPi5Jd3tKQZA3zJnb9Kz3cYs6WVcxoVs9pWk6hpYbt7hdncrQO7cDQKFoSsEbjM+IiJ6VgaTpduLnT7O7ablPtiVIcUhZw42RuIwT616NZ9mdMsdWu7liysw2+lsJYFsgBtSZBI+Ij6VFb9ngz2jTqaXk7UqfLbIQP+sS2Pw2H61J1cWp0q8tb0Nhz2dTLjbffi4dO4hSFIQ6kISUkxEHpWrZac4stoUISV923bWpVsdOAk7D1wef5V27vZBDunqtRcoLadM/RzW9sK2q4K/jx9Oan1vsxYXvZ2+smLS0NwpgpaUtpMBzbCVT0q92VL0qdp/YW3XauL1K7cauXU4bs3QlDR6Knlas9fD6Yk1NP7LO3OrPM6hcWzlhbObVqQNpusTsKSMJ/eiZiPOrrGi6c0hQHZHTSo8whpO4TOQEVlXfZi3e1hm+RodgLYLbC7RLbasBL+4xATkuNGP4fSufLdvl04YyenoVybe8tXLW4W29bupU2tpSvCUkQQa8u1jS1dn9TTae0d/ZvYtnircvz7tf8Q6HqB58zaXo3sbyTddkEX6g1sWTbWKZWFe+PHjFaA7Mp1K+uLhjR2uzqkobQzLDKp9/eCGlTtO4feHFMdYfJnjznhhWCr/T7966tdQcZW+AggtNqASBwJBjz/oV1/Zter63pziru8cfsXlYe7oIU4mBKUbR7p6q9cedZ3+x+qoG5rWLNJPINiqJ9IcnzpujaG5pft1tqjV8+nvv1Dli48033ZaTgJDmIM4q5WZTwx08c8b5dez2f0+31H9JWlsLS5cnvS34e/HksdfQ9Ix1rP1xF/oLb2qaYgOsuK3XdspBVt83kBP3o95PUCeQd2U4nS0ju0tdpg4tEAm4vD65O+m6QtxLtsVaVce3ItW213r7GVK2Qvxqz0E+dc/Tv7Zmr9r9Ru7m2TdLct7NbXesuWiXUNvAid5XM+HyB6yelNtC9qGoKtNMSh+8fO9bq1FYbTx3jiuT6DrwODHWvWRurS3ZQEMBtpxru0p8ISpsoiBwAdp+VYz/ZlDWqq1Rti3vHDavtqaUvYHHN4U1P/wBY3c5rWOc9OWXTtvtpN6LpnZ4NMMWov9XvP+P4u+Un3nlj7iUz0joBmK3NC0S00O1NvZoA71wuuuJABdWeTjA+HAAxXHOWd4y7bvWSbrTXnWwLhFu4Fpw+gASd33FuHGc1pJ9vUGwvUdThVwtlZLqQEtjfDnudYH+KsZbs9us1GzrOivXFyjVdNUhnVmEFAUtPguG5ktL9JyD0PpIPEXeq6vetrYN/dIl0M3NsEttLb/eGBuSeMg8HHM1p3Oq31nc2SHG9XuUPMOLWlq6AWhaSgASpaBEKPrx61zo1xu7ul3YdcfurobW2O9KzsTJSmVK94bvFnBNbxl15cOrl9NFpCGbdDLSAltCe7SkCAEgcRWGt56xaurbTkrU0j73vJZnkNpGVxzt+QPlbfunHGnWrjSbnu1CCAUOBaevCvw69Jqxb3DLjMsNkITwC2WwPkQPyiukunlm2yeznZ9nTVIttL0jvUNbW3HrZtaSoDlYETxNRad2Zb1fUl3WnuO2eirCRKEhAdjH6hOYQqcrPP3f3qzdPNu7rZYu7J/ULZAE29rC5XEnv90CMphM56iu4T2jQDtXpeoN46tJOPkqsZXLH09mExy8053sz2dtLVL93p1ghq1Tv755tJ7sDxFRUfUTM1T/Q+lajaB1/S0NNvlJSy5uSpSADs3pPHJVt6GJ8Sah1btPp9xfM2ty7dssNJNw9bexOFbpHubsYQDmOp29AZr6t21sbdxti1Q8/evqIQhxpbSBGVKUVJ4448wK5zlr+utuOmXqumOaA0HEB67sE5KleN1gfxdVJGfFyIzOTUF0X7a2VcOWzyGWxuK0tk/kM9OPOrCu1l7ZWql31q1dISZ3257pZ6bQgzJJwM5wOed7R9Gl/2u4tlWral94zYkgpaJ+8oZTuPknAM9TNb5XGbrhOlhnfDBtNMvXLTvL3VNLsnkJ3vW6kKUq348CoXkjj41UKXmVNjUe53BTZKEpUO5WoS2Fk87h/hV4eYr0XAPOeuf69K4/Xe1SXby90i305m8ZZJZfL7xSFq2g7RAP7w8R4PSs453K+m+p0cMIxVXVwtxa0WIVbNq27lFQdVGDtRt4HTOelTr2rSym3R7Qu6WAy2nl5ZGP8yroBJ4rK068WyPY7p5Tz7KUkud0UyCkdfvfhWno17c2T2pq0uxN0tNt3iy0Al1r/AN02vkb/ACExk+Vdb4eTCS+HUjsSW9NbLjrj999/bcFlkdTtASeOmM9YrKuOymrsu3DzBQtKG9ybdx8Ol0/uoUG0bMee6d3Tmo9Ks9VcUq//AEahHfhKFsKfdtdq0uEB1CQSUBSckTkx1mbdz+k9KfC0q7nT7haWrhab164W0CofrEb/AHOqTBxIUR4a5b1dbezhjZ6Sab2XTf2PtLl++O9TDTbLYaLWPvBaSd4Vu5gfw1LYW1poOoXFuy1qGpXvdtqeeLaSUoztTgISOvuj49KT3Zq+Ny6th3R0tOrUUhyzdWoAnknvxuV6xmqFyxrfZbvL7vrF60uEbHVMW6mhbOfdd2qWsR0Jx9ycCRrlvxtLhMZvTprHUW9QtW7pgKU05lBUkpPruB4gyI6GsbV9G0JqyLa7ljQHLq5K03bSktrW4qdw3K/eG4fD0rAtHzpt27fMNLeddCt6A5s7zcrduPSfWMSR1qF1251FZuNSUHHFSO73fqm0qOUJHwwT1irI49xuaJ7H2ffbbt+0T71o+UoU3qm7xHACm3CBM+WQZrZ1S/unL1nTNIdZReKJLrjrSnW2EgTECAVTGCoRPwFc/oGt3NnYDRby4Ui3S0vutQK+8daz4UFCkq3ETA9E59eo0Zdo1pTVpY3vtbTKQESod4E/dBgfy6VnL2642Vi9p9W1Tsv2fVqLl4i8UFBtKBahKNypgFW/A6T6+dcJqPb3XO0KLizRdI0ptxpYNshkFQEER3hneOp2gc1F2m1PtnqmtOaa6y+h0OKSLGxeiUkiPcOU+rkDyjityz+z200WwttT7Yaoym3ZcQtxltoIb3zAClgSfXAHyrrjJj7S7vpl9jO0uoaRaLRaWNvdtvIYeWHXVNlP6lCcHarHg610Nz9pyUWiizoVw47vLZK7hsNAhUK3KBJA+VcO9rF9bvOadopCrdb7oQ9aIU4pSWnVJCEBIMJKC3msx/TtRbvGi7Zami7uFHu3329q3YEkFa8QAOFdBW+GOV3WZllPT0W8+0q0vdHv7G7t7ixuX2u6aVbuBwyvwyCdsbefhXGns8tGjN6taP2GqMLV7OlAK27la5y2lpc7jmfCetaHY7s9adoLXULFdnaXN0+pK3rwN7vYm9uNi8FS1ZgDwjk+R79rS+yv2caU1cOJWV7+6bedBuHSpWSEjoMEnaKzvHDxGtXLzXL9lvsy1VvvHL+7c0i0fbCXbS0el11IMgLVwkf2fPmtztVpmjaFoFjo9g1a2b7l9bOMWyI7x3a6ncqOTiZNcx2y7eX2o6jbudnNT1Bq1Lag8wWu5hQ6hSk5kEjnkDisDS70al2l0ou3T17c261OOLfcLziQlCzG4+R4E0ky3ulsniOk0HXex2mt9/qerXjt22+7DIcfU2ygrXtSEpxCQc85PrXoWk9q9F19zu9M1K3uXdgcKEnxJTjJTzGa82037LNevOzlveN32lqVcspeS0ttwbtw3QVcA9OKwrO9v+xerm6vO+0+9LSmhbvMFCCJBgHO6CB4hUywxz9LMrj7eldpvsx0jtHdP3feO2V8/BW42QpK+kqSfzEUq5+x+1nV1WikvaCy++I7tbNztQtUcwek+vWlWePUW5YV7QErSZ3Gg53ixIKsc1agT7vlzTCkKgiacnl4K2xQ6AeYpygIAyanCEpz5/nTgyeY5q8jgqAeKZAmnKnkED1HFWO6zkA0lISZKk81NnCq/i96RHrSSVBEQDUxbSMR8jTu7G2AKbONV1pO0SSfhR7kbCZnFTBBUecHmkEbRGeabJigI8chM/zpuzcT+r9ashsAe9+FFTZifFmnI4q6EkKnbmnEZygfjUndiRukUdqdsices02cUCgpSSAE/GKKEkqggACpi3PE0e5IMyY5ps4q21SVcGPSklCt0QEz1PnVra5tyf503YVDJgikyTii2KHyo7FnIKkn4cVL3YVkHjypBqFT+E02vFEtJ3QSTS2lTZCVAVL3I5VPpTwgJCts/SmziqhJHLtAZ+9k9astthK95CT8qASmcpB86bOCtAKfDAqQoWESkiRnbU3djbCUmT5US3uSfF4hTksxQFC1JkkJB/Ch3ZUvCgR61N3ZKI3TRFuCgGOekzTkcFfujwSkUu7gSkCrCWRthRBjzp3dojy68ZFTknBUKPETtSIpwBPKUp9Qan2I3yIPnjmiW0qmUAAcSauzgp92Ur92QT0p+SAQ2QUjyqz3Y+6Uxxilt3KwRAzTZxVDJIhBk+dGFf8ADH5VZUyTO6II6UO6xIOUjzq7OKulOCIKVeVIoXsJKAr4CnuvtWje+5ebabUtLe5SolSiEpHxJMVYS0jE81N1JiqpQoyYweajcAKdpCSSemKvbU+7u4pigjbBJMelNrcFYJUlQBTIHFBSFTBBE8etWu78PX6UtpPJPzxV2nBWCCGvAMfhShOxILfxNWglMyTKvXmnKbVyNsHrmptZip7UHAR7vNFSUpGEx0qyQIgkg/CkG/FE4PJIps4oUgKRiAfrTdo2yQc8xVlDaQogKP5UlISmApaoJ6Cmzi57XU66zaBWhW9m+8mSpNysgk9AkcH5kVgM/wD2kOKl+z0pO37uASfPDh/OvQSkEYOD1pq0tqSUqmJwDWpmvFj6aL1ywZXqbDDN2qe8bZcK0JyYyfl9etYetal2oavls6VoZXbIAHtSu7eWsyeG+8T9Zrsu7bK8TmltQkx8+Kc2eLzpy410oBu0dokncSe6aaTGeIb/AOfrVR8tXlyr2hntStaUySkXSB/9BAr00hJEgcdDTC3x4RFTd9t708x/RKbgEDR+0r6Unh69fCZ+C3hVyx026sH1uWfZB63Wr3nUqt0rPz3zXoISngp55PWkUNjBMzT37OdcWu4u2VBT+jakgCTuDPecf9monp5Uv0hZhkPPOm2T/wD3DTjR+e5M12gBJCc4OCfOploSBA3f51m44t93J5+3rOlurKRqTPgxuUlwfiQPzq8wuxfQHG9TQpP7yUHb/wA67GEmQdyp6Vn6h2d0bWFoVqOj2l4UElBeZSqJ5jGOn0qdvFqda/LGUzbAjdeJ+AaM0e4tN3/SnVR+61V9zsV2aWpKjpTIKeNm5H5EUv8AYjs+rnTUqT5d65H03VntxrvfxSTb2QEKuLiOI2CnhvTArxLuM81Y/wBhOyadxT2f09JX736rKvjQc7A9mVMqba0pm1BnNtLJE+RSRTtT7O9/FdI0hYAS4+mTk+VWU6TZrIKHHIPkQRVNHYQW3/RO0OpJQMBq4Db6QPiUb/qqnDsjqSFbka+gef8AuYn/AL1Yy6d+K6TrT5Xf0LbKyXHDu+GajXoSVZ9pVt/iRUJ7N6klsga+AYgbrX/JdN/QvaFLknV7B5qPdXaOJWR/aD38qz2svte9inVoykEEOpWJk7jFRPW6rZAX7KlaU/urrPutL7Vh9Yas9HfbnwrXeuoJ+XdH86hNn2vSrOlaQoHp+klz+LNa7OR3cV5b1ncsltDdxar47xlQJHw3T+VRM2dsmErvb92MytDQ/JIot2mvBILui2+773d3YP8A+0UnU6k0mT2cvXFSI7h9hc/4lppwy9L3MRVp1mshXtWoo/sqQkD8Kqq0fvkhLGsaxbzyUhpc/wCJBqdi51KSf0Dq1sEx4loacn/5biqba9rBeL7qzfceuR71qsIaeSJiSl0p8jU1liS40630J63ut7+p6rfo/wCG8Gkg+vhbSfxpKsbh9LyCy9blRIbead3qA8/EiJ9DNW27jX3xIsbxKTwVOsxHyWaclrXNg/3U+XivAI/CpblfK+HLX2k65bKBTqF7cKUYg2zAIxycD8Pwqg9Z6k34nrPUL10SClsd2mPhviPnXalnVoldgyqB1u5+nhq1b6e84j/eEoYUY8KVbwfnirz0zentwDh1NCAn/Z/VdnRQU2uPl3tWU6a6nap1N02lExNtxz5KNd5+iQ7BVcKIP7qBirDdjahvYptDnqtINO99Mz8eX286bTpUpS9qZbJHh71BZkf3qvWegWeoS5a6mm5R17nar4Zmu7Fpag/9GZ2jpsqneaUwq3Uq1aUHwBtSm7dYSr4lM/lU7u17MjzbU9GtNM1fVbVD60OGzaeaKbjuSpwl0FUJUmfdTn0FW7jSGE6g2bS/v1WibZxSyjVHlQ8FI2Dd3kzHeY4r0SySvCb6xYUEJgKDwf8A+8hJqC9Z0S7tFBnSGLy5bUkezJtmkugExu2u7cevWMTW51GuGnmvtLGltW7ymVEIsC44ltPiWpS0StUx1MqUT5msltVxeXnt10ol/aoIb8O1tJUPCIEnhOfjXpTi9NbtnWLjTGrVpxJS4Liy7hCh1BJTtiucv+w925d+0aKoGzc8S0OvFSQrPuHaTB9TW8c5fbj1cMrPDln7m9YvbFFr7Sy+FlTVyy2l0IUEqHuqwox5/GZ56FrXL5LXer1nVoKQf1lhakZ6naj8OamtuzOpW+oMl9hospdla+8kR8MHy6VZu9Iv37FLBtrTcy0lqe/BSpWM8emJq5ZzWl6WFxipddodVt7Vtbd9dLW5+z7yzaaBkTzmMelc5aW7lsFqddCytS3VqSiIUpSlGP4c1c7X3O9q30dWm3Cbi2Qh1xxlxIVBSUjaQcztIgxg1kNpKLNaz3ts64RuLh3uqzGCN0znbAPPB4O8Z4cerbldNiy0261e7Va2pUhLSZuHgNwZxwB95R6D5nET2+j29na6aGNNRsQyfHv95SjySes5z9MVn6Trjmm6chhjsq7bhBVCWbhoj3jBO5QO4jJJ6zTb7tg5pqWS/pD7KXnNgHeteGQcmDxxJ9a4ZzLLxHfDGYzbafcSoQklPQ00qDrRbcSFIX4VNqylQ6g/HyrDV2lfdMo0S4jkp75qR+NK/wC01vZdw37MpbzwKtu4JgJiTJ9SK5TpZbb5Rq2Nw7pb6LG4WV2jh22r5mUH/hLPy8KvkcgFW0pBVM+4cHdxHrXmjvazUrrR1MvaVbuXD+9DjanS2hsRjzMg/lODir112rvNQtE6TbMrtLlxqXrzvdwYaAhSpgHeeBIjk9IrpellamPVx0zdUvLGx1ten6bZ3j7aFOJDSkBoNLQQCkFZEpz8vhVdy+UlACrFSZ3bgq6t8RP8cx8Kop7Saa5cfo56xNtpaHB7LfBQU4hwSe9VMjMEknPM8mOpSt16zcSG2bK9twFXCWHH9js5C22m1JkKHr5joa7X9Y4cJkx1XjltcWourbube8BDLweStClD7sg4PlT7xi3u7R1m6T+oUB3qd0e6dwyM9KuoVd3lq9p+oaNf3ds+NjhLKQIBPiT3lwpQg5BGayS1qWmui2vLVSkB3Za3C0pcS/4vBnAS7ERvgbs54pNM8NXwmRq7HZKxZYtGEM3K0qWplDfDQkK3KBmf/eZO7j3ST1nZ8aalr9IPNrure2bE6he33eFsBBmW1q8B5yn3gZnNZ992edbsGdT1TTLG8voQgss2DKnBE43LUAYA6flWPcaLfPJZf1G1tFWTLqS5a2iQHvZ0kq2ghIBO/OMxIBzUsmXl6MZZPLNVqNzqvaW41Ts1dHTFXd8lpD7yBuDTraEd5tUMJU40mOvwroLP7MLu91Rx7tRrK9YQGiluSpCt5zlM+6PLgzkU/tZpto47pup2KkN6TfWw04uW8BLImbdxHlCpE+oro7DtdYtdmWb/AFy8t7B5ClW74cVt/WpOdo5MxuHoRVzyys/VZJ8gdL0/ROzyLZq9T2eH7V15pTaVqc2+IkqEH6DivOe2mut3en2WlNKPaZxgl4ailzugNxICIbIBO3BJ/wCWx2n1bsb2uvtPevO0rti3asu+Btvu1kkoPK0444iTUb/Z/sqnQk32ksHtBasHu7t9Vyt5xtMe8G/dJ84AMcTV6c1OV9sZ+fTjuzmn3V9qztxeWmoO2CnNhFitJTII8O9ZBAGZKeT5RXoWrp0a10HQnNHt022movDbut7FJW33jSkjvByFbtoznxetPt71hNs37BbsqtikBqPcjpt29IrM1rThqzN2lpx2yeu0pClNqOxxScoUU8T4R4sGBXS3dcpnrw7XslqKldiLYNtqfurFg27jI94uNjbtE8TAj0NeZax207S9qCmxLHgJg2NrYl0k+S+8SYjjG3mal0rtE/ok6o82LqyuFJZvmkulotujwodwYE+4rjKfSvU7TXNOt+zqtSXNlZNglalGQjPpXP8AxfDt/qaeZ6D9lup3ynH723c0JpLfhbaWjvnVDgHlKR+ORSrb7S/ak2Lm2s+y91ZXTrgWt15xClpSRACQMZ5Mz0pVd51j9Y9n2AJ2iPKmFs7cniptk8mkUwIB+tcdnFF3YIApFMGeT9KmSn4ZolI4pteKtEZ86IQCJqUokYopTAIps4oAjxYSKO2BlM1KpB6E5pbCRkips4oiiFzJzSKB1nmplNkQZpAeQps4oNkCATHoKbtE4nFWZJ5xQKfL8qu04oAgKPAp3dhCYCBA6CpNk9KcWhER+NNrxQlB3TxNEJEQQTUoSOgpER05ptOKHbJnOKRmcJxU6U+f/KgpJAJBNNnFEAngIpKHpE+lS7ARORSKZEATPWm14oQFJJiKWYwMCp9gIkGYpbQZ/wCVNpxQASrgCiQSYAx8KlCdvA/GkUknKQabOKPxJHhSQT1pBBMyKk2kcACaXormmzSEt8gwOtHaMxzU2yAYHNLbTa8UBRiTk+ZpJT8c+dTbMEAnNIIjjpTZcVcoGCPrR2GR8an7vIz86RRmJwKbTih7siMmh3R6ceVT7P3Z+dLaYyabqcVcNnmTnmls3KTxzU8q4ORRKf3Y+FNnFxv2g3DdvoemrcAUgatZSP8A/ckzXWBJBPuivNvtkaVfsdntJQ+q3NxfA70mFAn9WmPm4T8q9G026Go6VaXyCdt00l3KY5E10t/WEh/dlRPE03uzPx6VY2SMCIod3Azn0rGzigCSIBJV6ChtIGM/GrO0RBms7XtSVougXupotXLw2jRdLLZG9YHMVZdnFY2+YFEgTI3CuK0v7Tre5dWzf6He2i0JSoqYWh9BB6jKVEYP3a00/aJ2ZJIU/ftKHRem3A/HZVssNOj2p3boIFDb13CsBH2gdl3jtF9dA/x2Fwn826jX9o3Zdte03N6oj93TblQ+obqeaXF0ndgqyr8KC0Hd4T0gVzKvtI0Mibe01e5PRIsi1P8A8wpqjd/aI6UIVZaJ3W45cvrpKAkeYCN0/UfGrJkvF2pble7IJ4NNLcnco8/OvOtG7TdpNe7X6a3aag1cWXfKF43Z249nba2mQpZ3HfO0DxDJ4NenFGBJMxTLwmlfu5GJ+lNUgpxgn0q0ECDyJpihJ4wKnJOKFU8BFM2490TVlKfDTQjPxpyOKIBM+JA9KbtaJkpmKsbYxAMUtuIB205HBBsESkfCpdpkFQxFSJbMiennQKN3J+EUtOJm0bSDIUKaEpCsyPSpggJHVR6UA2d+TM9DTZpCoeEDcT8aG3qkc8mrBTCvu0ik/eSfjTkcVYpO0kok06VwAU/KKmCUzwr0p20EyJps4K8E9QaEbUk5zVlScYSZFNCTkFJAps4oYzlIpFIxIMeQFT7UpTg7vOkE4ps4oNqRy2M+fWltTylIBqUjxRAxRLe4YMVNnFFtSTlAx1ogDblNSd3tOc0RMVNnFEUJHugfKqt5ptjqLRavrFi4b/ddbCx+NXx4lRG2hsmQTIq7XTnT2J7Oto2sacm1Rx/urrjH/cUKj/2H0wIIRc6u2AOmr3f/APLXTd3IwPp0rF7W9p7Tsfof6Uvre4fZS6loi3SDtJ6kkgAfE8wOtWW/C+kY7NFCUhnVtRaSMAF3f081gmmuaLqqDvtNZKiPu3TKFo5/hCD+NcO/9tL5QfZezpS6qEI9ofJEzJ3lIMDbAHr9a0uwv2lXGs3b1l2gt2LN9S1KZdbEM7f3SSrnyOJ8sVb0/G6kzrpH2dfaSotWem3M8brhbMifLaqqq9Q1+3Z3vdmEPqn3bHUEOGPP9Ylv6V1QKyQkmAfWiUFXiCCY/Cuesfpvnk4tPbC2SSm/03V9NWPuvWDjgP8AeaC0/jVhPazs+H0NL1a2bW57iXld0o/JcfSujuLyxtXe7uL23ZdPDRdHeH4JGayry/1PUmu60Zlq2ZO9LtzqTK+QY8DMgqHOSQOImpenhXSdTNZSkPBC0FJQrggkg/CKSmEF5tZbQVNmUEjcU/CeP9aytH7LWWjWKrdp67eK3VvKcUsoTuUZO1AwkTOB+eak14sad2Y1S4dQ842m1clCHSFqlMBKT0JJGa5TDeWo7XLU3V+FqJcttQuGi4rcCh7ek/3VSmPQUbZrbdLXdWtnuIlNwy33Lk/uqjnzmfPFcB9mGqO6mjUbS87q4eYKH/aQhLal7itCpSmAILQ4jn5n0RSglBW4doSJJPA/0q9THLpZcazhljnjyii65fPa24uyubK7sWkhu4tB4X2F8ghU5BkeFUec0WvYdQDgS0lamyULQtqFpP8AEk5H8+k4NQaf/wCutetb+ytm12dlvR7f3sd9uR7je3325UCVcbk4BIkO7TurZ1PSm7NKHL1anFL8JUU24T4sg4G/uwPX4Glx2u9OG7SOsX/aBNq7prLKW7lphD6DC3WzdsIUAUncPC6tJHrisLWdKaPZ7v12veKaYQvdJMOFLZKsn1V9a9LcdW8Ah9QOQoAp8jIPyIH0FVbnS9Pu7B61dSlDK07VBnwqiehHHFdJ1dTTnenu7cUrRrEdqLNlFowULtXiUJQNpIcajHpJqTTtJs7m50Gydtkpt7u82PhCNnfI7yCklOYINdI9oFhbpXdOanetd0iVuKuyAhOJknpj8KxO0VnojPZ1tCdadZLqd1k+h5ThSZHjTszHEwetdMct3aXUnlYeX9nGm6hf2d9+mLg29wUA2t1eONttiNolK4PXiTzNcpqDmhntFcOaEtwWj6AWk3DqlvN7QkOJUHPGkyZg4ggg8xQsXHUWiAWkMoT+yQkkQPh084qZtdxePli1kuJwtZI8OOPUx9OT69rZp4t8vCUKuLi4FrZthTxG47sttI/eV5+gBz8ATW7b6RbMWjlu6gOh/wD6QpwT3p8z6enFV7BZsEvMeyr2AgqlScmOuZUrnP8AZAHMaSXFuoS4VDPiOw7h8q8vU6lniOuOExU09m9FdVnS7VSle8C0M/hWh7KrTrFl/T7UOLtm9rbMmXGuqAZ+ecYqNTrragSVR+9xNPbuA2srICSeOn0/GuPO326Rr2101d2iX7dbbrSx4VwfEQYM46RGfKnvNN3bCmX2UuNOAoUlxAKVTjI+dZ67lm2AfUIZddHeONpOCTG74eZ6TV0ALXg7NvhKp4mseZdx0Yz9mrSLpN26/dXdiwjY0lxSnl2fnA95QM8mSPhxM9rOk2y7dt7UrZHfAKQlTyRvSeCB5f61Neaxp+n3C2ry+bZeaRuUgr8fGYHWRwkVyqWbZ527cYtbi1s7kkqt3mu7KV8KiPumZ55Jr1dO8vNYy6kxjdVbNG2vtOcj9Eame63AEC3uV8bT+6pUccL/ALWOOZ0+47SM2aVXLdrc3Dqrd4PMd4EXTadpIIIKCpKI9dorathqzWjHRheNt6a2O7aHchbhRghC5xA4wJ4zUT/smotMPWAFu7qyS27tJV7PfsQpCjImVhO7POyetd8br0xzxyYeodiddsdaTZXtxYoQsSw4vchu5VncN0Hu1gefy61d7M9oHux1893ul2jyLgjvXrZ8rcfTmNhJ2mJiAB1rs7ztNo+udjWf0xZPvG4SgvWzDRUplY95Q/skH19K5650HsvrjD7517V9FetUoJXfvAIIMhtUKxHhUIBBHlVmfKasNSXxUf8AtJoJ1Jlel293aN3ipdtFMkIZc/eSoeEAx4hPOfOuj0JhrtCtxVu+O6bJDrhH3vKD1ri7bQdXsbYXemsnVrZJKHHrC479D4AI2qQsgoM5xPUVd0zVdfSrvdOsdU0+/WsJ7t6ydU05xheIAyMyCI5imU+mZPP7L2paExoGt6hpQDlxp99Yru+7dzCtx3j8Un5mtHV+zPaHULG1stC9mY0l+3l1h18hSlL5nwEkbcc5mh2gXcXfavQ1XFqbd+50y4DjKiD3aiW5B6c1rWd1evfY/aP2q9t0rTWzvKwg7do3+I8GN0GeYrNtkldtSuWb7IdmdD1FDHarW1XD6k98bOyYcDe3dA3KQComQcSJjjzVQ6cmwQwu6smkMpuocUQI3460qtrz9yfT6DJxwaBz0p+QcAYohRzivM9OjW0nqBRVHzotkcgc05QEChpFBBgijjyFO+JoROaLooA6c03aJnFPoTImI6VNgYNLaAKKhFGINNmjNoSetBXoI86eIGDmlg8U2mjUgzk4o8CjI8sUfWm10Z94DbM0u7g4JNPGQelIeops0W2hFOSBu+NA+9xMU2EEzAihGI4FOBxg0lHz603TRoSTMRS2BPNLFHHlTZoNqfM0oHl+NHEYMRTeT8KbNDA6UtoJnM0oNIDzBNNmhIOJimx+FPwBzQMTAoaCD60CCD7tOyMikCfM0NG58oo7SRAFJSglO5UbRkmiDKZBEenWmzRm09aW0RTxMZpH86uzRm0CgUick5qQbScmM0hBO0H51ZUseddvxbjV9MunUhQa1iwtU7feQqVrMHpO9E/Cu30lk2to5aKk9w+4lM/ulW9P0SoD5Vw/bp1CdC7OvqJJv+0lq6iMAy4Sj/8ATSn6V3e7udaWkhIRcM7wI4UgwfqFJ/wmul/yzJ5WikAyaBA5A5o4CuIFEQeK57a0Z8qUJ4UAoHoeDTjRAB5qbNPMO2X2auvO2112WYFsptpxtVu3euW6JxtKRO2MZEDp5VzOpaVrOj26Hr7SNZZQpwNhaLm2cClkYiVlXTk17H2i1VOg9n7vUu6Q8bdIIbW53aVEqCcmDHPka811vtXfdqdF01T1hZWTXfN3kIulOrI2KAEFA/4g+ld8crfbNjN0jR9a1i17+20nV3Wt6m97txao8STCsBY/DyqleWzjV3esOadfpdsT+sBvykHnjarPBrc0btjeaPpj1hZO6agN3LxBdSpa5Lh5SlQrEcZ1d++vLx24uXlXytyzZaG+tM7icHx+da9jZ1fsTrGi6DdancMWS27ZAUW1X7zi1CQP3PWm9k+yD+t3V06Tpunm0UhtXd2W95aSjdIcKhHJHunina1fdqL3s9fu6nqGunTENKXcJGmssJCBknxNBVQaTpusanq+oW2lpv1FLFsp4WuoJtgCe8AmFAn3Tx5U86Hq2h6Oz2f0hGn2qlrQlS3FKcA3LWolSlGABMnoK0c+XFUtEt7207P6cxqTwfv2rZtFw6FbgtwJAUZ65q/zXC3yvEyPpTVCRxUhGIH/ACppyZqGjNtLHkKfFACqaN25kAUtk9OKfnpS+M+lE0btjmPSgUkAkDinhIpw94VNmkaUiJPIoTmSmaeAZkngU4RwTTa8UUZmIp2SIJ49aJwqFClM5FNmg2nzzRAMQRP4UenAoCZxFNmg2HdO4/OgoCRzT4xJzQnpj8qHECkR0z6Uonj50QM58/Ko+9h4tqbcCQncHY8Bzx8flTZMT9uYimFJB90mafuAkg0sq8REgCpva6NAgcc0tvnNPKhMY+NZ2va0xoNg3cPJRLroZbLjgaQFEE+Nw4QMHJ6wOSK1JbdJqfK8RIgCTQI8MBR+NQ6Zfo1bRbLUmmnGEXjCHw26Nq0BQmFDzqbCMkAD1PFS7l0aiK5urfT7R27u7hu3tmQVOOunahAHma8Q1T7VO0N1Zqa/SGjMt3S1JZUwx3qFCVDaveVSCI6JMxWz9pNjq/aPXEs6brtndaWUoS5ZNKWtSFJVIUtLYUV+IT93pNWtH+z3R7Nja5oKb65caSy/daksJC4Sf1jbKN3J6Ej412wuOE3WMsMsvTyJ9Nxb2rrztq1ZqcVK1WfhQ0onBjAT0A8q6vsr2t7Ntagye0PZluydbKG1PIc3MbvCd5ZJPUc+Ln6Ve2ui9mOzZv7Bu1u39bUUXId/Y2rSSd20I3SUbQpAJ3R54rM1K7sXu0a3tN7pdoX+8bQnFz3O4FQAVO0wVAT6V23yjlxuNes3P2q6FdWjrltqjzDiFbPZm7X/AHpXkRvxt4zxW/a2mn6vYJuFOr1ezu07gq4dLza0+iD4APQJHwrzrQ1dgNW7WKsXNGvdPuXiFWzl1dr23EKTkJCvAowZT/nXqdvbt2NqzbW7QaZZQG20J+6AMCvF1rw8R6+lOQ2dla6fbpYsbW2tGk8NsMpbQPkkCrCpg7TE+prNVq1ulwNtqduFlezawwt2D67QQnjrFN9p1l9QFtpabdB5evXkgpH7wbRuJ+ZTXn8327+I0JPG4SPPisjtVoqdf7N3mmuPusKUkOpU2QTuQrcMHlMiDirzek3joC7/AFl1bQmUWjQtkQTiVEqX6YWOagtr3SLCbfQrJd88swo26ZSSIEuXCsGPVRV6GumE43cYyvKacT9junqcb1LVElKUOhu3baS3x4EuTP8Af49PWuvVa6d3pD1nqHaC4bcH7VKS0hQVykK2M+HmQCcdYq1a6Q03ZG1UWW7dxXeLtrVvumyT0P3lD6T1EYrSgqBHOc1vq9blnyY6fS446VVq1a7QU96xYJyn9V+ucA6QpQCQf7qulCz01iwCy0Frec/aPvOFx5zJPiWcnkwOBOAKuKO1IBUJpmT1A+NcLnXaSGXFs1ct7HUSPjFVDptrtUkIc8X8WR8KvDJAkz5Ud7Z8JKSUwY61mbvpfDyP7RLXWLXVO8dTcudnkNtrSW8tpXJkuwJGYiZTwfhyhfYtHhLStyyYOSEAnPojPiMRJzXY/aBrfaJOrXenOu3FjpRUG2lW7BCH0qQJ3OwR5iBtI+hrjlW7KrwXMEOoSpvCsRzn4Y+tfRwn6vl9a7yG/vEtOpbVvQ2tJ3vIQfoMHJnr+PFC31/Qw000m8tkbQpW0qIAKiCAFecmScmQTmM1Xxdoeldq280XEtobRcqRv3EJTuOyckjE9TM1oWet35tme70VpVu4lAbKdwQd3u/9VxlPNdOM15OnBZ7UWEpUm8sXCSHQHFJASqNv90zn0TAyTWhb6/orbbhs3LSVQn/pCQOQlEzx1PolOaqt625dBDiOzqHEL2lJCkkkKCY+55LR/i+NaidF1t/Tk3yewbrlqtvvg6HLbLe2Z2zPGa53pY118rJ1KzLSYvrUIPQupx+NL26y2Cb22VP/AL0Y+Gf6mqtxpV/Y6U9qN32FuGbVtovOOxbEJQBuJ970qk2xpzz3cr7HrQoc/wC7snIieFfxD61z7EV0DTwQdzbyFAEZ3yOnH9dapq1gNW+o6fd6m3Y7Wj7PerdGArAnxZWk/ht86wNR0jRnLVq5XZafYoFy1bpZQUhxUuJC1LKDiEBZ2yY5ORAuadYtaUzaqt7Fm/tnpQ28y0lTrS0kgJVHvCE+99ea1OjMflNjYX7b9gTpbIuzarKC4nAUc+JCle+fifjUzOqoumrdKGVOXDze5Tf3WswdyjxBx9cUNZumvYgzvubVx7xoSptaCoJgqTIkpHA3cT51DYNMhDT1qsXK3VFS7mUpcjnIAjkCRjrW7I4ZzSYaqUbUP2Nwh1TndHu2itG7pB8jzP1g4p18m0t7C9SxbLf1mWX0lswEhtcoHlmVjiYJq0HVlopEDcCACncnjGPxrL0VxY9rs7xpKLpCwtSkqK0uIPChuPGIg8VJ9sS6MTdsNXvtFu6V2eoOlGSf1NyMKQeo3ASB5g+daCbZpVx3waStyAAsiT5/nVK+btNN1R25vEFzS78Bm9ROELxsexxHEj0PSrRYe0u+RbuPi5triVWz3Csctq8zGQeonyrV8+Y3ZynKJE6g5orqtUtFoZdRlaFk7XgYGxXqfDB5kDB4rodf7Ta2wdOaYZVpdtqDCFC4eSVOh1WSyOiVpGcz1gYrnLhlNxaqZCvER7w5Hkf5/KmXVxqmrKYRq2oO3LFupKmWxAC1J4WvalO4yeOBA+NZn9XDPWIBx5jtdobT13cPIWi4bT7Q8XCmUpXG4+I+796fKq7bmp/7M22li4d9ls3e6Fs33ad/dOKjctWYlI4qLtA8bV7TLxO3daXrZ3GPcVKDP1qxcsou73WdMcKkIVcYUEgwlSUrwDjkmt78Lu3Daa1eavBvQsKRmFJPJ4NKqa/aXNJQ07dCxuEObA44pI3JCoExiFJ6YpVzyx8uPmPozdIwaKVQDIpjf7OnK5HwrzvqaPQQE0iTx50G6XQf11oaEny600c07yoHmlQpg5HNAERzThTVcii6OBJVkelBSjERTvKmH36GiGRBBpyQCIApK/r6UuhoaDOJFE8RQV7x+VI/50B+dEj8KbTjRCjFLxAYPxpDkUF0DvkM0DHUTTRT1DilDZBPuxFLwnrToGKYOaLoYTREfCgaSaIRoigrmiOKA48pim8dKSetI8fOgM45xTQoEdMetVb1ak2F4pKiClhRBB4O3ms3sbcv3fYvTLi5ecfecaBU44oqUrwjknJrUnjaNLVROjXoIJHcOY/umm6GrvOz+mrmd1q0T/gFDXvD2e1EjB9mdyP7JqHsoZ7F6H/8Cz/4aaSbiNTHU4NLcD50jyaA61lopz1xVXU3T7CttqQ4+QwgjmV+GflJPyq2nrWfqOb7TP8At3P/AAV1Yjk/tLZR7L2XbQE7E65akfwwTxXZ3p7tCbgjLC+8kjge6r8CT8q5H7SwDb9m5A//ABu3/nXaq8SXArI2nmt2+Ens70IkUox4RxVfTiVaXZqUSVKt21EnknaM1bgFPArK03YY4JA60ADFeev312P/AEkG7L2p72X9Cb+57w7N28528T616Gn9mmlnE3s1aG3W1tutocbUIKVCQfiK4D7QdJ0ywtNB9h020tD+kiVFhlLZ2+zP+Q8zXoB/zri/tI/YaR/8Wv8A8JVawvlLFv7NFkdiG1BRClXt6TGP/wA07XWDPJP1rkvs1/8AYVn/AOMvP/8AqdrrBVzvlZPDn+3zYV9nHaXHOmXBOOvdqNc59nIKe1OuSMKs7PPwcuP9K6btuSOwfaGCR/6suf8AwlVgdgsdodV/+Et//EdrUv6s2eXeE+L/AEpSKB5odK4tCqmTTzUdA4KH4UwLhveraiD95VPSAVHFeLfb1d3I1DTbAXDos31/rbcLPduQFEbk8GCAc+QreGPL2xllqPZ0uIWkFCgsHgpzNGT5V5P/AOj66472QvkOOKWlN0kgKMgEtJJPzOTXrKhB+VMpqrPJA9OKUmYjih0VQPSsqdkClEjnNNTTxRS5AB6UsUDwfjSVzSgyKWOtNo9DUQdgJkTSVyJGB1qJJPizUiQJ46VVLEROegNLBPqeKvW7TZj9Wn3fKvIPt11rVdG7NBzS9TvLBftO3dbPqaMScSkirpHpeo3tro9iu91G8ZsbdvJdfWGkjPmrrXkn2la1ZWmq2z9o/daq7cIDvs7wbXbWyeELS24kQorQeoJAVCkmK6XsHaW1zoNtfP27T12Ubi+tAU5Mc7jmvP8A7SCT2uuFEndtt0z1iUY/E/U16fxsJnlquXWyuOO3pnZ7VWbTRLZGmp1fW2HR3zd3dutjBPuncQobfLbjzrhPtV7R3OoXrOl3jItrazt/aVNtO96l1xe4JKpSJKQg4yPH1xXSfZuB/sisQITd3Eenjn8yT8681+1gn/bBYkwtbKFfxJ2cHzHpW+hjO/cWer/+Ur0f7OtYvNW7Jr0y5urhlWmOhptTbpS4WigFIUecHcPgK6JzQtMuSBe2v6QhQV/vririD5gLJzXG/ZGB+iNXVA3e37J67Q23A+Ak49TXoLOUq+NeH8nK49SyPT0J+kJKA02EISENpEAAQKp6vq1loemvahqL6bW0Z/aLIJGTjjPpxWoyhJW34RnnHNef/bE64xouioacU2l+8Qh0JMBxP63CvMYGD5CsY48r5dM8uM8OF1Xtnpl72iVqb/ZK01WyWtSlvP7VubPCEKlRISOu048XQ1Rudestbt0aDbNN2WlN3KLy3unLVTz7DKs9ylCB0cKhgxt9BXLXv6ntKwlvwJeDocCcBcExPn860ftJuX7TtUz7M84x/uYH6tRTjJjHxP1r6WpPDw7teraX9nOg67YtXdprt9f2+UkPJZdTuHIKS2IIxj0Fdh2f7NHRr1957XtS1Z9xKWlC+eSoN56AAQT/ACrzTWnndN/9GqwubFxdo+8ppTjjKihSyVCSSMknrXly767V2ZTfKunjdvuKLr5cPeOEKTG5XJjpNeazlPLvLx9Pra7vW7dAJRcXCiJSlpE//UYSD8VCqRf1F4xDFomeEfrl/UwB9FfGvMPstv7tdrYMLun1Nez3CthcJTIuCAY9BivUf+rbPWK8uf6+nfD9puqidKYdg3q3dRWCDuvFbxIjOwQgcdEitAAGEngcA0P3f7NMWohkKBM+dcLa6SROQYJCPpRCSMgGTXLajcvpu9qX3APIKNV1XDwVh5wf3jWtK7DalPIk1DcvJtrZx4xubSVBJPJiubQ4teFrUoT1M0FftPp/KtSeWdsF+57Y3unpjUmGXdjK0m3timFB8bt3izhMn0URUTnZvVF3a1L1e52KCg2trYyWwlUNAFIn3XHfmfSukQSH+T75H4VZmNvwrvz16cteXIvdk1P2WpW95cXV0y+VvMte0qALu9xSSYjzRz1ArnL/ALDKSnVHGGLouFLybdKXZ3Tao/NzcPkB0r09OULByM/nUaz4keq81cetlDLp41xTvYyzskuXq1P/AKp5BQlTxzLrcfERiKbZWTZ7DaQ4lACy3ZAmcHxt1v8AaM/+orj/ALVj/wAdusGzx2C0aMfqrE/Pe1W5lcp5ZmMxvhz2l3NiiwZDt7btuwx4FuokfqrXMf3V/wCE17FpPars5/sVaWqddsO9TYBsoD6Z3d1G34zXA6J/7L6UevszX/g1rJJhwSYCVAfDNdNSs2N7tL2n0G9+yzVra21vTnrlzSnEBhF0guFXdcBMzNcQ8tVi/dXy2nFIQl52GxKlDa1ATHU7TFXNUJ/2EukyYVp6wR5juqzO2brjHZe5U04ptRdQklJgwXWwR8wSPgasnwzv2zNAbWxodmy/bpaWhsIKUweMAz68/OrDd3b3TihZX4adSoqcVbbFGT4cghXy8orH7VOLa7OrLa1IO9KfCYx4cfifrQ1xRtLRItyWA3YP7e78O2EpiI4irp4tt+ztSw68/cXj92++fE88lO8J6JxGOfxpt8/7G0lxm0L25f6wpnB8ztkn6fHis3sq+6/2ftFuurcUpJJKlEkwBFSaX+w1kdO/drPus73RumdSW0t3TrtJ9qKVbX8hkddsfkRRu3VWzi3jZPuqtmpC2wJVu94IEifdk03s7i1vEjCQ8IHT3G60rkbWFKGD5itTysULDVG9Ttl77Z5lCvC4i4aKZH9fGorN3v8ARLrTmLht250tSX7NQUDKB7qJ843I+FcQi5fvO3zVndPOXFsXQCy6oqQePunFeq63a29l2w7Ot2rDdu3+j1ja0gIEd4nED4n61qzTv08fcPs9L1HUbRFxZWCTbuoDjLy3kIDiSJBGZj4gVMjsh2heehxOmWqON3fOPK5/dCUj8a1Ps+H/ANw7VP3W7m5QkdEpDzgAHkBXUH3W/jXmyzuNunbDoYWPLO23ZO/07sXeXFzftXjhdYbShi2KEpPeAdVKJzWpYabY6j2ueTqNkl9u9sm7i3cMgb0FQWJB5hSK6ftH/wCzl0On6r/vpNVdTAa1rs+GwED25SPDjw9y7j4YGPStTPeO3TtzG6iVrsl2dtlpWzoWnpcGd/syCR/eImlWuzlbnx/ypV5b1MnWdPF//9k=',
    'outreach': 'data:image/jpeg;base64,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',
    'run': 'data:image/jpeg;base64,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',
}


def asset_url(page):
    # A real image you drop in wins; otherwise use the built-in art inline so
    # it always renders with no folder, no extra request, nothing to 404.
    for ext in ("jpg", "jpeg", "png", "webp"):
        if os.path.exists(os.path.join(ASSETS_DIR, f"header-{page}.{ext}")):
            return f"/assets/header-{page}.{ext}"
    if page in EMBED:
        return EMBED[page]
    return "data:image/svg+xml," + quote(DEFAULT_ART.get(page, ""))


ensure_assets()


def blank_counts():
    return {"searches_done": 0, "searches_total": 0, "collected": 0,
            "scanned": 0, "scan_total": 0, "found": 0,
            "sent": 0, "send_target": 0}


HISTORY_PATH = os.path.join(BASE, "history.jsonl")


def append_history(record):
    try:
        with open(HISTORY_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def load_history(limit=80):
    items = []
    if os.path.exists(HISTORY_PATH):
        try:
            with open(HISTORY_PATH, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        items.append(json.loads(line))
                    except Exception:
                        pass
        except Exception:
            pass
    return items[-limit:][::-1]   # newest first


JOB = {
    "running": False,
    "stage": "idle",
    "step": "idle",          # idle | collect | find | send | done | stopped
    "kind": "",              # human label for the active run
    "started_at": None,
    "attention": False,      # True while waiting for a human to clear a Google check
    "attention_msg": "",
    "counts": blank_counts(),
    "log": [],
}
JOB_LOCK = threading.Lock()
STOP = threading.Event()


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    JOB["log"].append(line)
    if len(JOB["log"]) > 400:
        JOB["log"] = JOB["log"][-400:]
    print(line)


def bump(**kw):
    for k, v in kw.items():
        JOB["counts"][k] = JOB["counts"].get(k, 0) + v


def set_counts(**kw):
    JOB["counts"].update(kw)


def start_job(target, step, kind=""):
    with JOB_LOCK:
        if JOB["running"]:
            return False
        JOB["running"] = True
        JOB["step"] = step
        JOB["kind"] = kind or step
        JOB["started_at"] = time.time()
        JOB["attention"] = False
        JOB["attention_msg"] = ""
        JOB["log"] = []
        JOB["counts"] = blank_counts()
        STOP.clear()

    def wrap():
        try:
            target()
        except Exception as e:
            log(f"Error: {type(e).__name__}: {e}")
        finally:
            JOB["running"] = False
            JOB["attention"] = False
            JOB["attention_msg"] = ""
            JOB["step"] = "stopped" if STOP.is_set() else "done"
            JOB["stage"] = "stopped" if STOP.is_set() else "done"
            log("Finished.")
            started = JOB.get("started_at") or time.time()
            append_history({
                "id": int(started * 1000),
                "kind": JOB.get("kind", step),
                "started": time.strftime("%Y-%m-%d %H:%M", time.localtime(started)),
                "ended": time.strftime("%H:%M"),
                "secs": int(time.time() - started),
                "status": "stopped" if STOP.is_set() else "done",
                "counts": dict(JOB["counts"]),
                "log": list(JOB["log"][-300:]),
            })

    threading.Thread(target=wrap, daemon=True).start()
    return True


# ===================== EMAIL FINDING =====================
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
CONTACT_PATHS = ["", "/contact", "/contact-us", "/contact-us/", "/about", "/about-us"]
JUNK = ("example.com", "sentry", "wixpress", "@2x", ".png", ".jpg", ".jpeg",
        ".gif", ".webp", ".svg", "no-reply", "noreply", "your-email", "email@",
        "domain.com", "core-js", "googleapis", "schema.org")
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; lead-research/1.0)"}
WEBSITE_KEYS = ("website", "url", "site", "web", "domain", "link", "href")
NAME_KEYS = ("business", "company", "organization", "name")


def _guess_name_col(fieldnames):
    for name in fieldnames:
        low = name.strip().lower()
        if any(k == low or k in low for k in NAME_KEYS):
            return name
    return None


def find_website_column(fieldnames):
    for name in fieldnames:
        low = name.strip().lower()
        if any(k == low or k in low for k in WEBSITE_KEYS):
            return name
    return None


def clean_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    return raw


def domain_of(url):
    try:
        netloc = urlparse(url).netloc.lower()
        return netloc[4:] if netloc.startswith("www.") else netloc
    except Exception:
        return None


def is_junk(email):
    e = email.lower()
    return any(j in e for j in JUNK)


def extract_emails(html, site_domain):
    found = set()
    for m in re.findall(r'mailto:([^"\'>?\s]+)', html, flags=re.I):
        found.add(m)
    for m in EMAIL_RE.findall(html):
        found.add(m)
    cleaned = {e.strip().strip(".,;:") for e in found if not is_junk(e)}
    if not cleaned:
        return []
    same = [e for e in cleaned if site_domain and e.lower().endswith("@" + site_domain)]
    return sorted(same) if same else sorted(cleaned)


def process_site(url):
    """Return (email, source). Only ever returns an address actually published
    on the business's own website. Never guesses or dictionary-generates an
    address (that is a prohibited 'harvesting'/'dictionary attack' under CAN-SPAM
    and lands on spam traps), so the only possible sources are 'scraped' or none."""
    url = clean_url(url)
    if not url:
        return "", "no_website"
    dom = domain_of(url)
    for path in CONTACT_PATHS:
        target = url.rstrip("/") + path
        try:
            r = requests.get(target, headers=HEADERS, timeout=12, allow_redirects=True)
            if r.status_code >= 400:
                continue
            emails = extract_emails(r.text, dom)
            if emails:
                return emails[0], "scraped"
        except requests.RequestException:
            continue
    return "", "no_email_found"


# ===================== COLLECTOR (Google Places API) =====================
# Business data is collected ONLY through Google's official Places API (New),
# using the student's OWN API key and billing. No scraping, no browser
# automation, no bot-detection masking, no Terms-of-Service circumvention.
# The field mask is kept tight so the call stays on the lowest applicable SKU.
SCRAPE_FIELDS = ["name", "address", "city", "phone", "website", "rating", "reviews", "maps_url"]

PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_FIELD_MASK = ",".join([
    "places.displayName",
    "places.formattedAddress",
    "places.addressComponents",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.websiteUri",
    "places.rating",
    "places.userRatingCount",
    "places.googleMapsUri",
    "nextPageToken",
])


def normalize_phone(raw):
    """Keep phones as readable text so spreadsheets never turn them into
    scientific notation. Preserves the country code and digits; guarantees a
    space so Excel treats the cell as text, not a number."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    plus = raw.lstrip().startswith("+")
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return ""
    known_cc = ("971", "966", "968", "974", "973", "965", "92", "91",
                "44", "61", "65", "81", "49", "33", "1")
    cc = ""
    rest = digits
    if plus:
        for c in known_cc:
            if rest.startswith(c):
                cc, rest = c, rest[len(c):]
                break
        if not cc:
            cc, rest = rest[:3], rest[3:]
    groups = [rest[i:i + 3] for i in range(0, len(rest), 3)]
    out = (("+" + cc + " ") if cc else "") + " ".join(groups)
    out = out.strip()
    if " " not in out and len(out) > 4:   # never leave a bare number
        out = out[:4] + " " + out[4:]
    return out


def _csv_safe(v):
    """Excel/Sheets treat a cell starting with = + - @ as a live formula, so a
    scraped value like =HYPERLINK(...) would execute on open. Prefix those with
    an apostrophe (Excel's own "literal text" marker). Leading tabs/CRs are
    stripped first - Excel ignores them when sniffing for a formula. Costs a
    visible apostrophe on e.g. "+1 555..." phone numbers; that is the standard
    accepted tradeoff."""
    if isinstance(v, str):
        stripped = v.lstrip("\t\r")
        if stripped[:1] in ("=", "+", "-", "@"):
            return "'" + stripped
    return v


def _csv_safe_row(row):
    if isinstance(row, dict):
        return {k: _csv_safe(v) for k, v in row.items()}
    return [_csv_safe(v) for v in row]


def save_csv(path, rows, fields):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    # utf-8-sig writes a BOM so Excel opens it as UTF-8 (fixes Arabic names)
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(_csv_safe_row(r) for r in rows)
    os.replace(tmp, path)


def _country_of(place):
    for comp in place.get("addressComponents", []) or []:
        if "country" in (comp.get("types") or []):
            return (comp.get("longText") or comp.get("shortText") or "").strip()
    return ""


def _country_allowed(country, allowed):
    if not allowed:
        return True
    c = (country or "").strip().lower()
    if not c:
        return False
    return any(c == a.strip().lower() for a in allowed)


def places_search(api_key, query, max_results, allowed_countries):
    """One niche+city query against Places API (New). Returns (rows, error).
    Pages up to 3x (Places caps at 60 results per query). Each page is one
    billable Text Search request."""
    rows, token, pages = [], None, 0
    max_pages = max(1, min(3, (int(max_results) + 19) // 20))
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
    }
    while pages < max_pages:
        body = {"textQuery": query, "pageSize": 20}
        if token:
            body["pageToken"] = token
        try:
            r = requests.post(PLACES_URL, headers=headers, json=body, timeout=30)
        except requests.RequestException as e:
            return rows, f"network error ({type(e).__name__})"
        if r.status_code != 200:
            try:
                msg = r.json().get("error", {}).get("message", r.text[:200])
            except Exception:
                msg = r.text[:200]
            return rows, f"{r.status_code}: {msg}"
        data = r.json()
        for place in data.get("places", []) or []:
            if not _country_allowed(_country_of(place), allowed_countries):
                continue
            phone = place.get("nationalPhoneNumber") or place.get("internationalPhoneNumber") or ""
            rating = place.get("rating")
            rows.append({
                "name": (place.get("displayName") or {}).get("text", "").strip(),
                "address": (place.get("formattedAddress") or "").strip(),
                "city": "",  # filled in by the caller
                "phone": normalize_phone(phone),
                "website": (place.get("websiteUri") or "").strip(),
                "rating": str(rating) if rating is not None else "",
                "reviews": str(place.get("userRatingCount") or ""),
                "maps_url": (place.get("googleMapsUri") or "").strip(),
            })
            if len(rows) >= int(max_results):
                return rows, None
        token = data.get("nextPageToken")
        pages += 1
        if not token:
            break
        time.sleep(2)   # Google needs a moment before a page token becomes valid
    return rows, None


def _collect(cfg):
    cities = cfg.get("cities", [])
    niches = cfg.get("niches", [])
    api_key = (cfg.get("places_api_key") or "").strip()
    allowed = [c for c in cfg.get("allowed_countries", []) if (c or "").strip()]
    max_results = int(cfg.get("max_per_search", 60) or 60)

    if not api_key:
        log("Add your Google Places API key on the Targets page first. "
            "Setup takes a few minutes - the steps are in LEGAL_AND_USE.txt.")
        return
    jobs = [(c, n) for n in niches for c in cities]
    if not jobs:
        log("Add at least one business type and one location first.")
        return
    if allowed:
        log("Collecting only in: " + ", ".join(allowed) + ".")

    run_dir = os.path.join(RUNS_DIR, time.strftime("%Y-%m-%d_%H-%M-%S"))
    set_counts(searches_total=len(jobs), searches_done=0, collected=0)
    log(f"Collecting {len(jobs)} searches into {os.path.basename(run_dir)}")

    for idx, (city, niche) in enumerate(jobs, 1):
        if STOP.is_set():
            log("Stopped.")
            break
        label, term = niche["label"], niche["term"]
        out_path = os.path.join(run_dir, label, "raw", f"{city} - {label}.csv")
        if os.path.exists(out_path):
            set_counts(searches_done=idx)
            continue
        JOB["stage"] = f"collecting {idx}/{len(jobs)}: {term} {city}"
        log(JOB["stage"])

        rows, err = places_search(api_key, f"{term} in {city}", max_results, allowed)
        for row in rows:
            row["city"] = city
        if err:
            low = err.lower()
            if any(w in low for w in ("api key", "permission", "denied")) or err.startswith("403"):
                log("  Google rejected the API key. In Google Cloud: enable "
                    "'Places API (New)', turn on billing, and make sure the key "
                    "isn't restricted away from it. Details in LEGAL_AND_USE.txt.")
            elif err.startswith("429"):
                log("  Hit Google's rate limit - pausing; it'll retry next run.")
                time.sleep(5)
            else:
                log(f"  search issue ({label}, {city}): {err}")
        if rows:
            save_csv(out_path, rows, SCRAPE_FIELDS)
            bump(collected=len(rows))
            log(f"  saved {len(rows)} ({label}, {city})")
        elif not err and not STOP.is_set():
            log(f"  0 results ({label}, {city})")
        set_counts(searches_done=idx)
        if not STOP.is_set() and idx < len(jobs):
            time.sleep(random.uniform(0.4, 1.2))
    log("Collecting complete.")


def do_scrape():
    JOB["step"] = "collect"
    JOB["stage"] = "collecting"
    _collect(load_config())


# ===================== FIND EMAILS =====================
def latest_run():
    if not os.path.isdir(RUNS_DIR):
        return None
    subs = [os.path.join(RUNS_DIR, d) for d in os.listdir(RUNS_DIR)
            if os.path.isdir(os.path.join(RUNS_DIR, d))]
    return max(subs, key=os.path.getmtime) if subs else None


def count_rows(path):
    try:
        with open(path, newline="", encoding="utf-8-sig") as f:
            return max(0, sum(1 for _ in f) - 1)
    except Exception:
        return 0


def do_find():
    from concurrent.futures import ThreadPoolExecutor, as_completed
    JOB["step"] = "find"
    run_dir = latest_run()
    if not run_dir:
        log("No businesses collected yet. Run step 1 first.")
        return
    JOB["stage"] = "finding emails"
    log(f"Finding emails in {os.path.basename(run_dir)}")
    raw_files = []
    for niche in sorted(os.listdir(run_dir)):
        raw = os.path.join(run_dir, niche, "raw")
        if os.path.isdir(raw):
            for fn in sorted(os.listdir(raw)):
                if fn.lower().endswith(".csv") and not fn.endswith(".tmp"):
                    raw_files.append((niche, os.path.join(raw, fn), fn))

    set_counts(scan_total=sum(count_rows(p) for _, p, _ in raw_files),
               scanned=0, found=0)

    for niche, in_path, fn in raw_files:
        if STOP.is_set():
            log("Stopped.")
            break
        out_path = os.path.join(run_dir, niche, "with_emails", fn)
        if os.path.exists(out_path):
            bump(scanned=count_rows(in_path))
            continue
        with open(in_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            fields = reader.fieldnames or []
        wc = find_website_column(fields)
        if not wc:
            bump(scanned=len(rows))
            continue
        results = {}
        with ThreadPoolExecutor(max_workers=10) as ex:
            futs = {ex.submit(process_site, rows[i].get(wc, "")): i for i in range(len(rows))}
            for fut in as_completed(futs):
                results[futs[fut]] = fut.result()
                bump(scanned=1)
        out_fields = fields + ["found_email", "email_source"]
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        tmp = out_path + ".tmp"
        with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=out_fields)
            w.writeheader()
            for i, row in enumerate(rows):
                email, source = results.get(i, ("", "error"))
                row["found_email"] = email
                row["email_source"] = source
                w.writerow(_csv_safe_row(row))
        os.replace(tmp, out_path)
        scraped = sum(1 for e, s in results.values() if s == "scraped")
        bump(found=scraped)
        log(f"  {niche} / {fn}: {len(rows)} businesses, {scraped} with a published email")
    log("Finding emails complete.")


# Imported businesses (website, no email yet) -> scan for a published email.
# Mirrors do_find()'s concurrency/lookup exactly, but reads a flat imported row
# list instead of RUNS_DIR/<run>/<niche>/raw files, and writes results back
# into the same IMPORTS_DIR record - never touches RUNS_DIR, so it can't be
# mistaken for a real scrape run by latest_run().
def do_find_import(import_id):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    JOB["step"] = "find"
    rec = _read_import(import_id)
    if not rec:
        log("Imported list not found. Upload a CSV on the Find Emails page first.")
        return
    if not rec.get("find_mapped") or not rec.get("website_col"):
        log("Map the website column for this import before finding emails.")
        return
    if STOP.is_set():
        return

    JOB["stage"] = "finding emails (imported list)"
    wc = rec["website_col"]
    rows = rec.get("rows", [])
    log(f"Finding emails for {len(rows)} imported businesses.")
    set_counts(scan_total=len(rows), scanned=0, found=0)

    results = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(process_site, rows[i].get(wc, "")): i for i in range(len(rows))}
        for fut in as_completed(futs):
            results[futs[fut]] = fut.result()
            bump(scanned=1)

    for i, row in enumerate(rows):
        email, source = results.get(i, ("", "error"))
        row["found_email"] = email
        row["email_source"] = source
    scraped = sum(1 for _e, s in results.values() if s == "scraped")
    bump(found=scraped)
    rec["rows"] = rows
    rec["found_count"] = scraped
    _write_import(rec)
    log(f"Done. {scraped} of {len(rows)} imported businesses had a published email.")


# ===================== SENDER =====================
SUBJECT_HAS = "quick idea for {business}'s website"
BODY_HAS = """Hi there,

I came across {business} and built a quick sample of what a sharper, higher-converting website could look like for you:

{link}

You're already paying for a domain and hosting either way - the real question is whether that's bringing you customers or just sitting there looking dated. People size up a business by its website in seconds, and a clean, fast one turns more of the visitors you already get into real enquiries.

I'd build the whole thing - your branding, services, and photos - for a flat {price}, one-time, with no monthly fees.

Worth a quick call to see if it's a fit? Reply with a couple of times that work for you and I'll set it up - no pressure either way.

{sender}

{address} - not interested? reply "stop"
"""

SUBJECT_NONE = "a website for {business}?"
BODY_NONE = """Hi there,

I noticed {business} doesn't have a website yet, and most businesses like yours already do. These days it's less about looking flashy and more about trust: when someone looks you up and finds a clean, professional site, you look established. When they find nothing, they often move on to the next name on the list.

I put together a sample so you can see what yours could look like:

{link}

I'd build the whole thing for a flat {price}, one-time, with no monthly fees.

Worth a quick call to see if it's a fit? Reply with a couple of times that work for you and I'll set it up - no pressure either way.

{sender}

{address} - not interested? reply "stop"
"""


def load_seen():
    seen = set()
    for path in (SENT_LOG, SUPPRESS_CSV):
        if os.path.exists(path):
            with open(path, newline="", encoding="utf-8") as f:
                for row in csv.reader(f):
                    if row:
                        seen.add(row[0].strip().lower())
    return seen


def log_sent(email, account):
    new = not os.path.exists(SENT_LOG)
    with open(SENT_LOG, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["email", "account", "timestamp"])
        w.writerow(_csv_safe_row([email, account, time.strftime("%Y-%m-%d %H:%M:%S")]))


def gather_leads(cfg):
    niche_map = {n["label"]: n for n in cfg["niches"]}
    leads, seen_batch = [], set()
    if not os.path.isdir(RUNS_DIR):
        return leads
    for root, _dirs, files in os.walk(RUNS_DIR):
        if os.path.basename(root) != "with_emails":
            continue
        niche = os.path.basename(os.path.dirname(root))
        if niche not in niche_map:
            continue
        for fn in sorted(files):
            if not fn.lower().endswith(".csv") or fn.endswith(".tmp"):
                continue
            with open(os.path.join(root, fn), newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                fields = reader.fieldnames or []
                ec = next((c for c in ("found_email", "email") if c in fields), None)
                if not ec:
                    continue
                for row in reader:
                    email = (row.get(ec) or "").strip()
                    if "@" not in email or "." not in email.split("@")[-1]:
                        continue
                    # Only ever contact a business's own published address.
                    if (row.get("email_source") or "").lower() != "scraped":
                        continue
                    key = email.lower()
                    if key in seen_batch:
                        continue
                    seen_batch.add(key)
                    business = (row.get("name") or "there").strip() or "there"
                    has_site = bool((row.get("website") or "").strip())
                    leads.append({"email": email, "business": business,
                                  "niche": niche, "has_site": has_site})
    return leads


class _SafeTokens(dict):
    def __missing__(self, k):
        return "{" + k + "}"


def render(cfg, lead, sender_name):
    # lead.get("niche") is None for imported leads (no niche context) - fall back
    # to an empty niche record ({link} renders blank) rather than KeyError.
    n = {x["label"]: x for x in cfg["niches"]}.get(lead.get("niche"), {})
    common = dict(business=lead["business"], link=n.get("link", ""), price=cfg["price"],
                  sender=sender_name, address=cfg["physical_address"])
    subj_t = (cfg.get("email_subject") or "").strip()
    body_t = (cfg.get("email_body") or "").strip()
    if subj_t and body_t:
        return (subj_t.format_map(_SafeTokens(**common)),
                body_t.format_map(_SafeTokens(**common)))
    if lead.get("has_site"):
        return SUBJECT_HAS.format(business=lead["business"]), BODY_HAS.format(**common)
    return SUBJECT_NONE.format(business=lead["business"]), BODY_NONE.format(**common)


def append_suppression(addr):
    addr = (addr or "").strip().lower()
    if not addr or "@" not in addr:
        return False
    existing = set()
    if os.path.exists(SUPPRESS_CSV):
        with open(SUPPRESS_CSV, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                if row:
                    existing.add(row[0].strip().lower())
    if addr in existing:
        return False
    new = not os.path.exists(SUPPRESS_CSV)
    with open(SUPPRESS_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["email", "added"])
        w.writerow(_csv_safe_row([addr, time.strftime("%Y-%m-%d %H:%M:%S")]))
    return True


UNSUB_WORDS = ("unsubscribe", "stop", "remove me", "opt out", "opt-out", "take me off")


def _imap_host_for(acct):
    host = (acct.get("imap_host") or "").strip()
    if host:
        return host
    smtp = (acct.get("smtp_host") or "").strip().lower()
    if not smtp or "gmail" in smtp:
        return "imap.gmail.com"
    # best-effort: smtp.example.com -> imap.example.com
    return "imap." + smtp.split(".", 1)[1] if smtp.startswith("smtp.") else smtp


def poll_unsubscribes(cfg):
    """Read each sending mailbox over IMAP and auto-suppress anyone whose reply
    asks to stop/unsubscribe. This is what makes opt-out honouring automatic, as
    anti-spam law requires - the student never has to watch the inbox by hand."""
    added = 0
    for a in cfg.get("sender_accounts", []):
        user = (a.get("email") or "").strip()
        pw = (a.get("app_password") or a.get("smtp_password") or "").replace(" ", "")
        if not user or not pw:
            continue
        host = _imap_host_for(a)
        try:
            M = imaplib.IMAP4_SSL(host, timeout=30)
            M.login(user, pw)
            M.select("INBOX")
            since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - 30 * 86400))
            typ, data = M.search(None, f'(SINCE {since})')
            ids = (data[0].split() if data and data[0] else [])[-400:]
            for num in ids:
                typ, msgdata = M.fetch(num, "(RFC822)")
                if typ != "OK" or not msgdata or not msgdata[0]:
                    continue
                m = emaillib.message_from_bytes(msgdata[0][1])
                subj = str(m.get("Subject") or "").lower()
                sender = parseaddr(m.get("From") or "")[1].lower()
                text = subj
                try:
                    if m.is_multipart():
                        for part in m.walk():
                            if part.get_content_type() == "text/plain":
                                text += " " + (part.get_payload(decode=True) or b"").decode("utf-8", "ignore").lower()
                    else:
                        text += " " + (m.get_payload(decode=True) or b"").decode("utf-8", "ignore").lower()
                except Exception:
                    pass
                if sender and any(w in text for w in UNSUB_WORDS):
                    if append_suppression(sender):
                        added += 1
            try:
                M.logout()
            except Exception:
                pass
        except Exception as e:
            log(f"  could not check {user} for opt-outs ({type(e).__name__}); skipping.")
    if added:
        log(f"  honoured {added} new opt-out repl{'y' if added == 1 else 'ies'}.")
    return added


def _active_accounts(cfg):
    def has_pw(a):
        return bool(a.get("app_password") or a.get("smtp_password"))
    return [a for a in cfg.get("sender_accounts", []) if a.get("email") and has_pw(a)]


def _smtp_conn(conns, a):
    if a["email"] not in conns:
        host = (a.get("smtp_host") or "smtp.gmail.com").strip()
        port = int(a.get("smtp_port") or (587 if host != "smtp.gmail.com" else 465))
        user = (a.get("smtp_user") or a["email"]).strip()
        pw = (a.get("app_password") or a.get("smtp_password") or "").replace(" ", "")
        ctx = ssl.create_default_context()
        if port == 465:
            s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
        else:
            s = smtplib.SMTP(host, port, timeout=30)
            s.ehlo()
            try:
                s.starttls(context=ctx)
                s.ehlo()
            except Exception:
                pass
        s.login(user, pw)
        conns[a["email"]] = s
    return conns[a["email"]]


def _build_send_message(sender_name, from_addr, to, subj, body, unsub_url):
    msg = EmailMessage()
    msg["From"] = f"{sender_name} <{from_addr}>" if sender_name else from_addr
    msg["Reply-To"] = from_addr
    msg["To"] = to
    msg["Subject"] = subj
    # Working, standards-compliant unsubscribe. The mailto always works
    # with no hosting; if a hosted one-click endpoint is configured it is
    # offered too (RFC 8058), which also satisfies Gmail/Yahoo bulk rules.
    unsub_parts = []
    if unsub_url:
        sep = "&" if "?" in unsub_url else "?"
        unsub_parts.append(f"<{unsub_url}{sep}email={quote(to)}>")
    unsub_parts.append(f"<mailto:{from_addr}?subject=unsubscribe>")
    msg["List-Unsubscribe"] = ", ".join(unsub_parts)
    if unsub_url:
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(body)
    return msg


def _run_send_loop(cfg, leads, accounts, dry):
    target = int(cfg["total_target"])
    seen = load_seen()
    conns = {}
    sent_acct = {a["email"]: 0 for a in accounts}
    cap = int(cfg["per_account_cap"])
    unsub_url = (cfg.get("unsub_url") or "").strip()
    total = 0
    idx = 0

    for lead in leads:
        if STOP.is_set() or total >= target:
            break
        to = lead["email"]
        if to.lower() in seen:
            continue
        acct = None
        if accounts:
            for _ in range(len(accounts)):
                c = accounts[idx % len(accounts)]
                idx += 1
                if sent_acct[c["email"]] < cap:
                    acct = c
                    break
            if acct is None:
                log("Every account has hit its daily limit.")
                break
        sender_name = (acct or {}).get("name", "")
        from_addr = (acct or {}).get("from_addr", "") or (acct or {}).get("email", "")
        subj, body = render(cfg, lead, sender_name)

        if dry:
            log(f"  [preview] {to} - {lead.get('niche') or lead.get('business')} - {subj}")
        else:
            msg = _build_send_message(sender_name, from_addr, to, subj, body, unsub_url)
            try:
                _smtp_conn(conns, acct).send_message(msg)
            except Exception as e:
                log(f"  failed: {to} ({type(e).__name__})")
                continue
            log_sent(to, acct["email"])
            sent_acct[acct["email"]] += 1
            log(f"  sent {total + 1} - {to}")

        seen.add(to.lower())
        total += 1
        bump(sent=1)
        if not dry and total < target and not STOP.is_set():
            time.sleep(random.uniform(int(cfg["min_delay"]), int(cfg["max_delay"])))

    for s in conns.values():
        try:
            s.quit()
        except Exception:
            pass
    log(f"{'Preview only - nothing sent' if dry else 'Sending done'}. Total: {total}.")


def do_send():
    JOB["step"] = "send"
    cfg = load_config()
    accounts = _active_accounts(cfg)
    dry = cfg.get("test_mode", True)

    # --- Compliance gates (live sends only) ---
    if not dry:
        if not accounts:
            log("Add a sending account (email + app password) on the Outreach page first.")
            return
        if not (cfg.get("physical_address") or "").strip():
            log("Add your mailing address on the Outreach page before sending. "
                "A real postal address in the footer is legally required for "
                "every marketing email - sending without one is not allowed.")
            return
        log("Checking inboxes for any opt-out replies before sending...")
        poll_unsubscribes(cfg)

    leads = gather_leads(cfg)
    target = int(cfg["total_target"])
    set_counts(sent=0, send_target=min(target, len(leads)))
    log(f"{len(leads)} contactable leads found.")
    if not leads:
        return

    JOB["stage"] = "sending (test)" if dry else "sending"
    _run_send_loop(cfg, leads, accounts, dry)


def do_all():
    do_scrape()
    if not STOP.is_set():
        do_find()


# ===================== IMPORTED CSV (parallel send source) =====================
# Lets a user send from an arbitrary uploaded CSV, independent of Targets/Outreach
# setup and of any prior scrape. Lives entirely under IMPORTS_DIR - never touches
# RUNS_DIR, never consults cfg["niches"], and never claims email_source=="scraped"
# (that value means "found on the business's own site" - imported rows get their
# own "imported" tag instead).
def _imports_ensure():
    os.makedirs(IMPORTS_DIR, exist_ok=True)


def _import_path(iid):
    iid = "".join(c for c in str(iid) if c.isalnum())
    return os.path.join(IMPORTS_DIR, iid + ".json")


def _read_import(iid):
    p = _import_path(iid)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_import(obj):
    _imports_ensure()
    with open(_import_path(obj["id"]), "w", encoding="utf-8") as f:
        json.dump(obj, f)


def _leads_from_import(rec):
    email_col = rec.get("email_col")
    name_col = rec.get("name_col")
    if not email_col:
        return []
    leads, seen_batch = [], set()
    for row in rec.get("rows", []):
        email = (row.get(email_col) or "").strip()
        if not EMAIL_RE.fullmatch(email):
            continue
        key = email.lower()
        if key in seen_batch:
            continue
        seen_batch.add(key)
        business = ((row.get(name_col) or "").strip() if name_col else "") or "there"
        leads.append({"email": email, "business": business, "niche": None,
                      "has_site": False, "email_source": "imported"})
    return leads


def do_send_import(import_id):
    JOB["step"] = "send"
    cfg = load_config()
    rec = _read_import(import_id)
    if not rec:
        log("Imported list not found. Upload a CSV on the Run page first.")
        return
    if not rec.get("mapped") or not rec.get("email_col"):
        log("Map the email column for this import before sending.")
        return

    accounts = _active_accounts(cfg)
    dry = cfg.get("test_mode", True)

    # --- Same compliance gates as the scraped send path (live sends only) ---
    if not dry:
        if not accounts:
            log("Add a sending account (email + app password) on the Outreach page first.")
            return
        if not (cfg.get("physical_address") or "").strip():
            log("Add your mailing address on the Outreach page before sending. "
                "A real postal address in the footer is legally required for "
                "every marketing email - sending without one is not allowed.")
            return
        log("Checking inboxes for any opt-out replies before sending...")
        poll_unsubscribes(cfg)

    leads = _leads_from_import(rec)
    target = int(cfg["total_target"])
    set_counts(sent=0, send_target=min(target, len(leads)))
    log(f"{len(leads)} contactable leads found in imported list.")
    if not leads:
        return

    JOB["stage"] = "sending imported (test)" if dry else "sending imported"
    _run_send_loop(cfg, leads, accounts, dry)


ACTIVATE_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activate __APP_NAME__</title>
<link rel="icon" type="image/png" href="/assets/logo.png">
<style>
:root{--canvas:#151514;--ink:#EAEAE5;--muted:#9C9C93;--faint:#71716A;--line:#2E2E2B;--pine:#C9A961;--pine-strong:#D8BC79;--pine-tint:#2B2718;--bad:#DE8B74;--bad-tint:#35211B;--bad-line:#4F2F26;
--sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,Consolas,monospace;--ease:cubic-bezier(.2,.7,.2,1)}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--canvas);color:var(--ink);font-family:var(--sans);display:grid;place-items:center;min-height:100vh}
.wrap{width:min(440px,92vw);text-align:center;padding:30px}
.mk{width:56px;height:56px;display:grid;place-items:center;margin:0 auto 16px}
h1{font-weight:700;font-size:22px;letter-spacing:-.02em;margin:0 0 7px}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 24px;line-height:1.55}
.card{background:#1C1C1B;border:1px solid #2B2B29;border-radius:14px;padding:24px;box-shadow:0 20px 50px -28px rgba(0,0,0,.6);text-align:left}
label{display:block;font:600 10px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}
#key{width:100%;background:#161615;border:1px solid #30302D;border-radius:8px;padding:13px 14px;font:600 16px var(--mono);letter-spacing:.12em;text-align:center;text-transform:uppercase;color:var(--ink);transition:.15s var(--ease)}
#key:focus{outline:none;border-color:var(--pine);box-shadow:0 0 0 3px rgba(160,124,45,.18)}
label.opt{display:block;font:600 10px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:16px 0 8px}
label.opt span{text-transform:none;letter-spacing:normal;font-weight:400;color:var(--muted)}
.optin{width:100%;background:#161615;border:1px solid #30302D;border-radius:8px;padding:11px 12px;font:500 13.5px var(--mono);color:var(--ink);transition:.15s var(--ease)}
.optin:focus{outline:none;border-color:var(--pine);box-shadow:0 0 0 3px rgba(160,124,45,.18)}
#go{width:100%;margin-top:16px;border:0;background:var(--pine);color:#201A0E;border-radius:8px;padding:13px;font:650 14px var(--sans);cursor:pointer;transition:.15s var(--ease)}
#go:hover{background:var(--pine-strong);transform:translateY(-1px)}#go:active{transform:translateY(0)}
#go:disabled{opacity:.55;cursor:default;transform:none}
.err{display:none;margin-top:13px;background:var(--bad-tint);border:1px solid var(--bad-line);color:var(--bad);border-radius:9px;padding:10px 12px;font-size:12.5px;line-height:1.5}
.err.show{display:block;animation:rise .3s var(--ease)}
.banner{display:none;margin:0 0 16px;background:var(--bad-tint);border:1px solid var(--bad-line);color:var(--bad);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.55;text-align:left}
.banner.show{display:block;animation:rise .3s var(--ease)}
.banner button{display:block;margin-top:10px;border:1px solid var(--bad-line);background:transparent;color:var(--bad);border-radius:7px;padding:7px 14px;font:600 12.5px var(--sans);cursor:pointer}
.banner button:hover{background:rgba(222,139,116,.08)}
.ok{display:none;margin-top:13px;color:var(--pine-strong);font-size:13.5px;text-align:center;font-weight:600}
.ok.show{display:block}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.foot{margin-top:22px;color:var(--faint);font-size:11px;line-height:1.7}
.foot code{font-family:var(--mono);background:#222221;border:1px solid #343431;padding:1px 6px;border-radius:5px;color:var(--muted)}
.spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(32,26,14,.35);border-top-color:#201A0E;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes sp{to{transform:rotate(360deg)}}
</style></head>
<body><div class="wrap">
  <div class="mk"><img src="/assets/logo.png" alt="" width="52" height="52" draggable="false"></div>
  <h1>Activate __APP_NAME__</h1>
  <p class="sub">Enter the license key from your program lead to unlock your copy.</p>
  <div class="banner" id="lic-banner"></div>
  <div class="card">
    <label for="key">License key</label>
    <input id="key" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" autofocus>
    <label class="opt" for="groq-key">Groq API key <span>(optional &mdash; add now or later in Settings)</span></label>
    <input id="groq-key" class="optin" placeholder="gsk_..." autocomplete="off" spellcheck="false">
    <label class="opt" for="places-key">Places API key <span>(optional &mdash; add now or later in Settings)</span></label>
    <input id="places-key" class="optin" placeholder="AIza..." autocomplete="off" spellcheck="false">
    <button id="go">Activate</button>
    <div class="err" id="err"></div>
    <div class="ok" id="ok"></div>
  </div>
  <p class="foot">One key, one computer. This copy will be tied to this device.<br>Device ID <code>__MID__</code></p>
</div>
<script>
window.__CSRF__="__CSRF_TOKEN__";(function(){var _f=window.fetch;window.fetch=function(u,o){o=o||{};try{var url=new URL(u,location.href);if(url.origin===location.origin){var h=new Headers(o.headers||{});h.set("X-CSRF-Token",window.__CSRF__);o.headers=h}}catch(e){}return _f.call(this,u,o)}})();
var k=document.getElementById('key'),go=document.getElementById('go'),err=document.getElementById('err'),ok=document.getElementById('ok');
// This page also serves as the BLOCKED screen: show why the app did not open.
fetch('/license/status').then(function(r){return r.json()}).then(function(d){
  if(!d||d.state!=='blocked'||!d.message)return;
  var b=document.getElementById('lic-banner');b.textContent=d.message;
  if(d.name==='no_server'||d.name==='clock'){
    var rb=document.createElement('button');rb.type='button';rb.textContent='Retry';
    rb.addEventListener('click',function(){location.reload()});b.appendChild(rb);
  }
  b.className='banner show';
}).catch(function(){});
k.addEventListener('keydown',function(e){if(e.key==='Enter')activate()});
go.addEventListener('click',activate);
function activate(){var key=k.value.trim();if(!key){err.textContent='Enter your license key.';err.className='err show';return}
  err.className='err';ok.className='ok';go.disabled=true;go.innerHTML='<span class="spin"></span>Activating';
  fetch('/license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key})})
   .then(function(r){return r.json()}).then(function(d){
     if(d.ok){
       var extra={};
       var gk=document.getElementById('groq-key').value.trim();
       var pk=document.getElementById('places-key').value.trim();
       if(gk)extra.groq_api_key=gk;
       if(pk)extra.places_api_key=pk;
       var save=Object.keys(extra).length?fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(extra)}):Promise.resolve();
       save.catch(function(){}).then(function(){
         ok.textContent='Welcome, '+(d.name||'')+' \u2014 opening your workspace\u2026';ok.className='ok show';setTimeout(function(){location.reload()},950)
       });
     }
     else{err.textContent=d.message||'Activation failed.';err.className='err show';go.disabled=false;go.textContent='Activate'}
   }).catch(function(){err.textContent='Could not reach the activation server. Check your internet connection.';err.className='err show';go.disabled=false;go.textContent='Activate'})}
</script>
</body></html>"""


# ===================== FLASK =====================
app = Flask(__name__)

# ===================== LOCAL API HARDENING (audit #6) =====================
# The API binds 127.0.0.1 only, but a browser is a confused deputy: a malicious
# site the student visits can still POST to http://127.0.0.1:5000 or use DNS
# rebinding to read responses. Two guards close that:
#   1. Host allow-list: reject any request whose Host hostname is not the
#      loopback names (kills DNS rebinding, which arrives as Host: attacker.com).
#   2. Per-process CSRF token: injected into the rendered page and required on
#      every state-changing route AND the secret-returning GETs. A cross-site
#      page can't read the token, and adding the custom header cross-origin
#      forces a CORS preflight that fails (no CORS headers are ever sent).
# Same-origin, tag-loaded static assets (/assets, /vendor) can't send a custom
# header, so they are exempt from the token (Host check still applies).
CSRF_TOKEN = secrets.token_urlsafe(32)
_CSRF_ALSO_REQUIRE = frozenset({"/config", "/my-groq-key", "/my-license"})  # secret GETs
_CSRF_EXEMPT_PREFIXES = ("/assets/", "/vendor/")                           # tag-loaded


@app.before_request
def _local_api_guard():
    # 1) DNS-rebinding defense: only loopback host names are accepted.
    host = (request.host or "").rsplit(":", 1)[0].strip("[]").lower()
    if host not in ("127.0.0.1", "localhost"):
        abort(403)
    # 2) CSRF: state-changing methods + the secret-returning GETs must carry the
    #    per-process token. GET "/" (page delivery) and static assets are exempt.
    p = request.path
    needs_token = (request.method in ("POST", "PUT", "DELETE", "PATCH")
                   or p in _CSRF_ALSO_REQUIRE)
    if needs_token and not any(p.startswith(x) for x in _CSRF_EXEMPT_PREFIXES):
        sent = request.headers.get("X-CSRF-Token", "")
        if not sent or not hmac.compare_digest(sent, CSRF_TOKEN):
            abort(403)


def _safe_name(name):
    return "".join(c for c in (name or "") if c not in '"\\<>').strip()


# Admin tab markup, spliced into INDEX_HTML server-side only when license_state()
# reports role == "admin". This hides the admin tab from non-admins, but the hosted
# brain's /admin/ is still reachable by URL + shared ADMIN_ACCESS_CODE - true
# server-side admin lockdown is a separate hardening step.
ADMIN_NAV_HTML = """      <div class="navdiv" role="presentation"></div>
      <div class="navsec tools">
      <button type="button" class="navi tool" data-view="admin">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 2 4 5.5v6c0 5 3.4 8.9 8 10.5 4.6-1.6 8-5.5 8-10.5v-6z"/><path d="m9 12 2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="navtext"><span class="lbl">Admin</span></span>
      </button>
      </div>
"""

ADMIN_VIEW_HTML = """      <section class="view" id="v-admin" aria-labelledby="vtitle" tabindex="-1">
        <div id="admin-frame-wrap" class="wb-wrap">
          <div id="admin-loading" class="wb-loading">
            <div class="wb-spin" aria-hidden="true"></div>
            <div class="wb-loadtxt">Starting the admin console&hellip;</div>
            <div class="wb-loadsub">First start can take a few seconds while it warms up.</div>
          </div>
          <div id="admin-error" class="wb-error" hidden>
            <b>Couldn't reach the admin console.</b>
            <span>The admin service isn't responding yet. Check your internet connection and try again.</span>
            <button type="button" class="btn primary" id="admin-retry">Retry</button>
          </div>
          <iframe id="admin-frame" class="wb-frame" title="Admin" hidden></iframe>
        </div>
      </section>
"""

ADMIN_TITLE_JS = '  admin:["Admin","Program administration console.","Admin"],\n'

ADMIN_SHOW_HOOK_JS = "  if(v==='admin'){Admin.enter()}\n"

ADMIN_CONTROLLER_JS = """
/* Admin: embed the hosted admin console directly. */
var Admin=(function(){
  var ready=false;
  var ADMIN_ORIGIN='https://lumen-brain.vercel.app';
  function showState(s){var l=el('admin-loading'),e=el('admin-error'),f=el('admin-frame');if(!l||!e||!f)return;l.hidden=(s!=='loading');e.hidden=(s!=='error');f.hidden=(s!=='ready');}
  function unlock(){
    var f=el('admin-frame');
    if(!f||!f.contentWindow)return;
    fetch('/my-license').then(function(r){return r.ok?r.json():null}).then(function(d){
      if(d&&d.ok&&f.contentWindow){f.contentWindow.postMessage({type:'lumen-admin-unlock',key:d.key,machine:d.machine},ADMIN_ORIGIN)}
    }).catch(function(){});
  }
  function load(){
    showState('loading');
    var f=el('admin-frame');
    if(!f){showState('error');return}
    if(!f.src){f.src='https://lumen-brain.vercel.app/admin/';}
    f.onload=function(){ready=true;showState('ready');unlock()};
    f.onerror=function(){showState('error')};
    setTimeout(function(){if(!ready)showState('ready')},1500);
  }
  var rb=el('admin-retry'); if(rb){rb.onclick=function(){ready=false;var f=el('admin-frame');if(f){f.removeAttribute('src')}load()}}
  return {enter:function(){ if(ready){showState('ready');return} load(); }};
})();
"""


@app.route("/")
def index():
    state, name, role = license_state()
    if state in ("ok", "grace"):
        art = {p: asset_url(p) for p in ART_PAGES}
        nm = _safe_name(name) or "you"
        is_admin = role == "admin"
        html = (INDEX_HTML.replace("__APP_NAME__", APP_NAME)
                .replace("__ART_JSON__", json.dumps(art))
                .replace("__USER_NAME__", nm)
                .replace("__USER_ROLE__", role)
                .replace("__CSRF_TOKEN__", CSRF_TOKEN)
                .replace("__ADMIN_NAV__", ADMIN_NAV_HTML if is_admin else "")
                .replace("__ADMIN_VIEW__", ADMIN_VIEW_HTML if is_admin else "")
                .replace("__ADMIN_TITLE__", ADMIN_TITLE_JS if is_admin else "")
                .replace("__ADMIN_SHOW_HOOK__", ADMIN_SHOW_HOOK_JS if is_admin else "")
                .replace("__ADMIN_JS__", ADMIN_CONTROLLER_JS if is_admin else ""))
        return html
    return (ACTIVATE_HTML.replace("__APP_NAME__", APP_NAME)
            .replace("__MID__", machine_id())
            .replace("__CSRF_TOKEN__", CSRF_TOKEN))


_LIC_ERRORS = {
    "invalid": "That key wasn't recognised. Check for typos and try again.",
    "in_use": "This key is already activated on another computer.",
    "machine_in_use": "This computer already has a license activated. Each computer can use only one key.",
    "expired": "This license has expired. Contact your program lead for a new key.",
    "another_device": "This license belongs to a different computer and couldn't be re-verified. Connect to the internet and try again.",
    "disabled": "This key has been turned off. Contact your program lead.",
    "empty": "Enter your license key.",
    "offline": "Couldn't reach the activation server. Check your internet connection.",
    "no_server": "Can't reach the license server. Connect to the internet and reopen Lumen.",
    "clock": "This computer's clock is set earlier than the last license check. Fix the system date and time, then reopen Lumen.",
    "server_error": "The license server had a temporary problem. Please try again in a few minutes.",
    "offline_expired": "Please connect to the internet to re-verify your license.",
    "need_reactivate": "Please connect to the internet once to refresh your license.",
}


@app.route("/license/activate", methods=["POST"])
def license_activate():
    key = (request.get_json(silent=True) or {}).get("key", "")
    if not key.strip():
        return jsonify(ok=False, error="empty", message=_LIC_ERRORS["empty"])
    ok, res = activate(key)
    if ok:
        return jsonify(ok=True, name=res)
    return jsonify(ok=False, error=res, message=_LIC_ERRORS.get(res, _LIC_ERRORS["invalid"]))


@app.route("/license/status")
def license_status():
    state, name, role = license_state()
    return jsonify(state=state, name=name, role=role, message=_LIC_ERRORS.get(name, ""))


@app.route("/my-license")
def my_license():
    """Admin-only: hands the current user's own license key + machine id to the
    Admin view's JS so it can unlock the embedded brain admin console without a
    separate password. Gated server-side on role, not just on tab visibility."""
    state, _name, role = license_state()
    if state not in ("ok", "grace") or role != "admin":
        return jsonify(ok=False), 403
    lic = _load_lic() or {}
    return jsonify(ok=True, key=lic.get("key", ""), machine=machine_id())


@app.route("/update")
def update_route():
    return jsonify(update_info())


@app.route("/assets/<path:fn>")
def assets(fn):
    return send_from_directory(ASSETS_DIR, fn)


@app.route("/website-builder/ensure", methods=["POST"])
def website_builder_ensure():
    try:
        import website_builder_bridge as wbb
        ready = wbb.ensure()
        return jsonify(ready=bool(ready), port=wbb.BRIDGE_PORT, info=wbb.status())
    except Exception as e:
        return jsonify(ready=False, error=str(e))


@app.route("/website-builder/status")
def website_builder_status():
    try:
        import website_builder_bridge as wbb
        return jsonify(wbb.status())
    except Exception as e:
        return jsonify(error=str(e))


@app.route("/website-builder/generate", methods=["POST"])
def website_builder_generate():
    from website_generation import generate_draft, WebsiteGenerationError
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Send a website brief."), 400
    try:
        draft = generate_draft(data.get("prompt"), load_config().get("groq_api_key", ""))
        return jsonify(draft=draft)
    except WebsiteGenerationError as exc:
        return jsonify(error=str(exc)), 400


@app.route("/agency-brain/ensure", methods=["POST"])
def agency_brain_ensure():
    try:
        import agency_brain_launcher as abl
        ready = abl.ensure()
        return jsonify(ready=bool(ready), port=abl.PORT, info=abl.status())
    except Exception as e:
        return jsonify(ready=False, error=str(e))


@app.route("/agency-brain/status")
def agency_brain_status():
    try:
        import agency_brain_launcher as abl
        return jsonify(abl.status())
    except Exception as e:
        return jsonify(error=str(e))


@app.route("/config", methods=["GET"])
def get_config():
    return jsonify(load_config())


@app.route("/my-groq-key", methods=["GET"])
def my_groq_key():
    cfg = load_config()
    return jsonify({"key": cfg.get("groq_api_key", "") or ""})


@app.route("/config", methods=["POST"])
def set_config():
    cfg = load_config()
    cfg.update(request.get_json(force=True) or {})
    save_config(cfg)
    return jsonify({"ok": True})


@app.route("/run/<stage>", methods=["POST"])
def run_stage(stage):
    if stage == "send_import":
        d = request.get_json(silent=True) or {}
        import_id = (d.get("import_id") or "").strip()
        if not import_id:
            return jsonify({"ok": False, "error": "no_import_selected"}), 400
        ok = start_job(lambda: do_send_import(import_id), "send", "Send imported campaign")
        return jsonify({"ok": ok, "error": None if ok else "a step is already running"})

    if stage == "find_import":
        d = request.get_json(silent=True) or {}
        import_id = (d.get("import_id") or "").strip()
        if not import_id:
            return jsonify({"ok": False, "error": "no_import_selected"}), 400
        ok = start_job(lambda: do_find_import(import_id), "find", "Find emails (imported list)")
        return jsonify({"ok": ok, "error": None if ok else "a step is already running"})

    targets = {"scrape": (do_scrape, "collect", "Collect businesses"),
               "find": (do_find, "find", "Find emails"),
               "send": (do_send, "send", "Send campaign"),
               "all": (do_all, "collect", "Collect + find")}
    if stage not in targets:
        return jsonify({"ok": False, "error": "unknown step"}), 400
    fn, step, kind = targets[stage]
    ok = start_job(fn, step, kind)
    return jsonify({"ok": ok, "error": None if ok else "a step is already running"})


@app.route("/stop", methods=["POST"])
def stop():
    STOP.set()
    return jsonify({"ok": True})


@app.route("/unsubscribes/sync", methods=["POST"])
def unsub_sync():
    if JOB["running"]:
        return jsonify({"ok": False, "error": "a step is already running"})
    cfg = load_config()
    n = poll_unsubscribes(cfg)
    return jsonify({"ok": True, "added": n})


@app.route("/imports/upload", methods=["POST"])
def imports_upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "no_file"}), 400
    if request.content_length and request.content_length > MAX_IMPORT_BYTES:
        return jsonify({"ok": False, "error": "too_large"}), 400
    raw = f.read(MAX_IMPORT_BYTES + 1)
    if len(raw) > MAX_IMPORT_BYTES:
        return jsonify({"ok": False, "error": "too_large"}), 400
    try:
        text = raw.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        headers = reader.fieldnames or []
        rows = list(reader)
    except Exception:
        return jsonify({"ok": False, "error": "bad_csv"}), 400
    if not headers:
        return jsonify({"ok": False, "error": "empty_csv"}), 400

    suggested_email_col = next((h for h in headers if "email" in h.lower()), None)
    suggested_name_col = _guess_name_col(headers)
    suggested_website_col = find_website_column(headers)
    iid = uuid.uuid4().hex[:12]
    _write_import({
        "id": iid, "filename": f.filename, "created": time.strftime("%Y-%m-%d %H:%M"),
        "headers": headers, "rows": rows, "row_count": len(rows),
        "suggested_email_col": suggested_email_col, "suggested_name_col": suggested_name_col,
        "suggested_website_col": suggested_website_col,
        "email_col": None, "name_col": None, "mapped": False,
        "valid_count": None, "skipped_count": None,
        "website_col": None, "find_mapped": False,
        "find_valid_count": None, "find_skipped_count": None, "found_count": None,
    })
    return jsonify({"ok": True, "id": iid, "filename": f.filename, "headers": headers,
                    "suggested_email_col": suggested_email_col,
                    "suggested_name_col": suggested_name_col,
                    "suggested_website_col": suggested_website_col, "row_count": len(rows)})


@app.route("/imports/list")
def imports_list():
    _imports_ensure()
    out = []
    for fn in os.listdir(IMPORTS_DIR):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(IMPORTS_DIR, fn), encoding="utf-8") as f:
                o = json.load(f)
            out.append({"id": o.get("id"), "filename": o.get("filename", "Untitled.csv"),
                        "created": o.get("created", ""), "row_count": o.get("row_count", 0),
                        "mapped": bool(o.get("mapped")), "email_col": o.get("email_col"),
                        "name_col": o.get("name_col"), "valid_count": o.get("valid_count"),
                        "skipped_count": o.get("skipped_count"),
                        "find_mapped": bool(o.get("find_mapped")), "website_col": o.get("website_col"),
                        "find_valid_count": o.get("find_valid_count"),
                        "find_skipped_count": o.get("find_skipped_count"),
                        "found_count": o.get("found_count")})
        except Exception:
            pass
    out.sort(key=lambda x: x.get("created", ""), reverse=True)
    return jsonify(out)


@app.route("/imports/<iid>/map", methods=["POST"])
def imports_map(iid):
    rec = _read_import(iid)
    if not rec:
        return jsonify({"ok": False, "error": "not_found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    email_col = (d.get("email_col") or "").strip()
    name_col = (d.get("name_col") or "").strip()
    headers = rec.get("headers", [])
    if email_col not in headers:
        return jsonify({"ok": False, "error": "bad_email_column"}), 400
    if name_col and name_col not in headers:
        name_col = None

    valid = skipped = 0
    for row in rec.get("rows", []):
        if EMAIL_RE.fullmatch((row.get(email_col) or "").strip()):
            valid += 1
        else:
            skipped += 1

    rec["email_col"] = email_col
    rec["name_col"] = name_col or None
    rec["mapped"] = True
    rec["valid_count"] = valid
    rec["skipped_count"] = skipped
    _write_import(rec)
    return jsonify({"ok": True, "valid": valid, "skipped": skipped})


@app.route("/imports/<iid>/map_find", methods=["POST"])
def imports_map_find(iid):
    rec = _read_import(iid)
    if not rec:
        return jsonify({"ok": False, "error": "not_found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    website_col = (d.get("website_col") or "").strip()
    name_col = (d.get("name_col") or "").strip()
    headers = rec.get("headers", [])
    if website_col not in headers:
        return jsonify({"ok": False, "error": "bad_website_column"}), 400
    if name_col and name_col not in headers:
        name_col = None

    valid = skipped = 0
    for row in rec.get("rows", []):
        if (row.get(website_col) or "").strip():
            valid += 1
        else:
            skipped += 1

    rec["website_col"] = website_col
    rec["name_col"] = name_col or None
    rec["find_mapped"] = True
    rec["find_valid_count"] = valid
    rec["find_skipped_count"] = skipped
    _write_import(rec)
    return jsonify({"ok": True, "valid": valid, "skipped": skipped})



# ===================== TOOLS: MARKET / INVOICE / AGREEMENT =====================
# Three extra tools bundled into the same app. All run locally and cost nothing
# to operate: Market uses the student's own Places key; Invoice/Agreement build
# self-contained printable HTML (saved as PDF from the browser), and the UPI QR
# is generated offline. No third-party paid service is called.
import html as _html

CURRENCY = {
    "INR": "\u20b9", "USD": "$", "AED": "AED ", "EUR": "\u20ac",
    "GBP": "\u00a3", "AUD": "A$", "CAD": "C$", "SGD": "S$",
}


def _h(s):
    return _html.escape(str(s if s is not None else ""))


def _safe_http_url(u):
    """User-entered payment links become clickable hrefs in generated invoice
    HTML - restrict to http(s) so a javascript:/data:/file: value can never
    become a live link. Returns "" for anything else."""
    u = (u or "").strip()
    return u if u.lower().startswith(("http://", "https://")) else ""


def _money(amount, cur="USD"):
    sym = CURRENCY.get(cur, "")
    try:
        n = float(amount)
    except Exception:
        n = 0.0
    return f"{sym}{n:,.2f}"


def fy_string(t=None):
    lt = time.localtime(t or time.time())
    start = lt.tm_year if lt.tm_mon >= 4 else lt.tm_year - 1   # Indian FY: April-March
    return f"{start}-{str(start + 1)[2:]}"


def next_invoice_no(cfg):
    year = time.strftime("%Y")
    if cfg.get("invoice_fy") != year:          # field name kept for config compat
        cfg["invoice_fy"] = year
        cfg["invoice_seq"] = 0
    cfg["invoice_seq"] = int(cfg.get("invoice_seq", 0) or 0) + 1
    save_config(cfg)
    return f"INV-{year}-{cfg['invoice_seq']:03d}"


def upi_link(vpa, name, amount, note, cur="INR"):
    """Build a standards-compliant UPI deep link (free, no account/API needed).
    Only meaningful for INR; returns '' otherwise."""
    vpa = (vpa or "").strip()
    if not vpa or "@" not in vpa or cur != "INR":
        return ""
    parts = [("pa", vpa), ("pn", name or ""), ("cu", "INR")]
    try:
        parts.append(("am", f"{float(amount):.2f}"))
    except Exception:
        pass
    if note:
        parts.append(("tn", str(note)[:50]))
    return "upi://pay?" + "&".join(f"{k}={quote(str(v))}" for k, v in parts if v)


def qr_svg(data, px=150):
    """Offline QR as inline SVG. No external service. Empty string if qrcode
    isn't available so the document still renders."""
    if not data:
        return ""
    try:
        import qrcode
        import qrcode.image.svg as _svgmod
        qr = qrcode.QRCode(box_size=10, border=2)
        qr.add_data(data)
        qr.make(fit=True)
        img = qr.make_image(image_factory=_svgmod.SvgPathImage)
        raw = img.to_string().decode("utf-8")
        raw = re.sub(r"<\?xml[^>]*\?>", "", raw).strip()
        raw = re.sub(r'\s(width|height)="[^"]*"', "", raw, count=2)
        raw = raw.replace("<svg ", f'<svg style="width:{px}px;height:{px}px" ', 1)
        return raw
    except Exception:
        return ""


# ---------- shared document chrome ----------
DOC_CSS = """
*{box-sizing:border-box} body{margin:0;background:#f0ede4;color:#241f12;
 font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{position:sticky;top:0;display:flex;gap:10px;justify-content:center;padding:12px;background:#241f12}
.bar button{font:600 14px/1 inherit;border:0;border-radius:8px;padding:11px 18px;cursor:pointer;background:#8a6a1f;color:#fff}
.bar button.alt{background:#57503c}
.sheet{max-width:820px;margin:22px auto;background:#fff;padding:46px 52px;
 box-shadow:0 8px 40px rgba(0,0,0,.12);border-radius:4px}
h1.doc{font-size:30px;letter-spacing:.06em;text-transform:uppercase;margin:0 0 2px;color:#7a5f1d}
.row{display:flex;justify-content:space-between;gap:30px;flex-wrap:wrap}
.muted{color:#6a7064;font-size:13px}
.bizname{font-size:19px;font-weight:700}
.blk{margin:18px 0}
.lbl{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8a9081;margin-bottom:5px}
table{width:100%;border-collapse:collapse;margin:14px 0}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a9081;text-align:left;
 border-bottom:2px solid #7a5f1d;padding:9px 8px}
td{padding:10px 8px;border-bottom:1px solid #e6e4dc;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}
.tot{margin-left:auto;width:300px;margin-top:10px}
.tot .r{display:flex;justify-content:space-between;padding:6px 8px}
.tot .grand{border-top:2px solid #7a5f1d;margin-top:6px;font-weight:700;font-size:17px;color:#7a5f1d}
.pay{display:flex;gap:22px;align-items:center;margin-top:8px;flex-wrap:wrap}
.pill{display:inline-block;background:#7a5f1d;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px}
.note{font-size:13px;color:#555b50;white-space:pre-wrap}
.sign{margin-top:46px;display:flex;justify-content:space-between;gap:30px}
.sign .l{width:46%}
.sign .line{border-top:1px solid #2c3128;margin-top:40px;padding-top:6px;font-size:13px;color:#6a7064}
.foot{margin-top:30px;font-size:11px;color:#9098886;border-top:1px solid #e6e4dc;padding-top:12px}
.clause{margin:14px 0}.clause h3{font-size:14px;margin:0 0 4px;color:#7a5f1d}
.clause p{margin:0;font-size:13.5px;color:#33372e}
@media print{.bar{display:none}.sheet{box-shadow:none;margin:0;max-width:none;border-radius:0;padding:24px 30px}body{background:#fff}}
"""


def _doc(title, inner):
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{_h(title)}</title><style>" + DOC_CSS + "</style></head><body>"
            "<div class='bar'><button onclick='window.print()'>Print / Save as PDF</button>"
            "<button class='alt' onclick='window.close()'>Close</button></div>"
            f"<div class='sheet'>{inner}</div></body></html>")


# ---------- Invoice ----------
def invoice_numeric_value(value, label, default):
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"{label} must be a valid number.")
    if isinstance(value, bool) or not math.isfinite(number) or number < 0 or number > 1e12:
        raise ValueError(f"{label} must be a finite amount between 0 and 1 trillion.")
    return number


def validate_invoice(payload):
    if not isinstance(payload, dict):
        raise ValueError("Invalid invoice. Please review the form.")
    result = dict(payload)
    for key in ("business", "client"):
        if result.get(key) is not None and not isinstance(result[key], dict):
            raise ValueError("Invalid invoice details.")
    items = result.get("items") or []
    if not isinstance(items, list):
        raise ValueError("Invoice items must be a list.")
    normalized = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("desc", ""), str):
            raise ValueError("Invalid invoice item.")
        if not item.get("desc", "").strip():
            continue
        normalized.append(dict(item,
            qty=invoice_numeric_value(item.get("qty"), "Quantity", 1),
            rate=invoice_numeric_value(item.get("rate"), "Item rate", 0)))
    result["items"] = normalized
    result["gst_rate"] = invoice_numeric_value(result.get("gst_rate"), "Tax rate",
                                        18 if result.get("gst_mode") == "gst" else 0)
    return result


def build_invoice_html(p):
    p = validate_invoice(p)
    b = p.get("business", {}) or {}
    c = p.get("client", {}) or {}
    items = [it for it in (p.get("items") or []) if (it.get("desc") or "").strip()]
    cur = p.get("currency") or b.get("default_currency") or "USD"
    mode = p.get("gst_mode") or "none"          # none | percent | gst | export
    supply = p.get("supply_type") or "intra"     # intra | inter (GST only)
    rate = p["gst_rate"]
    sub = 0.0
    rows_html = ""
    for i, it in enumerate(items, 1):
        qty = it["qty"]
        price = it["rate"]
        amt = qty * price
        sub += amt
        sac = f"<div class='muted'>SAC {_h(it['sac'])}</div>" if (mode == "gst" and it.get("sac")) else ""
        rows_html += (f"<tr><td>{i}</td><td>{_h(it.get('desc'))}{sac}</td>"
                      f"<td class='n'>{qty:g}</td><td class='n'>{_money(price, cur)}</td>"
                      f"<td class='n'>{_money(amt, cur)}</td></tr>")

    tax = sub * rate / 100 if mode in ("gst", "percent") else 0.0
    total = sub + tax

    title = "Tax Invoice" if mode == "gst" else "Invoice"
    biz_lines = "<br>".join(_h(x) for x in [b.get("address"), b.get("email"), b.get("phone")] if x)
    if b.get("gstin"):
        tid_lbl = "GSTIN" if mode == "gst" else "Tax ID"
        biz_lines += f"<br>{tid_lbl}: {_h(b['gstin'])}"
    cli_lines = "<br>".join(_h(x) for x in [c.get("address"), c.get("email")] if x)
    if mode == "gst" and c.get("gstin"):
        cli_lines += f"<br>GSTIN: {_h(c['gstin'])}"

    tot = "<div class='tot'>"
    tot += f"<div class='r'><span>Subtotal</span><span>{_money(sub, cur)}</span></div>"
    if mode == "percent":
        tot += f"<div class='r'><span>Sales tax @ {rate:g}%</span><span>{_money(tax, cur)}</span></div>"
    elif mode == "gst":
        if supply == "inter":
            tot += f"<div class='r'><span>IGST @ {rate:g}%</span><span>{_money(tax, cur)}</span></div>"
        else:
            tot += f"<div class='r'><span>CGST @ {rate/2:g}%</span><span>{_money(tax/2, cur)}</span></div>"
            tot += f"<div class='r'><span>SGST @ {rate/2:g}%</span><span>{_money(tax/2, cur)}</span></div>"
    tot += f"<div class='r grand'><span>Total due</span><span>{_money(total, cur)}</span></div></div>"

    # payment block - works worldwide: UPI (India), online links (Stripe/PayPal/
    # Wise/etc), and bank/wire details. A scannable QR is offered for whatever
    # the primary method is.
    pay = ""
    upi = upi_link(b.get("upi"), b.get("name"), total, f"Invoice {p.get('number','')}", cur)
    primary_link = _safe_http_url(b.get("payment_link"))
    second_link = _safe_http_url(b.get("payment_link2"))
    qr, qr_cap = "", ""
    if upi:
        qr, qr_cap = qr_svg(upi), "Scan to pay via UPI"
    elif primary_link:
        qr, qr_cap = qr_svg(primary_link), "Scan to pay online"
    paybits = []
    if qr:
        paybits.append(f"<div style='text-align:center'>{qr}"
                       f"<div class='muted' style='margin-top:4px'>{qr_cap}</div></div>")

    methods = []
    if upi:
        methods.append(f"<a class='pill' href='{_h(upi)}'>Pay {_money(total, cur)} via UPI</a>")
    if primary_link:
        methods.append(f"<a class='pill' href='{_h(primary_link)}'>{_h(b.get('payment_link_label') or 'Pay online')}</a>")
    if second_link:
        methods.append(f"<a class='pill' href='{_h(second_link)}'>{_h(b.get('payment_link2_label') or 'Pay online')}</a>")
    detail = []
    if upi:
        detail.append(f"UPI ID: {_h(b['upi'])}")
    if b.get("bank_details"):
        detail.append("<span class='lbl' style='margin:8px 0 2px'>Bank transfer</span>"
                      f"<div class='note'>{_h(b['bank_details'])}</div>")
    rightcol = ""
    if methods:
        rightcol += "".join(f"<div style='margin-bottom:8px'>{m}</div>" for m in methods)
    if detail:
        rightcol += "<div class='muted' style='margin-top:6px'>" + "".join(
            d if d.startswith("<span") else f"<div>{d}</div>" for d in detail) + "</div>"
    if rightcol:
        paybits.append(f"<div>{rightcol}</div>")
    if paybits:
        pay = "<div class='blk'><div class='lbl'>Payment</div><div class='pay'>" + "".join(paybits) + "</div></div>"

    notes = ""
    note_txt = p.get("notes") or b.get("terms") or ""
    if mode == "export":
        note_txt = ("Tax exempt / zero-rated supply - no tax charged. " + note_txt).strip()
    if note_txt:
        notes = f"<div class='blk'><div class='lbl'>Notes</div><div class='note'>{_h(note_txt)}</div></div>"

    decl = ""
    if mode == "gst":
        pos = f" &nbsp;|&nbsp; Place of supply: {_h(p.get('place_of_supply'))}" if p.get("place_of_supply") else ""
        decl = ("<div class='foot'>We declare that this invoice shows the actual price of the "
                "services described and that all particulars are true and correct." + pos + "</div>")

    inner = (
        f"<div class='row'><div><div class='bizname'>{_h(b.get('name') or 'Your Business')}</div>"
        f"<div class='muted'>{biz_lines}</div></div>"
        f"<div style='text-align:right'><h1 class='doc'>{title}</h1>"
        f"<div class='muted'># {_h(p.get('number'))}<br>Date: {_h(p.get('date'))}"
        + (f"<br>Terms: {_h(p.get('terms'))}" if p.get("terms") else "")
        + (f"<br>Due: {_h(p.get('due'))}" if p.get("due") else "")
        + (f"<br>PO: {_h(p.get('po'))}" if p.get("po") else "") + "</div></div></div>"
        f"<div class='blk'><div class='lbl'>Bill to</div><div><b>{_h(c.get('name') or 'Client')}</b>"
        f"<br><span class='muted'>{cli_lines}</span></div></div>"
        "<table><thead><tr><th>#</th><th>Description</th><th class='n'>Qty</th>"
        "<th class='n'>Rate</th><th class='n'>Amount</th></tr></thead><tbody>"
        + (rows_html or "<tr><td colspan='5' class='muted'>No items</td></tr>")
        + "</tbody></table>" + tot + pay + notes + decl
        + "<div class='foot'>Thank you for your business.</div>"
    )
    return _doc(f"Invoice {p.get('number','')}", inner)


# ---------- Service Agreement ----------
def build_agreement_html(p):
    b = p.get("business", {}) or {}
    c = p.get("client", {}) or {}
    cur = p.get("currency") or b.get("default_currency") or "USD"
    prov = b.get("name") or "the Service Provider"
    cli = c.get("name") or "the Client"
    law = p.get("governing_law") or "United States"

    def clause(h, body):
        return f"<div class='clause'><h3>{_h(h)}</h3><p>{_h(body)}</p></div>"

    fee_txt = p.get("fee") or ""
    pay_terms = p.get("payment_terms") or (
        "50% in advance before work begins and the balance on completion, payable within 7 days of each invoice.")
    _pt = pay_terms.strip()
    if _pt and _pt[-1] not in ".!?":
        _pt += "."
    pay_terms = _pt
    timeline = p.get("timeline") or "as mutually agreed in writing"
    revisions = p.get("revisions") or "two (2)"
    scope = p.get("scope") or "the services described by the parties in writing"

    body = (
        f"<h1 class='doc' style='font-size:24px'>Service Agreement</h1>"
        f"<p class='muted'>Effective date: {_h(p.get('date'))}</p>"
        f"<p>This Service Agreement (\"Agreement\") is made between <b>{_h(prov)}</b>"
        + (f", {_h(b.get('address'))}" if b.get("address") else "") + " (\"Service Provider\") and <b>"
        + f"{_h(cli)}</b>" + (f", {_h(c.get('address'))}" if c.get("address") else "")
        + " (\"Client\"). By signing below, both parties agree to the following terms.</p>"
        + clause("1. Services", f"The Service Provider will provide {scope} (the \"Services\").")
        + clause("2. Term", f"This Agreement begins on the effective date and continues until the Services are completed or it is terminated under Section 10. Expected timeline: {timeline}.")
        + clause("3. Fees", (f"The Client will pay {fee_txt} for the Services." if fee_txt else "The Client will pay the fees agreed in writing for the Services.") + f" All amounts are in {cur} and exclusive of applicable taxes unless stated otherwise.")
        + clause("4. Payment terms", pay_terms + " Late payments may pause work until resolved.")
        + clause("5. Expenses", "Any third-party costs (e.g. domains, hosting, ad spend, paid tools, stock assets) are billed to or paid directly by the Client and are not included in the fees above unless expressly stated.")
        + clause("6. Revisions", f"The fee includes {revisions} round(s) of reasonable revisions to the agreed deliverables. Further changes or new requirements may be quoted separately.")
        + clause("7. Client responsibilities", "The Client will provide timely access, content, approvals, credentials, and feedback needed to perform the Services. Delays caused by the Client may extend the timeline.")
        + clause("8. Intellectual property", "On full and final payment, the Service Provider assigns to the Client the rights in the final deliverables created specifically for the Client. Until full payment, all rights remain with the Service Provider. The Service Provider retains ownership of its pre-existing tools, code, and know-how, and may show non-confidential work in its portfolio.")
        + clause("9. Confidentiality", "Each party will keep the other's non-public information confidential and use it only to perform or receive the Services.")
        + clause("10. Independent contractor", "The Service Provider is an independent contractor, not an employee, partner, or agent of the Client, and is responsible for its own taxes.")
        + clause("11. Warranties and disclaimer", "The Service Provider will perform the Services with reasonable skill and care. Except as stated, the Services are provided \"as is\". The Service Provider does not guarantee any specific business, ranking, traffic, or revenue outcome.")
        + clause("12. Limitation of liability", "To the maximum extent permitted by law, neither party is liable for indirect or consequential loss, and the Service Provider's total liability under this Agreement will not exceed the total fees paid by the Client for the Services.")
        + clause("13. Termination", "Either party may terminate with seven (7) days' written notice. The Client will pay for all work performed up to termination. Sections 8, 9, 11, 12 and 15 survive termination.")
        + clause("14. Force majeure", "Neither party is liable for delay or failure caused by events beyond its reasonable control.")
        + clause("15. Governing law", f"This Agreement is governed by the laws of {law}, and the parties submit to the courts having jurisdiction there.")
        + clause("16. Entire agreement", "This document is the entire agreement between the parties about the Services and replaces any prior discussions. Changes must be in writing and signed by both parties.")
        + "<div class='sign'>"
        + f"<div class='l'><div class='line'>Service Provider - {_h(prov)}</div></div>"
        + f"<div class='l'><div class='line'>Client - {_h(cli)}</div></div></div>"
        + "<div class='foot'>Template provided for convenience only and is not legal advice. "
        "Have a qualified lawyer review it for your situation and jurisdiction before relying on it.</div>"
    )
    return _doc("Service Agreement", body)


@app.route("/invoice/build", methods=["POST"])
def invoice_build():
    try:
        p = validate_invoice(request.get_json(silent=True))
        for key in ("number", "date"):
            if not isinstance(p.get(key, ""), str):
                raise ValueError("Invalid invoice " + key + ".")
    except ValueError as error:
        return jsonify(ok=False, error=str(error)), 400
    cfg = load_config()
    if not (p.get("number") or "").strip():
        p["number"] = next_invoice_no(cfg)
    if not (p.get("date") or "").strip():
        p["date"] = time.strftime("%b %d, %Y")
    return jsonify({"ok": True, "number": p["number"], "html": build_invoice_html(p)})


@app.route("/agreement/build", methods=["POST"])
def agreement_build():
    p = request.get_json(force=True) or {}
    if not (p.get("date") or "").strip():
        p["date"] = time.strftime("%b %d, %Y")
    return jsonify({"ok": True, "html": build_agreement_html(p)})

@app.route("/history")
def history():
    return jsonify(load_history())


@app.route("/version")
def version():
    return jsonify({"name": APP_NAME, "version": APP_VERSION, "art": "inline"})


@app.route("/status")
def status():
    return jsonify({
        "running": JOB["running"],
        "stage": JOB["stage"],
        "step": JOB["step"],
        "kind": JOB["kind"],
        "attention": JOB["attention"],
        "attention_msg": JOB["attention_msg"],
        "counts": JOB["counts"],
        "log": JOB["log"][-200:],
    })


@app.route("/logs/clear", methods=["POST"])
def logs_clear():
    with JOB_LOCK:
        JOB["log"] = []
    return jsonify({"ok": True})



# ===================== SHEETS (lead-list spreadsheets) =====================
import os as _os, time as _time, json as _json, uuid as _uuid, base64 as _b64
from flask import Response as _Resp

_XS_JS_GZ_B64 = "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"
_XS_CSS_GZ_B64 = "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"

@app.route("/vendor/xspreadsheet.js")
def _xs_js():
    return _Resp(_b64.b64decode(_XS_JS_GZ_B64), mimetype="application/javascript",
                 headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=31536000"})

@app.route("/vendor/xspreadsheet.css")
def _xs_css():
    return _Resp(_b64.b64decode(_XS_CSS_GZ_B64), mimetype="text/css",
                 headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=31536000"})

_XS_SVG1_GZ_B64 = "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"
_XS_SVG2_GZ_B64 = "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"

@app.route("/vendor/58eaeb4e52248a5c75936c6f4c33a370.svg")
def _xs_svg1():
    return _Resp(_b64.b64decode(_XS_SVG1_GZ_B64), mimetype="image/svg+xml",
                 headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=31536000"})

@app.route("/vendor/ece3e4fa05d4292823fdef970eaf1233.svg")
def _xs_svg2():
    return _Resp(_b64.b64decode(_XS_SVG2_GZ_B64), mimetype="image/svg+xml",
                 headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=31536000"})

def _sheets_ensure():
    _os.makedirs(SHEETS_DIR, exist_ok=True)

def _sheet_path(sid):
    sid = "".join(c for c in str(sid) if c.isalnum())
    return _os.path.join(SHEETS_DIR, sid + ".json")

def _read_sheet(sid):
    p = _sheet_path(sid)
    if not _os.path.exists(p): return None
    try:
        with open(p, encoding="utf-8") as f: return _json.load(f)
    except Exception: return None

def _write_sheet(obj):
    _sheets_ensure()
    with open(_sheet_path(obj["id"]), "w", encoding="utf-8") as f: _json.dump(obj, f)

@app.route("/sheets/list")
def sheets_list():
    _sheets_ensure(); out = []
    for fn in _os.listdir(SHEETS_DIR):
        if not fn.endswith(".json"): continue
        try:
            with open(_os.path.join(SHEETS_DIR, fn), encoding="utf-8") as f: o = _json.load(f)
            out.append({"id": o.get("id"), "name": o.get("name", "Untitled"),
                        "updated": o.get("updated", ""),
                        "followup": bool((o.get("followup") or {}).get("enabled"))})
        except Exception: pass
    out.sort(key=lambda x: x.get("updated", ""), reverse=True)
    return jsonify(out)

@app.route("/sheets/new", methods=["POST"])
def sheets_new():
    d = request.get_json(force=True, silent=True) or {}
    name = (d.get("name") or "Untitled list").strip()[:80]
    sid = _uuid.uuid4().hex[:12]; now = _time.strftime("%Y-%m-%d %H:%M")
    obj = {"id": sid, "name": name, "created": now, "updated": now,
           "followup": {"enabled": False}, "data": {}}
    _write_sheet(obj)
    return jsonify({"id": sid, "name": name})

@app.route("/sheets/<sid>")
def sheets_get(sid):
    o = _read_sheet(sid)
    if not o: return jsonify({"error": "not_found"}), 404
    return jsonify(o)

@app.route("/sheets/<sid>", methods=["POST"])
def sheets_save(sid):
    o = _read_sheet(sid)
    if not o: return jsonify({"error": "not_found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    if "data" in d: o["data"] = d["data"]
    o["updated"] = _time.strftime("%Y-%m-%d %H:%M"); _write_sheet(o)
    return jsonify({"ok": True, "updated": o["updated"]})

@app.route("/sheets/<sid>/rename", methods=["POST"])
def sheets_rename(sid):
    o = _read_sheet(sid)
    if not o: return jsonify({"error": "not_found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    o["name"] = (d.get("name") or o["name"]).strip()[:80]
    o["updated"] = _time.strftime("%Y-%m-%d %H:%M"); _write_sheet(o)
    return jsonify({"ok": True, "name": o["name"]})

@app.route("/sheets/<sid>/delete", methods=["POST"])
def sheets_delete(sid):
    p = _sheet_path(sid)
    try:
        if _os.path.exists(p): _os.remove(p)
    except Exception: pass
    return jsonify({"ok": True})


# ---- follow-up + scrape-to-sheet ----
import re as _re

FU_COLS = ["Follow up", "Channel", "Status"]
FU_FOLLOWUP_OPTS = "Required,"
FU_CHANNEL_OPTS = "Email,Phone/SMS,WhatsApp"

def _xs_first(data):
    if isinstance(data, list):
        return data[0] if data else None
    if isinstance(data, dict) and data:
        return data
    return None

def _col_letter(n):
    s = ""; n += 1
    while n:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s

def _cell_text(cells, c):
    cell = (cells or {}).get(str(c))
    return ((cell or {}).get("text") or "").strip() if cell else ""

def _header_map(sheet):
    rows = sheet.get("rows") or {}
    r0 = (rows.get("0") or {}).get("cells") or {}
    out = {}
    for k, v in r0.items():
        try: out[int(k)] = (v.get("text") or "").strip()
        except Exception: pass
    return out

def _max_used_col(sheet):
    rows = sheet.get("rows") or {}; mx = -1
    for rk, rv in rows.items():
        if rk == "len": continue
        for ck in ((rv or {}).get("cells") or {}):
            try:
                ci = int(ck)
                if ci > mx: mx = ci
            except Exception: pass
    return mx

def _set_cell(sheet, r, c, text):
    rows = sheet.setdefault("rows", {})
    row = rows.setdefault(str(r), {})
    row.setdefault("cells", {})[str(c)] = {"text": text}

def _ensure_fu_columns(sheet):
    hdr = _header_map(sheet)
    have = {v: k for k, v in hdr.items()}
    nxt = _max_used_col(sheet) + 1
    cols = {}
    for name in FU_COLS:
        if name in have:
            cols[name] = have[name]
        else:
            cols[name] = nxt; _set_cell(sheet, 0, nxt, name); nxt += 1
    fu_letters = {_col_letter(cols["Follow up"]), _col_letter(cols["Channel"])}
    vals = [v for v in (sheet.get("validations") or [])
            if not (v.get("refs") and any(_re.sub(r"[0-9]", "", ref.split(":")[0]) in fu_letters for ref in v["refs"]))]
    def vrow(col, opts):
        L = _col_letter(col)
        return {"refs": ["%s2:%s1000" % (L, L)], "mode": "cell", "type": "list",
                "required": False, "operator": "be", "value": opts}
    vals.append(vrow(cols["Follow up"], FU_FOLLOWUP_OPTS))
    vals.append(vrow(cols["Channel"], FU_CHANNEL_OPTS))
    sheet["validations"] = vals
    c = sheet.setdefault("cols", {})
    c["len"] = max(int(c.get("len", 26) or 26), cols["Status"] + 2)
    return cols

@app.route("/sheets/<sid>/followup/enable", methods=["POST"])
def sheets_fu_enable(sid):
    o = _read_sheet(sid)
    if not o: return jsonify({"error": "not_found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    data = o.get("data")
    if not isinstance(data, list) or not data:
        data = [{"name": o.get("name", "Sheet1")}]
    cols = _ensure_fu_columns(data[0])
    o["data"] = data
    o["followup"] = {"enabled": True, "subject": (d.get("subject") or "").strip(),
                     "body": (d.get("body") or "").strip(), "cols": cols,
                     "updated": _time.strftime("%Y-%m-%d %H:%M")}
    o["updated"] = _time.strftime("%Y-%m-%d %H:%M"); _write_sheet(o)
    return jsonify({"ok": True, "cols": cols})

@app.route("/sheets/<sid>/followup/disable", methods=["POST"])
def sheets_fu_disable(sid):
    o = _read_sheet(sid)
    if not o: return jsonify({"error": "not_found"}), 404
    fu = o.get("followup") or {}; fu["enabled"] = False; o["followup"] = fu; _write_sheet(o)
    return jsonify({"ok": True})

@app.route("/sheets/<sid>/followup/start", methods=["POST"])
def sheets_fu_start(sid):
    o = _read_sheet(sid)
    if not o: return jsonify({"error": "not_found"}), 404
    fu = o.get("followup") or {}
    if not fu.get("enabled"): return jsonify({"error": "not_enabled"}), 400
    sheet = _xs_first(o.get("data"))
    if not sheet: return jsonify({"error": "empty"}), 400
    hdr = _header_map(sheet)
    n2c = {v.strip().lower(): k for k, v in hdr.items()}
    cols = fu.get("cols") or {}
    fu_col = cols.get("Follow up", n2c.get("follow up"))
    ch_col = cols.get("Channel", n2c.get("channel"))
    st_col = cols.get("Status", n2c.get("status"))
    if fu_col is None or ch_col is None: return jsonify({"error": "no_columns"}), 400
    if st_col is None:
        st_col = _max_used_col(sheet) + 1; _set_cell(sheet, 0, st_col, "Status")
    email_col = next((ci for ci, h in hdr.items() if "email" in h.lower()), None)
    cfg = load_config()
    dry = bool(cfg.get("test_mode", True))
    accounts = [a for a in cfg.get("sender_accounts", [])
                if a.get("email") and (a.get("app_password") or a.get("smtp_password"))]
    if not dry:
        if not accounts: return jsonify({"error": "no_account"}), 400
        if not (cfg.get("physical_address") or "").strip(): return jsonify({"error": "no_address"}), 400
    subj_t = fu.get("subject") or ""; body_t = fu.get("body") or ""
    rows = sheet.get("rows") or {}
    ris = sorted(int(k) for k in rows if k != "len" and str(k).isdigit() and int(k) >= 1)
    sent = failed = no_email = 0; manual = []; conns = {}; idx = 0

    def _send(acct, to, subj, body):
        if acct["email"] not in conns:
            host = (acct.get("smtp_host") or "smtp.gmail.com").strip()
            port = int(acct.get("smtp_port") or (587 if host != "smtp.gmail.com" else 465))
            user = (acct.get("smtp_user") or acct["email"]).strip()
            pw = (acct.get("app_password") or acct.get("smtp_password") or "").replace(" ", "")
            ctx = ssl.create_default_context()
            if port == 465:
                s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
            else:
                s = smtplib.SMTP(host, port, timeout=30); s.ehlo()
                try: s.starttls(context=ctx); s.ehlo()
                except Exception: pass
            s.login(user, pw); conns[acct["email"]] = s
        from_addr = acct.get("from_addr") or acct["email"]; nm = acct.get("name") or ""
        msg = EmailMessage()
        msg["From"] = ("%s <%s>" % (nm, from_addr)) if nm else from_addr
        msg["Reply-To"] = from_addr; msg["To"] = to; msg["Subject"] = subj
        msg["List-Unsubscribe"] = "<mailto:%s?subject=unsubscribe>" % from_addr
        msg.set_content(body); conns[acct["email"]].send_message(msg)

    for r in ris:
        cells = (rows.get(str(r)) or {}).get("cells") or {}
        if _cell_text(cells, fu_col).lower() != "required": continue
        channel = _cell_text(cells, ch_col)
        ctxd = {}
        for ci, h in hdr.items():
            ctxd[_re.sub(r"\s+", "", h.strip().lower())] = _cell_text(cells, ci)
        subj = subj_t.format_map(_SafeTokens(ctxd)); body = body_t.format_map(_SafeTokens(ctxd))
        if channel == "Email":
            to = _cell_text(cells, email_col) if email_col is not None else ""
            if "@" not in to: _set_cell(sheet, r, st_col, "No email"); no_email += 1; continue
            if dry: _set_cell(sheet, r, st_col, "Sent (test)"); sent += 1; continue
            acct = accounts[idx % len(accounts)]; idx += 1
            try: _send(acct, to, subj, body); _set_cell(sheet, r, st_col, "Sent"); sent += 1
            except Exception: _set_cell(sheet, r, st_col, "Failed"); failed += 1
        elif channel in ("Phone/SMS", "WhatsApp"):
            _set_cell(sheet, r, st_col, "Manual - " + channel)
            phone = next((_cell_text(cells, ci) for ci, h in hdr.items()
                          if "phone" in h.lower() or "whats" in h.lower()), "")
            nm = next((_cell_text(cells, ci) for ci, h in hdr.items()
                       if h.lower() in ("name", "business", "business name")), "")
            manual.append({"row": r + 1, "name": nm, "channel": channel, "phone": phone})
        else:
            _set_cell(sheet, r, st_col, "Pick a channel")
    for s in conns.values():
        try: s.quit()
        except Exception: pass
    o["updated"] = _time.strftime("%Y-%m-%d %H:%M"); _write_sheet(o)
    return jsonify({"ok": True, "sent": sent, "failed": failed, "no_email": no_email,
                    "manual": manual, "test_mode": dry})

def _rows_to_xs(name, headers, rows):
    sh = {"name": (name[:30] or "Leads"), "rows": {"len": max(100, len(rows) + 10)}}
    sh["rows"]["0"] = {"cells": {str(i): {"text": str(h)} for i, h in enumerate(headers)}}
    for ri, row in enumerate(rows, start=1):
        cells = {str(i): {"text": str(row.get(h, ""))} for i, h in enumerate(headers) if row.get(h, "")}
        if cells: sh["rows"][str(ri)] = {"cells": cells}
    sh["cols"] = {"len": max(26, len(headers) + 2)}
    return [sh]

def _read_latest_run_rows():
    rd = latest_run()
    if not rd: return [], []
    for sub in ("with_emails", "raw"):
        headers, rows, hit = [], [], False
        for root, _dirs, files in os.walk(rd):
            if os.path.basename(root) != sub: continue
            for fn in sorted(files):
                if not fn.lower().endswith(".csv") or fn.endswith(".tmp"): continue
                with open(os.path.join(root, fn), newline="", encoding="utf-8-sig") as f:
                    rdr = csv.DictReader(f)
                    for h in (rdr.fieldnames or []):
                        if h not in headers: headers.append(h)
                    for row in rdr: rows.append(row); hit = True
        if hit: return headers, rows
    return [], []

@app.route("/sheets/from_run", methods=["POST"])
def sheets_from_run():
    d = request.get_json(force=True, silent=True) or {}
    name = (d.get("name") or "").strip()[:80] or ("Leads " + _time.strftime("%Y-%m-%d %H:%M"))
    headers, rows = _read_latest_run_rows()
    if not rows: return jsonify({"error": "no_rows"}), 400
    sid = _uuid.uuid4().hex[:12]; now = _time.strftime("%Y-%m-%d %H:%M")
    _write_sheet({"id": sid, "name": name, "created": now, "updated": now,
                  "followup": {"enabled": False}, "data": _rows_to_xs(name, headers, rows)})
    return jsonify({"ok": True, "id": sid, "name": name, "rows": len(rows)})


from pages_store import register_pages
from crm_store import register_crm

register_crm(app, BASE, lambda: CSRF_TOKEN,
             lambda: license_state()[0] in ("ok", "grace"))

register_pages(app, BASE, RES_BASE, lambda: CSRF_TOKEN,
               lambda: license_state()[0] in ("ok", "grace"),
               SHEETS_DIR, _read_latest_run_rows)

INDEX_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__APP_NAME__</title>
<script src="/assets/theme-palettes.js?v=1"></script>
<script src="/assets/themes.js?v=2"></script>
<link rel="stylesheet" href="/assets/themes.css?v=1">
<link rel="stylesheet" href="/assets/theme-settings.css?v=2">
<link rel="icon" type="image/png" href="/assets/logo.png">
<script>window.__CSRF__="__CSRF_TOKEN__";(function(){var _f=window.fetch;window.fetch=function(u,o){o=o||{};try{var url=new URL(u,location.href);if(url.origin===location.origin){var h=new Headers(o.headers||{});h.set("X-CSRF-Token",window.__CSRF__);o.headers=h}}catch(e){}return _f.call(this,u,o)}})();window.__ART__=__ART_JSON__;window.__USER__="__USER_NAME__";window.__ROLE__="__USER_ROLE__";</script>
<style>
:root{
  /* surfaces — neutral charcoal, always dark */
  --canvas:#151514; --bg:#151514; --panel:#1C1C1B; --panel-2:#232322; --sink:#2A2A28;
  --ink:#EAEAE5; --ink-2:#D3D3CC; --muted:#9C9C93; --faint:#949489;
  --line:#2E2E2B; --line-2:#272726;
  /* accent gold — used sparingly — + intent */
  --pine:#C9A961; --pine-strong:#D8BC79; --pine-deep:#E5CE96; --pine-tint:#2B2718; --pine-wash:#232013;
  --on-accent:#201A0E;
  --teal:#84A97E; --teal-tint:#232B21; --slate:#8A8163;
  --ok:#84A97E; --ok-tint:#232B21;
  --warn:#D3A75F; --warn-tint:#2E2817; --warn-line:#463A20;
  --bad:#DE8B74; --bad-tint:#35211B; --bad-line:#4F2F26;
  /* terminal */
  --forest:#111110; --forest-2:#181817; --forest-ink:#DEDED6; --forest-mut:#84847B; --forest-line:#292927; --forest-accent:#C9A961;
  /* component tokens */
  --grad-card:#1C1C1B;
  --grad-head:#181817;
  --grad-btn:#242423;
  --grad-btn-hi:#2B2B29;
  --grad-gold:#C9A961;
  --grad-gold-hi:#D6B876;
  --gold-line:#A98D4C;
  --edge:rgba(255,255,255,.03);
  --field:#161615; --field-line:#30302D;
  --btn-line:#343431; --btn-ink:#D3D3CC;
  --card-line:#2B2B29;
  --gold-glow:rgba(201,169,97,.25);
  --gold-dim:rgba(201,169,97,.10);
  /* focus + elevation */
  --ring:rgba(201,169,97,.25);
  --shadow:0 1px 2px rgba(0,0,0,.3);
  --shadow-2:0 1px 2px rgba(0,0,0,.25),0 6px 18px rgba(0,0,0,.3);
  --shadow-3:0 24px 64px rgba(0,0,0,.5);
  /* type */
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Code","SF Mono","JetBrains Mono",Consolas,monospace;
  /* shape + rhythm */
  --r-sm:8px; --r:12px; --r-lg:16px; --r-xl:20px; --r-pill:999px;
  --ease:cubic-bezier(.2,.7,.2,1);
  /* accent alias (single source of truth for the one gold; --pine kept for back-compat) */
  --gold:var(--pine); --accent:var(--pine); --accent-hover:var(--pine-strong); --accent-tint:var(--pine-tint);
  /* type scale — two families, seven sizes, four weights */
  --fs-xs:11px; --fs-sm:12px; --fs-base:13px; --fs-md:14px; --fs-lg:16px; --fs-xl:20px; --fs-display:32px;
  /* spacing rhythm */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px; --sp-7:32px; --sp-8:48px;
  /* transitions */
  --t-fast:150ms; --t:200ms; --t-slow:300ms;
  /* one modal scrim everywhere */
  --scrim:rgba(12,12,11,.6);
  /* z-index ladder (fixed scale) */
  --z-nav:10; --z-topbar:30; --z-viewload:40; --z-banner:50; --z-toast:60; --z-chat:70; --z-editor:80; --z-modal:90; --z-boot:100; --z-tour:110;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--canvas);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.topbar{height:52px;flex:none;display:flex;align-items:center;gap:var(--sp-3);padding:0 var(--sp-5);background:var(--grad-head);border-bottom:1px solid var(--line-2);z-index:var(--z-topbar)}
.tb-brand{display:flex;align-items:center;gap:var(--sp-2);min-width:0}
.tb-nm{font-family:var(--sans);font-weight:700;font-size:var(--fs-lg);color:var(--ink);letter-spacing:-.015em}
.tb-tag{font:600 var(--fs-xs) var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:2px 0 0 2px}
.tb-sp{flex:1}
.shell{flex:1;display:flex;min-height:0}
::selection{background:rgba(201,169,97,.28)}
:focus-visible{outline:2px solid var(--pine);outline-offset:2px;border-radius:6px}
/* Navigation focus announces the new page without drawing a box around it.
   Keep focus rings on interactive controls, including keyboard-only tabs. */
.view[tabindex="-1"]:focus,
#settings-page-title:focus{outline:none!important;box-shadow:none!important}
[hidden]{display:none!important}
.skip{position:absolute;left:-9999px;top:8px;z-index:50;background:var(--pine);color:var(--on-accent);padding:8px 14px;border-radius:var(--r-sm);font-weight:600}
.skip:focus{left:12px}

/* ===== sidebar ===== */
.side{width:232px;flex:none;background:transparent;border-right:1px solid var(--line-2);display:flex;flex-direction:column;padding:var(--sp-4) var(--sp-3) var(--sp-3);z-index:var(--z-nav)}
.nav{position:relative;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.nav::-webkit-scrollbar{width:6px}
.nav::-webkit-scrollbar-track{background:transparent}
.nav::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px}
.nav::-webkit-scrollbar-thumb:hover{background:var(--faint)}
.navsec{position:relative;display:flex;flex-direction:column;gap:2px}
.navi{position:relative;z-index:1;display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2);border-radius:var(--r-sm);background:none;border:0;cursor:pointer;width:100%;text-align:left;font-family:inherit;transition:background var(--t-fast) var(--ease),box-shadow var(--t-fast) var(--ease)}
.navgroup{z-index:1;font:600 var(--fs-xs) var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--faint);padding:var(--sp-4) var(--sp-3) var(--sp-1);margin-top:var(--sp-1)}
.navsec.tools{padding-left:0}
/* group boundaries: one hairline where a header used to be. .rail-only shows
   only in the collapsed icon rail, where headers are hidden and the icons would
   otherwise run together. */
.navdiv{height:1px;background:var(--line);margin:var(--sp-3) var(--sp-2);flex:none}
.navdiv.rail-only{display:none}
.navspacer{flex:1 1 auto;min-height:var(--sp-4)}
.navi .step{width:17px;height:17px;display:grid;place-items:center;color:var(--faint);flex:none;transition:color .18s var(--ease)}
.navi .step svg{width:16px;height:16px;display:block;stroke:var(--faint)}
.navi:hover .step svg{stroke:var(--muted)}
.navi[aria-current=page] .step svg{stroke:var(--pine)}
.navi .navtext{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.navi .lbl{font-weight:500;font-size:var(--fs-base);color:var(--ink-2);letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.navi:hover{background:var(--panel-2)}
.navi:hover .step{color:var(--muted)}
.navi[aria-current=page]{background:rgba(255,255,255,.05);box-shadow:inset 2px 0 0 var(--accent)}
.navi[aria-current=page] .step{background:transparent;color:var(--accent)}
.navi[aria-current=page] .lbl{color:var(--ink);font-weight:600}
/* completed workflow step: green + check glyph (colour is never the only signal) */
.navi.done::after{content:"\2713";margin-left:auto;padding-left:var(--sp-2);font:700 var(--fs-sm)/1 var(--sans);color:var(--ok);flex:none}
.licensed{margin-top:auto;padding:var(--sp-3) var(--sp-3) var(--sp-2);font-size:var(--fs-sm);color:var(--muted);border-top:1px solid var(--line-2);display:flex;align-items:center;gap:var(--sp-2)}
.licensed::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--ok-tint);flex:none}
.licensed b{color:var(--ink);font-weight:600}
.side-foot{display:flex;gap:var(--sp-2);align-items:flex-start;padding:var(--sp-2) var(--sp-3) var(--sp-1);color:var(--faint);font-size:var(--fs-xs);line-height:1.45}
.side-foot svg{flex:none;margin-top:1px}

/* ===== main + page intro ===== */
.main{flex:1;display:flex;flex-direction:column;min-width:0;position:relative;z-index:1}
.pageintro{max-width:1240px;margin:0 auto var(--sp-6);padding-top:var(--sp-1)}
.crumb{font:600 var(--fs-xs) var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:0 0 var(--sp-2);display:block}
.pageintro h1{margin:0;font-size:var(--fs-xl);font-weight:700;letter-spacing:-.02em;color:var(--ink);line-height:1.25}
.pageintro p{margin:var(--sp-2) 0 0;font-size:var(--fs-base);color:var(--muted);max-width:70ch}
.savestate{font:600 var(--fs-xs) var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.savestate.saved{color:var(--ok)}
.savestate.unsaved{color:var(--warn)}
#save-btn.dirty{box-shadow:0 0 0 3px var(--ring);animation:savepulse 1.8s ease-in-out infinite}
@keyframes savepulse{0%,100%{box-shadow:0 0 0 2px var(--ring)}50%{box-shadow:0 0 0 5px var(--ring)}}

/* ===== buttons ===== */
.btn{appearance:none;border:1px solid var(--btn-line);background:var(--grad-btn);color:var(--btn-ink);border-radius:8px;padding:8px 15px;font:600 13px var(--sans);cursor:pointer;white-space:nowrap;transition:background .15s var(--ease),border-color .15s var(--ease),color .15s var(--ease),transform .12s var(--ease)}
.btn:hover{border-color:#454540;background:var(--grad-btn-hi);color:var(--ink)}
.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--pine);border-color:var(--pine);color:var(--on-accent);font-weight:650}
.btn.primary:hover{background:var(--pine-strong);border-color:var(--pine-strong)}
.btn.sm{padding:6px 12px;font-size:12px}
.btn.danger{color:var(--bad);border-color:var(--bad-line)}
.btn.danger:hover{background:var(--bad-tint);border-color:var(--bad)}

.activity{height:2px;overflow:hidden}
.activity.on{background:linear-gradient(90deg,transparent,var(--teal),transparent);background-size:40% 100%;background-repeat:no-repeat;animation:sweep 1.3s linear infinite}
@keyframes sweep{0%{background-position:-40% 0}100%{background-position:140% 0}}
.content{flex:1;overflow:auto;padding:26px 36px 72px;scrollbar-width:thin;scrollbar-color:#333330 transparent}
.content::-webkit-scrollbar{width:10px}
.content::-webkit-scrollbar-track{background:transparent}
.content::-webkit-scrollbar-thumb{background:#2E2E2B;border-radius:6px}
.content::-webkit-scrollbar-thumb:hover{background:#3B3B37}
.view{display:none;max-width:1240px;margin:0 auto}
.view.on{display:block;animation:fade .28s var(--ease)}
.view.on>*{animation:rise .4s var(--ease) backwards}
.view.on .cols>*{animation:rise .45s var(--ease) backwards}
.view.on .cols>*:nth-child(2){animation-delay:.07s}
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
.cols{display:grid;grid-template-columns:1.55fr 1fr;gap:20px;align-items:start}
.side-col{position:sticky;top:4px;display:flex;flex-direction:column;gap:14px}

/* ===== type + sections ===== */
.eb{font:600 10px var(--mono);letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px;display:flex;align-items:center;gap:10px}
.eb:first-child{margin-top:0}
.eb::after{content:"";flex:1;height:1px;background:var(--line)}
.card{background:var(--panel);border:0;border-radius:14px;padding:22px;box-shadow:var(--shadow)}
.card+.card{margin-top:14px}
.eb+.card{margin-top:0}
.card-h{margin:0 0 15px}
.card-h h3{margin:0;font-size:14.5px;font-weight:660;letter-spacing:-.01em;color:var(--ink)}
.card-h p{margin:4px 0 0;font-size:12px;color:var(--muted);line-height:1.5;max-width:70ch}
.panel{background:var(--panel);border:0;border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}
.panel+.panel,.card+.panel,.panel+.card{margin-top:14px}
.panel,.card{transition:box-shadow .2s var(--ease),border-color .2s var(--ease)}
.ph{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line-2);background:rgba(255,255,255,.015)}
.ph .sq{display:none;width:8px;height:8px;border-radius:50%;flex:none}
.ph .lbl{font:600 12.5px var(--sans);letter-spacing:-.005em;color:var(--ink)}
.ph .meta{margin-left:auto;font:600 10px var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--faint);display:flex;align-items:center;gap:8px}
.ph .btn{flex:none;margin-left:8px}
.pb{padding:18px}

/* ===== forms ===== */
.fld{display:block;min-width:0}
.fld>span{display:block;font-size:12px;color:var(--ink-2);margin:0 0 6px;font-weight:600}
input,textarea,select{width:100%;background:var(--field);border:1px solid var(--field-line);color:var(--ink);border-radius:8px;padding:8px 11px;font:13.5px var(--sans);transition:border-color .15s var(--ease),box-shadow .15s var(--ease)}
select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239C9C93' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;padding-right:30px;cursor:pointer}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--pine);box-shadow:0 0 0 3px var(--ring)}
input:disabled,select:disabled,textarea:disabled{opacity:.45;cursor:not-allowed}
button:disabled{cursor:not-allowed}
input.mono{font-family:var(--mono);font-size:12.5px}
textarea{min-height:150px;resize:vertical;font-family:var(--mono);font-size:12.5px;line-height:1.6}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.hint{font-size:11.5px;color:var(--muted);margin-top:9px;line-height:1.55}
.listrow{display:grid;gap:10px;align-items:end;margin-bottom:11px}
.listrow.niche{grid-template-columns:1fr 1fr 38px}
.listrow.sample{display:grid;grid-template-columns:140px 1fr;gap:12px;align-items:center;margin-bottom:10px}
.listrow.sample .slab{font-weight:580;font-size:12.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .15s var(--ease)}
.listrow.sample:hover .slab{color:var(--pine-strong)}
.listrow.acct{grid-template-columns:1.3fr 1fr .9fr 38px}
.listrow.item{grid-template-columns:minmax(200px,2.2fr) minmax(80px,.5fr) minmax(110px,.8fr) 38px}
.listrow.item .gstonly2{grid-row:2;grid-column:1/-1}
.rm{height:36px;border:1px solid var(--line);background:var(--panel);color:var(--faint);border-radius:var(--r-sm);cursor:pointer;font-size:17px;line-height:1;transition:.15s var(--ease)}
.rm:hover{color:var(--bad);border-color:var(--bad-line);background:var(--bad-tint)}
.empty{border:1px dashed #3B3B37;border-radius:10px;padding:26px 20px;text-align:center;color:var(--muted);background:#1A1A19;font-size:12.5px}
.empty b{display:block;font-family:var(--sans);color:var(--ink);font-weight:650;margin-bottom:4px;font-size:14px;letter-spacing:-.01em}
.note{display:flex;gap:10px;background:var(--warn-tint);border:1px solid var(--warn-line);color:var(--warn);border-radius:var(--r-sm);padding:11px 13px;font-size:12px;line-height:1.55;margin-bottom:15px}
.note svg{flex:none;margin-top:1px}
.check{display:flex;align-items:flex-start;gap:11px;padding:11px 0;color:var(--ink);font-size:13px;cursor:pointer}
.check+.check{border-top:1px solid var(--line-2)}
.check input{width:16px;height:16px;margin-top:2px;accent-color:var(--pine);flex:none}
.check .sub{color:var(--muted);font-size:11.5px;display:block;margin-top:2px}
.addbtn{margin-top:5px}

/* ===== signature: search plan ===== */
.bigrow{display:flex;align-items:flex-end;gap:11px;margin-bottom:5px}
.bignum{font-family:var(--sans);font-size:42px;line-height:.9;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink)}
.bignum-u{font-size:11.5px;color:var(--muted);line-height:1.25;padding-bottom:4px}
.plan-eq{font:600 11px var(--mono);color:var(--teal);letter-spacing:.03em;margin-bottom:6px}
.plan-sec{margin-top:15px}
.mini{font:600 9.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);display:block;margin-bottom:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font:600 11px var(--mono);letter-spacing:.01em;background:var(--panel-2);border:1px solid var(--btn-line);color:var(--ink-2);padding:4px 10px;border-radius:999px;cursor:default;transition:border-color .15s var(--ease),color .15s var(--ease)}
.chip:hover{border-color:var(--faint);color:var(--pine-strong)}
.chip.ghost{color:var(--faint)}
.chip.more{background:var(--pine-tint);color:var(--pine-strong);border-color:var(--line)}

/* ===== signature: email preview ===== */
.mail{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.mail .mh{padding:10px 14px;border-bottom:1px solid var(--line-2);background:var(--panel-2);font:11px var(--mono);color:var(--muted);display:flex;flex-direction:column;gap:3px}
.mail .mh .r{display:flex;gap:9px}.mail .mh .r .k{color:var(--faint);width:34px;flex:none}.mail .mh b{color:var(--ink);font-weight:600}
.mail .subjin{display:block;width:100%;border:0;border-bottom:1px solid var(--line-2);padding:12px 15px;font:650 14px var(--sans);color:var(--ink);background:none;border-radius:0;transition:background .15s var(--ease)}
.mail .subjin:focus{outline:none;box-shadow:none;background:var(--panel-2)}
.mail .bodyin{display:block;width:100%;border:0;padding:12px 15px 15px;font:12.5px/1.62 var(--sans);color:var(--ink-2);background:none;resize:vertical;min-height:210px;border-radius:0;transition:background .15s var(--ease)}
.mail .bodyin:focus{outline:none;box-shadow:none;background:var(--panel-2)}
.mail:focus-within{border-color:var(--pine);box-shadow:0 0 0 3px var(--ring)}
.tokhelp{font-size:11px;color:var(--muted);margin-top:10px;line-height:2}
.tokhelp code{font:600 10.5px var(--mono);background:var(--pine-tint);color:var(--pine-strong);padding:2px 7px;border-radius:6px;cursor:pointer;transition:.13s var(--ease)}
.tokhelp code:hover{background:var(--pine);color:#fff}
.stat{display:flex;align-items:baseline;gap:11px}
.stat .v{font-family:var(--sans);font-size:32px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--ink)}
.stat .u{font-size:12.5px;color:var(--muted)}

/* ===== run / engine ===== */
.guide{display:flex;gap:11px;align-items:flex-start;background:var(--panel);border:0;border-left:3px solid var(--teal);border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:12.5px;color:var(--muted);box-shadow:var(--shadow)}
.guide b{color:var(--ink);font-weight:620}
.guide.warn{border-left-color:var(--warn);background:var(--warn-tint);border-color:var(--warn-line);color:var(--warn)}
.guide .jump{margin-left:auto;flex:none}
.attn{display:none;gap:12px;background:var(--warn-tint);border:1px solid var(--warn-line);border-radius:var(--r);padding:15px 16px;margin-bottom:14px;align-items:flex-start}
.attn.show{display:flex;animation:rise .3s var(--ease)}
.attn .be{width:26px;height:26px;border-radius:7px;background:var(--panel);border:1px solid var(--warn-line);display:grid;place-items:center;flex:none;position:relative}
.attn .be::after{content:"";position:absolute;inset:-5px;border-radius:11px;border:2px solid var(--warn);opacity:.4;animation:ring 1.5s ease-out infinite}
@keyframes ring{0%{transform:scale(.8);opacity:.5}100%{transform:scale(1.55);opacity:0}}
.attn h4{margin:0 0 3px;font-size:13px;font-weight:660;color:var(--warn)}
.attn p{margin:0;font-size:12.5px;color:var(--warn);line-height:1.5}
.runbar{margin-top:20px;padding-top:16px;border-top:1px solid var(--line-2);display:flex;flex-direction:column;align-items:flex-end;gap:11px}
.rb-row{display:flex;align-items:center;gap:12px;padding:0;flex-wrap:wrap;justify-content:flex-end;width:100%}
.node{display:flex;align-items:center;gap:11px;min-width:0}
.node .dotn{width:36px;height:36px;border-radius:10px;background:var(--panel-2);border:1px solid var(--line);display:grid;place-items:center;color:var(--muted);flex:none;transition:.25s var(--ease)}
.node .dotn svg{width:17px;height:17px}
.rb-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.node .ttl{font-weight:660;font-size:13.5px;letter-spacing:-.01em;color:var(--ink)}
.node .cnt{font:600 10.5px var(--mono);color:var(--muted);transition:color .3s}
.node .cnt b{color:var(--ink);font-weight:680}
.node.active .dotn{background:var(--pine);border-color:var(--pine);color:#fff;animation:beat 1.4s ease-in-out infinite}
.node.active .cnt{color:var(--pine-strong)}
@keyframes beat{0%,100%{box-shadow:0 0 0 0 var(--ring)}50%{box-shadow:0 0 0 6px transparent}}
.node.done .dotn{background:var(--teal-tint);border-color:transparent;color:var(--teal)}
.rb-status{display:flex;align-items:center;gap:7px;font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--panel-2);border:1px solid var(--line-2);border-radius:999px;padding:6px 13px;flex:none}
.rb-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rb-actions .mode{margin-left:0}
.rb-req{align-self:flex-end}
.rb-src{display:flex;align-items:center;gap:8px;flex:none}
.rb-src>span{font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.rb-src select{width:auto;min-width:190px;max-width:280px;padding:8px 30px 8px 11px;font-size:12.5px}
.segrow{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;box-shadow:var(--shadow)}
.seg{appearance:none;border:0;background:var(--grad-btn);color:var(--muted);padding:8px 24px;font:600 12.5px var(--sans);cursor:pointer;transition:.15s var(--ease)}
.seg+.seg{border-left:1px solid var(--line)}
.seg:hover{background:var(--panel-2)}
.seg.on{background:var(--pine);color:var(--on-accent);font-weight:650}
.seg.on:hover{background:var(--pine-strong)}
.sheetlist-acts{display:flex;gap:8px}
.statrow{display:flex;align-items:center;gap:18px;background:var(--panel);border-radius:14px;padding:14px 20px;margin-bottom:14px;box-shadow:var(--shadow);flex-wrap:wrap}
.statrow .bignum{font-size:30px}
.statcell{display:flex;align-items:center;gap:10px}
.statlbl{font-size:11px;color:var(--muted);line-height:1.25}
.statdiv{width:1px;height:26px;background:var(--line-2);flex:none}
.stathint{margin-left:auto;font-size:11.5px;color:var(--faint)}
.grouplbl{display:block;font-size:12px;font-weight:600;color:var(--ink-2);margin:0 0 8px}
.grid2.split{gap:22px;align-items:start}
#v-settings .grid2.split{align-items:stretch}
#v-settings .grid2.split .card{display:flex;flex-direction:column;margin-top:0}
#v-settings .grid2.split .card .btn.danger{margin-top:auto!important}
.cardsep{height:1px;background:var(--line-2);margin:18px 0 15px}
#v-agreement .main-col{max-width:780px}
@media (max-width:1080px){.grid2.split{grid-template-columns:1fr}.dash{grid-template-columns:1fr}#v-logs .hist{height:230px}}
.csv-spec{display:flex;gap:12px;align-items:flex-start;background:var(--panel-2);border:1px solid var(--line-2);border-radius:10px;padding:11px 14px;margin:0 0 16px;font-size:12px;color:var(--muted);line-height:1.6}
.csv-spec b{color:var(--ink-2)}
.csv-spec code{font:600 11px var(--mono);background:var(--sink);padding:1px 6px;border-radius:5px;color:var(--ink-2)}
.cs-t{font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint);flex:none;margin-top:3px}
.csv-spec ul{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:2px}
/* loading */
.boot{position:fixed;inset:0;z-index:200;background:var(--canvas);display:grid;place-items:center;transition:opacity .5s var(--ease)}
.boot.off{opacity:0;pointer-events:none}
.boot img{width:120px;height:120px;animation:loadspin 2.2s linear infinite}
.viewload{position:absolute;inset:0;z-index:40;background:var(--canvas);display:grid;place-items:center;opacity:0;visibility:hidden;transition:opacity .16s var(--ease),visibility .16s;pointer-events:none}
.viewload.on{opacity:1;visibility:visible}
.viewload img{width:84px;height:84px;animation:loadspin 2.2s linear infinite}
@keyframes loadspin{to{transform:rotate(360deg)}}
/* entrances */
.fu-ov.show .fu-card{animation:popin .26s var(--ease)}
.upgate.show .upcard{animation:popin .26s var(--ease)}
.chat-panel{animation:popin .22s var(--ease);transform-origin:bottom right}
@keyframes popin{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.rb-req{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0;justify-content:flex-end}
.req-t{font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-right:2px}
.req-pill{appearance:none;display:inline-flex;align-items:center;border:1px solid var(--warn-line);background:transparent;color:var(--warn);border-radius:999px;padding:4px 12px;font:600 11.5px var(--sans);cursor:pointer;transition:.15s var(--ease)}
.req-pill:hover{background:var(--warn-tint)}
.runbar .meter{margin:0;padding:0;width:100%}
.viewnote{font-size:12px;color:var(--muted);margin:0 2px 16px;line-height:1.5}
.viewnote b{color:var(--ink-2);font-weight:620}
.meter{margin-top:15px;display:none}
.meter.show{display:block;animation:rise .3s var(--ease)}
.meter .ml{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;gap:12px}
.meter .ml .t{font:600 12px var(--sans);color:var(--ink)}
.meter .ml .pc{font:600 12px var(--mono);color:var(--muted);text-align:right}
.bar{height:7px;border-radius:5px;background:var(--sink);overflow:hidden}
.bar i{display:block;height:100%;background:var(--pine);border-radius:5px;width:0;transition:width .5s var(--ease)}
.bar.indet i{width:32%;animation:indet 1.4s var(--ease) infinite}
@keyframes indet{0%{margin-left:-32%}100%{margin-left:100%}}
.opbtn{appearance:none;border:1px solid var(--btn-line);background:var(--grad-btn);color:var(--btn-ink);border-radius:8px;padding:9px 18px;font:600 13px var(--sans);letter-spacing:0;cursor:pointer;transition:transform .12s var(--ease),background .15s var(--ease),border-color .15s var(--ease),color .15s var(--ease)}
.opbtn:hover{border-color:#454540;color:var(--ink);background:var(--grad-btn-hi)}
.opbtn:active{transform:translateY(1px)}
.opbtn.go{background:var(--pine);border-color:var(--pine);color:var(--on-accent);font-weight:650}
.opbtn.go:hover{background:var(--pine-strong);border-color:var(--pine-strong);color:var(--on-accent)}
.opbtn.halt{background:transparent;color:var(--bad);border-color:var(--bad-line);box-shadow:none}
.opbtn.halt:hover{background:var(--bad-tint)}
.opbtn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.opbtn.run:hover:not(:disabled){transform:translateY(-1px)}
.mode{margin-left:auto;font:600 10.5px var(--mono);letter-spacing:.07em;text-transform:uppercase;padding:6px 13px;border-radius:999px;border:1px solid transparent;cursor:pointer;background:none}
.mode.test{background:var(--warn-tint);color:var(--warn);border-color:var(--warn-line)}
.mode.live{background:var(--bad-tint);color:var(--bad);border-color:var(--bad-line)}
.statusdot{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.statusdot.run{background:var(--teal);animation:pulse 1.2s infinite}
.statusdot.done{background:var(--ok)}.statusdot.stopped{background:var(--bad)}.statusdot.attn{background:var(--warn)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

/* ===== logs + history ===== */
.dash{display:grid;grid-template-columns:300px 1fr;gap:14px;align-items:start}
#v-logs .hist{height:calc(100vh - 262px)}
.logpanel{background:var(--forest);border-color:var(--forest-line)}
.logpanel .ph{background:var(--forest-2);border-bottom-color:var(--forest-line)}
.logpanel .ph .lbl{color:#C3CFBC}.logpanel .ph .meta{color:var(--forest-mut)}
.logpanel .btn{background:transparent;border-color:var(--forest-line);color:#AEBBA6}
.logpanel .btn:hover{background:rgba(255,255,255,.06);border-color:#3A4840;color:#D6E1D2}
.log{height:340px;overflow:auto;padding:14px 16px;font:12px/1.7 var(--mono);color:var(--forest-ink);white-space:pre-wrap;word-break:break-word}
.log .ph2{color:var(--forest-mut)}
.log .ln.in{animation:lnin .35s var(--ease)}
@keyframes lnin{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.log::-webkit-scrollbar{width:9px}.log::-webkit-scrollbar-thumb{background:#333330;border-radius:5px}
#v-logs .log{height:calc(100vh - 262px)}
#v-logs .ph .btn{margin-left:8px}
.hist{height:340px;overflow:auto;padding:7px}
.hitem{display:block;width:100%;text-align:left;font-family:inherit;padding:10px 11px;border-radius:var(--r-sm);border:1px solid transparent;background:none;cursor:pointer;transition:background .15s var(--ease),border-color .15s var(--ease)}
.hitem:hover{background:var(--panel-2);border-color:var(--line-2)}
.hitem[aria-pressed=true]{background:var(--pine-tint);border-color:var(--pine)}
.hi-top{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.hi-top .hkind{font-weight:620;font-size:12.5px;color:var(--ink)}
.hi-top .hwhen{margin-left:auto;font:600 10px var(--mono);color:var(--faint)}
.hi-sum{font:600 11px var(--mono);color:var(--muted);padding-left:15px}

/* ===== imports ===== */
.impflow{display:flex;flex-direction:column;gap:18px}
.impstep{display:flex;gap:13px}
.is-num{width:23px;height:23px;border-radius:50%;background:var(--pine-tint);color:var(--pine-strong);font:700 11px var(--mono);display:grid;place-items:center;flex:none;margin-top:1px}
.is-body{flex:1;min-width:0}
.is-t{font-weight:650;font-size:13px;color:var(--ink);margin-bottom:9px;letter-spacing:-.005em}
.dz-row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.dz-hint{font-size:11.5px;color:var(--faint);margin:9px 0 0}
.dz-status{display:block;margin:6px 0 0;color:var(--pine-strong);font-weight:600}
.dz-status:empty{display:none}
.colsel{min-width:200px;flex:1;max-width:300px}
.fld .opt{font-style:normal;font-weight:500;color:var(--faint)}
input[type=file]{width:auto;max-width:340px;padding:5px 6px;font:12.5px var(--sans);color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer}
input[type=file]::file-selector-button{appearance:none;border:1px solid var(--line);background:var(--panel-2);border-radius:6px;padding:5px 11px;font:600 12px var(--sans);color:var(--ink-2);margin-right:10px;cursor:pointer;transition:.15s var(--ease)}
input[type=file]::file-selector-button:hover{background:var(--sink)}
.dropzone{border:1.5px dashed #3B3B37;border-radius:10px;padding:14px;background:#1A1A19;transition:.15s var(--ease)}
.dropzone .dz-row{align-items:center}
.dropzone.drag{border-color:var(--pine);background:var(--pine-wash)}

.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(12px);background:#EAEAE5;color:#1C1C1B;padding:11px 18px;border-radius:999px;font-size:12.5px;font-weight:620;box-shadow:0 10px 30px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:.25s var(--ease);z-index:60;max-width:80vw}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{background:var(--ok-tint);color:var(--ink);border:1px solid var(--ok);box-shadow:0 10px 30px rgba(0,0,0,.5)}
.toast.err{background:var(--bad-tint);color:var(--ink);border:1px solid var(--bad);box-shadow:0 10px 30px rgba(0,0,0,.5)}
.cfgerr{position:fixed;left:50%;top:62px;transform:translateX(-50%);z-index:var(--z-banner);display:flex;align-items:center;gap:12px;max-width:min(560px,92vw);background:var(--bad-tint);border:1px solid var(--bad-line);color:var(--ink);border-radius:var(--r);padding:11px 14px;font-size:var(--fs-base);line-height:1.5;box-shadow:var(--shadow-3)}
.cfgerr b{color:var(--bad);font-weight:700}
.cfgerr .sp{flex:1}
.cfgerr button{flex:none;appearance:none;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:var(--r-sm);padding:6px 13px;font:600 var(--fs-sm)/1 var(--sans);cursor:pointer;transition:background var(--t-fast) var(--ease)}
.cfgerr button:hover{background:rgba(222,139,116,.12)}

/* ===== update notice ===== */
.upbar{display:none;align-items:center;gap:12px;background:#222221;color:#EAEAE5;padding:9px 18px;font-size:13px;font-weight:540}
.upbar.show{display:flex}
.upbar b{font-weight:700}
.upbar .sp{flex:1}
.upbar button{appearance:none;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff;border-radius:7px;padding:6px 14px;font:600 12px var(--sans);cursor:pointer;transition:.15s var(--ease)}
.upbar button:hover{background:rgba(255,255,255,.22)}
.upbar button.x{border:0;background:none;opacity:.85;font-size:17px;line-height:1;padding:4px 6px}
.upgate{display:none;position:fixed;inset:0;z-index:90;background:rgba(14,22,17,.55);place-items:center;backdrop-filter:blur(2px)}
.upgate.show{display:grid}
.upcard{background:var(--grad-card);border:1px solid var(--btn-line);border-radius:var(--r-lg);padding:32px 30px;width:min(420px,90vw);text-align:center;box-shadow:var(--shadow-3)}
.upcard .v{font:600 11px var(--mono);color:var(--pine);letter-spacing:.08em;text-transform:uppercase}
.upcard h2{font-family:var(--sans);font-size:21px;font-weight:700;letter-spacing:-.02em;margin:9px 0 8px;color:var(--ink)}
.upcard p{color:var(--muted);font-size:13.5px;line-height:1.6;margin:0 0 22px}
.upcard button{appearance:none;border:0;background:var(--pine);color:var(--on-accent);border-radius:10px;padding:13px 22px;font:650 14px var(--sans);cursor:pointer;width:100%;transition:.15s var(--ease)}
.upcard button:hover{background:var(--pine-strong)}

.savestate.pop{animation:pop .42s var(--ease)}
@keyframes pop{0%{transform:scale(.7);opacity:.3}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}

@keyframes rmpulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){
  /* Reduce, don't remove: cut transitions and vestibular (transform/rotate/slide)
     motion, but keep long-running feedback legible via opacity-only pulses so a
     reduced-motion user never sees a frozen screen during an operation. */
  *{transition-duration:1ms!important}
  .view.on,.view.on>*,.view.on .cols>*,.view.on .cols>*:nth-child(2),
  .node.active .dotn,.savestate.pop,.attn .be::after,.statusdot.run,
  .fu-ov.show .fu-card,.upgate.show .upcard,.chat-panel,.sheet-card:hover,
  .err.show,.banner.show,.attn.show,.meter.show,#save-btn.dirty{animation:none!important}
  .boot img,.viewload img,.wb-spin,.spin{animation:rmpulse 1.6s ease-in-out infinite!important}
  .activity.on{animation:none!important;opacity:.85}
  .bar i{transition:none!important}
  .bar.indet i{animation:none!important;width:40%!important;margin-left:0!important}
}
@media (max-width:1080px){.cols{grid-template-columns:1fr}.side-col{position:static}.dash{grid-template-columns:1fr}.hist{height:230px}}
@media (max-width:860px){
  .side{width:56px;padding:14px 6px}
  .navi .navtext,.side-foot,.licensed,.navgroup,.tb-tag,.navi.done::after{display:none}
  .navdiv.rail-only{display:block}
  .navdiv{margin:var(--sp-2) var(--sp-1)}
  .navi{justify-content:center;padding:9px 0}
  .content{padding:22px 22px 56px}
}
@media (max-width:680px){
  .grid2,.grid3{grid-template-columns:1fr}.listrow.niche,.listrow.acct,.listrow.item{grid-template-columns:1fr}
  .listrow .rm{width:46px}
  .pageintro h1{font-size:19px}
  .rb-actions{margin-left:0;width:100%}
}

/* ===== sheets ===== */
#v-sheets{max-width:1240px}
.sheets-list{max-width:none}
.sheetlist-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 12px;font:650 14.5px var(--sans);letter-spacing:-.01em;color:var(--ink)}
.sheet-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.sheet-card{text-align:left;border:1px solid var(--line);border-radius:var(--r);background:var(--panel);cursor:pointer;padding:15px 16px;display:flex;flex-direction:column;gap:5px;font-family:inherit;width:100%;box-shadow:var(--shadow);transition:border-color .15s var(--ease),box-shadow .15s var(--ease),transform .12s var(--ease)}
.sheet-card:hover{border-color:var(--faint);box-shadow:var(--shadow-2);transform:translateY(-1px)}
.sheet-card.on{border-color:var(--pine);box-shadow:0 0 0 3px var(--ring)}
.sheet-card.on .sc-name{color:var(--pine-strong);font-weight:680}
.sc-name{font-size:13.5px;color:var(--ink);font-weight:640;letter-spacing:-.005em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-meta{font:600 10px var(--mono);letter-spacing:.04em;color:var(--faint);display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.sc-fu{background:var(--teal-tint);color:var(--teal);padding:1px 7px;border-radius:999px}
.sheet-editor{display:none;position:fixed;inset:0;z-index:80;background:#fff;flex-direction:column}
/* the grid canvas is always light, so the editor keeps light tokens */
.sheet-editor{--panel:#FFFFFF;--panel-2:#F4F4F2;--sink:#ECECE9;--ink:#20201E;--ink-2:#3C3C38;--muted:#6E6E67;--faint:#9A9A92;--line:#E4E4DF;--line-2:#EDEDE9;--pine:#A3853F;--pine-strong:#8A6F31;--pine-tint:#F3EDDC;--ring:rgba(163,133,63,.18);--on-accent:#fff;--grad-btn:#FFFFFF;--grad-btn-hi:#F4F4F1;--btn-line:#D9D9D2;--btn-ink:#3C3C38;--edge:rgba(255,255,255,.7);--field:#FFFFFF;--field-line:#E4E4DF;--bad:#B0452F;--bad-tint:#FAE8E2;--bad-line:#EFCBBF;--card-line:#E4E4DF;--gold-dim:rgba(163,133,63,.12);--gold-glow:rgba(163,133,63,.25)}
.sheet-editor.show{display:flex}
.se-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--line);background:#fff;flex:none}
.se-back{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;border-radius:9px;padding:7px 14px;font:600 13px var(--sans);color:var(--ink-2);cursor:pointer;transition:.15s var(--ease)}
.se-back:hover{background:var(--panel-2);border-color:var(--faint)}
.se-name{font:650 15px var(--sans);color:var(--ink);letter-spacing:-.01em}
.se-bar .sp{flex:1}
.se-bar .savestate{font:600 11px var(--mono);color:var(--faint)}
.fx-bar{display:flex;align-items:stretch;background:#fff;border-bottom:1px solid var(--line);flex:none;height:34px}
.fx-name{width:88px;flex:none;font:500 12.5px var(--sans);color:var(--ink-2);border-right:1px solid var(--line);display:grid;place-items:center}
.fx-lbl{font:italic 600 12.5px Georgia,serif;color:var(--faint);display:grid;place-items:center;padding:0 13px}
.fx-input{flex:1;border:0;background:none;box-shadow:none;border-radius:0;padding:0 12px;font:13px var(--sans);color:var(--ink)}
.fx-input:focus{outline:none;border:0;box-shadow:none}
.xs-addrows{position:absolute;left:152px;bottom:16px;z-index:15;border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 14px;font:600 12px var(--sans);color:var(--ink-2);cursor:pointer;box-shadow:var(--shadow-2);transition:.15s var(--ease)}
.xs-addrows:hover{background:var(--panel-2)}
.xs-viewport{flex:1;width:100%;min-height:0;position:relative;overflow:auto}
.xs-host{width:100%;height:100%;transform-origin:top left}
.xs-zoom{position:absolute;left:16px;bottom:16px;z-index:15;display:flex;align-items:center;gap:2px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 6px;box-shadow:var(--shadow-2)}
.xs-zoom-btn{width:24px;height:24px;border:0;background:none;border-radius:50%;font:600 15px var(--sans);color:var(--ink-2);cursor:pointer;display:grid;place-items:center;line-height:1;padding:0}
.xs-zoom-btn:hover{background:var(--sink)}
.xs-zoom-btn:disabled{opacity:.35;cursor:default}
.xs-zoom-pct{font:600 11.5px var(--mono);color:var(--muted);min-width:38px;text-align:center;user-select:none}
body.editing-sheet{overflow:hidden}
/* Sheets: Google-Sheets-leaning restyle of the x-spreadsheet chrome (DOM
   only - the grid itself is canvas-rendered by the vendored library and
   can't be restyled by CSS). Scoped to #xs-host. */
#xs-host,#xs-host input,#xs-host select,#xs-host textarea{font-family:var(--sans)}
#xs-host .x-spreadsheet-toolbar,#xs-host .x-spreadsheet-bottombar{background:#fff}
#xs-host .x-spreadsheet-toolbar{border-bottom:1px solid var(--line)}
#xs-host .x-spreadsheet-bottombar{border-top:1px solid var(--line)}
#xs-host .x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn{border-radius:6px}
#xs-host .x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn:hover,#xs-host .x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn.active{background:var(--sink)}
#xs-host .x-spreadsheet-toolbar-divider{border-right-color:var(--line)}
#xs-host .x-spreadsheet-menu>li{color:var(--muted);font-family:var(--sans);font-weight:600}
#xs-host .x-spreadsheet-menu>li.active{background:var(--pine-tint);color:var(--pine-strong)}
#xs-host .x-spreadsheet-bottombar .x-spreadsheet-menu>li{border-right-color:var(--line)}
#xs-host .x-spreadsheet-selector .x-spreadsheet-selector-area{border-color:var(--pine);background:rgba(160,124,45,.10)}
#xs-host .x-spreadsheet-selector .x-spreadsheet-selector-corner{background:var(--pine);border-color:#fff}
#xs-host .x-spreadsheet-selector .x-spreadsheet-selector-clipboard{border-color:var(--pine)}
#xs-host .x-spreadsheet-scrollbar{background-color:var(--panel-2)}
#xs-host .x-spreadsheet-scrollbar.horizontal>div,#xs-host .x-spreadsheet-scrollbar.vertical>div{background:#C9C9C4}

/* ===== follow-up modal ===== */
.fu-ov{display:none;position:fixed;inset:0;z-index:95;background:rgba(14,22,17,.5);place-items:center;backdrop-filter:blur(2px)}
.fu-ov.show{display:grid}
.fu-card{background:var(--grad-card);border:1px solid var(--btn-line);border-radius:var(--r-lg);padding:26px 26px 22px;width:min(540px,92vw);max-height:88vh;overflow:auto;box-shadow:var(--shadow-3);position:relative}
.fu-card h2{font-family:var(--sans);font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;color:var(--ink)}
.fu-x{position:absolute;top:12px;right:14px;border:0;background:none;font-size:22px;line-height:1;color:var(--faint);cursor:pointer;padding:4px;border-radius:6px}
.fu-x:hover{background:var(--sink);color:var(--ink)}
.fu-note{font-size:12.5px;color:var(--muted);background:var(--panel-2);border:1px solid var(--line-2);border-radius:9px;padding:9px 11px;margin:0 0 14px;line-height:1.5}
.fu-tok{font:600 11px var(--mono);color:var(--faint);margin:6px 0 16px}
.fu-actions{display:flex;gap:9px;flex-wrap:wrap}
.fu-result{margin-top:16px;border-top:1px solid var(--line-2);padding-top:13px}
.fu-sum{font-size:13px;color:var(--ink-2);margin-bottom:10px}
.fu-man-h{font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:8px 0 6px}
.fu-man{display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line-2);font-size:13px}
.fu-man .fm-name{flex:1;color:var(--ink-2);font-weight:580}
.fu-man .fm-ch{font:600 10px var(--mono);background:var(--teal-tint);color:var(--teal);padding:2px 7px;border-radius:999px}
.fu-man .fm-ph{font:12px var(--mono);color:var(--muted)}

/* ===== website builder / embedded frames ===== */
#v-website-builder.view.on{max-width:none;height:100%;display:flex;flex-direction:column}
.wb-wrap{position:relative;flex:1;min-height:560px;height:calc(100vh - 210px);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;background:#080C1A;box-shadow:var(--shadow)}
.wb-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#080C1A}
.wb-loading,.wb-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:30px;background:var(--panel)}
.wb-loadtxt{font:650 15px var(--sans);color:var(--ink-2)}
.wb-loadsub,.wb-error span{font-size:12.5px;color:var(--muted);max-width:420px}
.wb-error b{font:650 15px var(--sans);color:var(--bad)}
.wb-spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--pine);animation:wbspin .8s linear infinite}
@keyframes wbspin{to{transform:rotate(360deg)}}

/* ===== floating AI chat ===== */
.chat-fab{position:fixed;right:24px;bottom:24px;z-index:70;width:52px;height:52px;border-radius:50%;border:0;background:var(--pine);color:var(--on-accent);display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4);transition:.18s var(--ease)}
.chat-fab:hover{background:var(--pine-strong);transform:translateY(-1px)}
.chat-fab svg{width:22px;height:22px}
.chat-fab-icon-close{display:none}
.chat-fab.open .chat-fab-icon-open{display:none}
.chat-fab.open .chat-fab-icon-close{display:block}
.chat-panel{position:fixed;right:24px;bottom:88px;z-index:70;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 120px));background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-3);display:flex;flex-direction:column;overflow:hidden}
.chat-panel[hidden]{display:none}
.chat-panel-bar{flex:none;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.chat-panel-title{font:650 13.5px var(--sans);color:var(--ink)}
.chat-panel-x{border:0;background:none;font-size:22px;line-height:1;color:var(--muted);cursor:pointer;padding:2px 6px;border-radius:6px}
.chat-panel-x:hover{background:var(--sink);color:var(--ink)}
.chat-panel .wb-wrap{flex:1;min-height:0;height:auto;border:0;border-radius:0;box-shadow:none}
@media (max-width:480px){.chat-panel{right:16px;left:16px;bottom:82px;width:auto}.chat-fab{right:16px;bottom:16px}}
/* First-run walkthrough (Tour) */
.tb-help{border:1px solid var(--line-2);background:var(--sink);color:var(--muted);width:32px;height:32px;border-radius:var(--r-sm);font:700 var(--fs-md) var(--sans);cursor:pointer;line-height:1;flex:none;display:flex;align-items:center;justify-content:center;transition:color var(--t-fast) var(--ease),border-color var(--t-fast) var(--ease),background var(--t-fast) var(--ease)}
.tb-help:hover{color:var(--ink);border-color:var(--accent);background:var(--panel-2)}
.pageintro{position:relative}
.sect-help{position:absolute;top:0;right:0;display:inline-flex;align-items:center;gap:var(--sp-2);border:1px solid var(--line-2);background:var(--sink);color:var(--muted);font:600 var(--fs-sm) var(--sans);padding:var(--sp-2) var(--sp-3);border-radius:var(--r-pill);cursor:pointer;transition:color var(--t-fast) var(--ease),border-color var(--t-fast) var(--ease),background var(--t-fast) var(--ease)}
.sect-help:hover{color:var(--ink);border-color:var(--accent);background:var(--panel-2)}
.sect-help b{font-weight:700;font-size:var(--fs-base)}
.tour-block{position:fixed;inset:0;z-index:9990;background:transparent}
.tour-block.dim{background:rgba(10,10,9,.62)}
.tour-spot{position:fixed;z-index:9991;border-radius:10px;background:transparent;box-shadow:0 0 0 9999px rgba(10,10,9,.62),0 0 0 2px var(--gold,#c9a84a);transition:box-shadow .15s ease;pointer-events:none}
.tour-tip{position:fixed;z-index:9992;width:min(324px,calc(100vw - 32px));background:var(--panel,#1c1c19);border:1px solid var(--line-2,#33332e);border-radius:12px;padding:15px 16px 12px;box-shadow:0 18px 50px rgba(0,0,0,.5);color:var(--ink,#eae7df)}
.tour-tip h4{margin:0 0 6px;font:650 15px var(--sans,sans-serif);color:var(--ink,#eae7df)}
.tour-tip p{margin:0 0 13px;font:400 13px/1.55 var(--sans,sans-serif);color:var(--muted,#a8a49a)}
.tour-row{display:flex;align-items:center;gap:8px}
.tour-count{font:500 12px var(--sans,sans-serif);color:var(--faint,#7d7a71);margin-right:auto}
.tour-skip{display:block;margin-top:9px;border:0;background:none;color:var(--faint,#7d7a71);font:500 12px var(--sans,sans-serif);cursor:pointer;padding:4px 2px}
.tour-skip:hover{color:var(--ink,#eae7df)}
</style>
<link rel="stylesheet" href="/vendor/xspreadsheet.css">
<link rel="stylesheet" href="/assets/interface.css?v=20261024">
<script defer src="/assets/interface.js?v=20261024"></script>
<link rel="stylesheet" href="/assets/overview.css?v=20261115">
<script defer src="/assets/overview.js?v=20261115"></script>
<script src="/vendor/xspreadsheet.js"></script>
</head>
<body>
<div class="boot" id="boot" aria-hidden="true"><img class="boot-v" src="/assets/logo.png" alt="" width="120" height="120" draggable="false"></div>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <header class="topbar">
    <span class="tb-brand"><img src="/assets/logo.png" alt="" width="26" height="26" draggable="false"><span class="tb-nm">__APP_NAME__</span><span class="tb-tag">Outreach console</span></span>
    <span class="tb-sp"></span>
    <span class="savestate" id="savestate" role="status" aria-live="polite"></span>
    <button type="button" class="tb-help" id="tour-btn" title="Overview tour" aria-label="Replay the overview tour" onclick="Tour.start()">?</button>
    <button type="button" class="btn primary" id="save-btn" onclick="saveCfg(true)">Save changes</button>
  </header>
  <div class="shell">
  <aside class="side">
    <nav class="nav" aria-labelledby="navlabel">
      <div class="navgroup" id="navlabel">Workflow</div>
      <div class="navsec">
      <button type="button" class="navi" data-view="business-info" aria-current="page">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke-linecap="round"/></svg></span>
        <span class="navtext"><span class="lbl">Business Information</span></span>
      </button>
      <button type="button" class="navi" data-view="find-emails">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>
        <span class="navtext"><span class="lbl">Find Emails</span></span>
      </button>
      <button type="button" class="navi" data-view="email-outreach">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M21.5 3.5 11 13M21.5 3.5l-7 18-3.6-7.4L3.5 10l18-6.5Z"/></svg></span>
        <span class="navtext"><span class="lbl">Email Outreach</span></span>
      </button>
      <button type="button" class="navi" data-view="logs">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12 14.5h5"/></svg></span>
        <span class="navtext"><span class="lbl">Logs</span></span>
      </button>
      </div>
      <div class="navdiv" role="presentation"></div>
      <div class="navsec">
      <button type="button" class="navi" data-view="sheets">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9.5h17M3.5 15h17M9 3.5v17" stroke-linecap="round"/></svg></span>
        <span class="navtext"><span class="lbl">Workspace</span></span>
      </button>
      <button type="button" class="navi" data-view="crm">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2"/></svg></span>
        <span class="navtext"><span class="lbl">CRM</span></span>
      </button>
      <button type="button" class="navi tool" data-view="website-builder">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 6.5h17M3.5 6.5v12a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-12M3.5 6.5 5 3.5h14l1.5 3M7 4.8v.01M10 4.8v.01" stroke-linecap="round"/><path d="m10.5 11.5-2 2 2 2M13.5 11.5l2 2-2 2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="navtext"><span class="lbl">Website Builder</span></span>
      </button>
      </div>
      <div class="navdiv rail-only" role="presentation"></div>
      <div class="navgroup" aria-hidden="true">Documents</div>
      <div class="navsec tools">
      <button type="button" class="navi tool" data-view="invoice">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h9l3 3v17l-3-2-3 2-3-2-3 2V2Z"/><path d="M9 8h6M9 12h6M9 16h3" stroke-linecap="round"/></svg></span>
        <span class="navtext"><span class="lbl">Invoice</span></span>
      </button>
      <button type="button" class="navi tool" data-view="agreement">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M7 3h10l3 3v15H4V3h3Z"/><path d="M8 9h8M8 13h8M8 17h5" stroke-linecap="round"/></svg></span>
        <span class="navtext"><span class="lbl">Agreement</span></span>
      </button>
      </div>
__ADMIN_NAV__      <div class="navspacer" aria-hidden="true"></div>
      <div class="navdiv rail-only" role="presentation"></div>
      <div class="navsec">
      <button type="button" class="navi" data-view="settings">
        <span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.4M12 18.1v2.4M4.4 6.4l1.7 1.7M17.9 15.9l1.7 1.7M3.5 12h2.4M18.1 12h2.4M4.4 17.6l1.7-1.7M17.9 8.1l1.7-1.7" stroke-linecap="round"/></svg></span>
        <span class="navtext"><span class="lbl">Settings</span></span>
      </button>
      </div>
    </nav>
    <div class="licensed" title="Your licensed copy">Licensed to <b>__USER_NAME__</b></div>
    <div class="side-foot">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" stroke="#8B948C" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <span>Runs on this computer. Your settings and history stay on this machine.</span>
    </div>
  </aside>

  <main class="main" id="main">
    <div class="upbar" id="upbar"><span id="upbar-txt"></span><span class="sp"></span><button id="upbar-go" type="button">Update now</button><button class="x" id="upbar-x" type="button" aria-label="Dismiss">&times;</button></div>
    <div class="activity" id="activity" aria-hidden="true"></div>
    <div class="viewload" id="viewload" aria-hidden="true"><img src="/assets/logo.png" alt="" width="84" height="84" draggable="false"></div>
    <div class="content" id="content">
      <div class="pageintro">
        <button type="button" class="sect-help" id="sect-help" title="Walk me through this section" onclick="Tour.section()"><b>?</b> Walkthrough</button>
        <span class="crumb" id="crumb">Workflow</span>
        <h1 id="vtitle">Business Information</h1>
        <p id="vdesc">Choose the kinds of business you want to reach and where.</p>
      </div>

      <section class="view" id="v-crm" aria-labelledby="vtitle" tabindex="-1">
        <link rel="stylesheet" href="/assets/crm.css?v=1">
        <div id="lumen-crm"><p>Opening CRM…</p></div>
        <script defer src="/assets/crm.js?v=1"></script>
      </section>
      <!-- BUSINESS INFORMATION -->
      <section class="view on" id="v-business-info" aria-labelledby="vtitle" tabindex="-1">
        <input id="apikey" type="hidden">
        <div class="guide" id="guide">
          <div id="guide-text">Add at least one business type and one location, then press <b>Collect businesses</b>. Finished work is saved automatically.</div>
          <button type="button" class="btn sm jump" id="guide-jump" hidden onclick="show('business-info')">Review setup</button>
        </div>
        <div class="attn" id="attn" role="alert">
          <div><h4>Action needed in the Chrome window</h4><p id="attn-msg"></p></div>
        </div>
        <div class="statrow">
          <div class="statcell"><span class="bignum" id="plan-total">0</span><span class="statlbl">map searches<br>queued</span></div>
          <span class="statdiv" aria-hidden="true"></span>
          <span class="plan-eq" id="plan-eq">0 types &times; 0 locations</span>
          <span hidden aria-hidden="true"><span id="plan-niches"></span><span id="plan-cities"></span></span>
          <span class="stathint">Each business type is searched in every location.</span>
        </div>
        <div class="card">
          <div class="card-h"><h3>Targeting</h3><p>The businesses you want to reach, and where to look for them.</p></div>
          <div class="grid2 split">
            <div>
              <span class="grouplbl">Business types</span>
              <div id="niches"></div>
              <div id="niches-empty" class="empty" hidden><b>No business types yet</b>Add the kind of business you want to target, like dentists or salons.</div>
              <button type="button" class="btn sm addbtn" onclick="addNiche()">+ Add business type</button>
            </div>
            <div>
              <span class="grouplbl">Locations &mdash; one city or area per line</span>
              <textarea id="cities" placeholder="Austin TX&#10;Dallas TX&#10;Miami FL"></textarea>
              <p class="hint">Write each one the way you'd type it into Google Maps.</p>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h3>Countries you'll contact</h3><p>Only businesses in these countries are collected and emailed.</p></div>
          <label class="fld"><span>One country per line</span><textarea id="countries" placeholder="United States"></textarea></label>
          <p class="hint">Keeps you in markets where opt-out B2B email is workable. Leave the EU, UK and Canada off unless you've set up consent first &mdash; their rules are stricter. Blank = no country filter.</p>
        </div>
        <div class="runbar">
          <div class="rb-req" id="req-collect" hidden></div>
          <div class="rb-row">
            <div class="node" id="node-collect" hidden>
              <span class="dotn" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5" stroke-linecap="round"/></svg></span>
              <span class="rb-text"><span class="ttl">Collect businesses</span><span class="cnt" id="cnt-collect">Not started</span></span>
            </div>
            <span class="rb-status" hidden><span class="statusdot" id="sdot-collect" aria-hidden="true"></span><span class="rb-stage" id="stage-collect">idle</span></span>
            <div class="rb-actions">
              <button type="button" class="opbtn go run" id="btn-collect" onclick="run('scrape')">Collect businesses</button>
              <button type="button" class="opbtn halt" id="stopbtn-collect" onclick="stopRun()" disabled>Stop</button>
            </div>
          </div>
          <div class="meter" id="meter-collect"><div class="ml"><span class="t" id="meter-t-collect">Working</span><span class="pc" id="meter-pc-collect"></span></div><div class="bar" id="bar-collect" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="bar-fill-collect"></i></div></div>
        </div>
      </section>

      <!-- FIND EMAILS -->
      <section class="view" id="v-find-emails" aria-labelledby="vtitle" tabindex="-1">
        <p class="viewnote">Scans each business's website for a published contact email. Use your collected businesses, or upload a CSV &mdash; then run it from the bar below.</p>
        <div class="panel" id="find-imp-panel">
          <div class="ph"><span class="lbl">Import a CSV <em class="opt">(optional)</em></span><span class="meta">No scrape needed</span></div>
          <div class="pb">
            <div class="csv-spec"><span class="cs-t">CSV format</span><ul><li>First row must be column headers</li><li>A <b>website</b> column with full URLs, like <code>https://acmedental.com</code></li><li>Optionally a <b>business name</b> column</li></ul></div>
            <div class="grid2 split">
              <div class="impstep">
                <span class="is-num" aria-hidden="true">1</span>
                <div class="is-body">
                  <div class="is-t">Upload your CSV</div>
                  <div class="dropzone" id="find-imp-drop">
                    <div class="dz-row">
                      <input type="file" id="find-imp-file" accept=".csv">
                      <button type="button" class="btn sm" onclick="FindImports.upload()">Upload CSV</button>
                      <button type="button" class="btn sm" onclick="FindImports.reset()">Clear</button>
                    </div>
                    <p class="dz-hint">or drag &amp; drop a .csv file anywhere in this box</p>
                    <span class="hint dz-status" id="find-imp-status"></span>
                  </div>
                </div>
              </div>
              <div class="impstep" id="find-imp-map">
                <span class="is-num" aria-hidden="true">2</span>
                <div class="is-body">
                  <div class="is-t">Map the columns</div>
                  <div class="dz-row">
                    <label class="fld colsel"><span>Website column</span><select id="find-imp-website-col" disabled></select></label>
                    <label class="fld colsel"><span>Business name column <em class="opt">(optional)</em></span><select id="find-imp-name-col" disabled><option value="">(none)</option></select></label>
                    <button type="button" class="btn sm" onclick="FindImports.confirmMap()" disabled>Confirm mapping</button>
                  </div>
                  <p class="hint">Once mapped, choose it as the <b>Source</b> in the bar below.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="runbar">
          <div class="rb-req" id="req-find" hidden></div>
          <div class="rb-row">
            <div class="node" id="node-find" hidden>
              <span class="dotn" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>
              <span class="rb-text"><span class="ttl">Find emails</span><span class="cnt" id="cnt-find">Not started</span></span>
            </div>
            <span class="rb-status" hidden><span class="statusdot" id="sdot-find" aria-hidden="true"></span><span class="rb-stage" id="stage-find">idle</span></span>
            <div class="rb-actions">
              <label class="rb-src"><span>Source</span><select id="find-imp-picker" aria-label="List to scan"><option value="">Collected businesses</option></select></label>
              <button type="button" class="opbtn go run" id="btn-find" onclick="findCampaign()">Find emails</button>
              <button type="button" class="opbtn halt" id="stopbtn-find" onclick="stopRun()" disabled>Stop</button>
            </div>
          </div>
          <div class="meter" id="meter-find"><div class="ml"><span class="t" id="meter-t-find">Working</span><span class="pc" id="meter-pc-find"></span></div><div class="bar" id="bar-find" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="bar-fill-find"></i></div></div>
        </div>
      </section>

      <!-- EMAIL OUTREACH -->
      <section class="view" id="v-email-outreach" aria-labelledby="vtitle" tabindex="-1">
        <div class="cols">
          <div class="main-col">
            <div class="card">
              <div class="card-h"><h3>Sending accounts</h3><p>The inboxes your campaign sends from, rotated automatically.</p></div>
              <div class="note"><span>Use dedicated accounts on a separate sending domain &mdash; never your personal or main-business inbox. For best deliverability and to meet Gmail/Yahoo bulk rules, send through a domain with SPF, DKIM and DMARC set up (fill in the SMTP host below). Plain Gmail works for small volumes but can get throttled. Passwords are stored encrypted on this computer.</span></div>
              <div id="accounts"></div>
              <div id="accounts-empty" class="empty" hidden><b>No accounts yet</b>Add a Gmail address and its app password to send from.</div>
              <button type="button" class="btn sm addbtn" onclick="addAccount()">+ Add account</button>
              <div class="cardsep"></div>
              <span class="grouplbl">Sending limits &mdash; pacing that keeps your accounts healthy</span>
              <div class="grid3">
                <label class="fld"><span>Per account / day</span><input id="cap" type="number" inputmode="numeric"></label>
                <label class="fld"><span>Min wait (sec)</span><input id="mindelay" type="number" inputmode="numeric"></label>
                <label class="fld"><span>Max wait (sec)</span><input id="maxdelay" type="number" inputmode="numeric"></label>
              </div>
              <p class="hint">Start low &mdash; around 10&ndash;15 per account for the first week &mdash; so new accounts warm up safely.</p>
            </div>
            <div class="card">
              <div class="card-h"><h3>Campaign</h3><p>Daily volume, the legally required footer address, and your sample sites.</p></div>
              <input id="price" type="hidden">
              <div class="grid2">
                <label class="fld"><span>Emails to send per day (total)</span><input id="target" type="number" inputmode="numeric"></label>
                <label class="fld"><span>Mailing address <em class="opt">(shown in the footer &mdash; required by anti-spam law)</em></span><input id="address" placeholder="Your business, Street, City, Country"></label>
              </div>
              <div class="cardsep"></div>
              <span class="grouplbl">Do you have sample websites you want to show the recipients?</span>
              <div class="segrow" role="group" aria-label="Include sample websites">
                <button type="button" class="seg" id="use-samples-yes" onclick="setUseSamples(true)">Yes</button>
                <button type="button" class="seg on" id="use-samples-no" onclick="setUseSamples(false)">No</button>
              </div>
              <div id="samples-wrap" hidden>
                <p class="hint" style="margin:12px 0">The demo link shown in the email for each business type &mdash; it fills the <b>{link}</b> token.</p>
                <div id="samples"></div>
              </div>
            </div>
            <div class="card">
              <div class="card-h"><h3>Before you send</h3></div>
              <label class="check"><input type="checkbox" id="testmode"><span>Test mode<span class="sub">Previews every email in the log without sending. Turn off only when you're ready to send for real.</span></span></label>
              <div class="note" style="margin-top:12px;margin-bottom:0"><span>Every email carries your mailing address and a working unsubscribe, and the app checks your inboxes for &ldquo;stop&rdquo; replies and suppresses them automatically before each send. Read <b>LEGAL_AND_USE.txt</b> before going live.</span></div>
            </div>
            <div class="panel" id="imp-panel">
              <div class="ph"><span class="lbl">Import a CSV <em class="opt">(optional)</em></span><span class="meta">No scrape needed</span></div>
              <div class="pb">
                <p class="hint" style="margin:0 0 12px">Upload any CSV to send a campaign. Imported addresses are <b>your responsibility</b> to have a lawful basis to contact &mdash; your physical address and unsubscribe link are still added automatically.</p>
                <div class="csv-spec"><span class="cs-t">CSV format</span><ul><li>First row must be column headers</li><li>An <b>email</b> column with one address per row, like <code>owner@acmedental.com</code></li><li>Optionally a <b>business name</b> column &mdash; fills the <b>{business}</b> token in your email</li></ul></div>
                <div class="impflow">
                  <div class="impstep">
                    <span class="is-num" aria-hidden="true">1</span>
                    <div class="is-body">
                      <div class="is-t">Upload your CSV</div>
                      <div class="dropzone" id="imp-drop">
                        <div class="dz-row">
                          <input type="file" id="imp-file" accept=".csv">
                          <button type="button" class="btn sm" onclick="Imports.upload()">Upload CSV</button>
                          <button type="button" class="btn sm" onclick="Imports.reset()">Clear</button>
                        </div>
                        <p class="dz-hint">or drag &amp; drop a .csv file anywhere in this box</p>
                        <span class="hint dz-status" id="imp-status"></span>
                      </div>
                    </div>
                  </div>
                  <div class="impstep" id="imp-map">
                    <span class="is-num" aria-hidden="true">2</span>
                    <div class="is-body">
                      <div class="is-t">Map the columns</div>
                      <div class="dz-row">
                        <label class="fld colsel"><span>Email column</span><select id="imp-email-col" disabled></select></label>
                        <label class="fld colsel"><span>Business name column <em class="opt">(optional)</em></span><select id="imp-name-col" disabled><option value="">(none)</option></select></label>
                        <button type="button" class="btn sm" onclick="Imports.confirmMap()" disabled>Confirm mapping</button>
                      </div>
                      <p class="hint">Once mapped, choose it under <b>Send to</b> in the bar below.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <aside class="side-col">
            <div class="panel">
              <div class="ph"><span class="lbl">Email preview</span><span class="meta">editable</span></div>
              <div class="pb">
                <div class="mail">
                  <div class="mh"><div class="r"><span class="k">From</span><b id="pv-from">you &lt;you@gmail.com&gt;</b></div><div class="r"><span class="k">To</span><span>a prospect business</span></div></div>
                  <input id="pv-subj" class="subjin" placeholder="Subject line" aria-label="Email subject">
                  <textarea id="pv-body" class="bodyin" rows="13" aria-label="Email body" placeholder="Write your email&#8230;"></textarea>
                </div>
                <p class="tokhelp">Filled in for each business &mdash; click to insert: <code onclick="insTok('{business}')">{business}</code> <code onclick="insTok('{link}')">{link}</code> <code onclick="insTok('{sender}')">{sender}</code> <code onclick="insTok('{address}')">{address}</code></p>
              </div>
            </div>
            <div class="panel">
              <div class="ph"><span class="lbl">Daily capacity</span></div>
              <div class="pb"><div class="stat"><span class="v" id="cap-num">0</span><span class="u" id="cap-u">emails / day</span></div><p class="hint" id="cap-note"></p></div>
            </div>
          </aside>
        </div>
        <div class="runbar">
          <div class="rb-req" id="req-send" hidden></div>
          <div class="rb-row">
            <div class="node" id="node-send" hidden>
              <span class="dotn" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M21 3 10 14M21 3l-7 18-4-8-8-4 19-6Z"/></svg></span>
              <span class="rb-text"><span class="ttl">Send campaign</span><span class="cnt" id="cnt-send">Not started</span></span>
            </div>
            <span class="rb-status" hidden><span class="statusdot" id="sdot-send" aria-hidden="true"></span><span class="rb-stage" id="stage-send">idle</span></span>
            <div class="rb-actions">
              <button type="button" class="mode test" id="mode" title="Change test mode above" onclick="el('testmode').scrollIntoView({behavior:'smooth',block:'center'})">Test mode</button>
              <label class="rb-src"><span>Send to</span><select id="imp-picker" aria-label="List to send to"><option value="">Collected businesses</option></select></label>
              <button type="button" class="opbtn go run" id="btn-send" onclick="sendCampaign()">Send campaign</button>
              <button type="button" class="opbtn halt" id="stopbtn-send" onclick="stopRun()" disabled>Stop</button>
            </div>
          </div>
          <div class="meter" id="meter-send"><div class="ml"><span class="t" id="meter-t-send">Working</span><span class="pc" id="meter-pc-send"></span></div><div class="bar" id="bar-send" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="bar-fill-send"></i></div></div>
        </div>
      </section>

      <!-- LOGS -->
      <section class="view" id="v-logs" aria-labelledby="vtitle" tabindex="-1">
        <div class="dash">
          <div class="panel">
            <div class="ph"><span class="lbl">Past runs</span><span class="meta" id="hist-count"></span></div>
            <div class="hist" id="hist"><div class="empty" style="border:none;background:none;padding:18px 10px"><b>No runs yet</b>Everything you run is saved here and waiting next time you open the app.</div></div>
          </div>
          <div class="panel logpanel">
            <div class="ph"><span class="lbl">Session log</span><span class="meta" id="logs-meta">&mdash;</span><button type="button" class="btn sm" id="logs-clear-btn" onclick="clearLogs()">Clear</button></div>
            <div class="log" id="logs-con" role="log" aria-live="polite" aria-label="Session log"><span class="ph2">Log is empty.</span></div>
          </div>
        </div>
      </section>

      <!-- INVOICE -->
      <section class="view" id="v-invoice" aria-labelledby="vtitle" tabindex="-1">
        <div class="cols">
          <div class="main-col">
            <div class="card">
              <div class="card-h"><h3>Your business details</h3><p>Saved once, reused on every invoice and agreement.</p></div>
              <div class="grid2">
                <label class="fld"><span>Business / your name</span><input id="biz-name" placeholder="AdFlorea"></label>
                <label class="fld"><span>Email</span><input id="biz-email" placeholder="hi@adflorea.tech"></label>
                <label class="fld"><span>Phone</span><input id="biz-phone" placeholder="+1 ..."></label>
                <label class="fld"><span>Tax ID <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(EIN / VAT / GSTIN &mdash; optional, shown on the invoice)</span></span><input id="biz-gstin" class="mono" placeholder="leave blank if none"></label>
              </div>
              <label class="fld" style="margin-top:14px"><span>Address</span><input id="biz-addr" placeholder="Austin, TX, USA"></label>
              <div class="eb" style="margin-top:20px">How clients pay you <span style="text-transform:none;letter-spacing:0;color:var(--faint);font-weight:400">&mdash; fill any that apply, they all show on the invoice</span></div>
              <div class="grid2">
                <label class="fld"><span>UPI ID <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(India &mdash; adds a QR)</span></span><input id="biz-upi" class="mono" placeholder="you@okbank"></label>
                <span></span>
                <label class="fld"><span>Online payment link</span><input id="biz-paylink" class="mono" placeholder="Stripe / PayPal / Wise / Razorpay link"></label>
                <label class="fld"><span>Button label</span><input id="biz-paylabel" placeholder="Pay with card"></label>
                <label class="fld"><span>Second payment link <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(optional)</span></span><input id="biz-paylink2" class="mono" placeholder="e.g. PayPal.me link"></label>
                <label class="fld"><span>Its label</span><input id="biz-paylabel2" placeholder="Pay with PayPal"></label>
              </div>
              <label class="fld" style="margin-top:14px"><span>Bank / wire transfer details <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(for international transfers &mdash; account name, number, IFSC / routing / SWIFT / IBAN)</span></span><textarea id="biz-bank" placeholder="Beneficiary: ...&#10;Bank: ...&#10;Account no: ...&#10;IFSC / Routing / SWIFT / IBAN: ..."></textarea></label>
              <p class="hint">Saved with <b>Save changes</b>. Fill once. UPI adds a scannable QR; for other methods the invoice shows a scannable QR of your first payment link plus the buttons and bank details. Everything is generated on your machine &mdash; no payment account or fee needed on our side.</p>
            </div>

            <div class="card">
              <div class="card-h"><h3>This invoice</h3><p>Who it's for and how it's taxed.</p></div>
              <div class="grid2">
                <label class="fld"><span>Client name</span><input id="iv-cname" placeholder="Bright Smile Dental"></label>
                <label class="fld"><span>Client email</span><input id="iv-cemail" placeholder="owner@brightsmile.com"></label>
                <label class="fld" style="grid-column:1/3"><span>Client address</span><input id="iv-caddr" placeholder="Austin, TX, USA"></label>
                <label class="fld"><span>Invoice no. <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(blank = auto)</span></span><input id="iv-no" class="mono" placeholder="auto"></label>
                <label class="fld"><span>Date <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(blank = today)</span></span><input id="iv-date" placeholder="Jun 20, 2026"></label>
                <label class="fld"><span>Due date</span><input id="iv-due" placeholder="optional"></label>
                <label class="fld"><span>Payment terms</span><select id="iv-terms"><option value="">(none)</option><option>Due on receipt</option><option>Net 7</option><option>Net 15</option><option>Net 30</option><option>Net 60</option></select></label>
                <label class="fld"><span>PO number <em class="opt">(optional)</em></span><input id="iv-po" class="mono" placeholder="optional"></label>
                <label class="fld"><span>Currency</span><select id="iv-cur"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option><option>AED</option><option>SGD</option><option>INR</option></select></label>
              </div>
              <div class="grid3" style="margin-top:14px">
                <label class="fld"><span>Tax</span><select id="iv-gst" onchange="gstToggle()"><option value="none">No tax</option><option value="percent">Sales tax (%)</option><option value="export">Tax exempt / zero-rated</option><option value="gst">GST (India)</option></select></label>
                <label class="fld taxonly" hidden><span>Tax rate %</span><input id="iv-rate" class="mono" placeholder="8.5"></label>
                <label class="fld gstonly" hidden><span>Supply</span><select id="iv-supply"><option value="intra">Same state (CGST+SGST)</option><option value="inter">Other state (IGST)</option></select></label>
                <label class="fld gstonly" hidden style="grid-column:1/4"><span>Place of supply</span><input id="iv-pos" placeholder="state where the service is consumed"></label>
                <label class="fld gstonly" hidden style="grid-column:1/4"><span>Client GSTIN <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(if B2B registered)</span></span><input id="iv-cgstin" class="mono"></label>
              </div>
            </div>

            <div class="card">
              <div class="card-h"><h3>Items</h3><p>What you're billing for.</p></div>
              <div id="iv-items"></div>
              <button type="button" class="btn sm addbtn" onclick="addItem()">+ Add item</button>
              <label class="fld" style="margin-top:14px"><span>Notes / terms (optional)</span><textarea id="iv-notes" placeholder="Payment due within 7 days. Thank you!"></textarea></label>
              <button type="button" class="btn primary" style="margin-top:14px" onclick="genInvoice()">Generate invoice</button>
              <p class="hint">Opens a clean invoice in a new tab. Click <b>Print / Save as PDF</b> there to download it.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- AGREEMENT -->
      <section class="view" id="v-agreement" aria-labelledby="vtitle" tabindex="-1">
        <div class="cols">
          <div class="main-col">
            <div class="card">
              <div class="card-h"><h3>The deal</h3><p>Uses <b>your business details</b> from the Invoice tab (fill them there once). Below are the deal-specific terms.</p></div>
              <div class="grid2">
                <label class="fld"><span>Client name</span><input id="ag-cname" placeholder="Bright Smile Dental"></label>
                <label class="fld"><span>Client address</span><input id="ag-caddr" placeholder="Austin, TX, USA"></label>
              </div>
              <label class="fld" style="margin-top:14px"><span>Scope of work</span><textarea id="ag-scope" placeholder="Meta Ads management, monthly reporting, and one landing page."></textarea></label>
              <div class="grid2" style="margin-top:14px">
                <label class="fld"><span>Fee</span><input id="ag-fee" placeholder="$1,500 per month"></label>
                <label class="fld"><span>Currency</span><select id="ag-cur"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option><option>AED</option><option>INR</option></select></label>
                <label class="fld"><span>Revisions included</span><input id="ag-rev" placeholder="two (2)"></label>
                <label class="fld"><span>Timeline</span><input id="ag-time" placeholder="4 weeks from kickoff"></label>
                <label class="fld" style="grid-column:1/3"><span>Payment terms</span><input id="ag-pay" placeholder="50% advance, 50% on completion within 7 days"></label>
                <label class="fld"><span>Governing law</span><input id="ag-law" placeholder="United States"></label>
              </div>
              <button type="button" class="btn primary" style="margin-top:14px" onclick="genAgreement()">Generate agreement</button>
              <p class="hint">Opens a ready-to-sign agreement in a new tab (Print / Save as PDF there). It's a solid template, not legal advice &mdash; have it reviewed for anything high-value.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- SHEETS -->
      <section class="view" id="v-sheets" aria-labelledby="vtitle" tabindex="-1">
        <link rel="stylesheet" href="/assets/workspace-shell.css?v=restore1">
        <meta name="csrf-token" content="__CSRF_TOKEN__">
        <div id="lumen-workspace" data-integrated="true"><div class="workspace-loading">Opening your workspace…</div></div>
        <script defer src="/assets/workspace-shell.js?v=restore1"></script>
        <details id="legacy-sheets"><summary>Legacy sheets — existing spreadsheets and follow-up workflows</summary>
        <div class="sheets-list">
          <div class="sheetlist-h"><span>Your lists</span><span class="sheetlist-acts"><input type="file" id="sheet-import-file" accept=".csv,.xlsx,.xls" hidden><button type="button" class="btn sm" onclick="el('sheet-import-file').click()">Import CSV / Excel</button><button type="button" class="btn sm" onclick="Sheets.create()">+ New list</button></span></div>
          <div id="sheet-items" class="sheet-grid"></div>
          <div id="sheet-empty" class="empty" hidden><b>No legacy lists yet</b>Your new writing workspace is above.</div>
        </div>
        </details>
      </section>

      <section class="view" id="v-website-builder" aria-labelledby="vtitle" tabindex="-1">
        <div id="wb-frame-wrap" class="wb-wrap">
          <div id="wb-loading" class="wb-loading">
            <div class="wb-spin" aria-hidden="true"></div>
            <div class="wb-loadtxt">Starting the website builder engine&hellip;</div>
            <div class="wb-loadsub">First start can take a few seconds while Website Studio opens.</div>
          </div>
          <div id="wb-error" class="wb-error" hidden>
            <b>Couldn't reach the website builder service.</b>
            <span>The local audit engine is still starting up &mdash; this can take a few seconds the first time. Give it a moment and click Retry.</span>
            <button type="button" class="btn primary" id="wb-retry">Retry</button>
          </div>
          <iframe id="wb-frame" class="wb-frame" title="Website Builder" hidden></iframe>
        </div>
      </section>
__ADMIN_VIEW__
      <section class="view" id="v-settings" aria-labelledby="vtitle" tabindex="-1">
        <div id="settings-home">
          <div class="settings-intro"><span class="ui-eyebrow">YOUR PREFERENCES</span><h2>A little more your own.</h2><p>Choose what you would like to manage.</p></div>
          <div class="settings-options">
            <button type="button" class="settings-option" onclick="openSettingsPage('theme')"><span class="settings-option-icon" aria-hidden="true">◐</span><span><strong>Theme</strong><small>Light or dark, with ten colour combinations to make Lumen yours.</small></span><span aria-hidden="true">&#8594;</span></button>
            <button type="button" class="settings-option" onclick="openSettingsPage('keys')"><span class="settings-option-icon" aria-hidden="true">⚿</span><span><strong>API keys</strong><small>Manage your Google Places and Groq connections.</small></span><span aria-hidden="true">&#8594;</span></button>
          </div>
        </div>
        <div id="settings-detail" hidden>
          <button type="button" class="btn settings-back" onclick="openSettingsPage('home')">&#8592; All settings</button>
          <h2 id="settings-page-title" tabindex="-1"></h2>
          <div id="settings-theme" hidden></div>
          <div id="settings-keys" hidden>
        <div class="grid2 split">
          <div class="card">
            <div class="card-h"><h3>Groq API key</h3><p>Powers the AI chat assistant. Stored encrypted on this computer.</p></div>
            <label class="fld"><span>Your API key</span><input id="set-groq" class="mono" placeholder="gsk_..." autocomplete="off" spellcheck="false"></label>
            <p class="hint">Leave blank to keep the key you already saved.</p>
            <button type="button" class="btn sm danger" style="margin-top:10px" onclick="removeKey('groq_api_key')">Remove key</button>
          </div>
          <div class="card">
            <div class="card-h"><h3>Google Places API key</h3><p>Used by Business Information to collect businesses through Google's official, licensed Places API.</p></div>
            <label class="fld"><span>Your API key</span><input id="set-places" class="mono" placeholder="AIza..." autocomplete="off" spellcheck="false"></label>
            <p class="hint">Stored encrypted on this computer. Leave blank to keep the key you already saved.</p>
            <button type="button" class="btn sm danger" style="margin-top:10px" onclick="removeKey('places_api_key')">Remove key</button>
          </div>
        </div>
        <button type="button" class="btn primary" style="margin-top:16px" onclick="saveCfg(true,function(){paintSettingsMask(cfg)})">Save keys</button>
          </div>
        </div>
      </section>
    </div>
  </main>
  </div>
</div>
<div class="cfgerr" id="cfgerr" role="alert" hidden><span><b>Couldn't load your settings.</b> This copy runs locally &mdash; try again in a moment.</span><span class="sp"></span><button type="button" id="cfgerr-retry">Retry</button></div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<div class="upgate" id="upgate"><div class="upcard"><div class="v" id="upgate-v"></div><h2>Update required</h2><p id="upgate-notes">A new version is available. You'll need to update to keep using the app.</p><button id="upgate-go" type="button">Download the update</button></div></div>

<button type="button" class="chat-fab" id="chat-fab" aria-label="Open AI chat" aria-expanded="false" title="AI Chat">
  <svg class="chat-fab-icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <svg class="chat-fab-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
</button>
<div class="chat-panel" id="chat-panel" hidden role="dialog" aria-label="AI Chat">
  <div class="chat-panel-bar">
    <span class="chat-panel-title">AI Chat</span>
    <button type="button" class="chat-panel-x" id="chat-panel-close" aria-label="Close chat">&times;</button>
  </div>
  <div id="ab-frame-wrap" class="wb-wrap">
    <div id="ab-loading" class="wb-loading">
      <div class="wb-spin" aria-hidden="true"></div>
      <div class="wb-loadtxt">Starting the AI chat engine&hellip;</div>
      <div class="wb-loadsub">First start can take a few seconds while the local assistant warms up.</div>
    </div>
    <div id="ab-error" class="wb-error" hidden>
      <b>Couldn't reach the AI chat service.</b>
      <span>The assistant isn't responding yet. Make sure Node.js 22.5+ is installed and the Agency Brain has been built (see RUN_FROM_SCRATCH.md).</span>
      <button type="button" class="btn primary" id="ab-retry">Retry</button>
    </div>
    <iframe id="ab-frame" class="wb-frame" title="Agency Brain" hidden></iframe>
  </div>
</div>

<div class="sheet-editor" id="sheet-editor">
  <div class="se-bar">
    <button type="button" class="se-back" onclick="Sheets.back()"><span aria-hidden="true">&larr;</span> Back to lists</button>
    <span class="se-name" id="sheetname-disp"></span>
    <span class="sp"></span>
    <span class="savestate" id="sheet-save"></span>
    <button type="button" class="btn sm" id="fu-btn" onclick="Sheets.followup()">Follow-up</button>
    <button type="button" class="btn sm" onclick="Sheets.rename()">Rename</button>
    <button type="button" class="btn sm danger" onclick="Sheets.del()">Delete</button>
  </div>
  <div class="fx-bar">
    <span class="fx-name" id="fx-name">A1</span>
    <span class="fx-lbl" aria-hidden="true">fx</span>
    <input id="fx-input" class="fx-input" autocomplete="off" spellcheck="false" aria-label="Formula bar" placeholder="">
  </div>
  <div id="xs-viewport" class="xs-viewport">
    <div id="xs-host" class="xs-host"></div>
    <div class="xs-zoom" id="xs-zoom">
      <button type="button" class="xs-zoom-btn" id="xs-zoom-out" aria-label="Zoom out">&minus;</button>
      <span class="xs-zoom-pct" id="xs-zoom-pct">100%</span>
      <button type="button" class="xs-zoom-btn" id="xs-zoom-in" aria-label="Zoom in">+</button>
    </div>
    <button type="button" class="xs-addrows" id="xs-addrows" onclick="Sheets.addRows(1000)">+ 1,000 more rows</button>
  </div>
</div>
<div class="fu-ov" id="fu-modal">
  <div class="fu-card">
    <button type="button" class="fu-x" onclick="Sheets.fuClose()" aria-label="Close">&times;</button>
    <h2 id="fu-title">Enable follow-up</h2>
    <p class="fu-note">Only <b>Email</b> follow-ups are sent automatically. Rows set to <b>Phone/SMS</b> or <b>WhatsApp</b> are listed for you to send by hand.</p>
    <label class="fld"><span>Email subject</span><input id="fu-subject" placeholder="Following up on my note"></label>
    <label class="fld"><span>Message</span><textarea id="fu-body" rows="7" placeholder="Hi {name}, just circling back on my note about {business}..."></textarea></label>
    <p class="fu-tok">Tokens like {name} {business} {email} fill from each row's columns.</p>
    <div class="fu-actions">
      <button type="button" class="btn primary" id="fu-save" onclick="Sheets.fuEnable()">Enable follow-up</button>
      <button type="button" class="btn" id="fu-start" onclick="Sheets.fuStart()" hidden>Start follow-up</button>
      <button type="button" class="btn danger" id="fu-disable" onclick="Sheets.fuDisable()" hidden>Disable</button>
    </div>
    <div id="fu-result" class="fu-result" hidden></div>
  </div>
</div>
<script>
var cfg={},dirty=false,wasRunning=false,selHist=null,liveCounts={},histCache=[];
function el(id){return document.getElementById(id)}
var ART=window.__ART__||{};
var TITLES={
  "business-info":["Business Information","Choose the kinds of business you want to reach and where.","Workflow"],
  "find-emails":["Find Emails","Scan businesses for a published contact email.","Workflow"],
  "email-outreach":["Email Outreach","Set up your sending accounts and send the campaign.","Workflow"],
  logs:["Logs","Live output from whatever is currently running or just ran.","Session"],
  invoice:["Invoice","Bill a client and get paid, anywhere in the world.","Documents"],
  agreement:["Service Agreement","Put a simple, signable contract in front of the client.","Documents"],
  sheets:["Workspace","A home for your notes, plans, and collections.","Workspace"],
  crm:["CRM","Contacts, calls, deals and the next step for every lead.","Sales"],
  "website-builder":["Website Studio","Choose a theme, build visually, and export your own website.","Website Builder"],
__ADMIN_TITLE__  settings:["Settings","Choose your appearance and manage your API keys.","Settings"]
};
/* Hero art retired: the #herobg element was permanently hidden and ART is keyed
   by legacy page names (targets/outreach/run) that no current view uses, so this
   never rendered anything. Kept as a no-op so every existing call site is safe.
   The server-side EMBED constant is intentionally left untouched. */
function setArt(v){}
var __booted=false,__bootT=Date.now(),__vlT;
function hideBoot(){if(__booted)return;__booted=true;var b=el('boot');if(!b)return;
  var wait=Math.max(0,900-(Date.now()-__bootT));
  setTimeout(function(){b.classList.add('off');setTimeout(function(){try{b.remove()}catch(e){}},560)},wait)}
setTimeout(hideBoot,4500);
function viewPulse(){if(!__booted)return;var v=el('viewload');if(!v)return;
  v.classList.add('on');clearTimeout(__vlT);__vlT=setTimeout(function(){v.classList.remove('on')},380)}
function openSettingsPage(page,focus){
  if(!['home','theme','keys'].includes(page))page='home';
  var home=page==='home';
  el('settings-home').hidden=!home;el('settings-detail').hidden=home;
  el('settings-theme').hidden=page!=='theme';el('settings-keys').hidden=page!=='keys';
  el('settings-page-title').textContent=page==='theme'?'Theme':'API keys';
  try{sessionStorage.setItem('lumen-settings-page',page)}catch(e){}
  if(focus!==false){
    var target=home?document.querySelector('.settings-option'):el('settings-page-title');
    if(target)target.focus({preventScroll:true});
    var content=el('content');if(content)content.scrollTop=0;
  }
}
function show(v){
  if(!TITLES[v] || !Array.from(document.querySelectorAll('.navi')).some(function(n){return n.dataset.view===v}))return;
  try{sessionStorage.setItem('lumen-active-section',v)}catch(e){}
  document.body.dataset.view=v;
  if(window.__lastView!==v){viewPulse();window.__lastView=v}
  document.querySelectorAll('.navi').forEach(function(n){if(n.dataset.view===v)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current')});
  document.querySelectorAll('.view').forEach(function(s){s.classList.toggle('on',s.id==='v-'+v)});
  el('vtitle').textContent=TITLES[v][0];el('vdesc').textContent=TITLES[v][1];el('crumb').textContent=TITLES[v][2];
  if(v==='settings'){var settingsPage='home';try{settingsPage=sessionStorage.getItem('lumen-settings-page')||'home'}catch(e){}openSettingsPage(settingsPage,false)}
  if(v==='email-outreach')renderSamples();
  if(v==='crm' && window.LumenCRM){LumenCRM.open()}
  if(v==='sheets'){if(window.LumenWorkspace)LumenWorkspace.open();Sheets.enter()}
  if(v==='website-builder'){WB.enter()}
__ADMIN_SHOW_HOOK__  setArt(v);var sec=el('v-'+v);if(sec){try{sec.focus({preventScroll:true})}catch(e){}}
  var c=el('content');if(c)c.scrollTop=0;
}
document.querySelectorAll('.navi').forEach(function(n){n.onclick=function(){show(n.dataset.view)}});

/* Website Builder: boot the local audit service via the bridge, then embed it. */
var WB=(function(){
  var booted=false, ready=false;
  function showState(s){
    var l=el('wb-loading'),e=el('wb-error'),f=el('wb-frame');
    if(!l||!e||!f)return;
    l.hidden=(s!=='loading'); e.hidden=(s!=='error'); f.hidden=(s!=='ready');
  }
  function load(){
    showState('loading');
    fetch('/website-builder/ensure',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
      if(d&&d.ready){
        var f=el('wb-frame');
        if(!f.src){f.src='http://127.0.0.1:'+(d.port||3001)+'/';}
        f.onload=function(){ready=true;showState('ready')};
        // in case onload already fired or is cached
        setTimeout(function(){if(!ready)showState('ready')},1200);
      }else{showState('error')}
    }).catch(function(){showState('error')});
  }
  var rb=el('wb-retry'); if(rb){rb.onclick=function(){ready=false;var f=el('wb-frame');if(f){f.removeAttribute('src')}load()}}
  return {enter:function(){ if(ready){showState('ready');return} load(); booted=true; }};
})();

/* Agency Brain: embed the hosted assistant directly. */
var AB=(function(){
  var ready=false;
  function showState(s){var l=el('ab-loading'),e=el('ab-error'),f=el('ab-frame');if(!l||!e||!f)return;l.hidden=(s!=='loading');e.hidden=(s!=='error');f.hidden=(s!=='ready');}
  function load(){
    showState('loading');
    var f=el('ab-frame');
    if(!f){showState('error');return}
    if(!f.src){f.src='https://lumen-brain.vercel.app/chat';}
    f.onload=function(){
      ready=true;showState('ready');
      fetch('/my-groq-key').then(function(r){return r.json()}).then(function(d){
        var k=d&&d.key;
        if(k){f.contentWindow.postMessage({type:'lumen-groq-key',key:k},'https://lumen-brain.vercel.app')}
      }).catch(function(){});
    };
    f.onerror=function(){showState('error')};
    setTimeout(function(){if(!ready)showState('ready')},1500);
  }
  var rb=el('ab-retry'); if(rb){rb.onclick=function(){ready=false;var f=el('ab-frame');if(f){f.removeAttribute('src')}load()}}
  return {enter:function(){ if(ready){showState('ready');return} load(); }};
})();

/* Floating AI Chat launcher: owns only open/closed state; delegates the
   lazy-load + Groq-key handshake to AB.enter(), unchanged. */
var ChatWidget=(function(){
  var open=false;
  var fab=el('chat-fab'), panel=el('chat-panel'), closeBtn=el('chat-panel-close');
  function setOpen(v){
    open=v;
    if(panel)panel.hidden=!open;
    if(fab){fab.classList.toggle('open',open);fab.setAttribute('aria-expanded',open?'true':'false')}
    if(open)AB.enter();
  }
  if(fab)fab.onclick=function(){setOpen(!open)};
  if(closeBtn)closeBtn.onclick=function(){setOpen(false)};
  return {open:function(){setOpen(true)},close:function(){setOpen(false)}};
})();

/* First-run walkthrough. Narrates at the nav level so it stays safe with the
   cross-origin Website Builder / AI Assistant iframes (which the parent page
   cannot spotlight into). Auto-runs once per TOUR_VERSION; replay via the ?
   button. "Seen" state persists in config.json (onboarded_tour). */
var Tour=(function(){
  var VERSION=1;
  var steps=[],i=0,active=false,prevFocus=null,curTour='global',block,spot,tip;
  function role(){return window.__ROLE__||'user'}
  function q(sel){return document.querySelector(sel)}
  function activeView(){var n=q('.navi[aria-current=page]');return (n&&n.dataset.view)||'business-info'}
  function buildGlobal(){
    var s=[];
    s.push({title:'Welcome to Lumen',body:'A quick 30-second orientation. Every section also has its own detailed walkthrough - here is what you need to get started.'});
    s.push({target:'.navi[data-view=settings]',title:'1 - Add your API keys',body:'Open Settings and paste your Google Places key (needed to collect leads) and your Groq key (for the AI assistant). Not much works until these are set.'});
    s.push({target:'#save-btn',title:'2 - Save your changes',body:'After you edit anything, click Save changes to store it on this computer.'});
    s.push({target:'#sect-help',title:'3 - Each section has a walkthrough',body:'Every section shows this Walkthrough button. Click it anytime for a step-by-step guide to just that section.'});
    s.push({title:'You are ready',body:'Open any section and press its Walkthrough for the details. Replay this overview anytime from the ? in the top bar.'});
    return s;
  }
  function buildSection(view){
    var T={
      'business-info':[
        {target:'#niches',title:'Business types',body:'List the kinds of business you want to reach - dentists, cafes, gyms, and so on. Add as many as you like.'},
        {target:'#cities',title:'Locations',body:'Add the cities or areas to target, one per line.'},
        {target:'#btn-collect',title:'Collect businesses',body:'Once your types and cities are set, this pulls matching businesses from Google Places. (Set your Places API key in Settings first.)'}
      ],
      'find-emails':[
        {target:'#btn-find',title:'Find emails',body:'Scans each collected business site for its own published contact email - never guessed or generated.'},
        {target:'#find-imp-drop',title:'Or import a list',body:'Already have leads? Import a CSV here and Lumen will find emails for those rows instead.'}
      ],
      'email-outreach':[
        {target:'#accounts',title:'Sending accounts',body:'Add the email account(s) you will send from - a dedicated address, not your main inbox. Use + Add account.'},
        {target:'#address',title:'Mailing address',body:'A real postal address shown in every footer. It is legally required before any live send.'},
        {target:'#pv-subj',title:'Your message',body:'Write your subject and body. Placeholders like {business} and {link} fill in per recipient.'},
        {target:'#btn-send',title:'Send the campaign',body:'Starts sending. Keep test mode on for a dry run first - nothing goes out until you turn it off.'}
      ],
      'logs':[
        {target:'#logs-con',title:'Live log',body:'Follow the current run step by step as it happens.'},
        {target:'#hist',title:'Run history',body:'Every past run and its results are kept here.'}
      ],
      'sheets':[
        {target:'#lumen-workspace',title:'Your workspace',body:'Create pages and subpages, type / to add blocks, and build tables or collections. Your existing spreadsheets and follow-up workflows remain under Legacy sheets below.'}
      ],
      'invoice':[
        {target:'#biz-name',title:'Your details',body:'Fill your business details once - they prefill every invoice and agreement.'},
        {target:'#iv-items',title:'Line items',body:'Add what you are billing for; the totals compute automatically.'}
      ],
      'agreement':[
        {target:'#ag-scope',title:'Scope and terms',body:'Describe the work, fee, and terms. The finished agreement is generated on your machine.'}
      ],
      'settings':[
        {target:'#set-places',title:'Google Places key',body:'Paste your Google Places API key here - required to collect leads.'},
        {target:'#set-groq',title:'Groq key',body:'Paste your Groq API key here to enable the AI assistant.'}
      ],
      'website-builder':[
        {target:'.navi[data-view=website-builder]',title:'Website Studio',body:'Choose a theme, drag sections onto your pages, edit text and design, or start with an AI draft. Save a backup and export your finished website. Audit and planning tools are also available.'}
      ],
      'admin':[
        {target:'.navi[data-view=admin]',title:'Admin console',body:'Manage licenses and the shared knowledge base. This opens the hosted admin console inside Lumen.'}
      ]
    };
    return T[view]||[];
  }
  function build(name){
    var raw=name==='global'?buildGlobal():buildSection(name);
    var out=raw.filter(function(st){return !st.target||q(st.target)});
    if(name!=='global'&&!out.length&&q('#v-'+name))out=[{target:'#v-'+name,title:'This section',body:'Explore the controls here - a detailed walkthrough for this section is coming soon.'}];
    return out;
  }
  function ensureEls(){
    if(block)return;
    block=document.createElement('div');block.className='tour-block';
    spot=document.createElement('div');spot.className='tour-spot';
    tip=document.createElement('div');tip.className='tour-tip';
    tip.setAttribute('role','dialog');tip.setAttribute('aria-live','polite');
    document.body.appendChild(block);document.body.appendChild(spot);document.body.appendChild(tip);
  }
  function place(st){
    var t=st.target?q(st.target):null;
    var lvl=0;   // if the target is hidden/empty/zero-size, climb to a visible sized ancestor
    while(t&&lvl<4){var rc=t.getBoundingClientRect();if(rc.width>8&&rc.height>8)break;t=t.parentElement;lvl++}
    if(!t||t===document.body){block.classList.add('dim');spot.style.display='none';
      tip.style.left='50%';tip.style.top='42%';tip.style.transform='translate(-50%,-50%)';return}
    block.classList.remove('dim');spot.style.display='block';tip.style.transform='none';
    var r=t.getBoundingClientRect(),pad=6;
    spot.style.left=(r.left-pad)+'px';spot.style.top=(r.top-pad)+'px';
    spot.style.width=(r.width+pad*2)+'px';spot.style.height=(r.height+pad*2)+'px';
    var tw=tip.offsetWidth||320,th=tip.offsetHeight||160,gap=14,left,top;
    if(r.right+gap+tw<window.innerWidth){left=r.right+gap;top=r.top}
    else if(r.bottom+gap+th<window.innerHeight){left=r.left;top=r.bottom+gap}
    else{left=r.left;top=r.top-th-gap}
    left=Math.min(Math.max(12,left),window.innerWidth-tw-12);
    top=Math.min(Math.max(12,top),window.innerHeight-th-12);
    tip.style.left=left+'px';tip.style.top=top+'px';
  }
  function render(){
    var st=steps[i];
    if(st.target&&window.LumenInterface)window.LumenInterface.reveal(st.target);
    if(st.view){try{show(st.view)}catch(e){}}
    tip.innerHTML='';
    var h=document.createElement('h4');h.textContent=st.title;tip.appendChild(h);
    var p=document.createElement('p');p.textContent=st.body;tip.appendChild(p);
    var row=document.createElement('div');row.className='tour-row';
    var cnt=document.createElement('span');cnt.className='tour-count';cnt.textContent=(i+1)+' / '+steps.length;row.appendChild(cnt);
    if(i>0){var b=document.createElement('button');b.type='button';b.className='btn sm';b.textContent='Back';b.onclick=prev;row.appendChild(b)}
    var nx=document.createElement('button');nx.type='button';nx.className='btn primary sm';nx.textContent=(i===steps.length-1?'Done':'Next');nx.onclick=next;row.appendChild(nx);
    tip.appendChild(row);
    var sk=document.createElement('button');sk.type='button';sk.className='tour-skip';sk.textContent='Skip tour';sk.onclick=function(){end()};tip.appendChild(sk);
    var t=st.target?q(st.target):null;
    if(t&&t.scrollIntoView){try{t.scrollIntoView({block:'center',behavior:'auto'})}catch(e){}}
    setTimeout(function(){place(st);try{nx.focus({preventScroll:true})}catch(e){}},30);
    setTimeout(function(){place(st)},300);
  }
  function next(){if(i>=steps.length-1){end()}else{i++;render()}}
  function prev(){if(i>0){i--;render()}}
  function onKey(e){if(!active)return;
    if(e.key==='Escape'){end()}
    else if(e.key==='ArrowRight'){e.preventDefault();next()}
    else if(e.key==='ArrowLeft'){e.preventDefault();prev()}}
  function reposition(){if(active)place(steps[i])}
  function run(name){
    if(active)end();
    steps=build(name);if(!steps.length)return;
    curTour=name;
    if(name!=='global'){try{show(name)}catch(e){}}
    prevFocus=document.activeElement;i=0;active=true;ensureEls();
    block.style.display='block';tip.style.display='block';
    document.addEventListener('keydown',onKey,true);
    window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);
    render();
  }
  function start(){run('global')}
  /* Website Builder runs in a cross-origin iframe the parent tour can't spotlight
     into, so its walkthrough lives INSIDE that tool. Hand off: open the tab and
     ping the iframe to start its own tour (pings on an interval to cover the
     iframe's load/warm-up; stops as soon as the tool acks). */
  function wbHandoff(){
    try{show('website-builder')}catch(e){}
    try{if(window.WB&&WB.enter)WB.enter()}catch(e){}
    var f=el('wb-frame');if(!f)return;
    var tries=0,iv=null;
    function ackH(ev){if(ev&&ev.data&&ev.data.type==='lumen-wb-tour-ack'){if(iv)clearInterval(iv);window.removeEventListener('message',ackH)}}
    window.addEventListener('message',ackH);
    iv=setInterval(function(){
      tries++;
      try{if(f.contentWindow&&f.src){var o='*';try{o=new URL(f.src).origin}catch(e){}f.contentWindow.postMessage({type:'lumen-wb-tour'},o)}}catch(e){}
      if(tries>=24){clearInterval(iv);window.removeEventListener('message',ackH)}
    },700);
  }
  function section(name){var v=name||activeView();if(v==='website-builder'){wbHandoff();return}run(v)}
  function markSeen(){
    try{if(window.cfg)cfg.onboarded_tour=VERSION}catch(e){}
    try{fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({onboarded_tour:VERSION})}).catch(function(){})}catch(e){}
  }
  function end(){
    if(!active)return;active=false;
    document.removeEventListener('keydown',onKey,true);
    window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);
    if(block){block.style.display='none';block.classList.remove('dim')}
    if(spot)spot.style.display='none';if(tip)tip.style.display='none';
    if(curTour==='global')markSeen();
    try{if(prevFocus&&prevFocus.focus)prevFocus.focus({preventScroll:true})}catch(e){}
  }
  function autoStart(){
    try{if(cfg&&cfg.onboarded_tour===VERSION)return}catch(e){}
    setTimeout(function(){if(!active)start()},900);
  }
  return {start:start,section:section,run:run,autoStart:autoStart,end:end};
})();
__ADMIN_JS__
var toastT;function toast(m,kind){var t=el('toast');t.textContent=m;t.className='toast'+(kind?' '+kind:'');t.classList.add('show');t.setAttribute('role',kind==='err'?'alert':'status');clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove('show')},kind==='err'?6000:3600)}
(function(){var rb=el('cfgerr-retry');if(rb)rb.onclick=function(){var b=el('cfgerr');if(b)b.hidden=true;loadCfg()}})();
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}

var nicheSeq=0, linkById={};
var PRM=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
function animateNum(node,to){to=+to||0;var from=+(node.getAttribute('data-v')||0);node.setAttribute('data-v',to);
  if(PRM||from===to){node.textContent=to.toLocaleString();return}
  var t0=performance.now(),dur=420;function step(t){var k=Math.min(1,(t-t0)/dur),v=Math.round(from+(to-from)*(1-Math.pow(1-k,3)));node.textContent=v.toLocaleString();if(k<1)requestAnimationFrame(step)}requestAnimationFrame(step)}

function nicheRow(n){n=n||{};var id='n'+(++nicheSeq);linkById[id]=n.link||'';return '<div class="listrow niche" data-id="'+id+'">'+
  '<label class="fld"><span>Business type</span><input data-k="label" placeholder="Dentists" value="'+esc(n.label)+'"></label>'+
  '<label class="fld"><span>Maps search term</span><input data-k="term" placeholder="dentist" value="'+esc(n.term)+'"></label>'+
  '<button type="button" class="rm" aria-label="Remove business type" onclick="removeNiche(this)">&times;</button></div>'}
function acctRow(a){a=a||{};return '<div class="listrow acct">'+
  '<label class="fld"><span>Email / username</span><input class="mono" data-k="email" placeholder="you@yourdomain.com" value="'+esc(a.email)+'"></label>'+
  '<label class="fld"><span>App password</span><input class="mono" data-k="app_password" placeholder="xxxx xxxx xxxx xxxx" value="'+esc(a.app_password)+'"></label>'+
  '<label class="fld"><span>Your name</span><input data-k="name" placeholder="Alex" value="'+esc(a.name)+'"></label>'+
  '<label class="fld"><span>From address <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(optional)</span></span><input class="mono" data-k="from_addr" placeholder="alex@yourdomain.com" value="'+esc(a.from_addr)+'"></label>'+
  '<label class="fld"><span>SMTP host <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(blank = Gmail)</span></span><input class="mono" data-k="smtp_host" placeholder="smtp.yourprovider.com" value="'+esc(a.smtp_host)+'"></label>'+
  '<label class="fld"><span>SMTP port <span style="text-transform:none;letter-spacing:0;color:var(--faint)">(optional)</span></span><input class="mono" data-k="smtp_port" placeholder="587" value="'+esc(a.smtp_port)+'"></label>'+
  '<button type="button" class="rm" aria-label="Remove account" onclick="this.closest(\'.listrow\').remove();refreshEmpty();markDirty();updatePreview();updateCap()">&times;</button></div>'}
function addNiche(){el('niches').insertAdjacentHTML('beforeend',nicheRow());refreshEmpty();markDirty();updatePlan();renderSamples();updatePreview()}
function removeNiche(btn){var r=btn.closest('.listrow');delete linkById[r.dataset.id];r.remove();refreshEmpty();markDirty();updatePlan();renderSamples();updatePreview()}
function addAccount(){el('accounts').insertAdjacentHTML('beforeend',acctRow());refreshEmpty();markDirty();updatePreview();updateCap()}
function refreshEmpty(){el('niches-empty').hidden=el('niches').children.length>0;el('accounts-empty').hidden=el('accounts').children.length>0}
function rows(id){var out=[];el(id).querySelectorAll('.listrow').forEach(function(r){var o={};r.querySelectorAll('input').forEach(function(i){o[i.dataset.k]=i.value.trim()});
  if(id==='niches'){o.__id=r.dataset.id;o.link=(linkById[r.dataset.id]||'').trim();if(o.label||o.term||o.link)out.push(o)}
  else if(Object.values(o).some(function(v){return v}))out.push(o)});return out}
function renderSamples(){var host=el('samples');if(!host)return;var rs=[];
  el('niches').querySelectorAll('.listrow').forEach(function(r){rs.push({id:r.dataset.id,label:(r.querySelector('input[data-k=label]').value||'').trim()})});
  if(!rs.length){host.innerHTML='<div class="empty" style="border-style:dashed"><b>No business types yet</b>Add business types on the Business Information page first.</div>';return}
  host.innerHTML=rs.map(function(x,i){return '<label class="listrow sample"><span class="slab">'+(esc(x.label)||('Business type '+(i+1)))+'</span><input class="mono" data-sid="'+x.id+'" placeholder="https://your-sample.netlify.app" value="'+esc(linkById[x.id]||'')+'" oninput="linkById[this.dataset.sid]=this.value.trim();markDirty();updatePreview()"></label>'}).join('')}
var useSamples=false;
function setUseSamples(v,silent){useSamples=!!v;
  var y=el('use-samples-yes'),n=el('use-samples-no'),w=el('samples-wrap');
  if(y)y.classList.toggle('on',useSamples);
  if(n)n.classList.toggle('on',!useSamples);
  if(w)w.hidden=!useSamples;
  if(useSamples)renderSamples();
  if(!silent)markDirty()}
function insTok(t){var b=el('pv-body');if(!b)return;var s=b.selectionStart||0,e=b.selectionEnd||0,v=b.value;b.value=v.slice(0,s)+t+v.slice(e);b.focus();b.selectionStart=b.selectionEnd=s+t.length;markDirty()}

function markDirty(){dirty=true;var s=el('savestate');s.textContent='Unsaved changes';s.classList.remove('saved');s.classList.add('unsaved');var sb=el('save-btn');if(sb)sb.classList.add('dirty')}
document.addEventListener('input',function(e){if(e.target.closest('#lumen-crm,#lumen-workspace,.theme-settings'))return;if(e.target.closest('.content')){
  if(e.target.id!=='imp-picker'&&e.target.id!=='find-imp-picker'){markDirty()}
  if(e.target.closest('#niches'))renderSamples();
  updatePlan();updatePreview();updateCap();updateGates()}});

function cityList(){return el('cities').value.split('\n').map(function(s){return s.trim()}).filter(Boolean)}
function chipEsc(t){return '<span class="chip">'+esc(t)+'</span>'}
function updatePlan(){var n=rows('niches'),c=cityList(),nb=n.length,cb=c.length;
  animateNum(el('plan-total'),nb*cb);
  el('plan-eq').innerHTML=nb+' type'+(nb===1?'':'s')+' &times; '+cb+' location'+(cb===1?'':'s');
  el('plan-niches').innerHTML=nb?n.map(function(x){return chipEsc(x.label||x.term||'untitled')}).join(''):'<span class="chip ghost">none yet</span>';
  el('plan-cities').innerHTML=cb?(c.slice(0,9).map(chipEsc).join('')+(cb>9?'<span class="chip more">+'+(cb-9)+' more</span>':'')):'<span class="chip ghost">none yet</span>'}
function updatePreview(){var a=rows('accounts'),acct=a[0]||{};
  el('pv-from').textContent=(acct.name||'you')+' <'+(acct.email||'you@gmail.com')+'>'}
function updateCap(){var a=rows('accounts').length,cap=+el('cap').value||0,target=+el('target').value||0;
  var room=a*cap,daily=target?Math.min(room,target):room;
  animateNum(el('cap-num'),daily);
  el('cap-note').innerHTML=a?(a+' account'+(a===1?'':'s')+' &times; '+cap+'/day'+(target&&target<room?', capped at your '+target+'/day target':'')):'Add an account to send.'}

function maskKey(v){return v?('••••'+v.slice(-4)):''}
function paintSettingsMask(c){
  var g=el('set-groq'),p=el('set-places');
  if(g){g.value='';g.placeholder=c.groq_api_key?maskKey(c.groq_api_key):'gsk_... (not set)'}
  if(p){p.value='';p.placeholder=c.places_api_key?maskKey(c.places_api_key):'AIza... (not set)'}
}
function removeKey(field){
  var body={};body[field]='';
  fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(){
    cfg[field]='';
    if(field==='places_api_key'){var a=el('apikey');if(a)a.value=''}
    paintSettingsMask(cfg);updateGates();toast('Removed')
  })
}
var setPlacesEl=el('set-places');
if(setPlacesEl)setPlacesEl.oninput=function(){el('apikey').value=this.value.trim()};
function loadCfg(){fetch('/config').then(function(r){return r.json()}).then(function(c){cfg=c;
  el('niches').innerHTML=(c.niches||[]).map(nicheRow).join('');
  el('accounts').innerHTML=(c.sender_accounts||[]).map(acctRow).join('');
  el('cities').value=(c.cities||[]).join('\n');
  el('apikey').value=c.places_api_key||'';
  paintSettingsMask(c);
  el('countries').value=(c.allowed_countries||[]).join('\n');
  el('price').value=c.price||'';el('address').value=c.physical_address||'';
  el('cap').value=c.per_account_cap;el('target').value=c.total_target;
  el('mindelay').value=c.min_delay;el('maxdelay').value=c.max_delay;
  el('testmode').checked=!!c.test_mode;
  el('pv-subj').value=c.email_subject||'';el('pv-body').value=c.email_body||'';
  var b=c.business||{};
  el('biz-name').value=b.name||'';el('biz-email').value=b.email||'';el('biz-phone').value=b.phone||'';
  el('biz-gstin').value=b.gstin||'';el('biz-upi').value=b.upi||'';el('biz-paylink').value=b.payment_link||'';
  el('biz-paylabel').value=b.payment_link_label||'';el('biz-paylink2').value=b.payment_link2||'';
  el('biz-paylabel2').value=b.payment_link2_label||'';el('biz-bank').value=b.bank_details||'';
  el('biz-addr').value=b.address||'';el('iv-notes').value=b.terms||'';
  if(b.default_currency){el('iv-cur').value=b.default_currency;el('ag-cur').value=b.default_currency}
  if(!el('iv-items').children.length)addItem();
  setUseSamples(c.use_samples!==undefined?!!c.use_samples:(c.niches||[]).some(function(n){return n.link}),true);
  refreshEmpty();renderSamples();updateMode();updateNavFlags();updateGuide();updatePlan();updatePreview();updateCap();updateGates();dirty=false;el('savestate').textContent='';var _ce=el('cfgerr');if(_ce)_ce.hidden=true;hideBoot();try{Tour.autoStart()}catch(e){}}).catch(function(){var b=el('cfgerr');if(b)b.hidden=false;hideBoot()})}

function countryList(){return el('countries').value.split('\n').map(function(s){return s.trim()}).filter(Boolean)}
function collect(){return{niches:rows('niches').map(function(n){return{label:n.label||'',term:n.term||'',link:n.link||''}}),
  sender_accounts:rows('accounts'),cities:cityList(),
  places_api_key:el('apikey').value.trim(),groq_api_key:el('set-groq').value.trim()||cfg.groq_api_key||'',allowed_countries:countryList(),
  price:el('price').value,physical_address:el('address').value,
  email_subject:el('pv-subj').value,email_body:el('pv-body').value,
  per_account_cap:+el('cap').value,total_target:+el('target').value,
  min_delay:+el('mindelay').value,max_delay:+el('maxdelay').value,
  business:{name:el('biz-name').value.trim(),email:el('biz-email').value.trim(),phone:el('biz-phone').value.trim(),
    gstin:el('biz-gstin').value.trim(),upi:el('biz-upi').value.trim(),payment_link:el('biz-paylink').value.trim(),
    payment_link_label:el('biz-paylabel').value.trim(),payment_link2:el('biz-paylink2').value.trim(),
    payment_link2_label:el('biz-paylabel2').value.trim(),bank_details:el('biz-bank').value,
    address:el('biz-addr').value.trim(),terms:el('iv-notes').value,default_currency:el('iv-cur').value},
  test_mode:el('testmode').checked,use_samples:useSamples}}
var configSaveQueue = Promise.resolve();
function saveCfg(toastIt, cb) {
  cfg = collect();
  var snapshot = JSON.stringify(cfg);
  configSaveQueue = configSaveQueue.then(async function() {
    try {
      var response = await fetch('/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: snapshot
      });
      if (!response.ok) throw new Error('Could not save your changes. Please try again.');
      updateMode(); updateNavFlags(); updateGuide();
      if (JSON.stringify(collect()) !== snapshot) {
        markDirty();
        if (toastIt || cb) toast('Earlier changes saved. Save your latest edits to continue.');
        return false;
      }
      dirty = false;
      var status = el('savestate');
      status.textContent = '✓ Saved';
      status.classList.add('saved');
      status.classList.remove('unsaved');
      var button = el('save-btn');
      if (button) button.classList.remove('dirty');
      status.classList.remove('pop');
      void status.offsetWidth;
      status.classList.add('pop');
      if (toastIt) toast('Saved');
      if (cb) cb();
      return true;
    } catch (error) {
      markDirty();
      toast('Could not save your changes. Please try again.');
      return false;
    }
  });
  return configSaveQueue;
}

/* ---- Tools: Market / Invoice / Agreement ---- */
function bizObj(){return{name:el('biz-name').value.trim(),address:el('biz-addr').value.trim(),email:el('biz-email').value.trim(),phone:el('biz-phone').value.trim(),gstin:el('biz-gstin').value.trim(),upi:el('biz-upi').value.trim(),payment_link:el('biz-paylink').value.trim(),payment_link_label:el('biz-paylabel').value.trim(),payment_link2:el('biz-paylink2').value.trim(),payment_link2_label:el('biz-paylabel2').value.trim(),bank_details:el('biz-bank').value,default_currency:el('iv-cur').value,terms:el('iv-notes').value}}
function openDoc(html){var w=window.open('','_blank');if(!w){toast('Allow pop-ups to open the document.');return}w.document.open();w.document.write(html);w.document.close()}
function gstToggle(){var v=el('iv-gst').value,gst=(v==='gst'),tax=gst||v==='percent';
  document.querySelectorAll('.gstonly,.gstonly2').forEach(function(e){e.hidden=!gst});
  document.querySelectorAll('.taxonly').forEach(function(e){e.hidden=!tax})}
function itemRow(){return '<div class="listrow item"><label class="fld"><span>Description</span><input data-k="desc" placeholder="Meta Ads management - June"></label>'+
  '<label class="fld gstonly2" hidden><span>SAC</span><input data-k="sac" class="mono" placeholder="998365"></label>'+
  '<label class="fld"><span>Qty</span><input data-k="qty" class="mono" value="1"></label>'+
  '<label class="fld"><span>Rate</span><input data-k="rate" class="mono" placeholder="25000"></label>'+
  '<button type="button" class="rm" aria-label="Remove item" onclick="this.closest(\'.listrow\').remove()">&times;</button></div>'}
function addItem(){el('iv-items').insertAdjacentHTML('beforeend',itemRow());gstToggle()}
function genInvoice(){saveCfg(false);
  if(!el('biz-name').value.trim()){toast('Add your business name first.');return}
  var items=[];el('iv-items').querySelectorAll('.listrow').forEach(function(r){var o={};r.querySelectorAll('input').forEach(function(i){o[i.dataset.k]=i.value.trim()});if(o.desc)items.push(o)});
  if(!items.length){toast('Add at least one item.');return}
  var p={business:bizObj(),client:{name:el('iv-cname').value.trim(),email:el('iv-cemail').value.trim(),address:el('iv-caddr').value.trim(),gstin:el('iv-cgstin').value.trim()},
    items:items,currency:el('iv-cur').value,gst_mode:el('iv-gst').value,supply_type:el('iv-supply').value,gst_rate:el('iv-rate').value,place_of_supply:el('iv-pos').value.trim(),
    number:el('iv-no').value.trim(),date:el('iv-date').value.trim(),due:el('iv-due').value.trim(),
    terms:el('iv-terms').value,po:el('iv-po').value.trim(),notes:el('iv-notes').value};
  fetch('/invoice/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}).then(function(r){return r.json()}).then(function(d){if(d.ok){if(!el('iv-no').value.trim())el('iv-no').value=d.number;openDoc(d.html)}else toast(d.error||'Could not build the invoice.')}).catch(function(){toast('Could not build the invoice. Check the connection and try again.')})}
function genAgreement(){saveCfg(false);
  if(!el('biz-name').value.trim()){toast('Add your business details on the Invoice tab first.');show('invoice');return}
  if(!el('ag-cname').value.trim()){toast('Add the client name.');return}
  var p={business:bizObj(),client:{name:el('ag-cname').value.trim(),address:el('ag-caddr').value.trim()},scope:el('ag-scope').value.trim(),fee:el('ag-fee').value.trim(),currency:el('ag-cur').value,revisions:el('ag-rev').value.trim(),timeline:el('ag-time').value.trim(),payment_terms:el('ag-pay').value.trim(),governing_law:el('ag-law').value.trim()};
  fetch('/agreement/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}).then(function(r){return r.json()}).then(function(d){if(d.ok)openDoc(d.html);else toast('Could not build the agreement.')})}

function updateMode(){var m=el('mode'),test=el('testmode').checked;m.textContent=test?'Test mode':'Live \u00b7 sends for real';m.className='mode '+(test?'test':'live');m.setAttribute('aria-label',(test?'Test mode on':'Live mode')+'. Click to change in Outreach.')}
function updateNavFlags(){var n=collect();
  document.querySelector('.navi[data-view=business-info]').classList.toggle('done',n.niches.length>0&&n.cities.length>0);
  document.querySelector('.navi[data-view=email-outreach]').classList.toggle('done',n.sender_accounts.length>0)}
function updateGuide(){var g=el('guide');if(g)g.hidden=true}

function renderReq(host,missing){
  if(!host)return;
  if(!missing.length){host.hidden=true;host.innerHTML='';return}
  host.hidden=false;
  host.innerHTML='<span class="req-t">To run this step</span>'+missing.map(function(m,i){
    return '<button type="button" class="req-pill" data-i="'+i+'">'+esc(m.label)+'</button>'}).join('');
  host.querySelectorAll('.req-pill').forEach(function(b){b.onclick=missing[+b.dataset.i].go});
}
function setGate(id,blocked){var b=el(id);if(!b)return;
  b.dataset.gated=blocked?'1':'0';
  b.disabled=!!blocked||!!window.__running;
  b.title=blocked?'Complete the items listed below first':'';
}
function goTo(view,id,focus){return function(){show(view);if(view==='settings'&&(id==='set-places'||id==='set-groq'))openSettingsPage('keys',false);var x=el(id);if(x){x.scrollIntoView({behavior:'smooth',block:'center'});if(focus)try{x.focus({preventScroll:true})}catch(e){}}}}
function updateGates(){
  var n=collect();
  var mc=[];
  if(!n.niches.length)mc.push({label:'Add a business type',go:goTo('business-info','niches')});
  if(!n.cities.length)mc.push({label:'Add a location',go:goTo('business-info','cities',true)});
  if(!n.places_api_key)mc.push({label:'Add your Places API key in Settings',go:goTo('settings','set-places',true)});
  renderReq(el('req-collect'),mc);setGate('btn-collect',mc.length);
  var mf=[];
  if(FindImports.selectedId()&&!FindImports.selectedMapped())mf.push({label:'Map the imported list\u2019s columns below',go:goTo('find-emails','find-imp-map')});
  renderReq(el('req-find'),mf);setGate('btn-find',mf.length);
  var ms=[];
  if(!n.test_mode){
    if(!n.sender_accounts.length)ms.push({label:'Add a sending account',go:goTo('email-outreach','accounts')});
    if(!(n.physical_address||'').trim())ms.push({label:'Add your mailing address',go:goTo('email-outreach','address',true)});
  }
  if(Imports.selectedId()&&!Imports.selectedMapped())ms.push({label:'Map the imported list\u2019s columns below',go:goTo('email-outreach','imp-map')});
  renderReq(el('req-send'),ms);setGate('btn-send',ms.length);
}
function preflight(stage){var n=collect();
  if(stage==='scrape'||stage==='all'){if(!n.niches.length||!n.cities.length){toast('Add a business type and a location first.');show('business-info');return false}
    if(!n.places_api_key){toast('Add your Google Places API key in Settings first.');show('settings');return false}}
  if((stage==='send'||stage==='send_import')&&!n.test_mode){if(!n.sender_accounts.length){toast('Add a sending account first, or turn on Test mode.');show('email-outreach');return false}
    if(!(n.physical_address||'').trim()){toast('Add your mailing address \u2014 it\u2019s legally required in every email.');show('email-outreach');return false}
    if(!confirm('This will send real emails from your account(s). Each one includes your address and an unsubscribe, and opt-out replies are honoured automatically. Continue?'))return false}
  if(stage==='send_import'&&!Imports.selectedId()){toast('Upload and map a CSV first.');return false}
  if(stage==='find_import'&&!FindImports.selectedId()){toast('Upload and map a CSV first.');return false}
  return true}
function run(stage,body){if(!preflight(stage))return;if(stage==='scrape'||stage==='all'){var nm=prompt('Name this lead list (it will be saved under Sheets when the run finishes):','');if(nm===null){return}window.__pendingList=(nm.trim()||('Leads '+new Date().toLocaleDateString()));}saveCfg(false,function(){var opts=body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{method:'POST'};fetch('/run/'+stage,opts).then(function(r){return r.json()}).then(function(d){if(!d.ok){toast(d.error||'Could not start this step.')}else{selHist=null}})})}
function stopRun(){fetch('/stop',{method:'POST'});toast('Stopping after the current item\u2026')}

var Imports=(function(){
  var lastId=null,items=[];
  function selectedId(){var p=el('imp-picker');return (p&&p.value)?p.value:null}
  function selectedMapped(){var id=selectedId();if(!id)return true;var o=items.filter(function(x){return x.id===id})[0];return !!(o&&o.mapped)}
  function refresh(selectId){fetch('/imports/list').then(function(r){return r.json()}).then(function(list){
    items=list||[];
    var p=el('imp-picker');
    var cur=selectId||p.value;
    p.innerHTML='<option value="">Collected businesses</option>'+list.map(function(o){
      var label=o.filename+' \u2014 '+fmt(o.row_count)+' rows'+(o.mapped?' (mapped, '+fmt(o.valid_count)+' valid)':' (not mapped)');
      return '<option value="'+o.id+'">'+esc(label)+'</option>'}).join('');
    p.value=cur||'';if(p.selectedIndex<0)p.value='';
    if(window.updateGates)updateGates()
  }).catch(function(){})}
  function reset(){lastId=null;var f=el('imp-file');if(f)f.value='';el('imp-status').textContent='';
    var m=el('imp-map');m.querySelectorAll('select,button').forEach(function(x){x.disabled=true});
    el('imp-email-col').innerHTML='';el('imp-name-col').innerHTML='<option value="">(none)</option>';
    var p=el('imp-picker');if(p)p.value='';refresh()}
  function upload(file){
    var f=file||(el('imp-file').files[0]);
    if(!f){toast('Choose a CSV file first.');return}
    var fd=new FormData();fd.append('file',f);
    el('imp-status').textContent='Uploading\u2026';
    fetch('/imports/upload',{method:'POST',body:fd}).then(function(r){return r.json()}).then(function(d){
      if(!d.ok){toast(d.error||'Could not read that CSV.');el('imp-status').textContent='';return}
      lastId=d.id;
      el('imp-status').textContent=fmt(d.row_count)+' rows found. Confirm the column mapping below.';
      var esel=el('imp-email-col'),nsel=el('imp-name-col');
      esel.innerHTML=d.headers.map(function(h){return '<option value="'+esc(h)+'">'+esc(h)+'</option>'}).join('');
      nsel.innerHTML='<option value="">(none)</option>'+d.headers.map(function(h){return '<option value="'+esc(h)+'">'+esc(h)+'</option>'}).join('');
      if(d.suggested_email_col)esel.value=d.suggested_email_col;
      if(d.suggested_name_col)nsel.value=d.suggested_name_col;
      el('imp-map').querySelectorAll('select,button').forEach(function(x){x.disabled=false});
      refresh()
    }).catch(function(){toast('Upload failed.');el('imp-status').textContent=''})}
  function confirmMap(){
    if(!lastId){toast('Upload a CSV first.');return}
    var body={email_col:el('imp-email-col').value,name_col:el('imp-name-col').value};
    fetch('/imports/'+lastId+'/map',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
      if(!d.ok){toast(d.error||'Could not map those columns.');return}
      el('imp-status').textContent=fmt(d.valid)+' sendable, '+fmt(d.skipped)+' skipped (no valid email).';
      refresh(lastId)
    }).catch(function(){toast('Mapping failed.')})}
  function send(){
    var iid=selectedId();
    if(!iid){toast('Upload and map a CSV first.');return}
    run('send_import',{import_id:iid})}
  return {upload:upload,confirmMap:confirmMap,refresh:refresh,send:send,selectedId:selectedId,selectedMapped:selectedMapped,reset:reset}
})();

var FindImports=(function(){
  var lastId=null,items=[];
  function selectedId(){var p=el('find-imp-picker');return (p&&p.value)?p.value:null}
  function selectedMapped(){var id=selectedId();if(!id)return true;var o=items.filter(function(x){return x.id===id})[0];return !!(o&&o.find_mapped)}
  function refresh(selectId){fetch('/imports/list').then(function(r){return r.json()}).then(function(list){
    items=list||[];
    var p=el('find-imp-picker');
    var cur=selectId||p.value;
    p.innerHTML='<option value="">Collected businesses</option>'+list.map(function(o){
      var label=o.filename+' \u2014 '+fmt(o.row_count)+' rows'+(o.find_mapped?' (mapped, '+fmt(o.find_valid_count)+' valid)':' (not mapped)');
      return '<option value="'+o.id+'">'+esc(label)+'</option>'}).join('');
    p.value=cur||'';if(p.selectedIndex<0)p.value='';
    if(window.updateGates)updateGates()
  }).catch(function(){})}
  function reset(){lastId=null;var f=el('find-imp-file');if(f)f.value='';el('find-imp-status').textContent='';
    var m=el('find-imp-map');m.querySelectorAll('select,button').forEach(function(x){x.disabled=true});
    el('find-imp-website-col').innerHTML='';el('find-imp-name-col').innerHTML='<option value="">(none)</option>';
    var p=el('find-imp-picker');if(p)p.value='';refresh()}
  function upload(file){
    var f=file||(el('find-imp-file').files[0]);
    if(!f){toast('Choose a CSV file first.');return}
    var fd=new FormData();fd.append('file',f);
    el('find-imp-status').textContent='Uploading\u2026';
    fetch('/imports/upload',{method:'POST',body:fd}).then(function(r){return r.json()}).then(function(d){
      if(!d.ok){toast(d.error||'Could not read that CSV.');el('find-imp-status').textContent='';return}
      lastId=d.id;
      el('find-imp-status').textContent=fmt(d.row_count)+' rows found. Confirm the column mapping below.';
      var wsel=el('find-imp-website-col'),nsel=el('find-imp-name-col');
      wsel.innerHTML=d.headers.map(function(h){return '<option value="'+esc(h)+'">'+esc(h)+'</option>'}).join('');
      nsel.innerHTML='<option value="">(none)</option>'+d.headers.map(function(h){return '<option value="'+esc(h)+'">'+esc(h)+'</option>'}).join('');
      if(d.suggested_website_col)wsel.value=d.suggested_website_col;
      if(d.suggested_name_col)nsel.value=d.suggested_name_col;
      el('find-imp-map').querySelectorAll('select,button').forEach(function(x){x.disabled=false});
      refresh()
    }).catch(function(){toast('Upload failed.');el('find-imp-status').textContent=''})}
  function confirmMap(){
    if(!lastId){toast('Upload a CSV first.');return}
    var body={website_col:el('find-imp-website-col').value,name_col:el('find-imp-name-col').value};
    fetch('/imports/'+lastId+'/map_find',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
      if(!d.ok){toast(d.error||'Could not map those columns.');return}
      el('find-imp-status').textContent=fmt(d.valid)+' have a website, '+fmt(d.skipped)+' skipped (no website).';
      refresh(lastId)
    }).catch(function(){toast('Mapping failed.')})}
  function send(){
    var iid=selectedId();
    if(!iid){toast('Upload and map a CSV first.');return}
    run('find_import',{import_id:iid})}
  return {upload:upload,confirmMap:confirmMap,refresh:refresh,send:send,selectedId:selectedId,selectedMapped:selectedMapped,reset:reset}
})();

function findCampaign(){var iid=FindImports.selectedId();if(iid){run('find_import',{import_id:iid})}else{run('find')}}
function sendCampaign(){var iid=Imports.selectedId();if(iid){run('send_import',{import_id:iid})}else{run('send')}}

function wireDropzone(zoneId,onFile){
  var z=el(zoneId);if(!z)return;
  ['dragenter','dragover'].forEach(function(evt){z.addEventListener(evt,function(e){e.preventDefault();e.stopPropagation();z.classList.add('drag')})});
  z.addEventListener('dragleave',function(e){e.preventDefault();e.stopPropagation();z.classList.remove('drag')});
  z.addEventListener('drop',function(e){
    e.preventDefault();e.stopPropagation();z.classList.remove('drag');
    var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(f)onFile(f);
  });
}
wireDropzone('imp-drop',function(f){Imports.upload(f)});
wireDropzone('find-imp-drop',function(f){FindImports.upload(f)});
el('imp-picker')&&el('imp-picker').addEventListener('change',function(){updateGates()});
el('find-imp-picker')&&el('find-imp-picker').addEventListener('change',function(){updateGates()});

function fmt(n){return (n||0).toLocaleString()}
function setNode(id,state){var n=el('node-'+id);n.classList.remove('active','done');if(state)n.classList.add(state)}
function setLogLines(lines,live,targetId){targetId=targetId||'con';var con=el(targetId);if(!con)return;
  if(!live){con.innerHTML='';liveCounts[targetId]=0;if(!lines||!lines.length){con.innerHTML='<span class="ph2">No output recorded for this run.</span>';return}con.innerHTML=lines.map(function(l){return '<div class="ln">'+esc(l)+'</div>'}).join('');con.scrollTop=con.scrollHeight;return}
  var lc=liveCounts[targetId]||0;
  if(lines.length<lc){con.innerHTML='';lc=0}
  if(lc===0&&lines.length&&con.querySelector('.ph2')){con.innerHTML=''}
  for(var i=lc;i<lines.length;i++){var d=document.createElement('div');d.className='ln in';d.textContent=lines[i];con.appendChild(d)}
  liveCounts[targetId]=lines.length;
  if(!lines.length&&!con.children.length){con.innerHTML='<span class="ph2">'+(targetId==='logs-con'?'Log is empty.':'Output appears here once you start a step.')+'</span>'}
  con.scrollTop=con.scrollHeight}
function clearLogs(){
  fetch('/logs/clear',{method:'POST'}).then(function(r){return r.json()}).then(function(o){
    if(!o.ok){toast(o.error||'Could not clear the log.');return}
    selHist=null;
    document.querySelectorAll('.hitem').forEach(function(n){n.setAttribute('aria-pressed','false')});
    var con=el('logs-con');if(con){con.innerHTML='<span class="ph2">Log is empty.</span>';liveCounts['logs-con']=0}
    toast('Log cleared');
    poll();
  }).catch(function(){toast('Could not clear the log.')});
}
function summarize(k,c){c=c||{};var p=[];if(/collect/i.test(k)&&c.collected)p.push(fmt(c.collected)+' collected');if(/find|collect/i.test(k)&&c.found)p.push(fmt(c.found)+' emails');if(/send/i.test(k)&&c.sent)p.push(fmt(c.sent)+' sent');return p.join(' \u00b7 ')||'no results'}
function renderHistory(items){histCache=items||[];el('hist-count').textContent=histCache.length?histCache.length+' total':'';if(!histCache.length)return;
  el('hist').innerHTML=histCache.map(function(it){var when=(it.started||'').replace(/^\d{4}-/,'').replace(/-/,'/');return '<button type="button" class="hitem" aria-pressed="'+(selHist===it.id)+'" data-id="'+it.id+'" onclick="showHist('+it.id+')"><div class="hi-top"><span class="hkind">'+esc(it.kind||'Run')+'</span><span class="hwhen">'+esc(when)+'</span></div><div class="hi-sum">'+esc(summarize(it.kind||'',it.counts))+'</div></button>'}).join('')}
function showHist(id){var it=histCache.filter(function(x){return x.id===id})[0];if(!it)return;selHist=id;document.querySelectorAll('.hitem').forEach(function(n){n.setAttribute('aria-pressed',+n.dataset.id===id)});var lm=el('logs-meta');if(lm)lm.textContent=(it.kind||'run')+' \u00b7 '+(it.started||'');setLogLines(it.log||[],false,'logs-con')}
function loadHistory(showLast){fetch('/history').then(function(r){return r.json()}).then(function(items){renderHistory(items);if(showLast&&items.length&&selHist===null)showHist(items[0].id)})}

function setMeter(suffix,show,pct,indet,title,pcText){
  var m=el('meter-'+suffix),bar=el('bar-'+suffix),fill=el('bar-fill-'+suffix),t=el('meter-t-'+suffix),pc=el('meter-pc-'+suffix);
  if(!m)return;
  if(!show){m.classList.remove('show');return}
  m.classList.add('show');bar.classList.toggle('indet',!!indet);
  if(!indet){fill.style.width=pct+'%'}
  t.textContent=title;pc.textContent=pcText;bar.setAttribute('aria-valuenow',pct||0);
}
function poll(){fetch('/status').then(function(r){return r.json()}).then(function(s){
  var c=s.counts||{},step=s.step,running=s.running;
  el('activity').className='activity'+(running?' on':'');
  var errd=s.attention?false:(/\b(error|errors|failed|failure|exception|traceback|refused|expired|cannot|could not)\b/i.test((s.log||[]).slice(-8).join('\n'))||step==='error');
  document.querySelectorAll('.logpanel').forEach(function(lp){lp.classList.toggle('err',errd);lp.classList.toggle('live',running&&!errd)});
  window.__running=running;
  document.querySelectorAll('.opbtn.run').forEach(function(b){b.disabled=running||b.dataset.gated==='1'});
  ['collect','find','send'].forEach(function(k){
    var sd=el('sdot-'+k),sg=el('stage-'+k),sb=el('stopbtn-'+k),mine=running&&step===k;
    if(sd)sd.className='statusdot'+(s.attention&&mine?' attn':(mine?' run':''));
    if(sg)sg.textContent=mine?(s.stage||'working'):(running?'Another step is running\u2026':'idle');
    if(sb)sb.disabled=!running;
  });
  var a=el('attn');if(a){if(s.attention){a.classList.add('show');el('attn-msg').textContent=s.attention_msg||''}else{a.classList.remove('show')}}
  setNode('collect',(running&&step==='collect')?'active':(c.collected>0?'done':''));
  setNode('find',(running&&step==='find')?'active':(c.found>0?'done':''));
  setNode('send',(running&&step==='send')?'active':(c.sent>0?'done':''));
  el('cnt-collect').innerHTML=c.collected>0?'<b>'+fmt(c.collected)+'</b> businesses':(running&&step==='collect'?'Searching\u2026':'Not started');
  el('cnt-find').innerHTML=c.found>0?'<b>'+fmt(c.found)+'</b> with email':(running&&step==='find'?'Scanning\u2026':'Not started');
  el('cnt-send').innerHTML=c.sent>0?'<b>'+fmt(c.sent)+'</b> '+(el('testmode').checked?'previewed':'sent'):(running&&step==='send'?'Sending\u2026':'Not started');
  if(running&&step==='collect'){var d=c.searches_done||0,tot=c.searches_total||0;setMeter('collect',true,tot?Math.round(d/tot*100):0,false,'Collecting businesses',d+' / '+tot+' searches \u00b7 '+fmt(c.collected)+' found')}
  else{setMeter('collect',false)}
  if(running&&step==='find'){var sd2=c.scanned||0,st2=c.scan_total||0;
    if(st2){setMeter('find',true,Math.round(sd2/st2*100),false,'Finding emails',sd2+' / '+st2+' sites \u00b7 '+fmt(c.found)+' with email')}
    else{setMeter('find',true,0,true,'Finding emails',fmt(c.found)+' with email')}}
  else{setMeter('find',false)}
  if(running&&step==='send'){var ss=c.sent||0,stg=c.send_target||0;setMeter('send',true,stg?Math.round(ss/stg*100):0,false,el('testmode').checked?'Previewing emails':'Sending campaign',ss+(stg?' / '+stg:''))}
  else{setMeter('send',false)}
  if(running){selHist=null}
  if(selHist===null){
    var lm=el('logs-meta');if(lm)lm.textContent=running?'live':'idle';
    setLogLines(s.log||[],true,'logs-con');
  }
  if(wasRunning&&!running){loadHistory(true);if(window.__pendingList){var _nm=window.__pendingList;window.__pendingList=null;fetch('/sheets/from_run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:_nm})}).then(function(r){return r.json()}).then(function(o){if(o&&o.ok){toast('Saved '+o.rows+' leads to \u201c'+_nm+'\u201d under Sheets');if(window.Sheets)Sheets.refresh()}}).catch(function(){})}}
  wasRunning=running;
})}
el('testmode')&&el('testmode').addEventListener('change',function(){updateMode();updateGuide();updateGates()});
window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue=''}});
function openURL(u){try{window.open(u,'_blank')}catch(e){location.href=u}}
function checkUpdate(){fetch('/update').then(function(r){return r.json()}).then(function(u){
  if(!u||!u.update)return;
  if(u.mandatory){el('upgate-v').textContent='Version '+(u.version||'');if(u.notes)el('upgate-notes').textContent=u.notes;el('upgate-go').onclick=function(){openURL(u.url)};el('upgate').classList.add('show')}
  else{el('upbar-txt').innerHTML='<b>Version '+esc(u.version)+'</b> is available'+(u.notes?' \u2014 '+esc(u.notes):'');el('upbar-go').onclick=function(){openURL(u.url)};el('upbar-x').onclick=function(){el('upbar').classList.remove('show')};el('upbar').classList.add('show')}
}).catch(function(){})}
var Sheets=(function(){
  var xs=null,cur=null,items=[],saveT=null,loaded=false,curFU=null,zoom=1,fxRi=0,fxCi=0;
  var ZOOM_STEPS=[.5,.75,.9,1,1.1,1.25,1.5,2];
  function colName(n){var t='';n=n+1;while(n>0){var m=(n-1)%26;t=String.fromCharCode(65+m)+t;n=(n-1-m)/26}return t}
  function fxSel(cell,ri,ci){fxRi=ri||0;fxCi=ci||0;
    var nm=el('fx-name');if(nm)nm.textContent=colName(fxCi)+(fxRi+1);
    var f=el('fx-input');if(f&&document.activeElement!==f)f.value=(cell&&cell.text!=null)?String(cell.text):''}
  function applyFx(){if(!xs)return;var f=el('fx-input');if(!f)return;
    try{xs.cellText(fxRi,fxCi,f.value);xs.reRender();scheduleSave()}catch(e){}}
  function host(){return el('xs-host')}
  function ensureXS(){if(xs)return xs;var h=host();
    xs=x_spreadsheet(h,{mode:'edit',showToolbar:true,showGrid:true,showContextmenu:true,
      view:{height:function(){return h.clientHeight},width:function(){return h.clientWidth}},
      row:{len:1000,height:24},col:{len:26,width:100,indexWidth:46,minWidth:60},
      style:{font:{name:'Arial',size:10},color:'#1F1A10'}});
    xs.change(function(){scheduleSave()});
    try{
      xs.on('cell-selected',function(cell,ri,ci){fxSel(cell,ri,ci)});
      xs.on('cells-selected',function(cell,r){if(r&&r.sri!==undefined)fxSel(cell,r.sri,r.sci)});
      xs.on('cell-edited',function(text,ri,ci){var f=el('fx-input');if(f&&document.activeElement!==f)f.value=text==null?'':String(text)});
    }catch(e){}
    return xs}
  function addRows(n){if(!xs)return;
    try{var d=xs.getData();var arr=Array.isArray(d)?d:[d];
      arr.forEach(function(sh){sh.rows=sh.rows||{};sh.rows.len=(parseInt(sh.rows.len,10)||1000)+n});
      xs.loadData(arr);reflow();scheduleSave();toast('Added '+fmt(n)+' rows')}catch(e){toast('Could not add rows')}}
  function reflow(){if(xs){try{xs.reRender()}catch(e){}}}
  function applyZoom(){var h=host();
    if(h){h.style.width=(100/zoom)+'%';h.style.height=(100/zoom)+'%';h.style.transform='scale('+zoom+')'}
    var p=el('xs-zoom-pct');if(p)p.textContent=Math.round(zoom*100)+'%';
    var i=ZOOM_STEPS.indexOf(zoom);
    var zo=el('xs-zoom-out'),zi=el('xs-zoom-in');
    if(zo)zo.disabled=(i<=0);if(zi)zi.disabled=(i===-1||i>=ZOOM_STEPS.length-1);
    reflow()}
  function zoomTo(z){zoom=z;applyZoom()}
  function zoomStep(dir){var i=ZOOM_STEPS.indexOf(zoom);if(i===-1)i=2;i=Math.max(0,Math.min(ZOOM_STEPS.length-1,i+dir));zoomTo(ZOOM_STEPS[i])}
  var zoomOutBtn=el('xs-zoom-out'),zoomInBtn=el('xs-zoom-in');
  if(zoomOutBtn)zoomOutBtn.onclick=function(){zoomStep(-1)};
  if(zoomInBtn)zoomInBtn.onclick=function(){zoomStep(1)};
  var _wa=0;
  window.addEventListener('wheel',function(e){
    var ed=el('sheet-editor');
    if(!ed||!ed.classList.contains('show'))return;
    if(!e.ctrlKey)return;
    e.preventDefault();e.stopPropagation();
    _wa+=e.deltaY;
    if(_wa<=-30){zoomStep(1);_wa=0}else if(_wa>=30){zoomStep(-1);_wa=0}
  },{passive:false,capture:true});
  var _fx=el('fx-input');
  if(_fx)_fx.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();applyFx();_fx.blur()}
    else if(e.key==='Escape'){_fx.blur()}
  });
  function scheduleSave(){if(!cur)return;el('sheet-save').textContent='Saving\u2026';clearTimeout(saveT);saveT=setTimeout(doSave,800)}
  function doSave(){if(!cur||!xs)return;var data=xs.getData();
    fetch('/sheets/'+cur,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:data})})
      .then(function(r){return r.json()}).then(function(){el('sheet-save').textContent='Saved'})
      .catch(function(){el('sheet-save').textContent='Save failed'})}
  function refresh(){return fetch('/sheets/list').then(function(r){return r.json()}).then(function(list){items=list||[];render();return items})}
  function render(){var box=el('sheet-items');if(!box)return;el('sheet-empty').hidden=items.length>0;
    box.innerHTML=items.map(function(s){return '<button type="button" class="sheet-card" onclick="Sheets.open(\''+s.id+'\')">'
      +'<span class="sc-name">'+esc(s.name)+'</span>'
      +'<span class="sc-meta">'+(s.followup?'<span class="sc-fu">follow-up</span>':'')+esc(s.updated||'')+'</span></button>'}).join('')}
  function enter(){if(!loaded){loaded=true;refresh()}}
  function create(){var name=prompt('Name this list (e.g. Texas Dentists):','');if(name===null)return;name=name.trim();if(!name)return;
    fetch('/sheets/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
      .then(function(r){return r.json()}).then(function(o){refresh().then(function(){openSheet(o.id)})})}
  function openSheet(id){cur=id;
    fetch('/sheets/'+id).then(function(r){return r.json()}).then(function(o){
      if(o.error){toast('List not found');return}
      el('sheetname-disp').textContent=o.name;el('sheet-save').textContent='';
      curFU=o.followup||{enabled:false};updateFuBtn();
      el('sheet-editor').classList.add('show');document.body.classList.add('editing-sheet');
      requestAnimationFrame(function(){ensureXS();
        var d=o.data;if(!d||(Array.isArray(d)&&!d.length)||(typeof d==='object'&&!Array.isArray(d)&&!Object.keys(d).length)){d=[{name:o.name}]}
        var arr=Array.isArray(d)?d:[d];
        arr.forEach(function(sh){sh.rows=sh.rows||{};var ln=parseInt(sh.rows.len,10)||0;if(ln<1000)sh.rows.len=1000});
        xs.loadData(arr);zoomTo(1);reflow();fxSel(null,0,0)})})}
  function back(){el('sheet-editor').classList.remove('show');document.body.classList.remove('editing-sheet');refresh()}
  function rename(){if(!cur)return;var s=items.filter(function(x){return x.id===cur})[0];var name=prompt('Rename list:',s?s.name:'');if(name===null)return;name=name.trim();if(!name)return;
    fetch('/sheets/'+cur+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
      .then(function(r){return r.json()}).then(function(o){el('sheetname-disp').textContent=o.name;refresh()})}
  function del(){if(!cur)return;if(!confirm('Delete this list permanently?'))return;
    fetch('/sheets/'+cur+'/delete',{method:'POST'}).then(function(){cur=null;back()})}
  window.addEventListener('resize',function(){if(el('sheet-editor')&&el('sheet-editor').classList.contains('show'))reflow()});
  function updateFuBtn(){var b=el('fu-btn');if(b)b.textContent=(curFU&&curFU.enabled)?'Follow-up \u2713':'Follow-up'}
  function fuClose(){el('fu-modal').classList.remove('show')}
  function followup(){if(!cur){toast('Open a list first');return}var on=curFU&&curFU.enabled;
    el('fu-title').textContent=on?'Follow-up (on)':'Enable follow-up';
    el('fu-subject').value=(curFU&&curFU.subject)||'';el('fu-body').value=(curFU&&curFU.body)||'';
    el('fu-save').textContent=on?'Save message':'Enable follow-up';
    el('fu-start').hidden=!on;el('fu-disable').hidden=!on;
    el('fu-result').hidden=true;el('fu-result').innerHTML='';el('fu-modal').classList.add('show')}
  function fuEnable(){var subject=el('fu-subject').value,body=el('fu-body').value;
    fetch('/sheets/'+cur+'/followup/enable',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:subject,body:body})})
      .then(function(r){return r.json()}).then(function(o){if(o.error){toast('Could not enable follow-up');return}
        curFU={enabled:true,subject:subject,body:body};updateFuBtn();
        el('fu-title').textContent='Follow-up (on)';el('fu-save').textContent='Save message';el('fu-start').hidden=false;el('fu-disable').hidden=false;
        toast('Follow-up on \u2014 columns added to the sheet');openSheet(cur)})}
  function fuDisable(){fetch('/sheets/'+cur+'/followup/disable',{method:'POST'}).then(function(){curFU={enabled:false};updateFuBtn();fuClose();toast('Follow-up disabled')})}
  function fuErr(e){return {no_account:'Add a sending account in Outreach, or turn on Test mode.',no_address:'Add your mailing address in Outreach before live sending.',no_columns:'Enable follow-up first.',not_enabled:'Enable follow-up first.',empty:'This list has no rows yet.'}[e]||'Could not start follow-up.'}
  function fuStart(){var b=el('fu-start');b.disabled=true;b.textContent='Sending\u2026';
    fetch('/sheets/'+cur+'/followup/start',{method:'POST'}).then(function(r){return r.json()}).then(function(o){
      b.disabled=false;b.textContent='Start follow-up';
      if(o.error){toast(fuErr(o.error));return}
      openSheet(cur);
      var html='<div class="fu-sum">'+(o.test_mode?'<b>Test mode</b> \u2014 nothing was actually emailed. ':'')+'<span>'+o.sent+' emailed</span>'+(o.failed?' \u00b7 <span>'+o.failed+' failed</span>':'')+(o.no_email?' \u00b7 <span>'+o.no_email+' had no email</span>':'')+'</div>';
      if(o.manual&&o.manual.length){html+='<div class="fu-man-h">Send these by hand ('+o.manual.length+')</div>'+o.manual.map(function(m){return '<div class="fu-man"><span class="fm-name">'+esc(m.name||('Row '+m.row))+'</span><span class="fm-ch">'+esc(m.channel)+'</span><span class="fm-ph">'+esc(m.phone||'')+'</span></div>'}).join('')}
      var box=el('fu-result');box.hidden=false;box.innerHTML=html})}
  return {enter:enter,create:create,open:openSheet,back:back,rename:rename,del:del,refresh:refresh,followup:followup,fuEnable:fuEnable,fuStart:fuStart,fuDisable:fuDisable,fuClose:fuClose,addRows:addRows}
})();

/* Import a CSV or Excel file as a new sheet. CSV is parsed directly; XLSX is
   unzipped in the browser (DecompressionStream) and the first worksheet read. */
var SheetImport=(function(){
  function csvParse(text){
    var rows=[],row=[],cur='',q=false;
    for(var i=0;i<text.length;i++){var ch=text[i];
      if(q){if(ch==='"'){if(text[i+1]==='"'){cur+='"';i++}else{q=false}}else{cur+=ch}}
      else if(ch==='"'){q=true}
      else if(ch===','){row.push(cur);cur=''}
      else if(ch==='\n'){row.push(cur);cur='';rows.push(row);row=[]}
      else if(ch==='\r'){}
      else{cur+=ch}}
    if(cur!==''||row.length){row.push(cur);rows.push(row)}
    return rows.filter(function(r){return r.some(function(c){return c!==''})})
  }
  function toXS(name,rows){var sh={name:'Sheet1',rows:{len:Math.max(1000,rows.length+10)}},maxc=1;
    rows.slice(0,1000).forEach(function(r,i){var cells={};
      for(var c=0;c<Math.min(r.length,60);c++){var v=r[c];if(v!==''&&v!=null){cells[String(c)]={text:String(v)};if(c+1>maxc)maxc=c+1}}
      if(Object.keys(cells).length)sh.rows[String(i)]={cells:cells}});
    sh.cols={len:Math.max(26,maxc+2)};
    return [sh]}
  function u16(d,o){return d[o]|d[o+1]<<8}
  function u32(d,o){return (d[o]|d[o+1]<<8|d[o+2]<<16|d[o+3]<<24)>>>0}
  function inflateRaw(bytes){
    if(typeof DecompressionStream==='undefined')return Promise.reject(new Error('unsupported'));
    var stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function(b){return new Uint8Array(b)})
  }
  function unzip(buf){
    var d=new Uint8Array(buf);
    var i=d.length-22;
    while(i>0&&u32(d,i)!==0x06054b50){i--}
    if(i<=0)return Promise.reject(new Error('not a zip'));
    var n=u16(d,i+10),off=u32(d,i+16),want={},jobs=[],p=off;
    for(var k=0;k<n;k++){
      if(u32(d,p)!==0x02014b50)break;
      var comp=u16(d,p+10),csz=u32(d,p+20),nlen=u16(d,p+28),elen=u16(d,p+30),clen=u16(d,p+32),lho=u32(d,p+42);
      var nm=new TextDecoder().decode(d.subarray(p+46,p+46+nlen));
      if(nm==='xl/sharedStrings.xml'||/^xl\/worksheets\/sheet1\.xml$/.test(nm)){
        (function(nm,lho,comp,csz){
          if(u32(d,lho)!==0x04034b50)return;
          var nl=u16(d,lho+26),xl=u16(d,lho+28),start=lho+30+nl+xl;
          var raw=d.subarray(start,start+csz);
          jobs.push((comp===0?Promise.resolve(new Uint8Array(raw)):inflateRaw(raw)).then(function(x){want[nm]=x}))
        })(nm,lho,comp,csz)
      }
      p+=46+nlen+elen+clen;
    }
    return Promise.all(jobs).then(function(){return want})
  }
  function parseXlsx(buf){
    return unzip(buf).then(function(files){
      var dec=new TextDecoder(),shared=[];
      if(files['xl/sharedStrings.xml']){
        var sdoc=new DOMParser().parseFromString(dec.decode(files['xl/sharedStrings.xml']),'text/xml');
        shared=[].map.call(sdoc.getElementsByTagName('si'),function(si){return si.textContent})
      }
      if(!files['xl/worksheets/sheet1.xml'])throw new Error('no worksheet');
      var doc=new DOMParser().parseFromString(dec.decode(files['xl/worksheets/sheet1.xml']),'text/xml');
      var rows=[];
      [].forEach.call(doc.getElementsByTagName('row'),function(rEl){
        var r=parseInt(rEl.getAttribute('r')||(rows.length+1),10)-1;
        var arr=rows[r]||(rows[r]=[]);
        [].forEach.call(rEl.getElementsByTagName('c'),function(cEl){
          var ref=cEl.getAttribute('r')||'',m=ref.match(/^([A-Z]+)/),ci=0;
          if(m){for(var j=0;j<m[1].length;j++){ci=ci*26+(m[1].charCodeAt(j)-64)}ci--}
          var t=cEl.getAttribute('t'),vEl=cEl.getElementsByTagName('v')[0],txt='';
          if(t==='inlineStr'){txt=cEl.textContent}
          else if(vEl){txt=vEl.textContent;if(t==='s'){txt=shared[parseInt(txt,10)]||''}}
          arr[ci]=txt})
      });
      var out=[];
      rows.forEach(function(r){var rr=[];if(r){for(var c=0;c<r.length;c++){rr.push(r[c]==null?'':r[c])}}out.push(rr)});
      return out
    })
  }
  function doImport(file){
    var name=file.name.replace(/\.(csv|xlsx|xls)$/i,'')||'Imported list';
    function finish(rows){
      if(!rows||!rows.length){toast('That file looks empty.');return}
      fetch('/sheets/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
        .then(function(r){return r.json()}).then(function(o){
          fetch('/sheets/'+o.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:toXS(name,rows)})})
            .then(function(){toast('Imported '+fmt(rows.length)+' rows');Sheets.refresh().then(function(){Sheets.open(o.id)})})
        }).catch(function(){toast('Could not save the imported sheet.')})
    }
    if(/\.csv$/i.test(file.name)){
      var fr=new FileReader();fr.onload=function(){finish(csvParse(String(fr.result)))};fr.readAsText(file)
    }else{
      file.arrayBuffer().then(parseXlsx).then(finish)
        .catch(function(){toast('Could not read that Excel file \u2014 save it as CSV and try again.')})
    }
  }
  var fi=el('sheet-import-file');
  if(fi){fi.addEventListener('change',function(){if(fi.files[0]){doImport(fi.files[0]);fi.value=''}})}
  return {doImport:doImport}
})();
document.addEventListener('keydown',function(e){
  var ed=el('sheet-editor');
  if(!ed||!ed.classList.contains('show'))return;
  if((e.ctrlKey||e.metaKey)&&(e.key==='a'||e.key==='A'||e.keyCode===65)){
    e.preventDefault();
    try{var ov=ed.querySelector('.x-spreadsheet-overlayer-content')||ed.querySelector('.x-spreadsheet-overlayer');
      if(ov){var r=ov.getBoundingClientRect();var o={bubbles:true,cancelable:true,view:window,clientX:r.left+6,clientY:r.top+6,button:0};
        ov.dispatchEvent(new MouseEvent('mousedown',o));ov.dispatchEvent(new MouseEvent('mouseup',o))}
    }catch(_){}
  }
},true);
document.addEventListener('DOMContentLoaded',function(){
  try{var saved=sessionStorage.getItem('lumen-active-section');if(saved)show(saved)}catch(e){}
});
loadCfg();loadHistory(true);setInterval(poll,1100);poll();checkUpdate();Imports.refresh();FindImports.refresh();
try{if(window.__USER__&&window.__USER__!=='you'&&!sessionStorage.getItem('welcomed')){sessionStorage.setItem('welcomed','1');setTimeout(function(){toast('Welcome, '+window.__USER__)},750)}}catch(e){}
</script>
</body></html>
"""


def open_browser():
    time.sleep(1.2)
    try:
        webbrowser.open("http://127.0.0.1:5000")
    except Exception:
        pass


if __name__ == "__main__":
    _bootstrap_user_files()   # seed config/license in the per-user data dir
    try:
        import website_builder_bridge as wbb
        wbb.prewarm()              # boot the local audit service in the background
    except Exception as _e:
        print(f"[website-builder] not started: {_e}")
    # Agency Brain is now hosted at https://lumen-brain.vercel.app; no local prewarm needed.
    # try:
    #     import agency_brain_launcher as abl
    #     abl.prewarm()
    # except Exception as _e:
    #     print(f"[agency-brain] not started: {_e}")
    threading.Thread(target=open_browser, daemon=True).start()
    print(f"{APP_NAME} {APP_VERSION} running at http://127.0.0.1:5000  (art: inline)")
    app.run(host="127.0.0.1", port=5000, threaded=True)
