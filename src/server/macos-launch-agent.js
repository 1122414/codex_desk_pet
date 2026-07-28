import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildMacBleHelper } from "./transports/macos-ble-device-manager.js";

export const MACOS_LAUNCH_AGENT_LABEL = "com.codex-desk.bridge";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringEntry(key, value) {
  return `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`;
}

function servicePath(nodePath, codexPath) {
  return [...new Set([
    dirname(nodePath),
    dirname(codexPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(delimiter);
}

export function buildMacosLaunchAgent({
  nodePath,
  codexPath,
  launcherPath,
  projectDirectory,
  logDirectory,
  homeDirectory = homedir(),
  path = servicePath(nodePath, codexPath),
  label = MACOS_LAUNCH_AGENT_LABEL,
} = {}) {
  for (const [name, value] of Object.entries({
    nodePath,
    codexPath,
    launcherPath,
    projectDirectory,
    logDirectory,
  })) {
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new TypeError(`${name} must be an absolute path`);
    }
  }
  const bridgeEntry = resolve(projectDirectory, "src/server/index.js");
  const stdoutPath = join(logDirectory, "bridge.log");
  const stderrPath = join(logDirectory, "bridge-error.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    stringEntry("Label", label),
    "    <key>AssociatedBundleIdentifiers</key>",
    "    <array>",
    "      <string>com.codex-desk.bridge.bluetooth</string>",
    "    </array>",
    "    <key>ProgramArguments</key>",
    "    <array>",
    `      <string>${xml(launcherPath)}</string>`,
    "      <string>--supervise</string>",
    `      <string>${xml(nodePath)}</string>`,
    `      <string>${xml(bridgeEntry)}</string>`,
    "    </array>",
    stringEntry("WorkingDirectory", resolve(projectDirectory)),
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    stringEntry("CODEX_DESK_CODEX_COMMAND", codexPath),
    stringEntry("CODEX_DESK_USB_AUTO", "1"),
    stringEntry("CODEX_DESK_BLE", "1"),
    stringEntry("CODEX_DESK_DEVICE_HOST", "0.0.0.0"),
    stringEntry("HOME", homeDirectory),
    stringEntry("NODE_ENV", "production"),
    stringEntry("PATH", path),
    "    </dict>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ThrottleInterval</key>",
    "    <integer>5</integer>",
    stringEntry("ProcessType", "Background"),
    stringEntry("LimitLoadToSessionType", "Aqua"),
    stringEntry("StandardOutPath", stdoutPath),
    stringEntry("StandardErrorPath", stderrPath),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function findExecutable(name, path = process.env.PATH ?? "") {
  if (name.includes("/")) {
    const candidate = resolve(name);
    await access(candidate, fsConstants.X_OK);
    return candidate;
  }
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching the bounded PATH supplied by the current user.
    }
  }
  throw new Error(`Cannot find executable: ${name}`);
}

async function rejectSymlink(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic link: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writePrivateFile(path, content) {
  await rejectSymlink(path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function copyRuntime(projectDirectory, applicationSupportDirectory) {
  const runtimeDirectory = join(applicationSupportDirectory, "app");
  const stagingDirectory = join(
    applicationSupportDirectory,
    `.app.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const backupDirectory = join(applicationSupportDirectory, ".app.previous");
  await mkdir(applicationSupportDirectory, { recursive: true, mode: 0o700 });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { mode: 0o700 });
  for (const entry of ["src", "public", "node_modules", "package.json"]) {
    await cp(
      join(projectDirectory, entry),
      join(stagingDirectory, entry),
      { recursive: true, errorOnExist: true, force: false },
    );
  }
  await rm(backupDirectory, { recursive: true, force: true });
  try {
    await rename(runtimeDirectory, backupDirectory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagingDirectory, runtimeDirectory);
  } catch (error) {
    await rename(backupDirectory, runtimeDirectory).catch(() => {});
    throw error;
  }
  await rm(backupDirectory, { recursive: true, force: true });
  return runtimeDirectory;
}

async function migrateLegacySettings(projectDirectory, homeDirectory) {
  const source = join(projectDirectory, ".codex-desk", "settings.json");
  const destination = join(homeDirectory, ".codex-desk", "settings.json");
  try {
    await access(destination);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Legacy Codex Desk settings are invalid");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writePrivateFile(destination, `${JSON.stringify(parsed, null, 2)}\n`);
}

function runLaunchctl(args, { allowFailure = false, launchctl = spawnSync } = {}) {
  const result = launchctl("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      result.stderr?.trim() || `launchctl ${args[0]} failed with status ${result.status}`,
    );
  }
  return result;
}

export async function installMacosLaunchAgent({
  projectDirectory = process.cwd(),
  homeDirectory = homedir(),
  nodePath = process.execPath,
  codexPath,
  path,
  uid = process.getuid(),
  launchctl = spawnSync,
  start = true,
  copyApplicationRuntime = true,
  platform = process.platform,
  buildHelper = buildMacBleHelper,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("macOS LaunchAgent installation is supported only on macOS");
  }
  const resolvedProject = resolve(projectDirectory);
  const resolvedCodex = codexPath ?? await findExecutable(
    process.env.CODEX_DESK_CODEX_COMMAND ?? "codex",
    path,
  );
  const launchAgents = join(homeDirectory, "Library", "LaunchAgents");
  const applicationSupportDirectory = join(
    homeDirectory,
    "Library",
    "Application Support",
    "CodexDeskBuddy",
  );
  const logDirectory = join(homeDirectory, "Library", "Logs", "CodexDeskBuddy");
  const plistPath = join(launchAgents, `${MACOS_LAUNCH_AGENT_LABEL}.plist`);
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await migrateLegacySettings(resolvedProject, homeDirectory);
  const runtimeDirectory = copyApplicationRuntime
    ? await copyRuntime(resolvedProject, applicationSupportDirectory)
    : resolvedProject;
  const launcherPath = await buildHelper({
    cacheRoot: join(homeDirectory, ".codex-desk", "bin"),
  });
  const plist = buildMacosLaunchAgent({
    nodePath: resolve(nodePath),
    codexPath: resolvedCodex,
    launcherPath,
    projectDirectory: runtimeDirectory,
    logDirectory,
    homeDirectory,
    path: path ?? servicePath(resolve(nodePath), resolvedCodex),
  });
  await writePrivateFile(plistPath, plist);
  if (start) {
    const domain = `gui/${uid}`;
    runLaunchctl(["bootout", domain, plistPath], { allowFailure: true, launchctl });
    runLaunchctl(["bootstrap", domain, plistPath], { launchctl });
    runLaunchctl(["enable", `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`], { launchctl });
  }
  return {
    plistPath,
    logDirectory,
    runtimeDirectory,
    nodePath: resolve(nodePath),
    codexPath: resolvedCodex,
    launcherPath,
  };
}

export async function removeMacosLaunchAgent({
  homeDirectory = homedir(),
  uid = process.getuid(),
  launchctl = spawnSync,
} = {}) {
  const plistPath = join(
    homeDirectory,
    "Library",
    "LaunchAgents",
    `${MACOS_LAUNCH_AGENT_LABEL}.plist`,
  );
  runLaunchctl(
    ["bootout", `gui/${uid}`, plistPath],
    { allowFailure: true, launchctl },
  );
  try {
    await rejectSymlink(plistPath);
    await unlink(plistPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { plistPath };
}

export function inspectMacosLaunchAgent({
  uid = process.getuid(),
  launchctl = spawnSync,
} = {}) {
  const service = `gui/${uid}/${MACOS_LAUNCH_AGENT_LABEL}`;
  const result = runLaunchctl(["print", service], { allowFailure: true, launchctl });
  return {
    loaded: result.status === 0,
    service,
    detail: (result.stdout || result.stderr || "").trim(),
  };
}
