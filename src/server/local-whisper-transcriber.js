import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TRANSCRIPT_LENGTH = 4_000;
const DEFAULT_CHINESE_PROMPT = "以下是普通话中文对话，请忠实转写用户原话。";
const DEFAULT_SERVER_HEALTH_TIMEOUT_MS = 700;
const NORMALIZATION_MINIMUM_MEAN_ABS = 80;
const NORMALIZATION_TARGET_MEAN_ABS = 4_800;
const NORMALIZATION_MAX_GAIN = 6;
const NORMALIZATION_MAX_PEAK = 28_000;

export const DEFAULT_WHISPER_MODEL_PATH = path.join(
  os.homedir(),
  ".cache",
  "codex-desk",
  "whisper",
  "ggml-base.bin",
);
export const DEFAULT_WHISPER_SERVER_ENDPOINT = "http://127.0.0.1:4323/inference";
export const DEFAULT_WHISPER_SERVER_COMMAND = "whisper-server";

function abortError() {
  const error = new Error("本地转写已取消");
  error.name = "AbortError";
  return error;
}

function processError(stderr, code) {
  const detail = String(stderr ?? "").trim().replace(/\s+/g, " ");
  return new Error(detail
    ? `本地语音转写失败：${detail.slice(0, 320)}`
    : `本地语音转写失败（退出码 ${code ?? "未知"}）`);
}

function normalizeTranscript(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TRANSCRIPT_LENGTH);
}

function localWhisperEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("本机常驻转写地址无效");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/inference") {
    throw new TypeError("本机常驻转写必须使用 127.0.0.1 /inference 地址");
  }
  return url;
}

function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function serverResponseError(response) {
  let detail = "";
  try {
    detail = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 240);
  } catch {
    // The status is enough to give the fallback transcriber a useful signal.
  }
  return new Error(detail
    ? `本机常驻转写失败：${detail}`
    : `本机常驻转写失败（HTTP ${response.status}）`);
}

export function normalizePcm16MonoForTranscription(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.byteLength === 0 || pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new TypeError("PCM 音频必须是非空的 16 位单声道采样");
  }
  let meanAbsolute = 0;
  let peak = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(offset);
    const absolute = Math.abs(sample);
    meanAbsolute += absolute;
    peak = Math.max(peak, absolute);
  }
  meanAbsolute /= pcm.byteLength / BYTES_PER_SAMPLE;
  if (meanAbsolute < NORMALIZATION_MINIMUM_MEAN_ABS || peak === 0) {
    return Buffer.from(pcm);
  }
  const gain = Math.min(
    NORMALIZATION_MAX_GAIN,
    NORMALIZATION_MAX_PEAK / peak,
    Math.max(1, NORMALIZATION_TARGET_MEAN_ABS / meanAbsolute),
  );
  if (gain <= 1.01) return Buffer.from(pcm);

  const normalized = Buffer.allocUnsafe(pcm.byteLength);
  for (let offset = 0; offset < pcm.byteLength; offset += BYTES_PER_SAMPLE) {
    const amplified = Math.round(pcm.readInt16LE(offset) * gain);
    normalized.writeInt16LE(Math.max(-32_768, Math.min(32_767, amplified)), offset);
  }
  return normalized;
}

export function pcm16MonoToWav(pcm, sampleRate = SAMPLE_RATE) {
  if (!Buffer.isBuffer(pcm) || pcm.byteLength === 0 || pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new TypeError("PCM 音频必须是非空的 16 位单声道采样");
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
    throw new RangeError("PCM 采样率无效");
  }
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  wav.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  return wav;
}

