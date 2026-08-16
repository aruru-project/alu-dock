const HELP_FLAGS = new Set(["--help", "-h"]);

const PUBLIC_TOPICS = new Set([
  "continue",
  "open",
  "new",
  "attach",
  "list",
  "status",
  "stop",
  "forget",
  "prune",
  "service",
  "help",
]);

const INTERNAL_TOPICS = new Set([
  "serve",
  "ping",
  "create",
  "reopen",
  "events",
  "prompt",
]);

const SERVICE_TOPICS = new Set([
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "uninstall",
]);

/** Resolve help before any client, service-manager, operation or interactive dispatch. */
export function requestedCliHelp(command: string, args: readonly string[]): string[] | undefined {
  if (command === "help") {
    const topics = args.filter((arg) => !HELP_FLAGS.has(arg));
    return topics;
  }
  if (command === "service" && args[0] === "help") {
    return ["service", ...args.slice(1).filter((arg) => !HELP_FLAGS.has(arg))];
  }
  if (!args.some((arg) => HELP_FLAGS.has(arg))) return undefined;
  if (command !== "service") return [command];
  const action = args.find((arg) => !HELP_FLAGS.has(arg) && arg !== "help" && !arg.startsWith("-"));
  return action ? ["service", action] : ["service"];
}

export function renderCliHelp(topics: readonly string[]): string {
  if (topics.length === 0) return overviewHelp();
  const [topic, ...rest] = topics;
  if (!topic) return overviewHelp();
  if (INTERNAL_TOPICS.has(topic)) {
    if (rest.length > 0) throw new Error(`Internal help topic ${topic} does not accept subtopics`);
    return internalTopicHelp(topic);
  }
  if (!PUBLIC_TOPICS.has(topic)) throw new Error(`Unknown help topic: ${topic}`);
  if (topic === "service") return serviceHelp(rest);
  if (rest.length > 0) throw new Error(`${topic} does not have help subtopics`);
  switch (topic) {
    case "continue": return continueHelp();
    case "open": return openHelp();
    case "new": return newHelp();
    case "attach": return attachHelp();
    case "list": return listHelp();
    case "status": return statusHelp();
    case "stop": return stopHelp();
    case "forget": return forgetHelp();
    case "prune": return pruneHelp();
    case "help": return helpHelp();
    default: return overviewHelp();
  }
}

function overviewHelp(): string {
  return `Alu Dock — managed Pi development terminal for SSH\n\nUsage:\n  aludock\n  aludock COMMAND [OPTIONS]\n  aludock help [COMMAND]\n\nStart here:\n  aludock                 Open the Dock Hub\n  aludock -c              Continue recent work here, or create it\n  aludock new             Create a new Pi session and enter Work\n  aludock attach TARGET   Attach to a known active instance\n\nHuman commands:\n  continue  Current-directory smart entry (-c, --continue)\n  open      Explicit legacy smart-entry or reopen by TARGET\n  new       Create a separate instance and Pi session\n  attach    Resolve TARGET and enter Work without taking Host ownership\n  list      Show actionable instances (or all catalog history)\n  status    Show one instance in detail\n  stop      Explicitly stop and dispose one instance\n  forget    Remove one terminal record from the Dock catalog\n  prune     Remove stopped records from the Dock catalog\n  service   Manage the systemd --user Host\n  help      Explore command help\n\nThe managed Host must be running. Hub New starts its folder browser at pwd.\nCtrl+D detaches Work; stop is destructive to the live runtime.\n\nExplore:\n  aludock help open\n  aludock help service\n  aludock COMMAND --help\n`;
}

function continueHelp(): string {
  return `aludock -c — continue recent work in the current directory\n\nUsage:\n  aludock -c\n  aludock --continue\n  aludock continue\n\nSelects the most recently updated active or reopenable Dock instance for the\ncurrent directory and enters Session Work. Active work is attached; recoverable\nwork is explicitly reopened. When no candidate exists, a new Dock instance and\nPi session are created. Stopped History and the separate Pi Sessions inventory\nare not searched.\n\nThis command connects only to an existing Host; it never starts systemd or forks\na detached Host.\n`;
}

