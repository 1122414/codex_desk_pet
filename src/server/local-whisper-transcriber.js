import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TRANSCRIPT_LENGTH = 4_000;

export const DEFAULT_WHISPER_MODEL_PATH = path.join(
  os.homedir(),
  ".cache",
  "codex-desk",
  "whisper",
  "ggml-base.bin",
);

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
    if (typeof spawnProcess !== "function") throw new TypeError("本地转写进程启动器无效");
    this.command = command;
    this.modelPath = path.resolve(modelPath);
    this.tempDirectory = path.resolve(tempDirectory);
    this.timeoutMs = timeoutMs;
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
    const wav = pcm16MonoToWav(pcm);
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
