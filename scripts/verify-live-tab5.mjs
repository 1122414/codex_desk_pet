import { pathToFileURL } from "node:url";
import {
  DEVICE_BOARD_ID,
  DEVICE_FIRMWARE_VERSION,
  DEVICE_PROTOCOL_VERSION,
} from "../src/shared/device-protocol.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4317";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 750;
const REQUIRED_CAPABILITIES = Object.freeze([
  "touch",
  "speaker",
  "offlineChineseVoice",
  "usb",
  "wifi",
  "ble",
  "microSd",
  "rtc",
  "camera",
]);
const LIVE_EVIDENCE = new Set(["voice", "vision"]);

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return number;
}

function normalizeBaseUrl(value) {
  const url = new URL(value ?? DEFAULT_BASE_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error("真机验收只允许读取本机回环 Bridge");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseWaitFor(value) {
  if (!value) return [];
  const items = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  for (const item of items) {
    if (!LIVE_EVIDENCE.has(item)) {
      throw new Error(`未知的真机证据：${item}`);
    }
  }
  return items;
}

export function parseLiveTab5Arguments(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    waitFor: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") {
      options.baseUrl = argv[++index];
      if (options.baseUrl === undefined) throw new Error("--url 缺少参数");
    } else if (argument === "--wait-for") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--wait-for 缺少参数");
      options.waitFor = parseWaitFor(value);
    } else if (argument === "--timeout-ms") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--timeout-ms 缺少参数");
      options.timeoutMs = parsePositiveInteger(value, "--timeout-ms");
    } else if (argument === "--poll-ms") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--poll-ms 缺少参数");
      options.pollMs = parsePositiveInteger(value, "--poll-ms");
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function evidenceSummary(snapshot) {
  return {
    voice: {
      completed:
        snapshot?.voice?.status === "completed" &&
        typeof snapshot.voice.transcript === "string" &&
        snapshot.voice.transcript.trim().length > 0 &&
        !snapshot.voice.error,
      status: snapshot?.voice?.status ?? "missing",
      transcriptCharacters: snapshot?.voice?.transcript?.trim().length ?? 0,
      updatedAt: snapshot?.voice?.updatedAt ?? null,
    },
    vision: {
      completed:
        snapshot?.vision?.status === "completed" &&
        Number.isInteger(snapshot.vision.bytes) &&
        snapshot.vision.bytes > 0 &&
        typeof snapshot.vision.reply === "string" &&
        snapshot.vision.reply.trim().length > 0 &&
        !snapshot.vision.error,
      status: snapshot?.vision?.status ?? "missing",
      width: snapshot?.vision?.width ?? null,
      height: snapshot?.vision?.height ?? null,
      bytes: snapshot?.vision?.bytes ?? null,
      replyCharacters: snapshot?.vision?.reply?.trim().length ?? 0,
      updatedAt: snapshot?.vision?.updatedAt ?? null,
    },
  };
}

