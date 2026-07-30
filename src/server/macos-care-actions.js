import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OPEN_EXECUTABLE = "/usr/bin/open";
const OSASCRIPT_EXECUTABLE = "/usr/bin/osascript";
const PROCESS_TIMEOUT_MS = 5_000;

async function defaultRunProcess(executable, args) {
  return execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}

function requirePresetId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("预设编号无效");
  }
  return value;
}

export class MacosCareActions {
  constructor({
    settings,
    platform = process.platform,
    runProcess = defaultRunProcess,
  } = {}) {
    if (!settings || typeof runProcess !== "function") {
      throw new TypeError("MacosCareActions requires settings and a process runner");
    }
    this.settings = settings;
    this.platform = platform;
    this.runProcess = runProcess;
  }

  async openApp(presetId) {
    this.#requireMacos();
    const id = requirePresetId(presetId);
    const settings = await this.settings.load();
    const preset = settings.care.appPresets.find((candidate) => candidate.id === id);
    if (!preset) throw new Error("应用预设不存在或未获允许");
    await this.runProcess(OPEN_EXECUTABLE, ["-b", preset.bundleId]);
    return {
      message: `已打开${preset.label}`,
      presetId: preset.id,
      label: preset.label,
    };
  }

  async openMediaPreset(presetId) {
    this.#requireMacos();
    const id = requirePresetId(presetId);
    const settings = await this.settings.load();
    const preset = settings.care.mediaPresets.find((candidate) => candidate.id === id);
    if (!preset) throw new Error("媒体预设不存在或未获允许");
    await this.runProcess(OPEN_EXECUTABLE, [preset.url]);
    return {
      message: `已打开${preset.label}`,
      presetId: preset.id,
      label: preset.label,
    };
  }

  async setVolume(value) {
    this.#requireMacos();
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error("Mac 音量必须是 0～100 的整数");
    }
    const current = await this.runProcess(OSASCRIPT_EXECUTABLE, [
      "-e",
      "output volume of (get volume settings)",
    ]);
    const previousValue = Number.parseInt(String(current?.stdout ?? "").trim(), 10);
    if (!Number.isInteger(previousValue) || previousValue < 0 || previousValue > 100) {
      throw new Error("无法读取当前 Mac 音量");
    }
    await this.runProcess(OSASCRIPT_EXECUTABLE, [
      "-e",
      `set volume output volume ${value}`,
    ]);
    return {
      message: "Mac 音量已调整",
      value,
      previousValue,
    };
  }

  #requireMacos() {
    if (this.platform !== "darwin") {
      throw new Error("此动作只支持 macOS");
    }
  }
}
