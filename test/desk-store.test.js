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

test("desk store exposes a bounded multi-task snapshot with plan progress and clock", () => {
  const store = new DeskStore();
  store.replaceThreads(Array.from({ length: 15 }, (_, index) => ({
    id: `thread-${index}`,
    name: `任务 ${index}`,
    updatedAt: 1_000 - index,
    status: { type: index < 2 ? "active" : "idle", activeFlags: [] },
    turns: [],
  })));
  store.handleNotification("turn/plan/updated", {
    threadId: "thread-0",
    turnId: "turn-0",
    plan: [
      { step: "准备", status: "completed" },
      { step: "实现", status: "inProgress" },
      { step: "验证", status: "pending" },
    ],
  });
  const now = 1_800_000_000_000;
  const snapshot = store.snapshot(now);

  assert.equal(snapshot.tasks.length, 12);
  assert.equal(snapshot.taskCounts.total, 15);
  assert.equal(snapshot.taskCounts.active, 2);
  assert.deepEqual(snapshot.tasks[0].progress, {
    known: true,
    completed: 1,
    total: 3,
    percent: 33,
  });
  assert.equal(snapshot.clock.unixMs, now);
  assert.ok(Number.isInteger(snapshot.clock.utcOffsetMinutes));
});

test("desk store marks git workspaces as projects and other threads as conversations", () => {
  const store = new DeskStore();
  store.replaceThreads([
    {
      id: "project",
      name: "项目任务",
      cwd: "/workspace/codex-desk",
      gitInfo: { branch: "main" },
      updatedAt: 200,
      status: { type: "idle" },
    },
    {
      id: "conversation",
      name: "纯对话",
      updatedAt: 100,
      status: { type: "idle" },
    },
  ]);

  const snapshot = store.snapshot(300_000);
  assert.deepEqual(
    snapshot.tasks.map(({ id, kind, workspace }) => ({ id, kind, workspace })),
    [
      { id: "project", kind: "project", workspace: "codex-desk" },
      { id: "conversation", kind: "conversation", workspace: "" },
    ],
  );
  assert.equal(snapshot.capabilities.threadConversation, true);
});

test("desk store selects the seven-day Codex rate-limit window and today's usage", () => {
  const store = new DeskStore();
  const now = new Date(2026, 6, 27, 12).getTime();
  store.setRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitName: "Codex",
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 10 },
        secondary: { usedPercent: 37.4, windowDurationMins: 10_080, resetsAt: 20 },
      },
    },
  });
  store.setAccountUsage({
    summary: { lifetimeTokens: 8_765_432 },
    dailyUsageBuckets: [
      { startDate: "2026-07-27", tokens: 12_345 },
      { startDate: "2026-07-26", tokens: 99_999 },
    ],
  });
  store.setLocalTodayTokens({
    dateKey: "2026-07-27",
    tokens: 777,
    available: true,
  });
  const snapshot = store.snapshot(now);
  assert.deepEqual(snapshot.quota, {
    available: true,
    usedPercent: 37,
    resetsAt: 20,
    windowMinutes: 10_080,
    name: "Codex",
  });
  assert.equal(snapshot.accountTokens.lifetime, 8_765_432);
  assert.equal(snapshot.accountTokens.today, 12_345);
  assert.equal(snapshot.accountTokens.todayAvailable, true);
});

test("desk store uses live local token usage while the official day bucket is pending", () => {
  const store = new DeskStore();
  const now = new Date(2026, 6, 27, 12).getTime();
  store.setAccountUsage({
    summary: { lifetimeTokens: 100 },
    dailyUsageBuckets: [{ startDate: "2026-07-26", tokens: 50 }],
  });
  store.setLocalTodayTokens({
    dateKey: "2026-07-27",
    tokens: 4_321,
    available: true,
  });
  const revision = store.revision;
  store.setLocalTodayTokens({
    dateKey: "2026-07-27",
    tokens: 4_321,
    available: true,
  });

  const snapshot = store.snapshot(now);
  assert.equal(store.revision, revision);
  assert.equal(snapshot.accountTokens.today, 4_321);
  assert.equal(snapshot.accountTokens.todayAvailable, true);
});

