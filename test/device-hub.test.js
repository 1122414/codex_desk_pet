import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DeviceSession } from "../src/server/device-session.js";
import { DeviceHub } from "../src/server/device-hub.js";
import {
  DeviceCredentialRepository,
  PairingCodeManager,
} from "../src/server/device-credential-repository.js";
import { PetCatalog } from "../src/server/pet-catalog.js";
import { DeskStore } from "../src/server/desk-store.js";
import { SettingsRepository } from "../src/server/settings-repository.js";
import { createMemoryTransportPair } from "../src/server/transports/memory-transport.js";
import {
  AtomicPetResourceCache,
  createPetResourceManifest,
  createResourceChunks,
} from "../src/shared/device-protocol.js";

const passthroughDeviceConverter = async ({ data }) => ({
  data: Buffer.from(data),
  sha256: "a".repeat(64),
  bytes: data.length,
});

async function waitFor(predicate, timeoutMs = 750) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for hub state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makeV2Webp(bytes = 30) {
  const file = Buffer.alloc(bytes);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WEBP", 8, "ascii");
  file.write("VP8X", 12, "ascii");
  file.writeUInt32LE(10, 16);
  file.writeUIntLE(1536 - 1, 24, 3);
  file.writeUIntLE(2288 - 1, 27, 3);
  return file;
}

test("USB pairing provisions a secret and authenticated device commands update the Bridge store", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-"));
  await mkdir(path.join(root, "pets"));
  const store = new DeskStore();
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  const pairingCodes = new PairingCodeManager({ randomCode: () => 123456 });
  const bridge = { decideApproval: async () => null };
  const hub = new DeviceHub({
    store,
    bridge,
    catalog: new PetCatalog(path.join(root, "pets"), { deviceAssetConverter: passthroughDeviceConverter }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
    pairingCodes,
  });
  await hub.start();
  t.after(() => hub.close());

  const offer = hub.createPairingOffer();
  const transports = createMemoryTransportPair({ kind: "usb" });
  const bridgeSession = hub.attachTransport(transports.left);
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "core-s3-1",
    pairingCode: offer.code,
    nonceFactory: () => "device_nonce_1234567890",
  });
  t.after(() => device.close());
  let provisionedSecret = null;
  let lastDeviceSnapshot = null;
  device.on("paired", ({ secret }) => { provisionedSecret = secret; });
  device.on("snapshot", (snapshot) => { lastDeviceSnapshot = snapshot; });
  device.start();
  await waitFor(() => bridgeSession.ready && device.ready && provisionedSecret !== null);

  store.addApproval({
    id: "approval-compact-1",
    rpcId: 99,
    threadId: "approval-thread",
    kind: "command",
    title: "Codex 请求执行命令",
    command: "npm test",
    displayDetail: "npm test",
    deviceDetail: "npm test",
    reason: "运行测试",
    requestedPermissions: {
      fileSystem: { write: ["/private/project"] },
    },
    availableDecisions: ["accept", "decline"],
    safeToApprove: true,
    deviceSafeToApprove: true,
  });
  await waitFor(() => lastDeviceSnapshot?.approval?.id === "approval-compact-1");
  assert.equal(lastDeviceSnapshot.approval.detail, "npm test");
  assert.equal(lastDeviceSnapshot.approval.safeToApprove, true);
  assert.equal(Object.hasOwn(lastDeviceSnapshot.approval, "requestedPermissions"), false);

  device.sendCommand("pet.select", { petId: "codex-core" }, randomUUID());
  device.sendCommand("telemetry.update", {
    batteryPercent: 63,
    charging: false,
    wifiRssi: -61,
  }, randomUUID());
  await waitFor(() => store.snapshot().telemetry.batteryPercent === 63);
  assert.equal(store.snapshot().telemetry.transport, "usb");
  assert.equal(hub.listDevices()[0].primaryTransport, "usb");
  assert.equal(hub.listDevices()[0].deviceInfo.boardId, "m5stack-tab5-k145");
  assert.equal(hub.listDevices()[0].compatibility.status, "compatible");
  assert.equal(await credentials.getSecret("core-s3-1"), provisionedSecret);
});

