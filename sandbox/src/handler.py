#!/usr/bin/env python3
"""Sandbox request handler.

Reads a single JSON request from stdin and writes a single JSON response to
stdout. socat runs one instance of this script per TCP connection.
"""

import base64
import json
import os
import subprocess
import sys


def respond(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def error(status, message):
    return {"ok": False, "status": status, "error": message}


def b64(data):
    return base64.b64encode(data).decode("ascii")


def handle(req):
    cmd = req.get("cmd")
    path = req.get("path")

    if cmd == "read":
        if not path:
            return error("bad_request", "missing path")
        if not os.path.isfile(path):
            return error("not_found", f"no such file: {path}")
        with open(path, "rb") as f:
            return {"ok": True, "status": "ok", "contentBase64": b64(f.read())}

    if cmd == "write":
        if not path:
            return error("bad_request", "missing path")
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            data = base64.b64decode(req.get("contentBase64", ""))
            with open(path, "wb") as f:
                f.write(data)
        except OSError as err:
            return error("write_failed", f"could not write: {path}: {err}")
        return {"ok": True, "status": "ok"}

    if cmd == "exec":
        command = req.get("command")
        if not command:
            return error("bad_request", "missing command")
        try:
            proc = subprocess.run(
                ["bash", "-c", command],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=req.get("timeout"),
            )
        except subprocess.TimeoutExpired as err:
            return {
                "ok": True,
                "status": "timeout",
                "exitCode": 124,
                "stdoutBase64": b64(err.stdout or b""),
                "stderrBase64": b64(err.stderr or b""),
            }
        return {
            "ok": True,
            "status": "ok",
            "exitCode": proc.returncode,
            "stdoutBase64": b64(proc.stdout),
            "stderrBase64": b64(proc.stderr),
        }

    return error("unknown_command", f"unknown command: {cmd}")


def main():
    raw = sys.stdin.buffer.read()
    try:
        req = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        respond(error("bad_request", "invalid JSON request"))
        return
    respond(handle(req))


if __name__ == "__main__":
    main()
