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
const CARE_PRESENTATIONS = Object.freeze({
  observing: { state: "reviewing", animation: "review" },
  thinking: { state: "reviewing", animation: "review" },
  speaking: { state: "running", animation: "waving" },
  listening: { state: "needs-input", animation: "waiting" },
  acting: { state: "running", animation: "running" },
});

export class DeviceHub extends EventEmitter {
  #sessions = new Set();
  #globalCommands = new CommandDeduplicator(2_048);
  #pendingCameraCommands = new Map();
  #pendingCareCommands = new Map();
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

  primaryCameraDeviceId() {
    return this.#cameraSessions()[0]?.deviceId ?? null;
  }

  requestCameraCapture(deviceId, { reason = "scheduled" } = {}) {
    if (typeof deviceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(deviceId)) {
      throw new Error("设备 ID 无效");
    }
    if (!["scheduled", "follow-up", "manual"].includes(reason)) {
      throw new Error("拍照原因无效");
    }
    const session = this.#cameraSessions()
      .find((candidate) => candidate.deviceId === deviceId);
    if (!session) throw new Error("没有可用于拍照的 USB 或 Wi-Fi 设备");
    const commandId = randomUUID();
    this.#pendingCameraCommands.set(commandId, {
      commandId,
      deviceId,
      session,
      reason,
      requestedAt: Date.now(),
    });
    try {
      session.sendCommand("camera.capture", { reason }, commandId);
    } catch (error) {
      this.#pendingCameraCommands.delete(commandId);
      throw error;
    }
    return {
      commandId,
      deviceId,
      transport: session.transport.kind,
      reason,
    };
  }

  setDeviceBrightness(deviceId, value) {
    return this.#requestCareDeviceValue(
      deviceId,
      "device.brightness.set",
      value,
    );
  }

  setDeviceVolume(deviceId, value) {
    return this.#requestCareDeviceValue(
      deviceId,
      "device.volume.set",
      value,
    );
  }

  stopCareConversation() {
    let notifiedDevices = 0;
    for (const session of this.#sessions) {
      if (!session.ready) continue;
      session.sendEvent({ event: "care.stop" });
      notifiedDevices += 1;
    }
    return { notifiedDevices };
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
        if (event?.event === "command.result") {
          if (!this.#handleCameraCommandResult(session, event)) {
            this.#handleCareCommandResult(session, event);
          }
        } else if (event?.event === "voice.audio" && this.voiceAgent) {
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
      for (const [commandId, pending] of this.#pendingCameraCommands) {
        if (pending.session !== session) continue;
        this.#pendingCameraCommands.delete(commandId);
        this.emit("cameraCaptureResult", {
          commandId,
          deviceId: pending.deviceId,
          ok: false,
          error: "拍照链路已断开",
        });
      }
      for (const [commandId, pending] of this.#pendingCareCommands) {
        if (pending.session !== session) continue;
        this.#pendingCareCommands.delete(commandId);
        clearTimeout(pending.timer);
        pending.reject(new Error("设备控制链路已断开"));
      }
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
    this.#pendingCameraCommands.clear();
    for (const pending of this.#pendingCareCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("设备服务已关闭"));
    }
    this.#pendingCareCommands.clear();
  }

  async #claimPairing(request) {
    if (!this.pairingCodes.claim(request.pairingCode)) return null;
    const record = await this.credentials.pair({
      deviceId: request.deviceId,
      displayName: request.deviceId,
    });
    return { secret: record.secret };
  }

  #cameraSessions() {
    return [...this.#sessions]
      .filter((session) =>
        session.ready &&
        ["usb", "wifi"].includes(session.transport.kind) &&
        session.deviceInfo?.capabilities?.camera === true)
      .sort((left, right) =>
        (TRANSPORT_PRIORITY[right.transport.kind] ?? -1) -
        (TRANSPORT_PRIORITY[left.transport.kind] ?? -1));
  }

  #deviceSessions(deviceId) {
    return [...this.#sessions]
      .filter((session) =>
        session.ready &&
        session.deviceId === deviceId)
      .sort((left, right) =>
        (TRANSPORT_PRIORITY[right.transport.kind] ?? -1) -
        (TRANSPORT_PRIORITY[left.transport.kind] ?? -1));
  }

  #requestCareDeviceValue(deviceId, command, value) {
    if (typeof deviceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(deviceId)) {
      throw new Error("设备 ID 无效");
    }
    if (
      !["device.brightness.set", "device.volume.set"].includes(command) ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new Error("设备控制参数无效");
    }
    const session = this.#deviceSessions(deviceId)[0];
    if (!session) throw new Error("目标 Tab5 当前未连接");
    const commandId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCareCommands.delete(commandId);
        reject(new Error("等待 Tab5 动作结果超时"));
      }, 10_000);
      timer.unref?.();
      this.#pendingCareCommands.set(commandId, {
        session,
        deviceId,
        command,
        resolve,
        reject,
        timer,
      });
      try {
        session.sendCommand(command, { value }, commandId);
      } catch (error) {
        clearTimeout(timer);
        this.#pendingCareCommands.delete(commandId);
        reject(error);
      }
    });
  }

  #handleCameraCommandResult(session, event) {
    const pending = this.#pendingCameraCommands.get(event.commandId);
    if (!pending || pending.session !== session) return false;
    this.#pendingCameraCommands.delete(event.commandId);
    const result = event.result && typeof event.result === "object" && !Array.isArray(event.result)
      ? event.result
      : {};
    this.emit("cameraCaptureResult", {
      commandId: event.commandId,
      deviceId: pending.deviceId,
      ok: event.ok === true,
      captureId: typeof result.captureId === "string"
        ? result.captureId
        : typeof event.captureId === "string" ? event.captureId : null,
      error: event.ok === true ? null : String(event.error || "设备拒绝拍照").slice(0, 500),
    });
    return true;
  }

  #handleCareCommandResult(session, event) {
    const pending = this.#pendingCareCommands.get(event.commandId);
    if (!pending || pending.session !== session) return false;
    this.#pendingCareCommands.delete(event.commandId);
    clearTimeout(pending.timer);
    if (event.ok !== true) {
      pending.reject(new Error(
        String(event.error || "Tab5 拒绝设备控制").slice(0, 500),
      ));
      return true;
    }
    const result = event.result && typeof event.result === "object" && !Array.isArray(event.result)
      ? event.result
      : {};
    if (
      !Number.isInteger(result.value) ||
      result.value < 0 ||
      result.value > 100 ||
      !Number.isInteger(result.previousValue) ||
      result.previousValue < 0 ||
      result.previousValue > 100
    ) {
      pending.reject(new Error("Tab5 返回了无效的设备控制结果"));
      return true;
    }
    pending.resolve({
      deviceId: pending.deviceId,
      command: pending.command,
      transport: session.transport.kind,
      value: result.value,
      previousValue: result.previousValue,
    });
    return true;
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
          temperatureC: Number.isFinite(payload.temperatureC)
            ? Math.round(payload.temperatureC * 10) / 10
            : null,
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
    const carePresentation = CARE_PRESENTATIONS[snapshot.care?.status] ?? null;
    return {
      ...snapshot,
      presentation: carePresentation
        ? { ...snapshot.presentation, ...carePresentation, previewing: false }
        : snapshot.presentation,
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