export class LocalWhisperTranscriber {
  constructor({
    command = process.env.CODEX_DESK_WHISPER_COMMAND ?? "whisper-cli",
    modelPath = process.env.CODEX_DESK_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL_PATH,
    tempDirectory = os.tmpdir(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    prompt = DEFAULT_CHINESE_PROMPT,
    spawnProcess = spawn,
  } = {}) {
    if (typeof command !== "string" || !command.trim()) {
      throw new TypeError("本地转写命令不能为空");
    }
    if (typeof modelPath !== "string" || !path.isAbsolute(modelPath)) {
      throw new TypeError("本地转写模型路径必须是绝对路径");
    }
    if (typeof tempDirectory !== "string" || !path.isAbsolute(tempDirectory)) {
      throw new TypeError("本地转写临时目录必须是绝对路径");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new RangeError("本地转写超时必须至少一秒");
    }
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      Buffer.byteLength(prompt, "utf8") > 240
    ) {
      throw new RangeError("本地中文转写提示必须是 1 到 240 字节的文本");
    }
    if (typeof spawnProcess !== "function") throw new TypeError("本地转写进程启动器无效");
    this.command = command;
    this.modelPath = path.resolve(modelPath);
    this.tempDirectory = path.resolve(tempDirectory);
    this.timeoutMs = timeoutMs;
    this.prompt = prompt.trim();
    this.spawnProcess = spawnProcess;
  }

  async available() {
    try {
      await access(this.modelPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async transcribe(pcm, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!await this.available()) {
      throw new Error(`本地中文转写模型未准备好：${this.modelPath}`);
    }
    const wav = pcm16MonoToWav(normalizePcm16MonoForTranscription(pcm));
    const directory = await mkdtemp(path.join(this.tempDirectory, "codex-desk-voice-"));
    const audioPath = path.join(directory, "utterance.wav");
    try {
      await writeFile(audioPath, wav, { mode: 0o600, flag: "wx" });
      return normalizeTranscript(await this.#run(audioPath, signal));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  #run(audioPath, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      let child;
      try {
        child = this.spawnProcess(this.command, [
          "--model", this.modelPath,
          "--file", audioPath,
          "--language", "zh",
          "--prompt", this.prompt,
          "--suppress-nst",
          "--no-fallback",
          "--threads", "4",
          "--no-timestamps",
          "--no-prints",
        ], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new Error(`本地转写器启动失败：${error.message}`));
        return;
      }

      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (error, value = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => {
        child.kill?.("SIGTERM");
        finish(abortError());
      };
      const timeout = setTimeout(() => {
        child.kill?.("SIGTERM");
        finish(new Error("本地语音转写超时"));
      }, this.timeoutMs);
      timeout.unref?.();

      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
      child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
      child.once?.("error", (error) => {
        finish(new Error(`本地转写器启动失败：${error.message}`));
      });
      child.once?.("close", (code) => {
        if (signal?.aborted) {
          finish(abortError());
          return;
        }
        if (code === 0) finish(null, stdout);
        else finish(processError(stderr, code));
      });
    });
  }
}

export class WhisperServerTranscriber {
  #child = null;
  #starting = null;
  #closed = false;

  constructor({
    endpoint = process.env.CODEX_DESK_WHISPER_SERVER_ENDPOINT ?? DEFAULT_WHISPER_SERVER_ENDPOINT,
    command = process.env.CODEX_DESK_WHISPER_SERVER_COMMAND ?? DEFAULT_WHISPER_SERVER_COMMAND,
    modelPath = process.env.CODEX_DESK_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL_PATH,
    prompt = DEFAULT_CHINESE_PROMPT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    healthTimeoutMs = DEFAULT_SERVER_HEALTH_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    spawnProcess = spawn,
    accessPath = access,
    platform = process.platform,
  } = {}) {
    if (typeof command !== "string" || !command.trim()) {
      throw new TypeError("本机常驻转写命令不能为空");
    }
    if (typeof modelPath !== "string" || !path.isAbsolute(modelPath)) {
      throw new TypeError("本机常驻转写模型路径必须是绝对路径");
    }
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt, "utf8") > 240) {
      throw new RangeError("本机常驻转写提示必须是 1 到 240 字节的文本");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new RangeError("本机常驻转写超时必须至少一秒");
    }
    if (!Number.isInteger(healthTimeoutMs) || healthTimeoutMs < 100) {
      throw new RangeError("本机常驻转写健康检查超时必须至少 100 毫秒");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("本机常驻转写请求器无效");
    if (typeof spawnProcess !== "function") throw new TypeError("本机常驻转写启动器无效");
    if (typeof accessPath !== "function") throw new TypeError("本机常驻转写文件检查器无效");
    const url = localWhisperEndpoint(endpoint);
    this.endpoint = url.toString();
    this.healthEndpoint = new URL("/", url).toString();
    this.command = command.trim();
    this.modelPath = path.resolve(modelPath);
    this.prompt = prompt.trim();
    this.timeoutMs = timeoutMs;
    this.healthTimeoutMs = healthTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.spawnProcess = spawnProcess;
    this.accessPath = accessPath;
    this.platform = platform;
  }

  async start() {
    if (this.#closed || this.platform !== "darwin") return false;
    if (await this.#healthy()) return true;
    await this.#startIfReady();
    return this.#healthy();
  }

  async available() {
    return this.start();
  }

  async transcribe(pcm, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!await this.available()) {
      throw new Error("本机常驻中文转写尚未准备好");
    }
    const wav = pcm16MonoToWav(normalizePcm16MonoForTranscription(pcm));
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    const request = requestSignal(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        body: form,
        signal: request.signal,
      });
      if (!response?.ok) throw await serverResponseError(response ?? { status: "未知" });
      const body = await response.json();
      if (signal?.aborted) throw abortError();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("本机常驻转写响应无效");
      }
      return normalizeTranscript(body.text);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw error;
    } finally {
      request.close();
    }
  }

