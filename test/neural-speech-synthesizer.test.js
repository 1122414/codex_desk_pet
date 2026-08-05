import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  FallbackSpeechSynthesizer,
  NeuralSpeechSynthesizer,
} from "../src/server/neural-speech-synthesizer.js";

function pcmWav(samples) {
  const wav = Buffer.alloc(44 + samples.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples.length, 40);
  samples.copy(wav, 44);
  return wav;
}

function fixture({ fetchImpl, spawnProcess = null, accessPath = null } = {}) {
  return new NeuralSpeechSynthesizer({
    endpoint: "http://127.0.0.1:4320/v1/speech",
    pythonPath: "/private/tmp/neural-tts-test/python",
    servicePath: "/private/tmp/neural-tts-test/service.py",
    baseModelPath: "/private/tmp/neural-tts-test/model",
    referenceAudioPath: "/private/tmp/neural-tts-test/reference.wav",
    profilePath: "/private/tmp/neural-tts-test/profile.json",
    platform: "darwin",
    fetchImpl,
    spawnProcess: spawnProcess ?? (() => {
      throw new Error("unexpected child process");
    }),
    accessPath: accessPath ?? (async () => {}),
  });
}

test("NeuralSpeechSynthesizer uses the local service and returns Tab5 PCM", async () => {
  const calls = [];
  const synthesizer = fixture({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(pcmWav(Buffer.from([1, 0, 2, 0])), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    },
  });

  assert.equal(await synthesizer.available(), true);
  assert.deepEqual(await synthesizer.synthesize("你好，斯卡蒂"), Buffer.from([1, 0, 2, 0]));
  assert.equal(calls.filter(({ url }) => url.endsWith("/health")).length, 2);
  const request = calls.find(({ url }) => url.endsWith("/v1/speech"));
  assert.deepEqual(JSON.parse(request.options.body), { text: "你好，斯卡蒂" });
  assert.equal(request.options.method, "POST");
});

test("NeuralSpeechSynthesizer starts its local sidecar only when all assets exist", async () => {
  let healthy = false;
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const synthesizer = fixture({
    fetchImpl: async () => new Response(JSON.stringify({ ok: healthy }), {
      status: healthy ? 200 : 503,
      headers: { "content-type": "application/json" },
    }),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(await synthesizer.available(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/private/tmp/neural-tts-test/python");
  assert.deepEqual(calls[0].args, [
    "/private/tmp/neural-tts-test/service.py",
    "--model", "/private/tmp/neural-tts-test/model",
    "--reference-audio", "/private/tmp/neural-tts-test/reference.wav",
    "--profile", "/private/tmp/neural-tts-test/profile.json",
    "--host", "127.0.0.1",
    "--port", "4320",
  ]);
  healthy = true;
  assert.equal(await synthesizer.available(), true);
  await synthesizer.close();
});

test("NeuralSpeechSynthesizer stays unavailable when a required asset is absent", async () => {
  let starts = 0;
  const synthesizer = fixture({
    fetchImpl: async () => new Response("down", { status: 503 }),
    spawnProcess: () => {
      starts += 1;
      return new EventEmitter();
    },
    accessPath: async (target) => {
      if (target.endsWith("profile.json")) throw new Error("missing");
    },
  });

  assert.equal(await synthesizer.available(), false);
  assert.equal(starts, 0);
});

test("FallbackSpeechSynthesizer retains the Apple voice when neural synthesis fails", async () => {
  const calls = [];
  const fallback = new FallbackSpeechSynthesizer({
    primary: {
      available: async () => true,
      synthesize: async () => {
        calls.push("neural");
        throw new Error("service unavailable");
      },
    },
    fallback: {
      available: async () => true,
      synthesize: async (text) => {
        calls.push(`apple:${text}`);
        return Buffer.from([3, 0]);
      },
    },
  });

  assert.equal(await fallback.available(), true);
  assert.deepEqual(await fallback.synthesize("继续聊吧"), Buffer.from([3, 0]));
  assert.deepEqual(calls, ["neural", "apple:继续聊吧"]);
});

test("NeuralSpeechSynthesizer rejects non-local endpoints and oversized text", async () => {
  assert.throws(
    () => new NeuralSpeechSynthesizer({ endpoint: "https://example.com/v1/speech" }),
    /本机 \/v1\/speech/,
  );
  const synthesizer = fixture({
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(() => synthesizer.synthesize("中".repeat(241)), /语音文本过长/);
});
