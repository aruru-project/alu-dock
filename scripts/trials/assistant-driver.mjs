// Runs in the Main container (see scripts/trials/README.md): her owner talks to the personal
// assistant with a real model, and what she and the Works she hands things to did is printed for a
// person to read. STEPS picks what to run, in order; MODEL=provider/id and THINKING pick her model.
const { DockClient } = await import("/opt/alu/dist/src/control/dock-client.js");
const { existsSync, readFileSync, writeFileSync } = await import("node:fs");

const client = new DockClient({ socketPath: "/root/dock.sock", timeoutMs: 60_000, longMutationTimeoutMs: 180_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [provider, ...modelId] = (process.env.MODEL ?? "openai-sub/gpt-6-luna").split("/");
const PROJECT = "/root/project", PRINTED = "/root/trial-printed";
const clip = (text, max = 700) => text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字）`;
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

/** Main opens the resident assistant itself; this driver never creates a second one. */
async function alu() {
  let work;
  await waitFor("Main 自动打开助手", async () => {
    work = (await client.list()).find((item) => item.assistant === true && item.lifecycle === "active");
    return work !== undefined;
  }, 60_000);
  await client.setModel(work.id, provider, modelId.join("/"));
  await client.setThinking(work.id, process.env.THINKING ?? "low");
  console.log(`# 常驻助手 ${work.displayName}，模型 ${provider}/${modelId.join("/")}`);
  return work;
}

const entries = async (id) => {
  const file = (await client.status(id)).executor.sessionFile;
  return file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

const text = (content) => typeof content === "string" ? content : content.map((block) =>
  block.type === "text" ? block.text
    : block.type === "toolCall" ? `→ ${block.name}(${clip(JSON.stringify(block.arguments), 500)})`
      : block.type === "thinking" ? "" : `[${block.type}]`).filter(Boolean).join("\n");

function render(entry) {
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "user") return `【主人】${clip(text(message.content), 300)}`;
    if (message.role === "toolResult") return `    ← ${message.toolName}${message.isError ? "（出错）" : ""}：${clip(text(message.content), 400)}`;
    const problem = message.stopReason === "error" || message.stopReason === "aborted" ? `  〔${message.stopReason}：${message.errorMessage ?? ""}〕` : "";
    return `【阿露】${text(message.content)}${problem}`;
  }
  if (entry.type === "custom_message") return `  〔${entry.customType}${entry.display === false ? "，客户端不显示" : ""}〕${clip(text(entry.content), 900)}`;
  if (entry.type === "compaction") return `  〔交接记录，换进去前约 ${entry.tokensBefore} token〕\n${entry.summary}`;
  if (entry.type === "model_change") return `  〔模型 ${entry.provider}/${entry.modelId}〕`;
  if (entry.type === "session" || entry.type === "thinking_level_change" || entry.type === "custom") return undefined;
  return `  〔${entry.type}〕${clip(JSON.stringify(entry), 300)}`;
}

/** Prints what was added to her conversation since the last time, as her session file keeps it. */
async function transcript(id) {
  const all = await entries(id);
  const from = existsSync(PRINTED) ? Number(readFileSync(PRINTED, "utf8")) : 0;
  for (const entry of all.slice(from)) { const line = render(entry); if (line !== undefined) console.log(line); }
  writeFileSync(PRINTED, String(all.length));
}

async function idle(id, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  let quiet = 0;
  while (Date.now() < until) {
    const status = await client.status(id);
    if (status.execution === "failed") throw new Error("她这一轮失败了");
    quiet = status.execution === "idle" ? quiet + 1 : 0;
    if (quiet >= 3) return;
    await sleep(400);
  }
  throw new Error("她这一轮没有结束");
}

async function waitFor(label, check, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await sleep(1_000); }
  throw new Error(`等不到：${label}`);
}

/** Her owner says something; returns once she finished answering it. */
async function say(id, words) {
  const before = (await entries(id)).length, started = Date.now();
  await client.prompt(id, words);
  await idle(id);
  const added = (await entries(id)).slice(before).filter((entry) => entry.type === "message");
  const calls = added.flatMap((entry) => entry.message.role === "assistant" ? entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.name) : []);
  await transcript(id);
  console.log(`  （${seconds(started)}，${calls.length === 0 ? "没调工具" : `调了 ${calls.join("、")}`}）\n`);
  return calls;
}

