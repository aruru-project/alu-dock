import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState } from "../src/control/machine-state.js";
import { MainMachineController } from "../src/control/machine-transport.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

// 2026-09-18: alu's valid history fitted with 3 bytes to spare, then Main added
// 48 bytes of hostId and rejected the whole response. Exercise the actual socket
// entrypoints; only the Agent is a static fixture, with no Pi/model/user files.
test("Main opens and pages near-limit conversation history without losing records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-response-budget-"));
  const runtime = new DelayedAgentWorkerConnection("budget-session");
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime })
  ));
  const controller = new MainMachineController({
    state: new MainMachineState(join(directory, "main")),
    mainHostEpoch: registry.hostEpoch,
    localSnapshots: () => registry.list(),
  });
  const host = new DockHost({ socketPath: join(directory, "dock.sock"), registry, remoteInstances: controller });
  const requestId = "r".repeat(36);
  const client = new DockClient({ socketPath: host.socketPath, requestId: () => requestId });
  context.after(async () => {
    client.closeActiveConnections();
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();
  const work = await client.create(directory);
  const instance = registry.get(work.id);
  const wireBytes = (result: unknown) => Buffer.byteLength(JSON.stringify({
    kind: "response", version: 2, requestId, hostEpoch: registry.hostEpoch, ok: true, result,
  }) + "\n");

  for (const mode of ["bootstrap", "history"] as const) {
    await context.test(mode, async () => {
      runtime.history = Array.from({ length: 100 }, (_, index) => ({
        recordId: `record-${index}`, entryId: `record-${index}`, kind: "custom", source: "extension",
        visibility: "metadata", content: [], metadata: { note: Array.from({ length: 20 }, () => "x".repeat(500)) },
      }));
      runtime.emit({ type: "conversation_checkpoint" });
      const unprojected = async () => {
        if (mode === "history") return instance.getHistoryPage(undefined, 200);
        const projection = await instance.getAttachProjection(undefined, 200, "conversation_bootstrap");
        return {
          instance: projection.instance,
          page: { ...projection.page, epochChanged: false, generationChanged: false },
          recentHistory: projection.recentHistory,
          historyRevision: projection.historyRevision,
          historyTruncated: projection.historyTruncated,
          pendingMessages: projection.pendingMessages,
        };
      };
      // Size the fixture, not the expected output: the published 1 MiB wire
      // contract and incident's 3-byte headroom are independent literals.
      const padding = 1_048_573 - wireBytes(await unprojected());
      assert.ok(padding > 0);
      const notes = (runtime.history[99]!.metadata as { note: string[] }).note;
      let remaining = padding;
      for (let index = 0; index < notes.length && remaining > 0; index += 1) {
        const added = Math.min(remaining, 7_000);
        notes[index] += "x".repeat(added);
        remaining -= added;
      }
      assert.equal(remaining, 0);
      runtime.emit({ type: "conversation_checkpoint" });
      assert.equal(wireBytes(await unprojected()), 1_048_573);

      const expected = structuredClone(runtime.history);
      const records = [];
      let beforeEntryId: string | undefined;
      if (mode === "bootstrap") {
        const result = await client.read(work.id, undefined, "conversation_bootstrap");
        assert.equal(result.instance.hostId, controller.mainHostId());
        assert.equal(result.historyTruncated, true);
        assert.ok(result.recentHistory.length > 0 && result.recentHistory.length < 100);
        records.push(...result.recentHistory);
        beforeEntryId = result.recentHistory[0]!.entryId;
      } else {
        const result = await client.history(work.id, undefined, 200);
        assert.equal(result.instance.hostId, controller.mainHostId());
        assert.equal(result.hasEarlier, true);
        assert.ok(result.entries.length > 0 && result.entries.length < 100);
        records.push(...result.entries);
        beforeEntryId = result.nextBeforeEntryId;
      }
      while (beforeEntryId) {
        const earlier = await client.history(work.id, beforeEntryId, 200);
        records.unshift(...earlier.entries);
        beforeEntryId = earlier.nextBeforeEntryId;
      }
      assert.deepEqual(JSON.parse(JSON.stringify(records)), expected, "every original record remains available across pages");
    });
  }
});

// #325 archived Host reproduction: a legal diagnostic disappeared while latest advanced;
// 1001 active records became 1000, and the same diagnostic disconnected live follow.
test("opted instance observation keeps all active records and consecutive large live diagnostics", async (context) => {
  const directory=await mkdtemp(join(tmpdir(),"alu-instance-records-"));
  const runtime=new DelayedAgentWorkerConnection("records-session");
  const registry=new DockRegistry(async ({id,creationOperationId,hostEpoch,cwd})=>new ManagedInstance({id,creationOperationId,hostEpoch,cwd,session:runtime}));
  const host=new DockHost({socketPath:join(directory,"dock.sock"),registry});
  const client=new DockClient({socketPath:host.socketPath});
  context.after(async()=>{client.closeActiveConnections();await host.stop();await rm(directory,{recursive:true,force:true});});
  await host.start();const work=await client.create(directory);
  const {parseConversationFrame}=await import("../src/control/protocol.js");
  const diagnostic=(messageId:string,error:string)=>parseConversationFrame({type:"message.completed",data:{messageId,role:"assistant",content:[],stopReason:"error",error}});
  const emit=(frame:ReturnType<typeof parseConversationFrame>)=>runtime.emit({type:"dock_conversation_frame",frame});
  const text="雪\\\"\n".repeat(280_000);
  const accepted=new Promise<void>(resolve=>{const unsubscribe=registry.get(work.id).subscribe(event=>{if(event.type==="message.delta"&&event.data.messageId==="distinct-1000"){unsubscribe();resolve();}});});
  emit(diagnostic("initial-large",text));
  for(let index=0;index<1001;index++)emit(parseConversationFrame({type:"message.delta",data:{messageId:`distinct-${index}`,block:"text",delta:"x"}}));
  await accepted;
  const source=await registry.get(work.id).getAttachProjection(undefined,200,"conversation_bootstrap");
  assert.equal(source.page.events.length,1002);
  const delivery={};
  const initial=await client.read(work.id,undefined,"conversation_bootstrap",delivery);
  context.diagnostic("complete bootstrap accepted");
  assert.deepEqual(initial.page.events,source.page.events);
  assert.equal(initial.page.truncated,source.page.truncated);
  assert.deepEqual(initial.page.latest,source.page.latest);
  const live:unknown[]=[];
  let first!:()=>void;const firstDelivered=new Promise<void>(resolve=>{first=resolve;});
  let complete!:()=>void;const finished=new Promise<void>(resolve=>{complete=resolve;});
  const follow=await client.follow(work.id,initial.page.latest,{deliveryContext:delivery,onEvent:event=>{live.push(event);if(live.length===1)first();if(live.length===3)complete();}});
  context.diagnostic("follow ready accepted");
  context.after(()=>follow.close());
  const errors=["a".repeat(5*1024*1024),"b".repeat(5*1024*1024),"small tail"];
  emit(diagnostic("live-0",errors[0]!));
  await Promise.race([firstDelivered,follow.done]);
  // Follow keeps framing/credit state correct across consecutive large records.
  emit(diagnostic("live-1",errors[1]!));emit(diagnostic("live-2",errors[2]!));
  await Promise.race([finished,follow.done.then(()=>{throw new Error("Follow ended before all events");})]);
  assert.deepEqual(live.map(item=>(item as {data:{error:string}}).data.error),errors);
  follow.close();await follow.done;
});
