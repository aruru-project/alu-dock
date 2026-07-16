const HELP_FLAGS = new Set(["--help", "-h"]);

const PUBLIC_TOPICS = new Set([
  "open",
  "new",
  "attach",
  "list",
  "status",
  "stop",
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
    case "open": return openHelp();
    case "new": return newHelp();
    case "attach": return attachHelp();
    case "list": return listHelp();
    case "status": return statusHelp();
    case "stop": return stopHelp();
    case "help": return helpHelp();
    default: return overviewHelp();
  }
}

function overviewHelp(): string {
  return `Alu Dock — managed Pi development terminal for SSH\n\nUsage:\n  alu-dock\n  alu-dock COMMAND [OPTIONS]\n  alu-dock help [COMMAND]\n\nStart here:\n  alu-dock                 Smart-open the current project\n  alu-dock new             Always create a new Pi session\n  alu-dock attach ID       Attach to a known active instance\n\nHuman commands:\n  open      Reuse, choose, reopen, or create for a project\n  new       Create a separate instance and Pi session\n  attach    Attach an interactive TUI without taking Host ownership\n  list      Show known instances and their current state\n  status    Show one instance in detail\n  stop      Explicitly stop and dispose one instance\n  service   Manage the systemd --user Host\n  help      Explore command help\n\nThe managed Host must be running. Ctrl+D detaches the client while the instance\nkeeps running; stop is destructive to the live runtime.\n\nExplore:\n  alu-dock help open\n  alu-dock help service\n  alu-dock COMMAND --help\n`;
}

function openHelp(): string {
  return `alu-dock open — smart project entry\n\nUsage:\n  alu-dock open [INSTANCE_ID] [--cwd PATH] [--name NAME] [--new]\n\nWithout an ID, open examines non-stopped instances for the project directory. It\nreuses the only active match, offers a chooser when needed, reopens explicitly\nselected recoverable context, or creates a session when no match exists. With an\nID, it attaches only if that exact instance is active.\n\nOptions:\n  --cwd PATH   Project directory (default: current directory)\n  --name NAME  Name a newly created instance\n  --new        Force a separate instance instead of reusing a match\n\nExamples:\n  alu-dock\n  alu-dock open --cwd ~/work/project\n  alu-dock open INSTANCE_ID\n  alu-dock open --new --name review\n\nOrdinary open never starts systemd or forks a detached Host. When the Host is\ndown, use 'alu-dock service start'.\n`;
}

function newHelp(): string {
  return `alu-dock new — create a separate Pi session\n\nUsage:\n  alu-dock new [--cwd PATH] [--name NAME]\n\nAlways creates a new Host-owned instance, even when the project already has an\nactive instance. It then attaches the interactive TUI.\n\nOptions:\n  --cwd PATH   Project directory (default: current directory)\n  --name NAME  Human-readable instance/session name\n\nExamples:\n  alu-dock new\n  alu-dock new --cwd ~/work/project --name experiment\n\nUse Ctrl+D to detach without stopping the new instance.\n`;
}

function attachHelp(): string {
  return `alu-dock attach — attach an interactive client\n\nUsage:\n  alu-dock attach [INSTANCE_ID] [--cwd PATH]\n\nWith an ID, attaches to that active Host-owned instance. Without an ID, attach\nuses the same current-project resolution and chooser as 'alu-dock open'. Prefer\n'open' for the normal smart-entry workflow. Attaching does not transfer runtime\nownership to the terminal and does not interrupt an in-flight run.\n\nOptions:\n  --cwd PATH   Project directory used when no ID is supplied\n\nExamples:\n  alu-dock attach INSTANCE_ID\n  alu-dock attach --cwd ~/work/project\n\nCtrl+D detaches. Use 'alu-dock stop INSTANCE_ID' only when disposal is intended.\n`;
}

function listHelp(): string {
  return `alu-dock list — scan known instances\n\nUsage:\n  alu-dock list\n\nShows a bounded human-readable catalog summary, including the short instance ID,\nname/project, lifecycle/execution state and whether persisted context can be\nreopened. Use the ID with open, attach, status, or stop.\n\nExamples:\n  alu-dock list\n  alu-dock status INSTANCE_ID\n\nThis is a read-only request. Typed automation should use DockClient/Protocol V2\nrather than parse terminal text.\n`;
}

function statusHelp(): string {
  return `alu-dock status — inspect one instance\n\nUsage:\n  alu-dock status INSTANCE_ID\n\nReads the current closed instance snapshot for a known ID. It does not attach,\nresume, retry, reopen, or mutate the instance.\n\nExample:\n  alu-dock status INSTANCE_ID\n`;
}

