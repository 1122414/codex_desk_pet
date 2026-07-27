import { CodexBridge } from "./codex-bridge.js";
import { DeviceCredentialRepository } from "./device-credential-repository.js";
import { DeviceHub } from "./device-hub.js";
import { DeviceWebSocketServer } from "./device-websocket-server.js";
import { DeskStore } from "./desk-store.js";
import { DeskHttpServer } from "./http-server.js";
import { HookApprovalBroker } from "./hook-approval-broker.js";
import { HookTokenRepository } from "./hook-token-repository.js";
import { PetCatalog } from "./pet-catalog.js";
import { PetAgent } from "./pet-agent.js";
import { SettingsRepository } from "./settings-repository.js";
import { MacBleDeviceManager } from "./transports/macos-ble-device-manager.js";
import { UsbDeviceManager } from "./transports/usb-cdc-transport.js";
import { VoiceAgent } from "./voice-agent.js";

const mode = process.env.CODEX_DESK_MODE ?? "direct";
if (!new Set(["direct", "daemon", "mock"]).has(mode)) throw new Error("CODEX_DESK_MODE must be direct, daemon, or mock");

const catalog = new PetCatalog();
catalog.onWarning = (message) => console.warn(message);
await catalog.refresh();

const settings = new SettingsRepository();
const saved = await settings.load();
const selectedPetId = catalog.has(saved.selectedPetId) ? saved.selectedPetId : "codex-core";
const store = new DeskStore({ selectedPetId });
const hookApprovalBroker = new HookApprovalBroker({ store });
const bridge = new CodexBridge({ store, mode, hookApprovalBroker });
bridge.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[codex] ${message}`);
});

try {
  await bridge.start();
} catch (error) {
  console.warn(`Codex bridge is unavailable: ${error.message}`);
}

const credentials = new DeviceCredentialRepository();
const hookToken = await new HookTokenRepository().loadOrCreate();
const petAgent = new PetAgent({ bridge, store });
const voiceAgent = new VoiceAgent({ bridge, store, petAgent });
const deviceHub = new DeviceHub({
  store,
  bridge,
  catalog,
  settings,
  credentials,
  voiceAgent,
  petAgent,
});
deviceHub.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[device] ${message}`);
});
await deviceHub.start();

const deviceServer = new DeviceWebSocketServer({ hub: deviceHub });
const deviceAddress = await deviceServer.listen({
  host: process.env.CODEX_DESK_DEVICE_HOST ?? "127.0.0.1",
  port: Number(process.env.CODEX_DESK_DEVICE_PORT ?? 4318),
});
const usbManager = new UsbDeviceManager({
  hub: deviceHub,
  explicitPaths: (process.env.CODEX_DESK_USB_PORT ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  autoDiscover: process.env.CODEX_DESK_USB_AUTO === "1",
});
usbManager.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[usb] ${message}`);
});
usbManager.on("attached", (devicePath) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[usb] attached ${devicePath}`);
});
await usbManager.start();
const bleManager = new MacBleDeviceManager({
  hub: deviceHub,
  enabled: process.platform === "darwin" && process.env.CODEX_DESK_BLE !== "0",
});
bleManager.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[ble] ${message}`);
});
bleManager.on("attached", ({ id, name }) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[ble] attached ${name} (${id})`);
});
await bleManager.start();

const server = new DeskHttpServer({
  store,
  bridge,
  catalog,
  settings,
  deviceHub,
  hookToken,
  hookApprovalBroker,
  petAgent,
});
server.onError = (error) => console.error(error);
const address = await server.listen({ port: Number(process.env.PORT ?? 4317) });
console.log(`Codex Desk Buddy is running at http://127.0.0.1:${address.port}`);
console.log(`Device WebSocket is listening at ws://${deviceAddress.address}:${deviceAddress.port}/device/ws`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  hookApprovalBroker.close();
  await voiceAgent.close();
  petAgent.close();
  await server.close();
  await deviceServer.close();
  await bleManager.close();
  await usbManager.close();
  await deviceHub.close();
  await bridge.stop();
}

process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