export function evaluateLiveTab5({ devices, snapshot, pets }) {
  const connected = devices?.devices?.filter((device) => device.connected) ?? [];
  requireCondition(connected.length === 1, "必须且只能有一台已连接的真机");
  const device = connected[0];
  requireCondition(device.deviceInfo?.boardId === DEVICE_BOARD_ID, "连接的设备不是目标 Tab5 K145");
  requireCondition(
    device.deviceInfo?.firmwareVersion === DEVICE_FIRMWARE_VERSION,
    `真机固件必须为 ${DEVICE_FIRMWARE_VERSION}`,
  );
  requireCondition(device.protocolVersion === DEVICE_PROTOCOL_VERSION, "真机协议版本不匹配");
  requireCondition(device.compatibility?.compatible === true, "真机兼容性检查未通过");
  for (const capability of REQUIRED_CAPABILITIES) {
    requireCondition(device.deviceInfo?.capabilities?.[capability] === true, `真机未声明 ${capability} 能力`);
  }
  requireCondition(device.deviceInfo?.health?.voiceDataReady === true, "真机中文语音数据未就绪");
  requireCondition(device.deviceInfo?.health?.storageReady === true, "真机 microSD 未就绪");
  requireCondition(device.transports?.includes("usb"), "真机当前没有加密 USB 链路");
  requireCondition(device.transports?.some((kind) => ["ble", "wifi"].includes(kind)), "真机当前没有无线备用链路");

  requireCondition(snapshot?.connection?.status === "connected", "Codex Bridge 当前未连接");
  requireCondition(snapshot?.telemetry?.deviceId === device.deviceId, "遥测没有绑定当前真机");
  requireCondition(snapshot?.capabilities?.voice === true, "Bridge 未开放语音能力");
  requireCondition(snapshot?.capabilities?.vision === true, "Bridge 未开放视觉能力");
  requireCondition(snapshot?.accountTokens?.todayAvailable === true, "今日 Token 统计不可用");
  requireCondition(Number.isSafeInteger(snapshot.accountTokens.today), "今日 Token 不是可靠整数");
  requireCondition(Number.isSafeInteger(snapshot.tokens?.total), "当前任务 Token 不是可靠整数");

  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  requireCondition(tasks.length > 0, "Bridge 没有最近任务");
  for (let index = 1; index < tasks.length; index += 1) {
    requireCondition(
      Number(tasks[index - 1].updatedAt) >= Number(tasks[index].updatedAt),
      "最近任务没有按时间倒序排列",
    );
  }

  const availablePets = pets?.pets ?? [];
  requireCondition(
    availablePets.some((pet) => pet.id === snapshot?.pet?.selectedId),
    "当前 Pet 不在 Bridge 目录中",
  );

  return {
    checkedAt: new Date().toISOString(),
    device: {
      deviceId: device.deviceId,
      boardId: device.deviceInfo.boardId,
      firmwareVersion: device.deviceInfo.firmwareVersion,
      protocolVersion: device.protocolVersion,
      transports: [...device.transports],
      primaryTransport: device.primaryTransport,
      storageReady: device.deviceInfo.health.storageReady,
      voiceDataReady: device.deviceInfo.health.voiceDataReady,
    },
    codex: {
      connected: true,
      visibleTasks: tasks.length,
      newestTaskFirst: true,
      currentTaskTokens: snapshot.tokens.total,
      todayTokens: snapshot.accountTokens.today,
      todayTokensAvailable: snapshot.accountTokens.todayAvailable,
    },
    pet: {
      selectedId: snapshot.pet.selectedId,
      available: availablePets.map((pet) => pet.id),
    },
    evidence: evidenceSummary(snapshot),
  };
}

async function readJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${route} 返回 HTTP ${response.status}`);
  return response.json();
}

async function readState(baseUrl, cachedPets = null) {
  const requests = [
    readJson(baseUrl, "/api/devices"),
    readJson(baseUrl, "/api/snapshot"),
  ];
  if (!cachedPets) requests.push(readJson(baseUrl, "/api/pets"));
  const [devices, snapshot, pets = cachedPets] = await Promise.all(requests);
  return { devices, snapshot, pets };
}

function pendingEvidence(report, waitFor) {
  return waitFor.filter((item) => !report.evidence[item]?.completed);
}

export async function verifyLiveTab5({
  baseUrl = DEFAULT_BASE_URL,
  waitFor = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const initialState = await readState(normalizedBaseUrl);
  const cachedPets = initialState.pets;
  let report = evaluateLiveTab5(initialState);
  let pending = pendingEvidence(report, waitFor);
  const startedAt = Date.now();
  while (pending.length > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待真机证据超时：${pending.join("、")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    report = evaluateLiveTab5(await readState(normalizedBaseUrl, cachedPets));
    pending = pendingEvidence(report, waitFor);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseLiveTab5Arguments(process.argv.slice(2));
  const report = await verifyLiveTab5(options);
  process.stdout.write(`Tab5 只读真机验收通过\n${JSON.stringify(report, null, 2)}\n`);
}