function stopHelp(): string {
  return `alu-dock stop — dispose one instance\n\nUsage:\n  alu-dock stop INSTANCE_ID\n\nExplicitly stops the Host-owned runtime and marks the catalog record stopped. It\nis not detach and can interrupt a run. No prompt, queue, Promise, interaction or\ntool effect is replayed.\n\nExample:\n  alu-dock stop INSTANCE_ID\n\nTo leave work running, attach and press Ctrl+D instead.\n`;
}

function helpHelp(): string {
  return `alu-dock help — explore the human CLI\n\nUsage:\n  alu-dock help\n  alu-dock help COMMAND\n  alu-dock help service SUBCOMMAND\n  alu-dock COMMAND --help\n\nHelp is local and read-only: it does not connect to the Host, query the catalog,\nstart systemd, generate an operation ID, or require a TTY.\n\nExamples:\n  alu-dock help open\n  alu-dock help service logs\n  alu-dock stop --help\n`;
}

function serviceHelp(rest: readonly string[]): string {
  if (rest.length === 0) {
    return `alu-dock service — manage the systemd --user Host\n\nUsage:\n  alu-dock service [status]\n  alu-dock service COMMAND [OPTIONS]\n\nCommands:\n  install     Install the generated user unit\n  start       Start the managed Host\n  stop        Stop the Host\n  restart     Restart the Host\n  status      Show systemd readiness and managed capabilities\n  logs        Read the user journal\n  uninstall   Remove only an Alu Dock-generated unit\n\nA service restart does not resume prompts, queues, interactions, tool effects or\nrun Promises. Inspect active work before stopping or restarting the Host.\n\nExplore:\n  alu-dock help service install\n  alu-dock service logs --help\n`;
  }
  if (rest.length !== 1 || !SERVICE_TOPICS.has(rest[0] as string)) {
    throw new Error(`Unknown service help topic: ${rest.join(" ")}`);
  }
  switch (rest[0]) {
    case "install":
      return `alu-dock service install — install the generated user unit\n\nUsage:\n  alu-dock service install [--now]\n\nOptions:\n  --now   Enable and start the unit after installation\n\nRefuses to overwrite a unit not generated by Alu Dock.\n`;
    case "start":
      return `alu-dock service start — start the managed Host\n\nUsage:\n  alu-dock service start\n\nStarts the installed systemd --user unit and waits for managed V2 readiness.\n`;
    case "stop":
      return `alu-dock service stop — stop the managed Host\n\nUsage:\n  alu-dock service stop\n\nStops the systemd --user Host. In-flight work is not replayed after Host loss.\nInspect 'alu-dock list' first when practical.\n`;
    case "restart":
      return `alu-dock service restart — replace the managed Host\n\nUsage:\n  alu-dock service restart\n\nRestarts the systemd --user unit and waits for readiness. Existing runs, queues,\ninteractions and side-effect Promises are not resumed or replayed.\n`;
    case "status":
      return `alu-dock service status — inspect managed readiness\n\nUsage:\n  alu-dock service status\n\nReads systemd state and verifies the expected MainPID, V2 handshake and managed\ncapabilities. It does not start or restart the service.\n`;
    case "logs":
      return `alu-dock service logs — read Host journal output\n\nUsage:\n  alu-dock service logs [--lines N] [--follow]\n\nOptions:\n  --lines N, -n N   Read 1–10000 lines (default: 200)\n  --follow, -f      Follow new journal entries\n\nExamples:\n  alu-dock service logs --lines 100\n  alu-dock service logs --follow\n`;
    case "uninstall":
      return `alu-dock service uninstall — remove the generated unit\n\nUsage:\n  alu-dock service uninstall\n\nRemoves only a unit carrying Alu Dock's generated marker. It does not delete the\ndurable catalog or Pi session files.\n`;
    default:
      throw new Error(`Unknown service help topic: ${String(rest[0])}`);
  }
}

function internalTopicHelp(topic: string): string {
  const humanAlternative: Record<string, string> = {
    serve: "Use 'alu-dock service' to manage the Host.",
    ping: "Use 'alu-dock service status' for human readiness checks.",
    create: "Use 'alu-dock new' to create and attach interactively.",
    reopen: "Use 'alu-dock open' to choose and reopen recoverable context.",
    events: "Use the interactive TUI or 'alu-dock status' for human inspection.",
    prompt: "Submit prompts through the attached interactive TUI.",
  };
  return `${topic} is an internal control command used by tests, release smoke, or\noperator diagnostics. It is intentionally omitted from the public human command\ntaxonomy and is not a model tool surface.\n\n${humanAlternative[topic] ?? "Use the public human workflow instead."}\nTyped automation should call DockClient/Protocol V2. See the repository's\ninternal control documentation.\n`;
}
