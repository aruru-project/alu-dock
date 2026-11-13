import type { AssistantPreview } from "../core/assistant.js";
import type { AssistantCallPort } from "./recorder.js";

/**
 * The editable persona and notes, with memory supplied by Main. Nothing about the assistant's
 * name, voice or working style is appended behind the owner's back. The shipped working guidance
 * is only an initial part of persona.md, editable through the same page as the rest of the prompt.
 */
export class AssistantOpening {
  private loaded: AssistantPreview | undefined;
  private stale = true;
  private told = false;

  constructor(private readonly port: AssistantCallPort, private readonly notify: (message: string) => void) {}

  refresh(): void { this.stale = true; }

  async text(): Promise<{ text: string; changed: boolean }> {
    let changed = false;
    let reason = "原因不明";
    if (this.stale) {
      try {
        this.loaded = await this.port.call({ op: "load" });
        this.stale = false;
        changed = true;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.loaded) return { text: this.loaded.text, changed };
    changed = !this.told;
    if (!this.told) {
      this.told = true;
      this.notify(`这一轮没能从 Main 载入助手的人设和设定（${reason}）。助手这一轮不知道你写的设定；Main 恢复后会在之后的回复中重新载入。`);
    }
    // This is an operational failure notice, not a fallback persona or a replacement for an empty file.
    return { text: `助手的人设、手写设定和记忆暂时未能载入（${reason}）。如果这会影响回答，就照实说明，不要编造缺失的信息。`, changed };
  }
}
