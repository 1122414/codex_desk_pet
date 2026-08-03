import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CareActionService } from "../src/server/care-action-service.js";
import { CareAgent } from "../src/server/care-agent.js";
import { CareMemoryRepository } from "../src/server/care-memory-repository.js";
import { DeviceCredentialRepository } from "../src/server/device-credential-repository.js";
import { DeviceHub } from "../src/server/device-hub.js";
import { DeviceSession } from "../src/server/device-session.js";
import { DeskStore } from "../src/server/desk-store.js";
import { ObservationScheduler } from "../src/server/observation-scheduler.js";
import { PetCatalog } from "../src/server/pet-catalog.js";
import { SettingsRepository } from "../src/server/settings-repository.js";
import { createMemoryTransportPair } from "../src/server/transports/memory-transport.js";
import { VisionAgent } from "../src/server/vision-agent.js";
import { VoiceAgent } from "../src/server/voice-agent.js";

const DEVICE_ID = "virtual-care-tab5";
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
const AUDIO = Buffer.alloc(640 * 2).toString("base64");

function careReply(patch = {}) {
  return JSON.stringify({
    say: "",
    continueListening: false,
    nextObservationMinutes: 10,
    action: null,
    memory: null,
    ...patch,
  });
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

class ScriptedConversation {
  constructor(replies = []) {
    this.replies = [...replies];
    this.starts = [];
    this.turns = [];
  }

  push(...replies) {
    this.replies.push(...replies);
  }

  async startThread(options) {
    this.starts.push(options);
    return `virtual-care-thread-${this.starts.length}`;
  }

  async runTurn(threadId, input) {
    const turnId = `virtual-care-turn-${this.turns.length + 1}`;
    this.turns.push({ threadId, turnId, input });
    const reply = await this.replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error("虚拟 Care 会话缺少脚本回复");
    return { threadId, turnId, reply };
  }
}

class ControlledClock {
  #nextTimerId = 1;
  #timers = new Map();

  constructor(now) {
    this.value = now;
  }

  now = () => this.value;

  setTimer = (callback, delay) => {
    const handle = {
      id: this.#nextTimerId,
      unref() {},
    };
    this.#nextTimerId += 1;
    this.#timers.set(handle.id, {
      callback,
      dueAt: this.value + Math.max(0, Number(delay) || 0),
    });
    return handle;
  };

  clearTimer = (handle) => {
    if (handle?.id) this.#timers.delete(handle.id);
  };

  advance(milliseconds) {
    this.value += milliseconds;
  }

  async fireNext() {
    const next = [...this.#timers.entries()]
      .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
    if (!next) throw new Error("虚拟观察调度器没有可触发的计时器");
    this.#timers.delete(next[0]);
    this.value = Math.max(this.value, next[1].dueAt);
    next[1].callback();
    await new Promise((resolve) => setImmediate(resolve));
    return this.value;
  }
}

