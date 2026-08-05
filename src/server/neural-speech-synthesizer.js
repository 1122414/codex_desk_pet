import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pcm16MonoFromWav } from "./macos-speech-synthesizer.js";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../..");
const NEURAL_TTS_DIRECTORY = path.join(homedir(), ".codex-desk", "neural-tts");

export const DEFAULT_NEURAL_TTS_ENDPOINT = "http://127.0.0.1:4320/v1/speech";
export const DEFAULT_NEURAL_TTS_PYTHON = path.join(NEURAL_TTS_DIRECTORY, ".venv", "bin", "python");
export const DEFAULT_NEURAL_TTS_SERVICE = path.join(PROJECT_DIRECTORY, "scripts", "neural-tts-service.py");
export const DEFAULT_NEURAL_TTS_BASE_MODEL = path.join(
  NEURAL_TTS_DIRECTORY,
  "models",
  "qwen3-base-8bit",
);
export const DEFAULT_NEURAL_TTS_REFERENCE_AUDIO = path.join(
  NEURAL_TTS_DIRECTORY,
  "skadi-taiwan-conversation-v2.wav",
);
export const DEFAULT_NEURAL_TTS_PROFILE = path.join(
  NEURAL_TTS_DIRECTORY,
  "skadi-taiwan-conversation-v2.json",
);

const MAX_TEXT_BYTES = 480;
const HEALTH_TIMEOUT_MS = 700;
const STREAMED_PCM_CONTENT_TYPE = "application/x-codex-pcm";
const MAX_STREAM_CHUNK_BYTES = 128 * 1_024;

function abortError() {
  const error = new Error("本地神经语音已取消");
  error.name = "AbortError";
  return error;
}

