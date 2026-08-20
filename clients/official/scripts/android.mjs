#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvironmentPath = join(repositoryRoot, ".env.android.local");
const machineConfigurationRoot = process.env.XDG_CONFIG_HOME
  ? process.env.XDG_CONFIG_HOME
  : process.platform === "win32" && process.env.APPDATA
    ? process.env.APPDATA
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".config");
const machineEnvironmentPath = join(
  machineConfigurationRoot,
  "aludock-client",
  "android.env",
);
const localPropertiesPath = join(
  repositoryRoot,
  "src-tauri",
  "gen",
  "android",
  "local.properties",
);

function loadConfiguredEnvironment() {
  const values = {};
  const sources = [];
  for (const path of [machineEnvironmentPath, localEnvironmentPath]) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      Object.assign(values, parseEnv(readFileSync(path, "utf8")));
      sources.push(path);
    } catch (error) {
      throw new Error(
        `无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { sources, values };
}

function firstConfigured(localEnvironment, names) {
  for (const name of names) {
    const localValue = localEnvironment[name]?.trim();
    if (localValue) {
      return localValue;
    }
  }
  for (const name of names) {
    const inheritedValue = process.env[name]?.trim();
    if (inheritedValue) {
      return inheritedValue;
    }
  }
  return undefined;
}

function executablePath(directory, executable) {
  return join(directory, "bin", process.platform === "win32" ? `${executable}.exe` : executable);
}

function requireDirectoryPath(name, value, errors) {
  if (!value) {
    errors.push(`${name} 未配置`);
    return;
  }
  if (!isAbsolute(value)) {
    errors.push(`${name} 必须是绝对路径：${value}`);
    return;
  }
  if (!existsSync(value)) {
    errors.push(`${name} 指向的目录不存在：${value}`);
  }
}

function readProperty(path, propertyName) {
  if (!existsSync(path)) {
    return undefined;
  }
  const prefix = `${propertyName} =`;
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(prefix));
  return line?.slice(line.indexOf(prefix) + prefix.length).trim();
}

function resolveAndroidEnvironment() {
  const configuredEnvironment = loadConfiguredEnvironment();
  const javaHome = firstConfigured(configuredEnvironment.values, ["JAVA_HOME"]);
  const androidHome = firstConfigured(configuredEnvironment.values, [
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
  ]);
  const ndkHome = firstConfigured(configuredEnvironment.values, [
    "NDK_HOME",
    "ANDROID_NDK_HOME",
  ]);

  const errors = [];
  requireDirectoryPath("JAVA_HOME", javaHome, errors);
  requireDirectoryPath("ANDROID_HOME", androidHome, errors);
  requireDirectoryPath("NDK_HOME", ndkHome, errors);

  if (javaHome && !existsSync(executablePath(javaHome, "java"))) {
    errors.push(`JAVA_HOME 中没有找到 Java：${javaHome}`);
  }
  if (androidHome) {
    const adbName = process.platform === "win32" ? "adb.exe" : "adb";
    if (!existsSync(join(androidHome, "platform-tools", adbName))) {
      errors.push(`Android SDK 中没有找到 platform-tools：${androidHome}`);
    }
  }
  if (ndkHome && !existsSync(join(ndkHome, "source.properties"))) {
    errors.push(`NDK 目录中没有找到 source.properties：${ndkHome}`);
  }

  if (errors.length > 0) {
    const setupHint = configuredEnvironment.sources.length > 0
      ? `请检查 ${configuredEnvironment.sources.join("、")}`
      : "请复制 .env.android.example 为 .env.android.local，或写入 pnpm android config-path 显示的本机配置位置";
    throw new Error(`${errors.join("\n")}\n${setupHint}`);
  }

  const pathEntries = [
    join(javaHome, "bin"),
    join(androidHome, "platform-tools"),
    join(androidHome, "emulator"),
    join(androidHome, "cmdline-tools", "latest", "bin"),
  ];
  const inheritedPath = process.env.PATH ?? "";
  const environment = {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    NDK_HOME: ndkHome,
    ANDROID_NDK_HOME: ndkHome,
    PATH: [...pathEntries, inheritedPath].filter(Boolean).join(delimiter),
  };

  return {
    androidHome,
    environment,
    javaHome,
    ndkHome,
    source:
      configuredEnvironment.sources.length > 0
        ? configuredEnvironment.sources.join("、")
        : "当前进程的环境变量",
  };
}

function probeJava(javaHome) {
  const result = spawnSync(executablePath(javaHome, "java"), ["-version"], {
    encoding: "utf8",
  });
  if (result.error) {
    return `无法运行：${result.error.message}`;
  }
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return output.split(/\r?\n/u)[0] || `退出状态 ${result.status ?? "未知"}`;
}

function showDoctor(environment) {
  const ndkRevision = readProperty(
    join(environment.ndkHome, "source.properties"),
    "Pkg.Revision",
  );
  console.log(`配置来源：${environment.source}`);
  console.log(`JAVA_HOME=${environment.javaHome}`);
  console.log(`ANDROID_HOME=${environment.androidHome}`);
  console.log(`NDK_HOME=${environment.ndkHome}`);
  console.log(`Java：${probeJava(environment.javaHome)}`);
  console.log(`NDK：${ndkRevision ?? "无法读取版本"}`);
}

function escapeLocalPropertyPath(value) {
  return value.replaceAll("\\", "/").replaceAll(":", "\\:");
}

function syncLocalProperties(androidHome) {
  const content = [
    "# Generated by pnpm android setup. Do not commit this file.",
    `sdk.dir=${escapeLocalPropertyPath(androidHome)}`,
    "",
  ].join("\n");
  mkdirSync(dirname(localPropertiesPath), { recursive: true });
  if (!existsSync(localPropertiesPath) || readFileSync(localPropertiesPath, "utf8") !== content) {
    writeFileSync(localPropertiesPath, content, "utf8");
  }
  console.log(`已更新 ${localPropertiesPath}`);
}

function showConfigurationPaths() {
  console.log(`本机共享配置：${machineEnvironmentPath}`);
  console.log(`当前工作区覆盖：${localEnvironmentPath}`);
}

function showUsage() {
  console.log(`用法：
  pnpm android config-path
  pnpm android doctor
  pnpm android setup
  pnpm android <Tauri Android 子命令及参数>

示例：
  pnpm android build --debug --apk --target aarch64 --ci`);
  showConfigurationPaths();
}

function runTauriAndroid(args, environment) {
  syncLocalProperties(environment.androidHome);
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, ["exec", "tauri", "android", ...args], {
    cwd: repositoryRoot,
    env: environment.environment,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    console.error(`Android 命令被信号 ${result.signal} 中止`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    showUsage();
    process.exit(0);
  }
  if (command === "config-path") {
    showConfigurationPaths();
    process.exit(0);
  }

  const environment = resolveAndroidEnvironment();
  if (command === "doctor") {
    showDoctor(environment);
  } else if (command === "setup") {
    showDoctor(environment);
    syncLocalProperties(environment.androidHome);
  } else {
    runTauriAndroid([command, ...args], environment);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