export async function verifyVirtualCare() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-virtual-care-"));
  const store = new DeskStore();
  const settings = new SettingsRepository(path.join(root, "settings.json"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  const catalog = new PetCatalog(path.join(root, "pets"));
  const memory = new CareMemoryRepository({
    directoryPath: path.join(root, "memory"),
    now: () => clock.value,
  });
  const clock = new ControlledClock(1_800_000_000_000);
  const conversation = new ScriptedConversation();
  const bridge = new EventEmitter();
  const transcripts = [];
  bridge.isMock = false;
  bridge.decideApproval = async () => null;
  bridge.client = {
    running: true,
    request: async () => ({}),
  };

  await settings.save({
    care: {
      enabled: true,
      observationMinimumMinutes: 1,
      observationMaximumMinutes: 1,
      autoListenSeconds: 5,
      duplicateGuardSeconds: 90,
      appPresets: [{
        id: "virtual-music",
        label: "虚拟音乐",
        bundleId: "com.example.virtual-music",
      }],
    },
  });
  await catalog.refresh();
  await memory.load();

  const careAgent = new CareAgent({
    bridge,
    store,
    settings,
    memory,
    conversation,
    cwd: root,
    now: clock.now,
  });
  const voiceAgent = new VoiceAgent({
    store,
    petAgent: {
      chat: async () => ({ reply: "unused" }),
      queueCommand: () => ({ requestId: "unused" }),
    },
    careAgent,
    settings,
    transcriber: {
      available: async () => true,
      transcribe: async () => transcripts.shift() ?? "",
    },
  });
  const visionAgent = new VisionAgent({
    store,
    careAgent,
    settings,
    root: path.join(root, "vision"),
  });
  const hub = new DeviceHub({
    store,
    bridge,
    catalog,
    settings,
    credentials,
    voiceAgent,
    visionAgent,
  });
  const scheduler = new ObservationScheduler({
    store,
    settings,
    selectDevice: () => hub.primaryCameraDeviceId(),
    capture: (deviceId, options) => hub.requestCameraCapture(deviceId, options),
    now: clock.now,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const openedApps = [];
  const actionService = new CareActionService({
    settings,
    deviceActions: {
      setBrightness: (deviceId, value) => hub.setDeviceBrightness(deviceId, value),
      setVolume: (deviceId, value) => hub.setDeviceVolume(deviceId, value),
    },
    macosActions: {
      openApp: async (presetId) => {
        openedApps.push(presetId);
        return { message: "已打开虚拟音乐", presetId };
      },
      openMediaPreset: async () => ({ message: "unused" }),
      setVolume: async () => ({ previousValue: 50 }),
    },
    observationScheduler: scheduler,
    now: clock.now,
  });
  careAgent.setActionService(actionService);

  const devices = [];
  const bridgeSessions = [];
  const careEvents = [];
  const deviceCommands = [];
  let captureMode = "complete";
  let captureSequence = 0;
  let ttsCompletions = 0;

  const sendCapture = (device, captureId, mode) => {
    const sha256 = createHash("sha256").update(JPEG).digest("hex");
    device.sendEvent({
      event: "vision.capture.begin",
      captureId,
      mimeType: "image/jpeg",
      totalBytes: JPEG.length,
      width: 1_280,
      height: 720,
      sha256,
    });
    if (mode === "interrupt") {
      setImmediate(() => device.close());
      return;
    }
    device.sendEvent({
      event: "vision.capture.chunk",
      captureId,
      offset: 0,
      data: JPEG.subarray(0, 5).toString("base64"),
    });
    device.sendEvent({
      event: "vision.capture.chunk",
      captureId,
      offset: 5,
      data: JPEG.subarray(5).toString("base64"),
    });
    device.sendEvent({ event: "vision.capture.end", captureId });
  };

  const attachDevice = ({ kind, secret = null, pairingCode = null }) => {
    const transports = createMemoryTransportPair({ kind });
    const bridgeSession = hub.attachTransport(transports.left);
    let device;
    device = new DeviceSession({
      role: "device",
      transport: transports.right,
      deviceId: DEVICE_ID,
      secret,
      pairingCode,
      commandHandler: async (command) => {
        deviceCommands.push({ kind, ...command });
        if (command.command === "camera.capture") {
          captureSequence += 1;
          const captureId = captureSequence.toString(16).padStart(16, "0");
          const mode = captureMode;
          setImmediate(() => sendCapture(device, captureId, mode));
          return { captureId };
        }
        if (command.command === "device.brightness.set") {
          return { value: command.value, previousValue: 72 };
        }
        if (command.command === "device.volume.set") {
          return { value: command.value, previousValue: 45 };
        }
        return { accepted: true };
      },
    });
    device.on("event", (event) => {
      if (event?.event === "care.reply") careEvents.push({ kind, ...event });
    });
    devices.push(device);
    bridgeSessions.push(bridgeSession);
    device.start();
    return { device, bridgeSession };
  };

  const refreshAvailability = () => {
    scheduler.setAvailable(hub.primaryCameraDeviceId() !== null);
  };
  const handleCaptureResult = (result) => scheduler.handleCaptureResult(result);
  hub.on("deviceConnected", refreshAvailability);
  hub.on("deviceDisconnected", refreshAvailability);
  hub.on("cameraCaptureResult", handleCaptureResult);

  const speakAfterTts = async (device, text) => {
    ttsCompletions += 1;
    const eventCount = careEvents.length;
    transcripts.push(text);
    await device.sendCommand("voice.start", { mode: "care" }, randomUUID());
    await waitFor(
      () => store.snapshot().voice.status === "listening",
      "虚拟 Tab5 未在 TTS 后自动进入关怀聆听",
    );
    device.sendEvent({
      event: "voice.audio",
      data: AUDIO,
      sampleRate: 16_000,
      numChannels: 1,
      samplesPerChannel: 640,
    });
    await device.sendCommand("voice.stop", {}, randomUUID());
    await waitFor(
      () => careEvents.length > eventCount,
      "虚拟 Tab5 未收到下一轮关怀回复",
    );
    return careEvents.at(-1);
  };

  try {
    await hub.start();
    await scheduler.start();

    const offer = hub.createPairingOffer();
    let pairedSecret = null;
    const usb = attachDevice({ kind: "usb", pairingCode: offer.code });
    usb.device.on("paired", ({ secret }) => { pairedSecret = secret; });
    await waitFor(
      () => usb.bridgeSession.ready && usb.device.ready && pairedSecret,
      "虚拟关怀 Tab5 未能通过 USB 配对",
    );
    const wifi = attachDevice({ kind: "wifi", secret: pairedSecret });
    await waitFor(
      () =>
        wifi.bridgeSession.ready &&
        wifi.device.ready &&
        hub.listDevices()[0]?.transports.length === 2,
      "虚拟关怀 Tab5 未建立 USB/Wi-Fi 双链路",
    );

    conversation.push(
      careReply({
        say: "你看起来还在忙，要不要和我说说？",
        continueListening: true,
        nextObservationMinutes: 5,
        memory: { summary: "用户正在桌前忙碌", importance: 1 },
      }),
      careReply({
        action: {
          name: "open_app",
          arguments: { presetId: "virtual-music" },
        },
      }),
      careReply({
        say: "音乐打开了，我们继续聊。",
        continueListening: true,
        nextObservationMinutes: 6,
      }),
      careReply({
        action: {
          name: "set_tab5_brightness",
          arguments: { value: 35 },
        },
      }),
      careReply({
        say: "屏幕已经暗一点了。",
        continueListening: true,
        nextObservationMinutes: 6,
      }),
      careReply({
        action: {
          name: "schedule_follow_up",
          arguments: { minutes: 7 },
        },
      }),
      careReply({
        say: "好，我七分钟后再来看看。",
        continueListening: false,
        nextObservationMinutes: 7,
      }),
    );

    await clock.fireNext();
    await waitFor(
      () => careEvents.some(({ source, ok }) => source === "observation" && ok),
      "定时观察没有形成主动关怀开场",
    );
    assert.equal(deviceCommands.at(-1).kind, "usb");
    assert.equal(careEvents.at(-1).text, "你看起来还在忙，要不要和我说说？");

    const duplicateCapture = await scheduler.requestNow("manual");
    assert.equal(duplicateCapture.accepted, false);
    assert.equal(duplicateCapture.reason, "duplicate-guard");

    usb.device.close();
    await waitFor(
      () => hub.listDevices()[0]?.primaryTransport === "wifi",
      "主动开场后未能从 USB 切换到 Wi-Fi",
    );

    const firstVoiceReply = await speakAfterTts(wifi.device, "帮我放点音乐吧");
    const secondVoiceReply = await speakAfterTts(wifi.device, "屏幕有一点亮");
    const thirdVoiceReply = await speakAfterTts(wifi.device, "好，晚点再看看我");
    assert.equal(firstVoiceReply.actionStatus?.action, "open_app");
    assert.equal(secondVoiceReply.actionStatus?.action, "set_tab5_brightness");
    assert.equal(thirdVoiceReply.actionStatus?.action, "schedule_follow_up");
    assert.deepEqual(openedApps, ["virtual-music"]);
    assert.equal(
      deviceCommands.filter(({ command }) => command === "device.brightness.set").length,
      1,
    );
    assert.equal(store.snapshot().care.nextObservationAt, clock.value + 7 * 60_000);
    assert.equal(new Set(conversation.turns.map(({ threadId }) => threadId)).size, 1);

    await actionService.execute({
      name: "open_app",
      arguments: { presetId: "virtual-music" },
    }, {
      idempotencyKey: "virtual-care-thread-1:virtual-care-turn-2",
      deviceId: DEVICE_ID,
    });
    assert.deepEqual(openedApps, ["virtual-music"]);

    clock.advance(91_000);
    conversation.push("not-json");
    const invalidStart = careEvents.length;
    assert.equal((await scheduler.requestNow("manual")).accepted, true);
    await waitFor(
      () => careEvents.length > invalidStart,
      "AI JSON 非法后没有安全完成观察",
    );
    assert.equal(careEvents.at(-1).ok, true);
    assert.equal(careEvents.at(-1).text, "");
    assert.equal(store.snapshot().care.status, "idle");

    clock.advance(91_000);
    conversation.push(new Error("Codex App Server 已断开"));
    const failedStart = careEvents.length;
    assert.equal((await scheduler.requestNow("manual")).accepted, true);
    await waitFor(
      () => careEvents.length > failedStart && careEvents.at(-1).ok === false,
      "Codex 断开后没有返回可恢复失败",
    );
    assert.equal(store.snapshot().vision.status, "failed");
    assert.ok(Number.isFinite(store.snapshot().care.nextObservationAt));

    clock.advance(91_000);
    conversation.push(careReply({
      say: "",
      continueListening: false,
      nextObservationMinutes: 4,
    }));
    const recoveredStart = careEvents.length;
    assert.equal((await scheduler.requestNow("manual")).accepted, true);
    await waitFor(
      () => careEvents.length > recoveredStart && careEvents.at(-1).ok === true,
      "Codex 恢复后观察没有重新成功",
    );
    assert.equal(conversation.starts.length, 2);

    clock.advance(91_000);
    captureMode = "interrupt";
    const interrupted = await scheduler.requestNow("manual");
    assert.equal(interrupted.accepted, true);
    await waitFor(
      () =>
        store.snapshot().vision.status === "failed" &&
        store.snapshot().vision.error === "摄像头图片传输中断",
      "图片传输中断没有进入可恢复失败状态",
    );
    await waitFor(
      () => hub.primaryCameraDeviceId() === null,
      "图片中断后虚拟设备没有断开",
    );

    captureMode = "complete";
    const reconnected = attachDevice({ kind: "wifi", secret: pairedSecret });
    await waitFor(
      () => reconnected.bridgeSession.ready && reconnected.device.ready,
      "虚拟 Tab5 图片中断后未能重连",
    );
    conversation.push(careReply({
      say: "",
      continueListening: false,
      nextObservationMinutes: 3,
    }));
    const afterReconnect = careEvents.length;
    await clock.fireNext();
    await clock.fireNext();
    await waitFor(
      () => careEvents.length > afterReconnect && careEvents.at(-1).ok === true,
      "图片中断重连后调度器没有恢复观察",
    );

    return {
      scheduledObservation: true,
      openingText: "你看起来还在忙，要不要和我说说？",
      automaticTtsCompletions: ttsCompletions,
      voiceRounds: 3,
      sharedCareThread: true,
      actions: {
        openedAppOnce: openedApps.length === 1,
        brightnessSetOnce:
          deviceCommands.filter(({ command }) =>
            command === "device.brightness.set").length === 1,
        followUpMinutes: 7,
      },
      transportSwitch: "usb-to-wifi",
      duplicateCaptureSuppressed: true,
      duplicateActionSuppressed: true,
      invalidJsonRecovered: true,
      codexReconnectRecovered: conversation.starts.length === 2,
      interruptedImageRecovered: true,
      eventCount: memory.snapshot().eventCount,
    };
  } finally {
    hub.off("deviceConnected", refreshAvailability);
    hub.off("deviceDisconnected", refreshAvailability);
    hub.off("cameraCaptureResult", handleCaptureResult);
    scheduler.stop();
    actionService.close();
    await voiceAgent.close();
    visionAgent.close();
    careAgent.close();
    for (const device of devices) device.close();
    await hub.close();
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await verifyVirtualCare();
  process.stdout.write(`虚拟 Tab5 主动关怀验收通过\n${JSON.stringify(report, null, 2)}\n`);
}
