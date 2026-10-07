import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MAX_TEXT_CHARS } from "../core/instance-dto.js";

const STATE_TYPE = "alu-dock-plan-goal-state";
const MESSAGE_TYPE = "alu-dock-plan-goal";
const MAX_CONTENT = 64_000;
const DEFAULT_ROUNDS = 10;
const DEFAULT_MINUTES = 30;
const PLAN_TOOLS = new Set(["plan_update", "plan_question", "goal_update"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);

type GoalStatus = "active" | "paused" | "blocked" | "complete" | "cancelled" | "budget_limited";
interface Plan {
  id: string;
  revision: number;
  content: string;
  approvedRevision?: number;
}
interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  maxRounds: number;
  rounds: number;
  expiresAt: number;
  summary: string;
  evidence: string[];
}
interface State {
  version: 1;
  mode: "plan" | "execute";
  plan?: Plan;
  goal?: Goal;
  addedPlanTools?: string[];
}

/** The adapter's existing abort must disarm before Pi can skip pre-settle. No Host state. */
export class PlanGoalControl {
  private pauseCurrent: ((reason: string) => void) | undefined;
  private promptCurrent: ((text: string, mayStart: () => boolean) => Promise<boolean>) | undefined;

  attach(pause: (reason: string) => void): () => void {
    this.pauseCurrent = pause;
    return () => { if (this.pauseCurrent === pause) this.pauseCurrent = undefined; };
  }

  pause(reason: string): void { this.pauseCurrent?.(reason); }
  bindPrompt(prompt: (text: string, mayStart: () => boolean) => Promise<boolean>): void { this.promptCurrent = prompt; }
  async start(text: string, mayStart: () => boolean): Promise<boolean> {
    if (!this.promptCurrent) throw new Error("规划与目标尚未连接到当前会话，请重新打开工作后再试。");
    return this.promptCurrent(text, mayStart);
  }
}

