import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeskStore } from "../src/server/desk-store.js";
import { VisionAgent } from "../src/server/vision-agent.js";

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

async function waitFor(check, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待摄像头处理完成超时");
}

test("camera JPEG is authenticated, reassembled, analyzed, and removed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-vision-test-"));
  const observations = [];
  const petAgent = {
    observeImage: async (imagePath) => {
      observations.push(await readFile(imagePath));
      return { reply: "我看到桌面前有一个人。" };
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
  const agent = new VisionAgent({ store, petAgent, root });
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

  assert.deepEqual(observations, [jpeg]);
  assert.deepEqual(events, [{
    event: "vision.reply",
    ok: true,
    text: "我看到桌面前有一个人。",
  }]);
  assert.equal(store.snapshot().vision.status, "completed");
  assert.deepEqual(await readdir(root), []);
});

test("camera transfer rejects BLE and out-of-order chunks", () => {
  const store = new DeskStore();
  const agent = new VisionAgent({
    store,
    petAgent: { observeImage: async () => ({ reply: "unused" }) },
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

test("camera accepts only one in-flight capture per authenticated device", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-vision-limit-"));
  let releaseObservation;
  const observation = new Promise((resolve) => {
    releaseObservation = resolve;
  });
  const agent = new VisionAgent({
    store: new DeskStore(),
    petAgent: {
      observeImage: async () => {
        await observation;
        return { reply: "完成" };
      },
    },
    root,
  });
  t.after(() => agent.close());
  const session = {
    ready: true,
    deviceId: "tab5-vision-limit",
    transport: { kind: "usb" },
    sendEvent: () => {},
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const begin = (captureId) => ({
    event: "vision.capture.begin",
    captureId,
    mimeType: "image/jpeg",
    totalBytes: jpeg.length,
    width: 1_280,
    height: 720,
    sha256: createHash("sha256").update(jpeg).digest("hex"),
  });
  agent.acceptEvent(session, begin("1111111111111111"));
  agent.acceptEvent(session, {
    event: "vision.capture.chunk",
    captureId: "1111111111111111",
    offset: 0,
    data: jpeg.toString("base64"),
  });
  agent.acceptEvent(session, {
    event: "vision.capture.end",
    captureId: "1111111111111111",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => agent.acceptEvent(session, begin("2222222222222222")),
    /上一张照片仍在处理/,
  );
  releaseObservation();
  await waitFor(() => {
    try {
      return agent.acceptEvent(session, begin("3333333333333333"));
    } catch (error) {
      if (!/上一张照片仍在处理/.test(error.message)) throw error;
      return false;
    }
  });
});
