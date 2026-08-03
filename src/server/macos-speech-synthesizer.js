import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MACOS_TTS_SAMPLE_RATE = 16_000;
export const MACOS_TTS_VOICE = "com.apple.voice.compact.zh-CN.Tingting";

const BYTES_PER_SAMPLE = 2;
const MAX_TEXT_BYTES = 480;
const MAX_PCM_BYTES = MACOS_TTS_SAMPLE_RATE * BYTES_PER_SAMPLE * 20;
const DEFAULT_RATE = 180;
const DEFAULT_TIMEOUT_MS = 30_000;
const JXA_SYNTHESIZE_SCRIPT = [
  'ObjC.import("AppKit");',
  'ObjC.import("Foundation");',
  'const argv = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);',
  'const marker = argv.lastIndexOf("--");',
  'if (marker < 0 || argv.length !== marker + 5) throw new Error("语音参数无效");',
  'const [text, voice, outputPath, rate] = argv.slice(marker + 1);',
  'const synth = $.NSSpeechSynthesizer.alloc.initWithVoice($(voice));',
  'if (synth === null) throw new Error("本机女声不可用");',
  'synth.setRate(Number(rate));',
  'synth.setVolume(1.0);',
  'const target = $.NSURL.fileURLWithPath($(outputPath));',
  'if (!synth.startSpeakingStringToURL($(text), target)) throw new Error("本机语音合成无法启动");',
  'while (synth.speaking) {',
  '  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));',
  '}',
].join(" ");

function abortedError() {
  const error = new Error("本机语音合成已取消");
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

function runCommand(command, args, { signal, timeoutMs, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`本机语音工具启动失败：${error.message}`));
      return;
    }
    let settled = false;
    let stderr = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child.kill?.("SIGTERM");
      finish(abortedError());
    };
    const timeout = setTimeout(() => {
      child.kill?.("SIGTERM");
      finish(new Error("本机语音合成超时"));
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.once?.("error", (error) => {
      finish(new Error(`本机语音工具启动失败：${error.message}`));
    });
    child.once?.("close", (code) => {
      if (signal?.aborted) {
        finish(abortedError());
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim().replace(/\s+/g, " ");
      finish(new Error(
        detail
          ? `本机语音合成失败：${detail.slice(0, 320)}`
          : `本机语音合成失败（退出码 ${code ?? "未知"}）`,
      ));
    });
  });
}

export function pcm16MonoFromWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.byteLength < 44) {
    throw new TypeError("本机语音输出不是有效 WAV");
  }
  if (wav.subarray(0, 4).toString("ascii") !== "RIFF" ||
      wav.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new TypeError("本机语音输出不是 RIFF/WAV");
  }
  let offset = 12;
  let validFormat = false;
  let data = null;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = wav.readUInt32LE(offset + 4);
    const contentStart = offset + 8;
    const contentEnd = contentStart + chunkLength;
    if (contentEnd > wav.length) throw new TypeError("WAV 块长度无效");
    if (chunkId === "fmt ") {
      if (chunkLength < 16) throw new TypeError("WAV 音频格式无效");
      validFormat =
        wav.readUInt16LE(contentStart) === 1 &&
        wav.readUInt16LE(contentStart + 2) === 1 &&
        wav.readUInt32LE(contentStart + 4) === MACOS_TTS_SAMPLE_RATE &&
        wav.readUInt16LE(contentStart + 14) === 16;
    } else if (chunkId === "data") {
      data = Buffer.from(wav.subarray(contentStart, contentEnd));
    }
    offset = contentEnd + (chunkLength % 2);
  }
  if (!validFormat || !data || data.byteLength === 0 || data.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new TypeError("本机语音 PCM 格式无效");
  }
  if (data.byteLength > MAX_PCM_BYTES) throw new RangeError("本机语音回复过长");
  return data;
}

export class MacosSpeechSynthesizer {
  constructor({
    voice = process.env.CODEX_DESK_TTS_VOICE ?? MACOS_TTS_VOICE,
    rate = DEFAULT_RATE,
    osascriptPath = "/usr/bin/osascript",
    afconvertPath = "/usr/bin/afconvert",
    tempDirectory = os.tmpdir(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    platform = process.platform,
    run = runCommand,
  } = {}) {
    if (typeof voice !== "string" || !voice.startsWith("com.apple.voice.")) {
      throw new TypeError("本机语音标识无效");
    }
    if (!Number.isInteger(rate) || rate < 80 || rate > 320) {
      throw new RangeError("本机语速必须在 80 到 320 之间");
    }
    if (!path.isAbsolute(osascriptPath) || !path.isAbsolute(afconvertPath) || !path.isAbsolute(tempDirectory)) {
      throw new TypeError("本机语音工具路径必须为绝对路径");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new RangeError("本机语音超时必须至少一秒");
    }
    if (typeof run !== "function") throw new TypeError("本机语音执行器无效");
    this.voice = voice;
    this.rate = rate;
    this.osascriptPath = osascriptPath;
    this.afconvertPath = afconvertPath;
    this.tempDirectory = path.resolve(tempDirectory);
    this.timeoutMs = timeoutMs;
    this.platform = platform;
    this.run = run;
  }

  async available() {
    if (this.platform !== "darwin") return false;
    try {
      await Promise.all([
        access(this.osascriptPath, constants.X_OK),
        access(this.afconvertPath, constants.X_OK),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async synthesize(text, { signal } = {}) {
    const phrase = boundedText(text);
    if (signal?.aborted) throw abortedError();
    if (!await this.available()) throw new Error("本机温柔女声不可用");
    const directory = await mkdtemp(path.join(this.tempDirectory, "codex-desk-tts-"));
    const aiffPath = path.join(directory, "speech.aiff");
    const wavPath = path.join(directory, "speech.wav");
    try {
      await this.run(this.osascriptPath, [
        "-l", "JavaScript",
        "-e", JXA_SYNTHESIZE_SCRIPT,
        "--", phrase, this.voice, aiffPath, String(this.rate),
      ], { signal, timeoutMs: this.timeoutMs });
      await this.run(this.afconvertPath, [
        "-f", "WAVE",
        "-d", `LEI16@${MACOS_TTS_SAMPLE_RATE}`,
        aiffPath,
        wavPath,
      ], { signal, timeoutMs: this.timeoutMs });
      if (signal?.aborted) throw abortedError();
      return pcm16MonoFromWav(await readFile(wavPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
