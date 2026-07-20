import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { PET_ATLAS, STANDARD_ANIMATIONS } from "./pet-spec.js";

export const DEVICE_PROTOCOL_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const CONNECTION_TIMEOUT_MS = 15_000;
export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_RANGES = 1_024;

export const MESSAGE_TYPES = Object.freeze([
  "hello",
  "pair.request",
  "pair.accepted",
  "pair.rejected",
  "challenge",
  "authenticate",
  "ready",
  "snapshot",
  "event",
  "command",
  "ack",
  "heartbeat",
  "error",
  "resource.manifest",
  "resource.request",
  "resource.chunk",
  "resource.commit",
]);

export const DEVICE_COMMANDS = Object.freeze([
  "pet.select",
  "approval.decide",
  "telemetry.update",
  "state.preview",
]);

export const TRANSPORT_PROFILES = Object.freeze({
  usb: Object.freeze({ maxEnvelopeBytes: 8 * 1024, resourceChunkBytes: 3 * 1024 }),
  wifi: Object.freeze({ maxEnvelopeBytes: 64 * 1024, resourceChunkBytes: 12 * 1024 }),
  ble: Object.freeze({ maxEnvelopeBytes: 8 * 1024, resourceChunkBytes: 96, linkMtuBytes: 180 }),
  memory: Object.freeze({ maxEnvelopeBytes: 64 * 1024, resourceChunkBytes: 12 * 1024 }),
});

export const RELIABLE_MESSAGE_TYPES = Object.freeze(
  MESSAGE_TYPES.filter((type) => !["ack", "heartbeat", "error"].includes(type)),
);

export class ProtocolError extends Error {
  constructor(message, code = "INVALID_MESSAGE") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireString(value, field, pattern = null) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new ProtocolError(`${field} is invalid`);
  }
}

function validateResourceManifest(payload) {
  requireString(payload.petId, "resource petId", /^[a-z0-9][a-z0-9-]{0,63}$/);
  requireString(payload.displayName, "resource displayName");
  if (payload.displayName.length > 80) throw new ProtocolError("resource displayName is too long");
  if (typeof payload.description !== "string" || payload.description.length > 240) {
    throw new ProtocolError("resource description is invalid");
  }
  requireString(payload.sha256, "resource sha256", /^[a-f0-9]{64}$/);
  if (!Number.isSafeInteger(payload.bytes) || payload.bytes < 1 || payload.bytes > MAX_RESOURCE_BYTES) {
    throw new ProtocolError("resource bytes is invalid");
  }
  if (![1, 2].includes(payload.spriteVersionNumber)) throw new ProtocolError("resource sprite version is invalid");
  const atlas = PET_ATLAS[payload.spriteVersionNumber];
  if (payload.width !== atlas.width || payload.height !== atlas.height) {
    throw new ProtocolError("resource atlas dimensions are invalid");
  }
}

function validateMissingRanges(ranges, totalBytes = MAX_RESOURCE_BYTES) {
  if (!Array.isArray(ranges) || ranges.length > MAX_RESOURCE_RANGES) {
    throw new ProtocolError("resource missing ranges are invalid");
  }
  let cursor = 0;
  for (const range of ranges) {
    if (
      !isPlainObject(range) ||
      !Number.isSafeInteger(range.offset) ||
      !Number.isSafeInteger(range.length) ||
      range.offset < cursor ||
      range.length < 1 ||
      range.offset + range.length > totalBytes
    ) {
      throw new ProtocolError("resource missing range is invalid");
    }
    cursor = range.offset + range.length;
  }
}