  async close() {
    this.#closed = true;
    this.#child?.kill?.("SIGTERM");
    this.#child = null;
    await this.#starting?.catch(() => {});
  }

  async #healthy() {
    const request = requestSignal(null, this.healthTimeoutMs);
    try {
      const response = await this.fetchImpl(this.healthEndpoint, { signal: request.signal });
      return response?.ok === true;
    } catch {
      return false;
    } finally {
      request.close();
    }
  }

  async #startIfReady() {
    if (this.#child || this.#starting || this.#closed) return;
    this.#starting = (async () => {
      try {
        await this.accessPath(this.modelPath, constants.R_OK);
      } catch {
        return;
      }
      if (this.#closed || this.#child) return;
      let child;
      try {
        child = this.spawnProcess(this.command, [
          "--model", this.modelPath,
          "--language", "zh",
          "--prompt", this.prompt,
          "--suppress-nst",
          "--no-fallback",
          "--threads", "4",
          "--host", "127.0.0.1",
          "--port", String(new URL(this.endpoint).port),
        ], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        return;
      }
      this.#child = child;
      const clear = () => {
        if (this.#child === child) this.#child = null;
      };
      child.once?.("error", clear);
      child.once?.("exit", clear);
    })().finally(() => {
      this.#starting = null;
    });
    await this.#starting;
  }
}

export class FallbackTranscriber {
  constructor({ primary, fallback } = {}) {
    if (!primary || !fallback ||
      typeof primary.available !== "function" || typeof primary.transcribe !== "function" ||
      typeof fallback.available !== "function" || typeof fallback.transcribe !== "function") {
      throw new TypeError("转写兜底器需要两个可用的转写器");
    }
    this.primary = primary;
    this.fallback = fallback;
  }

  async start() {
    if (typeof this.primary.start !== "function") return this.primary.available();
    return this.primary.start();
  }

  async available() {
    try {
      if (await this.primary.available()) return true;
    } catch {
      // Keep the pre-existing one-shot CLI as a local recovery path.
    }
    return this.fallback.available();
  }

  async transcribe(pcm, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    try {
      if (await this.primary.available()) {
        return await this.primary.transcribe(pcm, { signal });
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
    }
    if (!await this.fallback.available()) throw new Error("本地中文转写不可用");
    return this.fallback.transcribe(pcm, { signal });
  }

  async close() {
    await this.primary.close?.();
    await this.fallback.close?.();
  }
}
