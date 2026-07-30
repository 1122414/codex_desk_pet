import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeskStore } from "../src/server/desk-store.js";
import { VisionAgent } from "../src/server/vision-agent.js";

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

test("camera JPEG is authenticated, reassembled, analyzed, and removed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-vision-test-"));
  const observations = [];
  const careAgent = {
    observeImage: async (imagePath, context) => {
      observations.push({ image: await readFile(imagePath), context });
      return { say: "我看到桌面前有一个人。" };
    },
  };
  const store = new DeskStore();
  const events = [];
  const session = {
    ready: true,
    deviceId: "tab5-vision-1",
    transport: { kind: "wifi" },
    sendEvent: (event) => events.push(event),
  };
  const agent = new VisionAgent({ store, careAgent, root });
  t.after(() => agent.close());
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
  const captureId = "0123456789abcdef";

  assert.equal(agent.acceptEvent(session, {
    event: "vision.capture.begin",
    captureId,
    mimeType: "image/jpeg",
    totalBytes: jpeg.length,
    width: 1_280,
    height: 720,
    sha256: createHash("sha256").update(jpeg).digest("hex"),
  }), true);
  assert.equal(agent.acceptEvent(session, {
    event: "vision.capture.chunk",
    captureId,
    offset: 0,
    data: jpeg.subarray(0, 4).toString("base64"),
  }), true);
  assert.equal(agent.acceptEvent(session, {
    event: "vision.capture.chunk",
    captureId,
    offset: 4,
    data: jpeg.subarray(4).toString("base64"),
  }), true);
  assert.equal(agent.acceptEvent(session, {
    event: "vision.capture.end",
    captureId,
  }), true);
  await settle();

  assert.deepEqual(observations, [{
    image: jpeg,
    context: {
      deviceId: "tab5-vision-1",
      state: {
        captureId,
        width: 1_280,
        height: 720,
      },
    },
  }]);
  assert.deepEqual(events, [{
    event: "vision.reply",
    ok: true,
    text: "我看到桌面前有一个人。",
    silent: false,
  }]);
  assert.equal(store.snapshot().vision.status, "completed");
});

test("camera transfer rejects BLE and out-of-order chunks", () => {
  const store = new DeskStore();
  const agent = new VisionAgent({
    store,
    careAgent: { observeImage: async () => ({ say: "unused" }) },
  });
  const session = {
    ready: true,
    deviceId: "tab5-vision-2",
    transport: { kind: "usb" },
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const captureId = "fedcba9876543210";

  assert.throws(() => agent.acceptEvent({
    ...session,
    transport: { kind: "ble" },
  }, {
    event: "vision.capture.begin",
  }), /USB 或 Wi-Fi/);
  agent.acceptEvent(session, {
    event: "vision.capture.begin",
    captureId,
    mimeType: "image/jpeg",
    totalBytes: jpeg.length,
    width: 1_280,
    height: 720,
    sha256: createHash("sha256").update(jpeg).digest("hex"),
  });
  assert.throws(() => agent.acceptEvent(session, {
    event: "vision.capture.chunk",
    captureId,
    offset: 1,
    data: jpeg.toString("base64"),
  }), /分块无效/);
  agent.close();
});
