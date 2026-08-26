#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
const stagingSigningEnvironmentPath = join(
  repositoryRoot,
  ".release-secrets",
  "android",
  "signing.env",
);
const androidJniLibrariesPath = join(
  repositoryRoot,
  "src-tauri",
  "gen",
  "android",
  "app",
  "src",
  "main",
  "jniLibs",
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
      : "请复制 .env.android.example 为 .env.android.local，或写入 corepack pnpm android config-path 显示的本机配置位置";
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
    "# Generated by corepack pnpm android setup. Do not commit this file.",
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
  corepack pnpm android config-path
  corepack pnpm android doctor
  corepack pnpm android setup
  corepack pnpm android stg
  corepack pnpm android <Tauri Android 子命令及参数>

示例：
  corepack pnpm android build --debug --apk --target aarch64 --ci`);
  showConfigurationPaths();
}

function runTauriAndroid(args, environment) {
  syncLocalProperties(environment.androidHome);
  const packageManager = process.env.npm_execpath;
  const executable = packageManager
    ? process.execPath
    : process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm";
  const command = packageManager
    ? [packageManager, "exec", "tauri", "android", ...args]
    : ["exec", "tauri", "android", ...args];
  const result = spawnSync(executable, command, {
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
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function stagingSigningEnvironment() {
  if (!existsSync(stagingSigningEnvironmentPath)) {
    throw new Error(`缺少本机签名配置：${stagingSigningEnvironmentPath}`);
  }
  const configured = parseEnv(readFileSync(stagingSigningEnvironmentPath, "utf8"));
  const names = [
    "ALUDOCK_ANDROID_KEYSTORE_PATH",
    "ALUDOCK_ANDROID_KEYSTORE_PASSWORD",
    "ALUDOCK_ANDROID_KEY_ALIAS",
    "ALUDOCK_ANDROID_KEY_PASSWORD",
  ];
  const values = {};
  for (const name of names) {
    const value = process.env[name]?.trim() || configured[name]?.trim();
    if (!value) {
      throw new Error(`本机签名配置缺少 ${name}：${stagingSigningEnvironmentPath}`);
    }
    values[name] = value;
  }
  const configuredPath = values.ALUDOCK_ANDROID_KEYSTORE_PATH
    .replaceAll("${PWD}", repositoryRoot)
    .replaceAll("$PWD", repositoryRoot);
  values.ALUDOCK_ANDROID_KEYSTORE_PATH = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(repositoryRoot, configuredPath);
  if (!existsSync(values.ALUDOCK_ANDROID_KEYSTORE_PATH)) {
    throw new Error(`本机签名证书不存在：${values.ALUDOCK_ANDROID_KEYSTORE_PATH}`);
  }
  return values;
}

function buildStagingApk(androidEnvironment) {
  const signingEnvironment = stagingSigningEnvironment();
  rmSync(androidJniLibrariesPath, { recursive: true, force: true });
  runTauriAndroid(
    ["build", "--apk", "--target", "aarch64", "--ci"],
    {
      ...androidEnvironment,
      environment: {
        ...androidEnvironment.environment,
        ...signingEnvironment,
      },
    },
  );

  const source = join(
    repositoryRoot,
    "src-tauri",
    "gen",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "universal",
    "release",
    "app-universal-release.apk",
  );
  if (!existsSync(source)) {
    throw new Error("Android staging 构建完成，但没有找到 Release APK。");
  }
  const version = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
  const outputDirectory = join(repositoryRoot, "dist");
  const output = join(outputDirectory, `AluDock-${version}-android-arm64-stg.apk`);
  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(source, output);
  console.log(`Android staging APK：${output}`);
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
  } else if (command === "stg") {
    if (args.length > 0) {
      throw new Error("corepack pnpm android stg 不接受额外参数。");
    }
    buildStagingApk(environment);
  } else {
    runTauriAndroid([command, ...args], environment);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
