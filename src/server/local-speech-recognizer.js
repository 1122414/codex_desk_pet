import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_SPEECH_SAMPLE_RATE = 16_000;
export const LOCAL_SPEECH_MAX_SECONDS = 30;
export const DEFAULT_WHISPER_MODEL_BYTES = 147_951_465;
export const DEFAULT_WHISPER_MODEL_SHA256 =
  "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
export const DEFAULT_WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
export const DEFAULT_WHISPER_MODEL_PATH = path.join(
  os.homedir(),
  ".codex-desk",
  "models",
  "ggml-base.bin",
);

const MAX_OUTPUT_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MINIMUM_CUSTOM_MODEL_BYTES = 1_000_000;

function configuredThreads() {
  const requested = Number(process.env.CODEX_DESK_WHISPER_THREADS);
  if (Number.isInteger(requested) && requested >= 1) {
    return Math.min(requested, 16);
  }
  return Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 8));
}

function executableCandidates(configured) {
  if (configured) return [configured];
  return [
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    "whisper-cli",
  ];
}

function pathCandidates(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return [path.resolve(command)];
  }
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
      .split(";")
      .filter(Boolean)
    : [""];
  return String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => path.join(directory, `${command}${extension}`)));
}

export async function resolveWhisperExecutable(configured = null) {
  for (const candidate of executableCandidates(configured)) {
    for (const resolved of pathCandidates(candidate)) {
      try {
        await access(resolved, fsConstants.X_OK);
        return resolved;
      } catch {
        // Try the next known installation location.
      }
    }
  }
  return null;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export function encodePcm16MonoWav(
  input,
  sampleRate = LOCAL_SPEECH_SAMPLE_RATE,
) {
  const pcm = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
    throw new TypeError("语音采样率无效");
  }
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new TypeError("语音 PCM 数据无效");
  }
  const output = Buffer.allocUnsafe(44 + pcm.length);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + pcm.length, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(pcm.length, 40);
  pcm.copy(output, 44);
  return output;
}

function appendBounded(target, chunk) {
  if (target.bytes >= MAX_OUTPUT_BYTES) return;
  const buffer = Buffer.from(chunk);
  const remaining = MAX_OUTPUT_BYTES - target.bytes;
  target.parts.push(buffer.subarray(0, remaining));
  target.bytes += Math.min(buffer.length, remaining);
}