test("Wi-Fi provisioning is sent only through an authenticated USB session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-wifi-"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "tab5-wifi-1", secret: "f".repeat(64) });
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets"), { deviceAssetConverter: passthroughDeviceConverter }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());

  const transports = createMemoryTransportPair({ kind: "usb" });
  const bridgeSession = hub.attachTransport(transports.left);
  const receivedCommands = [];
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "tab5-wifi-1",
    secret: "f".repeat(64),
    commandHandler: async (command) => {
      receivedCommands.push(command);
      return { accepted: true };
    },
  });
  t.after(() => device.close());
  device.start();
  await waitFor(() => bridgeSession.ready && device.ready);

  assert.deepEqual(hub.provisionWifi("tab5-wifi-1", {
    ssid: "Desk Wi-Fi",
    password: "secret",
    bridgeHost: "192.168.1.20",
    bridgePort: 4318,
  }), { deviceId: "tab5-wifi-1", transport: "usb" });
  await waitFor(() => receivedCommands.length === 1);
  assert.deepEqual(receivedCommands[0], {
    command: "wifi.provision",
    commandId: receivedCommands[0].commandId,
    ssid: "Desk Wi-Fi",
    password: "secret",
    bridgeHost: "192.168.1.20",
    bridgePort: 4318,
  });
  assert.throws(() => hub.provisionWifi("tab5-wifi-1", {
    ssid: "Desk Wi-Fi",
    password: "secret",
    bridgeHost: "invalid host",
    bridgePort: 4318,
  }), /Wi-Fi 配置无效/);
});

test("care device controls are correlated, bounded, and return previous values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-care-"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  const secret = "9".repeat(64);
  await credentials.pair({ deviceId: "tab5-care-1", secret });
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets"), {
      deviceAssetConverter: passthroughDeviceConverter,
    }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());

  const transports = createMemoryTransportPair({ kind: "usb" });
  const bridgeSession = hub.attachTransport(transports.left);
  const received = [];
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "tab5-care-1",
    secret,
    commandHandler: async (command) => {
      received.push(command);
      return {
        value: command.value,
        previousValue: command.command === "device.brightness.set" ? 50 : 30,
      };
    },
  });
  t.after(() => device.close());
  device.start();
  await waitFor(() => bridgeSession.ready && device.ready);

  assert.deepEqual(await hub.setDeviceBrightness("tab5-care-1", 25), {
    deviceId: "tab5-care-1",
    command: "device.brightness.set",
    transport: "usb",
    value: 25,
    previousValue: 50,
  });
  assert.deepEqual(await hub.setDeviceVolume("tab5-care-1", 80), {
    deviceId: "tab5-care-1",
    command: "device.volume.set",
    transport: "usb",
    value: 80,
    previousValue: 30,
  });
  assert.deepEqual(
    received.map(({ command, value }) => ({ command, value })),
    [
      { command: "device.brightness.set", value: 25 },
      { command: "device.volume.set", value: 80 },
    ],
  );
  assert.throws(
    () => hub.setDeviceVolume("tab5-care-1", 101),
    /控制参数/,
  );
});

test("proactive camera capture uses the highest-priority USB/Wi-Fi session and correlates its result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-camera-"));
  const secret = "c".repeat(64);
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "tab5-camera-1", secret });
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets"), {
      deviceAssetConverter: passthroughDeviceConverter,
    }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());

  const received = { usb: [], wifi: [] };
  const devices = [];
  for (const kind of ["wifi", "usb"]) {
    const transports = createMemoryTransportPair({ kind });
    const bridgeSession = hub.attachTransport(transports.left);
    const device = new DeviceSession({
      role: "device",
      transport: transports.right,
      deviceId: "tab5-camera-1",
      secret,
      commandHandler: async (payload) => {
        received[kind].push(payload);
        return { captureId: `${kind}0123456789ab` };
      },
      nonceFactory: () => `device_nonce_${kind}_1234567890`,
    });
    devices.push(device);
    t.after(() => device.close());
    device.start();
    await waitFor(() => bridgeSession.ready && device.ready);
  }

  const results = [];
  hub.on("cameraCaptureResult", (result) => results.push(result));
  assert.equal(hub.primaryCameraDeviceId(), "tab5-camera-1");
  const request = hub.requestCameraCapture("tab5-camera-1", {
    reason: "scheduled",
  });
  assert.equal(request.transport, "usb");
  await waitFor(() => results.length === 1);

  assert.equal(received.usb.length, 1);
  assert.equal(received.wifi.length, 0);
  assert.equal(received.usb[0].command, "camera.capture");
  assert.equal(received.usb[0].reason, "scheduled");
  assert.deepEqual(results[0], {
    commandId: request.commandId,
    deviceId: "tab5-camera-1",
    ok: true,
    captureId: "usb0123456789ab",
    error: null,
  });
  assert.throws(
    () => hub.requestCameraCapture("tab5-camera-1", { reason: "invalid" }),
    /拍照原因/,
  );
});

