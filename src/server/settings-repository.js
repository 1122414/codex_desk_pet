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
