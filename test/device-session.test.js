import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeviceSession } from "../src/server/device-session.js";
import { createMemoryTransportPair } from "../src/server/transports/memory-transport.js";
import {
  createEnvelope,
  isEncryptedEnvelope,
} from "../src/shared/device-protocol.js";

const SECRET = "b".repeat(64);

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for session state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function createSessions({
  clock = { value: 1_000 },
  snapshotProvider = () => ({ revision: 1, presentation: { state: "ready" } }),
  commandHandler = null,
  deviceSecret = SECRET,
  transportKind = "memory",
  sessionOptions = {},
} = {}) {
  const transports = createMemoryTransportPair({ kind: transportKind });
  const bridge = new DeviceSession({
    role: "bridge",
    transport: transports.left,
    secretResolver: (deviceId) => deviceId === "core-s3-1" ? SECRET : null,
    snapshotProvider,
    commandHandler,
    now: () => clock.value,
    nonceFactory: () => "bridge_nonce_1234567890",
    retry: { baseRetryMs: 10, maxRetryMs: 40, maxAttempts: 5 },
    ...sessionOptions,
  });
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "core-s3-1",
    secret: deviceSecret,
    now: () => clock.value,
    nonceFactory: () => "device_nonce_1234567890",
    retry: { baseRetryMs: 10, maxRetryMs: 40, maxAttempts: 5 },
    ...sessionOptions,
  });
  return { bridge, device, transports, clock };
}

test("device and bridge mutually authenticate before the encrypted initial snapshot", async (t) => {
  const { bridge, device, transports } = createSessions();
  t.after(() => {
    bridge.close();
    device.close();
  });
  const snapshots = [];
  const wireSnapshots = [];
  device.on("snapshot", (snapshot) => snapshots.push(snapshot));
  transports.right.on("message", (envelope) => {
    if (envelope.type === "snapshot") wireSnapshots.push(envelope);
  });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });

  await waitFor(() => bridge.ready && device.ready && snapshots.length === 1);
  assert.equal(bridge.sessionId, device.sessionId);
  assert.equal(snapshots[0].revision, 1);
  assert.equal(wireSnapshots.length, 1);
  assert.equal(isEncryptedEnvelope(wireSnapshots[0]), true);
  assert.equal(JSON.stringify(wireSnapshots[0]).includes("\"revision\":1"), false);
  await waitFor(() => bridge.pendingAcknowledgements === 0 && device.pendingAcknowledgements === 0);
});

test("an authenticated session rejects a plaintext downgrade and closes the link", async (t) => {
  const { bridge, device, transports } = createSessions();
  t.after(() => {
    bridge.close();
    device.close();
  });
  let highestDeviceSequence = 0;
  let sessionError = null;
  transports.left.on("message", (envelope) => {
    highestDeviceSequence = Math.max(highestDeviceSequence, envelope.sequence);
  });
  bridge.on("sessionError", (error) => { sessionError = error; });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() =>
    bridge.ready &&
    device.ready &&
    bridge.pendingAcknowledgements === 0 &&
    device.pendingAcknowledgements === 0,
  );

  transports.right.send(createEnvelope({
    sequence: highestDeviceSequence + 1,
    type: "heartbeat",
    payload: { lastReceivedSequence: 0 },
    id: "plaintext-downgrade-0001",
    sentAt: 5_000,
    sessionId: bridge.sessionId,
  }));
  await waitFor(() => sessionError !== null && bridge.state === "closed");
  assert.equal(sessionError.code, "ENCRYPTION_REQUIRED");
  assert.equal(transports.left.open, false);
});

test("device rejects a bridge proof produced with a different pairing secret", async (t) => {
  const { bridge, device } = createSessions({ deviceSecret: "c".repeat(64) });
  t.after(() => {
    bridge.close();
    device.close();
  });
  let failed = null;
  device.on("authenticationFailed", (result) => { failed = result; });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => failed !== null);
  assert.equal(device.state, "rejected");
  assert.equal(failed.reason, "bridge-proof");
});

