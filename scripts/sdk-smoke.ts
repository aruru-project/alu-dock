#!/usr/bin/env node

import { resolve } from "node:path";

import { createPiInstance } from "../src/pi/create-pi-instance.js";

interface SmokeOptions {
  cwd: string;
  prompt: string;
  abortAfterMs?: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const instance = await createPiInstance({
    cwd: options.cwd,
    name: "alu-dock-sdk-smoke",
  });
  const unsubscribe = instance.subscribe((event) => {
    process.stdout.write(`${JSON.stringify({ kind: "event", ...event })}\n`);
  });

  let abortTimer: NodeJS.Timeout | undefined;
  try {
    process.stdout.write(`${JSON.stringify({ kind: "snapshot", value: instance.snapshot() })}\n`);
    const receipt = await instance.submit(options.prompt);
    process.stdout.write(`${JSON.stringify({ kind: "receipt", value: receipt })}\n`);

    if (options.abortAfterMs !== undefined) {
      abortTimer = setTimeout(() => {
        void instance.stop().catch((error: unknown) => {
          process.stderr.write(`stop failed: ${errorMessage(error)}\n`);
        });
      }, options.abortAfterMs);
    }

    await instance.waitForIdle();
    const settled = instance.snapshot();
    process.stdout.write(`${JSON.stringify({ kind: "settled", value: settled })}\n`);
    if (settled.lastRun === "failed") {
      throw new Error(`Pi run failed: ${settled.lastError ?? "unknown error"}`);
    }
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    await instance.stop();
    unsubscribe();
    process.stdout.write(`${JSON.stringify({ kind: "final", value: instance.snapshot() })}\n`);
  }
}

function parseArgs(args: string[]): SmokeOptions {
  let cwd = process.cwd();
  let prompt = "Reply with exactly ALU_DOCK_SMOKE_OK and do not use tools.";
  let abortAfterMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cwd") {
      cwd = requiredValue(args, ++index, arg);
    } else if (arg === "--prompt") {
      prompt = requiredValue(args, ++index, arg);
    } else if (arg === "--abort-after-ms") {
      const parsed = Number(requiredValue(args, ++index, arg));
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--abort-after-ms must be a non-negative number");
      }
      abortAfterMs = parsed;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run smoke:sdk -- [--cwd PATH] [--prompt TEXT] [--abort-after-ms N]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { cwd: resolve(cwd), prompt, abortAfterMs };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`SDK smoke failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
