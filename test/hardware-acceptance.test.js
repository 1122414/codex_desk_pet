import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeHardwareAcceptance,
  createHardwareAcceptanceRecord,
  mergeHardwareAcceptanceEvents,
  normalizeHardwareAcceptanceSample,
} from "../src/shared/hardware-acceptance.js";

const startedAt = 2_000_000_000_000;

function sample(occurredAt, {
  connected = true,
  rssBytes = 80 * 1024 * 1024,
} = {}) {
  return normalizeHardwareAcceptanceSample({
    occurredAt,
    snapshot: {
      care: { status: "idle", conversationId: "care-thread-1" },
      voice: { status: "idle" },
      vision: { status: "idle" },
      telemetry: {
        deviceId: "tab5-acceptance",
        batteryPercent: 75,
        charging: true,
        wifiRssi: -58,
        temperatureC: 43.2,
        transport: "wifi",
      },
    },
    diagnostics: {
      bridgeVersion: "0.3.0",
      target: {
        boardId: "m5stack-tab5-k145",
        protocolVersion: 5,
        minimumFirmwareVersion: "0.3.0",
      },
      codex: { connected: true },
      runtime: {
        uptimeSeconds: 1_000,
        memory: { rssBytes, heapUsedBytes: 20 * 1024 * 1024 },
      },
    },
    devices: [{
      deviceId: "tab5-acceptance",
      connected,
      transports: connected ? ["wifi"] : [],
      primaryTransport: connected ? "wifi" : null,
      protocolVersion: connected ? 5 : null,
      deviceInfo: {
        boardId: "m5stack-tab5-k145",
        firmwareVersion: "0.3.0",
      },
      compatibility: { compatible: true },
    }],
    deviceId: "tab5-acceptance",
  });
}

function completedEvent(id, type, offset, extra = {}) {
  return {
    version: 1,
    id,
    type,
    occurredAt: startedAt + offset,
    deviceId: "tab5-acceptance",
    conversationId: "care-thread-1",
    summary: type,
    data: null,
    ...extra,
  };
}

test("hardware acceptance proves the complete physical evidence contract", () => {
  const record = createHardwareAcceptanceRecord({
    startedAt,
    durationHours: 2 / 60,
    sampleIntervalSeconds: 60,
    deviceId: "tab5-acceptance",
  });
  record.samples.push(
    sample(startedAt),
    sample(startedAt + 60_000, { connected: false }),
    sample(startedAt + 120_000, { rssBytes: 82 * 1024 * 1024 }),
  );
  const events = [
    completedEvent("scheduled", "observation.requested", 1_000, {
      summary: "scheduled",
      data: { reason: "scheduled", transport: "wifi" },
    }),
    completedEvent("observed", "observation.completed", 2_000),
    completedEvent("disconnect", "device.disconnected", 50_000, {
      data: { transport: "wifi" },
    }),
    completedEvent("reconnect", "device.connected", 70_000, {
      data: { transport: "wifi" },
    }),
  ];
  for (let round = 0; round < 5; round += 1) {
    events.push(
      completedEvent(`user-${round}`, "conversation.user_reply", 3_000 + round * 2_000),
      completedEvent(`assistant-${round}`, "conversation.assistant_reply", 4_000 + round * 2_000),
    );
  }
  const actions = [
    "set_tab5_brightness",
    "set_tab5_volume",
    "set_macos_volume",
    "open_app",
    "capture_now",
    "schedule_follow_up",
  ];
  actions.forEach((name, index) => {
    events.push(
      completedEvent(`action-request-${index}`, "action.requested", 20_000 + index * 2_000, {
        summary: name,
        data: { name, arguments: {} },
      }),
      completedEvent(`action-complete-${index}`, "action.completed", 21_000 + index * 2_000, {
        summary: `${name} 完成`,
        data: { action: name, ok: true },
      }),
    );
  });
  mergeHardwareAcceptanceEvents(record, events);

  const report = analyzeHardwareAcceptance(record, {
    requiredDurationMs: 120_000,
  });
  assert.equal(report.passed, true);
  assert.equal(report.checks.fiveRoundConversation.ok, true);
  assert.equal(report.checks.wifiReconnect.ok, true);
  assert.equal(report.checks.temperatureRecorded.evidence.maximumC, 43.2);
});

test("hardware acceptance rejects duplicate actions and incomplete evidence", () => {
  const record = createHardwareAcceptanceRecord({
    startedAt,
    durationHours: 1,
    sampleIntervalSeconds: 60,
    requireWifiReconnect: false,
  });
  record.samples.push(sample(startedAt), sample(startedAt + 60_000));
  mergeHardwareAcceptanceEvents(record, [
    completedEvent("duplicate-1", "action.requested", 1_000, {
      summary: "open_app",
      data: { name: "open_app", arguments: { presetId: "music" } },
    }),
    completedEvent("duplicate-2", "action.requested", 2_000, {
      summary: "open_app",
      data: { name: "open_app", arguments: { presetId: "music" } },
    }),
    completedEvent("unrecovered-camera", "observation.failed", 3_000, {
      summary: "摄像头中断",
    }),
  ]);

  const report = analyzeHardwareAcceptance(record);
  assert.equal(report.passed, false);
  assert.equal(report.checks.noDuplicateActions.ok, false);
  assert.equal(report.checks.duration.ok, false);
  assert.equal(report.checks.fiveRoundConversation.ok, false);
  assert.equal(report.checks.recoveredFinalState.ok, false);
});

test("hardware event merging is idempotent across recorder resumes", () => {
  const record = createHardwareAcceptanceRecord({ startedAt });
  const event = completedEvent("stable-event", "observation.completed", 1_000);
  mergeHardwareAcceptanceEvents(record, [event, event]);
  mergeHardwareAcceptanceEvents(record, [event]);
  assert.equal(record.events.length, 1);
});

test("five-round evidence requires five replies from each side", () => {
  const record = createHardwareAcceptanceRecord({
    startedAt,
    durationHours: 1 / 60,
    sampleIntervalSeconds: 60,
    requireWifiReconnect: false,
  });
  record.samples.push(sample(startedAt), sample(startedAt + 60_000));
  const events = [];
  for (let round = 0; round < 5; round += 1) {
    events.push(
      completedEvent(`strict-user-${round}`, "conversation.user_reply", 1_000 + round * 2_000),
    );
    if (round < 4) {
      events.push(
        completedEvent(`strict-assistant-${round}`, "conversation.assistant_reply", 2_000 + round * 2_000),
      );
    }
  }
  mergeHardwareAcceptanceEvents(record, events);
  const report = analyzeHardwareAcceptance(record, { requiredDurationMs: 60_000 });
  assert.equal(report.checks.fiveRoundConversation.ok, false);
  assert.equal(
    report.checks.fiveRoundConversation.evidence.assistantReplies,
    4,
  );
});