test("duplicate device commands execute once and return a correlated result", async (t) => {
  const commands = [];
  const { bridge, device, transports } = createSessions({
    commandHandler: async (payload) => {
      commands.push(payload);
      return { selectedId: payload.petId };
    },
  });
  t.after(() => {
    bridge.close();
    device.close();
  });
  const results = [];
  device.on("event", (event) => {
    if (event.event === "command.result") results.push(event);
  });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready);

  transports.right.duplicateNext();
  const commandId = randomUUID();
  device.sendCommand("pet.select", { petId: "codex-core" }, commandId);
  await waitFor(() => results.length === 1 && device.pendingAcknowledgements === 0);
  assert.equal(commands.length, 1);
  assert.equal(results[0].commandId, commandId);
  assert.equal(results[0].ok, true);
});

test("a lost ACK retries without resync or duplicate execution", async (t) => {
  const commands = [];
  const snapshots = [];
  const { bridge, device, transports, clock } = createSessions({
    commandHandler: async (payload) => {
      commands.push(payload);
      return null;
    },
  });
  t.after(() => {
    bridge.close();
    device.close();
  });
  device.on("snapshot", (snapshot) => snapshots.push(snapshot));
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready && snapshots.length === 1);

  transports.left.dropNext();
  device.sendCommand("telemetry.update", {
    batteryPercent: 80,
    charging: false,
    wifiRssi: -60,
  }, randomUUID());
  await waitFor(() => commands.length === 1);
  clock.value += 20;
  device.tick(clock.value);
  await waitFor(() => device.pendingAcknowledgements === 0);
  assert.equal(commands.length, 1);
  assert.equal(snapshots.length, 1);
});

test("a remote sequence gap closes the bridge transport for a clean reconnect", async (t) => {
  const { bridge, device, transports } = createSessions();
  t.after(() => {
    bridge.close();
    device.close();
  });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() =>
    bridge.ready &&
    device.ready &&
    bridge.pendingAcknowledgements === 0 &&
    device.pendingAcknowledgements === 0,
  );

  transports.left.dropNext();
  bridge.sendEvent({ event: "test.dropped" });
  bridge.sendEvent({ event: "test.gap" });
  await waitFor(() => bridge.state === "closed");

  assert.equal(device.state, "closed");
  assert.equal(transports.left.open, false);
  assert.equal(transports.right.open, false);
});

test("pet resources transfer in chunks and install on the device cache", async (t) => {
  const { bridge, device } = createSessions();
  t.after(() => {
    bridge.close();
    device.close();
  });
  let installed = null;
  device.on("resourceInstalled", (manifest) => { installed = manifest; });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready);

  const data = Buffer.alloc(25_000, 0x2a);
  const pet = { id: "resource-pet", displayName: "Resource Pet", spriteVersionNumber: 2 };
  const manifest = bridge.sendResource(pet, data);
  await waitFor(() => installed !== null);
  assert.equal(installed.sha256, manifest.sha256);
  assert.deepEqual(device.resourceCache.get(pet.id).data, data);
});

test("large pet transfers use a bounded ACK window before installing", async (t) => {
  const { bridge, device } = createSessions({
    transportKind: "usb",
    sessionOptions: { maxReliableInFlight: 4 },
  });
  t.after(() => {
    bridge.close();
    device.close();
  });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready);
  const data = Buffer.alloc(256_000, 0x3c);
  bridge.sendResource({ id: "large-pet", displayName: "Large Pet", spriteVersionNumber: 2 }, data);
  assert.equal(bridge.pendingAcknowledgements, 4);
  assert.ok(bridge.queuedMessages > 0);
  await waitFor(() => device.resourceCache.get("large-pet") !== null, 1_500);
  assert.deepEqual(device.resourceCache.get("large-pet").data, data);
  assert.equal(bridge.queuedMessages, 0);
});

