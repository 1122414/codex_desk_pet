import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FallbackTranscriber,
  LocalWhisperTranscriber,
  normalizePcm16MonoForTranscription,
  pcm16MonoToWav,
  WhisperServerTranscriber,
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

test("normalizePcm16MonoForTranscription raises quiet speech without clipping", () => {
  const quiet = Buffer.alloc(4);
  quiet.writeInt16LE(1_000, 0);
  quiet.writeInt16LE(-1_000, 2);
  const normalized = normalizePcm16MonoForTranscription(quiet);
  assert.equal(normalized.readInt16LE(0), 4_800);
  assert.equal(normalized.readInt16LE(2), -4_800);

  const nearlySilent = Buffer.alloc(4);
  nearlySilent.writeInt16LE(30, 0);
  nearlySilent.writeInt16LE(-30, 2);
  assert.deepEqual(normalizePcm16MonoForTranscription(nearlySilent), nearlySilent);

  const loud = Buffer.alloc(4);
  loud.writeInt16LE(20_000, 0);
  loud.writeInt16LE(-20_000, 2);
  assert.deepEqual(normalizePcm16MonoForTranscription(loud), loud);
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
      "--no-fallback",
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

test("WhisperServerTranscriber keeps the local model warm and sends one in-memory WAV", async () => {
  const calls = [];
  const transcriber = new WhisperServerTranscriber({
    endpoint: "http://127.0.0.1:4323/inference",
    command: "whisper-server-test",
    modelPath: "/private/tmp/whisper-server-test/ggml-base.bin",
    platform: "darwin",
    accessPath: async () => {},
    spawnProcess: () => {
      throw new Error("healthy service must not spawn");
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/")) return new Response("ready", { status: 200 });
      assert.equal(options.method, "POST");
      const file = options.body.get("file");
      assert.equal(file.name, "utterance.wav");
      const wav = Buffer.from(await file.arrayBuffer());
      assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(wav.readUInt32LE(24), 16_000);
      return new Response(JSON.stringify({ text: "你好\n斯卡蒂" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(await transcriber.available(), true);
  assert.equal(await transcriber.transcribe(Buffer.alloc(1_280)), "你好 斯卡蒂");
  assert.equal(calls.filter(({ url }) => url.endsWith("/")).length, 2);
});

test("WhisperServerTranscriber starts whisper-server only after its local health probe fails", async () => {
  let healthy = false;
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const transcriber = new WhisperServerTranscriber({
    endpoint: "http://127.0.0.1:4323/inference",
    command: "whisper-server-test",
    modelPath: "/private/tmp/whisper-server-test/ggml-base.bin",
    platform: "darwin",
    accessPath: async () => {},
    fetchImpl: async () => new Response("ready", { status: healthy ? 200 : 503 }),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      healthy = true;
      return child;
    },
  });

  assert.equal(await transcriber.available(), true);
  assert.deepEqual(calls, [{
    command: "whisper-server-test",
    args: [
      "--model", "/private/tmp/whisper-server-test/ggml-base.bin",
      "--language", "zh",
      "--prompt", "以下是普通话中文对话，请忠实转写用户原话。",
      "--suppress-nst",
      "--no-fallback",
      "--threads", "4",
      "--host", "127.0.0.1",
      "--port", "4323",
    ],
    options: { stdio: ["ignore", "ignore", "ignore"] },
  }]);
  await transcriber.close();
});

test("FallbackTranscriber uses the one-shot CLI only when the warm server fails", async () => {
  const calls = [];
  const transcriber = new FallbackTranscriber({
    primary: {
      available: async () => true,
      transcribe: async () => {
        calls.push("server");
        throw new Error("server unavailable");
      },
    },
    fallback: {
      available: async () => true,
      transcribe: async () => {
        calls.push("cli");
        return "备用转写";
      },
    },
  });

  assert.equal(await transcriber.available(), true);
  assert.equal(await transcriber.transcribe(Buffer.alloc(1_280)), "备用转写");
  assert.deepEqual(calls, ["server", "cli"]);
});
