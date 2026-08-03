import test from "node:test";
import assert from "node:assert/strict";
import { DeskStore } from "../src/server/desk-store.js";
import { VoiceAgent } from "../src/server/voice-agent.js";

function createFixture({ available = true, transcribe = null } = {}) {
  const transcriptions = [];
  const transcribedAudio = [];
  const chatCalls = [];
  const commandCalls = [];
  const careCalls = [];
  const careReplies = [];
  const transcriber = {
    available: async () => available,
    transcribe: async (audio, options) => {
      transcribedAudio.push({ audio: Buffer.from(audio), options });
      return transcribe
        ? transcribe(audio, options)
        : transcriptions.shift() ?? "";
    },
  };
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
    store,
    petAgent,
    careAgent,
    settings,
    transcriber,
  });
  return {
    agent,
    careCalls,
    careReplies,
    chatCalls,
    commandCalls,
    events,
    session,
    store,
    transcribedAudio,
    transcriptions,
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

function sendAudio(fixture, samples = 640) {
  const audio = Buffer.alloc(samples * 2);
  return fixture.agent.acceptAudio(fixture.session, {
    event: "voice.audio",
    data: audio.toString("base64"),
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: samples,
  });
}

async function finishTurn(fixture, text) {
  fixture.transcriptions.push(text);
  assert.equal(sendAudio(fixture), true);
  await fixture.agent.stop(fixture.session.deviceId);
  await settle();
}

test("voice chat buffers PCM for local transcription and returns a bounded reply", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.agent.close());

  assert.deepEqual(
    await fixture.agent.start(fixture.session, { mode: "chat" }),
    { accepted: true, mode: "chat" },
  );
  assert.equal(fixture.store.snapshot().voice.status, "listening");
  await finishTurn(fixture, "今天进展怎么样");

  assert.equal(fixture.transcribedAudio.length, 1);
  assert.equal(fixture.transcribedAudio[0].audio.byteLength, 1_280);
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
  await finishTurn(fixture, "让 Codex 运行测试");

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
  assert.equal(fixture.store.snapshot().care.status, "idle");
});

test("care voice cancellation aborts local transcription without producing a reply", async (t) => {
  let releaseTranscription;
  const fixture = createFixture({
    transcribe: () => new Promise((resolve) => {
      releaseTranscription = resolve;
    }),
  });
  t.after(() => fixture.agent.close());
  await fixture.agent.start(fixture.session, { mode: "care" });
  assert.equal(sendAudio(fixture), true);
  await fixture.agent.stop(fixture.session.deviceId);
  await Promise.resolve();
  assert.equal(typeof releaseTranscription, "function");

  assert.deepEqual(await fixture.agent.stopCareConversation(), {
    stoppedSessions: 1,
  });
  releaseTranscription("这条转写已取消");
  await settle();
  assert.equal(fixture.store.snapshot().voice.status, "idle");
  assert.equal(fixture.store.snapshot().care.status, "idle");
  assert.deepEqual(fixture.events, []);
});

test("voice rejects unavailable local transcription, malformed audio, and BLE", async (t) => {
  const unavailable = createFixture({ available: false });
  t.after(() => unavailable.agent.close());
  await assert.rejects(
    unavailable.agent.start(unavailable.session, { mode: "chat" }),
    /本地中文转写模型未准备好/,
  );

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
  assert.throws(() => fixture.agent.acceptAudio(fixture.session, {
    event: "voice.audio",
    data: Buffer.alloc(2).toString("base64"),
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: 640,
  }), /长度无效/);
});

test("disconnect cancels a pending local transcription without acting", async (t) => {
  let releaseTranscription;
  const fixture = createFixture({
    transcribe: () => new Promise((resolve) => {
      releaseTranscription = resolve;
    }),
  });
  t.after(() => fixture.agent.close());
  await fixture.agent.start(fixture.session, { mode: "chat" });
  assert.equal(sendAudio(fixture), true);
  await fixture.agent.stop(fixture.session.deviceId);
  await Promise.resolve();
  await fixture.agent.disconnect(fixture.session);
  releaseTranscription("不应执行");
  await settle();
  assert.deepEqual(fixture.chatCalls, []);
  assert.deepEqual(fixture.commandCalls, []);
  assert.equal(fixture.store.snapshot().voice.status, "idle");
});
