import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  CommandDeduplicator,
  DEVICE_PROTOCOL_VERSION,
  evaluateDeviceCompatibility,
  normalizeWifiProvisioning,
} from "../shared/device-protocol.js";
import { DeviceSession } from "./device-session.js";
import { PairingCodeManager } from "./device-credential-repository.js";

const TRANSPORT_PRIORITY = Object.freeze({ usb: 3, wifi: 2, ble: 1, memory: 0 });

export class DeviceHub extends EventEmitter {
  #sessions = new Set();
  #globalCommands = new CommandDeduplicator(2_048);
  #started = false;

  constructor({
    store,
    bridge,
    catalog,
    settings,
    credentials,
    pairingCodes = new PairingCodeManager(),
    maxSessions = 32,
    voiceAgent = null,
    petAgent = null,
    visionAgent = null,
  } = {}) {
    super();
    if (!store || !bridge || !catalog || !settings || !credentials) {
      throw new TypeError("DeviceHub requires store, bridge, catalog, settings, and credentials");
    }
    this.store = store;
    this.bridge = bridge;
    this.catalog = catalog;
    this.settings = settings;
    this.credentials = credentials;
    this.pairingCodes = pairingCodes;
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError("Device session limit must be positive");
    this.maxSessions = maxSessions;
    this.voiceAgent = voiceAgent;
    this.petAgent = petAgent;
    this.visionAgent = visionAgent;
    this.onStoreChange = (snapshot) => this.#broadcastSnapshot(snapshot);
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    await this.credentials.load();
    this.store.on("change", this.onStoreChange);
  }

