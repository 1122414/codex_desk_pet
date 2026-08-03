import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcClient } from "../src/server/json-rpc-client.js";
import { inspectCodexHookInstallation } from "../src/server/codex-hook-installer.js";
import { verifyFirmwareRelease } from "../src/server/firmware-release.js";
import {
  DEVICE_BOARD_ID,
  DEVICE_FIRMWARE_VERSION,
  DEVICE_PROTOCOL_VERSION,
} from "../src/shared/device-protocol.js";
import { resolvePlatformioCommand } from "./platformio-command.mjs";
import { DEFAULT_WHISPER_MODEL_PATH } from "../src/server/local-whisper-transcriber.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredMethods = [
  "thread/list",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout || result.stderr).trim();
}

async function readTree(directory) {
  const contents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await readTree(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      contents.push(await readFile(target, "utf8"));
    }
  }
  return contents;
}

const report = {
  ok: false,
  target: {
    boardId: DEVICE_BOARD_ID,
    firmwareVersion: DEVICE_FIRMWARE_VERSION,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
  },
  node: {
    version: process.version,
    compatible: Number(process.versions.node.split(".")[0]) >= 22,
  },
  codex: {
    version: null,
    appServerConnected: false,
    appServerUserAgent: null,
    threadListReadable: false,
    schemaMethods: {},
    nativePetEvents: false,
    maturity: "experimental",
    error: null,
  },
  hooks: {
    configPath: null,
    targetScript: null,
    scriptPresent: false,
    configured: false,
    configuredEvents: [],
    error: null,
  },
  platformio: {
    version: null,
    available: false,
    error: null,
  },
  localWhisper: {
    command: process.env.CODEX_DESK_WHISPER_COMMAND ?? "whisper-cli",
    modelPath: process.env.CODEX_DESK_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL_PATH,
    executable: false,
    modelReady: false,
    error: null,
  },
  firmwareRelease: {
    directory: `dist/firmware/v${DEVICE_FIRMWARE_VERSION}`,
    verified: false,
    factoryImage: null,
    error: null,
  },
};

const codexHome = path.resolve(
  process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
);
const hookInstallation = await inspectCodexHookInstallation(codexHome);
report.hooks = {
  configPath: hookInstallation.configPath,
  targetScript: hookInstallation.targetScript,
  scriptPresent: hookInstallation.scriptPresent,
  configured: hookInstallation.configured,
  configuredEvents: hookInstallation.configuredEvents,
  error: hookInstallation.error ?? null,
};

let schemaDirectory = null;
let client = null;
try {
  report.codex.version = run("codex", ["--version"]);
  schemaDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-desk-schema-"));
  run("codex", [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    schemaDirectory,
  ]);
  const schemaText = (await readTree(schemaDirectory)).join("\n");
  report.codex.schemaMethods = Object.fromEntries(
    requiredMethods.map((method) => [method, schemaText.includes(method)]),
  );
  const documentedPetMethod = schemaText.match(
    /"(?:pet|pets)\/[A-Za-z0-9._/-]+"/g,
  );
  report.codex.nativePetEvents = Boolean(documentedPetMethod?.length);

  client = new JsonRpcClient();
  const initialized = await client.start();
  const threads = await client.request("thread/list", {
    limit: 1,
    sortKey: "recency_at",
    sortDirection: "desc",
    archived: false,
    useStateDbOnly: true,
  });
  report.codex.appServerConnected = true;
  report.codex.appServerUserAgent = initialized.userAgent ?? null;
  report.codex.threadListReadable = Array.isArray(threads.data);
} catch (error) {
  report.codex.error = error.message;
} finally {
  await client?.stop();
  if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
}

try {
  const pio = resolvePlatformioCommand();
  report.platformio.version = run(pio, ["--version"]);
  report.platformio.available = true;
} catch (error) {
  report.platformio.error = error.message;
}

try {
  run(report.localWhisper.command, ["--version"]);
  report.localWhisper.executable = true;
  await access(report.localWhisper.modelPath, constants.R_OK);
  report.localWhisper.modelReady = true;
} catch (error) {
  report.localWhisper.error = error.message;
}

try {
  const directory = path.join(root, report.firmwareRelease.directory);
  const manifest = await verifyFirmwareRelease(directory);
  report.firmwareRelease.verified = true;
  report.firmwareRelease.factoryImage = {
    file: manifest.factoryImage.file,
    bytes: manifest.factoryImage.bytes,
    sha256: manifest.factoryImage.sha256,
  };
} catch (error) {
  report.firmwareRelease.error = error.message;
}

report.ok = Boolean(
  report.node.compatible &&
  report.codex.version &&
  report.codex.appServerConnected &&
  report.codex.threadListReadable &&
  requiredMethods.every((method) => report.codex.schemaMethods[method]) &&
  report.platformio.available &&
  report.localWhisper.executable &&
  report.localWhisper.modelReady &&
  report.firmwareRelease.verified
);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
