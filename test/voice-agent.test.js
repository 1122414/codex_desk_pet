import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DeskStore } from "../src/server/desk-store.js";
import { VoiceAgent } from "../src/server/voice-agent.js";

function createFixture({
  accountType = "apiKey",
  realtimeStartNotification = "started",
  localTranscript = "本地语音识别成功",
  localReadyError = null,
} = {}) {
  const bridge = new EventEmitter();
  const requests = [];
  bridge.client = {
    running: true,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "account/read") {
        return { account: { type: accountType }, requiresOpenaiAuth: true };
      }
      if (method === "thread/start") return { thread: { id: "voice-thread-1" } };
      if (method === "thread/realtime/start") {
        queueMicrotask(() => {
          bridge.emit(
            "notification",
            `thread/realtime/${realtimeStartNotification}`,
            realtimeStartNotification === "started"
              ? { threadId: "voice-thread-1", version: params.version }
              : { threadId: "voice-thread-1", message: "实时语音启动被拒绝" },
          );
        });
      }
      return {};
    },
  };
  const chatCalls = [];
  const commandCalls = [];
  const petAgent = {
    chat: async (text) => {
      chatCalls.push(text);
      return { reply: `收到：${text}` };
    },
    queueCommand: (text) => {
      commandCalls.push(text);
      return { requestId: "voice-command-1" };
    },
  };
  const events = [];
  const localAudio = [];
  const localSpeech = {
    assertReady: async () => {
      if (localReadyError) throw new Error(localReadyError);
      return { ready: true };
    },
    transcribe: async (audio, { signal }) => {
      assert.equal(signal.aborted, false);
      localAudio.push(Buffer.from(audio));
      return localTranscript;
    },
  };
  const session = {
    ready: true,
    deviceId: "tab5-voice-1",
    transport: { kind: "usb" },
    sendEvent: (event) => events.push(event),
  };
  const store = new DeskStore();
  const agent = new VoiceAgent({
    bridge,
    store,
    petAgent,
    transcriptSettleMs: 1,
    closedSettleMs: 1,
    realtimeStartTimeoutMs: 50,
    localSpeech,
  });
  return {
    agent,
    bridge,
    requests,
    chatCalls,
    commandCalls,
    events,
    localAudio,
    session,
    store,
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

test("voice chat streams PCM into Codex Realtime and returns a bounded reply", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());

  assert.deepEqual(
    await fixture.agent.start(fixture.session, { mode: "chat" }),
    { accepted: true, mode: "chat", recognition: "realtime" },
  );
  assert.equal(fixture.store.snapshot().voice.status, "listening");
  assert.equal(
    fixture.requests.find(({ method }) => method === "thread/start").params.sandbox,
    "read-only",
  );
  assert.equal(
    fixture.requests.find(({ method }) => method === "thread/realtime/start").params.version,
    "v2",
  );

  const samples = Buffer.alloc(640 * 2).toString("base64");
  assert.equal(fixture.agent.acceptAudio(fixture.session, {
    event: "voice.audio",
    data: samples,
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: 640,
  }), true);
  const stopPromise = fixture.agent.stop(fixture.session.deviceId);
  await stopPromise;
  fixture.bridge.emit("notification", "thread/realtime/transcript/done", {
    threadId: "voice-thread-1",
    role: "user",
    text: "今天进展怎么样",
  });
  fixture.bridge.emit("notification", "thread/realtime/closed", {
    threadId: "voice-thread-1",
  });
  await settle();

  assert.equal(
    fixture.requests.filter(({ method }) => method === "thread/realtime/appendAudio").length,
    1,
  );
  assert.deepEqual(fixture.chatCalls, ["今天进展怎么样"]);
  assert.deepEqual(fixture.events, [{
    event: "voice.reply",
    ok: true,
    text: "收到：今天进展怎么样",
  }]);
  assert.equal(fixture.store.snapshot().voice.status, "completed");
});

test("voice start waits for the realtime started notification and surfaces async errors", async (t) => {
  const fixture = createFixture({ realtimeStartNotification: "error" });
  t.after(() => fixture.agent.close());

  await assert.rejects(
    fixture.agent.start(fixture.session, { mode: "chat" }),
    /实时语音启动被拒绝/,
  );
  assert.equal(fixture.store.snapshot().voice.status, "failed");
  assert.deepEqual(fixture.events, [{
    event: "voice.reply",
    ok: false,
    text: "实时语音启动被拒绝",
  }]);
});

