import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  analyzeHardwareAcceptance,
  createHardwareAcceptanceRecord,
  mergeHardwareAcceptanceEvents,
  normalizeHardwareAcceptanceSample,
} from "../src/shared/hardware-acceptance.js";

const arguments_ = process.argv.slice(2);
const defaults = {
  baseUrl: "http://127.0.0.1:4317",
  durationHours: 24,
  sampleIntervalSeconds: 30,
  deviceId: null,
  careEventsPath: path.join(os.homedir(), ".codex-desk", "care-events.jsonl"),
  outputPath: null,
  resumePath: null,
  triggerObservation: false,
  requireWifiReconnect: true,
};

function usage() {
  return [
    "用法：npm run acceptance:hardware -- [选项]",
    "  --duration-hours <小时>       默认 24，最大 168",
    "  --sample-seconds <秒>         默认 30",
    "  --device-id <Tab5 ID>         可选；默认选择已连接的 Tab5",
    "  --base-url <本机 Bridge URL>  默认 http://127.0.0.1:4317",
    "  --care-events <JSONL 路径>    默认 ~/.codex-desk/care-events.jsonl",
    "  --output <报告路径>           默认 output/hardware-care-acceptance/<时间>.json",
    "  --resume <报告路径>           从已有原子检查点继续",
    "  --trigger-observation         启动后通过 CSRF API 立即观察一次",
    "  --no-require-wifi-reconnect   仅用于预检；最终验收必须验证 Wi-Fi 重连",
  ].join("\n");
}

function valueAfter(name) {
  const index = arguments_.indexOf(name);
  if (index === -1) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

function parseOptions() {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const known = new Set([
    "--duration-hours",
    "--sample-seconds",
    "--device-id",
    "--base-url",
    "--care-events",
    "--output",
    "--resume",
    "--trigger-observation",
    "--no-require-wifi-reconnect",
    "--help",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!known.has(argument)) throw new Error(`未知参数：${argument}`);
    if (
      !["--trigger-observation", "--no-require-wifi-reconnect", "--help"]
        .includes(argument)
    ) {
      index += 1;
    }
  }
  const baseUrl = new URL(valueAfter("--base-url") ?? defaults.baseUrl);
  if (
    baseUrl.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(baseUrl.hostname)
  ) {
    throw new Error("真机验收只允许连接本机 HTTP Bridge");
  }
  const durationHours = Number(
    valueAfter("--duration-hours") ?? defaults.durationHours,
  );
  const sampleIntervalSeconds = Number(
    valueAfter("--sample-seconds") ?? defaults.sampleIntervalSeconds,
  );
  const resumePath = valueAfter("--resume");
  const outputPath = valueAfter("--output");
  if (resumePath && outputPath && path.resolve(resumePath) !== path.resolve(outputPath)) {
    throw new Error("--resume 与 --output 必须指向同一个文件");
  }
  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    durationHours,
    sampleIntervalSeconds,
    deviceId: valueAfter("--device-id"),
    careEventsPath: path.resolve(
      valueAfter("--care-events") ?? defaults.careEventsPath,
    ),
    outputPath: outputPath ? path.resolve(outputPath) : null,
    resumePath: resumePath ? path.resolve(resumePath) : null,
    triggerObservation: arguments_.includes("--trigger-observation"),
    requireWifiReconnect:
      !arguments_.includes("--no-require-wifi-reconnect"),
  };
}

async function readCareEvents(filePath) {
  const events = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  input.on("error", () => {});
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim() || Buffer.byteLength(line) > 16 * 1024) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === "object") events.push(event);
      } catch {
        // The Bridge may be appending the final line while this read is in progress.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return events.slice(-5_000);
}

