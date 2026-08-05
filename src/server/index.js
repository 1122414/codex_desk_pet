import { CodexBridge } from "./codex-bridge.js";
import { CareAgent } from "./care-agent.js";
import { CareActionService } from "./care-action-service.js";
import { CareMemoryRepository } from "./care-memory-repository.js";
import { CodexConversation } from "./codex-conversation.js";
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
import { MacosCareActions } from "./macos-care-actions.js";
import { ObservationScheduler } from "./observation-scheduler.js";
import { UsbDeviceManager } from "./transports/usb-cdc-transport.js";
import { LocalWhisperTranscriber } from "./local-whisper-transcriber.js";
import { MacosSpeechSynthesizer } from "./macos-speech-synthesizer.js";
import { FallbackSpeechSynthesizer, NeuralSpeechSynthesizer } from "./neural-speech-synthesizer.js";
import { VoiceAgent } from "./voice-agent.js";
import { VisionAgent } from "./vision-agent.js";

const mode = process.env.CODEX_DESK_MODE ?? "direct";
if (!new Set(["direct", "daemon", "mock"]).has(mode)) throw new Error("CODEX_DESK_MODE must be direct, daemon, or mock");

const catalog = new PetCatalog();
catalog.onWarning = (message) => console.warn(message);
await catalog.refresh();

const settings = new SettingsRepository();
const saved = await settings.load();
const selectedPetId = catalog.has(saved.selectedPetId) ? saved.selectedPetId : "codex-core";
const store = new DeskStore({
  selectedPetId,
  care: { enabled: saved.care.enabled },
});
const careMemory = new CareMemoryRepository();
const refreshCareMemory = (memory) => store.setCareMemory(memory);
careMemory.on("diagnostic", ({ message }) => console.warn(`[care-memory] ${message}`));
careMemory.on("change", refreshCareMemory);
try {
  refreshCareMemory(await careMemory.load());
} catch (error) {
  console.warn(`Care memory is unavailable: ${error.message}`);
  store.setCare({ status: "failed", error: error.message });
}
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
const conversation = new CodexConversation({ bridge });
const petAgent = new PetAgent({ bridge, store, conversation });
void petAgent.warmChat().catch(() => {});
const careAgent = new CareAgent({
  bridge,
  store,
  settings,
  memory: careMemory,
  conversation,
});
const neuralSpeechSynthesizer = new NeuralSpeechSynthesizer();
void neuralSpeechSynthesizer.start().catch(() => {});
const speechSynthesizer = new FallbackSpeechSynthesizer({
  primary: neuralSpeechSynthesizer,
  fallback: new MacosSpeechSynthesizer(),
});
const voiceAgent = new VoiceAgent({
  store,
  petAgent,
  careAgent,
  settings,
  transcriber: new LocalWhisperTranscriber(),
  speechSynthesizer,
});
const visionAgent = new VisionAgent({ store, careAgent, settings });
const deviceHub = new DeviceHub({
  store,
  bridge,
  catalog,
  settings,
  credentials,
  voiceAgent,
  petAgent,
  visionAgent,
});
const observationScheduler = new ObservationScheduler({
  store,
  settings,
  selectDevice: () => deviceHub.primaryCameraDeviceId(),
  capture: (deviceId, options) => deviceHub.requestCameraCapture(deviceId, options),
});
const macosCareActions = new MacosCareActions({ settings });
const careActionService = new CareActionService({
  settings,
  deviceActions: {
    setBrightness: (deviceId, value) =>
      deviceHub.setDeviceBrightness(deviceId, value),
    setVolume: (deviceId, value) =>
      deviceHub.setDeviceVolume(deviceId, value),
  },
  macosActions: macosCareActions,
  observationScheduler,
});
careActionService.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[care-action] ${message}`);
});
careAgent.setActionService(careActionService);
const refreshObservationAvailability = () => {
  observationScheduler.setAvailable(deviceHub.primaryCameraDeviceId() !== null);
};
const handleCameraCaptureResult = (result) => {
  observationScheduler.handleCaptureResult(result);
};
const recordAcceptanceEvent = (event) => {
  careMemory.appendEvent(event).catch((error) => {
    if (process.env.CODEX_DESK_DEBUG === "1") {
      console.warn(`[care-memory] ${error.message}`);
    }
  });
};
const handleDeviceConnected = (details) => {
  refreshObservationAvailability();
  recordAcceptanceEvent({
    type: "device.connected",
    deviceId: details.deviceId,
    summary: `${details.transport} 已连接`,
    data: { transport: details.transport },
  });
};
const handleDeviceDisconnected = (details) => {
  refreshObservationAvailability();
  recordAcceptanceEvent({
    type: "device.disconnected",
    deviceId: details.deviceId,
    summary: `${details.transport} 已断开`,
    data: { transport: details.transport },
  });
};
const handleCaptureRequested = (details) => {
  recordAcceptanceEvent({
    type: "observation.requested",
    deviceId: details.deviceId,
    summary: details.reason,
    data: {
      reason: details.reason,
      transport: details.transport ?? null,
      commandId: details.commandId ?? null,
    },
  });
};
const handleCaptureFailed = (details) => {
  recordAcceptanceEvent({
    type: "observation.failed",
    deviceId: details.deviceId ?? null,
    summary: String(details.error || "摄像头观察失败").slice(0, 500),
  });
};
deviceHub.on("deviceConnected", handleDeviceConnected);
deviceHub.on("deviceDisconnected", handleDeviceDisconnected);
deviceHub.on("cameraCaptureResult", handleCameraCaptureResult);
observationScheduler.on("captureRequested", handleCaptureRequested);
observationScheduler.on("captureFailed", handleCaptureFailed);
deviceHub.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[device] ${message}`);
});
await deviceHub.start();
refreshObservationAvailability();
await observationScheduler.start();

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
  careAgent,
  voiceAgent,
  observationScheduler,
  careMemory,
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
  await speechSynthesizer.close();
  visionAgent.close();
  careAgent.close();
  petAgent.close();
  conversation.close();
  await server.close();
  await deviceServer.close();
  await bleManager.close();
  await usbManager.close();
  observationScheduler.stop();
  careActionService.close();
  deviceHub.off("deviceConnected", handleDeviceConnected);
  deviceHub.off("deviceDisconnected", handleDeviceDisconnected);
  deviceHub.off("cameraCaptureResult", handleCameraCaptureResult);
  observationScheduler.off("captureRequested", handleCaptureRequested);
  observationScheduler.off("captureFailed", handleCaptureFailed);
  await deviceHub.close();
  careMemory.off("change", refreshCareMemory);
  await careMemory.close();
  await bridge.stop();
}

process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
