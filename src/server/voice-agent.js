import {
  LOCAL_SPEECH_MAX_SECONDS,
  LOCAL_SPEECH_SAMPLE_RATE,
  LocalSpeechRecognizer,
} from "./local-speech-recognizer.js";

const SAMPLE_RATE = LOCAL_SPEECH_SAMPLE_RATE;
const MAX_AUDIO_CHUNK_BYTES = 2_048;
const MAX_PENDING_CHUNKS = 64;
const MAX_LOCAL_AUDIO_BYTES =
  SAMPLE_RATE * 2 * LOCAL_SPEECH_MAX_SECONDS;
const TRANSCRIPT_SETTLE_MS = 2_500;
const CLOSED_SETTLE_MS = 120;
const REALTIME_START_TIMEOUT_MS = 10_000;
const VOICE_INSTRUCTIONS = [
  "你是 Codex Desk Buddy 的语音转写会话。",
  "准确识别用户的普通话语音，不执行命令，不调用工具，不修改文件。",
  "保持用户原意，不补充不存在的内容。",
].join("\n");

function validBase64(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= Math.ceil(MAX_AUDIO_CHUNK_BYTES / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function realtimeErrorMessage(value) {
  const message = String(value || "Codex 实时语音失败");
  if (message.includes("requires API key auth")) {
    return "实时语音需要 OpenAI API Key 登录，当前 ChatGPT 登录暂不支持";
  }
  return message;
}

export class VoiceAgent {
  #sessions = new Map();

  constructor({
    bridge,
    store,
    petAgent,
    cwd = process.cwd(),
    transcriptSettleMs = TRANSCRIPT_SETTLE_MS,
    closedSettleMs = CLOSED_SETTLE_MS,
    realtimeStartTimeoutMs = REALTIME_START_TIMEOUT_MS,
    localSpeech = new LocalSpeechRecognizer(),
  } = {}) {
    if (!bridge || !store || !petAgent) {
      throw new TypeError("VoiceAgent requires bridge, store, and petAgent");
    }
    this.bridge = bridge;
    this.store = store;
    this.petAgent = petAgent;
    this.cwd = cwd;
    this.transcriptSettleMs = transcriptSettleMs;
    this.closedSettleMs = closedSettleMs;
    this.realtimeStartTimeoutMs = realtimeStartTimeoutMs;
    this.localSpeech = localSpeech;
    this.onNotification = (method, params) => this.#handleNotification(method, params);
    this.bridge.on("notification", this.onNotification);
  }

  async start(session, { mode = "chat" } = {}) {
    if (!session?.ready || typeof session.deviceId !== "string") {
      throw new Error("设备语音会话未认证");
    }
    if (!["usb", "wifi"].includes(session.transport?.kind)) {
      throw new Error("实时语音首版需要 USB 或 Wi-Fi 链路");
    }
    if (!["chat", "command"].includes(mode)) throw new Error("语音模式无效");
    if (!this.bridge.client?.running) throw new Error("Codex App Server 当前未连接");
    await this.stop(session.deviceId, { silent: true });

    const entry = {
      deviceId: session.deviceId,
      session,
      mode,
      backend: null,
      threadId: null,
      transcriptParts: [],
      audioChunks: [],
      audioBytes: 0,
      audioChain: Promise.resolve(),
      pendingChunks: 0,
      stopping: false,
      started: false,
      failed: false,
      startupError: null,
      finalizeTimer: null,
      ready: null,
      resolveReady: null,
      abortController: new AbortController(),
    };
    entry.ready = new Promise((resolve) => {
      entry.resolveReady = resolve;
    });
    this.#sessions.set(session.deviceId, entry);
    this.store.setVoice({
      status: "starting",
      mode,
      transcript: null,
      error: null,
      deviceId: session.deviceId,
    });
    try {
      const account = await this.bridge.client.request("account/read", {});
      if (!account?.account?.type) {
        throw new Error("Codex 当前未登录");
      }
      if (account.account.type !== "apiKey") {
        await this.localSpeech.assertReady();
        entry.backend = "local";
        entry.started = true;
        entry.resolveReady(true);
        this.store.setVoice({ status: "listening" });
        return { accepted: true, mode, recognition: "local" };
      }
      entry.backend = "realtime";
      const response = await this.bridge.client.request("thread/start", {
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        environments: [],
        dynamicTools: [],
        personality: "friendly",
        developerInstructions: VOICE_INSTRUCTIONS,
        serviceName: "codex-desk-voice",
      });
      entry.threadId = response?.thread?.id;
      if (!entry.threadId) throw new Error("Codex 没有返回语音会话");
      await this.bridge.client.request("thread/realtime/start", {
        threadId: entry.threadId,
        clientManagedHandoffs: true,
        flushTranscriptTailOnSessionEnd: true,
        outputModality: "text",
        includeStartupContext: false,
        prompt: "只做中文语音转写，不执行任何操作。",
        transport: { type: "websocket" },
        version: "v2",
      });
      const started = await new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve(false),
          this.realtimeStartTimeoutMs,
        );
        entry.ready.then((ready) => {
          clearTimeout(timer);
          resolve(ready);
        });
      });
      if (!started) {
        throw entry.startupError ?? new Error("Codex 实时语音启动超时");
      }
      if (this.#sessions.get(entry.deviceId) !== entry) {
        throw entry.startupError ?? new Error("Codex 实时语音启动失败");
      }
      this.store.setVoice({ status: "listening" });
      return { accepted: true, mode, recognition: "realtime" };
    } catch (error) {
      this.#fail(entry, error);
      throw error;
    }
  }

  acceptAudio(session, payload) {
    const entry = this.#sessions.get(session?.deviceId);
    if (!entry || entry.session !== session || entry.stopping) return false;
    if (
      payload?.event !== "voice.audio" ||
      payload.sampleRate !== SAMPLE_RATE ||
      payload.numChannels !== 1 ||
      !Number.isInteger(payload.samplesPerChannel) ||
      payload.samplesPerChannel < 1 ||
      payload.samplesPerChannel > MAX_AUDIO_CHUNK_BYTES / 2 ||
      !validBase64(payload.data)
    ) {
      throw new Error("语音音频块无效");
    }
    const decoded = Buffer.from(payload.data, "base64");
    if (decoded.length !== payload.samplesPerChannel * 2) {
      throw new Error("语音音频块长度无效");
    }
    if (entry.backend === "local") {
      if (entry.audioBytes + decoded.length > MAX_LOCAL_AUDIO_BYTES) {
        throw new Error(`单次语音不能超过 ${LOCAL_SPEECH_MAX_SECONDS} 秒`);
      }
      entry.audioChunks.push(decoded);
      entry.audioBytes += decoded.length;
      return true;
    }
    if (entry.pendingChunks >= MAX_PENDING_CHUNKS) {
      throw new Error("语音上传速度超过处理能力");
    }
    entry.pendingChunks += 1;
    entry.audioChain = entry.audioChain
      .then(async () => {
        if (!await entry.ready || !entry.threadId) return null;
        return this.bridge.client.request("thread/realtime/appendAudio", {
          threadId: entry.threadId,
          audio: {
            data: payload.data,
            sampleRate: SAMPLE_RATE,
            numChannels: 1,
            samplesPerChannel: payload.samplesPerChannel,
            itemId: null,
          },
        });
      })
      .catch((error) => {
        this.#fail(entry, error);
      })
      .finally(() => {
        entry.pendingChunks = Math.max(0, entry.pendingChunks - 1);
      });
    return true;
  }

  async stop(deviceId, { silent = false } = {}) {
    const entry = this.#sessions.get(deviceId);
    if (!entry) return { accepted: false };
    if (entry.stopping) return { accepted: true };
    if (silent) {
      await this.#cancel(entry);
      return { accepted: true };
    }
    entry.stopping = true;
    this.store.setVoice({ status: "transcribing" });
    if (entry.backend === "local") {
      const audio = Buffer.concat(entry.audioChunks, entry.audioBytes);
      entry.audioChunks = [];
      entry.audioBytes = 0;
      this.#transcribeLocal(entry, audio);
      return { accepted: true };
    }
    await entry.audioChain;
    if (!entry.threadId) {
      this.#sessions.delete(deviceId);
      return { accepted: false };
    }
    try {
      await this.bridge.client.request("thread/realtime/stop", {
        threadId: entry.threadId,
      });
    } catch (error) {
      this.#fail(entry, error);
      return { accepted: false };
    }
    entry.finalizeTimer = setTimeout(
      () => this.#finalize(entry),
      this.transcriptSettleMs,
    );
    entry.finalizeTimer.unref?.();
    return { accepted: true };
  }

  async close() {
    this.bridge.off("notification", this.onNotification);
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const entry of entries) {
      entry.abortController.abort();
      entry.resolveReady(false);
      clearTimeout(entry.finalizeTimer);
      if (entry.threadId && this.bridge.client?.running) {
        await this.bridge.client.request("thread/realtime/stop", {
          threadId: entry.threadId,
        }).catch(() => {});
      }
    }
  }

  async disconnect(session) {
    const entry = this.#sessions.get(session?.deviceId);
    if (!entry || entry.session !== session) return;
    entry.startupError = new Error("设备语音连接已断开");
    await this.#cancel(entry);
    this.store.setVoice({
      status: "idle",
      mode: null,
      transcript: null,
      error: null,
      deviceId: null,
    });
  }

  #handleNotification(method, params) {
    const entry = [...this.#sessions.values()]
      .find((candidate) => candidate.threadId === params?.threadId);
    if (!entry) return;
    if (method === "thread/realtime/started") {
      entry.started = true;
      entry.resolveReady(true);
      return;
    }
    if (method === "thread/realtime/transcript/done" && params.role === "user") {
      const text = String(params.text ?? "").trim();
      if (text) entry.transcriptParts.push(text);
      return;
    }
    if (method === "thread/realtime/error") {
      entry.startupError = new Error(realtimeErrorMessage(params.message));
      this.#fail(entry, entry.startupError);
      return;
    }
    if (method === "thread/realtime/closed") {
      if (!entry.started) {
        entry.startupError = new Error("Codex 实时语音启动前已关闭");
        this.#fail(entry, entry.startupError);
        return;
      }
      clearTimeout(entry.finalizeTimer);
      entry.finalizeTimer = setTimeout(
        () => this.#finalize(entry),
        this.closedSettleMs,
      );
      entry.finalizeTimer.unref?.();
    }
  }

  async #finalize(entry) {
    if (this.#sessions.get(entry.deviceId) !== entry) return;
    this.#sessions.delete(entry.deviceId);
    clearTimeout(entry.finalizeTimer);
    const transcript = entry.transcriptParts.join(" ").trim();
    if (!transcript) {
      this.store.setVoice({
        status: "failed",
        transcript: null,
        error: "没有听清，请再说一次",
      });
      entry.session.sendEvent({
        event: "voice.reply",
        ok: false,
        text: "没有听清，请再说一次",
      });
      return;
    }
    this.store.setVoice({ status: "processing", transcript, error: null });
    try {
      if (entry.mode === "command") {
        const command = this.petAgent.queueCommand(transcript);
        this.store.setVoice({ status: "awaiting-confirmation" });
        entry.session.sendEvent({
          event: "voice.command.queued",
          requestId: command.requestId,
          text: transcript,
        });
        return;
      }
      const result = await this.petAgent.chat(transcript);
      this.store.setVoice({ status: "completed" });
      entry.session.sendEvent({
        event: "voice.reply",
        ok: true,
        text: this.#boundedDeviceText(result.reply),
      });
    } catch (error) {
      this.#fail(entry, error);
    }
  }

  async #transcribeLocal(entry, audio) {
    try {
      const transcript = await this.localSpeech.transcribe(audio, {
        signal: entry.abortController.signal,
      });
      if (this.#sessions.get(entry.deviceId) !== entry) return;
      entry.transcriptParts.push(transcript);
      await this.#finalize(entry);
    } catch (error) {
      if (this.#sessions.get(entry.deviceId) === entry) {
        this.#fail(entry, error);
      }
    }
  }

  async #cancel(entry) {
    if (this.#sessions.get(entry.deviceId) === entry) {
      this.#sessions.delete(entry.deviceId);
    }
    entry.abortController.abort();
    entry.resolveReady(false);
    clearTimeout(entry.finalizeTimer);
    await entry.audioChain.catch(() => {});
    if (entry.threadId && this.bridge.client?.running) {
      await this.bridge.client.request("thread/realtime/stop", {
        threadId: entry.threadId,
      }).catch(() => {});
    }
  }

  #fail(entry, error) {
    if (entry.failed) return;
    entry.failed = true;
    entry.abortController.abort();
    entry.resolveReady(false);
    if (this.#sessions.get(entry.deviceId) === entry) {
      this.#sessions.delete(entry.deviceId);
    }
    clearTimeout(entry.finalizeTimer);
    this.store.setVoice({ status: "failed", error: error.message });
    try {
      entry.session.sendEvent({
        event: "voice.reply",
        ok: false,
        text: this.#boundedDeviceText(error.message),
      });
    } catch {
      // The transport may already be closed.
    }
  }

  #boundedDeviceText(value, maximumBytes = 240) {
    const source = Buffer.from(String(value ?? ""), "utf8");
    if (source.length <= maximumBytes) return source.toString("utf8");
    let end = maximumBytes;
    while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
    return source.subarray(0, end).toString("utf8");
  }
}
