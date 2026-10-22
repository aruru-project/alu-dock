import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionFactory, ToolLoadout } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "alu-dock-plan-goal-state";
const MESSAGE_TYPE = "alu-dock-plan-goal";
const MAX_CONTENT = 64_000;
const DEFAULT_ROUNDS = 10;
const PLAN_TOOLS = ["plan_submit", "plan_question"];
const OWN_TOOLS = new Set([...PLAN_TOOLS, "goal_update"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const RUN_ONCE = "按此执行";
const RUN_AS_GOAL = "执行并自动推进到完成";
const DISCUSS = "继续讨论";
const PAUSED_HINT = "已暂停。用 /dock-goal 选择“继续”。";

const PLAN_SUBMIT_SCHEMA = {
  type: "object",
  properties: { content: { type: "string", minLength: 1, maxLength: MAX_CONTENT } },
  required: ["content"],
  additionalProperties: false,
};
const PLAN_QUESTION_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 1, maxLength: 2_000 },
    options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 200 } },
  },
  required: ["question"],
  additionalProperties: false,
};
const GOAL_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["progress", "blocked", "complete"] },
    summary: { type: "string", minLength: 1, maxLength: 8_000 },
    evidence: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2_000 } },
  },
  required: ["status", "summary"],
  additionalProperties: false,
};

type Mode = "plan" | "execute";
type GoalStatus = "active" | "paused" | "blocked" | "budget_limited";
interface Plan { id: string; revision: number; content: string }
interface Goal { id: string; objective: string; status: GoalStatus; maxRounds: number; rounds: number; summary: string; evidence: string[] }
interface State { mode: Mode; plan?: Plan; goal?: Goal; readsAddedByPlan?: string[] }
/**
 * One session record holds only what changed since the previous record.
 * `stoppedPrompt` is the timestamp of a Goal prompt stopped before it reached the model.
 */
interface StateRecord { version: 1; mode?: Mode; plan?: Plan | null; goal?: Partial<Goal> | null; readsAddedByPlan?: string[] | null; stoppedPrompt?: number }
interface PlanSubmitParams { content: string }
interface PlanQuestionParams { question: string; options?: string[] }
interface GoalUpdateParams { status: "progress" | "blocked" | "complete"; summary: string; evidence?: string[] }

/**
 * The Worker-local link between this extension and Dock's Pi adapter.
 *
 * Pi's `sendUserMessage` reports neither a failure before the run starts nor
 * input taken over by another extension. The adapter fills `prompt`, which
 * reports whether the run really started and calls `mayStart` at the last
 * moment; the extension sets `cancelPending` so the adapter's abort can drop a
 * request still being prepared. Pi records a prompt it stopped before its first
 * request, so the adapter calls the request's `stopped` just before Pi records it,
 * and the extension keeps that prompt out of later requests.
 *
 * The extension also sets `isPlanning`. Dock's built-in codemode reads it so
 * that while planning, codemode stops hiding the other tools, as its "only"
 * mode otherwise does; Plan hides codemode itself.
 *
 * The adapter calls `toolsChosen` after the person sets the active tools, which
 * Pi does not report to extensions.
 */
export interface PlanGoalPort {
  prompt?: (text: string, mayStart: () => boolean, stopped: () => void) => Promise<boolean>;
  cancelPending?: () => void;
  isPlanning?: () => boolean;
  toolsChosen?: () => void;
}