async function fetchJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${route} 返回 HTTP ${response.status}`);
  return response.json();
}

async function sampleBridge(options) {
  const occurredAt = Date.now();
  try {
    const [snapshot, diagnostics, deviceResult, events] = await Promise.all([
      fetchJson(options.baseUrl, "/api/snapshot"),
      fetchJson(options.baseUrl, "/api/diagnostics"),
      fetchJson(options.baseUrl, "/api/devices"),
      readCareEvents(options.careEventsPath),
    ]);
    return {
      sample: normalizeHardwareAcceptanceSample({
        occurredAt,
        snapshot,
        diagnostics,
        devices: deviceResult.devices,
        deviceId: options.deviceId,
      }),
      events,
    };
  } catch (error) {
    return {
      sample: normalizeHardwareAcceptanceSample({ occurredAt, error }),
      events: await readCareEvents(options.careEventsPath).catch(() => []),
    };
  }
}

async function triggerObservation(baseUrl) {
  const session = await fetch(`${baseUrl}/api/session`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!session.ok) throw new Error(`会话初始化返回 HTTP ${session.status}`);
  const { csrfToken } = await session.json();
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  if (!csrfToken || !cookie) throw new Error("Bridge 没有返回 CSRF 会话");
  const response = await fetch(`${baseUrl}/api/care/observe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: baseUrl,
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({
      commandId: `hardware-acceptance-${randomUUID()}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `立即观察返回 HTTP ${response.status}`);
  }
  return result;
}

async function saveRecord(filePath, record) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function loadRecord(filePath) {
  const record = JSON.parse(await readFile(filePath, "utf8"));
  if (
    record?.schemaVersion !== 1 ||
    !Array.isArray(record.samples) ||
    !Array.isArray(record.events)
  ) {
    throw new Error("恢复文件不是真机验收记录");
  }
  return record;
}

function defaultOutputPath(startedAt) {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return path.resolve("output", "hardware-care-acceptance", `${stamp}.json`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const options = parseOptions();
let record;
let outputPath;
if (options.resumePath) {
  record = await loadRecord(options.resumePath);
  outputPath = options.resumePath;
  if (options.deviceId && record.deviceId && options.deviceId !== record.deviceId) {
    throw new Error("恢复记录的设备 ID 与本次参数不一致");
  }
  options.deviceId ??= record.deviceId;
} else {
  record = createHardwareAcceptanceRecord({
    durationHours: options.durationHours,
    sampleIntervalSeconds: options.sampleIntervalSeconds,
    deviceId: options.deviceId,
    requireWifiReconnect: options.requireWifiReconnect,
  });
  outputPath = options.outputPath ?? defaultOutputPath(record.startedAt);
}

let stopRequested = false;
process.once("SIGINT", () => {
  stopRequested = true;
  process.stdout.write("\n收到停止信号，正在保存部分验收报告……\n");
});
process.once("SIGTERM", () => {
  stopRequested = true;
});

if (options.triggerObservation && !record.trigger) {
  try {
    record.trigger = {
      occurredAt: Date.now(),
      ok: true,
      result: await triggerObservation(options.baseUrl),
    };
  } catch (error) {
    record.trigger = {
      occurredAt: Date.now(),
      ok: false,
      error: error.message,
    };
  }
  await saveRecord(outputPath, record);
}

const deadline = record.startedAt + record.targetDurationMs;
while (!stopRequested) {
  const { sample, events } = await sampleBridge(options);
  record.samples.push(sample);
  mergeHardwareAcceptanceEvents(record, events);
  record.report = analyzeHardwareAcceptance(record);
  await saveRecord(outputPath, record);
  process.stdout.write(
    `[${new Date(sample.occurredAt).toISOString()}] ` +
    `设备=${sample.device?.connected ? sample.device.primaryTransport : "离线"} ` +
    `关怀=${sample.care.status ?? "未知"} ` +
    `样本=${record.samples.length} 记录=${outputPath}\n`,
  );
  if (Date.now() >= deadline) break;
  await wait(Math.min(record.sampleIntervalMs, Math.max(1, deadline - Date.now())));
}

record.report = analyzeHardwareAcceptance(record);
await saveRecord(outputPath, record);
process.stdout.write(
  `${record.report.passed ? "真机验收通过" : "真机验收尚未通过"}：${outputPath}\n` +
  `${JSON.stringify(record.report, null, 2)}\n`,
);
if (!record.report.passed) process.exitCode = 1;
