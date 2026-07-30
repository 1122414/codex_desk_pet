import path from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;

function normalizeInput(input) {
  if (typeof input === "string") {
    return [{ type: "text", text: input, text_elements: [] }];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("Codex conversation input must not be empty");
  }
  return input;
}

export class CodexConversation {
  #turns = new Map();
  #closed = false;

  constructor({
    bridge,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!bridge) throw new TypeError("CodexConversation requires a bridge");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
      throw new RangeError("Codex conversation timeout must be at least one second");
    }
    this.bridge = bridge;
    this.cwd = path.resolve(cwd);
    this.timeoutMs = timeoutMs;
    this.onNotification = (method, params) => this.#handleNotification(method, params);
    this.bridge.on("notification", this.onNotification);
  }

  requireConnected() {
    if (this.#closed) throw new Error("Codex 对话服务已关闭");
    if (!this.bridge.client?.running) throw new Error("Codex App Server 当前未连接");
  }

  async startThread({
    cwd = this.cwd,
    ephemeral = true,
    approvalPolicy = "never",
    sandbox = "read-only",
    developerInstructions,
    serviceName,
    personality = "friendly",
  } = {}) {
    this.requireConnected();
    if (typeof developerInstructions !== "string" || !developerInstructions.trim()) {
      throw new TypeError("Codex conversation instructions are required");
    }
    if (typeof serviceName !== "string" || !serviceName.trim()) {
      throw new TypeError("Codex conversation service name is required");
    }
    const response = await this.bridge.client.request("thread/start", {
      cwd: path.resolve(cwd),
      approvalPolicy,
      sandbox,
      ephemeral: Boolean(ephemeral),
      environments: [],
      dynamicTools: [],
      personality,
      developerInstructions,
      serviceName,
    });
    const threadId = response?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Codex 没有返回有效会话");
    }
    return threadId;
  }

  async runTurn(threadId, input, {
    effort = "low",
    summary = "none",
  } = {}) {
    this.requireConnected();
    if (typeof threadId !== "string" || !threadId) {
      throw new TypeError("Codex conversation thread id is required");
    }
    if (this.#turns.has(threadId)) {
      throw new Error("同一 Codex 会话不能同时运行两个回合");
    }
    const entry = {
      turnId: null,
      reply: "",
      resolve: null,
      reject: null,
      timer: null,
    };
    const completion = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.timer = setTimeout(() => {
      if (this.#turns.get(threadId) !== entry) return;
      this.#turns.delete(threadId);
      entry.reject(new Error("等待 Codex 回复超时"));
    }, this.timeoutMs);
    entry.timer.unref?.();
    this.#turns.set(threadId, entry);
    try {
      const response = await this.bridge.client.request("turn/start", {
        threadId,
        input: normalizeInput(input),
        effort,
        summary,
      });
      entry.turnId = response?.turn?.id ?? null;
      return await completion;
    } catch (error) {
      if (this.#turns.get(threadId) === entry) this.#turns.delete(threadId);
      clearTimeout(entry.timer);
      entry.reject(error);
      throw error;
    }
  }

  close(reason = "Codex 对话服务已关闭") {
    if (this.#closed) return;
    this.#closed = true;
    this.bridge.off("notification", this.onNotification);
    for (const entry of this.#turns.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.#turns.clear();
  }

  #handleNotification(method, params) {
    const entry = this.#turns.get(params?.threadId);
    if (!entry) return;
    if (method === "item/agentMessage/delta") {
      entry.reply += params.delta ?? "";
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      entry.reply = params.item.text ?? entry.reply;
      return;
    }
    if (method === "error" && params.willRetry === false) {
      this.#finishTurn(params.threadId, new Error(params.error?.message ?? "Codex 回复失败"));
      return;
    }
    if (method !== "turn/completed") return;
    if (entry.turnId && params.turn?.id && entry.turnId !== params.turn.id) return;
    if (params.turn?.status !== "completed") {
      this.#finishTurn(
        params.threadId,
        new Error(params.turn?.error?.message ?? `Codex 回合状态：${params.turn?.status ?? "unknown"}`),
      );
      return;
    }
    const completedReply = [...(params.turn?.items ?? [])]
      .reverse()
      .find((item) => item?.type === "agentMessage")?.text;
    const reply = String(completedReply ?? entry.reply).trim();
    this.#finishTurn(
      params.threadId,
      reply ? null : new Error("Codex 没有返回可显示的回复"),
      reply,
    );
  }

  #finishTurn(threadId, error, reply = "") {
    const entry = this.#turns.get(threadId);
    if (!entry) return;
    this.#turns.delete(threadId);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve({ threadId, turnId: entry.turnId, reply });
  }
}