test("desk store does not count blocked goals as currently running or invent today's usage", () => {
  const store = new DeskStore();
  store.replaceThreads([
    {
      id: "running",
      name: "正在执行",
      updatedAt: 200,
      status: { type: "active", activeFlags: [] },
      turns: [],
    },
    {
      id: "blocked",
      name: "已经阻塞",
      updatedAt: 100,
      status: { type: "idle" },
      goal: { status: "blocked" },
      turns: [],
    },
  ]);
  store.setAccountUsage({
    summary: { lifetimeTokens: 100 },
    dailyUsageBuckets: [{ startDate: "2026-07-26", tokens: 50 }],
  });

  const snapshot = store.snapshot(new Date(2026, 6, 27, 12).getTime());
  assert.equal(snapshot.taskCounts.active, 1);
  assert.equal(snapshot.accountTokens.today, 0);
  assert.equal(snapshot.accountTokens.todayAvailable, false);
});

test("passive goal refresh preserves task recency and supplies current token total", () => {
  const store = new DeskStore();
  store.replaceThreads([
    {
      id: "newer",
      name: "最新任务",
      updatedAt: 200,
      status: { type: "idle" },
      turns: [],
    },
    {
      id: "older",
      name: "较早任务",
      updatedAt: 100,
      status: { type: "idle" },
      turns: [],
    },
  ]);
  store.patchThread(
    "older",
    { goal: { status: "complete", tokensUsed: 12_345 } },
    { touchActivity: false },
  );
  store.patchThread(
    "newer",
    { goal: { status: "active", tokensUsed: 54_321 } },
    { touchActivity: false },
  );

  const snapshot = store.snapshot(300_000);
  assert.deepEqual(snapshot.tasks.map(({ id }) => id), ["newer", "older"]);
  assert.equal(snapshot.tokens.total, 54_321);
  assert.equal(snapshot.tasks[0].tokens, 54_321);
});

test("passive token refresh does not reorder the task list", () => {
  const store = new DeskStore();
  store.replaceThreads([
    {
      id: "newer",
      name: "最新任务",
      updatedAt: 200,
      status: { type: "idle" },
      turns: [],
    },
    {
      id: "older",
      name: "较早任务",
      updatedAt: 100,
      status: { type: "idle" },
      turns: [],
    },
  ]);
  store.handleNotification("thread/tokenUsage/updated", {
    threadId: "older",
    tokenUsage: { total: { totalTokens: 99_999 } },
  });

  const snapshot = store.snapshot(300_000);
  assert.deepEqual(snapshot.tasks.map(({ id }) => id), ["newer", "older"]);
  assert.equal(snapshot.tasks[1].tokens, 99_999);
});

test("desk store exposes only a bounded care summary and validates state transitions", () => {
  const store = new DeskStore({ care: { enabled: false } });
  store.setCare({
    status: "listening",
    conversationId: "care-thread-1",
    summary: "状".repeat(1_000),
    error: "错".repeat(1_000),
    nextObservationAt: 123_456,
  });
  store.setCareMemory({
    profile: {
      summary: "正在讨论 Bug",
      recentConversation: {
        threadId: "care-thread-2",
        updatedAt: 120_000,
      },
      preferences: Array.from({ length: 100 }, (_, index) => `偏好 ${index}`),
    },
    recentEvent: {
      id: "event-1",
      type: "conversation.user_reply",
      occurredAt: 120_000,
      summary: "回".repeat(1_000),
      data: { privateTranscript: "不应进入快照" },
    },
  });

  const care = store.snapshot().care;
  assert.equal(care.enabled, false);
  assert.equal(care.status, "listening");
  assert.equal(care.conversationId, "care-thread-2");
  assert.equal(care.summary, "正在讨论 Bug");
  assert.equal(care.recentEvent.summary.length, 320);
  assert.equal(Object.hasOwn(care.recentEvent, "data"), false);
  assert.equal(JSON.stringify(care).includes("privateTranscript"), false);
  assert.throws(() => store.setCare({ status: "unknown" }), /Care status/);
});
