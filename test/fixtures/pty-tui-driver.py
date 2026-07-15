#!/usr/bin/env python3
"""Run a command in a real PTY, resize it, toggle tools, then detach."""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_size(fd: int, rows: int, columns: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def read_available(fd: int, output: bytearray, timeout: float) -> int:
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return 0
    try:
        chunk = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return -1
        raise
    if not chunk:
        return -1
    output.extend(chunk)
    return len(chunk)


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: pty-tui-driver.py COMMAND [ARG ...]")

    pid, fd = pty.fork()
    if pid == 0:
        environment = dict(os.environ)
        environment.setdefault("TERM", "xterm-256color")
        environment["NO_COLOR"] = "1"
        os.execvpe(sys.argv[1], sys.argv[1:], environment)

    output = bytearray()
    resized_bytes = 0
    timed_out = False
    status = 1
    try:
        set_size(fd, 24, 80)
        deadline = time.monotonic() + 12
        while b"Enter send/steer" not in output and time.monotonic() < deadline:
            if read_available(fd, output, 0.1) < 0:
                break
        if b"Enter send/steer" not in output:
            timed_out = True
        else:
            before_resize = len(output)
            set_size(fd, 18, 43)
            os.kill(pid, signal.SIGWINCH)
            resize_deadline = time.monotonic() + 2
            while len(output) == before_resize and time.monotonic() < resize_deadline:
                if read_available(fd, output, 0.05) < 0:
                    break
            resized_bytes = len(output) - before_resize
            action = os.environ.get("ALU_DOCK_PTY_ACTION", "detach")
            ready_file = os.environ.get("ALU_DOCK_PTY_READY_FILE")
            if ready_file:
                with open(ready_file, "w", encoding="utf-8") as marker:
                    marker.write("ready\n")
            if action == "abort":
                os.write(fd, b"\x03")  # Ctrl+C with empty editor: abort current run.
                abort_deadline = time.monotonic() + 4
                while b"Run aborted" not in output and time.monotonic() < abort_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "editor":
                os.write(fd, b"\x1b[200~first line\nsecond line\x1b[201~\r")
                first_deadline = time.monotonic() + 3
                while b"first line" not in output and time.monotonic() < first_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                time.sleep(0.1)
                os.write(fd, b"\x1b[A\r")  # History up, then resubmit.
                time.sleep(0.2)
                read_available(fd, output, 0.05)
            elif action == "transport-close":
                close_deadline = time.monotonic() + 6
                while b"replayed; this TUI" not in output and time.monotonic() < close_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "extension-dialogs":
                dialog_steps = [
                    (b"Pick fixture", b"beta\r"),
                    (b"Confirm fixture", b"\x1b[A\r"),
                    (b"Input fixture", b"typed value\r"),
                    (b"Edit fixture", b"\r"),
                ]
                for marker, response in dialog_steps:
                    dialog_deadline = time.monotonic() + 5
                    while marker not in output and time.monotonic() < dialog_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                    os.write(fd, response)
                    time.sleep(0.1)
                    read_available(fd, output, 0.05)
            elif action == "extension-replacement":
                dialog_deadline = time.monotonic() + 5
                while b"Post replacement confirm" not in output and time.monotonic() < dialog_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1b[A\r")  # Confirm defaults to No; move to explicit Yes.
                time.sleep(0.1)
                read_available(fd, output, 0.05)
            elif action == "model-search":
                os.write(fd, b"/model\r")
                picker_deadline = time.monotonic() + 4
                while b"Search:" not in output and time.monotonic() < picker_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"local\r")
                selected_deadline = time.monotonic() + 4
                while b"Model changed to fixture/local" not in output and time.monotonic() < selected_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "scroll":
                os.write(fd, b"\x1b[5~")  # PageUp
                scroll_deadline = time.monotonic() + 3
                while b"history paused" not in output and time.monotonic() < scroll_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if ready_file:
                    with open(ready_file + ".locked", "w", encoding="utf-8") as marker:
                        marker.write("locked\n")
                unseen_deadline = time.monotonic() + 4
                while b"new output" not in output and time.monotonic() < unseen_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1b[6~")  # PageDown returns one PageUp to the bottom.
                time.sleep(0.1)
                read_available(fd, output, 0.05)
            elif action == "tool-fold":
                fold_deadline = time.monotonic() + 3
                while b"Alt+O detail" not in output and time.monotonic() < fold_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1bo")  # Alt+O: expand latest tool only.
                expand_deadline = time.monotonic() + 3
                while b"expanded tool detail" not in output and time.monotonic() < expand_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "stage6":
                os.write(fd, b"/tree tree-u2\r")
                tree_deadline = time.monotonic() + 5
                while b"Session branch selected" not in output and time.monotonic() < tree_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x03")  # Clear selected editor text.
                os.write(fd, b"/fork tree-u2\r")
                fork_deadline = time.monotonic() + 5
                while b"generation 2" not in output and time.monotonic() < fork_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x03")  # Clear fork-selected editor text.
                os.write(fd, b"/clone\r")
                clone_deadline = time.monotonic() + 5
                while b"generation 3" not in output and time.monotonic() < clone_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "stage3":
                steps = [
                    (b"/settings autoRetry false\r", b"autoRetry = false"),
                    (b"/tools read write\r", b"Active tools: read, write"),
                    (b"/name PTY Stage 3\r", b"Session name: PTY Stage 3"),
                    (b"/compact\r", b"Compacted 123 tokens"),
                    (b"/reload\r", b"Resources reloaded"),
                    (b"/new\r", b"Session new"),
                    (b"/resume /tmp/pty-resume.jsonl\r", b"Session resume"),
                ]
                for command, marker in steps:
                    os.write(fd, command)
                    command_deadline = time.monotonic() + 5
                    while marker not in output and time.monotonic() < command_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
            else:
                os.write(fd, b"\x0f")  # Ctrl+O: collapse/expand tool output.
                time.sleep(0.1)
                read_available(fd, output, 0.05)
            os.write(fd, b"\x04")  # Ctrl+D: detach without stopping.

        exit_deadline = time.monotonic() + 8
        while time.monotonic() < exit_deadline:
            result, wait_status = os.waitpid(pid, os.WNOHANG)
            if result == pid:
                status = os.waitstatus_to_exitcode(wait_status)
                break
            if read_available(fd, output, 0.05) < 0:
                result, wait_status = os.waitpid(pid, 0)
                status = os.waitstatus_to_exitcode(wait_status)
                break
        else:
            timed_out = True
            os.kill(pid, signal.SIGKILL)
            _, wait_status = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(wait_status)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

    sys.stdout.write(json.dumps({
        "status": status,
        "timedOut": timed_out,
        "resizedBytes": resized_bytes,
        "output": base64.b64encode(bytes(output)).decode("ascii"),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
