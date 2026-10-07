import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

export interface ChatRequest {
  messages?: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

/** Only the model transport is fake: every reply is supplied explicitly by a test. */
export class PlanGoalProvider {
  readonly requests: HeldChatRequest[] = [];
  private readonly server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    this.requests.push(new HeldChatRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest, response));
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async request(index: number): Promise<HeldChatRequest> {
    await waitFor(() => this.requests.length > index, `Model request ${index + 1} did not arrive`);
    return this.requests[index]!;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class HeldChatRequest {
  constructor(readonly body: ChatRequest, private readonly response: ServerResponse) {}

  get closed(): boolean { return this.response.destroyed; }
  get toolNames(): string[] { return (this.body.tools ?? []).map((tool) => tool.function.name); }

  text(content: string): void {
    this.reply({ role: "assistant", content }, "stop");
  }

  tools(...calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): void {
    this.reply({ role: "assistant", tool_calls: calls.map((call, index) => ({
      index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })) }, "tool_calls");
  }

  private reply(delta: Record<string, unknown>, finishReason: string): void {
    assert.equal(this.closed, false, "The native run ended before the test supplied its model reply");
    this.response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [part, finish] of [[delta, null], [{}, finishReason]] as const) {
      this.response.write(`data: ${JSON.stringify({ id: "chatcmpl-plan-goal", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    this.response.end("data: [DONE]\n\n");
  }
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
