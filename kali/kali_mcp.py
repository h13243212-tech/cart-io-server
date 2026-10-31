"""A real MCP server for Kali — no pip, no venv, no dependencies.

Model Context Protocol, JSON-RPC 2.0, spec revision 2025-06-18.

Two transports, same handler:
  * Streamable HTTP  POST /mcp            (served by bridge_agent.py)
  * stdio            bridge_agent.py --mcp-stdio   (for Claude Desktop & co)

The tool surface follows MCP-Kali-Server (TriV3, MIT): execute a command,
read/write files, inspect the box. The implementation here is our own and
stdlib-only, so it runs on a fresh Kali with nothing installed; the official
SDK-based servers need `pip install mcp` and a working venv first.

Full access is deliberate: run_command executes as the user that started the
agent. The one seatbelt is --deny-rm, and it is a seatbelt, not a lock.
"""

import json
import os
import platform
import shlex
import socket
import subprocess
import time

VERSION = "0.1.0"
SERVER_NAME = "arena-kali"

# Protocol revisions we can speak. Newest first; the client picks.
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

MAX_OUTPUT = 64 * 1024        # bytes of stdout/stderr returned to the client
MAX_FILE_READ = 512 * 1024
DEFAULT_TIMEOUT = 120
HARD_TIMEOUT = 900


# -- tool schemas -----------------------------------------------------------
# Every tool returns text. MCP clients render `content` blocks, so a single
# text block holding the command's output is the shape that Just Works in
# Claude Desktop, Cursor, Cline and anything else that speaks the spec.

TOOLS = [
    {
        "name": "run_command",
        "description": (
            "Run a shell command on the Kali machine and return its output. "
            "Runs with /bin/bash, in the current working directory unless cwd is given. "
            "This is a real shell with full access as the agent's user — "
            "anything the user could type in a terminal can be run here."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "cwd": {"type": "string", "description": "Working directory (optional)"},
                "timeout_s": {
                    "type": "number",
                    "description": "Seconds before the command is killed (default 120, max 900)",
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a text file from the Kali filesystem. Returns up to 512 KB.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path, or relative to $HOME"},
                "max_bytes": {"type": "number", "description": "Truncate after this many bytes"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write (or append to) a text file. Parent directories are created.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path, or relative to $HOME"},
                "content": {"type": "string", "description": "Text to write"},
                "append": {"type": "boolean", "description": "Append instead of overwriting"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "list_directory",
        "description": "List a directory. Directories are marked with a trailing slash.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Default: the current directory"},
            },
        },
    },
    {
        "name": "system_info",
        "description": "Hostname, user, OS, kernel, uptime, and the agent's working directory.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


# -- helpers ----------------------------------------------------------------

def _expand(path):
    if not isinstance(path, str) or not path.strip():
        raise ValueError("path must be a non-empty string")
    p = os.path.expandvars(os.path.expanduser(path.strip()))
    return os.path.abspath(p)


def _cap(text):
    if len(text) <= MAX_OUTPUT:
        return text
    return text[:MAX_OUTPUT] + "\n…truncated (%d bytes total)" % len(text)


def _result(text, is_error=False):
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _seatbelt_hit(command, patterns):
    flat = " ".join(command.lower().split())
    return next((p for p in patterns if p in flat), None)


# -- tools ------------------------------------------------------------------

def tool_run_command(args, seatbelt=()):
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        return _result("run_command: `command` must be a non-empty string", True)
    if len(command) > 100_000:
        return _result("run_command: command too long", True)

    if seatbelt:
        hit = _seatbelt_hit(command, seatbelt)
        if hit:
            return _result("refused by --deny-rm seatbelt: matches %r" % hit, True)

    cwd = None
    if args.get("cwd"):
        try:
            cwd = _expand(args["cwd"])
        except ValueError as exc:
            return _result("run_command: %s" % exc, True)
        if not os.path.isdir(cwd):
            return _result("run_command: no such directory: %s" % cwd, True)

    try:
        timeout_s = float(args.get("timeout_s", DEFAULT_TIMEOUT))
    except (TypeError, ValueError):
        timeout_s = DEFAULT_TIMEOUT
    timeout_s = max(1.0, min(HARD_TIMEOUT, timeout_s))

    started = time.time()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            executable="/bin/bash",
            cwd=cwd,
            capture_output=True,
            timeout=timeout_s,
        )
        out = proc.stdout.decode("utf-8", "replace")
        err = proc.stderr.decode("utf-8", "replace")
        code, timed_out = proc.returncode, False
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or b"").decode("utf-8", "replace")
        err = (exc.stderr or b"").decode("utf-8", "replace")
        code, timed_out = 124, True

    ms = int((time.time() - started) * 1000)
    parts = []
    if out.strip():
        parts.append(out.rstrip())
    if err.strip():
        parts.append("[stderr]\n" + err.rstrip())
    parts.append("[exit %s · %d ms%s]" % (code, ms, " · TIMED OUT" if timed_out else ""))
    return _result(_cap("\n".join(parts)), bool(code) or timed_out)


def tool_read_file(args):
    try:
        path = _expand(args.get("path"))
    except ValueError as exc:
        return _result("read_file: %s" % exc, True)
    try:
        limit = int(args.get("max_bytes", MAX_FILE_READ))
    except (TypeError, ValueError):
        limit = MAX_FILE_READ
    limit = max(1, min(limit, MAX_FILE_READ))
    try:
        with open(path, "rb") as fh:
            data = fh.read(limit + 1)
    except OSError as exc:
        return _result("read_file: %s" % exc, True)
    truncated = len(data) > limit
    text = data[:limit].decode("utf-8", "replace")
    if truncated:
        text += "\n…truncated at %d bytes" % limit
    return _result(text)


def tool_write_file(args):
    try:
        path = _expand(args.get("path"))
    except ValueError as exc:
        return _result("write_file: %s" % exc, True)
    content = args.get("content")
    if not isinstance(content, str):
        return _result("write_file: `content` must be a string", True)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a" if args.get("append") else "w", encoding="utf-8") as fh:
            fh.write(content)
    except OSError as exc:
        return _result("write_file: %s" % exc, True)
    return _result("wrote %d bytes to %s" % (len(content.encode()), path))


def tool_list_directory(args):
    path = args.get("path") or os.getcwd()
    try:
        path = _expand(path)
    except ValueError as exc:
        return _result("list_directory: %s" % exc, True)
    try:
        entries = sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name.lower()))
    except OSError as exc:
        return _result("list_directory: %s" % exc, True)
    lines = []
    for e in entries:
        try:
            is_dir = e.is_dir()
            size = "" if is_dir else "  %d B" % e.stat().st_size
        except OSError:
            is_dir, size = False, ""
        lines.append(("%s/%s" % (e.name, "") if is_dir else e.name) + size)
    return _result("\n".join(lines) or "(empty)")


