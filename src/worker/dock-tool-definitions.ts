/**
 * The Dock tools a top-level Work offers its model (card #667): each tool's name, description and
 * arguments, what a call asks the Host and what it gives back. An Agent registers them from here through
 * its own tool API; nothing in this file knows which kind of Agent that is.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { THINKING_LEVELS, type ThinkingLevel } from "../core/agent-worker.js";
import {
  MAX_DOCK_TOOL_CWD_CHARS,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_NAME_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  type DockToolsRequest,
  type DockToolsResult,
} from "../core/dock-tools.js";
import { MAX_OBSERVATION_CURSOR_CHARS, MAX_OBSERVATION_MESSAGE_LIMIT, type ObservationMessageType } from "../core/instance-observation.js";
import { MAX_SOURCE_FILE_PATH_CHARS } from "../core/source-file.js";
import { MAX_ALLOWED_TOOLS, MAX_ALLOWED_TOOL_NAME_CHARS } from "../core/worker-tool-policy.js";
import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS, type ModelRef } from "../control/protocol.js";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, type ChildWaitResult } from "./child-messages.js";
import { renderChildWait, renderDockToolsResult, type ModelFacts, type RenderContext } from "./dock-tools-client.js";

/** What one Dock tool call needs from the Agent it runs in. */
export interface DockToolRuntime {
  /** Asks the Host. The Agent's bridge may do more around the call, such as noting which child Works now owe a result. */
  invoke(request: DockToolsRequest): Promise<DockToolsResult>;
  /** The Agent's current thinking level, which a child Work started without one of its own keeps. */
  thinkingLevel(): ThinkingLevel;
  /** What the Agent's own model and the models it can run support, for dock_models. */
  modelFacts(): ModelFacts;
  /** dock_wait: waits in this turn for child Works. Absent for an Agent that never waits inside a turn. */
  wait?(request: { target?: string; all?: boolean; timeoutSeconds?: number }, signal: AbortSignal | undefined): Promise<ChildWaitResult>;
}

/** What one Dock tool call gives back: the text the model reads and the structured details clients show. */
export interface DockToolOutput {
  text: string;
  details?: unknown;
}

export interface DockToolDefinition {
  name: string;
  label: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: object;
  /** Runs one call. The Agent checks `params` against `parameters` first, so each tool reads them as its own type. */
  execute(params: unknown, runtime: DockToolRuntime, signal?: AbortSignal): Promise<DockToolOutput>;
}

export interface DockToolOptions {
  /**
   * false leaves out dock_spawn's `withContext` argument and the sentence of its description about it,
   * for an Agent whose conversation is never copied to a child Work. Default true.
   */
  conversationCopy?: boolean;
}

const DOCK_TOOLS_GUIDE_PATH = fileURLToPath(new URL("../../../docs/agent/dock-tools.md", import.meta.url));

