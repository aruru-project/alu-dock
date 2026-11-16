import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// These public SDK functions only parse and format skills. No Agent, resource loader, extensions,
// settings, project context or personal Pi identity is created here.
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import type { DiagnosticDto, ResourceDto, SourceDto } from "../core/config-projection.js";
import { documentResource } from "./resource-files.js";

export interface AgentSkillSource { path: string; source: SourceDto }
export interface AgentSkillDeclaration {
  /** A local extension's optional `skills` list. Invalid lists diagnose only the manuals. */
  paths: unknown;
  /** Module directory for factory declarations; config file directory for configured declarations.
   * Built-in factories have no local module path and must return absolute paths. */
  baseDir?: string;
  source: SourceDto;
}

/** Shared packaged manual location, usable by native loaders too. */
export function bundledDockSkillPath(name: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, `../../skills/${name}/SKILL.md`),
    resolve(moduleDirectory, `../../../skills/${name}/SKILL.md`),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
}

/** Only explicit common skill locations; never the Pi user identity or its package settings. */
function commonSkillPaths(cwd: string): string[] {
  const paths = [join(cwd, ".pi", "skills")];
  let directory = cwd;
  while (true) {
    paths.push(join(directory, ".agents", "skills"));
    const parent = dirname(directory);
    if (existsSync(join(directory, ".git")) || parent === directory) break;
    directory = parent;
  }
  paths.push(join(homedir(), ".aludock", "skills"), join(homedir(), ".agents", "skills"));
  return [...new Set(paths)];
}

/** Discover on a normal adapter boundary (new reply, startup, Reload), not a watcher or model call. */
export class AgentSkills {
  resources: ResourceDto[] = [];
  diagnostics: DiagnosticDto[] = [];
  prompt = "";

  constructor(private readonly cwd: string) {}

  refresh(declarations: readonly AgentSkillDeclaration[] = [], supplied: readonly AgentSkillSource[] = []): boolean {
    const diagnostics: DiagnosticDto[] = [];
    const sources: AgentSkillSource[] = [];
    for (const path of commonSkillPaths(resolve(this.cwd))) {
      // Missing conventional directories are normal. Explicit missing paths below are diagnosed by
      // the SDK. A dangling conventional link is still a configured but broken location.
      try { lstatSync(path); sources.push({ path, source: { kind: "skill", path } }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(warning("无法查看技能目录，请检查读取权限后重试。", path));
      }
    }
    sources.push(...supplied);
    for (const declaration of declarations) {
      if (declaration.paths === undefined) continue;
      if (!Array.isArray(declaration.paths)) {
        diagnostics.push(warning("技能声明需要 skills 路径数组；工具和命令仍可使用。", declaration.source.path));
        continue;
      }
      for (const path of declaration.paths) {
        if (typeof path !== "string" || !path.trim() || path.includes("\0") || (!isAbsolute(path) && declaration.baseDir === undefined)) {
          diagnostics.push(warning("技能路径无效；本机扩展使用相对模块的路径，随包扩展使用绝对路径。工具和命令仍可使用。", declaration.source.path));
          continue;
        }
        sources.push({ path: resolve(declaration.baseDir ?? this.cwd, path), source: declaration.source });
      }
    }
    for (const { path } of sources) {
      try { accessSync(path, constants.R_OK); }
      catch (error) {
        // The SDK diagnoses missing files and malformed frontmatter, but silently skips directories
        // it cannot traverse. Report unreadable declared roots without replacing its discovery.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(warning("无法读取技能来源，请检查读取权限后重试。", path));
      }
    }
    const loaded = loadSkills({ cwd: this.cwd, agentDir: this.cwd, skillPaths: sources.map(source => source.path), includeDefaults: false });
    this.resources = loaded.skills.map(skill => documentResource("skill", skill.name, skill.filePath,
      sources.find(source => contains(source.path, skill.filePath))?.source ?? { kind: "skill", path: skill.filePath }));
    this.diagnostics = [...diagnostics, ...loaded.diagnostics.map(diagnostic => warning(
      diagnostic.collision
        ? `${diagnostic.message}; using ${diagnostic.collision.winnerPath}`
        : diagnostic.message,
      diagnostic.path,
    ))];
    const index = formatSkillsForPrompt(loaded.skills);
    const prompt = index ? `${index}\nBefore using tools covered by a matching skill, read that skill's file and follow its instructions. Skill files do not grant tools or permissions that this Agent does not have.` : "";
    const changed = prompt !== this.prompt;
    this.prompt = prompt;
    return changed;
  }
}

function contains(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function warning(message: string, source?: string): DiagnosticDto {
  return { severity: "warning", message: message.slice(0, 2_048) || "技能文件未加载，请检查文件。", ...(source ? { source: source.slice(0, 256) } : {}) };
}