export function planGoalExtension(port: PlanGoalPort): ExtensionFactory {
  return (pi) => {
    let state: State = { mode: "execute" };
    port.isPlanning = () => state.mode === "plan";
    let recorded: State = structuredClone(state);
    let context: ExtensionContext | undefined;
    // A Goal round proposed at the settle boundary that has not started yet,
    // and the Goal whose round is running now (only it may report results).
    let pendingRound: string | undefined;
    let runningGoalId: string | undefined;
    // Bumped whenever automatic work stops, so a start still being prepared is dropped.
    let requestVersion = 0;
    // Goal prompts Pi recorded although they were stopped before reaching the model.
    let stoppedPrompts = new Set<number>();
    let stoppedStartRecording = false;
    // The run now ending is such a stopped start, not a Goal round the person stopped.
    let stoppedStartSettling = false;
    const startStopped = (): void => {
      stoppedStartRecording = true;
      stoppedStartSettling = true;
    };

    const goalActive = (): boolean => state.goal?.status === "active";

    const isReadOnlyTool = (name: string): boolean => {
      const tool = pi.getAllTools().find((item) => item.name === name);
      return READ_TOOLS.has(name) && tool?.sourceInfo.source === "builtin" || tool?.annotations?.readOnlyHint === true;
    };

    /**
     * Planning adds the built-in read tools and its own tools. It never removes
     * the person's tools: plan_submit hides the ones that are not read-only, so
     * tools switched on or off during planning stay that way afterwards. Once the
     * person chooses tools while planning, the read tools that are on are theirs
     * too, and stay when planning ends.
     */
    const applyTools = (): void => {
      const active = pi.getActiveTools().filter((name) => !OWN_TOOLS.has(name));
      if (state.mode === "plan") {
        state.readsAddedByPlan ??= pi.getAllTools()
          .filter((tool) => tool.sourceInfo.source === "builtin" && READ_TOOLS.has(tool.name) && !active.includes(tool.name))
          .map((tool) => tool.name);
        pi.setActiveTools([...new Set([...active, ...state.readsAddedByPlan, ...PLAN_TOOLS])]);
        return;
      }
      const ordinary = active.filter((name) => !state.readsAddedByPlan?.includes(name));
      delete state.readsAddedByPlan;
      pi.setActiveTools(goalActive() ? [...ordinary, "goal_update"] : ordinary);
    };

    port.toolsChosen = () => {
      if (state.mode !== "plan" || state.readsAddedByPlan?.length === 0) return;
      state.readsAddedByPlan = [];
      appendRecord();
    };

    const hideNonReadOnlyTools = (loadout: ToolLoadout) => state.mode === "plan" ? {
      hiddenDeclarations: loadout.declared.map((tool) => tool.name).filter((name) => !PLAN_TOOLS.includes(name) && !isReadOnlyTool(name)),
    } : undefined;

    const appendRecord = (): void => {
      const record: StateRecord = { version: 1 };
      if (state.mode !== recorded.mode) record.mode = state.mode;
      if (JSON.stringify(state.plan) !== JSON.stringify(recorded.plan)) record.plan = state.plan ?? null;
      if (JSON.stringify(state.readsAddedByPlan) !== JSON.stringify(recorded.readsAddedByPlan)) record.readsAddedByPlan = state.readsAddedByPlan ?? null;
      if (!state.goal && recorded.goal) record.goal = null;
      else if (state.goal) {
        const previous = recorded.goal?.id === state.goal.id ? recorded.goal : undefined;
        const changed = Object.entries(state.goal)
          .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous?.[key as keyof Goal]));
        if (changed.length > 0) record.goal = Object.fromEntries(changed);
      }
      if (Object.keys(record).length > 1) pi.appendEntry(STATE_TYPE, record);
      recorded = structuredClone(state);
    };

    const render = (ctx: ExtensionContext): void => {
      const { plan, goal } = state;
      ctx.ui.setStatus("Plan", state.mode === "plan" ? "规划中 · /dock-plan 退出" : undefined);
      ctx.ui.setWidget("alu-dock-plan", state.mode === "plan" && plan
        ? ["当前计划", ...plan.content.split("\n").filter((line) => line.trim()).slice(0, 24)]
        : undefined);
      ctx.ui.setStatus("Goal", goal ? `${goalLabel(goal.status)} · ${goal.rounds}/${goal.maxRounds}轮 · /dock-goal 管理` : undefined);
      ctx.ui.setWidget("alu-dock-goal", goal?.status === "active"
        ? [`目标：${goal.objective}`, ...(goal.summary ? [goal.summary] : [])]
        : undefined);
    };

    /** Every state change ends here: tool visibility, the session record and the UI. */
    const commit = (ctx = context): void => {
      applyTools();
      appendRecord();
      if (ctx) render(ctx);
    };

    const stopAutomation = (): void => {
      pendingRound = undefined;
      runningGoalId = undefined;
      requestVersion += 1;
    };

    const setGoalStatus = (status: GoalStatus, ctx = context, message?: string): void => {
      if (!state.goal) return;
      if (status !== "active") stopAutomation();
      state.goal.status = status;
      commit(ctx);
      if (message) ctx?.ui.notify(message, "info");
    };

    const stopForBudget = (goal: Goal, ctx: ExtensionContext): void => {
      setGoalStatus("budget_limited", ctx, `已用完 ${goal.maxRounds} 轮，目标还没完成。用 /dock-goal 选择“再给 10 轮”。`);
    };

    const pause = (message: string, ctx = context): void => {
      if (goalActive()) setGoalStatus("paused", ctx, message);
      else stopAutomation();
    };

    const announce = (text: string): void => {
      pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, { triggerTurn: false });
    };

    const finishGoal = (ended: boolean, ctx: ExtensionContext): void => {
      const goal = state.goal;
      if (!goal) return;
      announce([ended ? "目标已结束" : "目标已完成", goal.objective, goal.summary, ...goal.evidence.map((item) => `依据：${item}`)]
        .filter(Boolean).join("\n"));
      stopAutomation();
      delete state.goal;
      commit(ctx);
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
      const current = (): boolean => version === requestVersion && (!goalId || goalActive() && state.goal?.id === goalId);
      const notStarted = (message: string, level: "warning" | "error"): void => {
        if (goalId && state.goal?.id === goalId) setGoalStatus("blocked", ctx);
        ctx.ui.notify(message, level);
      };
      if (!port.prompt) {
        notStarted("规划与目标没有连接到当前工作，无法开始。请重新打开这个工作后再试。", "error");
        return;
      }
      void port.prompt(text, current, startStopped).then((started) => {
        if (!started && goalId && current()) notStarted("这条请求被其他扩展接管，目标没有开始。查看结果后用 /dock-goal 继续。", "warning");
      }).catch((error: unknown) => {
        if (current()) notStarted(`无法开始：${error instanceof Error ? error.message : String(error)}。处理问题后重试。`, "error");
      });
    };

    const resumeGoal = (ctx: ExtensionContext): void => {
      const goal = state.goal;
      if (!goal) return;
      if (goal.rounds >= goal.maxRounds) {
        stopForBudget(goal, ctx);
        return;
      }
      stopAutomation();
      state.mode = "execute";
      goal.status = "active";
      commit(ctx);
      if (ctx.isIdle()) {
        pendingRound = goal.id;
        startPrompt(goalPrompt(goal), ctx, goal.id);
      } else {
        ctx.ui.notify("目标已就绪，当前回复结束后继续推进。", "info");
      }
    };

    const newGoal = (objective: string, rounds: number): Goal => ({
      id: randomUUID(), objective, status: "active", maxRounds: rounds, rounds: 0, summary: "", evidence: [],
    });

    const setPlanContent = (content: string): void => {
      if (state.plan?.content === content) return;
      state.plan = { id: state.plan?.id ?? randomUUID(), revision: (state.plan?.revision ?? 0) + 1, content };
    };

    const restore = (ctx: ExtensionContext): void => {
      stopAutomation();
      context = ctx;
      state = { mode: "execute" };
      let lastReadsAddedByPlan: string[] | undefined;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
        const record = entry.data as Partial<StateRecord> | undefined;
        if (record?.version !== 1) continue;
        if (record.mode === "plan" || record.mode === "execute") state.mode = record.mode;
        if (record.plan === null) delete state.plan;
        else if (validPlan(record.plan)) state.plan = record.plan;
        if (record.goal === null) delete state.goal;
        else if (record.goal && typeof record.goal === "object") {
          const goal = { ...state.goal, ...record.goal };
          if (validGoal(goal)) state.goal = goal;
        }
        if (record.readsAddedByPlan === null) delete state.readsAddedByPlan;
        else if (Array.isArray(record.readsAddedByPlan) && record.readsAddedByPlan.every((name) => typeof name === "string")) {
          state.readsAddedByPlan = lastReadsAddedByPlan = record.readsAddedByPlan;
        }
      }
      stoppedPrompts = new Set(ctx.sessionManager.getBranch().flatMap((entry) => (
        entry.type === "custom" && entry.customType === STATE_TYPE && Number.isSafeInteger((entry.data as Partial<StateRecord> | undefined)?.stoppedPrompt)
          ? [(entry.data as StateRecord).stoppedPrompt!]
          : []
      )));
      recorded = structuredClone(state);
      // Pi records the tool list only with the next request. At a history point
      // between leaving Plan and that request, Pi restores the planning tools.
      if (state.mode === "execute" && lastReadsAddedByPlan && pi.getActiveTools().includes("plan_submit")) {
        state.readsAddedByPlan = lastReadsAddedByPlan;
      }
      // Reopening or switching history never restarts automatic work by itself.
      if (state.goal?.status === "active") state.goal.status = "paused";
      commit(ctx);
    };

    pi.on("session_start", (_event, ctx) => {
      restore(ctx);
      port.cancelPending = () => {
        if (pendingRound) pause(PAUSED_HINT);
        else stopAutomation();
      };
    });
    pi.on("session_tree", (_event, ctx) => restore(ctx));
    pi.on("session_shutdown", () => {
      stopAutomation();
      port.cancelPending = undefined;
    });

    pi.on("turn_start", (_event, ctx) => {
      context = ctx;
      const goal = state.goal;
      if (!goalActive() || !goal || goal.id !== pendingRound) return;
      pendingRound = undefined;
      runningGoalId = goal.id;
      goal.rounds += 1;
      appendRecord();
      render(ctx);
    });

    // The only place a new Goal round begins, after Pi's own retries,
    // compaction and queued input have had their turn.
    pi.on("agent_before_settle", (event, ctx) => {
      const goal = state.goal;
      if (!goalActive() || !goal) return;
      if (event.outcome === "aborted") return setGoalStatus("paused", ctx, PAUSED_HINT);
      if (event.outcome === "error") return setGoalStatus("blocked", ctx, "当前请求出错。处理错误后用 /dock-goal 继续。");
      if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0 || event.continue) return;
      if (goal.rounds >= goal.maxRounds) return stopForBudget(goal, ctx);
      pendingRound = goal.id;
      return {
        entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE, content: goalPrompt(goal), display: true }],
        continue: true,
      };
    });

    // The first user message of a start the adapter stopped is its Goal prompt.
    pi.on("message_end", (event) => {
      if (!stoppedStartRecording || event.message.role !== "user") return;
      stoppedStartRecording = false;
      stoppedPrompts.add(event.message.timestamp);
      pi.appendEntry(STATE_TYPE, { version: 1, stoppedPrompt: event.message.timestamp } satisfies StateRecord);
    });

    // A stopped Goal never reaches the model, also not as history of later requests.
    pi.on("context", (event) => stoppedPrompts.size === 0 ? undefined : {
      messages: event.messages.filter((message) => !(message.role === "user" && stoppedPrompts.has(message.timestamp))),
    });

    // Esc skips the settle boundary; the run still ends here.
    pi.on("agent_settled", (_event, ctx) => {
      context = ctx;
      const stoppedStart = stoppedStartSettling;
      stoppedStartSettling = false;
      stoppedStartRecording = false;
      // A Goal still active after a stopped start was started after that stop and
      // has been waiting for it to end ("目标已就绪…"): it starts now.
      if (goalActive() && stoppedStart) resumeGoal(ctx);
      else if (goalActive()) pause("当前回复已停止。用 /dock-goal 选择“继续”。", ctx);
      else render(ctx);
    });

    pi.on("tool_call", (event) => {
      if (state.mode !== "plan" || PLAN_TOOLS.includes(event.toolName) || isReadOnlyTool(event.toolName)) return;
      return { block: true, reason: "正在规划，此工具不能用于只读调查。请提交计划，由用户决定是否执行。" };
    });

    pi.registerTool({
      name: "plan_submit",
      label: "提交计划",
      description: "In Plan mode, investigate with read-only tools and discuss before implementing. Use plan_question only for material user decisions. Submit the complete plan with facts, scope, steps and checks for review, editing or execution. Only the user approves execution.",
      parameters: PLAN_SUBMIT_SCHEMA,
      defaultActive: false,
      prepareLoadout: hideNonReadOnlyTools,
      execute: async (_id: string, params: PlanSubmitParams, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        if (state.mode !== "plan") throw new Error("当前不在规划中。用户可以用 /dock-plan 开始。");
        if (!validText(params.content)) throw new Error("请提交完整且简洁的计划。");
        context = ctx;
        setPlanContent(params.content);
        commit(ctx);
        if (!ctx.hasUI) return textResult("计划已保存。请向用户展示完整计划，等待在支持对话框的入口审阅。");
        while (state.mode === "plan" && !signal?.aborted) {
          const shown = state.plan!;
          // Dock's adapter gives editors opened during a run that run's abort
          // signal, so Esc closes this editor instead of waiting for an answer.
          const reviewed = await ctx.ui.editor("审阅完整计划（可修改，保存后选择下一步）", shown.content);
          if (reviewed === undefined) return textResult("用户继续讨论，尚未批准执行。等待用户输入。");
          if (state.plan?.revision !== shown.revision) continue;
          if (!validText(reviewed)) return textResult("计划为空或太长，请继续讨论后重新提交。");
          setPlanContent(reviewed);
          commit(ctx);
          const plan = state.plan!;
          const choice = await ctx.ui.select("接下来怎么做？", [RUN_ONCE, RUN_AS_GOAL, DISCUSS], { signal });
          if (state.plan?.revision !== plan.revision) continue;
          if (signal?.aborted || state.mode !== "plan") break;
          if (choice !== RUN_ONCE && choice !== RUN_AS_GOAL) return textResult("用户选择继续讨论，尚未批准执行。等待用户输入。");
          state.mode = "execute";
          if (choice === RUN_AS_GOAL) {
            stopAutomation();
            state.goal = newGoal(`执行已批准的第 ${plan.revision} 版计划`, DEFAULT_ROUNDS);
            pendingRound = state.goal.id;
          }
          commit(ctx);
          // A normal message, not this tool result: Pi's summary input cuts tool
          // results to 2,000 characters, and the edited plan must survive intact.
          announce(`用户已批准第 ${plan.revision} 版计划：\n\n${plan.content}`);
          return textResult(`第 ${plan.revision} 版计划已批准。${choice === RUN_ONCE ? "按计划执行一次。" : "按计划推进目标，用 goal_update 记录结果；完成必须附依据。"}`);
        }
        return textResult("规划已停止，尚未批准执行。");
      },
    } as never);

    pi.registerTool({
      name: "plan_question",
      label: "确认规划取舍",
      description: "In Plan mode, use read-only tools to investigate facts first, then ask one material planning question. Do not implement until the user approves plan_submit. A missing answer is not approval.",
      parameters: PLAN_QUESTION_SCHEMA,
      defaultActive: false,
      execute: async (_id: string, params: PlanQuestionParams, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        if (state.mode !== "plan") throw new Error("当前不在规划中，不能弹出规划问题。");
        if (!ctx.hasUI) return textResult("请在回复中列出问题，等待用户回答。");
        const answer = params.options
          ? await ctx.ui.select(params.question, params.options, { signal })
          : await ctx.ui.input(params.question, undefined, { signal });
        return textResult(answer === undefined ? "用户没有回答，请等待，不要推测选择或授权。" : `用户回答：${answer}`);
      },
    } as never);

    pi.registerTool({
      name: "goal_update",
      label: "记录目标进展",
      description: "Record progress, a blocker or completion of the current Goal. Completion requires concrete evidence. Cannot change the objective, budget or resume paused work.",
      parameters: GOAL_UPDATE_SCHEMA,
      defaultActive: false,
      execute: async (_id: string, params: GoalUpdateParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
        const goal = state.goal;
        if (!goalActive() || !goal || runningGoalId !== goal.id) throw new Error("这轮回复没有在推进当前目标。请等目标开始后再记录结果。");
        if (params.status === "complete" && !params.evidence?.some((item) => item.trim())) throw new Error("完成目标需要具体产物或实际检查结果作为依据。");
        goal.summary = params.summary;
        goal.evidence = params.evidence ?? [];
        if (params.status === "complete") {
          finishGoal(false, ctx);
          return textResult("已记录完成结果，自动推进结束。");
        }
        if (params.status === "blocked") {
          setGoalStatus("blocked", ctx);
          return textResult("已记录阻塞，等待用户处理后继续。");
        }
        commit(ctx);
        return textResult("已记录进展。");
      },
    } as never);

    pi.registerCommand("dock-plan", {
      description: "审阅和修改计划，再决定执行或继续讨论",
      handler: async (args, ctx) => {
        context = ctx;
        const request = args.trim();
        if (!request && state.mode === "plan") {
          state.mode = "execute";
          commit(ctx);
          ctx.ui.notify("已退出规划。", "info");
          return;
        }
        pause("进入规划，目标已暂停。用 /dock-goal 可继续。", ctx);
        state.mode = "plan";
        commit(ctx);
        if (!request) {
          ctx.ui.notify("已进入规划。告诉我你的需求；再输入 /dock-plan 可退出。", "info");
          return;
        }
        const message = `请先规划：\n${request}\n\n先用只读工具调查，不执行修改。重要取舍用 plan_question 提问；准备好后用 plan_submit 提交完整计划，由我决定是否执行。`;
        if (ctx.isIdle()) startPrompt(message, ctx);
        else pi.sendUserMessage(message, { deliverAs: "followUp" });
      },
    });

    pi.registerCommand("dock-goal", {
      description: "直接输入目标开始；不带内容时管理当前目标",
      handler: async (args, ctx) => {
        context = ctx;
        if (args.trim()) {
          const parsed = parseGoal(args);
          if (!parsed) {
            ctx.ui.notify("用 /dock-goal 目标内容 开始，或 /dock-goal --rounds 10 目标内容 指定轮数。", "info");
            return;
          }
          stopAutomation();
          state.goal = newGoal(parsed.objective, parsed.rounds);
          resumeGoal(ctx);
          return;
        }
        const goal = state.goal;
        if (!goal) {
          ctx.ui.notify("用 /dock-goal 目标内容 开始，默认自动推进 10 轮。", "info");
          return;
        }
        const choices = goal.status === "active" ? ["暂停", "结束"]
          : goal.status === "budget_limited" ? ["再给 10 轮", "结束"]
            : ["继续", "结束"];
        // Dialog titles are a single line.
        const choice = await ctx.ui.select(`${goalLabel(goal.status)} · ${goal.rounds}/${goal.maxRounds}轮 · ${goal.objective}`, choices);
        if (state.goal?.id !== goal.id) return;
        if (choice === "结束") {
          const wasActive = goalActive();
          finishGoal(true, ctx);
          if (wasActive) ctx.abort();
        } else if (choice === "暂停") {
          pause(PAUSED_HINT, ctx);
          ctx.abort();
        } else if (choice === "继续" || choice === "再给 10 轮") {
          if (choice === "再给 10 轮") goal.maxRounds += DEFAULT_ROUNDS;
          resumeGoal(ctx);
        }
      },
    });
  };
}

