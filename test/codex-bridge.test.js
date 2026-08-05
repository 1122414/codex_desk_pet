import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CodexBridge,
  normalizeThreadConversation,
} from "../src/server/codex-bridge.js";
import { DeskStore } from "../src/server/desk-store.js";

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.startCount = 0;
    this.responses = [];
    this.errors = [];
    this.requests = [];
    this.threadList = [];
  }

  async start() {
    this.startCount += 1;
    this.running = true;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/list") return { data: this.threadList };
    if (method === "thread/read") return { thread: { turns: [] } };
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 100 },
          secondary: { usedPercent: 21, windowDurationMins: 10_080, resetsAt: 200 },
        },
        rateLimitsByLimitId: null,
      };
    }
    if (method === "account/usage/read") {
      return {
        summary: { lifetimeTokens: 123_456 },
        dailyUsageBuckets: [],
      };
    }
    if (method === "thread/goal/get") return { goal: null };
    throw new Error(`Unexpected fake request: ${method}`);
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.errors.push({ id, code, message });
  }

  disconnect() {
    this.running = false;
    this.emit("exit", 1, null, { intentional: false });
  }

  async stop() {
    this.running = false;
    this.emit("exit", 0, null, { intentional: true });
  }
}

async function waitFor(predicate, timeoutMs = 250) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

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

test("bridge loads official weekly quota, account usage, and thread goals", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  client.threadList = [{
    id: "thread-goal",
    name: "同步真实状态",
    updatedAt: Date.now() / 1_000,
    status: { type: "notLoaded" },
  }];
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/goal/get") {
      return {
        goal: {
          threadId: params.threadId,
          objective: "完成桌宠",
          status: "active",
          tokenBudget: null,
          tokensUsed: 4321,
          timeUsedSeconds: 20,
          createdAt: 1,
          updatedAt: Date.now() / 1_000,
        },
      };
    }
    return originalRequest(method, params);
  };
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();

  const snapshot = store.snapshot();
  assert.equal(snapshot.quota.available, true);
  assert.equal(snapshot.quota.usedPercent, 21);
  assert.equal(snapshot.quota.resetsAt, 200);
  assert.equal(snapshot.accountTokens.lifetime, 123_456);
  assert.equal(snapshot.tasks[0].state, "running");
  assert.equal(snapshot.tasks[0].tokens, 4321);
  await bridge.stop();
});

test("bridge aggregates live daily tokens from every readable session", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const now = new Date();
  const dateKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  client.threadList = [
    {
      id: "thread-a",
      path: "/sessions/a.jsonl",
      name: "任务 A",
      updatedAt: Date.now() / 1_000,
      status: { type: "notLoaded" },
    },
    {
      id: "thread-b",
      path: "/sessions/b.jsonl",
      name: "任务 B",
      updatedAt: Date.now() / 1_000,
      status: { type: "notLoaded" },
    },
  ];
  const bridge = new CodexBridge({
    store,
    client,
    pollIntervalMs: 0,
    sessionTokenReader: async (sessionPath) => ({
      totalTokens: sessionPath.includes("/a.") ? 10_000 : 20_000,
      observedAt: Date.now(),
      dateKey,
      todayTokens: sessionPath.includes("/a.") ? 1_234 : 5_678,
      todayAvailable: true,
    }),
  });
  await bridge.start();

  const snapshot = store.snapshot();
  assert.equal(snapshot.accountTokens.today, 6_912);
  assert.equal(snapshot.accountTokens.todayAvailable, true);
  assert.deepEqual(
    snapshot.tasks.map((task) => task.tokens).sort((a, b) => a - b),
    [10_000, 20_000],
  );
  await bridge.stop();
});

