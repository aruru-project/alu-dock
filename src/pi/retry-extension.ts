import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETRY_TRIGGER = "alu-dock-retry";

/** A manual retry enters Pi's normal Session lifecycle, without a new user prompt. */
export function retryExtension(pi: ExtensionAPI): void {
  pi.on("context", (event) => ({
    messages: event.messages.filter((message) => !(message.role === "custom" && message.customType === RETRY_TRIGGER)),
  }));

  pi.registerCommand("retry", {
    description: "重试上一条失败的模型请求",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("当前请求尚未结束，请结束后再重试。", "warning");
        return;
      }
      const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message");
      if (last?.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "error") {
        ctx.ui.notify("当前没有可重试的失败请求。", "warning");
        return;
      }
      // Retain a hidden command marker in Pi's journal, but remove it from model
      // context above. Pi already omits failed assistant responses at its API boundary.
      pi.sendMessage({ customType: RETRY_TRIGGER, content: "", display: false }, { triggerTurn: true });
      // Keep command attribution until Pi's retry/compaction/settlement has finished.
      await ctx.waitForIdle();
    },
  });
}
