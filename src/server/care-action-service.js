import { EventEmitter } from "node:events";
import { CARE_ACTION_NAMES } from "./settings-repository.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_COMPLETED_ACTIONS = 512;
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}超出范围`);
  }
  return value;
}

export function validateCareAction(value) {
  if (!isRecord(value) || !exactKeys(value, ["name", "arguments"])) {
    throw new Error("关怀动作结构无效");
  }
  if (!CARE_ACTION_NAMES.includes(value.name) || !isRecord(value.arguments)) {
    throw new Error("关怀动作未获允许");
  }
  const args = value.arguments;
  switch (value.name) {
    case "capture_now":
      if (!exactKeys(args, [])) throw new Error("立即拍照动作参数无效");
      break;
    case "set_tab5_brightness":
    case "set_tab5_volume":
    case "set_macos_volume":
      if (!exactKeys(args, ["value"], ["durationSeconds"])) {
        throw new Error("音量或亮度动作参数无效");
      }
      integer(args.value, 0, 100, "动作值");
      if (args.durationSeconds !== undefined) {
        integer(args.durationSeconds, 1, 3_600, "动作持续时间");
      }
      break;
    case "open_app":
    case "open_media_preset":
      if (
        !exactKeys(args, ["presetId"]) ||
        typeof args.presetId !== "string" ||
        !PRESET_ID.test(args.presetId)
      ) {
        throw new Error("预设动作参数无效");
      }
      break;
    case "schedule_follow_up":
      if (!exactKeys(args, ["minutes"])) throw new Error("跟进动作参数无效");
      integer(args.minutes, 1, 120, "跟进时间");
      break;
    default:
      throw new Error("关怀动作未获允许");
  }
  return structuredClone(value);
}

function boundedMessage(value) {
  return String(value ?? "").trim().slice(0, 500);
}

export class CareActionService extends EventEmitter {
  #inflight = new Map();
  #completed = new Map();
  #restoreTimers = new Set();
  #closed = false;

  constructor({
    settings,
    deviceActions,
    macosActions,
    observationScheduler,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    super();
    if (!settings || !deviceActions || !macosActions || !observationScheduler) {
      throw new TypeError(
        "CareActionService requires settings, device, macOS, and observation adapters",
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new RangeError("关怀动作超时必须在 100～120000 毫秒之间");
    }
    this.settings = settings;
    this.deviceActions = deviceActions;
    this.macosActions = macosActions;
    this.observationScheduler = observationScheduler;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  execute(action, { idempotencyKey, deviceId = null } = {}) {
    if (this.#closed) throw new Error("关怀动作服务已关闭");
    const normalized = validateCareAction(action);
    if (
      typeof idempotencyKey !== "string" ||
      !idempotencyKey.trim() ||
      idempotencyKey.length > 256
    ) {
      throw new Error("关怀动作幂等键无效");
    }
    const key = idempotencyKey.trim();
    if (this.#completed.has(key)) return Promise.resolve(structuredClone(this.#completed.get(key)));
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const operation = this.#run(normalized, { deviceId })
      .then((result) => {
        this.#remember(key, result);
        return structuredClone(result);
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, operation);
    return operation;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#restoreTimers) this.clearTimer(timer);
    this.#restoreTimers.clear();
  }

  async #run(action, context) {
    const executedAt = this.now();
    try {
      const settings = await this.settings.load();
      if (!settings.care.allowedActions.includes(action.name)) {
        throw new Error("此关怀动作已在设置中禁用");
      }
      const details = await this.#withTimeout(this.#dispatch(action, context));
      return {
        ...details,
        action: action.name,
        ok: true,
        message: boundedMessage(details.message || "动作已完成"),
        executedAt,
      };
    } catch (error) {
      return {
        action: action.name,
        ok: false,
        message: boundedMessage(error.message || "动作执行失败"),
        executedAt,
      };
    }
  }

  async #dispatch(action, { deviceId }) {
    const args = action.arguments;
    switch (action.name) {
      case "capture_now": {
        const result = await this.observationScheduler.requestNow("manual", {
          fromCareAction: true,
        });
        if (!result?.accepted) {
          throw new Error(`暂时无法拍照：${result?.reason ?? "unknown"}`);
        }
        return { message: "已请求立即观察", deviceId: result.deviceId ?? deviceId };
      }
      case "schedule_follow_up": {
        const dueAt = this.observationScheduler.schedule(args.minutes);
        return {
          message: `已安排 ${args.minutes} 分钟后再次观察`,
          minutes: args.minutes,
          dueAt,
        };
      }
      case "set_tab5_brightness":
        return this.#setTemporaryValue(
          () => this.deviceActions.setBrightness(deviceId, args.value),
          (value) => this.deviceActions.setBrightness(deviceId, value),
          args,
          "Tab5 亮度已调整",
        );
      case "set_tab5_volume":
        return this.#setTemporaryValue(
          () => this.deviceActions.setVolume(deviceId, args.value),
          (value) => this.deviceActions.setVolume(deviceId, value),
          args,
          "Tab5 音量已调整",
        );
      case "set_macos_volume":
        return this.#setTemporaryValue(
          () => this.macosActions.setVolume(args.value),
          (value) => this.macosActions.setVolume(value),
          args,
          "Mac 音量已调整",
        );
      case "open_app":
        return this.macosActions.openApp(args.presetId);
      case "open_media_preset":
        return this.macosActions.openMediaPreset(args.presetId);
      default:
        throw new Error("关怀动作未获允许");
    }
  }

  async #setTemporaryValue(apply, restore, args, message) {
    const result = await apply();
    const details = {
      message,
      value: args.value,
      previousValue: Number.isInteger(result?.previousValue)
        ? result.previousValue
        : null,
    };
    if (
      args.durationSeconds !== undefined &&
      Number.isInteger(details.previousValue)
    ) {
      const restoreAt = this.now() + args.durationSeconds * 1_000;
      const timer = this.setTimer(() => {
        this.#restoreTimers.delete(timer);
        Promise.resolve(restore(details.previousValue))
          .catch((error) => this.emit("diagnostic", `恢复动作失败：${error.message}`));
      }, args.durationSeconds * 1_000);
      timer?.unref?.();
      this.#restoreTimers.add(timer);
      details.restoreAt = restoreAt;
    }
    return details;
  }

  #withTimeout(operation) {
    let timer;
    return Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = this.setTimer(
          () => reject(new Error("关怀动作执行超时")),
          this.timeoutMs,
        );
        timer?.unref?.();
      }),
    ]).finally(() => this.clearTimer(timer));
  }

  #remember(key, result) {
    this.#completed.set(key, structuredClone(result));
    while (this.#completed.size > MAX_COMPLETED_ACTIONS) {
      this.#completed.delete(this.#completed.keys().next().value);
    }
  }
}
