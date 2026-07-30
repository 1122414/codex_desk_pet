import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DeskStore } from "../src/server/desk-store.js";
import { VoiceAgent } from "../src/server/voice-agent.js";

function createFixture() {
  const bridge = new EventEmitter();
  const requests = [];
  bridge.client = {
    running: true,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: "voice-thread-1" } };
      return {};
    },
  };
  const chatCalls = [];
  const commandCalls = [];
  const careCalls = [];
  const careReplies = [];
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
  const careAgent = {
    respondToText: async (text, context) => {
      careCalls.push({ text, context });
      return careReplies.shift() ?? {
        say: `关怀：${text}`,
        continueListening: false,
        nextObservationMinutes: 12,
        action: null,
        memory: null,
      };
    },
  };
  const settings = {
    load: async () => ({ care: { autoListenSeconds: 20 } }),
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
    careAgent,
    settings,
    transcriptSettleMs: 1,
    closedSettleMs: 1,
  });
  return {
    agent,
    bridge,
    requests,
    chatCalls,
    commandCalls,
    careCalls,
    careReplies,
    events,
    session,
    store,
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

async function finishTurn(fixture, text) {
  fixture.bridge.emit("notification", "thread/realtime/transcript/done", {
    threadId: "voice-thread-1",
    role: "user",
    text,
  });
  await fixture.agent.stop(fixture.session.deviceId);
  fixture.bridge.emit("notification", "thread/realtime/closed", {
    threadId: "voice-thread-1",
  });
  await settle();
}

test("voice chat streams PCM into Codex Realtime and returns a bounded reply", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());

  assert.deepEqual(
    await fixture.agent.start(fixture.session, { mode: "chat" }),
    { accepted: true, mode: "chat" },
  );
  assert.equal(fixture.store.snapshot().voice.status, "listening");
  assert.equal(
    fixture.requests.find(({ method }) => method === "thread/start").params.sandbox,
    "read-only",
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

test("care voice completes three automatic rounds in one CareAgent context", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());
  fixture.careReplies.push(
    {
      say: "听起来你卡住了，具体是哪一步？",
      continueListening: true,
      nextObservationMinutes: 5,
    },
    {
      say: "是编译报错，还是运行结果不对？",
      continueListening: true,
      nextObservationMinutes: 8,
    },
    {
      say: "好，那你先处理，我晚点再来看看。",
      continueListening: false,
      nextObservationMinutes: 20,
    },
  );

  for (const text of ["这个问题卡了很久", "是编译时报错", "我知道怎么改了"]) {
    assert.deepEqual(
      await fixture.agent.start(fixture.session, { mode: "care" }),
      { accepted: true, mode: "care" },
    );
    await finishTurn(fixture, text);
  }

  assert.deepEqual(
    fixture.careCalls.map(({ text }) => text),
    ["这个问题卡了很久", "是编译时报错", "我知道怎么改了"],
  );
  assert.ok(fixture.careCalls.every(({ context }) =>
    context.deviceId === "tab5-voice-1" && context.state.source === "voice"));
  assert.deepEqual(fixture.chatCalls, []);
  assert.deepEqual(fixture.commandCalls, []);
  assert.deepEqual(
    fixture.events.map(({ event, continueListening, nextObservationMinutes }) => ({
      event,
      continueListening,
      nextObservationMinutes,
    })),
    [
      { event: "care.reply", continueListening: true, nextObservationMinutes: 5 },
      { event: "care.reply", continueListening: true, nextObservationMinutes: 8 },
      { event: "care.reply", continueListening: false, nextObservationMinutes: 20 },
    ],
  );
  assert.ok(fixture.events.every(({ autoListenSeconds }) => autoListenSeconds === 20));
});

test("silent care timeout exits without calling the CareAgent", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());
  await fixture.agent.start(fixture.session, { mode: "care" });
  await fixture.agent.stop(fixture.session.deviceId);
  fixture.bridge.emit("notification", "thread/realtime/closed", {
    threadId: "voice-thread-1",
  });
  await settle();

  assert.deepEqual(fixture.careCalls, []);
  assert.deepEqual(fixture.events, [{
    event: "care.reply",
    source: "voice",
    ok: true,
    text: "",
    continueListening: false,
    nextObservationMinutes: null,
    autoListenSeconds: 20,
  }]);
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