/** Every Dock tool's description ends with where its usage guide is on this machine. */
export function toolDescription(description: string): string {
  return `${description}\nUsage guide (read when needed): ${DOCK_TOOLS_GUIDE_PATH}`;
}

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const LIST_SCHEMA = {
  type: "object",
  properties: { scope: { type: "string", enum: ["live", "all"] } },
  additionalProperties: false,
};
const INSPECT_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
    limit: { type: "integer", minimum: 1, maximum: MAX_OBSERVATION_MESSAGE_LIMIT },
    types: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["user", "assistant", "other"] } },
    cursor: { type: "string", minLength: 1, maxLength: MAX_OBSERVATION_CURSOR_CHARS },
  },
  required: ["target"],
  additionalProperties: false,
};
const REQUIRED_TARGET_SCHEMA = {
  type: "object",
  properties: { target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS } },
  required: ["target"],
  additionalProperties: false,
};
const OPTIONAL_WATCH_SCHEMA = {
  type: "object",
  properties: { watchId: { type: "string", minLength: 1, maxLength: 128 } },
  additionalProperties: false,
};
const DELIVER_SCHEMA = {
  type: "object",
  properties: { path: { type: "string", minLength: 1, maxLength: MAX_SOURCE_FILE_PATH_CHARS } },
  required: ["path"],
  additionalProperties: false,
};
const MACHINE_NAME_SCHEMA = { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS, description: "An exact name from dock_machines. Omit for this Work's Machine." };
const SYSTEM_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    machine: MACHINE_NAME_SCHEMA,
    id: { type: "string", minLength: 1, maxLength: 128, description: "A candidate's id from the list. Reads that candidate instead of listing." },
    cursor: { type: "object", properties: { revision: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["revision", "offset"], additionalProperties: false, description: "The list's nextCursor, for its next page. Only without id." },
    offset: { type: "integer", minimum: 0, description: "The candidate's nextOffset, to continue reading it. Only with id." },
    revision: { type: "string", minLength: 1, maxLength: 128, description: "The revision that came with nextOffset. Only with id." },
  },
  required: ["cwd"], additionalProperties: false,
};
const CREATE_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    systemId: { type: "string", minLength: 1, maxLength: 128, description: "A candidate's id read with dock_system. Omit for the directory default." },
    saveDefault: { type: "boolean" },
    assistant: { type: "boolean", description: "Open it as the owner's personal assistant, with her persona and memory in place of a system, so without systemId. Only when the owner asks for that Work to be her." },
    name: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_NAME_CHARS },
    machine: MACHINE_NAME_SCHEMA,
    model: {
      type: "object",
      properties: {
        provider: { type: "string", minLength: 1, maxLength: MAX_MODEL_PROVIDER_CHARS },
        id: { type: "string", minLength: 1, maxLength: MAX_MODEL_ID_CHARS },
      },
      required: ["provider", "id"],
      additionalProperties: false,
    },
  },
  required: ["cwd"],
  additionalProperties: false,
};
const SEND_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS },
    message: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    delivery: { type: "string", enum: ["followUp", "steer"], description: "For another top-level Work only: default followUp lets its current turn finish; steer deliberately supplies guidance during the turn. A child Work of yours always gets the message at its next step." },
  },
  required: ["target", "message"],
  additionalProperties: false,
};
const WAIT_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_TARGET_CHARS, description: "One child Work's name or id: wait for its final result. Omit to wait for the first message from any child Work." },
    all: { type: "boolean", description: "Wait until every child Work you handed work to has sent its final result or stopped." },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: `Default ${DEFAULT_WAIT_SECONDS}.` },
  },
  additionalProperties: false,
};

const SPAWN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_NAME_CHARS },
    task: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_MESSAGE_CHARS },
    cwd: { type: "string", minLength: 1, maxLength: MAX_DOCK_TOOL_CWD_CHARS },
    model: CREATE_SCHEMA.properties.model,
    thinkingLevel: { type: "string", enum: THINKING_LEVELS },
    allowedTools: { type: "array", maxItems: MAX_ALLOWED_TOOLS, items: { type: "string", minLength: 1, maxLength: MAX_ALLOWED_TOOL_NAME_CHARS }, uniqueItems: true, description: "Exact Pi tool names such as read, grep, find, ls, edit, write, bash. Omit for normal full tool access; [] grants none. The child can always message you; it never gets other Dock tools. This limits tools, not what a granted shell can do." },
    withContext: { type: "boolean", description: "true starts the child Work from a copy of your conversation so far, so it already knows what you and the user settled; the task then only needs what is new. Omit it for a fresh start, as for an independent reviewer. A copied conversation makes each of the child Work's model requests larger." },
  },
  required: ["name", "task"], additionalProperties: false,
};

function spawnSchema(conversationCopy: boolean): object {
  if (conversationCopy) return SPAWN_SCHEMA;
  const { withContext: _withContext, ...properties } = SPAWN_SCHEMA.properties;
  return { ...SPAWN_SCHEMA, properties };
}

