import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalWhisperTranscriber,
  pcm16MonoToWav,
} from "../src/server/local-whisper-transcriber.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
    this.killed = false;
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 143));
    return true;
  }
}

test("pcm16MonoToWav produces a 16 kHz mono WAV header", () => {
  const wav = pcm16MonoToWav(Buffer.from([1, 0, 2, 0]));

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.subarray(44).toString("hex"), "01000200");
});

test("LocalWhisperTranscriber writes a private WAV, invokes whisper-cli, and removes it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-whisper-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelPath = path.join(root, "ggml-base.bin");
  await writeFile(modelPath, "model");
  const calls = [];
  const transcriber = new LocalWhisperTranscriber({
    command: "whisper-cli-test",
    modelPath,
    tempDirectory: root,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new FakeChild();
      queueMicrotask(async () => {
        const audioPath = args[args.indexOf("--file") + 1];
        const wav = await readFile(audioPath);
        assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
        assert.equal(wav.readUInt32LE(24), 16_000);
        child.stdout.emit("data", "你好\n世界\n");
        child.emit("close", 0);
      });
      return child;
    },
  });

  assert.equal(await transcriber.available(), true);
  assert.equal(await transcriber.transcribe(Buffer.alloc(1_280)), "你好 世界");
  assert.deepEqual(calls[0], {
    command: "whisper-cli-test",
    args: [
      "--model", modelPath,
      "--file", calls[0].args[3],
      "--language", "zh",
      "--prompt", "以下是普通话中文对话，请忠实转写用户原话。",
      "--suppress-nst",
      "--threads", "4",
      "--no-timestamps",
      "--no-prints",
    ],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  });
  assert.deepEqual(await readdir(root), ["ggml-base.bin"]);
});

test("LocalWhisperTranscriber reports a missing model and aborts child work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-whisper-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = new LocalWhisperTranscriber({
    modelPath: path.join(root, "missing.bin"),
    tempDirectory: root,
  });
  assert.equal(await missing.available(), false);
  await assert.rejects(
    missing.transcribe(Buffer.alloc(1_280)),
    /模型未准备好/,
  );

  const modelPath = path.join(root, "ggml-base.bin");
  await writeFile(modelPath, "model");
  let child;
  let resolveSpawned;
  const spawned = new Promise((resolve) => {
    resolveSpawned = resolve;
  });
  const transcriber = new LocalWhisperTranscriber({
    modelPath,
    tempDirectory: root,
    spawnProcess: () => {
      child = new FakeChild();
      resolveSpawned();
      return child;
    },
  });
  const controller = new AbortController();
  const pending = transcriber.transcribe(Buffer.alloc(1_280), { signal: controller.signal });
  await spawned;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(child.killed, true);
});

test("LocalWhisperTranscriber rejects an empty or oversized Mandarin prompt", () => {
  assert.throws(
    () => new LocalWhisperTranscriber({ prompt: "" }),
    /转写提示/,
  );
  assert.throws(
    () => new LocalWhisperTranscriber({ prompt: "中".repeat(121) }),
    /转写提示/,
  );
});
