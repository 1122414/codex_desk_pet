import { EventEmitter } from "node:events";
import {
  AtomicPetResourceCache,
  CommandDeduplicator,
  CONNECTION_TIMEOUT_MS,
  HANDSHAKE_MESSAGE_TYPES,
  HEARTBEAT_INTERVAL_MS,
  PetResourceAssembler,
  ProtocolError,
  RELIABLE_MESSAGE_TYPES,
  ReliableOutbox,
  SequenceWindow,
  TRANSPORT_PROFILES,
  createEnvelope,
  createDeviceInfo,
  createDeviceInfoHash,
  createHandshakeNonce,
  createHandshakeProof,
  createPetResourceManifest,
  createResourceChunks,
  decryptEnvelopePayload,
  deriveSessionId,
  encryptEnvelopePayload,
  isEncryptedEnvelope,
  normalizeDeviceInfo,
  validateEnvelope,
  verifyHandshakeProof,
} from "../shared/device-protocol.js";

const HANDSHAKE_TYPES = new Set(HANDSHAKE_MESSAGE_TYPES);

const DEFAULT_RELIABLE_WINDOWS = Object.freeze({
  usb: 1,
  wifi: 24,
  ble: 1,
  memory: 64,
});

const DEFAULT_RETRY_OPTIONS = Object.freeze({
  ble: Object.freeze({
    baseRetryMs: 2_000,
    maxRetryMs: 8_000,
    maxAttempts: 6,
  }),
});

const DEFAULT_MAX_QUEUED_RELIABLE = 16_384;
const USB_RESYNC_WAKE_INTERVAL_MS = 1_000;

export class DeviceSession extends EventEmitter {
  #nextSequence = 1;
  #receiveWindow = new SequenceWindow();
  #outbox;
  #commandDeduplicator;
  #timer = null;
  #handshake = null;
  #started = false;
  #handshakeStartedAt = 0;
  #reliableQueue = [];
  #initialPeerHandshakeId = null;
  #lastUsbResyncWakeAt = Number.NEGATIVE_INFINITY;

