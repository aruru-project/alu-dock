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
  "machine",
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
  if (topic === "machine") return machineHelp(rest);
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
  return `Alu Dock — managed Pi development terminal for SSH\n\nUsage:\n  aludock\n  aludock COMMAND [OPTIONS]\n  aludock help [COMMAND]\n\nStart here:\n  aludock                 Open the Dock Hub\n  aludock -c              Continue recent work here, or create it\n  aludock new             Start separate Pi work\n  aludock attach TARGET   Open known running work in this terminal\n\nHuman commands:\n  continue  Continue recent work in this directory (-c, --continue)\n  open      Find matching work, or resume it by TARGET\n  new       Start separate work and a new Pi session\n  attach    Open known running work\n  list      Show work that is current or saved in History\n  status    Show one work item in detail\n  stop      End running work and remove it from the Dock\n  forget    Remove one ended work item from Dock History\n  prune     Remove ended work from Dock History\n  service   Manage the background Alu Dock service\n  help      Explore command help\n\nThe Alu Dock service must be running. If it is stopped, use\n'aludock service start'. New work starts where you ran aludock and can use\na different directory. Ctrl+D leaves Work for the shell while the work keeps\nrunning.\n\nExplore:\n  aludock help open\n  aludock help service\n  aludock COMMAND --help\n`;
}

function machineHelp(rest: readonly string[]): string {
  if (rest.length > 0 && (rest.length !== 1 || rest[0] !== "join-file")) throw new Error("machine help accepts only join-file");
  return `aludock machine join-file — prepare one SubHost enrollment\n\nUsage:\n  aludock machine join-file --out PATH [--state PATH] [--machine-name NAME]\n\nThe private file expires after ten minutes and works once. When starting the\nSubHost, enter Main's address and machine port separately. The same action is\navailable from Main's Machines menu.\n`;
}

function continueHelp(): string {
  return `aludock -c — continue recent work in the current directory\n\nUsage:\n  aludock -c\n  aludock --continue\n  aludock continue\n\nOpens the most recently updated work for this directory. Running work continues\nwhere it is; interrupted work resumes from its saved Pi session. If there is no\nmatching work, Alu Dock starts new work here.\n\nStart the Alu Dock service first with 'aludock service start'.\n`;
}

function openHelp(): string {
  return `aludock open — smart project entry\n\nUsage:\n  aludock open [TARGET] [--cwd PATH] [--name NAME] [--new]\n\nWithout TARGET, finds project work or starts new work. TARGET is an exact work\nname. For unnamed or duplicate work, run 'aludock' and choose it\nby conversation, project, and recent activity in the Hub.\n\nOptions:\n  --cwd PATH   Project directory (default: current directory)\n  --name NAME  Name newly started work\n  --new        Start separate work instead of reusing a match\n\nExamples:\n  aludock open --cwd ~/work/project\n  aludock open review\n  aludock open --new --name review\n\nIf the Alu Dock service is stopped, use 'aludock service start'.\n`;
}

function newHelp(): string {
  return `aludock new — start separate Pi work\n\nUsage:\n  aludock new [--cwd PATH] [--name NAME]\n\nStarts separate work with a new Pi session, even when this project already has\nrunning work, then opens it in this terminal.\n\nOptions:\n  --cwd PATH   Project directory (default: current directory)\n  --name NAME  Name the new work and Pi session\n\nExamples:\n  aludock new\n  aludock new --cwd ~/work/project --name experiment\n\nCtrl+D leaves Work and returns to the shell while the new work keeps running.\n`;
}

function attachHelp(): string {
  return `aludock attach — open running work in this terminal\n\nUsage:\n  aludock attach TARGET\n\nTARGET is an exact work name and must identify work that is already running.\nFor unnamed or duplicate work, choose it in the Hub. For interrupted work, use\n'aludock open TARGET' or choose Resume in the Hub.\n\nExample:\n  aludock attach review\n\nAny current run keeps going. Ctrl+D leaves Work and returns to the shell;\n'aludock stop TARGET' ends the work.\n`;
}

function listHelp(): string {
  return `aludock list — show Dock work\n\nUsage:\n  aludock list [--all]\n\nShows running, finishing, interrupted, and resumable work. Ended work stays\nhidden unless you use --all. The list includes each work name, project, status,\nand next useful action.\n\nOptions:\n  --all   Include ended work from Dock History\n\nExamples:\n  aludock list\n  aludock list --all\n  aludock status TARGET\n`;
}

function statusHelp(): string {
  return `aludock status — show one work item\n\nUsage:\n  aludock status TARGET\n\nTARGET is an exact work name. The result shows where the work is, what it is\ndoing, and how to continue it. For unnamed or duplicate work, choose it in the\nHub.\n\nExample:\n  aludock status review\n`;
}

function stopHelp(): string {
  return `aludock stop — end running work\n\nUsage:\n  aludock stop TARGET\n\nEnds the selected work and removes it from the Dock. Any current response and\nwaiting messages end with it.\n\nExample:\n  aludock stop review\n\nTo leave the work running, open it and press Ctrl+D instead.\n`;
}

function forgetHelp(): string {
  return `aludock forget — remove one item from Dock History\n\nUsage:\n  aludock forget TARGET\n\nRemoves ended or interrupted work from Dock History. Any saved Pi session and\nproject files remain where they are. Running or finishing work must be stopped\nfirst.\n\nExample:\n  aludock forget review\n`;
}