export function planGoalExtension(control: PlanGoalControl): ExtensionFactory {
  return (pi) => {
    let state: State = { version: 1, mode: "execute" };
    let context: ExtensionContext | undefined;
    let armed = false;
    let pendingRound: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let detach = (): void => {};
    let noProgressRounds = 0;
    let progressSinceBoundary = false;
    let lastAssistantText = "";
    let intentVersion = 0;

    const stopTimer = (): void => { if (timer) clearTimeout(timer); timer = undefined; };
    const disarm = (): void => { armed = false; pendingRound = undefined; stopTimer(); };
    const activatePlanTools = (): void => {
      // Pi's configured registry already respects explicit tools/excludeTools.
      // Its default loadout omits search/listing, which planning needs to discover facts.
      const reads = pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin" && READ_TOOLS.has(tool.name)).map((tool) => tool.name);
      const active = pi.getActiveTools();
      state.addedPlanTools = [...new Set([...(state.addedPlanTools ?? []), ...reads.filter((name) => !active.includes(name))])];
      pi.setActiveTools([...new Set([...active, ...reads])]);
    };
    const setMode = (mode: State["mode"]): void => {
      state.mode = mode;
      if (mode === "plan") activatePlanTools();
      else if (state.addedPlanTools) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => !state.addedPlanTools!.includes(name)));
        delete state.addedPlanTools;
      }
    };
    const render = (ctx: ExtensionContext): void => {
      const plan = state.plan;
      ctx.ui.setStatus("Plan", state.mode === "plan" ? `规划中 · 第${plan?.revision ?? 0}版`
        : plan?.approvedRevision === plan?.revision && plan ? `已批准 · 第${plan.revision}版` : undefined);
      ctx.ui.setWidget("alu-dock-plan", plan && state.mode === "plan"
        ? ["规划：先调查、讨论，再按计划执行", ...plan.content.split("\n").slice(0, 24), "/plan show 查看完整计划 · /plan edit 编辑 · /plan apply 执行"]
        : undefined);
      const goal = state.goal;
      ctx.ui.setStatus("Goal", goal ? `${goalLabel(goal.status)} · ${goal.rounds}/${goal.maxRounds}轮` : undefined);
      ctx.ui.setWidget("alu-dock-goal", goal ? [
        `目标：${goal.objective}`,
        `${goalLabel(goal.status)} · ${goal.rounds}/${goal.maxRounds}轮 · 截止 ${new Date(goal.expiresAt).toISOString()}`,
        ...(goal.summary ? [goal.summary] : []),
        ...goal.evidence.map((item) => `依据：${item}`),
        goal.status === "active" ? "/goal pause 暂停 · /goal cancel 取消" : "/goal status 查看 · /goal resume 继续",
      ] : undefined);
    };
    const save = (ctx = context): void => {
      pi.appendEntry(STATE_TYPE, structuredClone(state));
      if (ctx) render(ctx);
    };
    const pause = (reason: string): void => {
      intentVersion += 1;
      disarm();
      if (state.goal?.status !== "active") return;
      state.goal.status = "paused";
      state.goal.summary = reason;
      save();
    };
    const exhaust = (reason: string, ctx: ExtensionContext, abort: boolean): void => {
      disarm();
      if (!state.goal || state.goal.status !== "active") return;
      state.goal.status = "budget_limited";
      state.goal.summary = reason;
      save(ctx);
      ctx.ui.notify(`${reason}。要继续，请明确设置一个新的目标和预算。`, "info");
      if (abort) ctx.abort();
    };
    const startTimer = (ctx: ExtensionContext): void => {
      stopTimer();
      const goal = state.goal;
      if (!goal || !armed) return;
      const goalId = goal.id;
      timer = setTimeout(() => {
        if (armed && state.goal?.id === goalId) exhaust("目标的时间预算已用尽", ctx, true);
      }, Math.max(0, goal.expiresAt - Date.now()));
      timer.unref();
    };
    const startUserRun = (text: string, ctx: ExtensionContext, goalId?: string): void => {
      const intent = intentVersion;
      // User-triggered starts need Pi's full prompt preparation (project context,
      // before_agent_start and tool loadout). A raw custom-message start skips it.
      const mayStart = (): boolean => intent === intentVersion && (!goalId || armed && state.goal?.id === goalId
        && state.goal.status === "active" && Date.now() < state.goal.expiresAt);
      void control.start(text, mayStart).then((started) => {
        if (started || !goalId || !mayStart() || state.goal?.id !== goalId) return;
        disarm(); state.goal.status = "blocked";
        state.goal.summary = "输入已由其他扩展接管，目标没有开始。请确认该扩展的结果后再继续。";
        save(ctx);
      }).catch((error: unknown) => {
        if (intent !== intentVersion) return;
        if (goalId && state.goal?.id === goalId && state.goal.status !== "active") return;
        if (goalId && state.goal?.id === goalId && state.goal.status === "active") {
          disarm(); state.goal.status = "blocked";
          state.goal.summary = "目标未能开始。请处理模型或会话错误后用 /goal resume 继续。";
          save(ctx);
        }
        ctx.ui.notify(`无法开始当前请求：${error instanceof Error ? error.message : String(error)}。请处理问题后重试。`, "error");
      });
    };
    const goalPrompt = (goal: Goal): string => [
      "[Dock Goal continuation: runtime-generated context, not new human authorization]",
      `Goal: ${goal.objective}`,
      `Goal-scheduled round: ${goal.rounds + 1}/${goal.maxRounds}. Deadline: ${new Date(goal.expiresAt).toISOString()}.`,
      "Continue the agreed task within its existing scope and tool permissions. Do not expand scope, spend more, commit or deploy unless already authorized.",
      "Use goal_update to record meaningful progress. When the target is met, report complete with concrete evidence; when a decision, permission or unavailable dependency prevents progress, report blocked and explain the next action.",
      "A progress checklist or your assertion alone is not an independently verified result. Describe checks honestly. Wait for asynchronous work using its existing wait/result tools rather than repeatedly restating that you are waiting.",
      "New user input takes priority. This generated Goal context records the existing task and never overrides a newer instruction or grants fresh authorization.",
      ...(goal.summary ? [`Latest progress: ${goal.summary}`] : []),
    ].join("\n");
    const beginRound = (ctx: ExtensionContext): void => {
      const goal = state.goal;
      if (!goal) return;
      armed = true;
      pendingRound = goal.id;
      progressSinceBoundary = false;
      noProgressRounds = 0;
      goal.status = "active";
      save(ctx);
      startTimer(ctx);
      startUserRun(`[Dock command: the user explicitly started or resumed this Goal]\n${goalPrompt(goal)}`, ctx, goal.id);
    };
    const restore = (ctx: ExtensionContext): void => {
      intentVersion += 1;
      disarm();
      context = ctx;
      state = { version: 1, mode: "execute" };
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === STATE_TYPE && isState(entry.data)) state = structuredClone(entry.data);
      }
      if (state.mode === "plan") activatePlanTools();
      if (state.goal?.status === "active") {
        state.goal.status = "paused";
        state.goal.summary = "会话已恢复，目标保留。用 /goal resume 明确继续。";
        save(ctx);
      } else render(ctx);
    };
    const notifyState = (ctx: ExtensionContext): void => {
      render(ctx);
      const goal = state.goal;
      ctx.ui.notify(goal ? `${goalLabel(goal.status)}：${goal.objective}\n${goal.rounds}/${goal.maxRounds}轮，截止 ${new Date(goal.expiresAt).toISOString()}\n${goal.summary}`
        : "还没有目标。用 /goal start --rounds 10 --minutes 30 目标内容 开始。", "info");
    };

    pi.on("session_start", (_event, ctx) => { detach(); restore(ctx); detach = control.attach(pause); });
    pi.on("session_tree", (_event, ctx) => restore(ctx));
    pi.on("session_shutdown", () => { intentVersion += 1; disarm(); detach(); });
    // Ordinary input retains Pi's own steer/Queue semantics. It never arms a
    // paused goal, but a supplement need not make an active goal require resume.
    pi.on("input", (event) => {
      if (event.source !== "extension") { intentVersion += 1; pendingRound = undefined; }
      return { action: "continue" };
    });
    pi.on("agent_start", (_event, ctx) => {
      context = ctx;
      const goal = state.goal;
      if (armed && goal?.status === "active" && pendingRound === goal.id) {
        pendingRound = undefined;
        goal.rounds += 1;
        save(ctx);
      }
    });
    pi.on("tool_result", (event) => {
      if (!event.isError && !PLAN_TOOLS.has(event.toolName)) progressSinceBoundary = true;
    });
    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant") return;
      const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
      if (text && text !== lastAssistantText) progressSinceBoundary = true;
      lastAssistantText = text;
    });
    pi.on("session_compact_failed", (event, ctx) => {
      if (!armed) return;
      disarm();
      if (state.goal) {
        state.goal.status = event.aborted ? "paused" : "blocked";
        state.goal.summary = event.aborted ? "上下文整理已中止。可查看结果后继续目标。" : "上下文整理失败。请处理错误后再继续目标。";
        save(ctx);
      }
    });
    pi.on("agent_before_settle", (event, ctx) => {
      context = ctx;
      const goal = state.goal;
      if (!armed || !goal || goal.status !== "active") return;
      if (event.outcome !== "completed") {
        disarm();
        goal.status = event.outcome === "aborted" ? "paused" : "blocked";
        goal.summary = event.outcome === "aborted" ? "当前活动已中止。可用 /goal resume 继续。" : "模型请求失败。请处理错误后用 /goal resume 继续。";
        save(ctx);
        return;
      }
      if (Date.now() >= goal.expiresAt) { exhaust("目标的时间预算已用尽", ctx, false); return; }
      if (goal.rounds >= goal.maxRounds) { exhaust("目标的推进轮数已用尽", ctx, false); return; }
      // Pi gets first chance to deliver already queued input. Never compete with
      // another extension's explicit continuation or discard its boundary drafts.
      if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0 || event.continue) return;
      noProgressRounds = progressSinceBoundary ? 0 : noProgressRounds + 1;
      progressSinceBoundary = false;
      if (noProgressRounds >= 3) {
        disarm();
        goal.status = "blocked";
        goal.summary = "连续几轮只有重复回复，也没有工具结果或新的进展，已停下来。请补充所需信息后继续。";
        save(ctx);
        return;
      }
      pendingRound = goal.id;
      return { entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE,
        content: goalPrompt(goal), display: true, details: { kind: "goal_continuation", goalId: goal.id } }], continue: true };
    });
    pi.on("agent_settled", (_event, ctx) => {
      // This notification cannot restart work. It also closes unforeseen early
      // exits where a different extension declined our boundary continuation.
      disarm();
      if (state.goal?.status === "active") {
        state.goal.status = "paused";
        state.goal.summary = "当前活动已结束。用 /goal resume 继续目标。";
        save(ctx);
      } else render(ctx);
    });
    pi.on("context", (event) => {
      const instruction = state.mode === "plan" ? [
        "[Dock Plan mode] Investigate first. Do not implement, send external messages, deploy, or delegate implementation.",
        "Use the available read-only tools; shell execution and tools without an explicit read-only declaration are blocked while planning.",
        "Resolve facts from the project yourself. Ask only questions that affect scope, direction or a consequential tradeoff with plan_question.",
        "Keep an actionable plan using plan_update: goal, facts, decisions, scope/non-goals, implementation and verification, and unresolved questions.",
        "Only the user can approve execution with /plan apply. You cannot approve your own plan.",
        state.plan?.content ? `Current plan revision ${state.plan.revision}:\n${state.plan.content}` : "No plan has been saved yet.",
      ].join("\n") : state.goal?.status === "active" && armed
        ? goalPrompt({ ...state.goal, rounds: Math.max(0, state.goal.rounds - 1) })
        : state.goal ? `[Dock Goal state: ${state.goal.status}]\nPrevious objective: ${state.goal.objective}\nAutomatic execution is disarmed. Answer the latest user request; do not restart the old objective from historical continuation messages. Only an explicit /goal start or /goal resume can arm it again.` : undefined;
      if (!instruction) return;
      return { messages: [...event.messages, { role: "custom", customType: "alu-dock-plan-goal-context", content: instruction, display: false, timestamp: Date.now() }] };
    });
    pi.on("tool_call", (event) => {
      if (state.mode !== "plan") return;
      const tool = pi.getAllTools().find((item) => item.name === event.toolName);
      if (PLAN_TOOLS.has(event.toolName) && tool?.sourceInfo.path === "<inline:alu-dock-plan-goal>"
        || READ_TOOLS.has(event.toolName) && tool?.sourceInfo.source === "builtin"
        || tool?.annotations?.readOnlyHint === true) return;
      return { block: true, reason: "当前是规划阶段，此工具没有明确的只读声明。请使用读工具调查，保存计划后由用户用 /plan apply 开始执行。" };
    });

    pi.registerTool({
      name: "plan_update", label: "更新计划", description: "Save or revise the current implementation plan in Plan mode. This never approves execution. Include facts, scope, decisions, implementation, verification, and unresolved questions.",
      parameters: { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: MAX_CONTENT } }, required: ["content"], additionalProperties: false },
      execute: async (_id: string, params: { content: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        if (state.mode !== "plan") return result("先用 /plan on 进入规划，再更新计划。", true);
        if (!validText(params.content)) return result("计划为空或太长，请提供完整且简洁的计划。", true);
        updatePlan(params.content); save(ctx);
        return result(`计划已更新为第${state.plan!.revision}版，等待用户决定是否执行。`);
      },
    } as never);
    pi.registerTool({
      name: "plan_question", label: "确认规划取舍", description: "Ask the user one material planning question. Investigate project facts yourself first. A missing/cancelled answer is not approval. Options are optional; otherwise accept free text.",
      parameters: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 2000 }, options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200 } } }, required: ["question"], additionalProperties: false },
      execute: async (_id: string, params: { question: string; options?: string[] }, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        if (!ctx.hasUI) return result("当前入口无法回答交互问题。请在回复中列出问题并等待用户。", true);
        const answer = params.options ? await ctx.ui.select(params.question, params.options, { signal }) : await ctx.ui.input(params.question, undefined, { signal });
        return result(answer === undefined ? "用户没有回答。请保留这个未决问题，不要假定选择或授权。" : `用户回答：${answer}`);
      },
    } as never);
    pi.registerTool({
      name: "goal_update", label: "记录目标进展", description: "Record meaningful progress, a blocker needing user action, or delivery of the active Goal. Complete requires concrete evidence; this is your report, not independent human acceptance. Cannot change objective, authorization, budget or resume paused work.",
      parameters: { type: "object", properties: { status: { type: "string", enum: ["progress", "blocked", "complete"] }, summary: { type: "string", minLength: 1, maxLength: 8000 }, evidence: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } } }, required: ["status", "summary"], additionalProperties: false },
      execute: async (_id: string, params: { status: "progress" | "blocked" | "complete"; summary: string; evidence?: string[] }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        const goal = state.goal;
        if (!goal || !armed || goal.status !== "active") return result("当前没有正在推进的目标。只有用户能开始或恢复目标。", true);
        if (params.status === "complete" && !params.evidence?.some((item) => item.trim())) return result("请附上具体完成依据：已运行的检查、产物或逐项核对结果。不要把未运行的检查写成通过。", true);
        progressSinceBoundary ||= goal.summary !== params.summary;
        goal.summary = params.summary;
        goal.evidence = params.evidence ?? [];
        if (params.status !== "progress") { goal.status = params.status; disarm(); }
        save(ctx);
        return result(params.status === "complete" ? "已记录交付及其依据，自动推进已结束。此记录不是用户验收。" : params.status === "blocked" ? "已记录阻塞，自动推进已停止。说明用户需要采取的下一步。" : "已记录进展。继续在原目标和预算内工作。");
      },
    } as never);

    function updatePlan(content: string): void {
      state.plan = { id: state.plan?.id ?? randomUUID(), revision: (state.plan?.revision ?? 0) + 1, content };
    }
    pi.registerCommand("plan", {
      description: "规划、编辑计划，再由你决定是否执行",
      getArgumentCompletions: (prefix) => ["on", "show", "edit", "apply", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        context = ctx;
        const [action = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "on") {
          pause("进入规划，当前目标已暂停。计划确认后可继续。");
          setMode("plan"); save(ctx);
          const intent = intentVersion;
          if (!ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
          if (intent !== intentVersion) return;
          if (rest.length) startUserRun(`[Dock command: user-requested planning]\n用户请求规划：${rest.join(" ")}\n先调查，必要时提问，并保存可执行的计划。`, ctx);
          else ctx.ui.notify("已进入规划。可以开始调查和讨论，用 /plan edit 编辑，用 /plan apply 按计划执行。", "info");
          return;
        }
        if (action === "off") { intentVersion += 1; setMode("execute"); save(ctx); ctx.ui.notify("已退出规划。当前目标不会因此自动恢复。", "info"); return; }
        if (action === "show") {
          render(ctx);
          if (state.plan && state.plan.content.length >= MAX_TEXT_CHARS && ctx.hasUI) await ctx.ui.editor("查看完整计划（此窗口不保存修改）", state.plan.content);
          else ctx.ui.notify(state.plan?.content || "还没有计划。用 /plan on 开始规划。", "info");
          return;
        }
        if (action === "edit") {
          if (!ctx.hasUI) { ctx.ui.notify("此入口无法编辑计划，请从支持编辑对话框的入口打开 /plan edit。", "warning"); return; }
          const revision = state.plan?.revision;
          const content = await ctx.ui.editor("编辑计划", state.plan?.content ?? "");
          if (content === undefined) return;
          if (revision !== state.plan?.revision) { ctx.ui.notify("计划刚刚有了更新。请重新打开 /plan edit，避免覆盖新内容。", "warning"); return; }
          if (!validText(content)) { ctx.ui.notify("计划为空或太长。请用 /plan edit 写下完整且简洁的计划。", "warning"); return; }
          const wasExecuting = state.mode === "execute";
          pause("计划已修改，目标已暂停。确认新计划后可继续。");
          setMode("plan"); updatePlan(content); save(ctx);
          if (wasExecuting && !ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
          return;
        }
        if (action === "apply") {
          const plan = state.plan;
          if (!plan?.content) { ctx.ui.notify("还没有可执行的计划。请先用 /plan on 讨论并保存计划。", "warning"); return; }
          const revision = plan.revision;
          const approvalIntent = intentVersion;
          if (!ctx.hasUI) { ctx.ui.notify("此入口无法确认计划。请从支持对话框的入口打开 /plan apply。", "warning"); return; }
          const reviewText = `第${revision}版\n\n${plan.content}`;
          const longPlan = reviewText.length > MAX_TEXT_CHARS;
          if (longPlan) {
            const reviewed = await ctx.ui.editor("审阅完整计划（保存后确认执行）", plan.content);
            if (reviewed === undefined) return;
            if (state.plan?.id !== plan.id || state.plan.revision !== revision) { ctx.ui.notify("审阅期间计划更新了。请重新运行 /plan apply。", "warning"); return; }
            if (reviewed !== plan.content) {
              if (!validText(reviewed)) { ctx.ui.notify("计划为空或太长。请用 /plan edit 调整后再执行。", "warning"); return; }
              const wasExecuting = state.mode === "execute";
              pause("计划已修改，目标已暂停。确认新计划后可继续。");
              setMode("plan"); updatePlan(reviewed); save(ctx);
              if (wasExecuting && !ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
              ctx.ui.notify("已保存你修改的计划。用 /plan apply 确认新版本后执行。", "info"); return;
            }
          }
          const accepted = await ctx.ui.confirm("按计划执行", longPlan ? `已完整展示第${revision}版计划。按刚才审阅的全部内容执行？` : reviewText);
          if (!accepted) return;
          if (approvalIntent !== intentVersion || state.plan?.id !== plan.id || state.plan.revision !== revision) { ctx.ui.notify("计划或当前请求在确认期间更新了。请用 /plan apply 查看并确认新版本。", "warning"); return; }
          pause("计划已确认，执行当前计划。目标仍保持暂停。");
          const handoffIntent = intentVersion;
          // Keep the Plan gate while stopping the old planning response. Its
          // already-generated tool calls must not inherit the new approval.
          if (!ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
          if (handoffIntent !== intentVersion) return;
          if (state.plan?.id !== plan.id || state.plan.revision !== revision) { ctx.ui.notify("计划在交接期间更新了。请用 /plan apply 查看并确认新版本。", "warning"); return; }
          state.plan.approvedRevision = revision; setMode("execute"); save(ctx);
          startUserRun(`[Dock command: user-approved plan revision ${revision}]\n用户已批准以下第${revision}版计划，开始在该范围内执行。普通实现细节可自行调整；改变目标、授权或重要取舍时再问用户。\n\n${plan.content}`, ctx);
          return;
        }
        ctx.ui.notify("用 /plan on、show、edit、apply 或 off 操作计划。", "warning");
      },
    });
    pi.registerCommand("goal", {
      description: "在明确目标和预算内自动推进，随时暂停或继续",
      getArgumentCompletions: (prefix) => ["start", "status", "pause", "resume", "cancel"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        context = ctx;
        const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const action = match?.[1] ?? "status";
        if (action === "status") { notifyState(ctx); return; }
        if (action === "pause" || action === "cancel") {
          intentVersion += 1;
          const goal = state.goal;
          const wasActive = armed;
          disarm();
          if (!goal) { notifyState(ctx); return; }
          if (goal.status !== "complete" && goal.status !== "cancelled") {
            goal.status = action === "pause" ? "paused" : "cancelled";
            goal.summary = action === "pause" ? "已由你暂停。聊天不会自动恢复目标。" : "已由你取消，会话和已有结果保留。";
            save(ctx);
          }
          if (wasActive) ctx.abort();
          notifyState(ctx); return;
        }
        if (action === "resume") {
          const goal = state.goal;
          if (!goal || goal.status === "complete" || goal.status === "cancelled") { ctx.ui.notify("没有可继续的目标。用 /goal start 设置目标和预算。", "info"); return; }
          if (armed) { notifyState(ctx); return; }
          if (goal.rounds >= goal.maxRounds || Date.now() >= goal.expiresAt) { goal.status = "budget_limited"; save(ctx); ctx.ui.notify("原预算已用尽。请用 /goal start 明确设置新的目标和预算。", "warning"); return; }
          if (!ctx.isIdle()) { ctx.ui.notify("当前回复仍在进行。结束后用 /goal resume 继续，或先中止当前回复。", "info"); return; }
          intentVersion += 1; beginRound(ctx); return;
        }
        if (action === "start") {
          const options = parseGoalStart(match?.[2] ?? "");
          if (!options) { ctx.ui.notify("用 /goal start --rounds 10 --minutes 30 目标内容 开始。轮数须为1至1000的整数，分钟须大于0且不超过1440。", "warning"); return; }
          pause("已开始新的目标，先结束之前的自动工作。");
          const intent = intentVersion;
          if (!ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
          if (intent !== intentVersion) return;
          state.goal = { id: randomUUID(), objective: options.objective, status: "active", maxRounds: options.rounds, rounds: 0,
            expiresAt: Date.now() + options.minutes * 60_000, summary: "", evidence: [] };
          beginRound(ctx); return;
        }
        ctx.ui.notify("用 /goal start、status、pause、resume 或 cancel 操作目标。", "warning");
      },
    });
  };
}

function goalLabel(status: GoalStatus): string {
  return { active: "推进中", paused: "已暂停", blocked: "受阻", complete: "已完成", cancelled: "已取消", budget_limited: "预算用尽" }[status];
}
function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CONTENT; }
function result(text: string, error = false): { content: Array<{ type: "text"; text: string }>; details: { error: boolean } } {
  if (error) throw new Error(text);
  return { content: [{ type: "text", text }], details: { error } };
}
function parseGoalStart(text: string): { objective: string; rounds: number; minutes: number } | undefined {
  let rounds = DEFAULT_ROUNDS, minutes = DEFAULT_MINUTES;
  let remaining = text.trim();
  while (remaining.startsWith("--")) {
    const option = remaining.match(/^--(rounds|minutes)\s+(\S+)\s+([\s\S]+)$/);
    if (!option) return;
    const value = Number(option[2]);
    if (option[1] === "rounds") rounds = value; else minutes = value;
    remaining = option[3]!.trim();
  }
  if (!validText(remaining) || !Number.isInteger(rounds) || rounds < 1 || rounds > 1000 || !Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) return;
  return { objective: remaining, rounds, minutes };
}
function isState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const s = value as State;
  if (s.version !== 1 || !["plan", "execute"].includes(s.mode)) return false;
  if (s.addedPlanTools && (!Array.isArray(s.addedPlanTools) || !s.addedPlanTools.every((name) => READ_TOOLS.has(name)))) return false;
  if (s.plan && (!validText(s.plan.id) || !validText(s.plan.content) || !Number.isInteger(s.plan.revision) || s.plan.revision < 1)) return false;
  const g = s.goal;
  return !g || validText(g.id) && validText(g.objective) && ["active", "paused", "blocked", "complete", "cancelled", "budget_limited"].includes(g.status)
    && Number.isInteger(g.maxRounds) && g.maxRounds >= 1 && g.maxRounds <= 1000 && Number.isInteger(g.rounds) && g.rounds >= 0 && g.rounds <= g.maxRounds
    && Number.isFinite(g.expiresAt) && typeof g.summary === "string" && Array.isArray(g.evidence) && g.evidence.every((item) => typeof item === "string");
}
