import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { DEFAULT_WHISPER_MODEL_PATH } from "../src/server/local-whisper-transcriber.js";

const model = {
  path: process.env.CODEX_DESK_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL_PATH,
  source: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  sha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
};
const whisperCommand = process.env.CODEX_DESK_WHISPER_COMMAND ?? "whisper-cli";

async function digestFile(target) {
  const hash = createHash("sha1");
  const digest = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const sink = new Transform({ transform(chunk, encoding, callback) { callback(); } });
  await pipeline(createReadStream(target), digest, sink);
  return hash.digest("hex");
}

async function validModel() {
  try {
    await access(model.path, constants.R_OK);
    return await digestFile(model.path) === model.sha1;
  } catch {
    return false;
  }
}

function requireWhisperCli() {
  const result = spawnSync(whisperCommand, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`找不到可用的 ${whisperCommand}；请先安装 whisper.cpp，例如：brew install whisper-cpp`);
  }
}

async function downloadModel() {
  if (await validModel()) {
    process.stdout.write(`已验证本地 Whisper 模型：${model.path}\n`);
    return;
  }
  const response = await fetch(model.source);
  if (!response.ok || !response.body) {
    throw new Error(`下载本地 Whisper 模型失败：HTTP ${response.status}`);
  }
  await mkdir(path.dirname(model.path), { recursive: true, mode: 0o700 });
  const temporary = `${model.path}.tmp-${process.pid}`;
  const hash = createHash("sha1");
  const digest = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      digest,
      createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
    );
    const actual = hash.digest("hex");
    if (actual !== model.sha1) {
      throw new Error(`本地 Whisper 模型校验失败：期望 ${model.sha1}，得到 ${actual}`);
    }
    await rename(temporary, model.path);
    process.stdout.write(`本地 Whisper 中文转写模型已准备：${model.path}\n`);
  } finally {
    await rm(temporary, { force: true });
  }
}

try {
  requireWhisperCli();
  await downloadModel();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