function goalLabel(status: GoalStatus): string {
  return { active: "推进中", paused: "已暂停", blocked: "受阻", budget_limited: "预算用尽" }[status];
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CONTENT;
}

function validPlan(value: unknown): value is Plan {
  const plan = value as Plan | undefined;
  return !!plan && validText(plan.id) && validText(plan.content) && Number.isInteger(plan.revision) && plan.revision > 0;
}

function validGoal(value: unknown): value is Goal {
  const goal = value as Goal | undefined;
  return !!goal && validText(goal.id) && validText(goal.objective)
    && ["active", "paused", "blocked", "budget_limited"].includes(goal.status)
    && Number.isSafeInteger(goal.maxRounds) && goal.maxRounds > 0
    && Number.isSafeInteger(goal.rounds) && goal.rounds >= 0 && goal.rounds <= goal.maxRounds
    && typeof goal.summary === "string" && Array.isArray(goal.evidence) && goal.evidence.every((item) => typeof item === "string");
}

function parseGoal(text: string): { objective: string; rounds: number } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("--rounds")) return validText(trimmed) ? { objective: trimmed, rounds: DEFAULT_ROUNDS } : undefined;
  const match = trimmed.match(/^--rounds\s+(\d+)\s+(\S[\s\S]*)$/);
  const rounds = Number(match?.[1]);
  return match && Number.isSafeInteger(rounds) && rounds > 0 && validText(match[2]) ? { objective: match[2], rounds } : undefined;
}
