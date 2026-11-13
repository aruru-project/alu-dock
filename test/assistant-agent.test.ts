import assert from "node:assert/strict";
import test from "node:test";

import { Reminders, reminderTime, type Reminder } from "../src/assistant-agent/reminders.js";
import { renderStatus } from "../src/assistant-agent/status.js";
import { WakeBudget } from "../src/assistant-agent/wake.js";

// Incident this guards against (the Minecraft companion this design follows): its two lines kept
// waking each other with nobody else involved. Works may start twelve of her replies in a row.
test("other Works may start twelve of her replies in a row; her owner or a reminder starts the count again", () => {
  const budget = new WakeBudget();
  for (let reply = 1; reply <= 12; reply += 1) assert.equal(budget.admit("work"), true, `Reply ${reply} starts`);
  assert.equal(budget.admit("work"), false);
  assert.equal(budget.admit("owner"), true);
  assert.equal(budget.admit("work"), true);
  for (let reply = 2; reply <= 12; reply += 1) budget.admit("work");
  assert.equal(budget.admit("work"), false);
  assert.equal(budget.admit("reminder"), true);
  assert.equal(budget.admit("work"), true);
});

test("a reminder is handed over once when it comes due, and one that came due while she was not running says how late it is", async () => {
  const now = Date.parse("2026-11-13T10:00:00.000Z");
  const saved: Reminder[][] = [];
  const due: Array<{ text: string; lateMs: number }> = [];
  const reminders = new Reminders((items) => saved.push([...items]), (reminder, lateMs) => due.push({ text: reminder.text, lateMs }), () => now);
  reminders.restore([{ id: "r1", at: "2026-11-13T09:30:00.000Z", text: "错过的", createdAt: "2026-11-13T09:00:00.000Z" }]);
  assert.throws(() => reminders.set(new Date(now - 1), "已经过去"), /already passed/u);
  const later = reminders.set(new Date(now + 3_600_000), "一小时后");
  assert.deepEqual(reminders.list().map((item) => item.text), ["错过的", "一小时后"]);
  reminders.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(due, [{ text: "错过的", lateMs: 1_800_000 }]);
  assert.deepEqual(saved.at(-1)!.map((item) => item.text), ["一小时后"], "What is still waiting is saved with the conversation");
  assert.equal(reminders.cancel(`#${later.id}`)?.text, "一小时后");
  assert.deepEqual(reminders.list(), []);
  reminders.stop();
});

test("a reminder's time is read as minutes from now, a local time, or an ISO time", () => {
  const now = Date.parse("2026-11-13T10:00:00.000Z");
  assert.equal(reminderTime({ inMinutes: 90 }, now).toISOString(), "2026-11-13T11:30:00.000Z");
  assert.equal(reminderTime({ at: "2026-11-14T09:00:00.000Z" }, now).toISOString(), "2026-11-14T09:00:00.000Z");
  const local = reminderTime({ at: "2026-11-14 09:05" }, now);
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()], [2026, 10, 14, 9, 5]);
  assert.ok(Number.isNaN(reminderTime({ at: "明天早上" }, now).getTime()));
});

test("her status lists the Works she handed things to and only counts her owner's other Works", () => {
  const at = (minutesAgo: number) => new Date(2026, 10, 13, 16, 5 - minutesAgo).toISOString();
  const base = { cwd: "/w", lifecycle: "active" as const, compacting: false, runtimeGeneration: 1 };
  const text = renderStatus({
    now: new Date(2026, 10, 13, 16, 5),
    wokenBy: "主人的消息",
    selfId: "alu",
    works: [
      { ...base, id: "alu", name: "阿露", execution: "running", executionChangedAt: at(0) },
      { ...base, id: "c1", parentId: "alu", name: "修历史刷新", execution: "running", executionChangedAt: at(12), runStartedAt: at(12) },
      { ...base, id: "c2", parentId: "alu", name: "整理部署", execution: "idle", executionChangedAt: at(3) },
      { ...base, id: "w1", name: "主人的项目", execution: "idle", executionChangedAt: at(50) },
      { ...base, id: "w2", name: "她替主人开的", execution: "idle", executionChangedAt: at(90) },
      { ...base, id: "x1", parentId: "w1", name: "别人的子 Work", execution: "running", executionChangedAt: at(1) },
    ],
    notes: new Map([["c1", { owes: true, lastSaid: "先问一下：要不要改测试？" }], ["c2", { lastSaid: "部署说明整理好了。" }]]),
    followed: new Set(["w2"]),
    reminders: [{ id: "r9", at: new Date(2026, 10, 14, 9, 0).toISOString(), text: "提醒主人开会\n带上材料", createdAt: at(0) }],
  });
  assert.equal(text, [
    "[现状 · 2026-11-13 16:05 周五] 这是 Dock 自动附上的，不是主人说的话。",
    "叫醒你的：主人的消息",
    "你派出去或在跟着的 Work：",
    "- 子 Work「修历史刷新」在干活，已 12 分钟；还欠你结果；最近说：先问一下：要不要改测试？",
    "- 子 Work「整理部署」空闲，3 分钟前停下；最近说：部署说明整理好了。",
    "- Work「她替主人开的」空闲，1 小时 30 分钟前停下",
    "另有 1 个别的 Work，要看用 dock_list。",
    "没到点的提醒：",
    "- 2026-11-14 09:00 提醒主人开会（#r9）",
  ].join("\n"));
});