function boundedText(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new RangeError("语音文本不能为空");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new RangeError("语音文本过长");
  }
  return text;
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${name}必须是绝对路径`);
  }
  return path.resolve(value);
}

function localEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("本地神经语音地址无效");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1/speech") {
    throw new TypeError("本地神经语音必须使用本机 /v1/speech 地址");
  }
  return url;
}

function requestSignal(signal, timeoutMs = HEALTH_TIMEOUT_MS) {
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

async function responseError(response) {
  let detail = "";
  try {
    detail = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 240);
  } catch {
    // The status code still gives the caller an actionable failure.
  }
  return new Error(detail
    ? `本地神经语音失败：${detail}`
    : `本地神经语音失败（HTTP ${response.status}）`);
}

export class NeuralSpeechSynthesizer {
  #child = null;
  #starting = null;
  #closed = false;

  constructor({
    endpoint = process.env.CODEX_DESK_NEURAL_TTS_ENDPOINT ?? DEFAULT_NEURAL_TTS_ENDPOINT,
    pythonPath = process.env.CODEX_DESK_NEURAL_TTS_PYTHON ?? DEFAULT_NEURAL_TTS_PYTHON,
    servicePath = DEFAULT_NEURAL_TTS_SERVICE,
    baseModelPath = process.env.CODEX_DESK_NEURAL_TTS_MODEL ?? DEFAULT_NEURAL_TTS_BASE_MODEL,
    referenceAudioPath = process.env.CODEX_DESK_NEURAL_TTS_REFERENCE ?? DEFAULT_NEURAL_TTS_REFERENCE_AUDIO,
    profilePath = process.env.CODEX_DESK_NEURAL_TTS_PROFILE ?? DEFAULT_NEURAL_TTS_PROFILE,
    fetchImpl = globalThis.fetch,
    spawnProcess = spawn,
    accessPath = access,
    platform = process.platform,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("本地神经语音请求器无效");
    if (typeof spawnProcess !== "function") throw new TypeError("本地神经语音启动器无效");
    if (typeof accessPath !== "function") throw new TypeError("本地神经语音文件检查器无效");
    const url = localEndpoint(endpoint);
    this.endpoint = url.toString();
    this.healthEndpoint = new URL("/health", url).toString();
    this.pythonPath = absolutePath(pythonPath, "本地神经语音 Python 路径");
    this.servicePath = absolutePath(servicePath, "本地神经语音服务路径");
    this.baseModelPath = absolutePath(baseModelPath, "本地神经语音模型路径");
    this.referenceAudioPath = absolutePath(referenceAudioPath, "本地神经语音参考音频路径");
    this.profilePath = absolutePath(profilePath, "本地神经语音配置路径");
    this.fetchImpl = fetchImpl;
    this.spawnProcess = spawnProcess;
    this.accessPath = accessPath;
    this.platform = platform;
  }

  async start() {
    if (this.#closed || this.platform !== "darwin") return false;
    if (await this.#healthy()) return true;
    await this.#startIfReady();
    return false;
  }

  async available() {
    if (this.#closed || this.platform !== "darwin") return false;
    if (await this.#healthy()) return true;
    await this.#startIfReady();
    return false;
  }

  async synthesize(text, { signal } = {}) {
    const phrase = boundedText(text);
    if (signal?.aborted) throw abortError();
    if (!await this.available()) {
      throw new Error("本地神经女声尚未准备好");
    }
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: phrase }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw new Error(`本地神经语音请求失败：${error.message}`);
    }
    if (!response?.ok) throw await responseError(response ?? { status: "未知" });
    if (signal?.aborted) throw abortError();
    const wav = Buffer.from(await response.arrayBuffer());
    if (signal?.aborted) throw abortError();
    return pcm16MonoFromWav(wav);
  }

  async synthesizeStream(text, { signal } = {}) {
    const phrase = boundedText(text);
    if (signal?.aborted) throw abortError();
    if (!await this.available()) {
      throw new Error("本地神经女声尚未准备好");
    }
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: phrase, stream: true }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw new Error(`本地神经语音请求失败：${error.message}`);
    }
    if (!response?.ok) throw await responseError(response ?? { status: "未知" });
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith(STREAMED_PCM_CONTENT_TYPE)) {
      throw new Error("本地神经语音流格式无效");
    }
    if (!response.body?.getReader) throw new Error("本地神经语音流不可读取");
    return this.#readPcmStream(response.body, signal);
  }

  async close() {
    this.#closed = true;
    this.#child?.kill?.("SIGTERM");
    this.#child = null;
    await this.#starting?.catch(() => {});
  }

  async #healthy() {
    const request = requestSignal();
    try {
      const response = await this.fetchImpl(this.healthEndpoint, { signal: request.signal });
      if (!response?.ok) return false;
      const body = await response.json();
      return body?.ok === true;
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
        await Promise.all([
          this.accessPath(this.pythonPath, constants.X_OK),
          this.accessPath(this.servicePath, constants.R_OK),
          this.accessPath(path.join(this.baseModelPath, "config.json"), constants.R_OK),
          this.accessPath(this.referenceAudioPath, constants.R_OK),
          this.accessPath(this.profilePath, constants.R_OK),
        ]);
      } catch {
        return;
      }
      if (this.#closed || this.#child) return;
      let child;
      try {
        child = this.spawnProcess(this.pythonPath, [
          this.servicePath,
          "--model", this.baseModelPath,
          "--reference-audio", this.referenceAudioPath,
          "--profile", this.profilePath,
          "--host", "127.0.0.1",
          "--port", String(new URL(this.endpoint).port),
        ], {
          cwd: PROJECT_DIRECTORY,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
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

  async *#readPcmStream(body, signal) {
    const reader = body.getReader();
    let trailing = Buffer.alloc(0);
    const cancel = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        if (signal?.aborted) throw abortError();
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
        if (value.byteLength > MAX_STREAM_CHUNK_BYTES) {
          throw new RangeError("本地神经语音流分块过大");
        }
        const received = Buffer.from(value);
        const joined = trailing.byteLength
          ? Buffer.concat([trailing, received])
          : received;
        const completeBytes = joined.byteLength - (joined.byteLength % 2);
        if (completeBytes > 0) yield Buffer.from(joined.subarray(0, completeBytes));
        trailing = Buffer.from(joined.subarray(completeBytes));
      }
      if (trailing.byteLength !== 0) throw new Error("本地神经语音流采样不完整");
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      reader.releaseLock?.();
    }
  }
}

export class FallbackSpeechSynthesizer {
  constructor({ primary, fallback } = {}) {
    if (!primary || !fallback ||
      typeof primary.available !== "function" || typeof primary.synthesize !== "function" ||
      typeof fallback.available !== "function" || typeof fallback.synthesize !== "function") {
      throw new TypeError("语音兜底器需要两个可用的语音合成器");
    }
    this.primary = primary;
    this.fallback = fallback;
  }

  async available() {
    try {
      if (await this.primary.available()) return true;
    } catch {
      // A neural sidecar probe must never hide the known-good macOS fallback.
    }
    return this.fallback.available();
  }

  async synthesize(text, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    let primaryAvailable = false;
    try {
      primaryAvailable = await this.primary.available();
    } catch {
      primaryAvailable = false;
    }
    if (primaryAvailable) {
      try {
        return await this.primary.synthesize(text, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
      }
    }
    if (!await this.fallback.available()) throw new Error("本机温柔女声不可用");
    return this.fallback.synthesize(text, { signal });
  }

  async synthesizeStream(text, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    let primaryAvailable = false;
    try {
      primaryAvailable = await this.primary.available();
    } catch {
      primaryAvailable = false;
    }
    if (primaryAvailable && typeof this.primary.synthesizeStream === "function") {
      try {
        return await this.primary.synthesizeStream(text, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
      }
    }
    if (!await this.fallback.available()) throw new Error("本机温柔女声不可用");
    const pcm = await this.fallback.synthesize(text, { signal });
    return (async function* streamFallbackPcm() {
      yield pcm;
    })();
  }

  async close() {
    await this.primary.close?.();
    await this.fallback.close?.();
  }
}