test("ChatGPT login uses local speech recognition without an API key", async (t) => {
  const fixture = createFixture({
    accountType: "chatgpt",
    localTranscript: "今天进展怎么样",
  });
  t.after(() => fixture.agent.close());

  assert.deepEqual(
    await fixture.agent.start(fixture.session, { mode: "chat" }),
    { accepted: true, mode: "chat", recognition: "local" },
  );
  assert.equal(
    fixture.requests.some(({ method }) => method === "thread/start"),
    false,
  );
  const samples = Buffer.alloc(640 * 2, 7);
  assert.equal(fixture.agent.acceptAudio(fixture.session, {
    event: "voice.audio",
    data: samples.toString("base64"),
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: 640,
  }), true);
  await fixture.agent.stop(fixture.session.deviceId);
  await settle();

  assert.equal(fixture.localAudio.length, 1);
  assert.deepEqual(fixture.localAudio[0], samples);
  assert.deepEqual(fixture.chatCalls, ["今天进展怎么样"]);
  assert.deepEqual(fixture.events, [{
    event: "voice.reply",
    ok: true,
    text: "收到：今天进展怎么样",
  }]);
  assert.equal(fixture.store.snapshot().voice.status, "completed");
});

test("ChatGPT voice reports a clear local setup error", async (t) => {
  const fixture = createFixture({
    accountType: "chatgpt",
    localReadyError: "未找到本地语音模型；请先运行 npm run setup:local-voice",
  });
  t.after(() => fixture.agent.close());

  await assert.rejects(
    fixture.agent.start(fixture.session, { mode: "chat" }),
    /setup:local-voice/,
  );
  assert.equal(fixture.store.snapshot().voice.status, "failed");
  assert.match(fixture.events[0].text, /setup:local-voice/);
});

test("voice command is queued for explicit confirmation instead of executing", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());
  await fixture.agent.start(fixture.session, { mode: "command" });
  fixture.bridge.emit("notification", "thread/realtime/transcript/done", {
    threadId: "voice-thread-1",
    role: "user",
    text: "让 Codex 运行测试",
  });
  await fixture.agent.stop(fixture.session.deviceId);
  fixture.bridge.emit("notification", "thread/realtime/closed", {
    threadId: "voice-thread-1",
  });
  await settle();

  assert.deepEqual(fixture.commandCalls, ["让 Codex 运行测试"]);
  assert.deepEqual(fixture.events, [{
    event: "voice.command.queued",
    requestId: "voice-command-1",
    text: "让 Codex 运行测试",
  }]);
  assert.equal(fixture.store.snapshot().voice.status, "awaiting-confirmation");
});

test("local voice command is queued for explicit confirmation", async (t) => {
  const fixture = createFixture({
    accountType: "chatgpt",
    localTranscript: "让 Codex 运行测试",
  });
  t.after(() => fixture.agent.close());
  await fixture.agent.start(fixture.session, { mode: "command" });
  const samples = Buffer.alloc(320 * 2);
  fixture.agent.acceptAudio(fixture.session, {
    event: "voice.audio",
    data: samples.toString("base64"),
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: 320,
  });
  await fixture.agent.stop(fixture.session.deviceId);
  await settle();

  assert.deepEqual(fixture.commandCalls, ["让 Codex 运行测试"]);
  assert.deepEqual(fixture.events, [{
    event: "voice.command.queued",
    requestId: "voice-command-1",
    text: "让 Codex 运行测试",
  }]);
  assert.equal(fixture.store.snapshot().voice.status, "awaiting-confirmation");
});

test("voice rejects BLE audio and disconnect cancels without acting", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());
  await assert.rejects(
    fixture.agent.start({
      ...fixture.session,
      transport: { kind: "ble" },
    }),
    /USB 或 Wi-Fi/,
  );

  await fixture.agent.start(fixture.session, { mode: "chat" });
  await fixture.agent.disconnect(fixture.session);
  fixture.bridge.emit("notification", "thread/realtime/transcript/done", {
    threadId: "voice-thread-1",
    role: "user",
    text: "不应执行",
  });
  await settle();
  assert.deepEqual(fixture.chatCalls, []);
  assert.deepEqual(fixture.commandCalls, []);
  assert.equal(fixture.store.snapshot().voice.status, "idle");
});
