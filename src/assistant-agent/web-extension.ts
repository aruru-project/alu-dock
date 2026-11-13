import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { McpClient, StdioTransport, toLlmContent } from "@earendil-works/pi-mcp";

import { DOCK_VERSION } from "../version.js";
import type { JsonObject } from "../core/json-value.js";
import type { AssistantExtensionFactory } from "./tool-extensions.js";

const WEB_TOOLS = new Set(["web_search", "fetch_content", "get_search_content", "source_check"]);
const require = createRequire(import.meta.url);

/**
 * Dock's shipped web extension. The pinned package's documented standalone entry owns search,
 * extraction and result storage. It is not a Pi extension host and does not use Pi sign-ins.
 */
export const webExtension: AssistantExtensionFactory = async (context) => {
  const packageFile = require.resolve("pi-web-access/package.json");
  const metadata = JSON.parse(await readFile(packageFile, "utf8")) as { bin?: Record<string, string> };
  const entry = metadata.bin?.["pi-web-access-mcp"];
  if (!entry) throw new Error("随包联网工具缺少启动入口，请更新 Alu Dock 后重试。");

  // The standalone engine uses this filename. Its configuration lives with this extension,
  // not under a user's Pi installation; only this extension receives these private values.
  await writeFile(join(context.dataDir, "web-search.json"), JSON.stringify(context.config), { mode: 0o600 });
  const client = new McpClient({ name: "aludock-assistant-web", version: DOCK_VERSION, requestTimeoutMs: 10_000 });
  try {
    await client.connect(new StdioTransport({
      command: process.execPath,
      args: [resolve(dirname(packageFile), entry)],
      cwd: context.cwd,
      env: { PI_CODING_AGENT_DIR: context.dataDir, PI_WEB_ACCESS_CACHE_ROOT: context.dataDir },
    }));
    const listed = await client.listTools();
    return {
      tools: listed.filter((tool) => WEB_TOOLS.has(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} } as unknown as JsonObject,
        execute: async (params, call) => {
          const result = await client.callTool(tool.name, params, { signal: call.signal, timeoutMs: 120_000 });
          // Only the result's public text/images reach the conversation; configuration and credentials do not.
          return { content: toLlmContent(result), isError: result.isError === true };
        },
      })),
      dispose: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
};
