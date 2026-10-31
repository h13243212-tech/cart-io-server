#!/usr/bin/env python3
"""
bridge_agent.py — the half of the bridge that runs inside the VM.

WHY THIS EXISTS
---------------
A web page served over https cannot talk to http://127.0.0.1: a browser
blocks the request as mixed content before it even leaves the tab, and CORS
would block it afterwards. A browser extension's service worker has host
permissions and is not subject to either rule. So the extension is the only
clean path, and this agent is the other end of it.

DESIGN CONSTRAINTS, IN ORDER OF IMPORTANCE
------------------------------------------
1. It binds 127.0.0.1 by default. This process can execute shell commands;
   it must never be reachable from a network. For a remote VM the correct
   deployment is an SSH tunnel (see README), not a public port.
2. Every request needs the bearer token. There is no unauthenticated mode,
   because "just for testing" is how these end up exposed.
3. Output streams. A `nmap` run that takes 40 seconds must show its first
   line immediately, not after 40 seconds of buffering.
4. It never trusts input: length caps, timeouts, an output ceiling, a
   concurrency limit, and process-group kills so a runaway child dies too.

Zero dependencies — stdlib only, so it runs on a fresh Kali with nothing
installed, and there is no supply chain to audit.

  python3 bridge_agent.py                 # 127.0.0.1:8787, token printed
  python3 bridge_agent.py --port 8787 --deny-rm
"""

import argparse
import hmac
import json
import os
import queue
import secrets
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.2.0"
MAX_CMD_CHARS = 8000
MAX_OUTPUT_BYTES = 2 * 1024 * 1024          # per stream, then truncated
MAX_CONCURRENT = 3
DEFAULT_TIMEOUT = 120
HARD_TIMEOUT_CAP = 900
READ_CHUNK = 4096

# Seatbelt, not a lock. Anyone with the token can type `bash -c 'rm -rf /'`
# and get around a substring check in about four seconds. This only stops
# the fat-fingered version.
SEATBELT = [
    "rm -rf /",
    "mkfs.",
    "dd if=/dev/zero of=/dev/sd",
    "> /dev/sda",
    ":(){ :|:& };:",
]

ALLOWED_ORIGIN_PREFIXES = (
    "chrome-extension://",
    "http://127.0.0.1",
    "http://localhost",
    "moz-extension://",
)


