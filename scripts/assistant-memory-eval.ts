#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

import { AssistantDocuments } from "../src/assistant/documents.js";
import { AssistantExtraction } from "../src/assistant/extraction.js";
import { AssistantMemories } from "../src/assistant/memories.js";
import { MainModelAccess } from "../src/assistant/model-access.js";
import { AssistantStore } from "../src/assistant/store.js";
import { AssistantTimeline } from "../src/assistant/timeline.js";
import { writeTransaction } from "../src/assistant/transaction.js";
import type { AssistantEntry, AssistantEpisode, AssistantMemory, AssistantModelRef } from "../src/core/assistant.js";
import { localSpan } from "../src/core/local-time.js";
import { configurePiNetwork } from "../src/pi/configure-pi-network.js";
import { MEMORY_CASES, type MemoryCase } from "./assistant-memory-cases.js";

/*
 * Runs the made-up conversations of assistant-memory-cases.ts through extraction and dreaming with a
 * real model and reports what was kept, memories and timeline, against what each case expects (card
 * #295). It is for tuning the prompts in src/assistant/extraction-prompt.ts.
 *
 * It calls the model for real, with this computer's Pi login, and that costs money: run it only when
 * the owner agreed to.
 *
 *   npm run build && node dist/scripts/assistant-memory-eval.js --model PROVIDER/MODEL [--case NAME] [--agent-dir DIR] [--history]
 *
 * --history also lists every change of every memory, to see which pass decided what.
 */

const CASE_TIMEOUT_MS = 10 * 60_000;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const agentDir = options.agentDir ?? getAgentDir();
  configurePiNetwork(SettingsManager.create(agentDir, agentDir, { projectTrusted: false }));
  const create = () => ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const cases = options.case === undefined ? MEMORY_CASES : MEMORY_CASES.filter((item) => item.name === options.case);
  if (cases.length === 0) throw new Error(`No case is named ${options.case}; the cases are ${MEMORY_CASES.map((item) => item.name).join(", ")}`);
  process.stdout.write(`Calling ${options.model.provider}/${options.model.id} for ${cases.length} case(s); this uses the real model.\n`);
  let failed = 0;
  for (const item of cases) if (!await runCase(item, options.model, create, options.history)) failed += 1;
  process.stdout.write(`\n${cases.length - failed} of ${cases.length} case(s) met what they expect.\n`);
  if (failed > 0) process.exitCode = 1;
}

