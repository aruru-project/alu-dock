# V0.1 human CLI help validation

Date: 2026-07-16

Cards: #166 under the #164 human-acceptance blocker gate

Status: source slice complete; #167 human `list` output and consolidated immutable rollout remain pending

## Problem

The former top-level usage block placed human workflow, systemd lifecycle and internal V0/V0.1 machine probes at equal prominence. It did not explain the behavioral difference between smart open, forced new and attach, and it had no command-level help dispatch.

Concrete failures included:

- `open --help`, `create --help` and `service logs --help` returning JSON CLI errors;
- `help create` ignoring the requested topic;
- `status --help` and `stop --help` treating `--help` as an instance ID and entering business dispatch.

## Public taxonomy

The frozen human command surface is:

```text
alu-dock               smart-open the current project
alu-dock open          smart project resolution, with optional exact ID
alu-dock new           always create a separate instance/Pi session
alu-dock attach        attach a thin TUI; exact ID is the normal explicit form
alu-dock list          scan the bounded catalog summary
alu-dock status        read one known instance
alu-dock stop          explicitly dispose one instance
alu-dock service       explicitly manage the systemd --user Host
alu-dock help          explore the human surface
```

Top-level help contains only these commands, concise semantics, the Ctrl+D detach versus stop distinction, and next-step help examples. It does not list `serve`, `ping`, `create`, `reopen`, `events`, `prompt` or `--socket`.

`serve/ping/create/reopen/events/prompt` remain available for existing tests, release smoke and operator diagnostics until their consumers are deliberately migrated. An explicit help request for one of them returns a short local redirect to the corresponding human workflow and typed DockClient/Protocol V2; internal commands are not promoted into the overview and are not model tools.

## Dispatch contract

The following forms are equivalent for every public top-level command:

```text
alu-dock COMMAND --help
alu-dock help COMMAND
```

Service help is nested:

```text
alu-dock service --help
alu-dock help service
alu-dock service logs --help
alu-dock help service logs
alu-dock service help logs
```

Help detection runs immediately after bounded global argument parsing and before interactive import, DockClient construction, UUID generation, service-manager construction or command parsing. Options before `--help` are not validated or executed. Therefore even these requests are safe and exit 0:

```text
alu-dock status --help
alu-dock open --cwd /missing --name ignored --help
alu-dock service logs --lines not-a-number --help
```

All static pages are terminal-safe, end with a newline and have a maximum source line width of 80 columns.

## Automated evidence

```text
TypeScript: PASS
npm test: 241/241 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/settings boundaries: PASS
```

The subprocess matrix sets `ALU_DOCK_SOCKET` to a nonexistent path. Top-level, six public command pages, all seven service subpages, the reproduced missing-argument cases and explicit internal redirects all exit 0 with non-JSON stdout and empty stderr. This simultaneously proves that help did not connect to a daemon. Setting the socket override for service help also proves dispatch returned before `UserServiceManager`, because ordinary service commands reject that override.

Pure routing tests cover help flags after otherwise invalid options, nested service topics, local output safety and 80-column bounds.

## Real SSH evidence

The source CLI was invoked through loopback SSH with a nonexistent socket for:

```text
--help
help open
service logs --help
status --help
create --help
```

Every request exited 0 without a daemon. The overview contained `Human commands:` and no `alu-dock create`; the command pages contained their expected usage/options, and the internal page identified itself as an internal control command. Result: `SSH_HELP_GATE:PASS`.

## Remaining work and risks

- #167 must make the default `alu-dock list` output match its now-frozen human help and migrate machine consumers to typed DockClient/V2 or an explicitly internal control entry.
- The current source slice is not independently deployed; the installed Night Console candidate still has the old help until #164's unified release.
- The final Windows Terminal/PowerShell/SSH pass must assess discoverability as a first-time user and verify all published service help forms from the installed `alu-dock` executable.
- Help does not rename every internal command or turn CLI text into an API. Future model diagnostics require a closed read-only Pi tool, not help-text parsing.