const children = async (id) => (await client.list()).filter((work) => work.parentId === id && work.lifecycle === "active");
const count = async (id, match) => (await entries(id)).filter(match).length;
const fromWork = (entry) => entry.type === "custom_message" && entry.customType === "dock-work-message";
const herWords = (entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop";
const file = (path) => existsSync(path) ? clip(readFileSync(path, "utf8").trim(), 400) : "（没有这个文件）";

/** Waits for something to wake her on its own, and for the reply that follows. */
async function woken(id, label, match, had, timeoutMs) {
  const started = Date.now();
  await waitFor(label, async () => await count(id, match) > had, timeoutMs);
  // It may have come, and been answered, before this started waiting.
  await waitFor(`${label}后她的回话`, async () => { const all = await entries(id); return herWords(all.at(-1)) && all.findLastIndex(match) < all.length - 1; }, 120_000);
  await idle(id);
  await transcript(id);
  console.log(`  （等了 ${seconds(started)}）\n`);
}

const steps = {
  async chat(id) {
    await say(id, "你好呀，你是谁？现在几点了？");
  },
  async remember(id) {
    await say(id, "记一下：我喝咖啡不加糖，只喝手冲。");
    console.log(`  记忆库里：${(await client.assistantMemories()).memories.map((memory) => memory.text).join(" | ") || "（空）"}\n`);
  },
  async delegate(id) {
    const had = await count(id, fromWork);
    await say(id, `帮我在 ${PROJECT} 目录里跑一下 \`sleep 40 && date > done.txt\`，跑完告诉我 done.txt 里写了什么。`);
    console.log(`  她的子 Work：${(await children(id)).map((work) => `「${work.name}」${work.execution}`).join("、") || "（没有）"}\n`);
    await say(id, "在干嘛呢？");
    await woken(id, "子 Work 的结果", fromWork, had, 240_000);
    console.log(`  ${PROJECT}/done.txt：${file(`${PROJECT}/done.txt`)}\n`);
  },
  async question(id) {
    const had = await count(id, fromWork);
    if (process.env.ANSWER === undefined) {
      await say(id, `派个 Work 去 ${PROJECT} 写一个 README.md，随便写两行介绍。标题先别定：让它动手前先问你用什么标题，你再来问我。`);
      await woken(id, "子 Work 的提问", fromWork, had, 180_000);
    }
    const asked = await count(id, fromWork);
    await say(id, "标题就叫「阿露的试验场」。");
    await woken(id, "子 Work 的结果", fromWork, asked, 240_000).catch((error) => console.log(`  （${error.message}）`));
    console.log(`  ${PROJECT}/README.md：${file(`${PROJECT}/README.md`)}\n`);
  },
  async stop(id) {
    await say(id, `再派个 Work 在 ${PROJECT} 里跑 \`sleep 600\`，跑完告诉我。`);
    console.log(`  她的子 Work：${(await children(id)).map((work) => `「${work.name}」${work.execution}`).join("、") || "（没有）"}\n`);
    await sleep(8_000);
    await say(id, "停，不用跑了。");
    await sleep(3_000);
    console.log(`  之后她的子 Work：${(await children(id)).map((work) => `「${work.name}」${work.execution}`).join("、") || "（没有）"}\n`);
  },
  async remind(id) {
    const had = await count(id, (entry) => entry.type === "custom_message" && entry.customType === "assistant-reminder");
    await say(id, "20 秒后提醒我喝水。");
    await woken(id, "提醒到点", (entry) => entry.type === "custom_message" && entry.customType === "assistant-reminder", had, 90_000);
  },
  async forget(id) {
    await say(id, "把我喝咖啡的那条忘掉吧。");
    const forgotten = (await client.assistantMemories({ state: "forgotten" })).memories.map((memory) => memory.text);
    console.log(`  记忆库里已忘掉的：${forgotten.join(" | ") || "（没有）"}\n`);
    await say(id, "我喝咖啡加糖吗？");
  },
  /** Her model gets a small window, and she is given long things to read until a record is written. */
  async handoff(id) {
    await client.setModel(id, "openai-sub-small", "gpt-6-luna");
    await say(id, "答应我一件事：下周一我要续域名 example.dev，具体几点到时候我再告诉你，先别定提醒。");
    const source = readFileSync("/opt/alu/docs/agent_maps/runtime.md", "utf8");
    const records = () => count(id, (entry) => entry.type === "compaction");
    const had = await records();
    for (let part = 0; part < 10 && await records() === had; part += 1) {
      await say(id, `读一下这段文档，用一句话告诉我它讲什么：\n\n${source.slice(part * 9_000, (part + 1) * 9_000)}`);
    }
    await waitFor("交接记录换进去", async () => await records() > had, 180_000).catch((error) => console.log(`  （${error.message}）`));
    await say(id, "我们手上还有哪些没了结的事？");
    await client.setModel(id, provider, modelId.join("/"));
  },
  /** For a Host restart from outside: she hands off something long first. */
  async leave(id) {
    await say(id, `派个 Work 在 ${PROJECT} 里跑 \`sleep 900 && echo ok\`，跑完告诉我。`);
    console.log(`  她的子 Work：${(await children(id)).map((work) => `「${work.name}」${work.execution}`).join("、") || "（没有）"}\n`);
  },
  async back(id) {
    await say(id, "我回来了。刚才那个活怎么样了？");
  },
  /** A Work of the owner's own on another machine, and a second model for one reply. */
  async create(id) {
    await say(id, `替我在 Laptop 那台机器上开一个 Work，目录用 ${PROJECT}，名字叫「笔记本上的活」，先不用交代任务，我自己去跟它说。`);
    for (const work of await client.list()) if (work.parentId === undefined && !work.assistant) console.log(`  主人的 Work：「${work.name ?? work.displayName}」 ${work.lifecycle}/${work.execution} 机器 ${work.hostId ?? "Main"}`);
  },
  async terra(id) {
    await client.setModel(id, provider, "gpt-6.1-terra");
    await say(id, "换了个模型。一句话：你现在手上盯着哪些 Work？");
    await client.setModel(id, provider, modelId.join("/"));
  },
  async memories() {
    const settings = await client.assistantSettings();
    console.log(`  整理记忆用的模型：${JSON.stringify(settings.extractionModel ?? null)}；后台整理：${JSON.stringify((await client.assistantInfo()).extraction)}`);
    console.log(`  记忆：${(await client.assistantMemories()).memories.map((memory) => `[${memory.topic}，${memory.author}${memory.resident ? "，常驻" : ""}] ${memory.text}`).join("\n        ") || "（空）"}`);
    console.log(`  时间线：${(await client.assistantTimeline()).episodes.map((episode) => clip(episode.text, 200)).join("\n          ") || "（空）"}`);
    console.log(`  搜「手冲」：${(await client.assistantSearch("手冲")).hits.length} 条\n`);
  },
  async works(id) {
    for (const work of await client.list()) console.log(`  ${work.id.slice(0, 8)} 「${work.name ?? work.displayName}」 ${work.lifecycle}/${work.execution}${work.parentId === id ? "  她的子 Work" : ""}${work.assistant ? "  助手" : ""}`);
  },
  /** The whole conversation again, from its start. */
  async transcript(id) { writeFileSync(PRINTED, "0"); await transcript(id); },
  /** What a Work she handed something to was given and did: CHILD is part of its name. */
  async child(id) {
    const work = (await client.list()).find((item) => item.parentId === id && (item.name ?? "").includes(process.env.CHILD ?? ""));
    if (!work) { console.log("  （没有这个子 Work）"); return; }
    console.log(`  子 Work「${work.name}」 ${work.lifecycle}/${work.execution}`);
    for (const entry of await entries(work.id)) { const line = render(entry); if (line !== undefined) console.log(line.replace("【阿露】", "【子 Work】").replace("【主人】", "【交给它的】")); }
  },
};

try {
  const work = await alu();
  if ((await client.assistantSettings()).extractionModel == null) await client.setAssistantSettings({ extractionModel: { provider, id: modelId.join("/") } });
  for (const name of (process.env.STEPS ?? "chat,remember,delegate,question,stop,remind,forget").split(",")) {
    console.log(`\n===== ${name} =====`);
    try { await steps[name](work.id); }
    catch (error) { await transcript(work.id).catch(() => {}); console.log(`  !! ${name} 没走完：${error instanceof Error ? error.message : String(error)}`); }
  }
} finally { client.closeActiveConnections(); }