async function runCase(item: MemoryCase, model: AssistantModelRef, create: () => Promise<ModelRuntime>, history: boolean): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "alu-memory-eval-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  const documents = new AssistantDocuments(root);
  await documents.initialize();
  if (item.notes !== undefined) await documents.set("notes", item.notes);
  const memories = new AssistantMemories(store.connection);
  const timeline = new AssistantTimeline(store.connection);
  const problems: string[] = [];
  const extraction = new AssistantExtraction(store.connection, memories, timeline, documents, new MainModelAccess(create),
    { idleMs: 0, busyChars: 1e9, chunkChars: 24_000, tickMs: 50, quietMs: 0, dreamChanges: 1, dreamIntervalMs: 1e15 },
    (message) => problems.push(message));
  try {
    for (const session of item.sessions) {
      store.record({ sessionId: session.id, cwd: root }, entriesOf(session), `${session.id}-${session.lines.length}`, {});
      const readThrough = session.alreadyRead ? session.lines.length : session.alreadyReadThrough;
      if (readThrough !== undefined) {
        store.connection.prepare(`UPDATE sessions SET extracted_through = (SELECT id FROM entries WHERE session_id = ?1 AND entry_id = ?2),
          waiting_chars = (SELECT coalesce(sum(length(search_text)), 0) FROM entries WHERE session_id = ?1 AND id > (SELECT id FROM entries WHERE session_id = ?1 AND entry_id = ?2))
          WHERE session_id = ?1`).run(session.id, `${session.id}-${readThrough}`);
      }
    }
    const bound = store.connection.prepare("SELECT at, at_ms FROM entries WHERE session_id = ? AND entry_id = ?");
    writeTransaction(store.connection, () => {
      for (const episode of item.episodes ?? []) {
        const from = bound.get(episode.session, `${episode.session}-${episode.from}`) as { at: string; at_ms: number };
        const to = bound.get(episode.session, `${episode.session}-${episode.to}`) as { at: string; at_ms: number };
        timeline.insert(episode.session, from, to, episode.text, "extraction");
      }
    });
    for (const memory of item.memories ?? []) {
      const [sessionId] = memory.source?.split(/-(?=\d+$)/u) ?? [];
      memories.add({ topic: memory.topic, text: memory.text, resident: memory.resident, ...(memory.source === undefined ? {} : { sources: [{ sessionId: sessionId!, entryId: memory.source }] }) }, memory.author);
    }
    extraction.setModel(model);
    extraction.start();
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    while (extraction.busy()) {
      if (Date.now() - started > CASE_TIMEOUT_MS) throw new Error("The model took more than ten minutes");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const status = extraction.status();
    const inUse = memories.list({ limit: 100 }).memories;
    const setAside = [...memories.list({ limit: 100, state: "retired" }).memories, ...memories.list({ limit: 100, state: "forgotten" }).memories];
    const lines = timeline.list({ limit: 100 }).episodes.slice().reverse();
    const checks = judge(item, inUse, lines);
    process.stdout.write(`\n== ${item.name}: ${item.about}\n`);
    const changes = (memory: AssistantMemory) => history
      ? memories.get(memory.id).history.slice().reverse().map((change) => `\n      ${change.author} ${change.action}${change.text === undefined ? "" : `: ${change.text}`}`).join("")
      : "";
    for (const memory of inUse.slice().reverse()) process.stdout.write(`  + ${describe(memory)}${changes(memory)}\n`);
    for (const memory of setAside) process.stdout.write(`  - ${describe(memory)}${memory.supersededBy === undefined ? "" : ` → #${memory.supersededBy}`}${changes(memory)}\n`);
    if (inUse.length + setAside.length === 0) process.stdout.write("  (nothing kept)\n");
    for (const line of lines) process.stdout.write(`  │ ${describeLine(line)}\n`);
    if (lines.length === 0) process.stdout.write("  │ (no timeline)\n");
    if (status.lastError !== undefined) process.stdout.write(`  ! ${status.lastError}\n`);
    for (const problem of problems) process.stdout.write(`  ! ${problem}\n`);
    for (const check of checks) process.stdout.write(`  ${check.ok ? "✔" : "✘"} ${check.label}\n`);
    return checks.every((check) => check.ok) && status.state !== "failed";
  } finally {
    await extraction.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Each line becomes an entry "<session>-<n>"; a line without a time is said 30 seconds after the one before. */
function entriesOf(session: MemoryCase["sessions"][number]): AssistantEntry[] {
  let at = Date.now();
  return session.lines.map(([kind, text, time], index) => {
    at = time === undefined ? at + 30_000 : localTime(time);
    return { entryId: `${session.id}-${index + 1}`, ...(index === 0 ? {} : { parentId: `${session.id}-${index}` }), at: new Date(at).toISOString(), kind, text };
  });
}

function localTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error(`${value} is not a time as YYYY-MM-DD HH:mm`);
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!).getTime();
}

function judge(item: MemoryCase, inUse: AssistantMemory[], lines: AssistantEpisode[]): Array<{ label: string; ok: boolean }> {
  const { include = [], resident = [], exclude = [], atMost = [], timeline = [], timelineExcludes = [], timelineAtMost } = item.expect;
  return [
    ...include.map((pattern) => ({ label: `keeps ${pattern}`, ok: inUse.some((memory) => pattern.test(memory.text)) })),
    ...resident.map((pattern) => ({ label: `loads ${pattern} every session`, ok: inUse.some((memory) => memory.resident && pattern.test(memory.text)) })),
    ...exclude.map((pattern) => ({ label: `leaves out ${pattern}`, ok: !inUse.some((memory) => pattern.test(memory.text)) })),
    ...atMost.map(([pattern, most]) => ({ label: `at most ${most} matching ${pattern}`, ok: inUse.filter((memory) => pattern.test(memory.text)).length <= most })),
    ...timeline.map((pattern) => ({ label: `timeline says ${pattern}`, ok: lines.some((line) => pattern.test(line.text)) })),
    ...timelineExcludes.map((pattern) => ({ label: `timeline leaves out ${pattern}`, ok: !lines.some((line) => pattern.test(line.text)) })),
    ...(timelineAtMost === undefined ? [] : [{ label: `at most ${timelineAtMost} timeline line(s)`, ok: lines.length <= timelineAtMost }]),
  ];
}

function describe(memory: AssistantMemory): string {
  const from = memory.sources.map((source) => source.entryId).join(", ");
  return `#${memory.id} [${memory.topic} · ${memory.resident ? "loaded every session" : "when searched"} · ${memory.author}] ${memory.text}${from ? ` (from ${from})` : ""}`;
}

function describeLine(line: AssistantEpisode): string {
  return `#${line.id} ${localSpan(new Date(line.fromAt), new Date(line.toAt))} ${line.text}`;
}

function parseArgs(args: string[]): { model: AssistantModelRef; case?: string; agentDir?: string; history: boolean } {
  let model: AssistantModelRef | undefined;
  let only: string | undefined;
  let agentDir: string | undefined;
  let history = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === "--history") { history = true; continue; }
    if (args[index] === "--model" && value) {
      const slash = value.indexOf("/");
      if (slash <= 0 || slash === value.length - 1) throw new Error("--model takes PROVIDER/MODEL");
      model = { provider: value.slice(0, slash), id: value.slice(slash + 1) };
    } else if (args[index] === "--case" && value) only = value;
    else if (args[index] === "--agent-dir" && value) agentDir = value;
    else throw new Error(`Unknown argument ${args[index]}; usage: --model PROVIDER/MODEL [--case NAME] [--agent-dir DIR] [--history]`);
    index += 1;
  }
  if (!model) throw new Error("--model PROVIDER/MODEL is required; this runs the real model");
  return { model, ...(only === undefined ? {} : { case: only }), ...(agentDir === undefined ? {} : { agentDir }), history };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