function validatePayload(type, payload) {
  if (type === "command") {
    if (!DEVICE_COMMANDS.includes(payload.command)) {
      throw new ProtocolError("Device command is not supported", "UNSUPPORTED_COMMAND");
    }
    requireString(payload.commandId, "commandId");
    if (payload.commandId.length < 8 || payload.commandId.length > 128) {
      throw new ProtocolError("commandId is invalid");
    }
    if (payload.command === "pet.select") {
      requireString(payload.petId, "petId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    }
    if (payload.command === "approval.decide") {
      requireString(payload.requestId, "requestId");
      if (payload.requestId.length > 128 || !["accept", "decline"].includes(payload.decision)) {
        throw new ProtocolError("approval decision is invalid");
      }
    }
    if (payload.command === "telemetry.update") {
      if (!Number.isFinite(payload.batteryPercent) || payload.batteryPercent < 0 || payload.batteryPercent > 100) {
        throw new ProtocolError("batteryPercent is invalid");
      }
      if (typeof payload.charging !== "boolean") throw new ProtocolError("charging is invalid");
      if (payload.wifiRssi !== undefined && payload.wifiRssi !== null && (
        !Number.isFinite(payload.wifiRssi) ||
        payload.wifiRssi < -127 ||
        payload.wifiRssi > 0
      )) {
        throw new ProtocolError("wifiRssi is invalid");
      }
    }
    if (payload.command === "state.preview" && (
      payload.animation !== null &&
      !Object.hasOwn(STANDARD_ANIMATIONS, payload.animation)
    )) {
      throw new ProtocolError("preview animation is invalid");
    }
  }
  if (type === "ack") {
    requireString(payload.acknowledgedId, "acknowledgedId");
    if (!Number.isSafeInteger(payload.acknowledgedSequence) || payload.acknowledgedSequence < 1) {
      throw new ProtocolError("acknowledgedSequence is invalid");
    }
  }
  if (type === "hello") {
    requireString(payload.deviceId, "deviceId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    requireString(payload.deviceNonce, "deviceNonce", /^[A-Za-z0-9_-]{16,128}$/);
  }
  if (type === "pair.request") {
    requireString(payload.deviceId, "deviceId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    requireString(payload.deviceNonce, "deviceNonce", /^[A-Za-z0-9_-]{16,128}$/);
    requireString(payload.pairingCode, "pairingCode", /^[0-9]{6}$/);
  }
  if (type === "pair.accepted") {
    requireString(payload.deviceId, "deviceId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    requireString(payload.secret, "pairing secret", /^[a-f0-9]{64}$/);
  }
  if (type === "pair.rejected") requireString(payload.reason, "pairing rejection reason");
  if (type === "challenge" || type === "authenticate") {
    requireString(payload.deviceId, "deviceId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    requireString(payload.deviceNonce, "deviceNonce", /^[A-Za-z0-9_-]{16,128}$/);
    requireString(payload.bridgeNonce, "bridgeNonce", /^[A-Za-z0-9_-]{16,128}$/);
    requireString(payload.proof, "proof", /^[a-f0-9]{64}$/);
  }
  if (type === "ready") {
    requireString(payload.sessionId, "sessionId");
    if (!Number.isSafeInteger(payload.heartbeatIntervalMs) || payload.heartbeatIntervalMs < 1_000) {
      throw new ProtocolError("heartbeatIntervalMs is invalid");
    }
    if (!Number.isSafeInteger(payload.connectionTimeoutMs) || payload.connectionTimeoutMs <= payload.heartbeatIntervalMs) {
      throw new ProtocolError("connectionTimeoutMs is invalid");
    }
  }
  if (type === "heartbeat" && (
    !Number.isSafeInteger(payload.lastReceivedSequence) ||
    payload.lastReceivedSequence < 0
  )) {
    throw new ProtocolError("heartbeat lastReceivedSequence is invalid");
  }
  if (type === "error") requireString(payload.code, "error code");
  if (type === "resource.manifest") validateResourceManifest(payload);
  if (type === "resource.request") {
    requireString(payload.petId, "resource petId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    if (payload.sha256 !== null && payload.sha256 !== undefined) {
      requireString(payload.sha256, "resource sha256", /^[a-f0-9]{64}$/);
    }
    if (payload.resumeSha256 !== undefined) {
      requireString(payload.resumeSha256, "resource resume sha256", /^[a-f0-9]{64}$/);
      validateMissingRanges(payload.missingRanges);
    } else if (payload.missingRanges !== undefined) {
      throw new ProtocolError("resource resume hash is required");
    }
  }
  if (type === "resource.chunk") {
    requireString(payload.petId, "resource petId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    requireString(payload.sha256, "resource sha256", /^[a-f0-9]{64}$/);
    requireString(payload.chunkSha256, "chunk sha256", /^[a-f0-9]{64}$/);
    requireString(payload.data, "resource chunk data", /^[A-Za-z0-9+/]*={0,2}$/);
    if (!Number.isSafeInteger(payload.offset) || payload.offset < 0) {
      throw new ProtocolError("resource chunk offset is invalid");
    }
  }
  if (type === "resource.commit") {
    requireString(payload.petId, "resource petId", /^[a-z0-9][a-z0-9-]{0,63}$/);
    requireString(payload.sha256, "resource sha256", /^[a-f0-9]{64}$/);
  }
}

export function createEnvelope({
  sequence,
  type,
  payload = {},
  id = randomUUID(),
  sentAt = Date.now(),
  sessionId = null,
}) {
  const envelope = {
    version: DEVICE_PROTOCOL_VERSION,
    id,
    sequence,
    type,
    sentAt,
    payload,
    ...(sessionId === null ? {} : { sessionId }),
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
  if (!isPlainObject(envelope.payload)) {
    throw new ProtocolError("Message payload must be an object");
  }
  if (envelope.sessionId !== undefined && (
    typeof envelope.sessionId !== "string" ||
    envelope.sessionId.length < 8 ||
    envelope.sessionId.length > 128
  )) {
    throw new ProtocolError("Message sessionId is invalid");
  }
  validatePayload(envelope.type, envelope.payload);
  return envelope;
}

export function createAck(envelope, sequence) {
  validateEnvelope(envelope);
  return createEnvelope({
    sequence,
    type: "ack",
    payload: { acknowledgedId: envelope.id, acknowledgedSequence: envelope.sequence },
    sessionId: envelope.sessionId ?? null,
  });
}

export function serializeEnvelope(envelope, transport = "memory") {
  validateEnvelope(envelope);
  const profile = TRANSPORT_PROFILES[transport];
  if (!profile) throw new ProtocolError(`Unknown transport profile: ${transport}`, "UNSUPPORTED_TRANSPORT");
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > profile.maxEnvelopeBytes) {
    throw new ProtocolError("Message exceeds transport envelope limit", "MESSAGE_TOO_LARGE");
  }
  return serialized;
}

export function parseEnvelope(serialized, transport = "memory") {
  const profile = TRANSPORT_PROFILES[transport];
  if (!profile) throw new ProtocolError(`Unknown transport profile: ${transport}`, "UNSUPPORTED_TRANSPORT");
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > profile.maxEnvelopeBytes) {
    throw new ProtocolError("Serialized message is invalid or too large", "MESSAGE_TOO_LARGE");
  }
  try {
    return validateEnvelope(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("Serialized message is not valid JSON");
  }
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

function normalizeSecret(secret) {
  const value = Buffer.isBuffer(secret)
    ? secret
    : typeof secret === "string" && /^[a-f0-9]{64,}$/.test(secret) ? Buffer.from(secret, "hex") : null;
  if (!value || value.length < 32) throw new ProtocolError("Pairing secret must contain at least 32 bytes", "INVALID_SECRET");
  return value;
}

function handshakeMaterial({ deviceId, deviceNonce, bridgeNonce, role }) {
  requireString(deviceId, "deviceId", /^[a-z0-9][a-z0-9-]{0,63}$/);
  requireString(deviceNonce, "deviceNonce", /^[A-Za-z0-9_-]{16,128}$/);
  requireString(bridgeNonce, "bridgeNonce", /^[A-Za-z0-9_-]{16,128}$/);
  if (!["bridge", "device", "session"].includes(role)) throw new ProtocolError("Handshake role is invalid");
  return JSON.stringify([DEVICE_PROTOCOL_VERSION, deviceId, deviceNonce, bridgeNonce, role]);
}

export function createPairingSecret() {
  return randomBytes(32).toString("hex");
}

export function createHandshakeNonce() {
  return randomBytes(24).toString("base64url");
}

export function createHandshakeProof({ secret, ...context }) {
  return createHmac("sha256", normalizeSecret(secret))
    .update(handshakeMaterial(context))
    .digest("hex");
}

export function verifyHandshakeProof({ proof, ...options }) {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = Buffer.from(createHandshakeProof(options), "hex");
  const actual = Buffer.from(proof, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function deriveSessionId(options) {
  return createHandshakeProof({ ...options, role: "session" }).slice(0, 32);
}

export class ReliableOutbox {
  #pending = new Map();

  constructor({ baseRetryMs = 250, maxRetryMs = 4_000, maxAttempts = 6 } = {}) {
    if (!Number.isFinite(baseRetryMs) || baseRetryMs < 1) throw new RangeError("baseRetryMs must be positive");
    if (!Number.isFinite(maxRetryMs) || maxRetryMs < baseRetryMs) throw new RangeError("maxRetryMs is invalid");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be positive");
    this.baseRetryMs = baseRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.maxAttempts = maxAttempts;
  }

  get size() {
    return this.#pending.size;
  }

  track(envelope, now = Date.now()) {
    validateEnvelope(envelope);
    if (!RELIABLE_MESSAGE_TYPES.includes(envelope.type)) return false;
    this.#pending.set(envelope.id, {
      envelope,
      attempts: 1,
      nextRetryAt: now + this.baseRetryMs,
    });
    return true;
  }

  acknowledge(acknowledgement) {
    validateEnvelope(acknowledgement);
    if (acknowledgement.type !== "ack") throw new ProtocolError("Acknowledgement message is required");
    const pending = this.#pending.get(acknowledgement.payload.acknowledgedId);
    if (!pending || pending.envelope.sequence !== acknowledgement.payload.acknowledgedSequence) return false;
    this.#pending.delete(pending.envelope.id);
    return true;
  }

  poll(now = Date.now()) {
    const retry = [];
    const failed = [];
    for (const [id, pending] of this.#pending) {
      if (pending.nextRetryAt > now) continue;
      if (pending.attempts >= this.maxAttempts) {
        this.#pending.delete(id);
        failed.push(pending.envelope);
        continue;
      }
      retry.push(pending.envelope);
      pending.attempts += 1;
      pending.nextRetryAt = now + Math.min(
        this.maxRetryMs,
        this.baseRetryMs * (2 ** (pending.attempts - 1)),
      );
    }
    return { retry, failed };
  }

  clear() {
    this.#pending.clear();
  }
}

export class ReconnectBackoff {
  #attempt = 0;

  constructor({
    delaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
    jitterRatio = 0.2,
    random = Math.random,
  } = {}) {
    if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new RangeError("Reconnect delays are invalid");
    }
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new RangeError("Reconnect jitter ratio is invalid");
    }
    this.delaysMs = [...delaysMs];
    this.jitterRatio = jitterRatio;
    this.random = random;
  }

  next() {
    const index = Math.min(this.#attempt, this.delaysMs.length - 1);
    const base = this.delaysMs[index];
    const jitter = base * this.jitterRatio * ((this.random() * 2) - 1);
    this.#attempt += 1;
    return Math.max(0, Math.round(base + jitter));
  }

  reset() {
    this.#attempt = 0;
  }
}

export function createPetResourceManifest(pet, data) {
  if (!pet || !Buffer.isBuffer(data)) throw new TypeError("Pet and resource bytes are required");
  const atlas = PET_ATLAS[pet.spriteVersionNumber];
  if (!atlas) throw new ProtocolError("Pet sprite version is invalid");
  const manifest = {
    petId: pet.id,
    displayName: String(pet.displayName ?? pet.id).slice(0, 80),
    description: String(pet.description ?? "").slice(0, 240),
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
    spriteVersionNumber: pet.spriteVersionNumber,
    width: atlas.width,
    height: atlas.height,
  };
  validateResourceManifest(manifest);
  return manifest;
}

export function createResourceChunks(
  manifest,
  data,
  chunkSize,
  ranges = [{ offset: 0, length: data.length }],
) {
  validateResourceManifest(manifest);
  if (!Buffer.isBuffer(data) || data.length !== manifest.bytes) throw new ProtocolError("Resource bytes do not match manifest");
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 12 * 1024) {
    throw new RangeError("Resource chunk size is invalid");
  }
  validateMissingRanges(ranges, data.length);
  const chunks = [];
  for (const range of ranges) {
    const end = range.offset + range.length;
    for (let offset = range.offset; offset < end; offset += chunkSize) {
      const chunk = data.subarray(offset, Math.min(offset + chunkSize, end));
      chunks.push({
        petId: manifest.petId,
        sha256: manifest.sha256,
        offset,
        data: chunk.toString("base64"),
        chunkSha256: createHash("sha256").update(chunk).digest("hex"),
      });
    }
  }
  return chunks;
}

export class PetResourceAssembler {
  #manifest = null;
  #chunks = new Map();

  begin(manifest) {
    validateResourceManifest(manifest);
    this.#manifest = { ...manifest };
    this.#chunks.clear();
    return this.resumeState();
  }

  canResume(manifest) {
    validateResourceManifest(manifest);
    return Boolean(
      this.#manifest &&
      this.#manifest.petId === manifest.petId &&
      this.#manifest.sha256 === manifest.sha256 &&
      this.#manifest.bytes === manifest.bytes &&
      this.#manifest.spriteVersionNumber === manifest.spriteVersionNumber
    );
  }

  accept(payload) {
    if (!this.#manifest) throw new ProtocolError("Resource transfer has not started", "TRANSFER_NOT_STARTED");
    validatePayload("resource.chunk", payload);
    if (payload.petId !== this.#manifest.petId || payload.sha256 !== this.#manifest.sha256) {
      throw new ProtocolError("Resource chunk does not match active manifest", "RESOURCE_MISMATCH");
    }
    const data = Buffer.from(payload.data, "base64");
    if (data.length < 1 || payload.offset + data.length > this.#manifest.bytes) {
      throw new ProtocolError("Resource chunk range is invalid");
    }
    const chunkSha256 = createHash("sha256").update(data).digest("hex");
    if (chunkSha256 !== payload.chunkSha256) throw new ProtocolError("Resource chunk checksum failed", "CHUNK_CHECKSUM_FAILED");

    for (const [offset, existing] of this.#chunks) {
      const overlaps = payload.offset < offset + existing.length && offset < payload.offset + data.length;
      if (!overlaps) continue;
      if (offset === payload.offset && existing.equals(data)) return { accepted: false, duplicate: true };
      throw new ProtocolError("Resource chunks overlap", "CHUNK_OVERLAP");
    }
    this.#chunks.set(payload.offset, Buffer.from(data));
    return { accepted: true, duplicate: false };
  }

  resumeState() {
    if (!this.#manifest) return { petId: null, sha256: null, missingRanges: [] };
    const missingRanges = [];
    let cursor = 0;
    for (const [offset, chunk] of [...this.#chunks.entries()].sort((a, b) => a[0] - b[0])) {
      if (offset > cursor) missingRanges.push({ offset: cursor, length: offset - cursor });
      cursor = Math.max(cursor, offset + chunk.length);
    }
    if (cursor < this.#manifest.bytes) {
      missingRanges.push({ offset: cursor, length: this.#manifest.bytes - cursor });
    }
    return {
      petId: this.#manifest.petId,
      sha256: this.#manifest.sha256,
      missingRanges,
    };
  }

  commit() {
    if (!this.#manifest) throw new ProtocolError("Resource transfer has not started", "TRANSFER_NOT_STARTED");
    const state = this.resumeState();
    if (state.missingRanges.length) throw new ProtocolError("Resource transfer is incomplete", "TRANSFER_INCOMPLETE");
    const result = Buffer.allocUnsafe(this.#manifest.bytes);
    for (const [offset, chunk] of this.#chunks) chunk.copy(result, offset);
    const sha256 = createHash("sha256").update(result).digest("hex");
    if (sha256 !== this.#manifest.sha256) throw new ProtocolError("Resource checksum failed", "RESOURCE_CHECKSUM_FAILED");
    return { manifest: { ...this.#manifest }, data: result };
  }
}

export class AtomicPetResourceCache {
  #installed = new Map();
  #staging = new Map();

  begin(manifest) {
    const existing = this.#staging.get(manifest.petId);
    if (existing?.canResume(manifest)) return existing.resumeState();
    const assembler = new PetResourceAssembler();
    assembler.begin(manifest);
    this.#staging.set(manifest.petId, assembler);
    return assembler.resumeState();
  }

  acceptChunk(payload) {
    const assembler = this.#staging.get(payload.petId);
    if (!assembler) throw new ProtocolError("Resource transfer has not started", "TRANSFER_NOT_STARTED");
    return assembler.accept(payload);
  }

  resumeState(petId) {
    return this.#staging.get(petId)?.resumeState() ?? null;
  }

  commit(petId, sha256) {
    const assembler = this.#staging.get(petId);
    if (!assembler) throw new ProtocolError("Resource transfer has not started", "TRANSFER_NOT_STARTED");
    const completed = assembler.commit();
    if (completed.manifest.sha256 !== sha256) throw new ProtocolError("Commit hash does not match manifest", "RESOURCE_MISMATCH");
    this.#installed.set(petId, completed);
    this.#staging.delete(petId);
    return { ...completed.manifest };
  }

  get(petId) {
    const resource = this.#installed.get(petId);
    return resource ? { manifest: { ...resource.manifest }, data: Buffer.from(resource.data) } : null;
  }
}
