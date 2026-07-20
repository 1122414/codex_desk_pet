import test from "node:test";
import assert from "node:assert/strict";
import { DeskStore } from "../src/server/desk-store.js";
import { HookApprovalBroker } from "../src/server/hook-approval-broker.js";

const NOW = 2_000_000_000_000;

function permission(overrides = {}) {
  return {
    version: 1,
    event: "PermissionRequest",
    requestId: "hook-request-1",
    sessionId: "hook-session-1",
    turnId: "hook-turn-1",
    toolName: "Bash",
    detail: "npm test",
    detailComplete: true,
    reason: "运行测试",
    occurredAt: NOW,
    ...overrides,
  };
}

test("hook approval broker returns a device decision to the waiting hook", async () => {
  const store = new DeskStore();
  const broker = new HookApprovalBroker({ store });
  const waiting = broker.request(permission(), { now: NOW });
  const approval = store.snapshot(NOW).approval;
  assert.equal(approval.source, "codex-hook");
  assert.equal(approval.displayDetail, "npm test");
  assert.equal(approval.deviceSafeToApprove, true);
  assert.equal(store.snapshot(NOW).presentation.state, "needs-input");

  const resolved = broker.decide(approval.id, "accept");
  assert.equal(resolved.decision, "accept");
  assert.equal(await waiting, "accept");
  assert.equal(store.snapshot(NOW).approval, null);
  assert.equal(store.snapshot().presentation.state, "running");
});

test("incomplete hook details can be declined but never accepted", async () => {
  const store = new DeskStore();
  const broker = new HookApprovalBroker({ store });
  const waiting = broker.request(permission({
    requestId: "hook-request-incomplete",
    detail: "x".repeat(4_096),
    detailComplete: false,
  }), { now: NOW });
  const approval = store.snapshot(NOW).approval;
  assert.equal(approval.safeToApprove, false);
  assert.equal(approval.deviceSafeToApprove, false);
  assert.throws(() => broker.decide(approval.id, "accept"), /incomplete/);
  broker.decide(approval.id, "decline");
  assert.equal(await waiting, "decline");
});

test("an aborted hook request clears the pending approval without a decision", async () => {
  const store = new DeskStore();
  const broker = new HookApprovalBroker({ store });
  const controller = new AbortController();
  const waiting = broker.request(permission({
    requestId: "hook-request-abort",
  }), { now: NOW, signal: controller.signal });
  assert.ok(store.snapshot(NOW).approval);
  controller.abort();
  assert.equal(await waiting, null);
  assert.equal(store.snapshot(NOW).approval, null);
});