function cleanTranscript(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export class LocalSpeechRecognizer {
  #verification = null;

  constructor({
    command = process.env.CODEX_DESK_WHISPER_COMMAND ?? null,
    modelPath = process.env.CODEX_DESK_WHISPER_MODEL ??
      DEFAULT_WHISPER_MODEL_PATH,
    modelSha256 = process.env.CODEX_DESK_WHISPER_MODEL_SHA256 ?? null,
    modelBytes = null,
    minimumModelBytes = MINIMUM_CUSTOM_MODEL_BYTES,
    language = process.env.CODEX_DESK_WHISPER_LANGUAGE ?? "zh",
    threads = configuredThreads(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temporaryRoot = path.join(os.tmpdir(), "codex-desk-voice"),
    spawnProcess = spawn,
  } = {}) {
    const usingDefaultModel =
      modelPath === DEFAULT_WHISPER_MODEL_PATH &&
      !process.env.CODEX_DESK_WHISPER_MODEL;
    this.command = command;
    this.modelPath = path.resolve(modelPath);
    this.modelSha256 = modelSha256 ??
      (usingDefaultModel ? DEFAULT_WHISPER_MODEL_SHA256 : null);
    this.modelBytes = modelBytes ??
      (usingDefaultModel ? DEFAULT_WHISPER_MODEL_BYTES : null);
    this.minimumModelBytes = minimumModelBytes;
    this.language = language;
    this.threads = Math.max(1, Math.min(Number(threads) || 1, 16));
    this.timeoutMs = Math.max(1_000, Math.min(Number(timeoutMs) || 0, 300_000));
    this.temporaryRoot = temporaryRoot;
    this.spawnProcess = spawnProcess;
  }

  async status() {
    const command = await resolveWhisperExecutable(this.command);
    if (!command) {
      return {
        ready: false,
        command: null,
        modelPath: this.modelPath,
        error: "未找到 whisper-cli；请先运行 npm run setup:local-voice",
      };
    }
    let info;
    try {
      info = await stat(this.modelPath);
    } catch {
      return {
        ready: false,
        command,
        modelPath: this.modelPath,
        error: "未找到本地语音模型；请先运行 npm run setup:local-voice",
      };
    }
    if (!info.isFile()) {
      return {
        ready: false,
        command,
        modelPath: this.modelPath,
        error: "本地语音模型路径不是文件",
      };
    }
    if (this.modelBytes !== null && info.size !== this.modelBytes) {
      return {
        ready: false,
        command,
        modelPath: this.modelPath,
        modelBytes: info.size,
        error: `本地语音模型大小校验失败（${info.size} 字节）`,
      };
    }
    if (this.modelBytes === null && info.size < this.minimumModelBytes) {
      return {
        ready: false,
        command,
        modelPath: this.modelPath,
        modelBytes: info.size,
        error: "本地语音模型文件过小",
      };
    }
    const verificationKey = `${this.modelPath}:${info.size}:${info.mtimeMs}`;
    let digest = null;
    if (this.modelSha256) {
      if (this.#verification?.key === verificationKey) {
        digest = this.#verification.digest;
      } else {
        digest = await sha256File(this.modelPath);
        this.#verification = { key: verificationKey, digest };
      }
      if (digest !== this.modelSha256.toLowerCase()) {
        return {
          ready: false,
          command,
          modelPath: this.modelPath,
          modelBytes: info.size,
          modelSha256: digest,
          error: "本地语音模型 SHA-256 校验失败",
        };
      }
    }
    return {
      ready: true,
      command,
      modelPath: this.modelPath,
      modelBytes: info.size,
      modelSha256: digest,
      language: this.language,
      threads: this.threads,
      gpu: false,
    };
  }

  async assertReady() {
    const status = await this.status();
    if (!status.ready) throw new Error(status.error);
    return status;
  }

  async transcribe(input, { signal = null } = {}) {
    const pcm = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
    if (pcm.length === 0 || pcm.length % 2 !== 0) {
      throw new Error("没有收到有效语音");
    }
    const maximumBytes =
      LOCAL_SPEECH_SAMPLE_RATE * 2 * LOCAL_SPEECH_MAX_SECONDS;
    if (pcm.length > maximumBytes) {
      throw new Error(`单次语音不能超过 ${LOCAL_SPEECH_MAX_SECONDS} 秒`);
    }
    if (signal?.aborted) throw new Error("语音识别已取消");
    const ready = await this.assertReady();
    await mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(this.temporaryRoot, "session-"));
    const wavPath = path.join(temporary, `${randomUUID()}.wav`);
    try {
      await writeFile(wavPath, encodePcm16MonoWav(pcm), {
        flag: "wx",
        mode: 0o600,
      });
      const stdout = { parts: [], bytes: 0 };
      const stderr = { parts: [], bytes: 0 };
      const transcript = await new Promise((resolve, reject) => {
        const child = this.spawnProcess(ready.command, [
          "-m",
          this.modelPath,
          "-f",
          wavPath,
          "-l",
          this.language,
          "-nt",
          "-np",
          "-t",
          String(this.threads),
          "-ng",
        ], {
          cwd: temporary,
          env: process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let settled = false;
        let timedOut = false;
        let forceKillTimer = null;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(forceKillTimer);
          signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          child.kill("SIGTERM");
          finish(() => reject(new Error("语音识别已取消")));
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
          forceKillTimer.unref?.();
        }, this.timeoutMs);
        timer.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.stdout?.on("data", (chunk) => appendBounded(stdout, chunk));
        child.stderr?.on("data", (chunk) => appendBounded(stderr, chunk));
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code, childSignal) => {
          finish(() => {
            if (timedOut) {
              reject(new Error("本地语音识别超时"));
              return;
            }
            if (code !== 0) {
              const detail = cleanTranscript(Buffer.concat(stderr.parts));
              reject(new Error(
                `本地语音识别失败${detail ? `：${detail.slice(0, 240)}` : ""}` +
                `${childSignal ? ` (${childSignal})` : ""}`,
              ));
              return;
            }
            resolve(cleanTranscript(Buffer.concat(stdout.parts)));
          });
        });
      });
      if (!transcript) throw new Error("没有听清，请再说一次");
      return transcript;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
