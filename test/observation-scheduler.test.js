import test from "node:test";
import assert from "node:assert/strict";
import { DeskStore } from "../src/server/desk-store.js";
import { ObservationScheduler } from "../src/server/observation-scheduler.js";

function createFixture({
  minimum = 10,
  maximum = 30,
  duplicateGuardSeconds = 90,
  random = 0.5,
} = {}) {
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const captures = [];
  let selectedDevice = "tab5-1";
  const store = new DeskStore();
  const scheduler = new ObservationScheduler({
    store,
    settings: {
      load: async () => ({
        care: {
          enabled: true,
          observationMinimumMinutes: minimum,
          observationMaximumMinutes: maximum,
          duplicateGuardSeconds,
        },
      }),
    },
    selectDevice: () => selectedDevice,
    capture: async (deviceId, options) => {
      captures.push({ deviceId, ...options });
      return { commandId: `capture-command-${captures.length}` };
    },
    now: () => now,
    random: () => random,
    setTimer: (callback, delay) => {
      const timer = { id: nextTimerId++, callback, delay };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer.id),
  });
  return {
    captures,
    scheduler,
    store,
    timers,
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    set selectedDevice(value) {
      selectedDevice = value;
    },
    async fireTimer() {
      const timer = [...timers.values()][0];
      assert.ok(timer, "expected an armed observation timer");
      timers.delete(timer.id);
      now += timer.delay;
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("scheduler randomizes normal observations and adopts AI follow-up time", async () => {
  const fixture = createFixture({ minimum: 10, maximum: 30, random: 0.5 });
  fixture.scheduler.setAvailable(true);
  await fixture.scheduler.start();

  assert.equal(fixture.scheduler.dueAt, fixture.now + 20 * 60_000);
  assert.equal(fixture.store.snapshot().care.nextObservationAt, fixture.scheduler.dueAt);
  await fixture.fireTimer();
  assert.deepEqual(fixture.captures, [{
    deviceId: "tab5-1",
    reason: "scheduled",
  }]);
  assert.equal(fixture.store.snapshot().care.status, "observing");
  assert.equal(fixture.scheduler.dueAt, null);

  fixture.store.setCare({
    status: "idle",
    nextObservationAt: fixture.now + 6 * 60_000,
  });
  assert.equal(fixture.scheduler.dueAt, fixture.now + 6 * 60_000);
  assert.equal([...fixture.timers.values()][0].delay, 6 * 60_000);
  fixture.scheduler.stop();
});

test("scheduler pauses while care is busy and resumes after state becomes idle", async () => {
  const fixture = createFixture({ minimum: 10, maximum: 10 });
  fixture.scheduler.setAvailable(true);
  await fixture.scheduler.start();
  fixture.store.setCare({ status: "listening" });
  assert.equal(fixture.timers.size, 0);

  fixture.now += 15 * 60_000;
  fixture.store.setCare({ status: "idle" });
  assert.equal(fixture.timers.size, 1);
  assert.equal([...fixture.timers.values()][0].delay, 0);
  await fixture.fireTimer();
  assert.equal(fixture.captures.length, 1);
  fixture.scheduler.stop();
});

test("scheduler enforces the technical duplicate guard without a six-hour cooldown", async () => {
  const fixture = createFixture({ duplicateGuardSeconds: 90 });
  fixture.scheduler.setAvailable(true);
  await fixture.scheduler.start();
  const first = await fixture.scheduler.requestNow("manual");
  assert.equal(first.accepted, true);
  fixture.store.setCare({ status: "idle" });

  fixture.now += 30_000;
  const duplicate = await fixture.scheduler.requestNow("follow-up");
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "duplicate-guard");
  assert.equal(duplicate.retryAt, fixture.now + 60_000);

  fixture.now = duplicate.retryAt;
  fixture.store.setCare({ status: "idle" });
  const second = await fixture.scheduler.requestNow("follow-up");
  assert.equal(second.accepted, true);
  assert.equal(fixture.captures.length, 2);
  fixture.scheduler.stop();
});

test("scheduler cancels on disconnect and replans after a high-bandwidth device returns", async () => {
  const fixture = createFixture();
  fixture.scheduler.setAvailable(true);
  await fixture.scheduler.start();
  assert.equal(fixture.timers.size, 1);

  fixture.scheduler.setAvailable(false);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.store.snapshot().care.nextObservationAt, null);
  fixture.selectedDevice = null;
  assert.deepEqual(await fixture.scheduler.requestNow(), {
    accepted: false,
    reason: "unavailable",
  });

  fixture.selectedDevice = "tab5-1";
  fixture.scheduler.setAvailable(true);
  assert.equal(fixture.timers.size, 1);
  assert.ok(fixture.scheduler.dueAt > fixture.now);
  fixture.scheduler.stop();
});
