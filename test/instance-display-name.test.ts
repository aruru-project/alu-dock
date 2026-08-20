import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CWD_FALLBACK_DISPLAY_NAME_CHARS,
  MAX_INSTANCE_DISPLAY_NAME_CHARS,
  projectInstanceDisplayName,
} from "../src/core/instance-display-name.js";

test("Dock projects one safe display name from the session name, first user message, or project", () => {
  assert.equal(projectInstanceDisplayName({
    name: "  中文<规划>\n工作  ",
    firstUserMessage: "ignored first message",
    cwd: "/workspace/ignored",
  }), "中文 规划 工作");
  assert.equal(projectInstanceDisplayName({
    name: "<>\n",
    firstUserMessage: "准备进行 Alu Dock 0.2 release 检查",
    cwd: "/workspace/ignored",
  }), "准备进行 Alu Dock 0 2 release 检查");
  assert.equal(projectInstanceDisplayName({
    cwd: "/workspace/my.project_v2<script>",
  }), "my project_v2 script");

  const truncated = projectInstanceDisplayName({ cwd: `/workspace/${"a".repeat(100)}` });
  assert.equal(truncated, "a".repeat(MAX_CWD_FALLBACK_DISPLAY_NAME_CHARS));
});

test("normalization expansion stays within the protocol's UTF-16 bound without splitting characters", () => {
  const source = `${"𐐀".repeat(100)}${"ﬃ".repeat(50)}`;
  assert.ok(source.length <= MAX_INSTANCE_DISPLAY_NAME_CHARS);

  const displayName = projectInstanceDisplayName({ name: source, cwd: "/workspace/ignored" });
  assert.equal(displayName.length, MAX_INSTANCE_DISPLAY_NAME_CHARS);
  assert.doesNotMatch(displayName, /[\ud800-\udbff]$/u);
  assert.match(displayName, /^[\p{L}\p{M}\p{N}_-]+(?: [\p{L}\p{M}\p{N}_-]+)*$/u);
});

test("unusual cwd text degrades to Work without exposing control or markup characters", () => {
  const cases = [
    "/",
    "/workspace/中文项目",
    "/workspace/🦊",
    "/workspace/\u001b[31m\u202ered",
    `/workspace/${String.fromCharCode(0xd800)}`,
  ];
  for (const cwd of cases) {
    const displayName = projectInstanceDisplayName({ cwd });
    assert.match(displayName, /^[A-Za-z0-9 _-]+$/u);
    assert.ok(displayName.length <= MAX_CWD_FALLBACK_DISPLAY_NAME_CHARS);
  }
  assert.equal(projectInstanceDisplayName({ cwd: "/workspace/中文项目" }), "Work");
});
