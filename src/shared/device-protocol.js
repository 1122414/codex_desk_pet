import { randomUUID } from "node:crypto";

export const DEVICE_PROTOCOL_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const CONNECTION_TIMEOUT_MS = 15_000;

export const MESSAGE_TYPES = Object.freeze([
  "snapshot",
  "event",
  "command",
  "ack",
  "heartbeat",
  "error",
]);

export const DEVICE_COMMANDS = Object.freeze([
  "pet.select",
  "approval.decide",
  "telemetry.update",
  "state.preview",
]);

export class ProtocolError extends Error {
  constructor(message, code = "INVALID_MESSAGE") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function createEnvelope({ sequence, type, payload = {}, id = randomUUID(), sentAt = Date.now() }) {
  const envelope = {
    version: DEVICE_PROTOCOL_VERSION,
    id,
    sequence,
    type,
    sentAt,
    payload,
  };
  validateEnvelope(envelope);
  return envelope;
}

export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new ProtocolError("Message must be an object");
  }
  if (envelope.version !== DEVICE_PROTOCOL_VERSION) {
    throw new ProtocolError("Unsupported protocol version", "UNSUPPORTED_VERSION");
  }
  if (typeof envelope.id !== "string" || envelope.id.length < 8 || envelope.id.length > 128) {
    throw new ProtocolError("Message id is invalid");
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
    throw new ProtocolError("Message sequence must be a positive safe integer");
  }
  if (!MESSAGE_TYPES.includes(envelope.type)) {
    throw new ProtocolError("Message type is invalid");
  }
  if (!Number.isFinite(envelope.sentAt) || envelope.sentAt <= 0) {
    throw new ProtocolError("Message sentAt is invalid");
  }
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new ProtocolError("Message payload must be an object");
  }
  if (envelope.type === "command" && !DEVICE_COMMANDS.includes(envelope.payload.command)) {
    throw new ProtocolError("Device command is not supported", "UNSUPPORTED_COMMAND");
  }
  return envelope;
}

export function createAck(envelope, sequence) {
  validateEnvelope(envelope);
  return createEnvelope({
    sequence,
    type: "ack",
    payload: { acknowledgedId: envelope.id, acknowledgedSequence: envelope.sequence },
  });
}

export class SequenceWindow {
  #lastAccepted = 0;

  get lastAccepted() {
    return this.#lastAccepted;
  }

  observe(envelope) {
    validateEnvelope(envelope);
    if (envelope.sequence <= this.#lastAccepted) {
      return { status: "duplicate", accepted: false, expected: this.#lastAccepted + 1 };
    }
    if (envelope.type !== "snapshot" && envelope.sequence !== this.#lastAccepted + 1) {
      return { status: "gap", accepted: false, expected: this.#lastAccepted + 1 };
    }
    this.#lastAccepted = envelope.sequence;
    return { status: "accepted", accepted: true, expected: this.#lastAccepted + 1 };
  }

  reset() {
    this.#lastAccepted = 0;
  }
}

export class CommandDeduplicator {
  #ids = new Set();
  #queue = [];

  constructor(limit = 256) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Deduplication limit must be positive");
    this.limit = limit;
  }

  accept(id) {
    if (typeof id !== "string" || !id) throw new TypeError("Command id is required");
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    this.#queue.push(id);
    while (this.#queue.length > this.limit) {
      this.#ids.delete(this.#queue.shift());
    }
    return true;
  }
}