/** Every Dock tool of a top-level Work, in registration order. */
export function topLevelDockTools(options: DockToolOptions = {}): DockToolDefinition[] {
  const conversationCopy = options.conversationCopy ?? true;
  return [
    {
      name: "dock_spawn", label: "Start a child Work",
      description: toolDescription(`Create a child Work for a task of yours and start it. It works in your workspace with your model and thinking level. Set model or thinkingLevel only when the user or the project's instructions ask for one, never because a task looks easy or hard; dock_models gives the exact name of a model the user picked. A model without that thinking level runs at the nearest one it has, and the result says so.${conversationCopy ? " It starts with only the task unless withContext gives it a copy of your conversation." : ""} It appears under you in Dock, talks only to you and cannot reach other Works. It works at the same time as you: while it works it sends you what you should know or answer now, such as findings that affect your work, questions or points to agree on, and when it finishes, its final result. These messages reach you at your next step if you are still working; if it stops without its result, Dock tells you. Send it more with dock_send and stop it with dock_stop when you no longer need it. Child Works that edit and build at the same time need separate directories: give each its own git worktree as cwd and merge their work yourself. After starting child Works, end your turn unless you have work of your own; do not poll them. If your turn must not end, as during a Dock Goal, use dock_wait. It also stops when you stop. If creation succeeded but the task was not confirmed, inspect it before sending the task again. For an independent review grant only read, grep, find and ls.`),
      parameters: spawnSchema(conversationCopy),
      execute: async (params: Omit<Extract<DockToolsRequest, { type: "spawn" }>, "type" | "operationId">, runtime) => {
        const thinkingAsked = params.thinkingLevel ?? runtime.thinkingLevel();
        return dockToolOutput(await runtime.invoke({ ...params, type: "spawn", operationId: randomUUID() }), { thinkingAsked });
      },
    },
    {
      name: "dock_wait", label: "Wait for child Works",
      description: toolDescription("Wait in this turn for your child Works: until the first message from any of them, until target sends its final result, or with all=true until every child Work you handed work to has sent its final result or stopped. Messages from child Works that arrive meanwhile come back here instead of separately; one that is not a final result, such as a question or a finding, ends the wait at once so you can answer it. Returns early when the user's message reaches you or the user cancels. Use it only when your turn must not end, such as during a Dock Goal, whose next round would start as soon as your turn ends; otherwise end your turn and the messages wake you."),
      parameters: WAIT_SCHEMA,
      execute: async (params: { target?: string; all?: boolean; timeoutSeconds?: number }, runtime, signal) => {
        if (!runtime.wait) throw new Error("dock_wait is not available in this Work.");
        const result = await runtime.wait(params, signal);
        return { text: renderChildWait(result), details: result };
      },
    },
    {
      name: "dock_models", label: "Models for child Works",
      description: toolDescription("Show your own model, which child Works use unless the user or the project's instructions ask for another, and the few models the user picked for child Works, with what each supports. Use it to find the exact name of a model you were asked to use; it is not a recommendation."),
      parameters: EMPTY_SCHEMA,
      execute: async (_params, runtime) => dockToolOutput(await runtime.invoke({ type: "models" }), { facts: runtime.modelFacts() }),
    },
    ...(["interrupt", "stop"] as const).map((action): DockToolDefinition => ({
      name: `dock_${action}`, label: action === "interrupt" ? "Interrupt a Work" : "Stop a Work",
      description: toolDescription(action === "interrupt" ? "Interrupt another Work's current turn. Its work stays available for follow-up. Ordinary messages should use dock_send instead." : "Permanently stop another Work. Its child Works also stop and exit and leave the work list; their conversation files remain on disk. Check dock_list first."),
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (params: { target: string }, runtime) => dockToolOutput(await runtime.invoke({ type: action, operationId: randomUUID(), target: params.target })),
    })),
    {
      name: "dock_list",
      label: "List Dock Works",
      description: toolDescription("List the Works you can see, without reading their conversations. Use scope='all' only when stopped or unavailable history is relevant."),
      parameters: LIST_SCHEMA,
      execute: async (params: { scope?: "live" | "all" }, runtime) => dockToolOutput(await runtime.invoke({
        type: "list",
        ...(params.scope === "all" ? { includeHistory: true } : {}),
      })),
    },
    {
      name: "dock_machines",
      label: "List Dock Machines",
      description: toolDescription("List current Machines with their names, availability, platform, Home, and workspace roots. The Machine this Work runs on is marked."),
      parameters: EMPTY_SCHEMA,
      execute: async (_params, runtime) => dockToolOutput(await runtime.invoke({ type: "machines" })),
    },
    {
      name: "dock_inspect",
      label: "Inspect a Work",
      description: toolDescription("Read a page of another Work’s conversation. Selected messages come whole; one too long for a page says so and continues on the next page. Source roles identify who said each message."),
      parameters: INSPECT_SCHEMA,
      execute: async (params: { target: string; limit?: number; types?: ObservationMessageType[]; cursor?: string }, runtime) => dockToolOutput(await runtime.invoke({
        type: "inspect",
        target: params.target,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.types === undefined ? {} : { types: params.types }),
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      })),
    },
    {
      name: "dock_watch",
      label: "Watch a Work",
      description: toolDescription("Get a notification when another Work becomes idle, stops or fails. Returns immediately; continue other work while waiting. The notification reaches you at your next step if you are still working. Your own child Works need no watch: they send you their results."),
      parameters: REQUIRED_TARGET_SCHEMA,
      execute: async (params: { target: string }, runtime) => dockToolOutput(await runtime.invoke({ type: "watch", target: params.target })),
    },
    {
      name: "dock_cancel_watch",
      label: "Cancel Dock watches",
      description: toolDescription("Cancel one source-owned watch, or all watches when watchId is omitted."),
      parameters: OPTIONAL_WATCH_SCHEMA,
      execute: async (params: { watchId?: string }, runtime) => dockToolOutput(await runtime.invoke({ type: "cancel", ...(params.watchId === undefined ? {} : { watchId: params.watchId }) })),
    },
    {
      name: "dock_deliver_file",
      label: "Deliver a temporary file",
      description: toolDescription("Register an absolute local file path for temporary download by the user. The file must remain unchanged and available."),
      parameters: DELIVER_SCHEMA,
      execute: async (params: { path: string }, runtime) => dockToolOutput(await runtime.invoke({ type: "deliver", path: params.path })),
    },
    {
      name: "dock_system",
      label: "Read Dock systems",
      description: toolDescription("Find the systems a new Work in an absolute cwd can start from, or read one. Without id it lists candidates; pass the list's nextCursor as cursor for the next page. With id it reads that candidate; pass its nextOffset as offset, with the revision that came with it, to continue. cursor goes only without id, offset and revision only with id."),
      parameters: SYSTEM_SCHEMA,
      execute: async (params: Omit<Extract<DockToolsRequest, { type: "system" }>, "type">, runtime) => dockToolOutput(await runtime.invoke({ type: "system", ...params })),
    },
    {
      name: "dock_create",
      label: "Create Dock work",
      description: toolDescription("Create a new top-level Work in an absolute working directory. Omit machine to create it on this Work's Machine; name another Machine exactly as dock_machines lists it. Set systemId only to an id read with dock_system. Without systemId, the creating Host applies its directory default, or Pi native behavior when none is configured; a broken configured default fails creation. saveDefault=true explicitly saves the selected system before creating. Saving and creating are separate outcomes. model is the exact {provider,id} the new Work starts with, as the owner names it; omit it for the target Machine's Pi default. An unavailable model fails creation. assistant=true opens it as the owner's personal assistant, whose persona and memory take the place of a system, so leave out systemId; without it the new Work is not her, whatever the directory's default. The new Work can collaborate immediately. For a task of your own use dock_spawn."),
      parameters: CREATE_SCHEMA,
      execute: async (params: { cwd: string; name?: string; machine?: string; systemId?: string; saveDefault?: boolean; model?: ModelRef; assistant?: boolean }, runtime) => dockToolOutput(await runtime.invoke({
        type: "create",
        operationId: randomUUID(),
        cwd: params.cwd,
        ...(params.assistant === true ? { assistant: true as const } : {}),
        ...(params.systemId === undefined ? {} : { systemId: params.systemId }),
        ...(params.saveDefault === undefined ? {} : { saveDefault: params.saveDefault }),
        ...(params.model === undefined ? {} : { model: { provider: params.model.provider, id: params.model.id } }),
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.machine === undefined ? {} : { machine: params.machine }),
      })),
    },
    {
      name: "dock_send",
      label: "Send a Dock message",
      description: toolDescription("Send a message to another Work with your authenticated sender identity. A child Work of yours gets it at its next step as a message from you, and its answers come back the same way. Another top-level Work is started if idle, or gets it after its current turn; use delivery=steer only for deliberate mid-turn guidance. Do not send acknowledgment-only messages: each one wakes the other Work."),
      parameters: SEND_SCHEMA,
      execute: async (params: { target: string; message: string; delivery?: "followUp" | "steer" }, runtime) => dockToolOutput(await runtime.invoke({
        type: "send",
        operationId: randomUUID(),
        target: params.target,
        message: params.message,
        ...(params.delivery === undefined ? {} : { delivery: params.delivery }),
      })),
    },
  ];
}

/** A Host answer as a tool call's outcome; the list of Machines goes to the model as text only. */
export function dockToolOutput(value: DockToolsResult, context?: RenderContext): DockToolOutput {
  return {
    text: renderDockToolsResult(value, context),
    ...(value.type === "machines" ? {} : { details: value }),
  };
}
