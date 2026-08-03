const SAMPLE_RATE = 16_000;
const MAX_AUDIO_CHUNK_BYTES = 2_048;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 60;
const DEFAULT_AUTO_LISTEN_SECONDS = 20;
const DEFAULT_CHAT_LISTENING_TIMEOUT_MS = 25_000;
const DEFAULT_CARE_LISTENING_TIMEOUT_MS = 65_000;
const LISTENING_TIMEOUT_ERROR = "设备语音会话超时，请再试一次";

function validBase64(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= Math.ceil(MAX_AUDIO_CHUNK_BYTES / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function validListeningTimeout(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError(`${name} must be an integer between 1 and 120000 milliseconds`);
  }
  return value;
}

export class VoiceAgent {
  #sessions = new Map();

  constructor({
    store,
    petAgent,
    careAgent = null,
    settings = null,
    transcriber,
    chatListeningTimeoutMs = DEFAULT_CHAT_LISTENING_TIMEOUT_MS,
    careListeningTimeoutMs = DEFAULT_CARE_LISTENING_TIMEOUT_MS,
  } = {}) {
    if (!store || !petAgent || !transcriber) {
      throw new TypeError("VoiceAgent requires store, petAgent, and transcriber");
    }
    if (typeof transcriber.available !== "function" || typeof transcriber.transcribe !== "function") {
      throw new TypeError("VoiceAgent transcriber must provide available and transcribe");
    }
    this.store = store;
    this.petAgent = petAgent;
    this.careAgent = careAgent;
    this.settings = settings;
    this.transcriber = transcriber;
    this.chatListeningTimeoutMs = validListeningTimeout(
      chatListeningTimeoutMs,
      "chatListeningTimeoutMs",
    );
    this.careListeningTimeoutMs = validListeningTimeout(
      careListeningTimeoutMs,
      "careListeningTimeoutMs",
    );
  }

  async start(session, { mode = "chat" } = {}) {
    if (!session?.ready || typeof session.deviceId !== "string") {
      throw new Error("设备语音会话未认证");
    }
    if (!["usb", "wifi"].includes(session.transport?.kind)) {
      throw new Error("语音对话首版需要 USB 或 Wi-Fi 链路");
    }
    if (!["chat", "command", "care"].includes(mode)) throw new Error("语音模式无效");
    if (mode === "care" && !this.careAgent) throw new Error("主动关怀语音服务不可用");
    if (!await this.transcriber.available()) throw new Error("本地中文转写模型未准备好");
    this.#cancel(this.#sessions.get(session.deviceId));

    const entry = {
      deviceId: session.deviceId,
      session,
      mode,
      audioChunks: [],
      audioBytes: 0,
      stopping: false,
      cancelled: false,
      abortController: new AbortController(),
      listeningTimer: null,
    };
    this.#sessions.set(session.deviceId, entry);
    this.store.setVoice({
      status: "listening",
      mode,
      transcript: null,
      error: null,
      deviceId: session.deviceId,
    });
    if (mode === "care") this.store.setCare({ status: "listening", error: null });
    this.#armListeningTimeout(entry);
    return { accepted: true, mode };
  }

  acceptAudio(session, payload) {
    const entry = this.#sessions.get(session?.deviceId);
    if (!entry || entry.session !== session || entry.stopping || entry.cancelled) return false;
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
    const audio = Buffer.from(payload.data, "base64");
    if (audio.byteLength !== payload.samplesPerChannel * 2) {
      throw new Error("语音音频块长度无效");
    }
    if (entry.audioBytes + audio.byteLength > MAX_AUDIO_BYTES) {
      this.#fail(entry, new Error("单次语音最长 60 秒"));
      return false;
    }
    entry.audioChunks.push(audio);
    entry.audioBytes += audio.byteLength;
    return true;
  }

  async stop(deviceId, { silent = false } = {}) {
    const entry = this.#sessions.get(deviceId);
    if (!entry) return { accepted: false };
    if (entry.stopping) return { accepted: true };
    entry.stopping = true;
    this.#clearListeningTimeout(entry);
    if (!silent) this.store.setVoice({ status: "transcribing" });
    void this.#finalize(entry).catch((error) => this.#fail(entry, error));
    return { accepted: true };
  }

  async close() {
    for (const entry of this.#sessions.values()) this.#cancel(entry);
    this.#sessions.clear();
  }

  async stopCareConversation() {
    const entries = [...this.#sessions.values()]
      .filter((entry) => entry.mode === "care");
    for (const entry of entries) this.#cancel(entry);
    if (entries.length) {
      this.store.setVoice({
        status: "idle",
        mode: null,
        transcript: null,
        error: null,
        deviceId: null,
      });
      this.store.setCare({ status: "idle", error: null });
    }
    return { stoppedSessions: entries.length };
  }

  async disconnect(session) {
    const entry = this.#sessions.get(session?.deviceId);
    if (!entry || entry.session !== session) return;
    this.#cancel(entry);
    this.store.setVoice({
      status: "idle",
      mode: null,
      transcript: null,
      error: null,
      deviceId: null,
    });
    if (entry.mode === "care") this.store.setCare({ status: "idle", error: null });
  }

  async #finalize(entry) {
    if (!this.#active(entry)) return;
    this.#clearListeningTimeout(entry);
    const audio = entry.audioBytes > 0
      ? Buffer.concat(entry.audioChunks, entry.audioBytes)
      : null;
    const transcript = audio
      ? String(await this.transcriber.transcribe(audio, { signal: entry.abortController.signal })).trim()
      : "";
    if (!this.#active(entry)) return;
    this.#sessions.delete(entry.deviceId);
    if (!transcript) {
      if (entry.mode === "care") {
        this.store.setVoice({
          status: "completed",
          transcript: null,
          error: null,
        });
        entry.session.sendEvent({
          event: "care.reply",
          source: "voice",
          ok: true,
          text: "",
          continueListening: false,
          nextObservationMinutes: null,
          autoListenSeconds: await this.#autoListenSeconds(),
        });
        this.store.setCare({ status: "idle", error: null });
        return;
      }
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
    if (entry.mode === "care") {
      const result = await this.careAgent.respondToText(transcript, {
        deviceId: entry.deviceId,
        state: { source: "voice" },
      });
      this.store.setVoice({ status: "completed" });
      entry.session.sendEvent({
        event: "care.reply",
        source: "voice",
        ok: true,
        text: this.#boundedDeviceText(result.say),
        continueListening: result.continueListening,
        nextObservationMinutes: result.nextObservationMinutes,
        autoListenSeconds: await this.#autoListenSeconds(),
        actionStatus: result.actionResult ?? null,
      });
      this.store.setCare({ status: "idle" });
      return;
    }
    const result = await this.petAgent.chat(transcript);
    this.store.setVoice({ status: "completed" });
    entry.session.sendEvent({
      event: "voice.reply",
      ok: true,
      text: this.#boundedDeviceText(result.reply),
    });
  }

  #active(entry) {
    return this.#sessions.get(entry.deviceId) === entry && !entry.cancelled;
  }

  #cancel(entry) {
    if (!entry) return;
    this.#clearListeningTimeout(entry);
    entry.cancelled = true;
    entry.stopping = true;
    entry.abortController.abort();
    if (this.#sessions.get(entry.deviceId) === entry) {
      this.#sessions.delete(entry.deviceId);
    }
  }

  #fail(entry, error) {
    if (entry.cancelled) return;
    this.#clearListeningTimeout(entry);
    if (this.#sessions.get(entry.deviceId) === entry) {
      this.#sessions.delete(entry.deviceId);
    }
    this.store.setVoice({ status: "failed", error: error.message });
    try {
      if (entry.mode === "care") {
        this.store.setCare({ status: "failed", error: error.message });
        entry.session.sendEvent({
          event: "care.reply",
          source: "voice",
          ok: false,
          text: this.#boundedDeviceText(error.message),
          continueListening: false,
          nextObservationMinutes: null,
          autoListenSeconds: DEFAULT_AUTO_LISTEN_SECONDS,
        });
      } else {
        entry.session.sendEvent({
          event: "voice.reply",
          ok: false,
          text: this.#boundedDeviceText(error.message),
        });
      }
    } catch {
      // The transport may already be closed.
    }
  }

  async #autoListenSeconds() {
    if (!this.settings?.load) return DEFAULT_AUTO_LISTEN_SECONDS;
    try {
      const value = (await this.settings.load())?.care?.autoListenSeconds;
      return Number.isInteger(value) && value >= 5 && value <= 60
        ? value
        : DEFAULT_AUTO_LISTEN_SECONDS;
    } catch {
      return DEFAULT_AUTO_LISTEN_SECONDS;
    }
  }

  #armListeningTimeout(entry) {
    entry.listeningTimer = setTimeout(() => {
      if (!this.#active(entry) || entry.stopping) return;
      this.#fail(entry, new Error(LISTENING_TIMEOUT_ERROR));
    }, entry.mode === "care"
      ? this.careListeningTimeoutMs
      : this.chatListeningTimeoutMs);
    entry.listeningTimer.unref?.();
  }

  #clearListeningTimeout(entry) {
    if (entry?.listeningTimer === null || entry?.listeningTimer === undefined) return;
    clearTimeout(entry.listeningTimer);
    entry.listeningTimer = null;
  }

  #boundedDeviceText(value, maximumBytes = 240) {
    const source = Buffer.from(String(value ?? ""), "utf8");
    if (source.length <= maximumBytes) return source.toString("utf8");
    let end = maximumBytes;
    while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
    return source.subarray(0, end).toString("utf8");
  }
}
