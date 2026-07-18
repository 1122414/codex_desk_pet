import test from "node:test";
import assert from "node:assert/strict";
import { DeskStore } from "../src/server/desk-store.js";

test("desk store reduces Codex notifications into a device snapshot", () => {
  const store = new DeskStore();
  store.replaceThreads([{
    id: "thread-1",
    name: "Build the bridge",
    updatedAt: 100,
    status: { type: "idle" },
    turns: [],
  }]);
  store.handleNotification("thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active", activeFlags: [] },
  });
  store.handleNotification("thread/tokenUsage/updated", {
    threadId: "thread-1",
    tokenUsage: { total: { totalTokens: 50_001 } },
  });
  const snapshot = store.snapshot();
  assert.equal(snapshot.task.title, "Build the bridge");
  assert.equal(snapshot.presentation.animation, "running");
  assert.equal(snapshot.tokens.level.level, 2);
});

test("approval snapshots omit internal JSON-RPC correlation ids", () => {
  const store = new DeskStore();
  store.setPreviewAnimation("jumping");
  store.addApproval({
    id: "public-approval",
    rpcId: 42,
    rpcMethod: "item/commandExecution/requestApproval",
    threadId: "thread-approval",
    title: "Approve",
    kind: "command",
    command: "npm test",
  });
  const snapshot = store.snapshot();
  assert.equal(snapshot.presentation.animation, "waiting");
  assert.equal(snapshot.presentation.previewing, false);
  assert.equal(snapshot.approval.id, "public-approval");
  assert.equal(Object.hasOwn(snapshot.approval, "rpcId"), false);
  store.resolveApproval("public-approval", "decline");
  assert.equal(store.snapshot().approval, null);
});

test("desk store clears all request state after a transport loss", () => {
  const store = new DeskStore();
  store.addApproval({
    id: "approval-a",
    rpcId: 1,
    threadId: "thread-a",
    title: "Approve",
    kind: "command",
  });
  store.setPendingUserInput({
    id: "input-a",
    rpcId: 2,
    threadId: "thread-a",
    questions: [],
  });

  const cleared = store.clearApprovals();
  assert.equal(cleared[0].decision, "connection-lost");
  assert.equal(store.clearPendingUserInput(), true);
  assert.equal(store.snapshot().approval, null);
  assert.equal(store.snapshot().userInput, null);
  assert.equal(store.snapshot().presentation.state, "ready");
});
