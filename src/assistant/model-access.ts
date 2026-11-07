import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AssistantModelRef } from "../core/assistant.js";
import { ExtractionModelError, type ExtractionModel } from "./extraction.js";
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

  async complete(ref: AssistantModelRef, prompt: ModelPrompt, signal: AbortSignal): Promise<string> {
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
    let reply: Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
    try {
      reply = await runtime.completeSimple(model, {
        systemPrompt: prompt.system,
        messages: [{ role: "user", content: prompt.prompt, timestamp: Date.now() }],
      }, { signal, maxTokens: Math.min(REPLY_TOKENS, model.maxTokens || REPLY_TOKENS) });
    } catch (error) {
      throw failed(name, error instanceof Error ? error.message : String(error));
    }
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw failed(name, reply.errorMessage ?? "原因不明");
    return reply.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
}

function failed(name: string, reason: string): ExtractionModelError {
  return new ExtractionModelError(`调用整理记忆用的模型 ${name} 没有成功（${reason}）。稍后会自动再试；一直不成功的话，看看 Main 上这个模型的登录和额度，或者在助手设置里换一个模型。`);
}
