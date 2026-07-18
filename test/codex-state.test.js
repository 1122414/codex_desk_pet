import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLevel,
  extractTotalTokens,
  mapThreadToPresentation,
  selectDisplayThread,
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

test("display selection prioritizes approvals, then active recency", () => {
  const idle = thread({ id: "idle", updatedAt: NOW / 1_000 + 100 });
  const active = thread({ id: "active", status: { type: "active", activeFlags: [] } });
  const approval = thread({ id: "approval", status: { type: "active", activeFlags: ["waitingOnApproval"] }, updatedAt: NOW / 1_000 - 100 });
  assert.equal(selectDisplayThread([idle, active, approval], { now: NOW }).id, "approval");
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

