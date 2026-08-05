import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_WHISPER_MODEL_BYTES,
  DEFAULT_WHISPER_MODEL_PATH,
  DEFAULT_WHISPER_MODEL_SHA256,
  DEFAULT_WHISPER_MODEL_URL,
  resolveWhisperExecutable,
  sha256File,
} from "../src/server/local-speech-recognizer.js";

const checkOnly = process.argv.includes("--check");
const configuredCommand = process.env.CODEX_DESK_WHISPER_COMMAND ?? null;
const configuredModel = process.env.CODEX_DESK_WHISPER_MODEL ?? null;
const modelPath = configuredModel
  ? path.resolve(configuredModel)
  : DEFAULT_WHISPER_MODEL_PATH;

function engineInstructions() {
  if (process.platform === "darwin") {
    return "未找到 whisper-cli。请先运行：brew install whisper-cpp";
  }
  return [
    "未找到 whisper-cli。",
    "请安装 whisper.cpp，并将 whisper-cli 加入 PATH，",
    "或通过 CODEX_DESK_WHISPER_COMMAND 指定可执行文件。",
  ].join("");
}

async function modelStatus() {
  try {
    const info = await stat(modelPath);
    if (!info.isFile()) return { ready: false, reason: "路径不是文件" };
    if (configuredModel) {
      return { ready: info.size >= 1_000_000, bytes: info.size };
    }
    if (info.size !== DEFAULT_WHISPER_MODEL_BYTES) {
      return { ready: false, bytes: info.size, reason: "文件大小不符" };
    }
    const digest = await sha256File(modelPath);
    return {
      ready: digest === DEFAULT_WHISPER_MODEL_SHA256,
      bytes: info.size,
      sha256: digest,
      reason: digest === DEFAULT_WHISPER_MODEL_SHA256
        ? null
        : "SHA-256 不符",
    };
  } catch {
    return { ready: false, reason: "文件不存在" };
  }
}

const command = await resolveWhisperExecutable(configuredCommand);
if (!command) throw new Error(engineInstructions());

let current = await modelStatus();
if (current.ready) {
  console.log(`本地语音引擎：${command}`);
  console.log(`本地语音模型：${modelPath}`);
  console.log("本地语音识别已就绪（CPU 模式，不需要 API Key）。");
  process.exit(0);
}
if (checkOnly) {
  throw new Error(`本地语音模型未就绪：${current.reason}`);
}
if (configuredModel) {
  throw new Error(
    `自定义语音模型不可用：${modelPath}（${current.reason}）`,
  );
}
if (current.reason !== "文件不存在") {
  throw new Error(
    `默认模型校验失败：${modelPath}（${current.reason}）。` +
    "请先将该文件移走，再重新运行此命令。",
  );
}

await mkdir(path.dirname(modelPath), { recursive: true, mode: 0o700 });
const temporary = `${modelPath}.download-${process.pid}-${randomUUID()}`;
console.log(`正在下载中文语音模型（${DEFAULT_WHISPER_MODEL_BYTES} 字节）……`);
try {
  const response = await fetch(DEFAULT_WHISPER_MODEL_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`模型下载失败：HTTP ${response.status}`);
  }
  let received = 0;
  let reported = -1;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const percent = Math.floor(
        received / DEFAULT_WHISPER_MODEL_BYTES * 10,
      ) * 10;
      if (percent !== reported && percent <= 100) {
        reported = percent;
        process.stdout.write(`\r下载进度：${percent}%`);
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    progress,
    createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
  );
  process.stdout.write("\n");
  const info = await stat(temporary);
  const digest = await sha256File(temporary);
  if (
    info.size !== DEFAULT_WHISPER_MODEL_BYTES ||
    digest !== DEFAULT_WHISPER_MODEL_SHA256
  ) {
    throw new Error(
      `模型校验失败：bytes=${info.size}, sha256=${digest}`,
    );
  }
  await rename(temporary, modelPath);
  await chmod(modelPath, 0o600);
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}

current = await modelStatus();
if (!current.ready) throw new Error(`模型安装后校验失败：${current.reason}`);
console.log(`本地语音引擎：${command}`);
console.log(`本地语音模型：${modelPath}`);
console.log("本地语音识别已就绪（CPU 模式，不需要 API Key）。");
