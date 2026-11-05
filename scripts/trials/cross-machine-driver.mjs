// Runs in the Main container (cross-machine-docker.sh run): a Work on the SubHost replies and calls a
// tool with a model whose key only Main has. MODEL picks one ("openai/gpt-5-nano"); otherwise the first
// small OpenAI model Main offers.
const { DockClient, ControlClientError } = await import("/opt/alu/dist/src/control/dock-client.js");
const client = new DockClient({ socketPath: "/root/dock.sock", timeoutMs: 60_000, longMutationTimeoutMs: 180_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = async (label, run) => {
  const started = Date.now();
  try { const detail = await run(); console.log(`PASS ${label} (${((Date.now() - started) / 1000).toFixed(1)}s): ${detail}`); }
  catch (error) { console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`); }
};
const finish = async (id) => {
  for (let i = 0; i < 360; i++) {
    const { execution } = await client.status(id);
    if (execution === "idle") return;
    if (execution === "failed") throw new Error("the turn failed");
    await sleep(500);
  }
  throw new Error("the turn did not finish");
};
const reply = async (id) => {
  const text = JSON.stringify(await client.history(id));
  const errors = [...text.matchAll(/"errorMessage":"([^"]{0,300})/g)].map((match) => match[1]);
  if (errors.length) throw new Error(errors.at(-1));
  return [...text.matchAll(/"text":"([^"]{0,80})"/g)].map((match) => match[1]).at(-1);
};
try {
  let laptop;
  for (let i = 0; i < 40 && !laptop; i++) { laptop = (await client.machines()).machines.find((machine) => machine.name === "Laptop"); if (!laptop) await sleep(500); }
  if (!laptop) throw new Error("the SubHost did not appear on Main");
  // A trust challenge is answered with the same operation ID that raised it.
  const operationId = `trial-create-${Date.now()}`;
  let work;
  try { work = await client.create("/root/project", "On the laptop", operationId, undefined, laptop.hostId); }
  catch (error) {
    if (!(error instanceof ControlClientError) || error.code !== "project_trust_required") throw error;
    work = await client.create("/root/project", "On the laptop", operationId, { challengeId: error.details.challengeId, decision: "trust_once" }, laptop.hostId);
  }
  const offered = (await client.models(work.id)).models.map((model) => `${model.provider}/${model.id}`);
  console.log(`Models the SubHost Work sees from Main: ${offered.length}`);
  const model = process.env.MODEL ?? ["gpt-5-nano", "gpt-4.1-nano", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"].map((id) => `openai/${id}`).find((ref) => offered.includes(ref));
  if (!model) throw new Error("no model to use; set MODEL=provider/id");
  const [provider, id] = model.split("/");
  await client.setModel(work.id, provider, id);
  console.log(`Model: ${model}`);
  await step("the SubHost Work replies with Main's credential", async () => {
    await client.prompt(work.id, "Reply with only the word PONG.");
    await finish(work.id);
    return `reply "${await reply(work.id)}"`;
  });
  await step("the SubHost Work calls a tool", async () => {
    await client.prompt(work.id, "Use the write tool to create the file ok.txt in the current directory containing exactly OK. Then reply with only the word DONE.");
    await finish(work.id);
    return `reply "${await reply(work.id)}"`;
  });
  await client.stop(work.id).catch(() => {});
} finally { client.closeActiveConnections(); }
