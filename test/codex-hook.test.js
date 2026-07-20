import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeCodexHookApproval,
  normalizeCodexHookEvent,
} from "../src/server/codex-hook.js";
import { DeskStore } from "../src/server/desk-store.js";
import { HookTokenRepository } from "../src/server/hook-token-repository.js";

const NOW = 2_000_000_000_000;

function hook(event, overrides = {}) {
  return {
    version: 1,
    event,
    sessionId: "hook-session-1",
    occurredAt: NOW,
    ...overrides,
  };
}

test("Codex hook events are bounded, versioned, and clock-clamped", () => {
  assert.deepEqual(normalizeCodexHookEvent(hook("UserPromptSubmit", {
    title: `  Build\n${"x".repeat(200)}  `,
    workspaceName: "project",
    toolName: "Bash",
  }), { now: NOW }), {
    version: 1,
    event: "UserPromptSubmit",
    sessionId: "hook-session-1",
    turnId: null,
    title: `Build ${"x".repeat(114)}`,
    workspaceName: "project",
    toolName: "Bash",
    occurredAt: NOW,
  });
  assert.equal(normalizeCodexHookEvent({ ...hook("Stop"), version: 2 }), null);
  assert.equal(normalizeCodexHookEvent(hook("Unknown")), null);
  assert.equal(
    normalizeCodexHookEvent(hook("Stop", { occurredAt: NOW - 10 * 60_000 }), { now: NOW }).occurredAt,
    NOW,
  );
});

test("official hook lifecycle fills cross-client running, input, and completion states", () => {
  const store = new DeskStore();
  assert.equal(store.handleCodexHook(hook("UserPromptSubmit", {
    title: "实现桌面宠物",
  }), NOW), true);
  assert.equal(store.snapshot(NOW).task.title, "实现桌面宠物");
  assert.equal(store.snapshot(NOW).presentation.state, "running");

  assert.equal(store.handleCodexHook(hook("PermissionRequest"), NOW), true);
  assert.equal(store.snapshot(NOW).presentation.state, "needs-input");
  assert.equal(store.handleCodexHook(hook("PostToolUse", {
    occurredAt: NOW - 1,
  }), NOW), false);
  assert.equal(store.snapshot(NOW).presentation.state, "needs-input");

  store.handleCodexHook(hook("Stop", { occurredAt: NOW + 1_000 }), NOW + 1_000);
  assert.equal(store.snapshot(NOW + 1_500).presentation.state, "completed");
  assert.equal(store.snapshot(NOW + 6_000).presentation.state, "ready");

  store.handleCodexHook(hook("UserPromptSubmit", {
    occurredAt: NOW + 10_000,
  }), NOW + 10_000);
  assert.equal(
    store.snapshot(NOW + 10_000 + (31 * 60_000)).presentation.state,
    "ready",
  );
});

test("hook approval preserves command whitespace and fails closed when truncated", () => {
  const exact = normalizeCodexHookApproval({
    ...hook("PermissionRequest"),
    requestId: "approval-exact",
    toolName: "Bash",
    detail: "printf 'a  b'\nprintf done",
    detailComplete: true,
  }, { now: NOW });
  assert.equal(exact.detail, "printf 'a  b'\nprintf done");
  assert.equal(exact.detailComplete, true);

  const truncated = normalizeCodexHookApproval({
    ...hook("PermissionRequest"),
    requestId: "approval-truncated",
    toolName: "Bash",
    detail: "界".repeat(2_000),
    detailComplete: true,
  }, { now: NOW });
  assert.ok(Buffer.byteLength(truncated.detail) <= 4_096);
  assert.equal(truncated.detailComplete, false);
});

test("terminal App Server errors override hook-derived state", () => {
  const store = new DeskStore();
  store.handleCodexHook(hook("PermissionRequest"), NOW);
  store.handleNotification("error", {
    threadId: "hook-session-1",
    error: { message: "failed" },
    willRetry: false,
  });
  assert.equal(store.snapshot(NOW).presentation.state, "blocked");
});

test("hook token is generated once with private permissions and corruption fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hook-token-"));
  const tokenPath = path.join(root, "nested", "hook-token");
  const repository = new HookTokenRepository(tokenPath);
  const first = await repository.loadOrCreate();
  const second = await repository.loadOrCreate();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);

  await writeFile(tokenPath, "not-a-token\n");
  await assert.rejects(() => repository.loadOrCreate(), /invalid/);
});