def log(msg):
    sys.stderr.write("[bridge %s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


class Config:
    token = ""
    seatbelt = False
    allow_pair = True
    semaphore = threading.BoundedSemaphore(MAX_CONCURRENT)
    started = time.time()


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 is required for chunked transfer encoding to work at all.
    protocol_version = "HTTP/1.1"
    server_version = "arena-bridge/" + VERSION

    # -- helpers -------------------------------------------------------
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin and any(origin.startswith(p) for p in ALLOWED_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, code, obj, close=False):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            # A rejection that does not drain the request body leaves those
            # bytes in the socket. On a keep-alive connection the next request
            # is then parsed starting mid-body — which silently answers some
            # later request with a 400. Closing is the safe answer.
            self.send_header("Connection", "close")
            self.close_connection = True
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self):
        got = self.headers.get("Authorization", "")
        want = "Bearer " + Config.token
        return hmac.compare_digest(got.encode(), want.encode())

    def _reject(self):
        # Deliberately vague: do not help a scanner distinguish
        # "no token" from "wrong token".
        self._send_json(401, {"error": "unauthorised"}, close=True)

    # -- routes --------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        route = self.path.split("?")[0]

        if route == "/pair":
            self._pair()
            return

        # A local stand-in for a chat UI, so the whole loop can be proven
        # without arena.ai, an account, or a model. Static file, no secrets.
        if route in ("/demo", "/demo/"):
            self._serve_demo()
            return

        if route != "/health":
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorised():
            self._reject()
            return
        self._send_json(200, {
            "ok": True,
            "agent": VERSION,
            "host": os.uname().nodename,
            "user": os.environ.get("USER") or os.environ.get("LOGNAME") or "?",
            "uptime_s": int(time.time() - Config.started),
            "seatbelt": Config.seatbelt,
        })

    # -- pairing -------------------------------------------------------
    # Removes the copy-the-token step. The gate is the Origin header: a web
    # page cannot forge Origin, so a page origin is refused, and another
    # browser extension could still pair — hence --no-pair, and a loud log
    # line on every attempt, successful or not.
    #
    # A *missing* Origin is allowed. It is not a bypass: browsers always send
    # Origin on the CORS fetches a page would need in order to read the reply,
    # so a page that reaches this endpoint cannot read the token it triggers
    # (CORS headers are only echoed for allowed origins). Chrome does not
    # always attach Origin to a privileged extension-worker fetch, which is
    # exactly the case that used to fail here — and a local process that could
    # send no Origin could read the token file anyway.
    def _pair(self):
        origin = self.headers.get("Origin", "")
        if not Config.allow_pair:
            log("pair attempt refused: pairing disabled (--no-pair), origin=%r" % origin)
            self._send_json(403, {"error": "pairing disabled (--no-pair)", "code": "disabled"})
            return
        allowed = (not origin) or origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")
        if not allowed:
            log("pair attempt refused: not an extension origin %r" % origin)
            self._send_json(403, {
                "error": "pairing is only available to a browser extension",
                "code": "origin",
            })
            return
        log("paired with origin %r" % (origin or "<none: local client or extension worker>"))
        self._send_json(200, {
            "token": Config.token,
            "agent": VERSION,
            "host": os.uname().nodename,
        })

    def _serve_demo(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo.html")
        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError:
            self._send_json(404, {"error": "demo.html is missing next to the agent"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/exec", "/run"):
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorised():
            self._reject()
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "bad content-length"}, close=True)
            return
        if length <= 0 or length > MAX_CMD_CHARS * 4:
            self._send_json(413, {"error": "body too large or empty"}, close=True)
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "body must be JSON"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "body must be a JSON object"})
            return

        # The journal is the only audit trail this thing has. Keeping quiet
        # about commands made "is it even reaching the VM?" unanswerable.
        cmd_for_log = payload.get("cmd")
        if isinstance(cmd_for_log, str):
            one_line = " ".join(cmd_for_log.split())
            log("%s %s" % (route, one_line[:160] + ("…" if len(one_line) > 160 else "")))

        if route == "/run":
            self._run(payload)
        else:
            self._exec(payload)

    # -- one-shot: run, collect, return a single JSON object ------------
    # The chat loop needs a compact result it can paste back into a
    # conversation, not a stream. Streaming would be nicer engineering and
    # is the wrong shape for this caller.
    def _run(self, payload):
        cmd = payload.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip():
            self._send_json(400, {"error": "cmd must be a non-empty string"})
            return
        if len(cmd) > MAX_CMD_CHARS:
            self._send_json(413, {"error": "cmd too long (max %d)" % MAX_CMD_CHARS}, close=True)
            return
        try:
            timeout_s = float(payload.get("timeout_s", DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout_s = DEFAULT_TIMEOUT
        timeout_s = max(1.0, min(HARD_TIMEOUT_CAP, timeout_s))

        if Config.seatbelt:
            flat = " ".join(cmd.lower().split())
            for bad in SEATBELT:
                if bad in flat:
                    self._send_json(403, {"error": "refused by seatbelt: %r" % bad})
                    return

        if not Config.semaphore.acquire(blocking=False):
            self._send_json(429, {"error": "too many concurrent commands"})
            return

        cap = int(payload.get("cap", 6000))
        cap = max(200, min(200000, cap))
        started = time.time()
        try:
            proc = subprocess.Popen(
                cmd, shell=True, executable="/bin/bash",
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True, cwd=os.path.expanduser("~"),
            )
        except OSError as e:
            Config.semaphore.release()
            self._send_json(500, {"error": "spawn failed: %s" % e})
            return

        timed_out = False
        try:
            out_b, err_b = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            self._kill_tree(proc)
            try:
                out_b, err_b = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                out_b, err_b = b"", b""
        finally:
            Config.semaphore.release()

        out = (out_b or b"").decode("utf-8", "replace")
        err = (err_b or b"").decode("utf-8", "replace")
        truncated = False
        if len(out) > cap:
            out = out[:cap] + "\n…[stdout truncated]"
            truncated = True
        if len(err) > cap:
            err = err[:cap] + "\n…[stderr truncated]"
            truncated = True

        self._send_json(200, {
            "code": proc.returncode,
            "timedOut": timed_out,
            "ms": int((time.time() - started) * 1000),
            "out": out,
            "err": err,
            "truncated": truncated,
            "cwd": os.path.expanduser("~"),
        })

    # -- streaming variant ---------------------------------------------
    def _exec(self, payload):
        cmd = payload.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip():
            self._send_json(400, {"error": "cmd must be a non-empty string"})
            return
        if len(cmd) > MAX_CMD_CHARS:
            self._send_json(413, {"error": "cmd too long (max %d)" % MAX_CMD_CHARS}, close=True)
            return

        try:
            timeout_s = float(payload.get("timeout_s", DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout_s = DEFAULT_TIMEOUT
        timeout_s = max(1.0, min(HARD_TIMEOUT_CAP, timeout_s))

        if Config.seatbelt:
            flat = " ".join(cmd.lower().split())
            for bad in SEATBELT:
                if bad in flat:
                    self._send_json(403, {"error": "refused by --deny-rm seatbelt: matches %r" % bad})
                    return

        # One runaway tab should not be able to fork-bomb the box.
        if not Config.semaphore.acquire(blocking=False):
            self._send_json(429, {"error": "too many concurrent commands"})
            return

        try:
            self._stream_command(cmd, timeout_s)
        finally:
            Config.semaphore.release()

    def _stream_command(self, cmd, timeout_s):
        started = time.time()
        cwd = os.path.expanduser("~")

        try:
            proc = subprocess.Popen(
                cmd,
                shell=True,
                executable="/bin/bash",
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,     # own process group, so we can kill the tree
                cwd=cwd,
            )
        except OSError as e:
            # headers not sent yet, so a clean JSON error is still possible
            self._send_json(500, {"error": "spawn failed: %s" % e})
            return

        # Chunked + ndjson: the response is a stream of one-line JSON events,
        # so the client can render output as it arrives instead of waiting
        # for the process to exit.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.end_headers()

        disconnected = False

        def emit(obj):
            nonlocal disconnected
            if disconnected:
                return
            data = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
            try:
                self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                disconnected = True

        q = queue.Queue()
        counters = {"out": 0, "err": 0}

        def pump(stream, kind):
            try:
                while True:
                    chunk = os.read(stream.fileno(), READ_CHUNK)
                    if not chunk:
                        break
                    if counters[kind] >= MAX_OUTPUT_BYTES:
                        continue            # drain, but stop forwarding
                    room = MAX_OUTPUT_BYTES - counters[kind]
                    counters[kind] += len(chunk)
                    q.put((kind, chunk[:room]))
            except (OSError, ValueError):
                pass
            finally:
                q.put((kind, None))

        threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True).start()
        threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True).start()

        emit({"t": "start", "cmd": cmd, "timeout_s": timeout_s})

        deadline = started + timeout_s
        open_streams = 2
        timed_out = False
        killed = False

        while open_streams > 0:
            remaining = deadline - time.time()
            if remaining <= 0:
                timed_out = True
                killed = True
                self._kill_tree(proc)
                break
            if disconnected:
                killed = True
                self._kill_tree(proc)
                break
            try:
                kind, data = q.get(timeout=min(0.2, max(0.01, remaining)))
            except queue.Empty:
                continue
            if data is None:
                open_streams -= 1
                continue
            emit({"t": kind, "d": data.decode("utf-8", "replace")})

        code = None
        try:
            code = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._kill_tree(proc)
            try:
                code = proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                code = None

        for kind in ("out", "err"):
            if counters[kind] >= MAX_OUTPUT_BYTES:
                emit({"t": "truncated", "stream": kind, "limit": MAX_OUTPUT_BYTES})

        emit({
            "t": "exit",
            "code": code,
            "killed": killed and not timed_out,
            "timedOut": timed_out,
            "ms": int((time.time() - started) * 1000),
        })

        if not disconnected:
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    @staticmethod
    def _kill_tree(proc):
        # Negative pid kills the whole process group, so `bash -c 'a | b'`
        # cannot leave a straggler holding the port or burning CPU.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except OSError:
                pass

    def log_message(self, fmt, *args):
        # Quiet by default; uncomment for protocol-level debugging.
        # log("%s %s" % (self.address_string(), fmt % args))
        pass


def load_token(path, explicit):
    if explicit:
        return explicit, "argument"
    try:
        with open(path, "r", encoding="utf-8") as f:
            tok = f.read().strip()
        if len(tok) >= 32:
            return tok, "file"
    except OSError:
        pass
    tok = secrets.token_urlsafe(32)
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(tok + "\n")
        return tok, "generated"
    except OSError as e:
        log("could not persist token (%s); it will change every start" % e)
        return tok, "memory"


def main():
    ap = argparse.ArgumentParser(description="Arena <-> VM bridge agent")
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default 127.0.0.1 — read the README before changing)")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--token", default=None, help="bearer token (default: read or create)")
    ap.add_argument("--token-file", default=os.path.expanduser("~/.arena-bridge/token"))
    ap.add_argument("--no-pair", action="store_true",
                    help="refuse /pair (then the token must be pasted by hand)")
    ap.add_argument("--deny-rm", action="store_true", dest="seatbelt",
                    help="refuse a few catastrophic command patterns (a seatbelt, not a lock)")
    args = ap.parse_args()

    Config.token, how = load_token(args.token_file, args.token)
    Config.seatbelt = args.seatbelt
    Config.allow_pair = not args.no_pair

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True

    print("")
    print("  arena-bridge agent %s" % VERSION)
    print("  listening   http://%s:%d" % (args.host, args.port))
    print("  token       %s  (from %s)" % (Config.token, how))
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("  !! BOUND TO A NON-LOOPBACK ADDRESS — anything that can reach this")
        print("     port can run shell commands as %s. Prefer an SSH tunnel." %
              (os.environ.get("USER") or "you"))
    if args.seatbelt:
        print("  seatbelt    on")
    print("")
    if Config.allow_pair:
        print("  In the extension: click Pair. No token to copy.")
    else:
        print("  Pairing is off — paste the token above into the extension popup.")
    print("  Ctrl-C to stop.")
    print("")

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