function openHelp(): string {
  return `aludock open — explicit smart project entry\n\nUsage:\n  aludock open [TARGET] [--cwd PATH] [--name NAME] [--new]\n\nWithout TARGET, this explicit legacy command examines non-stopped instances for\nthe project directory and may create or reopen a runtime. TARGET accepts a full\nID, unique displayed ID prefix, or unique exact name. Active instances attach;\nrecoverable instances reopen.\n\nOptions:\n  --cwd PATH   Project directory (default: current directory)\n  --name NAME  Name a newly created instance\n  --new        Force a separate instance instead of reusing a match\n\nExamples:\n  aludock open --cwd ~/work/project\n  aludock open 019f7005\n  aludock open review\n  aludock open --new --name review\n\nOrdinary open never starts systemd or forks a detached Host. When the Host is\ndown, use 'aludock service start'.\n`;
}

function newHelp(): string {
  return `aludock new — create a separate Pi session\n\nUsage:\n  aludock new [--cwd PATH] [--name NAME]\n\nAlways creates a new Host-owned instance, even when the project already has an\nactive instance. It then attaches the interactive TUI.\n\nOptions:\n  --cwd PATH   Project directory (default: current directory)\n  --name NAME  Human-readable instance/session name\n\nExamples:\n  aludock new\n  aludock new --cwd ~/work/project --name experiment\n\nUse Ctrl+D to detach without stopping the new instance.\n`;
}

function attachHelp(): string {
  return `aludock attach — attach an interactive client\n\nUsage:\n  aludock attach TARGET\n\nTARGET is a full ID, a unique displayed ID prefix, or a unique exact name. It\nmust resolve to an active Host-owned instance; recoverable and stopped records\nreturn an actionable lifecycle error instead of being treated as attachable.\nAttaching does not transfer runtime ownership or interrupt an in-flight run.\n\nExamples:\n  aludock attach 019f7005\n  aludock attach review\n\nCtrl+D detaches. Use 'aludock stop TARGET' only when disposal is intended.\n`;
}

function listHelp(): string {
  return `aludock list — scan actionable instances\n\nUsage:\n  aludock list [--all]\n\nBy default, shows a bounded human-readable summary of active, stopping,\nhost-lost and runtime-error records while reporting how many stopped records are\nhidden.\nUse --all to include stopped catalog history.\n\nOptions:\n  --all   Include stopped Dock records\n\nExamples:\n  aludock list\n  aludock list --all\n  aludock status TARGET\n\nThis is a read-only request. Typed automation should use DockClient/Protocol V2\nrather than parse terminal text.\n`;
}

function statusHelp(): string {
  return `aludock status — inspect one instance\n\nUsage:\n  aludock status TARGET\n\nResolves a full ID, unique displayed ID prefix, or unique exact name and reads\nthe current closed instance snapshot. It does not attach,\nresume, retry, reopen, or mutate the instance.\n\nExample:\n  aludock status 019f7005\n`;
}

function stopHelp(): string {
  return `aludock stop — dispose one instance\n\nUsage:\n  aludock stop TARGET\n\nResolves the same human TARGET grammar as the Hub, explicitly stops the\nHost-owned runtime, and marks the catalog record stopped. It is not detach and\ncan interrupt a run. No prompt, queue, Promise, interaction or tool effect is\nreplayed.\n\nExample:\n  aludock stop 019f7005\n\nTo leave work running, attach and press Ctrl+D instead.\n`;
}

function forgetHelp(): string {
  return `aludock forget — remove one terminal Dock record\n\nUsage:\n  aludock forget TARGET\n\nResolves the same human TARGET grammar and removes a stopped, host-lost, or\nruntime-error record from the Host-owned Dock catalog after an atomic commit.\nActive and stopping instances are rejected. Pi session files, project files and\nruntime resources are never deleted. Forgetting a recoverable record removes\nonly Dock's reopen pointer.\n\nExample:\n  aludock forget 019f7005\n\nMutations are not automatically retried after an ambiguous transport outcome.\n`;
}

function pruneHelp(): string {
  return `aludock prune — remove stopped Dock history\n\nUsage:\n  aludock prune --stopped\n\nAtomically removes a bounded batch of stopped records only. Recoverable\nhost-lost/runtime-error records are preserved. Repeat when the receipt reports\nthat more stopped records remain. Pi session files are never deleted.\n\nExample:\n  aludock prune --stopped\n`;
}

