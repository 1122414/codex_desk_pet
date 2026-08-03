import test from "node:test";
import assert from "node:assert/strict";
import {
  MACOS_TTS_SAMPLE_RATE,
  MacosSpeechSynthesizer,
  pcm16MonoFromWav,
} from "../src/server/macos-speech-synthesizer.js";

function pcmWav(samples, { sampleRate = MACOS_TTS_SAMPLE_RATE } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const filler = Buffer.from("padding");
  const total = 12 + 8 + fmt.length + 8 + filler.length + (filler.length % 2) + 8 + samples.length;
  const wav = Buffer.alloc(total);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(total - 8, 4);
  wav.write("WAVE", 8, "ascii");
  let offset = 12;
  wav.write("fmt ", offset, "ascii");
  wav.writeUInt32LE(fmt.length, offset + 4);
  fmt.copy(wav, offset + 8);
  offset += 8 + fmt.length;
  wav.write("FLLR", offset, "ascii");
  wav.writeUInt32LE(filler.length, offset + 4);
  filler.copy(wav, offset + 8);
  offset += 8 + filler.length + (filler.length % 2);
  wav.write("data", offset, "ascii");
  wav.writeUInt32LE(samples.length, offset + 4);
  samples.copy(wav, offset + 8);
  return wav;
}

test("pcm16MonoFromWav reads 16 kHz mono audio after converter filler chunks", () => {
  const samples = Buffer.from([0x01, 0x00, 0xfe, 0xff]);

  assert.deepEqual(pcm16MonoFromWav(pcmWav(samples)), samples);
});

test("pcm16MonoFromWav rejects unexpected sample formats", () => {
  assert.throws(
    () => pcm16MonoFromWav(pcmWav(Buffer.from([0x01, 0x00]), { sampleRate: 22_050 })),
    /PCM 格式无效/,
  );
  assert.throws(() => pcm16MonoFromWav(Buffer.from("not a wav")), /有效 WAV/);
});

test("MacosSpeechSynthesizer stays unavailable away from macOS", async () => {
  const synthesizer = new MacosSpeechSynthesizer({ platform: "linux" });

  assert.equal(await synthesizer.available(), false);
  await assert.rejects(() => synthesizer.synthesize("你好"), /温柔女声不可用/);
});
