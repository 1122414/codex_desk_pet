import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLevel,
  extractTotalTokens,
  mapThreadToPresentation,
  selectDisplayThread,
  sortDisplayThreads,
  summarizeThread,
} from "../src/shared/codex-state.js";

const NOW = 2_000_000_000_000;

function thread(overrides = {}) {
  return {
    id: "thread-1",
    preview: "Build a desk buddy",
    updatedAt: NOW / 1_000,
    status: { type: "idle" },
    turns: [],
    ...overrides,
  };
}

test("Codex thread states map to pet presentation states", () => {
  assert.deepEqual(mapThreadToPresentation(thread(), { now: NOW }), { state: "ready", animation: "idle" });
  assert.deepEqual(
    mapThreadToPresentation(thread({ status: { type: "active", activeFlags: [] } }), { now: NOW }),
    { state: "running", animation: "running" },
  );
  assert.deepEqual(
    mapThreadToPresentation(thread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }), { now: NOW }),
    { state: "needs-input", animation: "waiting" },
  );
  assert.deepEqual(
    mapThreadToPresentation(thread({ status: { type: "systemError" } }), { now: NOW }),
    { state: "blocked", animation: "failed" },
  );
});

test("a fresh completion celebrates before returning to idle", () => {
  const completed = thread({ lastTurn: { status: "completed", completedAt: (NOW - 500) / 1_000 } });
  assert.equal(mapThreadToPresentation(completed, { now: NOW }).animation, "jumping");
  assert.equal(mapThreadToPresentation(completed, { now: NOW + 2_000 }).animation, "waving");
  assert.equal(mapThreadToPresentation(completed, { now: NOW + 5_000 }).animation, "idle");
});

test("a separately loaded Codex task is considered running while its session file is fresh", () => {
  const recent = thread({
    status: { type: "notLoaded" },
    updatedAt: (NOW - 5_000) / 1_000,
  });
  const stale = thread({
    status: { type: "notLoaded" },
    updatedAt: (NOW - 120_000) / 1_000,
  });
  assert.equal(mapThreadToPresentation(recent, { now: NOW }).state, "running");
  assert.equal(mapThreadToPresentation(stale, { now: NOW }).state, "ready");
});

test("display selection prioritizes approvals, then true recency", () => {
  const idle = thread({ id: "idle", updatedAt: NOW / 1_000 + 100 });
  const active = thread({ id: "active", status: { type: "active", activeFlags: [] } });
  const approval = thread({ id: "approval", status: { type: "active", activeFlags: ["waitingOnApproval"] }, updatedAt: NOW / 1_000 - 100 });
  assert.equal(selectDisplayThread([idle, active, approval], { now: NOW }).id, "approval");
  assert.equal(selectDisplayThread([idle, active], { now: NOW }).id, "idle");
});

test("a stale blocked goal cannot pin the main display over recent work", () => {
  const recent = thread({ id: "recent", updatedAt: NOW / 1_000 });
  const staleBlocked = thread({
    id: "stale-blocked",
    updatedAt: (NOW - 2 * 86_400_000) / 1_000,
    goal: { status: "blocked", updatedAt: (NOW - 2 * 86_400_000) / 1_000 },
  });
  assert.equal(selectDisplayThread([staleBlocked, recent], { now: NOW }).id, "recent");
});

test("fresh execution overrides a stale blocked goal", () => {
  const active = thread({
    status: { type: "active", activeFlags: [] },
    goal: { status: "blocked" },
  });
  assert.deepEqual(
    mapThreadToPresentation(active, { now: NOW }),
    { state: "running", animation: "running" },
  );
});

test("recent thread activity overrides an older terminal goal", () => {
  const resumed = thread({
    status: { type: "notLoaded" },
    updatedAt: NOW / 1_000,
    goal: {
      status: "blocked",
      updatedAt: (NOW - 60_000) / 1_000,
    },
  });
  assert.deepEqual(
    mapThreadToPresentation(resumed, { now: NOW }),
    { state: "running", animation: "running" },
  );
});

test("task list is ordered strictly by newest activity", () => {
  const newestIdle = thread({ id: "newest", updatedAt: NOW / 1_000 + 10 });
  const olderRunning = thread({
    id: "older-running",
    updatedAt: NOW / 1_000,
    status: { type: "active", activeFlags: [] },
  });
  assert.deepEqual(
    sortDisplayThreads([olderRunning, newestIdle]).map(({ id }) => id),
    ["newest", "older-running"],
  );
});

test("token usage produces a configurable level", () => {
  const tokens = extractTotalTokens({ total: { totalTokens: 125_500 } });
  assert.equal(tokens, 125_500);
  assert.deepEqual(computeLevel(tokens, 50_000), { level: 3, current: 25_500, target: 50_000, progress: 0.51 });
});

test("thread summary is compact and safe for a small display", () => {
  assert.equal(summarizeThread(null), "暂无 Codex 任务");
  assert.equal(summarizeThread(thread({ name: "  A\n  concise   title  " })), "A concise title");
});
