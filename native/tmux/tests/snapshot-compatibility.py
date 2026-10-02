#!/usr/bin/env python3
"""Compare native-grid bytes with the previous artifact on disposable servers."""
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import time


def capture(binary):
    with tempfile.TemporaryDirectory(prefix="snapshot-compat-", dir="/tmp") as directory:
        socket = str(pathlib.Path(directory) / "s")
        payload = pathlib.Path(directory) / "payload"
        # History, true colour, wide characters, combining text and cursor mode.
        payload.write_bytes(("line\r\n" * 40 + "\033[38;2;19;87;143mcolour\033[0m 界 é\r\n"
                             "\033[?25lSNAPSHOT-COMPAT-READY").encode())
        env = {**os.environ, "TMUX": ""}

        def tmux(*args):
            return subprocess.check_output([binary, "-S", socket, *args], env=env, timeout=5,
                                           stderr=subprocess.PIPE)
        try:
            tmux("-f", "/dev/null", "new-session", "-d", "-x", "80", "-y", "24",
                 "-s", "proof", f"cat {shlex.quote(str(payload))}; sleep 60")
            deadline = time.monotonic() + 5
            while b"SNAPSHOT-COMPAT-READY" not in tmux("capture-pane", "-p", "-t", "proof"):
                assert time.monotonic() < deadline, "fixture output did not arrive"
                time.sleep(.01)
            return tmux("capture-pane", "-p", "-R", "-S", "-", "-t", "proof")
        finally:
            try:
                tmux("kill-server")
            except subprocess.CalledProcessError:
                pass


before, after = map(capture, sys.argv[1:3])
assert before == after, "native-grid bytes changed"
print(f"native snapshot compatibility: {len(after)} bytes identical")
