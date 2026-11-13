import type { AssistantPreview } from "../core/assistant.js";
import type { AssistantCallPort } from "./recorder.js";

/**
 * What she works by here, after everything Main loads for her (persona, the owner's notes, her
 * memories and recent timeline). Written in the owner's language, like the text it follows.
 */
const WORKING_HERE = [
  "## 你在 Alu Dock 里",
  "",
  "你是主人在 Alu Dock 里的个人助手，这段对话就是你和主人说话的地方。",
  "",
  "- 你写下的字，主人在他的 Dock 客户端里直接看到。",
  "- 主人发来的图片你能直接看；其他附件你只看得到文件名。",
  "- 你自己不能读写文件、跑命令或上网。需要这样动手的事，照实告诉主人你现在做不了，请他另开一个 Work 去做，不要假装做过。",
].join("\n");

/**
 * Her opening: what Main loads for her, then how she works here. Asked for before her first reply,
 * so a Work opens even while Main is away; that reply then goes without her persona, says so, and
 * the owner is told once. Each later reply asks again until Main answers. `refresh` has the next
 * reply load it anew; until Main answers she keeps the one she has.
 */
export class AssistantOpening {
  private loaded: AssistantPreview | undefined;
  private stale = true;
  private told = false;

  constructor(private readonly port: AssistantCallPort, private readonly notify: (message: string) => void) {}

  refresh(): void { this.stale = true; }

  /** The opening to lead with, and whether it differs from the one the last call gave. */
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
    if (this.loaded) return { text: `${this.loaded.text}\n\n${WORKING_HERE}`, changed };
    changed = !this.told;
    if (!this.told) {
      this.told = true;
      this.notify(`这一轮没能从 Main 载入助手的人设和设定（${reason}）。她这一轮不知道你写给她的设定；Main 恢复后，之后的回合会自动载入。`);
    }
    return {
      text: `你是主人的个人助手，但你的人设、主人的手写设定和你的记忆刚才没能从 Main 载入（${reason}）。如果这会影响回答，就照实说，不要编造它们。\n\n${WORKING_HERE}`,
      changed,
    };
  }
}
