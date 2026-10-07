import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "alu-dock-plan-goal-state";
const MESSAGE_TYPE = "alu-dock-plan-goal";
const MAX_CONTENT = 64_000;
const DEFAULT_ROUNDS = 10;
const OWN_TOOLS = new Set(["plan_submit", "plan_question", "goal_update"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const PLAN_CHOICES = ["按此执行", "执行并自动推进到完成", "我来改", "继续讨论"];

type GoalStatus = "active" | "paused" | "blocked" | "budget_limited";
interface Plan { id: string; revision: number; content: string }
interface Goal { id: string; objective: string; status: GoalStatus; maxRounds: number; rounds: number; summary: string; evidence: string[] }
interface State { mode: "plan" | "execute"; plan?: Plan; goal?: Goal; tools?: string[] }
interface StateChange { version: 2; mode?: State["mode"]; plan?: Plan | null; goal?: Partial<Goal> | null; tools?: string[] | null }

/** Pi's extension sendUserMessage is fire-and-forget: pre-start errors/handled
 * input have no settled event, and abort during preparation does not cancel it.
 * This small port reports that result and invalidates an unstarted request. */
export interface PlanGoalStart {
  prompt?: (text: string, mayStart: () => boolean) => Promise<boolean>;
  cancelPending?: () => void;
}

export function planGoalExtension(start: PlanGoalStart): ExtensionFactory {
  return (pi) => {
    let state: State = { mode: "execute" };
    let saved: State = structuredClone(state);
    let context: ExtensionContext | undefined;
    let armed = false;
    let pendingRound: string | undefined;
    let runningGoalId: string | undefined;
    let requestVersion = 0;

    const readOnly = (name: string): boolean => {
      const tool = pi.getAllTools().find((item) => item.name === name);
      return READ_TOOLS.has(name) && tool?.sourceInfo.source === "builtin" || tool?.annotations?.readOnlyHint === true;
    };
    const syncTools = (): void => {
      const active = pi.getActiveTools().filter((name) => !OWN_TOOLS.has(name));
      if (state.mode === "plan") {
        state.tools ??= active;
        pi.setActiveTools([...new Set([...active.filter(readOnly), ...pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin" && READ_TOOLS.has(tool.name)).map((tool) => tool.name), "plan_submit", "plan_question"])]);
      } else {
        const normal = state.tools ?? active;
        delete state.tools;
        pi.setActiveTools([...normal, ...(armed && state.goal?.status === "active" ? ["goal_update"] : [])]);
      }
    };
    const render = (ctx: ExtensionContext): void => {
      ctx.ui.setStatus("Plan", state.mode === "plan" ? "规划中 · /plan 退出" : undefined);
      ctx.ui.setWidget("alu-dock-plan", state.mode === "plan" && state.plan
        ? ["当前计划", ...state.plan.content.split("\n").slice(0, 24)] : undefined);
      const goal = state.goal;
      ctx.ui.setStatus("Goal", goal ? `${goalLabel(goal.status)} · ${goal.rounds}/${goal.maxRounds}轮 · /goal 管理` : undefined);
      ctx.ui.setWidget("alu-dock-goal", goal?.status === "active" ? [`目标：${goal.objective}`, ...(goal.summary ? [goal.summary] : [])] : undefined);
    };
    const save = (ctx = context): void => {
      const change: StateChange = { version: 2 };
      if (state.mode !== saved.mode) change.mode = state.mode;
      if (JSON.stringify(state.plan) !== JSON.stringify(saved.plan)) change.plan = state.plan ?? null;
      if (JSON.stringify(state.tools) !== JSON.stringify(saved.tools)) change.tools = state.tools ?? null;
      if (!state.goal && saved.goal) change.goal = null;
      else if (state.goal) {
        const goal = state.goal;
        const previous = saved.goal?.id === goal.id ? saved.goal : undefined;
        const changed = Object.fromEntries(Object.entries(goal).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous?.[key as keyof Goal])));
        if (Object.keys(changed).length) change.goal = changed;
      }
      if (Object.keys(change).length > 1) pi.appendEntry(STATE_TYPE, change);
      saved = structuredClone(state);
      if (ctx) render(ctx);
    };
    const disarm = (): void => { armed = false; pendingRound = undefined; runningGoalId = undefined; requestVersion += 1; };
    const pause = (reason: string): void => {
      disarm();
      if (state.goal?.status === "active") { state.goal.status = "paused"; context?.ui.notify(reason, "info"); }
      syncTools(); save();
    };
    const announce = (text: string): void => pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, { triggerTurn: false });
    const finish = (cancelled: boolean, ctx: ExtensionContext): void => {
      const goal = state.goal;
      if (!goal) return;
      announce([cancelled ? "目标已结束" : "目标已完成", goal.objective, goal.summary, ...goal.evidence.map((item) => `依据：${item}`)].filter(Boolean).join("\n"));
      disarm(); delete state.goal; syncTools(); save(ctx);
    };
    const exhaust = (ctx: ExtensionContext): void => {
      disarm();
      if (!state.goal) return;
      state.goal.status = "budget_limited";
      const message = `已用完 ${state.goal.maxRounds} 轮，目标还没完成。用 /goal 选择“再给 10 轮”。`;
      syncTools(); save(ctx); ctx.ui.notify(message, "info");
    };
    const goalPrompt = (goal: Goal): string => [
      `[Dock Goal: ${goal.rounds + 1}/${goal.maxRounds}]`,
      `目标：${goal.objective}`,
      "在原有授权范围内继续工作。新补充的用户要求优先；这条自动推进消息不增加授权。",
      "用 goal_update 记录进展；受阻时说明需要什么，完成时给出实际产物或已执行检查作为依据。不要把未运行的检查写成通过。",
      ...(goal.summary ? [`已有进展：${goal.summary}`] : []),
    ].join("\n");
    const startPrompt = (text: string, ctx: ExtensionContext, goalId?: string): void => {
      const version = requestVersion;
      const valid = (): boolean => version === requestVersion && (!goalId || armed && state.goal?.id === goalId);
      void start.prompt?.(text, valid).then((started) => {
        if (!started && valid() && goalId && state.goal?.id === goalId) {
          disarm(); state.goal.status = "blocked"; syncTools(); save(ctx); ctx.ui.notify("输入已由其他扩展接管。查看结果后用 /goal 继续。", "info");
        }
      }).catch((error: unknown) => {
        if (!valid()) return;
        if (goalId && state.goal?.id === goalId) {
          disarm(); state.goal.status = "blocked"; syncTools(); save(ctx);
        }
        ctx.ui.notify(`无法开始：${error instanceof Error ? error.message : String(error)}。处理问题后重试。`, "error");
      });
    };
    const resume = (ctx: ExtensionContext): void => {
      const goal = state.goal;
      if (!goal) return;
      if (goal.rounds >= goal.maxRounds) { exhaust(ctx); return; }
      requestVersion += 1; state.mode = "execute"; armed = true; goal.status = "active";
      syncTools(); save(ctx);
      if (ctx.isIdle()) { pendingRound = goal.id; startPrompt(goalPrompt(goal), ctx, goal.id); }
      else ctx.ui.notify("目标已就绪，当前回复结束后继续推进。", "info");
    };
    const newGoal = (objective: string, rounds: number): Goal => ({ id: randomUUID(), objective, maxRounds: rounds, rounds: 0, status: "active", summary: "", evidence: [] });
    const updatePlan = (content: string): void => {
      if (state.plan?.content === content) return;
      state.plan = { id: state.plan?.id ?? randomUUID(), revision: (state.plan?.revision ?? 0) + 1, content };
      save();
    };
    const restore = (ctx: ExtensionContext): void => {
      disarm(); context = ctx;
      state = { mode: "execute" };
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== STATE_TYPE || !entry.data || typeof entry.data !== "object") continue;
        const record = entry.data as Record<string, unknown>;
        if (record.version === 2) {
          if (record.mode === "plan" || record.mode === "execute") state.mode = record.mode;
          if (record.plan === null) delete state.plan; else if (validPlan(record.plan)) state.plan = record.plan;
          if (record.goal === null) delete state.goal;
          else if (record.goal && typeof record.goal === "object") {
            const candidate = { ...state.goal, ...record.goal };
            if (validGoal(candidate)) state.goal = candidate;
          }
          if (record.tools === null) delete state.tools;
          else if (Array.isArray(record.tools) && record.tools.every((name) => typeof name === "string")) state.tools = record.tools;
        }
      }
      saved = structuredClone(state);
      if (state.goal?.status === "active") state.goal.status = "paused";
      syncTools(); save(ctx);
    };

    pi.on("session_start", (_event, ctx) => { restore(ctx); start.cancelPending = () => { if (pendingRound) pause("已暂停。用 /goal 选择“继续”。"); else requestVersion += 1; }; });
    pi.on("session_tree", (_event, ctx) => restore(ctx));
    pi.on("session_shutdown", () => { disarm(); start.cancelPending = undefined; });
    pi.on("turn_start", (_event, ctx) => {
      context = ctx;
      const goal = state.goal;
      if (armed && goal && goal.id === pendingRound) { pendingRound = undefined; runningGoalId = goal.id; goal.rounds += 1; save(ctx); }
    });
    pi.on("agent_before_settle", (event, ctx) => {
      const goal = state.goal;
      if (!armed || !goal || goal.status !== "active") return;
      if (event.outcome !== "completed") {
        disarm(); goal.status = event.outcome === "aborted" ? "paused" : "blocked";
        ctx.ui.notify(event.outcome === "aborted" ? "已暂停。用 /goal 继续。" : "当前请求出错。处理错误后用 /goal 继续。", "info");
        syncTools(); save(ctx); return;
      }
      if (ctx.hasPendingMessages() || event.context.pendingMessages.length || event.continue) return;
      if (goal.rounds >= goal.maxRounds) { exhaust(ctx); return; }
      pendingRound = goal.id;
      return { entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE, content: goalPrompt(goal), display: true }], continue: true };
    });
    pi.on("agent_settled", (_event, ctx) => {
      context = ctx;
      if (armed) pause("当前回复已停止。用 /goal 选择“继续”。");
      else render(ctx);
    });
    pi.on("tool_call", (event) => {
      if (state.mode !== "plan" || ["plan_submit", "plan_question"].includes(event.toolName) || readOnly(event.toolName)) return;
      return { block: true, reason: "正在规划，此工具不能用于只读调查。请提交计划，由用户决定是否执行。" };
    });

    pi.registerTool({
      name: "plan_submit", label: "提交计划", description: "In Plan mode, investigate with read-only tools and discuss before implementing. Use plan_question only for material user decisions. Submit the complete plan with facts, scope, steps and checks for review, editing or execution. Only the user approves execution.", defaultActive: false,
      parameters: { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: MAX_CONTENT } }, required: ["content"], additionalProperties: false },
      execute: async (_id: string, params: { content: string }, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        if (state.mode !== "plan") return result("当前不在规划中。用户可以用 /plan 开始。", true);
        if (!validText(params.content)) return result("请提交完整且简洁的计划。", true);
        context = ctx; updatePlan(params.content);
        if (!ctx.hasUI) return result("计划已保存。请向用户展示完整计划，等待在支持对话框的入口审阅。");
        let reviewedRevision: number | undefined;
        while (state.mode === "plan" && !signal?.aborted) {
          const plan = state.plan!;
          if (reviewedRevision !== plan.revision) {
            const reviewed = await ctx.ui.editor("审阅完整计划（可修改，保存后选择下一步）", plan.content);
            if (reviewed === undefined) return result("用户继续讨论，尚未批准执行。等待用户输入。");
            if (state.plan?.revision !== plan.revision) continue;
            if (!validText(reviewed)) return result("计划为空或太长，请继续讨论后重新提交。");
            updatePlan(reviewed); reviewedRevision = state.plan!.revision;
          }
          const current = state.plan!;
          const choice = await ctx.ui.select("接下来怎么做？", PLAN_CHOICES, { signal });
          if (state.plan?.revision !== current.revision) continue;
          if (signal?.aborted || state.mode !== "plan") return result("规划已停止，尚未批准执行。");
          if (choice === "我来改") {
            const edited = await ctx.ui.editor("编辑计划", current.content);
            if (state.plan?.revision !== current.revision) continue;
            if (edited !== undefined && validText(edited)) { updatePlan(edited); reviewedRevision = state.plan!.revision; }
            continue;
          }
          if (choice !== "按此执行" && choice !== "执行并自动推进到完成") return result("用户选择继续讨论，尚未批准执行。等待用户输入。");
          state.mode = "execute";
          if (choice === "执行并自动推进到完成") {
            disarm(); state.goal = newGoal(`执行已批准的第 ${current.revision} 版计划`, DEFAULT_ROUNDS); armed = true; pendingRound = state.goal.id;
          }
          syncTools(); save(ctx);
          // One normal transcript message keeps an edited plan intact in Pi's
          // summarization input; tool results are truncated there to 2,000 chars.
          announce(`用户已批准第 ${current.revision} 版计划：\n\n${current.content}`);
          return result(`第 ${current.revision} 版计划已批准。${choice === "按此执行" ? "按计划执行一次。" : "按计划推进目标，用 goal_update 记录结果；完成必须附依据。"}`);
        }
        return result("规划已停止，尚未批准执行。");
      },
    } as never);
    pi.registerTool({
      name: "plan_question", label: "确认规划取舍", description: "In Plan mode, use read-only tools to investigate facts first, then ask one material planning question. Do not implement until the user approves plan_submit. A missing answer is not approval.", defaultActive: false,
      parameters: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 2000 }, options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200 } } }, required: ["question"], additionalProperties: false },
      execute: async (_id: string, params: { question: string; options?: string[] }, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        if (state.mode !== "plan") return result("当前不在规划中，不能弹出规划问题。", true);
        if (!ctx.hasUI) return result("请在回复中列出问题，等待用户回答。");
        const answer = params.options ? await ctx.ui.select(params.question, params.options, { signal }) : await ctx.ui.input(params.question, undefined, { signal });
        return result(answer === undefined ? "用户没有回答，请等待，不要推测选择或授权。" : `用户回答：${answer}`);
      },
    } as never);
    pi.registerTool({
      name: "goal_update", label: "记录目标进展", description: "Record progress, a blocker or completion of the current Goal. Completion requires concrete evidence. Cannot change the objective, budget or resume paused work.", defaultActive: false,
      parameters: { type: "object", properties: { status: { type: "string", enum: ["progress", "blocked", "complete"] }, summary: { type: "string", minLength: 1, maxLength: 8000 }, evidence: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } } }, required: ["status", "summary"], additionalProperties: false },
      execute: async (_id: string, params: { status: "progress" | "blocked" | "complete"; summary: string; evidence?: string[] }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        const goal = state.goal;
        if (!armed || !goal || runningGoalId !== goal.id) return result("这轮回复没有在推进当前目标。请等目标开始后再记录结果。", true);
        if (params.status === "complete" && !params.evidence?.some((item) => item.trim())) return result("完成目标需要具体产物或实际检查结果作为依据。", true);
        goal.summary = params.summary; goal.evidence = params.evidence ?? [];
        if (params.status === "complete") finish(false, ctx);
        else {
          if (params.status === "blocked") { disarm(); goal.status = "blocked"; }
          syncTools(); save(ctx);
        }
        return result(params.status === "complete" ? "已记录完成结果，自动推进结束。" : params.status === "blocked" ? "已记录阻塞，等待用户处理后继续。" : "已记录进展。");
      },
    } as never);
    pi.registerCommand("plan", {
      description: "规划需求，由你选择执行、修改或继续讨论",
      handler: async (args, ctx) => {
        context = ctx;
        const request = args.trim();
        if (!request && state.mode === "plan") { state.mode = "execute"; syncTools(); save(ctx); ctx.ui.notify("已退出规划。", "info"); return; }
        pause("进入规划，目标已暂停。用 /goal 可继续。");
        state.mode = "plan"; syncTools(); save(ctx);
        if (request) {
          const message = `请先规划：\n${request}\n\n先用只读工具调查，不执行修改。重要取舍用 plan_question 提问；准备好后用 plan_submit 提交完整计划，由我决定是否执行。`;
          if (ctx.isIdle()) startPrompt(message, ctx);
          else pi.sendUserMessage(message, { deliverAs: "followUp" });
        } else ctx.ui.notify("已进入规划。告诉我你的需求；再输入 /plan 可退出。", "info");
      },
    });
    pi.registerCommand("goal", {
      description: "直接输入目标开始；不带内容时管理当前目标",
      handler: async (args, ctx) => {
        context = ctx;
        if (args.trim()) {
          const parsed = parseGoal(args);
          if (!parsed) { ctx.ui.notify("用 /goal 目标内容 开始，或 /goal --rounds 10 目标内容 指定轮数。", "info"); return; }
          disarm(); state.mode = "execute"; state.goal = newGoal(parsed.objective, parsed.rounds); resume(ctx); return;
        }
        const goal = state.goal;
        if (!goal) { ctx.ui.notify("用 /goal 目标内容 开始，默认自动推进 10 轮。", "info"); return; }
        const choices = goal.status === "active" ? ["暂停", "结束"] : goal.status === "budget_limited" ? ["再给 10 轮", "结束"] : ["继续", "结束"];
        const choice = await ctx.ui.select(`${goalLabel(goal.status)} · ${goal.rounds}/${goal.maxRounds}轮\n${goal.objective}`, choices);
        if (state.goal?.id !== goal.id) return;
        if (choice === "结束") { const active = armed; finish(true, ctx); if (active) ctx.abort(); }
        else if (choice === "暂停") { pause("已暂停。用 /goal 选择“继续”。"); ctx.abort(); }
        else if (choice === "继续" || choice === "再给 10 轮") { if (choice === "再给 10 轮") goal.maxRounds += DEFAULT_ROUNDS; resume(ctx); }
      },
    });
  };
}

