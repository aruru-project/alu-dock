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


def hub_item_y(rows: int, columns: int, item_index: int, item_count: int) -> int:
    list_rows = min(max(item_count, 1), 12) + (1 if item_count > 12 else 0)
    if columns < 64:
        content_rows = 1 + 2 + list_rows + 1
        list_start = 1 + 2
    else:
        content_rows = max(10, 2 + list_rows + 1)
        list_start = 2
    top_padding = max(0, (rows - content_rows) // 2)
    return top_padding + list_start + item_index + 1


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


def write_input(fd: int, output: bytearray, data: bytes, settle: float = 0.04) -> None:
    os.write(fd, data)
    deadline = time.monotonic() + settle
    while time.monotonic() < deadline:
        if read_available(fd, output, 0.01) < 0:
            break


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
    stable_render_batches = 0
    stable_output_bytes = 0
    stable_draft_rewrites = 0
    localized_activity_batches = 0
    startup_mouse_enable_count = 0
    navigation_scrollback_clear_count = 0
    navigation_render_batches = 0
    draft_visible = False
    signal_restore_ms = -1.0
    timed_out = False
    status = 1
    try:
        action = os.environ.get("ALU_DOCK_PTY_ACTION", "detach")
        hub_actions = ("hub-exit", "hub-click-leave", "hub-narrow", "hub-signal", "hub-signal-inventory", "hub-new", "hub-continue", "hub-mouse-continue", "hub-history", "hub-history-forget", "hub-adopt")
        startup_marker = b"Alu Dock Hub" if action in hub_actions else b"cache "
        set_size(fd, 24, 80)
        deadline = time.monotonic() + 12
        while startup_marker not in output and time.monotonic() < deadline:
            if read_available(fd, output, 0.1) < 0:
                break
        if startup_marker not in output:
            timed_out = True
        else:
            before_resize = len(output)
            completed_renders = bytes(output).count(b"\x1b[?2026l")
            if action in hub_actions:
                set_size(fd, 18 if action == "hub-narrow" else 40, 43 if action == "hub-narrow" else 120)
            elif action in ("extension-dialogs", "extension-replacement", "extension-pending-attach", "extension-response-retry"):
                set_size(fd, 40, 120)
            elif action == "flow-frame-stability":
                set_size(fd, 58, 252)
            else:
                set_size(fd, 18, 43)
            os.kill(pid, signal.SIGWINCH)
            resize_deadline = time.monotonic() + 2
            while bytes(output).count(b"\x1b[?2026l") <= completed_renders and time.monotonic() < resize_deadline:
                if read_available(fd, output, 0.05) < 0:
                    break
            resized_bytes = len(output) - before_resize
            ready_file = os.environ.get("ALU_DOCK_PTY_READY_FILE")
            if ready_file:
                with open(ready_file, "w", encoding="utf-8") as marker:
                    marker.write("ready\n")
            if action in ("hub-exit", "hub-narrow"):
                if action == "hub-narrow":
                    time.sleep(0.12)
                    while read_available(fd, output, 0.01) > 0:
                        pass
                os.write(fd, b"\x03" if action == "hub-narrow" else b"\x1b")  # Keyboard leave without mutation.
            elif action == "hub-click-leave":
                y = hub_item_y(40, 120, 4, 5)
                os.write(fd, f"\x1b[<0;30;{y}M".encode("ascii"))
            elif action == "hub-signal":
                os.kill(pid, signal.SIGTERM)
            elif action == "hub-signal-inventory":
                for _ in range(3):
                    write_input(fd, output, b"\x1b[B")  # Pi Sessions is fourth.
                os.write(fd, b"\r")
                loading_deadline = time.monotonic() + 5
                while b"Loading Pi Sessions" not in output and time.monotonic() < loading_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                signal_sent = time.monotonic()
                os.kill(pid, signal.SIGTERM)
                restore_deadline = signal_sent + 1
                while b"\x1b[?1049l" not in output and time.monotonic() < restore_deadline:
                    if read_available(fd, output, 0.01) < 0:
                        break
                if b"\x1b[?1049l" in output:
                    signal_restore_ms = (time.monotonic() - signal_sent) * 1000
            elif action == "hub-new":
                os.write(fd, b"\r")  # Hub defaults to New.
                work_deadline = time.monotonic() + 8
                while b"cache " not in output and time.monotonic() < work_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action in ("hub-continue", "hub-mouse-continue"):
                if action == "hub-continue":
                    write_input(fd, output, b"\x1b[B")  # Continue is second in the stable root menu.
                else:
                    write_input(fd, output, b"\x1b[<65;30;20M")  # One wheel step selects Continue.
                os.write(fd, b"\r")
                continue_deadline = time.monotonic() + 5
                while b"Current Dock work" not in output and time.monotonic() < continue_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if action == "hub-continue":
                    os.write(fd, b"\r")
                else:
                    y = hub_item_y(40, 120, 0, 2)
                    os.write(fd, f"\x1b[<0;30;{y}M".encode("ascii"))
                action_deadline = time.monotonic() + 5
                while b"Open Work" not in output and time.monotonic() < action_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if action == "hub-continue":
                    os.write(fd, b"\r")
                else:
                    y = hub_item_y(40, 120, 0, 3)
                    os.write(fd, f"\x1b[<0;30;{y}M".encode("ascii"))
                work_deadline = time.monotonic() + 8
                while b"cache " not in output and time.monotonic() < work_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action in ("hub-history", "hub-history-forget"):
                write_input(fd, output, b"\x1b[B")
                write_input(fd, output, b"\x1b[B")  # History is third.
                os.write(fd, b"\r")
                history_deadline = time.monotonic() + 5
                while b"Past Dock records" not in output and time.monotonic() < history_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\r")  # Select the newest stopped record.
                action_deadline = time.monotonic() + 5
                while b"Forget history record" not in output and time.monotonic() < action_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if action == "hub-history":
                    os.write(fd, b"\r")
                    work_deadline = time.monotonic() + 8
                    while b"cache " not in output and time.monotonic() < work_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                else:
                    write_input(fd, output, b"\x1b[B")  # Forget is below Continue.
                    os.write(fd, b"\r")
                    forget_deadline = time.monotonic() + 5
                    while b"Forgot History record" not in output and time.monotonic() < forget_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                    empty_deadline = time.monotonic() + 5
                    while b"No Dock history" not in output and time.monotonic() < empty_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                    os.write(fd, b"\x1b")
            elif action == "hub-adopt":
                for _ in range(3):
                    write_input(fd, output, b"\x1b[B")  # Pi Sessions is fourth.
                os.write(fd, b"\r")
                inventory_deadline = time.monotonic() + 5
                while b"Pi session inventory incomplete" not in output and time.monotonic() < inventory_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\r")  # Select the only persisted session.
                adopt_deadline = time.monotonic() + 5
                while b"Adopt as a new Dock instance" not in output and time.monotonic() < adopt_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\r")
                work_deadline = time.monotonic() + 8
                while b"cache " not in output and time.monotonic() < work_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "work-responsive":
                time.sleep(0.08)
                while read_available(fd, output, 0.01) > 0:
                    pass
                set_size(fd, 18, 120)
                os.kill(pid, signal.SIGWINCH)
                wide_deadline = time.monotonic() + 2
                while time.monotonic() < wide_deadline:
                    if read_available(fd, output, 0.05) > 0 and b"fixture/default" in output:
                        break
            elif action == "abort":
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
                while b"status is unknown" not in output and time.monotonic() < close_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "stream-recover":
                recovery_deadline = time.monotonic() + 8
                while b"Event stream reconnected" not in output and time.monotonic() < recovery_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"/status\r")
                status_deadline = time.monotonic() + 5
                while b"Status: running" not in output and time.monotonic() < status_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "external-stop":
                stop_deadline = time.monotonic() + 8
                while b"stopped" not in output and time.monotonic() < stop_deadline:
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
                os.write(fd, b"\x03")  # Clear the injected main-editor draft before detach.
                time.sleep(0.05)
                read_available(fd, output, 0.02)
            elif action == "extension-replacement":
                dialog_deadline = time.monotonic() + 5
                while b"Post replacement confirm" not in output and time.monotonic() < dialog_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1b[A\r")  # Confirm defaults to No; move to explicit Yes.
                directive_deadline = time.monotonic() + 5
                while (b"Post replacement extension title" not in output or b"post replacement injected draft" not in output) and time.monotonic() < directive_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x03")  # Clear the injected main-editor draft before detach.
                time.sleep(0.05)
                read_available(fd, output, 0.02)
            elif action == "extension-pending-attach":
                dialog_deadline = time.monotonic() + 5
                while b"Fresh attach confirm" not in output and time.monotonic() < dialog_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1b[A\r")
                time.sleep(0.1)
                read_available(fd, output, 0.05)
            elif action == "extension-response-retry":
                dialog_deadline = time.monotonic() + 5
                while b"Retry response confirm" not in output and time.monotonic() < dialog_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1b[A\r")
                retry_deadline = time.monotonic() + 5
                while b"same question remains pending" not in output and time.monotonic() < retry_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1b[A\r")
                time.sleep(0.1)
                read_available(fd, output, 0.05)
            elif action in ("model-search", "model-disconnect"):
                os.write(fd, b"/model\r")
                picker_deadline = time.monotonic() + 4
                while b"Search:" not in output and time.monotonic() < picker_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if action == "model-disconnect" and ready_file:
                    with open(ready_file + ".picker", "w", encoding="utf-8") as marker:
                        marker.write("picker\n")
                    disconnect_deadline = time.monotonic() + 8
                    while b"fresh conversation view" not in output and time.monotonic() < disconnect_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                os.write(fd, b"local\r")
                selected_deadline = time.monotonic() + 4
                selected_marker = b"Model changed to fixture/local"
                while selected_marker not in output and time.monotonic() < selected_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "history-flow":
                pass  # Eager history already flowed into native terminal scrollback.
            elif action == "history-live-flow":
                live_deadline = time.monotonic() + 4
                while b"new output" not in output and time.monotonic() < live_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "flow-frame-stability":
                time.sleep(0.05)
                while read_available(fd, output, 0.01) > 0:
                    pass
                navigation_start = len(output)
                marker = b"ALU_LAYOUT_PTY_MARKER"
                write_input(fd, output, marker, 0.08)
                os.write(fd, b"\x0f")  # Host-authoritative Ctrl+O must preserve the draft.
                frame_deadline = time.monotonic() + 3
                while time.monotonic() < frame_deadline:
                    if read_available(fd, output, 0.03) < 0:
                        break
                    if marker in bytes(output[navigation_start:]) and bytes(output[navigation_start:]).count(b"\x1b[?2026h") >= 1:
                        break
                navigation_output = bytes(output[navigation_start:])
                navigation_scrollback_clear_count = navigation_output.count(b"\x1b[3J")
                navigation_render_batches = navigation_output.count(b"\x1b[?2026h")
                draft_visible = marker in navigation_output
                os.write(fd, b"\x03")
                time.sleep(0.05)
                read_available(fd, output, 0.02)
            elif action in ("queue-restore", "queue-inflight", "queue-abort"):
                queue_deadline = time.monotonic() + 4
                while b"steer next" not in output and time.monotonic() < queue_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if action == "queue-restore":
                    os.write(fd, b"\x1b[1;3A")  # Alt+Up: restore all without aborting.
                    restore_deadline = time.monotonic() + 4
                    while b"Restored 2 queued messages to editor" not in output and time.monotonic() < restore_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                elif action == "queue-inflight":
                    os.write(fd, b"current draft")
                    draft_deadline = time.monotonic() + 2
                    while b"current draft" not in output and time.monotonic() < draft_deadline:
                        if read_available(fd, output, 0.02) < 0:
                            break
                    os.write(fd, b"\x1b")  # Escape must not abort while Pi owns an in-flight item.
                    inflight_deadline = time.monotonic() + 4
                    while b"run was not aborted" not in output and time.monotonic() < inflight_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                    draft_visible = b"current draft" in output
                else:
                    os.write(fd, b"\x1b")  # Escape: restore queue, then abort the run.
                    abort_deadline = time.monotonic() + 5
                    while b"Run aborted" not in output and time.monotonic() < abort_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
                os.write(fd, b"\x03")  # Clear restored editor text before Ctrl+D detach.
                time.sleep(0.1)
                read_available(fd, output, 0.05)
            elif action == "activity-stability":
                draft = b"draft while agent runs"
                os.write(fd, draft)
                draft_deadline = time.monotonic() + 3
                while draft not in output and time.monotonic() < draft_deadline:
                    if read_available(fd, output, 0.02) < 0:
                        break
                draft_visible = draft in output
                # Drain the input-triggered render, then observe a quiet period.
                # A waiting runtime emits no events, so any synchronized batches
                # here are timer-only repaints of otherwise stable composer state.
                drain_deadline = time.monotonic() + 0.08
                while time.monotonic() < drain_deadline:
                    if read_available(fd, output, 0.01) < 0:
                        break
                stable_start = len(output)
                sample_deadline = time.monotonic() + 0.65
                while time.monotonic() < sample_deadline:
                    if read_available(fd, output, 0.02) < 0:
                        break
                stable_output = bytes(output[stable_start:])
                stable_render_batches = stable_output.count(b"\x1b[?2026h")
                localized_activity_batches = stable_output.count(b"\x1b[s")
                stable_draft_rewrites = stable_output.count(draft)
                stable_output_bytes = len(stable_output)
                os.write(fd, b"\x03")  # Clear the draft before detach.
                time.sleep(0.05)
                read_available(fd, output, 0.02)
            elif action == "activity-streaming":
                draft = b"draft survives concurrent streaming"
                for byte in draft:
                    os.write(fd, bytes([byte]))
                    time.sleep(0.012)
                    read_available(fd, output, 0.005)
                time.sleep(0.12)
                while read_available(fd, output, 0.01) > 0:
                    pass
                frame_start = len(output)
                set_size(fd, 18, 44)
                os.kill(pid, signal.SIGWINCH)
                frame_deadline = time.monotonic() + 2
                while time.monotonic() < frame_deadline:
                    if read_available(fd, output, 0.02) < 0:
                        break
                    frame_output = bytes(output[frame_start:])
                    if b"\x1b[2J\x1b[H\x1b[3J" in frame_output and draft in frame_output:
                        break
                draft_visible = draft in bytes(output[frame_start:])
                os.write(fd, b"\x03")
                time.sleep(0.05)
                read_available(fd, output, 0.02)
            elif action == "work-native-mouse":
                startup_mouse_enable_count = bytes(output).count(b"\x1b[?1000h\x1b[?1006h")
            elif action == "command-handled":
                for message in (b"fixture no-run one\r", b"fixture no-run two\r"):
                    os.write(fd, message)
                    time.sleep(0.15)
                    while read_available(fd, output, 0.01) > 0:
                        pass
            elif action == "tool-fold":
                fold_deadline = time.monotonic() + 3
                while "✓ read".encode("utf-8") not in output and time.monotonic() < fold_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x1bo")  # Alt+O: expand latest tool only.
                expand_deadline = time.monotonic() + 1
                while b"expanded tool detail" not in output and time.monotonic() < expand_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if b"expanded tool detail" not in output:
                    os.write(fd, b"\x1b[6~\x1b[1;5F")  # PageDown/Ctrl+End reveal the expanded tail in narrow chrome.
                    expand_deadline = time.monotonic() + 5
                    while b"expanded tool detail" not in output and time.monotonic() < expand_deadline:
                        if read_available(fd, output, 0.05) < 0:
                            break
            elif action == "tree-branch-roundtrip":
                os.write(fd, b"/tree\r")
                picker_deadline = time.monotonic() + 5
                while b"Navigate session tree" not in output and time.monotonic() < picker_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                loaded_marker = b"shared answer"
                loaded_deadline = time.monotonic() + 5
                while loaded_marker not in output and time.monotonic() < loaded_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\x01")  # Ctrl+A: temporary All filter must survive Branch action Esc.
                os.write(fd, b"original branch answer")
                time.sleep(0.04)
                while read_available(fd, output, 0.01) > 0:
                    pass
                os.write(fd, b"\r")
                mode_deadline = time.monotonic() + 5
                while b"Branch action" not in output and time.monotonic() < mode_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                back_start = len(output)
                os.write(fd, b"\x1b")  # Esc returns to the same Tree surface and selection.
                back_deadline = time.monotonic() + 5
                while b"Search [all]" not in output[back_start:] and time.monotonic() < back_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                action_start = len(output)
                os.write(fd, b"\r")  # The previously selected branch remains selected.
                action_deadline = time.monotonic() + 5
                while b"Branch action" not in output[action_start:] and time.monotonic() < action_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\r")
                navigation_deadline = time.monotonic() + 5
                while b"Session branch selected" not in output and time.monotonic() < navigation_deadline:
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
            elif action in ("compact-detach", "compact-queue"):
                os.write(fd, b"/compact\r")
                compact_deadline = time.monotonic() + 5
                while b"compacting" not in output and time.monotonic() < compact_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                if action == "compact-queue":
                    os.write(fd, b"manual queue survives\r")
                    queue_deadline = time.monotonic() + 5
                    while b"steer next" not in output and time.monotonic() < queue_deadline:
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
            if action not in ("hub-exit", "hub-click-leave", "hub-signal", "hub-signal-inventory", "hub-history-forget"):
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
        "stableRenderBatches": stable_render_batches,
        "stableOutputBytes": stable_output_bytes,
        "stableDraftRewrites": stable_draft_rewrites,
        "localizedActivityBatches": localized_activity_batches,
        "startupMouseEnableCount": startup_mouse_enable_count,
        "navigationScrollbackClearCount": navigation_scrollback_clear_count,
        "navigationRenderBatches": navigation_render_batches,
        "draftVisible": draft_visible,
        "signalRestoreMs": signal_restore_ms,
        "output": base64.b64encode(bytes(output)).decode("ascii"),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
