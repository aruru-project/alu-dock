#!/usr/bin/env node

import assert from "node:assert/strict";
import { resolve } from "node:path";

import { DockClient } from "../src/control/dock-client.js";

interface SmokeArgs { socketPath: string; cwd: string; releaseId: string }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new DockClient({ socketPath: args.socketPath, timeoutMs: 30_000 });
  const ping = await client.ping();
  const instance = await client.create(args.cwd, `release-smoke-${args.releaseId.slice(-12)}`);
  let stopAttempted = false;
  let stopped = false;
  let forgetAttempted = false;
  try {
    const [catalog, resources, tools, settings, snapshot, tree] = await Promise.all([
      client.commands(instance.id),
      client.resources(instance.id),
      client.tools(instance.id),
      client.settings(instance.id),
      client.status(instance.id),
      client.tree(instance.id),
    ]);
    assert.ok(ping.capabilities.includes("session.tree.v1"), "managed Host must advertise session.tree.v1");
    assert.equal(settings.settings.length, 24, "settings projection must remain exhaustive");
    assert.equal(snapshot.lifecycle, "active");
    assert.match(tree.treeRevision, new RegExp(`^g${snapshot.runtimeGeneration}-[0-9a-f]{64}$`, "u"));
    assert.ok(tree.nodes.length <= tree.total);
    assert.equal(tree.truncated, tree.nodes.length < tree.total);
    const names = catalog.commands.map((command) => command.name);
    const checkedPairs: string[] = [];
    for (const [first, second] of [["chain", "chain-prompts"], ["run", "run-chain"]] as const) {
      if (names.includes(first) && names.includes(second)) {
        assert.ok(names.indexOf(first) < names.indexOf(second), `${first}/${second} must use canonical ordering`);
        checkedPairs.push(`${first}/${second}`);
      }
    }
    const projection = JSON.stringify({ catalog, resources, tools, settings });
    assert.doesNotMatch(projection, /data:[^,]*;base64,/iu);
    assert.doesNotMatch(projection, /"(?:handler|execute|component)"\s*:/u);
    stopAttempted = true;
    await client.stop(instance.id);
    stopped = true;
    forgetAttempted = true;
    await client.forget(instance.id);
    process.stdout.write(`${JSON.stringify({
      kind: "athena.release_smoke",
      releaseId: args.releaseId,
      pid: ping.pid,
      hostEpoch: ping.hostEpoch,
      instanceId: instance.id,
      commands: catalog.commands.length,
      resources: resources.resources.length,
      diagnostics: resources.diagnostics.length,
      tools: tools.tools.length,
      settings: settings.settings.length,
      treeNodes: tree.nodes.length,
      treeRevision: tree.treeRevision,
      checkedPairs,
      passed: true,
    })}\n`);
  } finally {
    if (!stopAttempted) {
      stopAttempted = true;
      stopped = await client.stop(instance.id).then(() => true, () => false);
    }
    if (stopped && !forgetAttempted) {
      forgetAttempted = true;
      await client.forget(instance.id).catch(() => {});
    }
  }
}

function parseArgs(args: string[]): SmokeArgs {
  let socketPath: string | undefined;
  let cwd: string | undefined;
  let releaseId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--socket") socketPath = requiredValue(args, ++index, value);
    else if (value === "--cwd") cwd = requiredValue(args, ++index, value);
    else if (value === "--release") releaseId = requiredValue(args, ++index, value);
    else throw new Error(`Unknown athena smoke argument: ${String(value)}`);
  }
  if (!socketPath || !cwd || !releaseId) throw new Error("athena smoke requires --socket, --cwd, and --release");
  return { socketPath: resolve(socketPath), cwd: resolve(cwd), releaseId };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ kind: "athena.release_smoke_failed", message })}\n`);
  process.exitCode = 1;
});
