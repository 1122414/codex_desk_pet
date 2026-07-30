import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CareAgent, parseCareResponse } from "../src/server/care-agent.js";
import { CareMemoryRepository } from "../src/server/care-memory-repository.js";
import { DeskStore } from "../src/server/desk-store.js";
import { SettingsRepository } from "../src/server/settings-repository.js";

function jsonReply(value) {
  return JSON.stringify({
    say: "",
    continueListening: false,
    nextObservationMinutes: 10,
    action: null,
    memory: null,
    ...value,
  });
}

class FakeConversation {
  constructor(replies) {
    this.replies = [...replies];
    this.starts = [];
    this.turns = [];
  }

  async startThread(options) {
    this.starts.push(options);
    return `care-thread-${this.starts.length}`;
  }

  async runTurn(threadId, input) {
    this.turns.push({ threadId, input });
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return { threadId, turnId: `turn-${this.turns.length}`, reply };
  }
}

async function fixture(replies, { actionService = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-care-agent-"));
  const now = 1_800_000_000_000;
  const settings = new SettingsRepository(path.join(root, "settings.json"));
  const memory = new CareMemoryRepository({
    directoryPath: root,
    now: () => now,
  });
  const store = new DeskStore();
  const conversation = new FakeConversation(replies);
  const agent = new CareAgent({
    bridge: { isMock: false },
    store,
    settings,
    memory,
    conversation,
    actionService,
    cwd: "/workspace",
    now: () => now,
  });
  return { agent, conversation, memory, store, now };
}

test("CareAgent keeps camera and text turns in one read-only conversation", async () => {
  const first = jsonReply({
    memory: { summary: "用户正在桌前工作", importance: 1 },
  });
  const second = jsonReply({
    say: "你还在处理刚才那个问题吗？",
    continueListening: true,
    nextObservationMinutes: 6,
    memory: { summary: "用户仍在处理刚才的问题", importance: 2 },
  });
  const { agent, conversation, memory, store, now } = await fixture([first, second]);
  const imagePath = path.join(process.cwd(), "test", "care-camera.jpg");

  const observation = await agent.observeImage(imagePath, { deviceId: "tab5-1" });
  const response = await agent.respondToText("还没解决，再陪我想想。", {
    deviceId: "tab5-1",
  });

  assert.equal(observation.say, "");
  assert.equal(response.say, "你还在处理刚才那个问题吗？");
  assert.equal(conversation.starts.length, 1);
  assert.equal(conversation.starts[0].approvalPolicy, "never");
  assert.equal(conversation.starts[0].sandbox, "read-only");
  assert.equal(conversation.starts[0].ephemeral, true);
  assert.match(conversation.starts[0].developerInstructions, /不要调用工具/);
  assert.equal(conversation.turns[0].threadId, "care-thread-1");
  assert.equal(conversation.turns[1].threadId, "care-thread-1");
  assert.deepEqual(conversation.turns[0].input[1], {
    type: "localImage",
    path: imagePath,
    detail: "low",
  });
  assert.match(conversation.turns[1].input[0].text, /还没解决/);
  assert.match(conversation.turns[1].input[0].text, /用户正在桌前工作/);
  assert.equal(memory.snapshot().profile.summary, "用户仍在处理刚才的问题");
  assert.equal(memory.snapshot().eventCount, 3);
  assert.equal(store.snapshot().care.status, "speaking");
  assert.equal(store.snapshot().care.nextObservationAt, now + 6 * 60_000);
  agent.close();
});

test("CareAgent safely degrades invalid model JSON without forwarding actions", async () => {
  const invalidAction = jsonReply({
    say: "执行任意命令",
    continueListening: true,
    action: {
      name: "run_shell",
      arguments: { command: "rm -rf /" },
    },
  });
  const { agent, store } = await fixture([invalidAction]);
  const result = await agent.respondToText("帮我处理一下");

  assert.equal(result.say, "我刚才走神了，你可以再说一遍吗？");
  assert.equal(result.action, null);
  assert.equal(result.continueListening, true);
  assert.match(store.snapshot().care.error, /安全降级/);
  agent.close();
});

test("CareAgent recreates a failed thread and resumes from persisted memory", async () => {
  const { agent, conversation, memory } = await fixture([
    new Error("连接已断开"),
    jsonReply({ say: "我们接着聊。", continueListening: true }),
  ]);
  await memory.load();
  await memory.saveProfile({ summary: "上次聊到构建失败" });

  await assert.rejects(() => agent.respondToText("你还记得吗？"), /连接已断开/);
  const result = await agent.respondToText("继续吧");

  assert.equal(result.say, "我们接着聊。");
  assert.equal(conversation.starts.length, 2);
  assert.equal(conversation.turns[0].threadId, "care-thread-1");
  assert.equal(conversation.turns[1].threadId, "care-thread-2");
  assert.match(conversation.turns[1].input[0].text, /上次聊到构建失败/);
  agent.close();
});

test("care response validation enforces ranges, exact fields, and action arguments", () => {
  const valid = parseCareResponse(jsonReply({
    say: "我帮你调暗一点。",
    action: {
      name: "set_tab5_brightness",
      arguments: { value: 35, durationSeconds: 600 },
    },
  }));
  assert.equal(valid.action.arguments.value, 35);

  assert.throws(() => parseCareResponse(jsonReply({
    nextObservationMinutes: 0,
  })), /间隔/);
  assert.throws(() => parseCareResponse(jsonReply({
    action: {
      name: "set_tab5_brightness",
      arguments: { value: 101 },
    },
  })), /超出范围/);
  assert.throws(() => parseCareResponse(JSON.stringify({
    say: "",
    continueListening: false,
    nextObservationMinutes: 10,
    action: null,
    memory: null,
    extra: true,
  })), /字段/);
  assert.throws(() => parseCareResponse("```json\n{}\n```"), /有效 JSON/);
});

test("CareAgent executes a whitelisted action and feeds the result back to the same thread", async () => {
  const actions = [];
  const actionService = {
    execute: async (action, context) => {
      actions.push({ action, context });
      return {
        action: action.name,
        ok: true,
        message: "已打开网易云音乐",
        presetId: action.arguments.presetId,
        executedAt: 1_800_000_000_000,
      };
    },
  };
  const { agent, conversation, memory } = await fixture([
    jsonReply({
      say: "我来打开。",
      continueListening: true,
      action: {
        name: "open_app",
        arguments: { presetId: "netease-music" },
      },
    }),
    jsonReply({
      say: "网易云音乐已经打开了，还想听点什么？",
      continueListening: true,
      nextObservationMinutes: 15,
    }),
  ], { actionService });

  const result = await agent.respondToText("帮我打开网易云", {
    deviceId: "tab5-1",
  });
  assert.equal(result.say, "网易云音乐已经打开了，还想听点什么？");
  assert.equal(result.action, null);
  assert.equal(result.actionResult.ok, true);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].threadId, "care-thread-1");
  assert.equal(conversation.turns[1].threadId, "care-thread-1");
  assert.match(conversation.turns[1].input[0].text, /已打开网易云音乐/);
  assert.equal(actions[0].context.idempotencyKey, "care-thread-1:turn-1");
  assert.equal(actions[0].context.deviceId, "tab5-1");
  assert.deepEqual(
    memory.listEvents().slice(0, 2).map(({ type }) => type),
    ["action.requested", "action.completed"],
  );
  agent.close();
});

test("a failed care action remains in the conversation instead of aborting it", async () => {
  const actionService = {
    execute: async (action) => ({
      action: action.name,
      ok: false,
      message: "应用预设不存在或未获允许",
      executedAt: 1_800_000_000_000,
    }),
  };
  const { agent, conversation } = await fixture([
    jsonReply({
      action: {
        name: "open_app",
        arguments: { presetId: "missing-app" },
      },
    }),
    jsonReply({
      say: "这个应用不在允许列表里，我没有打开它。",
      continueListening: true,
    }),
  ], { actionService });

  const result = await agent.respondToText("打开那个应用");
  assert.equal(result.actionResult.ok, false);
  assert.match(result.say, /允许列表/);
  assert.equal(conversation.turns.length, 2);
  assert.match(conversation.turns[1].input[0].text, /未获允许/);
  agent.close();
});
