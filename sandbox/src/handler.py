#!/usr/bin/env python3
"""Sandbox request handler.

Reads a single JSON request from stdin and writes a single JSON response to
stdout. socat runs one instance of this script per TCP connection.
"""

import base64
import json
import os
import sys


def respond(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def handle(req):
    cmd = req.get("cmd")
    path = req.get("path")

    if cmd == "read":
        if not path:
            return {"ok": False, "status": "bad_request", "error": "missing path"}
        if not os.path.isfile(path):
            return {"ok": False, "status": "not_found", "error": f"no such file: {path}"}
        with open(path, "rb") as f:
            content = base64.b64encode(f.read()).decode("ascii")
        return {"ok": True, "status": "ok", "contentBase64": content}

    if cmd == "write":
        if not path:
            return {"ok": False, "status": "bad_request", "error": "missing path"}
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            data = base64.b64decode(req.get("contentBase64", ""))
            with open(path, "wb") as f:
                f.write(data)
        except OSError as err:
            return {"ok": False, "status": "write_failed", "error": f"could not write: {path}: {err}"}
        return {"ok": True, "status": "ok"}

    return {"ok": False, "status": "unknown_command", "error": f"unknown command: {cmd}"}


def main():
    raw = sys.stdin.buffer.read()
    try:
        req = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        respond({"ok": False, "status": "bad_request", "error": "invalid JSON request"})
        return
    respond(handle(req))


if __name__ == "__main__":
    main()
