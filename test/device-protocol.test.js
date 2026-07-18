import test from "node:test";
import assert from "node:assert/strict";
import {
  CommandDeduplicator,
  ProtocolError,
  SequenceWindow,
  createAck,
  createEnvelope,
  validateEnvelope,
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
    () => createEnvelope({ sequence: 1, type: "command", payload: { command: "shell.run" }, id: "message-0002" }),
    (error) => error instanceof ProtocolError && error.code === "UNSUPPORTED_COMMAND",
  );
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