function pruneHelp(): string {
  return `aludock prune — clear ended work from Dock History\n\nUsage:\n  aludock prune --stopped\n\nRemoves one batch of ended work from Dock History. Interrupted work stays\navailable to resume, and saved Pi sessions remain where they are. If more ended\nwork remains, run the command again.\n\nExample:\n  aludock prune --stopped\n`;
}

function helpHelp(): string {
  return `aludock help — explore the human CLI\n\nUsage:\n  aludock help\n  aludock help COMMAND\n  aludock help service SUBCOMMAND\n  aludock COMMAND --help\n\nHelp is available in any terminal, even while the Alu Dock service is stopped.\n\nExamples:\n  aludock help open\n  aludock help service logs\n  aludock stop --help\n`;
}

function serviceHelp(rest: readonly string[]): string {
  if (rest.length === 0) {
    return `aludock service — manage the background Alu Dock service\n\nUsage:\n  aludock service [status]\n  aludock service COMMAND [OPTIONS]\n\nCommands:\n  install     Install the service for this user\n  start       Start Alu Dock\n  stop        Stop Alu Dock\n  restart     Restart Alu Dock\n  status      Show whether Alu Dock is ready\n  logs        Show service logs\n  uninstall   Remove the Alu Dock service setup\n\nInstall or update the local package from the current working tree with:\n\n  npm run install:local\n\nFinish or stop active work before updating. The installer will ask you to use an\nexplicit replacement option if work is still active. Saved Pi sessions and\nproject files remain available after service commands.\n\nExplore:\n  aludock help service install\n  aludock service logs --help\n`;
  }
  if (rest.length !== 1 || !SERVICE_TOPICS.has(rest[0] as string)) {
    throw new Error(`Unknown service help topic: ${rest.join(" ")}`);
  }
  switch (rest[0]) {
    case "install":
      return `aludock service install — install Alu Dock for this user\n\nUsage:\n  aludock service install [--now] [--json]\n\nOptions:\n  --now    Start Alu Dock after installation\n  --json   Print the machine-readable result for scripts\n\nIf another service already uses this setup, Alu Dock leaves it in place and\nasks you to review it.\n`;
    case "start":
      return `aludock service start — start Alu Dock\n\nUsage:\n  aludock service start [--json]\n\nStarts the installed service and waits until Alu Dock is ready to open work.\n`;
    case "stop":
      return `aludock service stop — stop Alu Dock\n\nUsage:\n  aludock service stop [--json]\n\nStops the background service. Current work may be interrupted. Run\n'aludock list' first and finish or stop important work.\n`;
    case "restart":
      return `aludock service restart — restart Alu Dock\n\nUsage:\n  aludock service restart [--json]\n\nRestarts the background service and waits until it is ready. Current responses\nand waiting messages may be interrupted, so finish or stop important work first.\n`;
    case "status":
      return `aludock service status — check Alu Dock\n\nUsage:\n  aludock service status [--json]\n\nShows a short human result by default. Use --json only when a script needs the\nmachine-readable service record. It checks whether Alu Dock is installed,\nrunning, and ready. If it is stopped,\nrun 'aludock service start'. For startup problems, use 'aludock service logs'.\n`;
    case "logs":
      return `aludock service logs — show Alu Dock service logs\n\nUsage:\n  aludock service logs [--lines N] [--follow]\n\nOptions:\n  --lines N, -n N   Read 1–10000 lines (default: 200)\n  --follow, -f      Follow new journal entries\n\nExamples:\n  aludock service logs --lines 100\n  aludock service logs --follow\n`;
    case "uninstall":
      return `aludock service uninstall — remove the Alu Dock service setup\n\nUsage:\n  aludock service uninstall [--json]\n\nRemoves the service setup created by Alu Dock. Dock History and saved Pi\nsessions remain available for a later installation.\n`;
    default:
      throw new Error(`Unknown service help topic: ${String(rest[0])}`);
  }
}

function internalTopicHelp(topic: string): string {
  if (topic === "serve") return `aludock serve — Host startup composition\n\nUsage:\n  aludock --socket PATH serve --dev [--state PATH]\n  aludock --socket PATH serve --dev --main --state PATH [--machine-port PORT] [--machine-name NAME]\n  aludock serve --dev --subhost --state PATH --main-address ADDRESS --machine-port PORT --machine-name NAME [--join-file PATH]\n\nMain is the default and owns every client entry point. Its SubHost listener is\noff unless a port is enabled in Settings or supplied explicitly. SubHost has one\nencrypted upstream and no client socket. Saved role settings apply when no role\nflag is supplied.\n`;
  const humanAlternative: Record<string, string> = {
    serve: "Use 'aludock service' to manage the Host.",
    ping: "Use 'aludock service status' for human readiness checks.",
    create: "Use 'aludock new' to create and attach interactively.",
    reopen: "Use 'aludock open' to choose and reopen recoverable context.",
    events: "Use the interactive TUI or 'aludock status' for human inspection.",
    prompt: "Submit prompts through the attached interactive TUI.",
  };
  return `${topic} supports tests and operator diagnostics.\n\n${humanAlternative[topic] ?? "Use the public human workflow instead."}\n`;
}
