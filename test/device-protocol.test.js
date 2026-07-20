import test from "node:test";
import assert from "node:assert/strict";
import {
  AtomicPetResourceCache,
  CommandDeduplicator,
  ReliableOutbox,
  ReconnectBackoff,
  ProtocolError,
  SequenceWindow,
  TRANSPORT_PROFILES,
  createAck,
  createEnvelope,
  createHandshakeProof,
  createPetResourceManifest,
  createResourceChunks,
  deriveSessionId,
  parseEnvelope,
  serializeEnvelope,
  validateEnvelope,
  verifyHandshakeProof,
} from "../src/shared/device-protocol.js";

test("protocol creates valid versioned envelopes and acknowledgements", () => {
  const message = createEnvelope({ sequence: 1, type: "snapshot", payload: { state: "ready" }, id: "message-0001", sentAt: 10 });
  assert.equal(validateEnvelope(message), message);
  const ack = createAck(message, 2);
  assert.equal(ack.payload.acknowledgedSequence, 1);
  assert.equal(ack.payload.acknowledgedId, "message-0001");
});

test("protocol rejects unsupported commands", () => {
  assert.throws(
    () => createEnvelope({
      sequence: 1,
      type: "command",
      payload: { command: "shell.run", commandId: "command-0002" },
      id: "message-0002",
    }),
    (error) => error instanceof ProtocolError && error.code === "UNSUPPORTED_COMMAND",
  );
});

test("protocol rejects malformed command payloads before they reach the Bridge", () => {
  assert.throws(() => createEnvelope({
    sequence: 1,
    type: "command",
    payload: {
      command: "telemetry.update",
      commandId: "command-telemetry-1",
      batteryPercent: 50,
      charging: "false",
      wifiRssi: -60,
    },
  }), /charging/);
  assert.throws(() => createEnvelope({
    sequence: 2,
    type: "command",
    payload: {
      command: "state.preview",
      commandId: "command-preview-1",
      animation: "unknown",
    },
  }), /animation/);
});

test("sequence window detects duplicates and gaps and accepts snapshot resync", () => {
  const window = new SequenceWindow();
  const event = (sequence, type = "event") => createEnvelope({ sequence, type, id: `message-${sequence.toString().padStart(4, "0")}` });
  assert.equal(window.observe(event(1)).status, "accepted");
  assert.equal(window.observe(event(1)).status, "duplicate");
  assert.deepEqual(window.observe(event(3)), { status: "gap", accepted: false, expected: 2 });
  assert.equal(window.observe(event(3, "snapshot")).status, "accepted");
  assert.equal(window.lastAccepted, 3);
});

test("command deduplicator keeps bounded idempotency history", () => {
  const dedupe = new CommandDeduplicator(2);
  assert.equal(dedupe.accept("one"), true);
  assert.equal(dedupe.accept("one"), false);
  assert.equal(dedupe.accept("two"), true);
  assert.equal(dedupe.accept("three"), true);
  assert.equal(dedupe.accept("one"), true);
});

test("transport profiles enforce serialized envelope limits", () => {
  const message = createEnvelope({
    sequence: 1,
    type: "event",
    payload: { value: "small" },
    id: "message-size-1",
  });
  assert.deepEqual(parseEnvelope(serializeEnvelope(message, "ble"), "ble"), message);
  const oversized = createEnvelope({
    sequence: 2,
    type: "event",
    payload: { value: "x".repeat(TRANSPORT_PROFILES.ble.maxEnvelopeBytes) },
    id: "message-size-2",
  });
  assert.throws(() => serializeEnvelope(oversized, "ble"), /exceeds/);
});

test("mutual authentication proofs bind both nonces, device, and role", () => {
  const context = {
    secret: "a".repeat(64),
    deviceId: "desk-unit-1",
    deviceNonce: "device_nonce_1234567890",
    bridgeNonce: "bridge_nonce_1234567890",
  };
  const proof = createHandshakeProof({ ...context, role: "bridge" });
  assert.equal(verifyHandshakeProof({ ...context, role: "bridge", proof }), true);
  assert.equal(verifyHandshakeProof({ ...context, role: "device", proof }), false);
  assert.equal(deriveSessionId(context).length, 32);
});

test("reliable outbox retries with backoff and stops after its attempt limit", () => {
  const outbox = new ReliableOutbox({ baseRetryMs: 10, maxRetryMs: 40, maxAttempts: 3 });
  const message = createEnvelope({
    sequence: 1,
    type: "event",
    payload: { event: "state" },
    id: "reliable-message-1",
    sentAt: 1,
  });
  outbox.track(message, 0);
  assert.deepEqual(outbox.poll(9), { retry: [], failed: [] });
  assert.deepEqual(outbox.poll(10).retry, [message]);
  assert.deepEqual(outbox.poll(30).retry, [message]);
  assert.deepEqual(outbox.poll(70), { retry: [], failed: [message] });

  const second = createEnvelope({
    sequence: 2,
    type: "event",
    payload: { event: "state" },
    id: "reliable-message-2",
    sentAt: 2,
  });
  outbox.track(second, 100);
  const ack = createAck(second, 3);
  assert.equal(outbox.acknowledge(ack), true);
  assert.equal(outbox.size, 0);
});

test("reconnect backoff is bounded, jitterable, and resettable", () => {
  const backoff = new ReconnectBackoff({
    delaysMs: [1_000, 2_000, 4_000],
    jitterRatio: 0,
  });
  assert.deepEqual([backoff.next(), backoff.next(), backoff.next(), backoff.next()], [1_000, 2_000, 4_000, 4_000]);
  backoff.reset();
  assert.equal(backoff.next(), 1_000);
});

test("pet resource chunks resume and install atomically only after full hash verification", () => {
  const original = Buffer.from("old-pet");
  const replacement = Buffer.alloc(1_100, 0x5a);
  const pet = { id: "desk-fox", displayName: "Desk Fox", description: "Fixture", spriteVersionNumber: 2 };
  const oldManifest = createPetResourceManifest(pet, original);
  const newManifest = createPetResourceManifest(pet, replacement);
  const cache = new AtomicPetResourceCache();
  cache.begin(oldManifest);
  for (const chunk of createResourceChunks(oldManifest, original, 4)) cache.acceptChunk(chunk);
  cache.commit(pet.id, oldManifest.sha256);

  cache.begin(newManifest);
  const chunks = createResourceChunks(newManifest, replacement, 128);
  cache.acceptChunk(chunks[1]);
  assert.deepEqual(cache.resumeState(pet.id).missingRanges[0], { offset: 0, length: 128 });
  const beforeResume = cache.resumeState(pet.id);
  assert.deepEqual(cache.begin(newManifest), beforeResume);
  assert.deepEqual(
    createResourceChunks(newManifest, replacement, 128, beforeResume.missingRanges)
      .map((chunk) => chunk.offset),
    [0, 256, 384, 512, 640, 768, 896, 1024],
  );
  assert.throws(() => cache.commit(pet.id, newManifest.sha256), /incomplete/);
  assert.deepEqual(cache.get(pet.id).data, original);

  const corrupt = { ...chunks[0], data: Buffer.from("corrupt").toString("base64") };
  assert.throws(() => cache.acceptChunk(corrupt), /checksum/);
  for (const chunk of chunks) cache.acceptChunk(chunk);
  assert.equal(cache.acceptChunk(chunks[0]).duplicate, true);
  cache.commit(pet.id, newManifest.sha256);
  assert.deepEqual(cache.get(pet.id).data, replacement);
});
