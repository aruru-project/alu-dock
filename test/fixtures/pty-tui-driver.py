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
    stable_render_batches = 0
    stable_output_bytes = 0
    stable_draft_rewrites = 0
    localized_activity_batches = 0
    startup_mouse_enable_count = 0
    mouse_overlay_priority = False
    draft_visible = False
    timed_out = False
    status = 1
    try:
        action = os.environ.get("ALU_DOCK_PTY_ACTION", "detach")
        hub_actions = ("hub-exit", "hub-narrow", "hub-signal", "hub-new", "hub-continue", "hub-history", "hub-history-forget", "hub-adopt")
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
            if action in hub_actions:
                set_size(fd, 18 if action == "hub-narrow" else 40, 43 if action == "hub-narrow" else 120)
            else:
                set_size(fd, 18, 43)
            os.kill(pid, signal.SIGWINCH)
            resize_deadline = time.monotonic() + 2
            while len(output) == before_resize and time.monotonic() < resize_deadline:
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
                os.write(fd, b"\x03" if action == "hub-narrow" else b"\x1b")  # Leave without choosing a mutation.
            elif action == "hub-signal":
                os.kill(pid, signal.SIGTERM)
            elif action == "hub-new":
                os.write(fd, b"\r")  # Hub defaults to New.
                work_deadline = time.monotonic() + 8
                while b"cache " not in output and time.monotonic() < work_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action == "hub-continue":
                os.write(fd, b"\x1b[B\r")  # Continue is second in the stable root menu.
                continue_deadline = time.monotonic() + 5
                while b"Current Dock work" not in output and time.monotonic() < continue_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\r")  # Select the current Dock instance.
                action_deadline = time.monotonic() + 5
                while b"Attach Session Work" not in output and time.monotonic() < action_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
                os.write(fd, b"\r")
                work_deadline = time.monotonic() + 8
                while b"cache " not in output and time.monotonic() < work_deadline:
                    if read_available(fd, output, 0.05) < 0:
                        break
            elif action in ("hub-history", "hub-history-forget"):
                os.write(fd, b"\x1b[B\x1b[B\r")  # History is third.
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
                    os.write(fd, b"\x1b[B\r")  # Forget is below Continue.
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
                os.write(fd, b"\x1b[B\x1b[B\x1b[B\r")  # Pi Sessions is fourth.
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
            elif action == "history-page":
                # Opt into Dock mouse tracking before exercising SGR wheel.
                os.write(fd, b"\x1bm")
                time.sleep(0.08)
                read_available(fd, output, 0.02)
                for _ in range(6):
                    os.write(fd, b"\x1b[<64;10;5M")
                    time.sleep(0.02)
                    read_available(fd, output, 0.01)
                history_deadline = time.monotonic() + 12
                attempts = 0
                while b"historical line 0" not in output and time.monotonic() < history_deadline and attempts < 280:
                    os.write(fd, b"\x1b[5~")
                    attempts += 1
                    time.sleep(0.025)
                    read_available(fd, output, 0.01)
                if b"historical line 0" in output:
                    os.write(fd, b"\x1b[<65;10;5M")
                    os.write(fd, b"\x1b[6~")
                    os.write(fd, b"\x1b[1;5F")  # Ctrl+End returns to the retained live tail.
                    time.sleep(0.1)
                    read_available(fd, output, 0.05)
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
            elif action == "mouse-selection":
                startup_mouse_enable_count = bytes(output).count(b"\x1b[?1000h\x1b[?1006h")
                os.write(fd, b"\x1bm")  # Alt+M opts into Dock mouse tracking.
                mode_deadline = time.monotonic() + 2
                while b"Dock mouse tracking" not in output and time.monotonic() < mode_deadline:
                    if read_available(fd, output, 0.02) < 0:
                        break
                os.write(fd, b"/m")  # Autocomplete must consume Esc before mouse mode.
                time.sleep(0.08)
                while read_available(fd, output, 0.01) > 0:
                    pass
                disable_sequence = b"\x1b[?1006l\x1b[?1000l"
                disables_before_overlay_escape = bytes(output).count(disable_sequence)
                os.write(fd, b"\x1b")
                time.sleep(0.08)
                while read_available(fd, output, 0.01) > 0:
                    pass
                mouse_overlay_priority = bytes(output).count(disable_sequence) == disables_before_overlay_escape
                os.write(fd, b"\x03")  # Clear the autocomplete query.
                os.write(fd, b"\x1b")  # Esc now returns to default terminal selection.
                time.sleep(0.08)
                while read_available(fd, output, 0.01) > 0:
                    pass
                os.write(fd, b"/mouse\r")  # Slash command opts in again.
                time.sleep(0.12)
                while read_available(fd, output, 0.01) > 0:
                    pass
                os.write(fd, b"\x1bm")  # Alt+M returns without aborting the run.
                time.sleep(0.08)
                while read_available(fd, output, 0.01) > 0:
                    pass
                os.write(fd, b"/mouse\r")  # Leave tracking active so terminal.stop() must clean it up.
                time.sleep(0.08)
                while read_available(fd, output, 0.01) > 0:
                    pass
            elif action == "command-handled":
                for command in (b"/chain\r", b"/chain-prompts\r"):
                    os.write(fd, command)
                    time.sleep(0.15)
                    while read_available(fd, output, 0.01) > 0:
                        pass
            elif action == "tool-fold":
                fold_deadline = time.monotonic() + 3
                while b"Alt+O detail" not in output and time.monotonic() < fold_deadline:
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
            elif action == "compact-detach":
                os.write(fd, b"/compact\r")
                compact_deadline = time.monotonic() + 5
                while b"compacting" not in output and time.monotonic() < compact_deadline:
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
            if action not in ("hub-exit", "hub-signal", "hub-history-forget"):
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
        "mouseOverlayPriority": mouse_overlay_priority,
        "draftVisible": draft_visible,
        "output": base64.b64encode(bytes(output)).decode("ascii"),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
