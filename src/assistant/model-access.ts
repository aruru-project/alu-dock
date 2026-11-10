import type { Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AssistantModelRef } from "../core/assistant.js";
import { ExtractionModelError, type ExtractionModel, type ModelTool } from "./extraction.js";
import type { ModelPrompt } from "./extraction-prompt.js";

/** Room for a reply listing many changes; a model with less uses its own limit. */
const REPLY_TOKENS = 16_000;

/**
 * The assistant service's own model calls. In the service the runtime takes Main's model
 * configuration and credentials from the model service (card #303), asking the Host like a Work does.
 */
export class MainModelAccess implements ExtractionModel {
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(private readonly create: () => Promise<ModelRuntime>) {}

  /**
   * The model's answer to `prompt`. With `tools` it may call them first: each round of calls is
   * answered and the model asked again; once `rounds` rounds were answered, further calls are told to
   * answer now, and a model that still calls gets its text taken as the answer.
   */
  async complete(ref: AssistantModelRef, prompt: ModelPrompt, signal: AbortSignal, tools?: { list: readonly ModelTool[]; rounds: number }): Promise<string> {
    const name = `${ref.provider}/${ref.id}`;
    let runtime: ModelRuntime;
    try {
      runtime = await (this.runtime ??= this.create().catch((error: unknown) => { this.runtime = undefined; throw error; }));
      // Models and logins changed on Main since the last call count from this one.
      await runtime.refresh({ allowNetwork: false, signal });
    } catch (error) {
      throw new ExtractionModelError(`没能从 Main 的模型服务取得模型设置（${error instanceof Error ? error.message : String(error)}）。稍后会自动再试。`);
    }
    const model = runtime.getModel(ref.provider, ref.id);
    if (!model) throw new ExtractionModelError(`整理记忆用的模型 ${name} 在 Main 上找不到了。请在助手设置里换一个模型。`);
    const declared: Tool[] | undefined = tools?.list.map(({ name: tool, description, parameters }) => ({ name: tool, description, parameters: parameters as Tool["parameters"] }));
    const messages: Message[] = [{ role: "user", content: prompt.prompt, timestamp: Date.now() }];
    for (let round = 0; ; round += 1) {
      let reply: Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
      try {
        reply = await runtime.completeSimple(model, { systemPrompt: prompt.system, messages, ...(declared ? { tools: declared } : {}) },
          { signal, maxTokens: Math.min(REPLY_TOKENS, model.maxTokens || REPLY_TOKENS) });
      } catch (error) {
        throw failed(name, error instanceof Error ? error.message : String(error));
      }
      if (reply.stopReason === "error" || reply.stopReason === "aborted") throw failed(name, reply.errorMessage ?? "原因不明");
      const text = reply.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const calls = reply.content.filter((block): block is ToolCall => block.type === "toolCall");
      if (!tools || calls.length === 0 || round > tools.rounds) return text;
      messages.push(reply);
      for (const call of calls) messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, ...answer(call, tools, round), timestamp: Date.now() });
    }
  }
}

/** One call answered: its tool's result, or why there is none. */
function answer(call: ToolCall, tools: { list: readonly ModelTool[]; rounds: number }, round: number): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
  if (round >= tools.rounds) return result(`已经查过 ${tools.rounds} 轮，不能再查了。现在就按约定的格式给出结果。`, true);
  const tool = tools.list.find((item) => item.name === call.name);
  if (!tool) return result(`没有叫 ${call.name} 的工具。`, true);
  if (call.argumentsError !== undefined) return result(`参数不是一个 JSON 对象：${call.argumentsError}`, true);
  return result(tool.run(call.arguments));
}

function failed(name: string, reason: string): ExtractionModelError {
  return new ExtractionModelError(`调用整理记忆用的模型 ${name} 没有成功（${reason}）。稍后会自动再试；一直不成功的话，看看 Main 上这个模型的登录和额度，或者在助手设置里换一个模型。`);
}