test("global command deduplication prevents dual-link duplicate approval execution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-dedupe-"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-1", secret: "e".repeat(64) });
  const decisions = [];
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: {
      decideApproval: async (requestId, decision) => {
        decisions.push({ requestId, decision });
      },
    },
    catalog: new PetCatalog(path.join(root, "pets"), { deviceAssetConverter: passthroughDeviceConverter }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());

  const usb = createMemoryTransportPair({ kind: "usb" });
  const wifi = createMemoryTransportPair({ kind: "wifi" });
  const bridgeUsb = hub.attachTransport(usb.left);
  const bridgeWifi = hub.attachTransport(wifi.left);
  const deviceUsb = new DeviceSession({
    role: "device",
    transport: usb.right,
    deviceId: "core-s3-1",
    secret: "e".repeat(64),
  });
  const deviceWifi = new DeviceSession({
    role: "device",
    transport: wifi.right,
    deviceId: "core-s3-1",
    secret: "e".repeat(64),
  });
  t.after(() => {
    deviceUsb.close();
    deviceWifi.close();
  });
  deviceUsb.start();
  deviceWifi.start();
  await waitFor(() => bridgeUsb.ready && bridgeWifi.ready && deviceUsb.ready && deviceWifi.ready);

  const commandId = randomUUID();
  const command = { requestId: "approval-1", decision: "decline" };
  deviceUsb.sendCommand("approval.decide", command, commandId);
  deviceWifi.sendCommand("approval.decide", command, commandId);
  await waitFor(() => decisions.length === 1);
  assert.deepEqual(decisions, [{ requestId: "approval-1", decision: "decline" }]);
  assert.deepEqual(hub.listDevices()[0].transports, ["usb", "wifi"]);
});

test("device resource requests stream a validated custom Pet into the atomic cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-resource-"));
  const petDir = path.join(root, "pets", "hub-pet");
  await mkdir(petDir, { recursive: true });
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "hub-pet",
    displayName: "Hub Pet",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }));
  const resource = makeV2Webp();
  await writeFile(path.join(petDir, "spritesheet.webp"), resource);
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-resource", secret: "1".repeat(64) });
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets"), { deviceAssetConverter: passthroughDeviceConverter }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());
  const transports = createMemoryTransportPair({ kind: "wifi" });
  const bridgeSession = hub.attachTransport(transports.left);
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "core-s3-resource",
    secret: "1".repeat(64),
  });
  t.after(() => device.close());
  device.start();
  await waitFor(() => bridgeSession.ready && device.ready);
  device.requestResource("hub-pet");
  await waitFor(() => device.resourceCache.get("hub-pet") !== null);
  assert.deepEqual(device.resourceCache.get("hub-pet").data, resource);
});

test("BLE resource requests require USB or Wi-Fi instead of starting an impractical large transfer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-ble-resource-"));
  const petDir = path.join(root, "pets", "hub-pet");
  await mkdir(petDir, { recursive: true });
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "hub-pet",
    displayName: "Hub Pet",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(path.join(petDir, "spritesheet.webp"), makeV2Webp());
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-ble-resource", secret: "3".repeat(64) });
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets"), { deviceAssetConverter: passthroughDeviceConverter }),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());
  const transports = createMemoryTransportPair({ kind: "ble" });
  const bridgeSession = hub.attachTransport(transports.left);
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "core-s3-ble-resource",
    secret: "3".repeat(64),
  });
  t.after(() => device.close());
  const events = [];
  device.on("event", (event) => events.push(event));
  device.start();
  await waitFor(() => bridgeSession.ready && device.ready);
  device.requestResource("hub-pet");
  await waitFor(() => events.some((event) => event.event === "resource.requires-high-bandwidth"));
  assert.deepEqual(events.at(-1).allowedTransports, ["usb", "wifi"]);
  assert.equal(device.resourceCache.get("hub-pet"), null);
});

test("an interrupted Pet transfer resumes only its missing byte ranges", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-resume-"));
  const petDir = path.join(root, "pets", "hub-pet");
  await mkdir(petDir, { recursive: true });
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "hub-pet",
    displayName: "Hub Pet",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }));
  const resource = makeV2Webp(10_000);
  await writeFile(path.join(petDir, "spritesheet.webp"), resource);
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-resume", secret: "5".repeat(64) });
  const catalog = new PetCatalog(path.join(root, "pets"), { deviceAssetConverter: passthroughDeviceConverter });
  const pets = await catalog.refresh();
  const pet = pets.find((candidate) => candidate.id === "hub-pet");
  const manifest = createPetResourceManifest(pet, resource);
  const cache = new AtomicPetResourceCache();
  cache.begin(manifest);
  cache.acceptChunk(createResourceChunks(manifest, resource, 3_072)[0]);

  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog,
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());
  const transports = createMemoryTransportPair({ kind: "usb" });
  const bridgeSession = hub.attachTransport(transports.left);
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "core-s3-resume",
    secret: "5".repeat(64),
    resourceCache: cache,
  });
  t.after(() => device.close());
  device.start();
  await waitFor(() => bridgeSession.ready && device.ready);
  const before = cache.resumeState("hub-pet");
  assert.deepEqual(before.missingRanges, [{ offset: 3_072, length: resource.length - 3_072 }]);
  device.requestResource("hub-pet");
  await waitFor(() => cache.get("hub-pet") !== null);
  assert.deepEqual(cache.get("hub-pet").data, resource);
});