  createPairingOffer() {
    if (!this.#started) throw new Error("DeviceHub is not started");
    return this.pairingCodes.createOffer();
  }

  listDevices() {
    const sessions = [...this.#sessions].filter((session) => session.ready);
    return this.credentials.list().map((device) => {
      const connected = sessions
        .filter((session) => session.deviceId === device.deviceId)
        .sort((left, right) => (TRANSPORT_PRIORITY[right.transport.kind] ?? -1) - (TRANSPORT_PRIORITY[left.transport.kind] ?? -1));
      const deviceInfo = connected[0]?.deviceInfo ?? device.deviceInfo ?? null;
      const compatibility = evaluateDeviceCompatibility(deviceInfo);
      const reportedHashes = new Set(
        connected.map((session) => session.deviceInfoHash).filter(Boolean),
      );
      if (reportedHashes.size > 1) {
        compatibility.status = "incompatible";
        compatibility.compatible = false;
        compatibility.issues.push("不同链路上报的设备信息不一致");
      }
      return {
        ...device,
        connected: connected.length > 0,
        transports: connected.map((session) => session.transport.kind),
        primaryTransport: connected[0]?.transport.kind ?? null,
        protocolVersion: connected.length ? DEVICE_PROTOCOL_VERSION : null,
        deviceInfo,
        compatibility,
      };
    });
  }

  attachTransport(transport) {
    if (!this.#started) throw new Error("DeviceHub is not started");
    if (this.#sessions.size >= this.maxSessions) {
      transport.close?.();
      throw new Error("Device session limit reached");
    }
    const session = new DeviceSession({
      role: "bridge",
      transport,
      secretResolver: (deviceId) => this.credentials.getSecret(deviceId),
      pairClaimHandler: (request) => this.#claimPairing(request),
      snapshotProvider: () => this.#deviceSnapshot(this.store.snapshot()),
      commandHandler: (command) => this.#handleCommand(command, session),
    });
    this.#sessions.add(session);
    session.on("ready", ({ deviceId, deviceInfo }) => {
      for (const existing of [...this.#sessions]) {
        if (
          existing !== session &&
          existing.ready &&
          existing.deviceId === deviceId &&
          existing.transport.kind === transport.kind
        ) {
          existing.close();
        }
      }
      this.credentials.touch(deviceId, Date.now(), deviceInfo)
        .catch((error) => this.emit("diagnostic", error.message));
      this.emit("deviceConnected", { deviceId, transport: transport.kind });
    });
    session.on("paired", ({ deviceId }) => this.emit("devicePaired", { deviceId, transport: transport.kind }));
    session.on("authenticationFailed", ({ deviceId, reason }) => {
      this.emit(
        "diagnostic",
        `Device authentication failed (${transport.kind}, ${deviceId ?? "unknown"}): ${reason}`,
      );
    });
    session.on("remoteError", ({
      code,
      message,
      expectedSequence,
      receivedSequence,
    }) => {
      const sequenceDetail =
        Number.isInteger(expectedSequence) && Number.isInteger(receivedSequence)
          ? ` expected=${expectedSequence} received=${receivedSequence}`
          : "";
      this.emit(
        "diagnostic",
        `Device protocol error (${transport.kind}): ${code}${sequenceDetail}${message ? ` ${message}` : ""}`,
      );
    });
    session.on("timeout", ({ phase }) => {
      this.emit(
        "diagnostic",
        `Device session timeout (${transport.kind}, ${session.deviceId ?? "unknown"}): ${phase}`,
      );
    });
    session.on("reliabilityFailure", (failed) => {
      const messages = failed
        .map(({ type, sequence }) => `${type}#${sequence}`)
        .join(",");
      this.emit(
        "diagnostic",
        `Device reliability failure (${transport.kind}, ${session.deviceId ?? "unknown"}): ${messages}`,
      );
    });
    session.on("resourceRequest", (request) => {
      this.#sendResource(session, request).catch((error) => {
        session.sendEvent({ event: "resource.error", petId: request.petId, error: error.message });
      });
    });
    session.on("event", (event) => {
      try {
        if (event?.event === "voice.audio" && this.voiceAgent) {
          this.voiceAgent.acceptAudio(session, event);
        } else if (event?.event?.startsWith("vision.") && this.visionAgent) {
          this.visionAgent.acceptEvent(session, event);
        }
      } catch (error) {
        this.emit("diagnostic", `Device media error (${transport.kind}): ${error.message}`);
      }
    });
    session.on("closed", () => {
      this.#sessions.delete(session);
      this.voiceAgent?.disconnect(session).catch((error) => {
        this.emit("diagnostic", `Device voice cleanup failed: ${error.message}`);
      });
      this.visionAgent?.disconnect(session);
      this.emit("deviceDisconnected", { deviceId: session.deviceId, transport: transport.kind });
    });
    session.on("sessionError", (error) => this.emit("diagnostic", error.message));
    session.start();
    return session;
  }

  async revokeDevice(deviceId) {
    const revoked = await this.credentials.revoke(deviceId);
    if (!revoked) return false;
    for (const session of this.#sessions) {
      if (session.deviceId === deviceId) session.close();
    }
    return true;
  }

  provisionWifi(deviceId, provisioning) {
    if (typeof deviceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(deviceId)) {
      throw new Error("设备 ID 无效");
    }
    const normalized = normalizeWifiProvisioning(provisioning);
    if (!normalized) throw new Error("Wi-Fi 配置无效");
    const session = [...this.#sessions].find((candidate) =>
      candidate.ready &&
      candidate.deviceId === deviceId &&
      candidate.transport.kind === "usb",
    );
    if (!session) throw new Error("请保持已配对 Tab5 的 USB 数据线连接");
    if (session.deviceInfo?.capabilities?.wifi !== true) {
      throw new Error("此设备未声明 Wi-Fi 能力");
    }
    session.sendCommand("wifi.provision", normalized, randomUUID());
    return { deviceId, transport: "usb" };
  }

  async close() {
    if (!this.#started) return;
    this.#started = false;
    this.store.off("change", this.onStoreChange);
    for (const session of [...this.#sessions]) session.close();
    this.#sessions.clear();
  }

  async #claimPairing(request) {
    if (!this.pairingCodes.claim(request.pairingCode)) return null;
    const record = await this.credentials.pair({
      deviceId: request.deviceId,
      displayName: request.deviceId,
    });
    return { secret: record.secret };
  }

  async #handleCommand(payload, session) {
    if (!this.#globalCommands.accept(payload.commandId)) return { duplicate: true };
    switch (payload.command) {
      case "pet.select":
        await this.catalog.refresh();
        if (typeof payload.petId !== "string" || !this.catalog.has(payload.petId)) throw new Error("Pet was not found");
        await this.settings.save({ selectedPetId: payload.petId });
        this.store.setSelectedPet(payload.petId);
        return { selectedId: payload.petId };
      case "approval.decide":
        if (typeof payload.requestId !== "string" || !["accept", "decline"].includes(payload.decision)) {
          throw new Error("Approval request and decision are invalid");
        }
        await this.bridge.decideApproval(payload.requestId, payload.decision);
        return { requestId: payload.requestId, decision: payload.decision };
      case "companion.command.decide":
        if (!this.petAgent) throw new Error("宠物命令服务不可用");
        if (typeof payload.requestId !== "string" || !["accept", "decline"].includes(payload.decision)) {
          throw new Error("宠物命令请求和决定无效");
        }
        return this.petAgent.decideCommand(payload.requestId, payload.decision);
      case "telemetry.update":
        if (!Number.isFinite(payload.batteryPercent) || payload.batteryPercent < 0 || payload.batteryPercent > 100) {
          throw new Error("Battery percentage is invalid");
        }
        this.store.setTelemetry({
          batteryPercent: Math.round(payload.batteryPercent),
          charging: Boolean(payload.charging),
          transport: session.transport.kind,
          wifiRssi: Number.isFinite(payload.wifiRssi) ? Math.round(payload.wifiRssi) : null,
          deviceId: session.deviceId,
        });
        return { accepted: true };
      case "voice.start":
        if (!this.voiceAgent) throw new Error("语音服务不可用");
        return this.voiceAgent.start(session, { mode: payload.mode });
      case "voice.stop":
        if (!this.voiceAgent) throw new Error("语音服务不可用");
        return this.voiceAgent.stop(session.deviceId);
      case "state.preview":
        this.store.setPreviewAnimation(payload.animation ?? null);
        return { animation: payload.animation ?? null };
      default:
        throw new Error("Device command is not supported");
    }
  }

  async #sendResource(session, request) {
    await this.catalog.refresh();
    const pet = this.catalog.get(request.petId);
    if (!pet || pet.kind !== "custom") throw new Error("Pet resource is not available");
    const asset = await this.catalog.readDeviceAsset(pet.id);
    if (!asset) throw new Error("Pet resource is not available");
    if (request.sha256 === asset.sha256) {
      session.sendEvent({ event: "resource.current", petId: pet.id, sha256: asset.sha256 });
      return;
    }
    if (session.transport.kind === "ble") {
      session.sendEvent({
        event: "resource.requires-high-bandwidth",
        petId: pet.id,
        sha256: asset.sha256,
        allowedTransports: ["usb", "wifi"],
      });
      return;
    }
    const missingRanges = request.resumeSha256 === asset.sha256
      ? request.missingRanges
      : null;
    session.sendResource(pet, asset.data, { missingRanges });
  }

  #broadcastSnapshot(snapshot) {
    for (const session of this.#sessions) {
      if (session.ready) session.sendSnapshot(this.#deviceSnapshot(snapshot));
    }
  }

  #deviceSnapshot(snapshot) {
    return {
      ...snapshot,
      approval: snapshot.approval ? {
        id: snapshot.approval.id,
        kind: snapshot.approval.kind,
        title: snapshot.approval.title,
        detail: snapshot.approval.deviceDetail,
        reason: snapshot.approval.reason,
        safeToApprove: snapshot.approval.deviceSafeToApprove,
        availableDecisions: snapshot.approval.availableDecisions,
      } : null,
      pet: {
        ...snapshot.pet,
        available: this.catalog.list().map((pet) => ({
          id: pet.id,
          displayName: pet.displayName,
          spriteVersionNumber: pet.spriteVersionNumber,
          kind: pet.kind,
        })),
      },
    };
  }
}
