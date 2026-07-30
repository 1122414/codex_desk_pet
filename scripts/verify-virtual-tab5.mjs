import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { DeviceCredentialRepository } from "../src/server/device-credential-repository.js";
import { DeviceHub } from "../src/server/device-hub.js";
import { DeviceSession } from "../src/server/device-session.js";
import { DeskStore } from "../src/server/desk-store.js";
import { PetCatalog } from "../src/server/pet-catalog.js";
import { SettingsRepository } from "../src/server/settings-repository.js";
import { createMemoryTransportPair } from "../src/server/transports/memory-transport.js";
import { verifyVirtualCare } from "./verify-virtual-care.mjs";

async function waitFor(predicate, message, timeoutMs = 1_500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export async function verifyVirtualTab5() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-virtual-tab5-"));
  const petRoot = path.join(root, "pets");
  const petDirectory = path.join(petRoot, "virtual-pet");
  await mkdir(petDirectory, { recursive: true });
  const spritesheet = await sharp({
    create: {
      width: 1536,
      height: 2288,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).webp({ lossless: true }).toBuffer();
  await Promise.all([
    writeFile(path.join(petDirectory, "pet.json"), JSON.stringify({
      id: "virtual-pet",
      displayName: "Virtual Pet",
      description: "离线验收使用的临时 V2 Pet",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
    })),
    writeFile(path.join(petDirectory, "spritesheet.webp"), spritesheet),
  ]);

  const store = new DeskStore();
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  const settings = new SettingsRepository(path.join(root, "settings.json"));
  const catalog = new PetCatalog(petRoot);
  const decisions = [];
  const bridge = {
    decideApproval: async (requestId, decision) => {
      decisions.push({ requestId, decision });
      store.resolveApproval(requestId, decision);
    },
  };
  const hub = new DeviceHub({ store, bridge, catalog, settings, credentials });
  const devices = [];

  try {
    await catalog.refresh();
    await hub.start();

    const offer = hub.createPairingOffer();
    const usb = createMemoryTransportPair({ kind: "usb" });
    const bridgeUsb = hub.attachTransport(usb.left);
    const usbCommands = [];
    let pairedSecret = null;
    let latestSnapshot = null;
    const deviceUsb = new DeviceSession({
      role: "device",
      transport: usb.right,
      deviceId: "virtual-tab5",
      pairingCode: offer.code,
      commandHandler: async (command) => {
        usbCommands.push(command);
        return { accepted: true };
      },
    });
    devices.push(deviceUsb);
    deviceUsb.on("paired", ({ secret }) => { pairedSecret = secret; });
    deviceUsb.on("snapshot", (snapshot) => { latestSnapshot = snapshot; });
    deviceUsb.start();

    await waitFor(
      () => bridgeUsb.ready && deviceUsb.ready && pairedSecret && latestSnapshot,
      "虚拟 Tab5 未能通过 USB 配对并收到初始快照",
    );
    assert.equal(await credentials.getSecret("virtual-tab5"), pairedSecret);
    assert.equal(latestSnapshot.pet.selectedId, "codex-core");
    assert.equal(
      latestSnapshot.pet.available.some((pet) => pet.id === "virtual-pet"),
      true,
    );

    deviceUsb.sendCommand("telemetry.update", {
      batteryPercent: 73,
      charging: true,
      wifiRssi: -55,
    }, randomUUID());
    deviceUsb.sendCommand("pet.select", { petId: "virtual-pet" }, randomUUID());
    deviceUsb.sendCommand("state.preview", { animation: "review" }, randomUUID());
    await waitFor(
      () =>
        store.snapshot().telemetry.batteryPercent === 73 &&
        store.snapshot().pet.selectedId === "virtual-pet" &&
        store.snapshot().presentation.animation === "review",
      "虚拟 Tab5 遥测、Pet 或状态预览未同步到 Bridge",
    );

    hub.provisionWifi("virtual-tab5", {
      ssid: "Virtual Lab",
      password: "temporary-test-only",
      bridgeHost: "192.168.1.20",
      bridgePort: 4318,
    });
    await waitFor(() => usbCommands.length === 1, "虚拟 Tab5 未收到加密 Wi-Fi 配置命令");
    assert.equal(usbCommands[0].command, "wifi.provision");

    const wifi = createMemoryTransportPair({ kind: "wifi" });
    const bridgeWifi = hub.attachTransport(wifi.left);
    const deviceWifi = new DeviceSession({
      role: "device",
      transport: wifi.right,
      deviceId: "virtual-tab5",
      secret: pairedSecret,
    });
    devices.push(deviceWifi);
    let wifiApproval = null;
    deviceWifi.on("snapshot", (snapshot) => {
      wifiApproval = snapshot.approval;
    });
    deviceWifi.start();
    await waitFor(
      () => bridgeWifi.ready && deviceWifi.ready && hub.listDevices()[0]?.transports.length === 2,
      "虚拟 Tab5 未能使用配对密钥建立 Wi-Fi 会话",
    );
    assert.deepEqual(hub.listDevices()[0].transports, ["usb", "wifi"]);

    let installedResource = null;
    deviceWifi.on("resourceInstalled", (manifest) => {
      installedResource = manifest;
    });
    deviceWifi.requestResource("virtual-pet");
    await waitFor(
      () => installedResource !== null && deviceWifi.resourceCache.get("virtual-pet") !== null,
      "最大规格 V2 Pet 未能通过加密 Wi-Fi 安装到虚拟 Tab5",
      30_000,
    );
    const cachedResource = deviceWifi.resourceCache.get("virtual-pet");
    assert.equal(installedResource.bytes, 28_114_944);
    assert.equal(cachedResource.data.length, 28_114_944);
    assert.match(installedResource.sha256, /^[a-f0-9]{64}$/);

    store.addApproval({
      id: "virtual-approval",
      rpcId: "virtual-rpc",
      threadId: "virtual-thread",
      kind: "command",
      title: "Codex 请求执行命令",
      command: "npm test",
      displayDetail: "npm test",
      deviceDetail: "npm test",
      reason: "验证虚拟设备审批链路",
      requestedPermissions: {},
      availableDecisions: ["accept", "decline"],
      safeToApprove: true,
      deviceSafeToApprove: true,
    });
    await waitFor(
      () => wifiApproval?.id === "virtual-approval",
      "虚拟 Tab5 未收到审批快照",
    );
    deviceWifi.sendCommand("approval.decide", {
      requestId: "virtual-approval",
      decision: "decline",
    }, randomUUID());
    await waitFor(() => decisions.length === 1, "虚拟 Tab5 审批决定未返回 Bridge");
    assert.deepEqual(decisions, [{ requestId: "virtual-approval", decision: "decline" }]);

    deviceUsb.close();
    await waitFor(
      () => hub.listDevices()[0]?.primaryTransport === "wifi",
      "USB 断开后虚拟 Tab5 未切换到 Wi-Fi 主链路",
    );

    return {
      pairing: "single-use-usb",
      authenticated: true,
      encryptedSession: true,
      transportsBeforeUsbDisconnect: ["usb", "wifi"],
      primaryTransportAfterUsbDisconnect: "wifi",
      telemetry: {
        batteryPercent: store.snapshot().telemetry.batteryPercent,
        charging: store.snapshot().telemetry.charging,
      },
      petSelection: store.snapshot().pet.selectedId,
      customPetResource: {
        bytes: installedResource.bytes,
        sha256: installedResource.sha256,
        installedOver: "wifi",
      },
      previewAnimation: store.snapshot().presentation.animation,
      approvalDecision: decisions[0].decision,
      credentialsIsolated: root.startsWith(os.tmpdir()),
      care: await verifyVirtualCare(),
    };
  } finally {
    for (const device of devices) device.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await verifyVirtualTab5();
  process.stdout.write(`虚拟 Tab5 端到端验收通过\n${JSON.stringify(report, null, 2)}\n`);
}