test("bridge exposes a bounded read-only conversation without reasoning or tool internals", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  client.threadList = [{
    id: "thread-detail",
    name: "斯卡蒂主题",
    cwd: "/workspace/codex-desk",
    gitInfo: { branch: "main" },
    updatedAt: Date.now() / 1_000,
    status: { type: "notLoaded" },
  }];
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/read") {
      return {
        thread: {
          ...client.threadList[0],
          turns: Array.from({ length: 8 }, (_, index) => ({
            id: `turn-${index}`,
            items: [
              {
                id: `user-${index}`,
                type: "userMessage",
                content: [
                  { type: "text", text: `用户消息 ${index} ${"海".repeat(180)}` },
                  { type: "image", url: "file:///private/photo.jpg" },
                ],
              },
              {
                id: `reasoning-${index}`,
                type: "reasoning",
                summary: ["不应出现在设备上"],
              },
              {
                id: `tool-${index}`,
                type: "commandExecution",
                command: "print-secret",
              },
              {
                id: `assistant-${index}`,
                type: "agentMessage",
                text: `助手消息 ${index}`,
              },
            ],
          })),
        },
      };
    }
    return originalRequest(method, params);
  };
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();

  const detail = await bridge.readThreadConversation("thread-detail");
  assert.equal(detail.kind, "project");
  assert.equal(detail.workspace, "codex-desk");
  assert.equal(detail.messages.length, 12);
  assert.deepEqual(new Set(detail.messages.map(({ role }) => role)), new Set(["user", "assistant"]));
  assert.equal(JSON.stringify(detail).includes("print-secret"), false);
  assert.equal(JSON.stringify(detail).includes("不应出现在设备上"), false);
  assert.equal(JSON.stringify(detail).includes("private/photo.jpg"), false);
  assert.equal(Buffer.byteLength(JSON.stringify({ event: "thread.detail", ...detail })) <= 4_200, true);
  assert.equal(detail.truncated, true);
  await assert.rejects(
    () => bridge.readThreadConversation("missing-thread"),
    (error) => error.code === "THREAD_NOT_FOUND",
  );
  await bridge.stop();
});

test("conversation normalizer distinguishes pure chats from projects", () => {
  const detail = normalizeThreadConversation({
    id: "chat-only",
    name: "纯对话",
    turns: [{
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "你好" }] },
        { id: "agent", type: "agentMessage", text: "你好，我是 Skadi。" },
      ],
    }],
  });
  assert.equal(detail.kind, "conversation");
  assert.deepEqual(detail.messages.map(({ role }) => role), ["user", "assistant"]);
});

test("bridge maps current command approval fields and returns the exact wire decision", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();

  client.emit("request", {
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-command",
      turnId: "turn-command",
      itemId: "item-command",
      cwd: "/workspace",
      reason: "运行测试",
      commandActions: [{ type: "unknown", command: "npm test" }],
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
    },
  });

  const approval = store.snapshot().approval;
  assert.equal(approval.command, "npm test");
  assert.equal(approval.networkHost, "registry.npmjs.org");
  assert.equal(approval.safeToApprove, true);
  await bridge.decideApproval(approval.id, "accept");
  assert.deepEqual(client.responses, [{ id: 71, result: { decision: "accept" } }]);
  assert.equal(store.snapshot().approval, null);
  await bridge.stop();
});

test("bridge grants only the requested permission subset and denies with an empty profile", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();
  const requestedPermissions = {
    network: { enabled: true },
    fileSystem: { write: ["/workspace"] },
  };
  client.emit("request", {
    id: 72,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-permissions",
      turnId: "turn-permissions",
      itemId: "item-permissions",
      cwd: "/workspace",
      reason: "下载依赖并写入工作区",
      permissions: requestedPermissions,
      startedAtMs: Date.now(),
    },
  });
  const accepted = store.snapshot().approval;
  assert.equal(accepted.kind, "permission");
  assert.equal(accepted.safeToApprove, true);
  assert.equal(accepted.deviceSafeToApprove, true);
  assert.match(accepted.displayDetail, /网络访问/);
  assert.match(accepted.displayDetail, /写 \/workspace/);
  await bridge.decideApproval(accepted.id, "accept");
  assert.deepEqual(client.responses.at(-1), {
    id: 72,
    result: {
      permissions: requestedPermissions,
      scope: "turn",
    },
  });

  client.emit("request", {
    id: 73,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-permissions",
      turnId: "turn-permissions",
      itemId: "item-permissions-2",
      cwd: "/workspace",
      permissions: { network: { enabled: true } },
      startedAtMs: Date.now(),
    },
  });
  const declined = store.snapshot().approval;
  await bridge.decideApproval(declined.id, "decline");
  assert.deepEqual(client.responses.at(-1), {
    id: 73,
    result: { permissions: {}, scope: "turn" },
  });
  await bridge.stop();
});

