import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_SPEECH_MAX_SECONDS,
  LOCAL_SPEECH_SAMPLE_RATE,
  LocalSpeechRecognizer,
  encodePcm16MonoWav,
} from "../src/server/local-speech-recognizer.js";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function createFixture(t, scriptBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-speech-test-"));
  const model = Buffer.from("fixture-whisper-model");
  const modelPath = path.join(root, "model.bin");
  const command = path.join(root, "fake-whisper");
  const temporaryRoot = path.join(root, "temporary");
  await writeFile(modelPath, model);
  await writeFile(command, `#!/usr/bin/env node\n${scriptBody}\n`);
  await chmod(command, 0o755);
  await mkdir(temporaryRoot);
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    model,
    modelPath,
    command,
    temporaryRoot,
    recognizer: new LocalSpeechRecognizer({
      command,
      modelPath,
      modelBytes: model.length,
      modelSha256: sha256(model),
      minimumModelBytes: 1,
      temporaryRoot,
      timeoutMs: 2_000,
      threads: 2,
    }),
  };
}

test("PCM encoder creates a valid 16 kHz mono WAV header", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = encodePcm16MonoWav(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 40);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), LOCAL_SPEECH_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("local recognizer verifies its model, forces CPU mode, and removes audio", async (t) => {
  const fixture = await createFixture(t, `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("-ng")) process.exit(12);
const wav = fs.readFileSync(args[args.indexOf("-f") + 1]);
if (wav.toString("ascii", 0, 4) !== "RIFF") process.exit(13);
process.stdout.write("测试语音，请识别这句话。\\n");
`);
  const status = await fixture.recognizer.status();
  assert.equal(status.ready, true);
  assert.equal(status.gpu, false);
  assert.equal(status.modelSha256, sha256(fixture.model));

  const transcript = await fixture.recognizer.transcribe(Buffer.alloc(640));
  assert.equal(transcript, "测试语音，请识别这句话。");
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test("local recognizer rejects corrupt models and overlong recordings", async (t) => {
  const fixture = await createFixture(t, "process.stdout.write('不会运行');");
  const corrupt = new LocalSpeechRecognizer({
    command: fixture.command,
    modelPath: fixture.modelPath,
    modelBytes: fixture.model.length,
    modelSha256: "0".repeat(64),
    minimumModelBytes: 1,
    temporaryRoot: fixture.temporaryRoot,
  });
  assert.equal((await corrupt.status()).ready, false);
  await assert.rejects(
    fixture.recognizer.transcribe(
      Buffer.alloc(
        LOCAL_SPEECH_SAMPLE_RATE * 2 * LOCAL_SPEECH_MAX_SECONDS + 2,
      ),
    ),
    /不能超过 30 秒/,
  );
});

test("local recognizer supports cancellation and still removes audio", async (t) => {
  const fixture = await createFixture(t, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = fixture.recognizer.transcribe(Buffer.alloc(640), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /已取消/);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});
