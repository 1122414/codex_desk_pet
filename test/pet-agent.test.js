import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { DeskStore } from "../src/server/desk-store.js";
import { PetAgent } from "../src/server/pet-agent.js";

class FakeBridge extends EventEmitter {
  constructor({ autoComplete = true } = {}) {
    super();
    this.isMock = false;
    this.calls = [];
    this.nextThread = 1;
    this.autoComplete = autoComplete;
    this.pendingCompletions = [];
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
          const complete = () => {
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
          };
          if (this.autoComplete) queueMicrotask(complete);
          else this.pendingCompletions.push(complete);
          return { turn: { id: turnId, status: "inProgress" } };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    };
  }

  completeNext() {
    this.pendingCompletions.shift()?.();
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

test("Skadi chat addresses the user as 博士 and starts a new persona thread", async () => {
  const store = new DeskStore({ selectedPetId: "chibi-skadi-v2" });
  const bridge = new FakeBridge();
  const agent = new PetAgent({ bridge, store, cwd: "/workspace" });

  await agent.chat("你好");
  assert.match(bridge.calls[0].params.developerInstructions, /称呼用户为“博士”/);
  assert.match(bridge.calls[0].params.developerInstructions, /不要称呼用户为“指挥官”/);

  store.setSelectedPet("codex-core");
  await agent.chat("切换以后呢？");
  const threadStarts = bridge.calls.filter(({ method }) => method === "thread/start");
  assert.equal(threadStarts.length, 2);
  assert.doesNotMatch(threadStarts[1].params.developerInstructions, /称呼用户为“博士”/);
  agent.close();
});

test("pet chat rejects overlap instead of losing the first reply", async () => {
  const store = new DeskStore();
  const bridge = new FakeBridge({ autoComplete: false });
  const agent = new PetAgent({ bridge, store, cwd: "/workspace" });
  const first = agent.chat("第一句话");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(agent.chat("第二句话"), /正在回复上一条消息/);
  bridge.completeNext();
  assert.equal((await first).reply, "明白，我会陪着你。");
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