def tool_system_info(_args):
    try:
        with open("/proc/uptime") as fh:
            up = float(fh.read().split()[0])
            uptime = "%dh %dm" % (up // 3600, (up % 3600) // 60)
    except (OSError, ValueError, IndexError):
        uptime = "?"
    uname = platform.uname()
    try:
        user = os.getlogin()
    except OSError:
        user = os.environ.get("USER", "?")
    text = "\n".join([
        "host:    %s" % socket.gethostname(),
        "user:    %s" % user,
        "os:      %s" % (uname.system + " " + uname.release),
        "kernel:  %s" % uname.version,
        "arch:    %s" % uname.machine,
        "uptime:  %s" % uptime,
        "cwd:     %s" % os.getcwd(),
        "agent:   v%s" % VERSION,
    ])
    return _result(text)


HANDLERS = {
    "run_command": tool_run_command,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "list_directory": tool_list_directory,
    "system_info": tool_system_info,
}


def call_tool(name, args, seatbelt=()):
    fn = HANDLERS.get(name)
    if fn is None:
        return _result("unknown tool: %s" % name, True)
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return _result("arguments must be an object", True)
    try:
        if fn is tool_run_command:
            return fn(args, seatbelt)
        return fn(args)
    except Exception as exc:                      # never kill the transport
        return _result("%s failed: %s" % (name, exc), True)


# -- JSON-RPC dispatch ------------------------------------------------------

def _error(id_, code, message, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id_, "error": err}


def _ok(id_, result):
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def handle(msg, seatbelt=()):
    """One JSON-RPC message in, one response dict out (or None for a notification)."""
    if not isinstance(msg, dict):
        return _error(None, -32600, "invalid request")

    method = msg.get("method")
    msg_id = msg.get("id")
    is_notification = "id" not in msg

    if msg.get("jsonrpc") != "2.0" or not isinstance(method, str):
        return None if is_notification else _error(msg_id, -32600, "invalid request")

    # Notifications (initialized, cancelled, …) never get a reply.
    if is_notification:
        return None

    params = msg.get("params") or {}
    if not isinstance(params, dict):
        return _error(msg_id, -32602, "params must be an object")

    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return _ok(msg_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": VERSION},
            "instructions": (
                "This server is a Kali Linux machine. run_command executes shell "
                "commands on it with the agent user's full authority."
            ),
        })

    if method == "ping":
        return _ok(msg_id, {})

    if method == "tools/list":
        return _ok(msg_id, {"tools": TOOLS})

    if method == "tools/call":
        name = params.get("name")
        if not isinstance(name, str) or not name:
            return _error(msg_id, -32602, "tools/call needs a tool name")
        return _ok(msg_id, call_tool(name, params.get("arguments"), seatbelt))

    # resources/prompts/logging are advertised as unsupported rather than 404'd
    if method in ("resources/list", "resources/templates/list", "prompts/list"):
        key = method.split("/")[0] + "s"
        return _ok(msg_id, {key: []})

    return _error(msg_id, -32601, "method not found: %s" % method)


def serve_stdio(stdin, stdout, seatbelt=()):
    """newline-delimited JSON-RPC on stdio — what `mcpServers` spawns."""
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            stdout.write(json.dumps(_error(None, -32700, "parse error")) + "\n")
            stdout.flush()
            continue
        out = handle(msg, seatbelt)
        if out is not None:
            stdout.write(json.dumps(out) + "\n")
            stdout.flush()


if __name__ == "__main__":  # `python3 kali_mcp.py` acts as a stdio server
    import sys
    serve_stdio(sys.stdin, sys.stdout)
