import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLiveTab5,
  parseLiveTab5Arguments,
  verifyLiveTab5,
} from "../scripts/verify-live-tab5.mjs";
import { DEVICE_FIRMWARE_VERSION } from "../src/shared/device-protocol.js";

function fixture() {
  return {
    devices: {
      devices: [{
        deviceId: "tab5-test",
        connected: true,
        protocolVersion: 4,
        primaryTransport: "usb",
        transports: ["usb", "ble"],
        compatibility: { compatible: true },
        deviceInfo: {
          boardId: "m5stack-tab5-k145",
          firmwareVersion: DEVICE_FIRMWARE_VERSION,
          capabilities: {
            touch: true,
            speaker: true,
            offlineChineseVoice: true,
            usb: true,
            wifi: true,
            ble: true,
            microSd: true,
            rtc: true,
            camera: true,
          },
          health: {
            voiceDataReady: true,
            storageReady: true,
          },
        },
      }],
    },
    snapshot: {
      connection: { status: "connected" },
      telemetry: { deviceId: "tab5-test" },
      capabilities: { voice: true, vision: true },
      accountTokens: { today: 1234, todayAvailable: true },
      tokens: { total: 5678 },
      tasks: [
        { id: "new", updatedAt: 200 },
        { id: "old", updatedAt: 100 },
      ],
      pet: { selectedId: "custom-pet" },
      voice: {
        status: "completed",
        transcript: "你好",
        error: null,
        updatedAt: 300,
      },
      vision: {
        status: "completed",
        width: 1600,
        height: 1200,
        bytes: 120000,
        reply: "看到桌面",
        error: null,
        updatedAt: 400,
      },
    },
    pets: {
      pets: [{ id: "codex-core" }, { id: "custom-pet" }],
    },
  };
}

test("live Tab5 evaluator verifies real-device state without exposing content", () => {
  const report = evaluateLiveTab5(fixture());
  assert.deepEqual(report.device.transports, ["usb", "ble"]);
  assert.equal(report.codex.newestTaskFirst, true);
  assert.equal(report.codex.todayTokens, 1234);
  assert.equal(report.pet.selectedId, "custom-pet");
  assert.equal(report.evidence.voice.completed, true);
  assert.equal(report.evidence.voice.transcriptCharacters, 2);
  assert.equal(report.evidence.vision.completed, true);
  assert.equal(report.evidence.vision.replyCharacters, 4);
  assert.equal("transcript" in report.evidence.voice, false);
  assert.equal("reply" in report.evidence.vision, false);
});

test("live Tab5 evaluator rejects stale task ordering and unhealthy storage", () => {
  const unordered = fixture();
  unordered.snapshot.tasks.reverse();
  assert.throws(
    () => evaluateLiveTab5(unordered),
    /最近任务没有按时间倒序排列/,
  );

  const unhealthy = fixture();
  unhealthy.devices.devices[0].deviceInfo.health.storageReady = false;
  assert.throws(
    () => evaluateLiveTab5(unhealthy),
    /microSD 未就绪/,
  );
});

test("live Tab5 arguments only permit loopback and known evidence", () => {
  assert.deepEqual(
    parseLiveTab5Arguments([
      "--url", "http://localhost:5000/",
      "--wait-for", "voice,vision,voice",
      "--timeout-ms", "5000",
      "--poll-ms", "100",
    ]),
    {
      baseUrl: "http://localhost:5000",
      waitFor: ["voice", "vision"],
      timeoutMs: 5000,
      pollMs: 100,
    },
  );
  assert.throws(
    () => parseLiveTab5Arguments(["--url", "http://192.168.1.10:4317"]),
    /只允许读取本机回环 Bridge/,
  );
  assert.throws(
    () => parseLiveTab5Arguments(["--wait-for", "camera"]),
    /未知的真机证据/,
  );
  assert.throws(
    () => parseLiveTab5Arguments(["--timeout-ms"]),
    /缺少参数/,
  );
});

test("live evidence polling reads the Pet catalog only once", async () => {
  const originalFetch = globalThis.fetch;
  const source = fixture();
  let petReads = 0;
  let snapshotReads = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/api/devices") {
      return new Response(JSON.stringify(source.devices), { status: 200 });
    }
    if (route === "/api/pets") {
      petReads += 1;
      return new Response(JSON.stringify(source.pets), { status: 200 });
    }
    if (route === "/api/snapshot") {
      snapshotReads += 1;
      const snapshot = structuredClone(source.snapshot);
      if (snapshotReads === 1) {
        snapshot.voice.status = "idle";
        snapshot.voice.transcript = null;
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  try {
    const report = await verifyLiveTab5({
      waitFor: ["voice"],
      timeoutMs: 1_000,
      pollMs: 1,
    });
    assert.equal(report.evidence.voice.completed, true);
    assert.equal(snapshotReads, 2);
    assert.equal(petReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
