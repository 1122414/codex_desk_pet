import { randomUUID } from "node:crypto";
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

export const CARE_ACTION_NAMES = Object.freeze([
  "capture_now",
  "set_tab5_brightness",
  "set_tab5_volume",
  "open_app",
  "open_media_preset",
  "set_macos_volume",
  "schedule_follow_up",
]);

const DEFAULT_PERSONA = "你是住在桌面设备里的陪伴伙伴。自然、简短地关心用户，先观察和倾听，不要把每次画面都解读成问题。";
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,159}$/;
const CARE_SETTING_KEYS = new Set([
  "enabled",
  "observationMinimumMinutes",
  "observationMaximumMinutes",
  "autoListenSeconds",
  "duplicateGuardSeconds",
  "persona",
  "allowedActions",
  "appPresets",
  "mediaPresets",
]);

export const DEFAULT_CARE_SETTINGS = Object.freeze({
  enabled: true,
  observationMinimumMinutes: 10,
  observationMaximumMinutes: 30,
  autoListenSeconds: 20,
  duplicateGuardSeconds: 90,
  persona: DEFAULT_PERSONA,
  allowedActions: Object.freeze([...CARE_ACTION_NAMES]),
  appPresets: Object.freeze([]),
  mediaPresets: Object.freeze([]),
});

export const DEFAULT_SETTINGS = Object.freeze({
  selectedPetId: "codex-core",
  care: DEFAULT_CARE_SETTINGS,
});

