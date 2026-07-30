import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { DeskStore } from "../src/server/desk-store.js";
import { PetAgent } from "../src/server/pet-agent.js";

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.isMock = false;
    this.calls = [];
    this.nextThread = 1;
    this.client = {
      running: true,
      request: async (method, params) => {
        this.calls.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: `pet-thread-${this.nextThread++}` } };
        }
        if (method === "thread/name/set") return {};
        if (method === "turn/start") {
          const turnId = `turn-${this.calls.length}`;
          queueMicrotask(() => {
            this.emit("notification", "item/completed", {
              threadId: params.threadId,
              turnId,
              item: { type: "agentMessage", text: "明白，我会陪着你。" },
            });
            this.emit("notification", "turn/completed", {
              threadId: params.threadId,
              turn: {
                id: turnId,
                status: "completed",
                items: [{ type: "agentMessage", text: "明白，我会陪着你。" }],
              },
            });
          });
          return { turn: { id: turnId, status: "inProgress" } };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    };
  }
}

test("pet chat runs in an ephemeral read-only Codex thread", async () => {
  const store = new DeskStore();
  const bridge = new FakeBridge();
  const agent = new PetAgent({ bridge, store, cwd: "/workspace" });
  const result = await agent.chat("今天怎么样？");

  assert.equal(result.reply, "明白，我会陪着你。");
  assert.equal(bridge.calls[0].method, "thread/start");
  assert.equal(bridge.calls[0].params.cwd, "/workspace");
  assert.equal(bridge.calls[0].params.approvalPolicy, "never");
  assert.equal(bridge.calls[0].params.sandbox, "read-only");
  assert.equal(bridge.calls[0].params.ephemeral, true);
  assert.match(bridge.calls[0].params.developerInstructions, /不要调用工具/);
  assert.equal(store.snapshot().companion.status, "completed");
  agent.close();
});

test("pet command requires an explicit decision before starting Codex", async () => {
  const store = new DeskStore();
  const bridge = new FakeBridge();
  const agent = new PetAgent({ bridge, store, cwd: "/workspace" });

  const queued = agent.queueCommand("运行测试");
  assert.equal(bridge.calls.length, 0);
  assert.equal(store.snapshot().companion.status, "awaiting-confirmation");

  const accepted = await agent.decideCommand(queued.requestId, "accept");
  assert.equal(accepted.threadId, "pet-thread-1");
  assert.equal(bridge.calls[0].params.sandbox, "workspace-write");
  assert.equal(bridge.calls[0].params.approvalPolicy, "on-request");
  assert.equal(bridge.calls[1].method, "thread/name/set");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot().companion.status, "completed");
  agent.close();
});

test("declining a pet command never starts a Codex thread", async () => {
  const store = new DeskStore();
  const bridge = new FakeBridge();
  const agent = new PetAgent({ bridge, store });
  const queued = agent.queueCommand("删除文件");
  const result = await agent.decideCommand(queued.requestId, "decline");
  assert.equal(result.decision, "decline");
  assert.equal(bridge.calls.length, 0);
  assert.equal(store.snapshot().companion.status, "declined");
  agent.close();
});

test("camera observations use one ephemeral read-only multimodal turn", async () => {
  const store = new DeskStore();
  const bridge = new FakeBridge();
  const agent = new PetAgent({ bridge, store, cwd: "/workspace" });
  const imagePath = path.join(process.cwd(), "test", "camera-frame.jpg");

  const result = await agent.observeImage(imagePath);

  assert.equal(result.reply, "明白，我会陪着你。");
  assert.equal(bridge.calls[0].method, "thread/start");
  assert.equal(bridge.calls[0].params.approvalPolicy, "never");
  assert.equal(bridge.calls[0].params.sandbox, "read-only");
  assert.equal(bridge.calls[0].params.ephemeral, true);
  assert.match(bridge.calls[0].params.developerInstructions, /不猜测身份/);
  assert.deepEqual(bridge.calls[1].params.input[1], {
    type: "localImage",
    path: imagePath,
    detail: "low",
  });
  agent.close();
});

test("pet agent can share a conversation lifecycle with other agents", async () => {
  const store = new DeskStore();
  const bridge = new FakeBridge();
  let closed = false;
  const conversation = {
    requireConnected() {},
    startThread: async (options) => {
      assert.equal(options.serviceName, "codex-desk-pet-chat");
      return "shared-thread";
    },
    runTurn: async () => ({
      threadId: "shared-thread",
      turnId: "shared-turn",
      reply: "共享会话正常。",
    }),
    close: () => {
      closed = true;
    },
  };
  const agent = new PetAgent({ bridge, store, conversation });
  assert.equal((await agent.chat("测试共享层")).reply, "共享会话正常。");
  agent.close();
  assert.equal(closed, false);
});
