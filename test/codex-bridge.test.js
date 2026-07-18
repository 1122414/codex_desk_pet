import test from "node:test";
import assert from "node:assert/strict";
import { CodexBridge } from "../src/server/codex-bridge.js";
import { DeskStore } from "../src/server/desk-store.js";

test("mock bridge can exercise a safely correlated approval flow", async () => {
  const store = new DeskStore();
  const bridge = new CodexBridge({ store, mode: "mock" });
  await bridge.start();
  const approval = bridge.createMockApproval();
  assert.equal(store.snapshot().approval.id, approval.id);
  await bridge.decideApproval(approval.id, "accept");
  assert.equal(store.snapshot().approval, null);
  await assert.rejects(() => bridge.decideApproval(approval.id, "accept"), /no longer pending/);
});

