import test from "node:test";
import assert from "node:assert/strict";
import {
  CareActionService,
  validateCareAction,
} from "../src/server/care-action-service.js";

function fixture({
  allowedActions = [
    "capture_now",
    "set_tab5_brightness",
    "set_tab5_volume",
    "open_app",
    "open_media_preset",
    "set_macos_volume",
    "schedule_follow_up",
  ],
} = {}) {
  const calls = [];
  const settings = {
    load: async () => ({ care: { allowedActions } }),
  };
  const deviceActions = {
    setBrightness: async (deviceId, value) => {
      calls.push(["brightness", deviceId, value]);
      return { previousValue: 50 };
    },
    setVolume: async (deviceId, value) => {
      calls.push(["device-volume", deviceId, value]);
      return { previousValue: 30 };
    },
  };
  const macosActions = {
    setVolume: async (value) => {
      calls.push(["mac-volume", value]);
      return { previousValue: 40 };
    },
    openApp: async (presetId) => {
      calls.push(["app", presetId]);
      return { message: "应用已打开", presetId };
    },
    openMediaPreset: async (presetId) => {
      calls.push(["media", presetId]);
      return { message: "媒体已打开", presetId };
    },
  };
  const observationScheduler = {
    requestNow: async (reason) => {
      calls.push(["capture", reason]);
      return { accepted: true, deviceId: "tab5-action-1" };
    },
    schedule: (minutes) => {
      calls.push(["schedule", minutes]);
      return 123_000;
    },
  };
  const timers = [];
  const service = new CareActionService({
    settings,
    deviceActions,
    macosActions,
    observationScheduler,
    now: () => 100_000,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  return { service, calls, timers };
}

test("CareActionService executes only registered actions and deduplicates a turn", async () => {
  const { service, calls } = fixture();
  const action = {
    name: "open_app",
    arguments: { presetId: "netease-music" },
  };
  const first = await service.execute(action, { idempotencyKey: "thread-1:turn-1" });
  const duplicate = await service.execute(action, { idempotencyKey: "thread-1:turn-1" });

  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(calls, [["app", "netease-music"]]);
  assert.throws(() => validateCareAction({
    name: "run_shell",
    arguments: { command: "open anything" },
  }), /未获允许/);
  assert.throws(() => validateCareAction({
    name: "open_media_preset",
    arguments: { presetId: "https://untrusted.example" },
  }), /预设/);
  service.close();
});

test("temporary device values are restored and disabled actions fail closed", async () => {
  const { service, calls, timers } = fixture({
    allowedActions: ["set_tab5_brightness"],
  });
  const adjusted = await service.execute({
    name: "set_tab5_brightness",
    arguments: { value: 20, durationSeconds: 60 },
  }, {
    idempotencyKey: "thread-1:turn-2",
    deviceId: "tab5-action-1",
  });
  assert.deepEqual(
    {
      ok: adjusted.ok,
      value: adjusted.value,
      previousValue: adjusted.previousValue,
      restoreAt: adjusted.restoreAt,
    },
    { ok: true, value: 20, previousValue: 50, restoreAt: 160_000 },
  );
  assert.equal(timers.find(({ delay }) => delay === 60_000)?.delay, 60_000);
  await timers.find(({ delay }) => delay === 60_000).callback();
  assert.deepEqual(calls, [
    ["brightness", "tab5-action-1", 20],
    ["brightness", "tab5-action-1", 50],
  ]);

  const denied = await service.execute({
    name: "open_app",
    arguments: { presetId: "music" },
  }, { idempotencyKey: "thread-1:turn-3" });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /禁用/);
  service.close();
});

test("all remaining registered actions route only to their fixed adapters", async () => {
  const { service, calls } = fixture();
  const actions = [
    { name: "capture_now", arguments: {} },
    { name: "schedule_follow_up", arguments: { minutes: 12 } },
    { name: "set_tab5_volume", arguments: { value: 45 } },
    { name: "set_macos_volume", arguments: { value: 35 } },
    { name: "open_media_preset", arguments: { presetId: "focus-music" } },
  ];
  for (const [index, action] of actions.entries()) {
    assert.equal(
      (await service.execute(action, {
        idempotencyKey: `thread-2:turn-${index}`,
        deviceId: "tab5-action-1",
      })).ok,
      true,
    );
  }
  assert.deepEqual(calls, [
    ["capture", "manual"],
    ["schedule", 12],
    ["device-volume", "tab5-action-1", 45],
    ["mac-volume", 35],
    ["media", "focus-music"],
  ]);
  service.close();
});
