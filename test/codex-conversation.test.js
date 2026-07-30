import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexConversation } from "../src/server/codex-conversation.js";

class FakeBridge extends EventEmitter {
  constructor({ autoReply = "你好" } = {}) {
    super();
    this.calls = [];
    this.autoReply = autoReply;
    this.client = {
      running: true,
      request: async (method, params) => {
        this.calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "conversation-thread-1" } };
        if (method === "turn/start") {
          const turnId = `turn-${this.calls.length}`;
          if (this.autoReply !== null) {
            queueMicrotask(() => {
              this.emit("notification", "item/agentMessage/delta", {
                threadId: params.threadId,
                turnId,
                delta: "流式",
              });
              this.emit("notification", "turn/completed", {
                threadId: params.threadId,
                turn: {
                  id: turnId,
                  status: "completed",
                  items: [{ type: "agentMessage", text: this.autoReply }],
                },
              });
            });
          }
          return { turn: { id: turnId, status: "inProgress" } };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    };
  }
}

test("CodexConversation starts a tool-free thread and aggregates its completed reply", async () => {
  const bridge = new FakeBridge({ autoReply: "完成回复" });
  const conversation = new CodexConversation({
    bridge,
    cwd: "/workspace",
    timeoutMs: 2_000,
  });
  const threadId = await conversation.startThread({
    developerInstructions: "只对话，不使用工具。",
    serviceName: "test-conversation",
  });
  const result = await conversation.runTurn(threadId, "你好");

  assert.equal(result.reply, "完成回复");
  assert.equal(bridge.calls[0].params.cwd, "/workspace");
  assert.equal(bridge.calls[0].params.approvalPolicy, "never");
  assert.equal(bridge.calls[0].params.sandbox, "read-only");
  assert.deepEqual(bridge.calls[0].params.dynamicTools, []);
  assert.deepEqual(bridge.calls[1].params.input, [{
    type: "text",
    text: "你好",
    text_elements: [],
  }]);
  conversation.close();
});

test("CodexConversation rejects overlapping turns on one thread", async () => {
  const bridge = new FakeBridge({ autoReply: null });
  const conversation = new CodexConversation({ bridge, timeoutMs: 2_000 });
  const threadId = await conversation.startThread({
    developerInstructions: "测试",
    serviceName: "test-overlap",
  });
  const first = conversation.runTurn(threadId, "第一轮");
  await Promise.resolve();
  await assert.rejects(
    () => conversation.runTurn(threadId, "第二轮"),
    /不能同时运行/,
  );
  bridge.emit("notification", "turn/completed", {
    threadId,
    turn: {
      id: "turn-2",
      status: "completed",
      items: [{ type: "agentMessage", text: "第一轮结束" }],
    },
  });
  assert.equal((await first).reply, "第一轮结束");
  conversation.close();
});

test("CodexConversation surfaces terminal errors and rejects pending turns on close", async () => {
  const bridge = new FakeBridge({ autoReply: null });
  const conversation = new CodexConversation({ bridge, timeoutMs: 2_000 });
  const threadId = await conversation.startThread({
    developerInstructions: "测试",
    serviceName: "test-errors",
  });
  const failed = conversation.runTurn(threadId, "会失败");
  await Promise.resolve();
  bridge.emit("notification", "error", {
    threadId,
    willRetry: false,
    error: { message: "上游失败" },
  });
  await assert.rejects(() => failed, /上游失败/);

  const pending = conversation.runTurn(threadId, "等待关闭");
  await Promise.resolve();
  conversation.close("测试关闭");
  await assert.rejects(() => pending, /测试关闭/);
});
