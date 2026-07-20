import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { CODEX_HOOK_EVENTS } from "./codex-hook.js";

const STATUS_MESSAGE = "同步 Codex Desk Buddy 状态";

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function windowsQuote(value) {
  if (value.includes("\"")) throw new Error("Codex home path contains an unsupported quote");
  return `"${value}"`;
}

async function readHooks(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!plainObject(parsed) || (parsed.hooks !== undefined && !plainObject(parsed.hooks))) {
      throw new Error("Existing Codex hooks file has an unsupported structure");
    }
    return { ...parsed, hooks: { ...(parsed.hooks ?? {}) } };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        description: "User-level Codex lifecycle hooks.",
        hooks: {},
      };
    }
    if (error instanceof SyntaxError) throw new Error("Existing Codex hooks file is not valid JSON");
    throw error;
  }
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function withoutDeskBuddyHandlers(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!plainObject(group) || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((handler) =>
      !plainObject(handler) || handler.statusMessage !== STATUS_MESSAGE);
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

function groupFor(event, command, commandWindows) {
  return {
    ...(event === "SessionStart"
      ? { matcher: "startup|resume|clear|compact" }
      : ["PreToolUse", "PermissionRequest", "PostToolUse"].includes(event)
        ? { matcher: "*" }
        : {}),
    hooks: [{
      type: "command",
      command,
      commandWindows,
      timeout: event === "PermissionRequest" ? 120 : 3,
      statusMessage: STATUS_MESSAGE,
    }],
  };
}

export async function inspectCodexHookInstallation(codexHome) {
  const root = path.resolve(codexHome);
  const configPath = path.join(root, "hooks.json");
  const targetScript = path.join(root, "codex-desk", "hooks", "forward-hook.mjs");
  try {
    const config = await readHooks(configPath);
    const scriptPresent = await access(targetScript).then(() => true).catch(() => false);
    const command = `node ${shellQuote(targetScript)}`;
    const commandWindows = `node ${windowsQuote(targetScript)}`;
    const configuredEvents = CODEX_HOOK_EVENTS.filter((event) =>
      Array.isArray(config.hooks[event]) &&
      config.hooks[event].some((group) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((handler) =>
          handler?.statusMessage === STATUS_MESSAGE &&
          handler?.command === command &&
          handler?.commandWindows === commandWindows &&
          handler?.timeout === (event === "PermissionRequest" ? 120 : 3))));
    return {
      configured: scriptPresent && configuredEvents.length === CODEX_HOOK_EVENTS.length,
      configuredEvents,
      configPath,
      targetScript,
      scriptPresent,
    };
  } catch (error) {
    return {
      configured: false,
      configuredEvents: [],
      configPath,
      targetScript,
      scriptPresent: false,
      error: error.message,
    };
  }
}

export async function installCodexHooks({ codexHome, sourceScript }) {
  const root = path.resolve(codexHome);
  const source = path.resolve(sourceScript);
  const hookDirectory = path.join(root, "codex-desk", "hooks");
  const targetScript = path.join(hookDirectory, "forward-hook.mjs");
  const configPath = path.join(root, "hooks.json");
  const script = await readFile(source, "utf8");
  const config = await readHooks(configPath);
  const command = `node ${shellQuote(targetScript)}`;
  const commandWindows = `node ${windowsQuote(targetScript)}`;

  await mkdir(hookDirectory, { recursive: true, mode: 0o700 });
  await chmod(hookDirectory, 0o700);
  await atomicWrite(targetScript, script);
  for (const event of CODEX_HOOK_EVENTS) {
    config.hooks[event] = [
      ...withoutDeskBuddyHandlers(config.hooks[event]),
      groupFor(event, command, commandWindows),
    ];
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    configPath,
    targetScript,
    configuredEvents: [...CODEX_HOOK_EVENTS],
  };
}

export async function removeCodexHooks({ codexHome }) {
  const root = path.resolve(codexHome);
  const configPath = path.join(root, "hooks.json");
  const targetScript = path.join(root, "codex-desk", "hooks", "forward-hook.mjs");
  const config = await readHooks(configPath);
  for (const event of CODEX_HOOK_EVENTS) {
    config.hooks[event] = withoutDeskBuddyHandlers(config.hooks[event]);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await unlink(targetScript).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return { configPath, targetScript };
}