test("unauthenticated Wi-Fi sessions cannot use the local pairing-code flow", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-wifi-pair-"));
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets")),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials: new DeviceCredentialRepository(path.join(root, "devices.json")),
    pairingCodes: new PairingCodeManager({ randomCode: () => 654321 }),
  });
  await hub.start();
  t.after(() => hub.close());
  const offer = hub.createPairingOffer();
  const transports = createMemoryTransportPair({ kind: "wifi" });
  hub.attachTransport(transports.left);
  const device = new DeviceSession({
    role: "device",
    transport: transports.right,
    deviceId: "core-s3-unpaired",
    pairingCode: offer.code,
  });
  t.after(() => device.close());
  let failure = null;
  device.on("authenticationFailed", (result) => { failure = result; });
  device.start();
  await waitFor(() => failure !== null);
  assert.equal(failure.reason, "pairing-not-allowed-on-this-transport");
});

test("a reconnecting device receives a fresh snapshot instead of stale offline state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-reconnect-"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-reconnect", secret: "2".repeat(64) });
  const store = new DeskStore();
  const hub = new DeviceHub({
    store,
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets")),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());

  const firstLink = createMemoryTransportPair({ kind: "wifi" });
  const firstBridge = hub.attachTransport(firstLink.left);
  const firstDevice = new DeviceSession({
    role: "device",
    transport: firstLink.right,
    deviceId: "core-s3-reconnect",
    secret: "2".repeat(64),
  });
  firstDevice.start();
  await waitFor(() => firstBridge.ready && firstDevice.ready);
  firstDevice.close();

  store.setTelemetry({ batteryPercent: 41, transport: "wifi" });
  const secondLink = createMemoryTransportPair({ kind: "wifi" });
  const secondBridge = hub.attachTransport(secondLink.left);
  const secondDevice = new DeviceSession({
    role: "device",
    transport: secondLink.right,
    deviceId: "core-s3-reconnect",
    secret: "2".repeat(64),
  });
  t.after(() => secondDevice.close());
  let snapshot = null;
  secondDevice.on("snapshot", (value) => { snapshot = value; });
  secondDevice.start();
  await waitFor(() => secondBridge.ready && secondDevice.ready && snapshot !== null);
  assert.equal(snapshot.telemetry.batteryPercent, 41);
  assert.equal(snapshot.revision, store.revision);
});

test("a new connection replaces an older session for the same device and transport", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-replace-"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-replace", secret: "4".repeat(64) });
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets")),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  t.after(() => hub.close());

  const firstLink = createMemoryTransportPair({ kind: "wifi" });
  const firstBridge = hub.attachTransport(firstLink.left);
  const firstDevice = new DeviceSession({
    role: "device",
    transport: firstLink.right,
    deviceId: "core-s3-replace",
    secret: "4".repeat(64),
  });
  firstDevice.start();
  await waitFor(() => firstBridge.ready && firstDevice.ready);

  const secondLink = createMemoryTransportPair({ kind: "wifi" });
  const secondBridge = hub.attachTransport(secondLink.left);
  const secondDevice = new DeviceSession({
    role: "device",
    transport: secondLink.right,
    deviceId: "core-s3-replace",
    secret: "4".repeat(64),
  });
  t.after(() => secondDevice.close());
  secondDevice.start();
  await waitFor(() => secondBridge.ready && secondDevice.ready && firstDevice.state === "closed");
  assert.deepEqual(hub.listDevices()[0].transports, ["wifi"]);
});

test("device hub rejects excess pending connections and closes their transports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hub-limit-"));
  const hub = new DeviceHub({
    store: new DeskStore(),
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets")),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials: new DeviceCredentialRepository(path.join(root, "devices.json")),
    maxSessions: 1,
  });
  await hub.start();
  t.after(() => hub.close());
  const first = createMemoryTransportPair({ kind: "wifi" });
  hub.attachTransport(first.left);
  const excess = createMemoryTransportPair({ kind: "wifi" });
  assert.throws(() => hub.attachTransport(excess.left), /session limit/);
  assert.equal(excess.left.open, false);
  assert.equal(excess.right.open, false);
});