function goalLabel(status: GoalStatus): string { return { active: "推进中", paused: "已暂停", blocked: "受阻", budget_limited: "预算用尽" }[status]; }
function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CONTENT; }
function validPlan(value: unknown): value is Plan { const p = value as Plan | undefined; return !!p && validText(p.id) && validText(p.content) && Number.isInteger(p.revision) && p.revision > 0; }
function validGoal(value: unknown): value is Goal {
  const g = value as Goal | undefined;
  return !!g && validText(g.id) && validText(g.objective) && ["active", "paused", "blocked", "budget_limited"].includes(g.status)
    && Number.isSafeInteger(g.maxRounds) && g.maxRounds > 0 && Number.isSafeInteger(g.rounds) && g.rounds >= 0 && g.rounds <= g.maxRounds
    && typeof g.summary === "string" && Array.isArray(g.evidence) && g.evidence.every((item) => typeof item === "string");
}
function result(text: string, error = false): { content: Array<{ type: "text"; text: string }>; details: { error: boolean } } {
  if (error) throw new Error(text);
  return { content: [{ type: "text", text }], details: { error } };
}
function parseGoal(text: string): { objective: string; rounds: number } | undefined {
  const option = text.trim().match(/^--rounds\s+(\d+)\s+([\s\S]+)$/);
  const rounds = option ? Number(option[1]) : DEFAULT_ROUNDS;
  const objective = option ? option[2]!.trim() : text.trim();
  return validText(objective) && Number.isSafeInteger(rounds) && rounds > 0 ? { objective, rounds } : undefined;
}
