#!/usr/bin/env python3
"""Real PTY for the system flow, against an already-running isolated fixture Host."""
import base64, importlib.util, json, os, pty, signal, sys, termios, time
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("existing_pty", os.path.join(os.path.dirname(__file__), "pty-tui-driver.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], dict(os.environ, TERM="xterm-256color", NO_COLOR="1"))
output = bytearray()
notes = []
status = -1
position = 0

def wait(marker, seconds=12):
    global position
    deadline = time.monotonic() + seconds
    while marker not in output[position:] and time.monotonic() < deadline:
        if helpers.read_available(fd, output, .04) < 0:
            break
    if marker not in output[position:]:
        raise AssertionError("Missing " + repr(marker) + ": " + bytes(output[-2500:]).decode("utf8", "replace"))
    position = len(output)

def send(data):
    global position
    position = len(output)
    os.write(fd, data)

def choose_cwd():
    send(b"\r"); wait(b"Use this directory")
    send(b"\r"); wait(b"chosen.json")


try:
    helpers.set_size(fd, 32, 100)
    mode = os.environ.get("SYSTEM_PTY_MODE", "hub")
    exiting = mode in ("cancel", "signal", "reader-signal", "hub-signal")
    if mode == "hub":
        wait(b"Alu Dock Hub")
        choose_cwd()
        send(b"\x1b"); wait(b"Alu Dock Hub")
        notes.append("Cancel returns to Hub without Work")
        choose_cwd()
        send(b"v"); wait(b"Reading document")
        deadline = time.monotonic() + 1.05
        while time.monotonic() < deadline:
            helpers.read_available(fd, output, .03)
        send(b"\x1b"); wait(b"Choose a system")
        notes.append("Pending read visible over one second; Esc returns immediately")
        send(b"v"); wait(b"NATIVE-START")
        send(b"\x1b[F"); wait(b"NATIVE-END")
        helpers.set_size(fd, 18, 43); os.kill(pid, signal.SIGWINCH)
        time.sleep(.1)
        helpers.read_available(fd, output, .1)
        notes.append("Native Markdown scroll-to-end and resize 100x32 to 43x18")
        send(b"\x1b"); wait(b"Choose a system")
        send(b"\x1b[B"); time.sleep(.1)
        send(b"v"); wait(b"Original text")
        send(b"\x1b[F"); wait(b"JSON-END")
        notes.append("Non-first template is raw JSON; reader returns without confirming")
        send(b"\x1b"); wait(b"Choose a system")
        # Card 271 review: removing an earlier row must not replace the selected source.
        source = os.path.join(os.getcwd(), ".pi", "SYSTEM.md")
        os.rename(source, source + ".removed")
        before_reload = len(output)
        send(b"r"); wait(b"this Work.")
        assert "› chosen.json".encode() in output[before_reload:], "Reload lost the explicitly selected template"
        os.rename(source + ".removed", source)
        notes.append("Reload preserves the chosen source when an earlier candidate disappears")
        send(b"\x13"); wait(b"Project trust choice")
        send(b"1\r"); wait(b"cache ")
        notes.append("Ctrl+S saves once; trust continues into Work")
        send(b"/resources\r"); wait(b"Pi resources")
        send(b"chosen.json"); time.sleep(.15)
        send(b"\r"); wait(b"Original text")
        send(b"\x1b[F"); wait(b"JSON-END")
        notes.append("Work /resources reads actual chosen source through same reader")
        send(b"\x1b"); wait(b"Pi resources")
        send(b"\x1b"); time.sleep(.2)
    elif mode == "hub-signal":
        wait(b"Alu Dock Hub"); choose_cwd()
        signal_at = time.monotonic()
        os.kill(pid, signal.SIGTERM)
    elif mode == "source-failure":
        wait(b"chosen.json")
        send(b"\x1b[B"); time.sleep(.1)
        send(b"\x13"); wait(b"Project trust choice")
        source = os.path.join(os.environ["HOME"], ".aludock", "systems", "chosen.json")
        os.rename(source, source + ".removed")
        send(b"1\r"); wait(b"Work could not start")
        assert b"Directory default was saved" in output
        position = 0; wait(b"Project SYSTEM")
        os.rename(source + ".removed", source)
        send(b"\r"); wait(b"Project trust choice")
        send(b"1\r"); wait(b"cache ")
        notes.append("Source removed during trust returns to selection; saved default retained, explicit alternative starts Work")
    elif mode in ("cancel", "signal", "reader-signal"):
        wait(b"Choose a system")
        if mode == "reader-signal":
            # Wait for this listing, not merely its loading heading.
            position = 0; wait(b"chosen.json")
            send(b"v"); wait(b"Reading document")
            signal_at = time.monotonic()
            os.kill(pid, signal.SIGTERM)
        elif mode == "signal": os.kill(pid, signal.SIGTERM)
        else: send(b"\x1b")
    elif mode == "default":
        wait(b"Project trust choice")
        assert b"chosen.json" not in output, "saved default must not force the picker"
        send(b"1\r"); wait(b"cache ")
        notes.append("Valid saved default proceeds without a new choice")
    else:
        # Directory default is deliberately corrupt for direct-new/miss scenarios.
        wait(b"chosen.json")
        send(b"\r"); wait(b"Project trust choice")
        send(b"1\r"); wait(b"cache ")
        notes.append("Direct entry requires an explicit choice; Enter does not save")
    if not exiting: send(b"\x04")
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        found, code = os.waitpid(pid, os.WNOHANG)
        if found:
            status = os.waitstatus_to_exitcode(code); break
        helpers.read_available(fd, output, .05)
    else: raise AssertionError("Client failed to exit")
    while helpers.read_available(fd, output, .01) > 0: pass
    attrs = termios.tcgetattr(fd)
    assert attrs[3] & termios.ICANON and attrs[3] & termios.ECHO, "terminal raw mode was not restored"
    assert status == 0, status
    if mode in ("reader-signal", "hub-signal"):
        assert time.monotonic() - signal_at < .8, "pending Host read delayed exit"
        notes.append("SIGTERM restores terminal in under 800ms without another Host read")
    screens = 2 if mode == "source-failure" else 1
    assert bytes(output).count(b"\x1b[?1049h") == screens
    assert bytes(output).count(b"\x1b[?1049l") == screens
    if not exiting:
        assert output.index(b"\x1b[?1049l") < output.index(b"Creating a Pi session")
    notes.append("Single alternate-screen owner, Work main buffer, restored ICANON/ECHO and exit 0")
    print(json.dumps({"status": status, "notes": notes, "output": base64.b64encode(output).decode()}))
except BaseException:
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except ProcessLookupError: pass
    raise
finally:
    os.close(fd)
