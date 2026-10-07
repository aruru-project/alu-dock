#!/usr/bin/env python3
"""TEMPORARY_PTY_QA: one bounded Plan review journey; remove after CI acceptance."""
import base64
import importlib.util
import json
import os
import pty
import signal
import sys
import termios
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("existing_pty", os.path.join(os.path.dirname(__file__), "pty-tui-driver.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], dict(os.environ, TERM="xterm-256color", NO_COLOR="1"))

output = bytearray()
position = 0
notes = []
status = -1
error = None
terminal_restored = False
resized_bytes = 0
scrollback_lines = 0


def wait_frame(*markers, seconds=12):
    """Only return once the complete sync frame after all fresh markers arrives."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        fresh = bytes(output[position:])
        ends = [fresh.find(marker) + len(marker) if marker in fresh else -1 for marker in markers]
        if all(end >= 0 for end in ends) and b"\x1b[?2026l" in fresh[max(ends, default=0):]:
            return
        if helpers.read_available(fd, output, .04) < 0:
            break
    raise AssertionError("Incomplete screen for " + repr(markers) + ": " + bytes(output[-2500:]).decode("utf8", "replace"))


def send(data):
    global position
    position = len(output)
    os.write(fd, data)


def resize(rows, columns):
    global position, resized_bytes
    # Drain already-completed output before requiring a fresh resize frame.
    while helpers.read_available(fd, output, .04) > 0:
        pass
    position = len(output)
    helpers.set_size(fd, rows, columns)
    os.kill(pid, signal.SIGWINCH)
    wait_frame()
    resized_bytes += len(output) - position


def interrupted(_signal, _frame):
    raise KeyboardInterrupt("PTY QA interrupted")


signal.signal(signal.SIGTERM, interrupted)
try:
    helpers.set_size(fd, 40, 120)
    wait_frame(b"cache ")
    send(b"/plan Prepare a report for terminal review\r")
    choices = ["按此执行", "执行并自动推进到完成", "我来改", "继续讨论"]
    wait_frame("审阅计划".encode(), b"PTY-PLAN-START", b"PTY-PLAN-END", *(choice.encode() for choice in choices))
    notes.append("Complete short plan and all four choices visible in the real TUI")
    send(b"\x1b")
    wait_frame(b"PTY discussion ready")
    notes.append("Esc returns to planning discussion")
    send(b"Please submit the same plan again.\r")
    wait_frame("审阅计划".encode(), b"PTY-PLAN-START", b"PTY-PLAN-END", "按此执行".encode())
    send(b"\r")
    wait_frame(b"PTY approved execution complete")
    notes.append("Enter approves the resubmitted plan and the write completes")
    completed = bytes(output)
    scrollback_lines = completed.count(b"PTY evidence line ")
    assert scrollback_lines >= 40, "Long response did not populate native terminal scrollback"
    assert b"\x1b[3J" not in completed, "Normal conversation cleared native scrollback"
    resize(18, 43)
    resize(40, 120)
    notes.append("Long response populates native scrollback; resize 120x40 to 43x18 and back completes")
    send(b"\x04")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        found, code = os.waitpid(pid, os.WNOHANG)
        if found:
            status = os.waitstatus_to_exitcode(code)
            break
        helpers.read_available(fd, output, .04)
    else:
        raise AssertionError("TUI did not detach")
    while helpers.read_available(fd, output, .01) > 0:
        pass
    attrs = termios.tcgetattr(fd)
    terminal_restored = bool(attrs[3] & termios.ICANON and attrs[3] & termios.ECHO)
    assert terminal_restored, "Detach did not restore ICANON/ECHO"
    assert status == 0, "TUI exited with status " + str(status)
    assert b"\x1b[?25h" in output, "Detach did not restore the visible cursor"
    notes.append("Detach exits cleanly with ICANON/ECHO and visible cursor restored")
except BaseException as failure:
    error = str(failure)
    try:
        os.kill(pid, signal.SIGKILL)
        _, code = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(code)
    except (ProcessLookupError, ChildProcessError):
        pass
finally:
    os.close(fd)

print(json.dumps({"status": status, "error": error, "terminalRestored": terminal_restored,
    "resizedBytes": resized_bytes, "scrollbackLines": scrollback_lines, "notes": notes,
    "output": base64.b64encode(output).decode()}))