test("device approval is disabled when its compact display cannot show every permission", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();
  client.emit("request", {
    id: 74,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-long-approval",
      turnId: "turn-long-approval",
      itemId: "item-long-approval",
      command: "npm run release",
      additionalPermissions: {
        fileSystem: {
          write: [
            `/workspace/${"very-long-directory/".repeat(8)}artifact`,
          ],
        },
      },
    },
  });
  const approval = store.snapshot().approval;
  assert.equal(approval.safeToApprove, true);
  assert.equal(approval.deviceSafeToApprove, false);
  assert.match(approval.displayDetail, /npm run release/);
  assert.match(approval.displayDetail, /artifact/);
  await bridge.decideApproval(approval.id, "decline");
  await bridge.stop();
});

test("bridge keeps legacy approval responses compatible", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();

  client.emit("request", {
    id: "legacy-4",
    method: "execCommandApproval",
    params: {
      conversationId: "legacy-thread",
      callId: "legacy-call",
      command: ["npm", "run", "check"],
      cwd: "/workspace",
    },
  });
  const approval = store.snapshot().approval;
  assert.equal(approval.command, "npm run check");
  await bridge.decideApproval(approval.id, "decline");
  assert.deepEqual(client.responses, [{ id: "legacy-4", result: { decision: "denied" } }]);
  await bridge.stop();
});

test("bridge clears requests resolved elsewhere and tracks current user-input requests", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();

  client.emit("request", {
    id: 88,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-input",
      turnId: "turn-input",
      itemId: "item-input",
      questions: [{ id: "choice", question: "选择方案" }],
    },
  });
  assert.equal(store.snapshot().presentation.state, "needs-input");
  assert.equal(store.snapshot().userInput.respondOnComputer, true);

  client.emit("notification", "serverRequest/resolved", { requestId: 88 });
  assert.equal(store.snapshot().userInput, null);
  await bridge.stop();
});

test("bridge maps review and terminal error notifications into pet states", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  client.threadList = [{
    id: "thread-events",
    name: "验证事件",
    updatedAt: Date.now() / 1_000,
    status: { type: "active", activeFlags: [] },
  }];
  const bridge = new CodexBridge({ store, client, pollIntervalMs: 0 });
  await bridge.start();

  client.emit("notification", "item/autoApprovalReview/started", {
    threadId: "thread-events",
    turnId: "turn-events",
  });
  assert.equal(store.snapshot().presentation.state, "reviewing");

  client.emit("notification", "item/autoApprovalReview/completed", {
    threadId: "thread-events",
    turnId: "turn-events",
  });
  assert.equal(store.snapshot().presentation.state, "running");

  client.emit("notification", "error", {
    threadId: "thread-events",
    turnId: "turn-events",
    error: { message: "sandbox failed" },
    willRetry: false,
  });
  assert.equal(store.snapshot().presentation.state, "blocked");
  assert.equal(store.snapshot().presentation.animation, "failed");
  await bridge.stop();
});

test("bridge reconnects after disconnect and expires stale approvals", async () => {
  const store = new DeskStore();
  const client = new FakeAppServerClient();
  const bridge = new CodexBridge({
    store,
    client,
    pollIntervalMs: 0,
    reconnectDelaysMs: [1],
    reconnectJitterRatio: 0,
  });
  await bridge.start();
  client.emit("request", {
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-reconnect",
      itemId: "item-reconnect",
      command: "npm test",
    },
  });
  const staleApprovalId = store.snapshot().approval.id;

  client.disconnect();
  assert.equal(store.snapshot().connection.status, "reconnecting");
  assert.equal(store.snapshot().approval, null);
  await assert.rejects(() => bridge.decideApproval(staleApprovalId, "accept"), /no longer pending/);

  await waitFor(() => client.startCount === 2 && store.snapshot().connection.status === "connected");
  await bridge.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(client.startCount, 2);
  assert.equal(store.snapshot().connection.status, "disconnected");
});