test("pet transfer streams beyond the reliable queue limit without buffering every chunk", async (t) => {
  const { bridge, device, transports } = createSessions({
    transportKind: "usb",
    sessionOptions: { maxQueuedReliable: 2 },
  });
  t.after(() => {
    bridge.close();
    device.close();
  });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready && bridge.pendingAcknowledgements === 0);

  transports.right.holdNext();
  const resourceStarted = new Promise((resolve) => device.once("resourceStarted", resolve));
  assert.doesNotThrow(() => {
    bridge.sendResource(
      { id: "streamed-pet", displayName: "Streamed Pet", spriteVersionNumber: 2 },
      Buffer.alloc(64_000, 0x5e),
    );
  });
  assert.equal(bridge.pendingAcknowledgements, 1);
  assert.equal(bridge.queuedMessages, 1);

  await resourceStarted;
  transports.right.flushHeld();
  await waitFor(() => device.resourceCache.get("streamed-pet") !== null, 1_500);
  assert.equal(bridge.queuedMessages, 0);
});

test("snapshots remain responsive while a large resource waits in the reliable queue", async (t) => {
  const { bridge, device, transports } = createSessions({
    transportKind: "usb",
  });
  t.after(() => {
    bridge.close();
    device.close();
  });
  const order = [];
  device.on("snapshot", (snapshot) => {
    if (snapshot.revision === 99) order.push("snapshot");
  });
  device.on("resourceInstalled", () => order.push("resource"));
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready && bridge.pendingAcknowledgements === 0);
  const resourceStarted = new Promise((resolve) => device.once("resourceStarted", resolve));
  transports.right.holdNext();
  bridge.sendResource(
    { id: "priority-pet", displayName: "Priority Pet", spriteVersionNumber: 2 },
    Buffer.alloc(32_000, 0x4d),
  );
  await resourceStarted;
  bridge.sendSnapshot({ revision: 99, presentation: { state: "running" } });
  transports.right.flushHeld();
  await waitFor(() => order.includes("resource"));
  assert.deepEqual(order, ["snapshot", "resource"]);
});

test("heartbeat timeout closes an authenticated session so its transport can reconnect", async (t) => {
  const { bridge, device, clock } = createSessions();
  t.after(() => {
    bridge.close();
    device.close();
  });
  bridge.start({ autoTick: false });
  device.start({ autoTick: false });
  await waitFor(() => bridge.ready && device.ready);
  clock.value += 16_000;
  device.tick(clock.value);
  assert.equal(device.state, "closed");
  assert.equal(bridge.state, "closed");
});

test("an idle unauthenticated transport is closed after the handshake deadline", () => {
  const clock = { value: 1_000 };
  const transports = createMemoryTransportPair();
  const bridge = new DeviceSession({
    role: "bridge",
    transport: transports.left,
    secretResolver: async () => null,
    now: () => clock.value,
    handshakeTimeoutMs: 1_000,
  });
  bridge.start({ autoTick: false });
  clock.value += 1_001;
  bridge.tick(clock.value);
  assert.equal(bridge.state, "closed");
  assert.equal(transports.left.open, false);
});

test("an unauthenticated error is not answered with another error", async (t) => {
  const transports = createMemoryTransportPair();
  const bridge = new DeviceSession({
    role: "bridge",
    transport: transports.left,
    secretResolver: async () => null,
  });
  t.after(() => bridge.close());
  const replies = [];
  transports.right.on("message", (message) => replies.push(message));
  bridge.start({ autoTick: false });

  transports.right.send(createEnvelope({
    sequence: 1,
    type: "error",
    payload: { code: "AUTHENTICATION_REQUIRED" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, []);
});

test("an idle USB bridge keeps one transport open and periodically wakes the device", () => {
  const clock = { value: 1_000 };
  const transports = createMemoryTransportPair({ kind: "usb" });
  let wakeCount = 0;
  transports.left.wakeDevice = () => {
    wakeCount += 1;
  };
  const bridge = new DeviceSession({
    role: "bridge",
    transport: transports.left,
    secretResolver: async () => null,
    now: () => clock.value,
    handshakeTimeoutMs: 1_000,
  });
  bridge.start({ autoTick: false });

  clock.value += 1_001;
  bridge.tick(clock.value);
  assert.equal(bridge.state, "handshaking");
  assert.equal(transports.left.open, true);
  assert.equal(wakeCount, 1);

  bridge.close();
});