function boundedInteger(value, fallback, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function boundedText(value, fallback, maximumLength) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactObject(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`${label}格式无效`);
  }
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label}必须是 ${minimum}～${maximum} 的整数`);
  }
}

function validateAppPresets(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError("应用预设必须是不超过 20 项的数组");
  }
  const ids = new Set();
  return value.map((preset) => {
    requireExactObject(preset, ["id", "label", "bundleId"], "应用预设");
    const id = typeof preset.id === "string" ? preset.id.trim() : "";
    const label = typeof preset.label === "string" ? preset.label.trim() : "";
    const bundleId = typeof preset.bundleId === "string" ? preset.bundleId.trim() : "";
    if (!PRESET_ID_PATTERN.test(id) || ids.has(id)) throw new TypeError("应用预设 ID 无效或重复");
    if (!label || label.length > 80) throw new TypeError("应用预设名称必须是 1～80 个字符");
    if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new TypeError("应用预设 Bundle ID 无效");
    ids.add(id);
    return { id, label, bundleId };
  });
}

function validateMediaPresets(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError("媒体预设必须是不超过 20 项的数组");
  }
  const ids = new Set();
  return value.map((preset) => {
    requireExactObject(preset, ["id", "label", "url"], "媒体预设");
    const id = typeof preset.id === "string" ? preset.id.trim() : "";
    const label = typeof preset.label === "string" ? preset.label.trim() : "";
    const rawUrl = typeof preset.url === "string" ? preset.url.trim() : "";
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new TypeError("媒体预设 URL 无效");
    }
    if (!PRESET_ID_PATTERN.test(id) || ids.has(id)) throw new TypeError("媒体预设 ID 无效或重复");
    if (!label || label.length > 80) throw new TypeError("媒体预设名称必须是 1～80 个字符");
    if (!["http:", "https:"].includes(url.protocol) || rawUrl.length > 2_048) {
      throw new TypeError("媒体预设只允许不超过 2048 个字符的 HTTP(S) URL");
    }
    ids.add(id);
    return { id, label, url: url.toString() };
  });
}

export function validateCareSettingsPatch(value, current = DEFAULT_CARE_SETTINGS) {
  if (!isRecord(value)) throw new TypeError("主动关怀设置必须是对象");
  const unknownKey = Object.keys(value).find((key) => !CARE_SETTING_KEYS.has(key));
  if (unknownKey) throw new TypeError(`未知的主动关怀设置：${unknownKey}`);
  const existing = normalizeCareSettings(current);
  const next = { ...existing };

  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") throw new TypeError("主动关怀开关必须是布尔值");
    next.enabled = value.enabled;
  }
  for (const [key, minimum, maximum, label] of [
    ["observationMinimumMinutes", 1, 120, "最短观察间隔"],
    ["observationMaximumMinutes", 1, 120, "最长观察间隔"],
    ["autoListenSeconds", 5, 60, "自动聆听时长"],
    ["duplicateGuardSeconds", 30, 600, "重复观察保护时长"],
  ]) {
    if (Object.hasOwn(value, key)) {
      requireInteger(value[key], minimum, maximum, label);
      next[key] = value[key];
    }
  }
  if (next.observationMinimumMinutes > next.observationMaximumMinutes) {
    throw new RangeError("最短观察间隔不能大于最长观察间隔");
  }
  if (Object.hasOwn(value, "persona")) {
    if (typeof value.persona !== "string") throw new TypeError("AI 人设必须是文本");
    const persona = value.persona.trim();
    if (!persona || persona.length > 2_000) throw new RangeError("AI 人设必须是 1～2000 个字符");
    next.persona = persona;
  }
  if (Object.hasOwn(value, "allowedActions")) {
    if (!Array.isArray(value.allowedActions)) throw new TypeError("允许动作必须是数组");
    const allowed = new Set();
    for (const name of value.allowedActions) {
      if (typeof name !== "string" || !CARE_ACTION_NAMES.includes(name)) {
        throw new TypeError(`未知的主动关怀动作：${String(name)}`);
      }
      if (allowed.has(name)) throw new TypeError(`主动关怀动作重复：${name}`);
      allowed.add(name);
    }
    next.allowedActions = CARE_ACTION_NAMES.filter((name) => allowed.has(name));
  }
  if (Object.hasOwn(value, "appPresets")) next.appPresets = validateAppPresets(value.appPresets);
  if (Object.hasOwn(value, "mediaPresets")) next.mediaPresets = validateMediaPresets(value.mediaPresets);
  return next;
}

function normalizeAppPresets(value) {
  if (!Array.isArray(value)) return [];
  const presets = [];
  const ids = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const bundleId = typeof candidate.bundleId === "string" ? candidate.bundleId.trim() : "";
    if (!PRESET_ID_PATTERN.test(id) || !BUNDLE_ID_PATTERN.test(bundleId) || ids.has(id)) continue;
    ids.add(id);
    presets.push({
      id,
      label: boundedText(candidate.label, id, 80),
      bundleId,
    });
    if (presets.length >= 20) break;
  }
  return presets;
}

function normalizeMediaPresets(value) {
  if (!Array.isArray(value)) return [];
  const presets = [];
  const ids = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const rawUrl = typeof candidate.url === "string" ? candidate.url.trim() : "";
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (
      !PRESET_ID_PATTERN.test(id) ||
      ids.has(id) ||
      !["http:", "https:"].includes(url.protocol) ||
      rawUrl.length > 2_048
    ) {
      continue;
    }
    ids.add(id);
    presets.push({
      id,
      label: boundedText(candidate.label, id, 80),
      url: url.toString(),
    });
    if (presets.length >= 20) break;
  }
  return presets;
}

export function normalizeCareSettings(value = {}) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const observationMinimumMinutes = boundedInteger(
    candidate.observationMinimumMinutes,
    DEFAULT_CARE_SETTINGS.observationMinimumMinutes,
    1,
    120,
  );
  const observationMaximumMinutes = Math.max(
    observationMinimumMinutes,
    boundedInteger(
      candidate.observationMaximumMinutes,
      DEFAULT_CARE_SETTINGS.observationMaximumMinutes,
      1,
      120,
    ),
  );
  const allowed = new Set(Array.isArray(candidate.allowedActions) ? candidate.allowedActions : CARE_ACTION_NAMES);
  return {
    enabled: candidate.enabled === undefined ? DEFAULT_CARE_SETTINGS.enabled : Boolean(candidate.enabled),
    observationMinimumMinutes,
    observationMaximumMinutes,
    autoListenSeconds: boundedInteger(
      candidate.autoListenSeconds,
      DEFAULT_CARE_SETTINGS.autoListenSeconds,
      5,
      60,
    ),
    duplicateGuardSeconds: boundedInteger(
      candidate.duplicateGuardSeconds,
      DEFAULT_CARE_SETTINGS.duplicateGuardSeconds,
      30,
      600,
    ),
    persona: boundedText(candidate.persona, DEFAULT_PERSONA, 2_000),
    allowedActions: CARE_ACTION_NAMES.filter((name) => allowed.has(name)),
    appPresets: normalizeAppPresets(candidate.appPresets),
    mediaPresets: normalizeMediaPresets(candidate.mediaPresets),
  };
}

function normalizeSettings(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const selectedPetId = typeof candidate.selectedPetId === "string" &&
    PRESET_ID_PATTERN.test(candidate.selectedPetId)
    ? candidate.selectedPetId
    : DEFAULT_SETTINGS.selectedPetId;
  return {
    selectedPetId,
    care: normalizeCareSettings(candidate.care),
  };
}

export class SettingsRepository {
  #saveQueue = Promise.resolve();

  constructor(filePath = path.join(os.homedir(), ".codex-desk", "settings.json")) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return normalizeSettings(parsed);
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return normalizeSettings();
      throw error;
    }
  }

  async save(patch) {
    const save = this.#saveQueue.then(async () => {
      const current = await this.load();
      const candidate = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
      const settings = normalizeSettings({
        ...current,
        ...candidate,
        care: candidate.care === undefined
          ? current.care
          : { ...current.care, ...candidate.care },
      });
      const directory = path.dirname(this.filePath);
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      try {
        await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.filePath);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return settings;
    });
    this.#saveQueue = save.catch(() => {});
    return save;
  }
}