function helpHelp(): string {
  return `aludock help — explore the human CLI\n\nUsage:\n  aludock help\n  aludock help COMMAND\n  aludock help service SUBCOMMAND\n  aludock COMMAND --help\n\nHelp is local and read-only: it does not connect to the Host, query the catalog,\nstart systemd, generate an operation ID, or require a TTY.\n\nExamples:\n  aludock help open\n  aludock help service logs\n  aludock stop --help\n`;
}

function serviceHelp(rest: readonly string[]): string {
  if (rest.length === 0) {
    return `aludock service — manage the systemd --user Host\n\nUsage:\n  aludock service [status]\n  aludock service COMMAND [OPTIONS]\n\nCommands:\n  install     Install the generated user unit\n  start       Start the managed Host\n  stop        Stop the Host\n  restart     Restart the Host\n  status      Show systemd readiness and managed capabilities\n  logs        Read the user journal\n  uninstall   Remove only an Alu Dock-generated unit\n\nInstall or update the local package from the current working tree with:\n\n  npm run install:local\n\nThe installer refuses active Dock instances and must run outside the managed\nHost. Service commands never run tests or modify Pi session files.\n\nExplore:\n  aludock help service install\n  aludock service logs --help\n`;
  }
  if (rest.length !== 1 || !SERVICE_TOPICS.has(rest[0] as string)) {
    throw new Error(`Unknown service help topic: ${rest.join(" ")}`);
  }
  switch (rest[0]) {
    case "install":
      return `aludock service install — install the generated user unit\n\nUsage:\n  aludock service install [--now]\n\nOptions:\n  --now   Enable and start the unit after installation\n\nRefuses to overwrite a unit not generated by Alu Dock.\n`;
    case "start":
      return `aludock service start — start the managed Host\n\nUsage:\n  aludock service start\n\nStarts the installed systemd --user unit and waits for managed V2 readiness.\n`;
    case "stop":
      return `aludock service stop — stop the managed Host\n\nUsage:\n  aludock service stop\n\nStops the systemd --user Host. In-flight work is not replayed after Host loss.\nInspect 'aludock list' first when practical.\n`;
    case "restart":
      return `aludock service restart — replace the managed Host\n\nUsage:\n  aludock service restart\n\nRestarts the systemd --user unit and waits for readiness. Existing runs, queues,\ninteractions and side-effect Promises are not resumed or replayed.\n`;
    case "status":
      return `aludock service status — inspect managed readiness\n\nUsage:\n  aludock service status\n\nReads systemd state and verifies the expected MainPID, V2 handshake and managed\ncapabilities. It does not start or restart the service.\n`;
    case "logs":
      return `aludock service logs — read Host journal output\n\nUsage:\n  aludock service logs [--lines N] [--follow]\n\nOptions:\n  --lines N, -n N   Read 1–10000 lines (default: 200)\n  --follow, -f      Follow new journal entries\n\nExamples:\n  aludock service logs --lines 100\n  aludock service logs --follow\n`;
    case "uninstall":
      return `aludock service uninstall — remove the generated unit\n\nUsage:\n  aludock service uninstall\n\nRemoves only a unit carrying Alu Dock's generated marker. It does not delete the\ndurable catalog or Pi session files.\n`;
    default:
      throw new Error(`Unknown service help topic: ${String(rest[0])}`);
  }
}

function internalTopicHelp(topic: string): string {
  const humanAlternative: Record<string, string> = {
    serve: "Use 'aludock service' to manage the Host.",
    ping: "Use 'aludock service status' for human readiness checks.",
    create: "Use 'aludock new' to create and attach interactively.",
    reopen: "Use 'aludock open' to choose and reopen recoverable context.",
    events: "Use the interactive TUI or 'aludock status' for human inspection.",
    prompt: "Submit prompts through the attached interactive TUI.",
  };
  return `${topic} is an internal control command used by tests or operator\ndiagnostics. It is intentionally omitted from the public human command taxonomy\nand is not a model tool surface.\n\n${humanAlternative[topic] ?? "Use the public human workflow instead."}\nTyped automation should call DockClient/Protocol V2. See the repository's\ninternal control documentation.\n`;
}