  constructor({
    role,
    transport,
    deviceId = null,
    secret = null,
    pairingCode = null,
    deviceInfo = null,
    secretResolver = null,
    pairClaimHandler = null,
    snapshotProvider = null,
    commandHandler = null,
    resourceCache = new AtomicPetResourceCache(),
    now = Date.now,
    nonceFactory = createHandshakeNonce,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
    handshakeTimeoutMs = 30_000,
    maxReliableInFlight = DEFAULT_RELIABLE_WINDOWS[transport?.kind] ?? 16,
    maxQueuedReliable = DEFAULT_MAX_QUEUED_RELIABLE,
    retry = {},
  } = {}) {
    super();
    if (!["bridge", "device"].includes(role)) throw new TypeError("DeviceSession role must be bridge or device");
    if (!transport?.on || typeof transport.send !== "function") throw new TypeError("DeviceSession requires a transport");
    if (role === "device" && (!deviceId || (!secret && !pairingCode))) {
      throw new TypeError("Device sessions require deviceId and either a secret or pairing code");
    }
    if (role === "bridge" && typeof secretResolver !== "function") {
      throw new TypeError("Bridge sessions require a secretResolver");
    }
    if (connectionTimeoutMs <= heartbeatIntervalMs) throw new RangeError("Connection timeout must exceed heartbeat interval");
    if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs < 1_000) {
      throw new RangeError("Handshake timeout must be at least one second");
    }
    if (!Number.isInteger(maxReliableInFlight) || maxReliableInFlight < 1) {
      throw new RangeError("Reliable in-flight limit must be positive");
    }
    if (!Number.isInteger(maxQueuedReliable) || maxQueuedReliable < 1) {
      throw new RangeError("Reliable queue limit must be positive");
    }
    this.role = role;
    this.transport = transport;
    this.deviceId = deviceId;
    this.secret = secret;
    this.pairingCode = pairingCode;
    this.deviceInfo = role === "device"
      ? normalizeDeviceInfo(deviceInfo) ?? createDeviceInfo()
      : null;
    this.deviceInfoHash = this.deviceInfo ? createDeviceInfoHash(this.deviceInfo) : null;
    this.secretResolver = secretResolver;
    this.pairClaimHandler = pairClaimHandler;
    this.snapshotProvider = snapshotProvider;
    this.commandHandler = commandHandler;
    this.resourceCache = resourceCache;
    this.now = now;
    this.nonceFactory = nonceFactory;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxReliableInFlight = maxReliableInFlight;
    this.maxQueuedReliable = maxQueuedReliable;
    this.state = "idle";
    this.sessionId = null;
    this.lastReceivedAt = 0;
    this.lastSentAt = 0;
    this.#outbox = new ReliableOutbox({
      ...DEFAULT_RETRY_OPTIONS[transport.kind],
      ...retry,
    });
    this.#commandDeduplicator = new CommandDeduplicator(512);
    this.onTransportMessage = (message) => {
      this.#receive(message).catch((error) => {
        this.emit("sessionError", error);
        if (["DECRYPTION_FAILED", "ENCRYPTION_REQUIRED"].includes(error?.code)) {
          this.emit("authenticationFailed", {
            deviceId: this.deviceId,
            reason: error.code,
          });
          this.close();
        }
      });
    };
    this.onTransportClose = () => this.#handleClose();
    this.onTransportError = (error) => this.emit("sessionError", error);
  }

  get ready() {
    return this.state === "ready";
  }

  get pendingAcknowledgements() {
    return this.#outbox.size;
  }

  get queuedMessages() {
    return this.#reliableQueue.length;
  }

  start({ autoTick = true } = {}) {
    if (this.#started) return;
    this.#started = true;
    this.state = "handshaking";
    this.lastReceivedAt = this.now();
    this.lastSentAt = this.now();
    this.#handshakeStartedAt = this.now();
    this.transport.on("message", this.onTransportMessage);
    this.transport.on("close", this.onTransportClose);
    this.transport.on("error", this.onTransportError);
    if (autoTick) {
      this.#timer = setInterval(() => this.tick(), Math.min(250, Math.max(50, this.heartbeatIntervalMs / 4)));
      this.#timer.unref?.();
    }
    if (this.role === "device") {
      const deviceNonce = this.nonceFactory();
      this.#handshake = {
        deviceId: this.deviceId,
        deviceNonce,
        bridgeNonce: null,
        deviceInfoHash: this.deviceInfoHash,
      };
      if (this.secret) this.#sendHello();
      else {
        this.#send("pair.request", {
          deviceId: this.deviceId,
          deviceNonce,
          pairingCode: this.pairingCode,
        });
      }
    }
  }

  tick(now = this.now()) {
    if (!this.#started || ["closed", "rejected"].includes(this.state)) return;
    const { retry, failed } = this.#outbox.poll(now);
    for (const envelope of retry) {
      this.transport.send(envelope);
      this.lastSentAt = now;
      this.emit("retry", envelope);
    }
    if (failed.length) {
      this.state = "stale";
      this.emit("reliabilityFailure", failed);
      this.close();
      return;
    }
    if (!this.ready && now - this.#handshakeStartedAt >= this.handshakeTimeoutMs) {
      if (this.role === "bridge" && this.transport.kind === "usb") {
        this.#handshakeStartedAt = now;
        this.transport.wakeDevice?.();
        return;
      }
      this.state = "stale";
      this.emit("timeout", { phase: "handshake" });
      this.close();
      return;
    }
    if (this.ready && now - this.lastReceivedAt >= this.connectionTimeoutMs) {
      this.state = "stale";
      this.emit("timeout", { phase: "connection" });
      this.close();
      return;
    }
    if (this.ready && now - this.lastSentAt >= this.heartbeatIntervalMs) {
      this.#send("heartbeat", { lastReceivedSequence: this.#receiveWindow.lastAccepted }, false);
    }
  }

  sendSnapshot(snapshot = this.snapshotProvider?.()) {
    if (this.role !== "bridge" || !this.ready) throw new Error("Only an authenticated bridge can send snapshots");
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("Snapshot is required");
    return this.#send("snapshot", snapshot);
  }

  sendEvent(event) {
    if (!this.ready) throw new Error("Session is not authenticated");
    return this.#send("event", event);
  }

  sendCommand(command, args = {}, commandId) {
    if (!this.ready) throw new Error("Session is not authenticated");
    return this.#send("command", { command, commandId, ...args });
  }

  requestResource(petId, sha256 = null) {
    if (this.role !== "device" || !this.ready) throw new Error("Only an authenticated device can request resources");
    const resume = this.resourceCache.resumeState(petId);
    return this.#send("resource.request", {
      petId,
      sha256,
      ...(resume?.sha256 ? {
        resumeSha256: resume.sha256,
        missingRanges: resume.missingRanges,
      } : {}),
    });
  }

  sendResource(pet, data, { missingRanges = null } = {}) {
    if (this.role !== "bridge" || !this.ready) throw new Error("Only an authenticated bridge can send resources");
    const manifest = createPetResourceManifest(pet, data);
    this.#send("resource.manifest", manifest);
    const profile = TRANSPORT_PROFILES[this.transport.kind] ?? TRANSPORT_PROFILES.memory;
    for (const chunk of createResourceChunks(
      manifest,
      data,
      profile.resourceChunkBytes,
      missingRanges ?? [{ offset: 0, length: data.length }],
    )) {
      this.#send("resource.chunk", chunk);
    }
    this.#send("resource.commit", { petId: manifest.petId, sha256: manifest.sha256 });
    return manifest;
  }

  close() {
    if (!this.#started) return;
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#outbox.clear();
    this.#reliableQueue = [];
    this.transport.off("message", this.onTransportMessage);
    this.transport.off("close", this.onTransportClose);
    this.transport.off("error", this.onTransportError);
    this.transport.close?.();
    this.state = "closed";
    this.emit("closed");
  }

  #send(type, payload, reliable = RELIABLE_MESSAGE_TYPES.includes(type)) {
    if (reliable && this.#outbox.size >= this.maxReliableInFlight) {
      if (type === "snapshot") {
        const queuedSnapshot = this.#reliableQueue.find((entry) => entry.type === "snapshot");
        if (queuedSnapshot) {
          queuedSnapshot.payload = payload;
          return null;
        }
      }
      if (this.#reliableQueue.length >= this.maxQueuedReliable) {
        throw new Error("Reliable send queue exceeded its limit");
      }
      const entry = { type, payload };
      if (type.startsWith("resource.")) {
        this.#reliableQueue.push(entry);
      } else {
        const firstResource = this.#reliableQueue.findIndex((queued) => queued.type.startsWith("resource."));
        if (firstResource === -1) this.#reliableQueue.push(entry);
        else this.#reliableQueue.splice(firstResource, 0, entry);
      }
      return null;
    }
    return this.#transmit(type, payload, reliable);
  }

  #transmit(type, payload, reliable) {
    const sequence = reliable ? this.#nextSequence++ : this.#nextSequence;
    const plaintextEnvelope = createEnvelope({
      sequence,
      type,
      payload,
      sentAt: this.now(),
      sessionId: this.sessionId,
    });
    const envelope = this.ready && !HANDSHAKE_TYPES.has(type)
      ? encryptEnvelopePayload(plaintextEnvelope, this.#encryptionContext("outgoing"))
      : plaintextEnvelope;
    this.transport.send(envelope);
    this.lastSentAt = this.now();
    if (reliable) this.#outbox.track(envelope, this.lastSentAt);
    return envelope;
  }

  #flushReliableQueue() {
    while (
      this.#reliableQueue.length > 0 &&
      this.#outbox.size < this.maxReliableInFlight &&
      this.#started
    ) {
      const next = this.#reliableQueue.shift();
      this.#transmit(next.type, next.payload, true);
    }
  }

  #sendAck(envelope) {
    this.#send("ack", {
      acknowledgedId: envelope.id,
      acknowledgedSequence: envelope.sequence,
    }, false);
  }

  async #receive(message) {
    let envelope = validateEnvelope(message);
    this.lastReceivedAt = this.now();
    const handshake = HANDSHAKE_TYPES.has(envelope.type);
    if (this.#isUsbPeerRestart(envelope)) {
      this.#resetForPeerRestart();
    }
    if (this.ready && !handshake && envelope.sessionId !== this.sessionId) {
      this.#send("error", { code: "INVALID_SESSION", message: "Message session does not match" }, false);
      return;
    }
    if (this.ready && !handshake) {
      if (!isEncryptedEnvelope(envelope)) {
        this.#send("error", { code: "ENCRYPTION_REQUIRED" }, false);
        throw new ProtocolError("Authenticated messages must be encrypted", "ENCRYPTION_REQUIRED");
      }
      envelope = decryptEnvelopePayload(envelope, this.#encryptionContext("incoming"));
    } else if (isEncryptedEnvelope(envelope)) {
      throw new ProtocolError("Encryption is not available before authentication", "INVALID_ENCRYPTION_STATE");
    } else if (
      !this.ready &&
      !handshake &&
      !["ack", "error"].includes(envelope.type)
    ) {
      this.#send("error", { code: "AUTHENTICATION_REQUIRED" }, false);
      return;
    }

    if (envelope.type === "ack") {
      if (this.#outbox.acknowledge(envelope)) this.#flushReliableQueue();
      return;
    }
    const reliable = RELIABLE_MESSAGE_TYPES.includes(envelope.type);
    if (reliable) {
      const observation = this.#receiveWindow.observe(envelope);
      if (observation.status === "duplicate") {
        this.#sendAck(envelope);
        return;
      }
      if (observation.status === "gap") {
        this.#send("error", {
          code: "RESYNC_REQUIRED",
          expectedSequence: observation.expected,
          receivedSequence: envelope.sequence,
        }, false);
        return;
      }
      if (
        envelope.sequence === 1 &&
        ["hello", "pair.request"].includes(envelope.type)
      ) {
        this.#initialPeerHandshakeId = envelope.id;
      }
    }

    if (handshake) {
      if (envelope.type !== "ready" && reliable) {
        this.#sendAck(envelope);
      }
      await this.#handleHandshake(envelope);
      if (envelope.type === "ready" && reliable) {
        this.#sendAck(envelope);
      }
      return;
    }

    if (reliable) this.#sendAck(envelope);

    switch (envelope.type) {
      case "heartbeat":
        this.emit("heartbeat", envelope.payload);
        return;
      case "snapshot":
        this.emit("snapshot", envelope.payload);
        return;
      case "event":
        this.emit("event", envelope.payload);
        return;
      case "command":
        await this.#handleCommand(envelope.payload);
        return;
      case "resource.manifest":
        this.resourceCache.begin(envelope.payload);
        this.emit("resourceStarted", envelope.payload);
        return;
      case "resource.chunk":
        this.resourceCache.acceptChunk(envelope.payload);
        this.emit("resourceProgress", this.resourceCache.resumeState(envelope.payload.petId));
        return;
      case "resource.commit": {
        const manifest = this.resourceCache.commit(envelope.payload.petId, envelope.payload.sha256);
        this.emit("resourceInstalled", manifest);
        return;
      }
      case "resource.request":
        this.emit("resourceRequest", envelope.payload);
        return;
      case "error":
        if (envelope.payload.code === "RESYNC_REQUIRED" && this.role === "bridge" && this.ready) {
          if (this.transport.kind === "usb" && typeof this.transport.wakeDevice === "function") {
            const now = this.now();
            if (now - this.#lastUsbResyncWakeAt >= USB_RESYNC_WAKE_INTERVAL_MS) {
              this.#lastUsbResyncWakeAt = now;
              this.transport.wakeDevice();
            }
          } else {
            this.sendSnapshot();
          }
        }
        this.emit("remoteError", envelope.payload);
        return;
      default:
    }
  }

  async #handleHandshake(envelope) {
    const payload = envelope.payload;
    if (envelope.type === "pair.request" && this.role === "bridge") {
      if (!["usb", "ble"].includes(this.transport.kind) || typeof this.pairClaimHandler !== "function") {
        this.#send("pair.rejected", { reason: "pairing-not-allowed-on-this-transport" });
        return;
      }
      const paired = await this.pairClaimHandler(payload);
      if (!paired?.secret) {
        this.#send("pair.rejected", { reason: "invalid-or-expired-code" });
        return;
      }
      this.#send("pair.accepted", { deviceId: payload.deviceId, secret: paired.secret });
      this.emit("paired", { deviceId: payload.deviceId });
      return;
    }

    if (envelope.type === "pair.accepted" && this.role === "device") {
      if (payload.deviceId !== this.deviceId) {
        this.state = "rejected";
        this.emit("authenticationFailed", { deviceId: this.deviceId, reason: "pairing-device-id" });
        return;
      }
      this.secret = payload.secret;
      this.pairingCode = null;
      this.emit("paired", { deviceId: this.deviceId, secret: this.secret });
      this.#sendHello();
      return;
    }

    if (envelope.type === "pair.rejected" && this.role === "device") {
      this.state = "rejected";
      this.emit("authenticationFailed", { deviceId: this.deviceId, reason: payload.reason });
      return;
    }

    if (envelope.type === "hello" && this.role === "bridge") {
      const secret = await this.secretResolver(payload.deviceId);
      if (!secret) {
        this.state = "rejected";
        this.#send("error", { code: "DEVICE_NOT_PAIRED" }, false);
        this.emit("authenticationFailed", { deviceId: payload.deviceId, reason: "unpaired" });
        return;
      }
      const bridgeNonce = this.nonceFactory();
      this.state = "handshaking";
      this.sessionId = null;
      this.#handshakeStartedAt = this.now();
      this.#outbox.clear();
      this.#reliableQueue = [];
      this.deviceId = payload.deviceId;
      this.secret = secret;
      this.deviceInfo = normalizeDeviceInfo(payload.deviceInfo);
      this.deviceInfoHash = payload.deviceInfoHash;
      this.#handshake = {
        deviceId: payload.deviceId,
        deviceNonce: payload.deviceNonce,
        bridgeNonce,
        deviceInfoHash: payload.deviceInfoHash,
      };
      this.#send("challenge", {
        ...this.#handshake,
        proof: createHandshakeProof({ secret, ...this.#handshake, role: "bridge" }),
      });
      return;
    }

    if (envelope.type === "challenge" && this.role === "device") {
      const matchesHello =
        payload.deviceId === this.#handshake?.deviceId &&
        payload.deviceNonce === this.#handshake?.deviceNonce &&
        payload.deviceInfoHash === this.#handshake?.deviceInfoHash;
      const valid = matchesHello && verifyHandshakeProof({
        secret: this.secret,
        ...payload,
        role: "bridge",
      });
      if (!valid) {
        this.state = "rejected";
        this.emit("authenticationFailed", { deviceId: this.deviceId, reason: "bridge-proof" });
        return;
      }
      this.#handshake.bridgeNonce = payload.bridgeNonce;
      this.#send("authenticate", {
        ...this.#handshake,
        proof: createHandshakeProof({ secret: this.secret, ...this.#handshake, role: "device" }),
      });
      return;
    }

    if (envelope.type === "authenticate" && this.role === "bridge") {
      const matchesChallenge =
        payload.deviceId === this.#handshake?.deviceId &&
        payload.deviceNonce === this.#handshake?.deviceNonce &&
        payload.bridgeNonce === this.#handshake?.bridgeNonce &&
        payload.deviceInfoHash === this.#handshake?.deviceInfoHash;
      const valid = matchesChallenge && verifyHandshakeProof({
        secret: this.secret,
        ...payload,
        role: "device",
      });
      if (!valid) {
        this.state = "rejected";
        this.#send("error", { code: "AUTHENTICATION_FAILED" }, false);
        this.emit("authenticationFailed", { deviceId: payload.deviceId, reason: "device-proof" });
        return;
      }
      this.sessionId = deriveSessionId({ secret: this.secret, ...this.#handshake });
      this.state = "ready";
      this.#send("ready", {
        sessionId: this.sessionId,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        connectionTimeoutMs: this.connectionTimeoutMs,
      });
      this.emit("ready", {
        deviceId: this.deviceId,
        sessionId: this.sessionId,
        deviceInfo: this.deviceInfo,
      });
      if (this.snapshotProvider) this.sendSnapshot();
      return;
    }

    if (envelope.type === "ready" && this.role === "device") {
      const expectedSessionId = deriveSessionId({ secret: this.secret, ...this.#handshake });
      if (payload.sessionId !== expectedSessionId || envelope.sessionId !== expectedSessionId) {
        this.state = "rejected";
        this.emit("authenticationFailed", { deviceId: this.deviceId, reason: "session-id" });
        return;
      }
      this.sessionId = expectedSessionId;
      this.state = "ready";
      this.emit("ready", {
        deviceId: this.deviceId,
        sessionId: this.sessionId,
        deviceInfo: this.deviceInfo,
      });
    }
  }

  async #handleCommand(payload) {
    if (!this.#commandDeduplicator.accept(payload.commandId)) {
      this.emit("duplicateCommand", payload);
      return;
    }
    try {
      const result = await this.commandHandler?.(payload);
      this.#send("event", {
        event: "command.result",
        commandId: payload.commandId,
        ok: true,
        result: result ?? null,
      });
    } catch (error) {
      this.#send("event", {
        event: "command.result",
        commandId: payload.commandId,
        ok: false,
        error: error.message,
      });
    }
  }

  #handleClose() {
    if (!this.#started) return;
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#outbox.clear();
    this.#reliableQueue = [];
    this.transport.off("message", this.onTransportMessage);
    this.transport.off("close", this.onTransportClose);
    this.transport.off("error", this.onTransportError);
    this.state = "closed";
    this.emit("closed");
  }

  #isUsbPeerRestart(envelope) {
    if (
      this.role !== "bridge" ||
      this.transport.kind !== "usb" ||
      envelope.sequence !== 1 ||
      !["hello", "pair.request"].includes(envelope.type) ||
      this.#receiveWindow.lastAccepted === 0 ||
      envelope.id === this.#initialPeerHandshakeId
    ) {
      return false;
    }
    return !this.deviceId || envelope.payload.deviceId === this.deviceId;
  }

  #resetForPeerRestart() {
    this.#nextSequence = 1;
    this.#receiveWindow.reset();
    this.#outbox.clear();
    this.#reliableQueue = [];
    this.#initialPeerHandshakeId = null;
    this.#lastUsbResyncWakeAt = Number.NEGATIVE_INFINITY;
    this.#handshake = null;
    this.#handshakeStartedAt = this.now();
    this.sessionId = null;
    this.state = "handshaking";
    this.emit("peerRestart", {
      deviceId: this.deviceId,
      transport: this.transport.kind,
    });
  }

  #sendHello() {
    this.#send("hello", {
      deviceId: this.deviceId,
      deviceNonce: this.#handshake.deviceNonce,
      transport: this.transport.kind,
      deviceInfo: this.deviceInfo,
      deviceInfoHash: this.deviceInfoHash,
    });
  }

  #encryptionContext(flow) {
    if (!["incoming", "outgoing"].includes(flow) || !this.#handshake?.bridgeNonce) {
      throw new ProtocolError("Encryption context is not ready", "INVALID_ENCRYPTION_CONTEXT");
    }
    const outgoing = flow === "outgoing";
    const bridgeToDevice = this.role === "bridge" ? outgoing : !outgoing;
    return {
      secret: this.secret,
      deviceId: this.#handshake.deviceId,
      deviceNonce: this.#handshake.deviceNonce,
      bridgeNonce: this.#handshake.bridgeNonce,
      direction: bridgeToDevice ? "bridge-to-device" : "device-to-bridge",
    };
  }
}

export { PetResourceAssembler };
