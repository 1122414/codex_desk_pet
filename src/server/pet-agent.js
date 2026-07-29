import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_PROMPT_LENGTH = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const CHAT_INSTRUCTIONS = [
  "你是 Codex Desk Buddy 中的桌面宠物。",
  "使用简洁、自然的中文回复，通常不超过 80 个汉字。",
  "你可以解释当前 Codex 状态并陪用户聊天。",
  "本会话只允许对话：不要调用工具、不要执行命令、不要修改文件，也不要索要或输出秘密。",
].join("\n");
const SKADI_CHAT_INSTRUCTIONS = [
  CHAT_INSTRUCTIONS,
  "当前桌面宠物是 Chibi Skadi。始终称呼用户为“博士”，不要称呼用户为“指挥官”。",
].join("\n");
const COMMAND_INSTRUCTIONS = [
  "你是从 Codex Desk Buddy 接收用户已确认命令的 Codex 执行代理。",
  "只完成用户明确提出的任务，保持改动聚焦并遵守工作区 AGENTS.md。",
  "不要读取、显示或记录无关秘密。需要额外权限时必须走 App Server 审批，不得规避审批。",
  "最后用简洁中文说明完成结果、验证情况和剩余风险。",
].join("\n");
const VISION_INSTRUCTIONS = [
  "你是 Codex Desk Buddy 的视觉观察助手。",
  "只描述图片中清楚可见的环境、人物姿态和物体，不猜测身份、健康、情绪或敏感属性。",
  "使用简洁自然的中文，通常不超过 80 个汉字。",
  "不要调用工具、执行命令、修改文件，也不要保留图片内容。",
].join("\n");

function normalizedPrompt(value) {
  if (typeof value !== "string") throw new TypeError("消息必须是文本");
  const prompt = value.trim();
  if (!prompt) throw new RangeError("消息不能为空");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new RangeError(`消息不能超过 ${MAX_PROMPT_LENGTH} 个字符`);
  }
  return prompt;
}

function publicInteraction(interaction) {
  return interaction ? {
    requestId: interaction.requestId,
    prompt: interaction.prompt,
    createdAt: interaction.createdAt,
  } : null;
}

export class PetAgent {
  #pendingCommand = null;
  #chatThreadId = null;
  #chatPetId = null;
  #chatActive = false;
  #turns = new Map();

  constructor({
    bridge,
    store,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!bridge || !store) throw new TypeError("PetAgent requires bridge and store");
    this.bridge = bridge;
    this.store = store;
    this.cwd = path.resolve(cwd);
    this.timeoutMs = timeoutMs;
    this.onNotification = (method, params) => this.#handleNotification(method, params);
    this.bridge.on("notification", this.onNotification);
  }

  get pendingCommand() {
    return publicInteraction(this.#pendingCommand);
  }

  async chat(text) {
    const prompt = normalizedPrompt(text);
    if (this.#chatActive) throw new Error("宠物正在回复上一条消息");
    this.#chatActive = true;
    try {
      return await this.#chat(prompt);
    } finally {
      this.#chatActive = false;
    }
  }

  async #chat(prompt) {
    if (this.bridge.isMock) {
      const reply = `收到：${prompt}`;
      this.store.setCompanion({
        status: "completed",
        mode: "chat",
        requestId: null,
        prompt,
        reply,
        error: null,
      });
      return { reply };
    }
    this.#requireConnected();
    this.store.setCompanion({
      status: "thinking",
      mode: "chat",
      requestId: null,
      prompt,
      reply: null,
      error: null,
    });
    try {
      const selectedPetId = this.store.selectedPetId;
      if (this.#chatPetId !== selectedPetId) {
        this.#chatThreadId = null;
        this.#chatPetId = selectedPetId;
      }
      const chatInstructions =
          selectedPetId === "chibi-skadi" ||
          selectedPetId.startsWith("chibi-skadi-")
        ? SKADI_CHAT_INSTRUCTIONS
        : CHAT_INSTRUCTIONS;
      this.#chatThreadId ??= await this.#startThread({
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: chatInstructions,
        serviceName: "codex-desk-pet-chat",
      });
      const result = await this.#runTurn(this.#chatThreadId, prompt);
      this.store.setCompanion({
        status: "completed",
        mode: "chat",
        prompt,
        reply: result.reply,
        threadId: this.#chatThreadId,
        turnId: result.turnId,
        error: null,
      });
      return { reply: result.reply };
    } catch (error) {
      this.store.setCompanion({
        status: "failed",
        mode: "chat",
        prompt,
        error: error.message,
      });
      throw error;
    }
  }

  async observeImage(imagePath, text = "请简洁说说你看到了什么。") {
    const prompt = normalizedPrompt(text);
    if (typeof imagePath !== "string" || !path.isAbsolute(imagePath)) {
      throw new TypeError("视觉图片路径必须是绝对路径");
    }
    if (this.bridge.isMock) {
      return { reply: "我看到了一张来自桌面摄像头的图片。" };
    }
    this.#requireConnected();
    const threadId = await this.#startThread({
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: VISION_INSTRUCTIONS,
      serviceName: "codex-desk-pet-vision",
    });
    const result = await this.#runTurn(threadId, [
      { type: "text", text: prompt, text_elements: [] },
      { type: "localImage", path: imagePath, detail: "low" },
    ]);
    return { reply: result.reply };
  }

  queueCommand(text) {
    const prompt = normalizedPrompt(text);
    if (this.#pendingCommand) throw new Error("已有一条命令等待确认");
    this.#pendingCommand = {
      requestId: randomUUID(),
      prompt,
      createdAt: Date.now(),
    };
    this.store.setCompanion({
      status: "awaiting-confirmation",
      mode: "command",
      requestId: this.#pendingCommand.requestId,
      prompt,
      reply: null,
      threadId: null,
      turnId: null,
      error: null,
    });
    return this.pendingCommand;
  }

  async decideCommand(requestId, decision) {
    if (!["accept", "decline"].includes(decision)) {
      throw new RangeError("命令决定只能是 accept 或 decline");
    }
    const pending = this.#pendingCommand;
    if (!pending || pending.requestId !== requestId) {
      throw new Error("该命令已不再等待确认");
    }
    this.#pendingCommand = null;
    if (decision === "decline") {
      this.store.setCompanion({
        status: "declined",
        mode: "command",
        requestId,
        prompt: pending.prompt,
        reply: "已取消",
        error: null,
      });
      return { decision, requestId };
    }

    if (this.bridge.isMock) {
      this.store.setCompanion({
        status: "completed",
        mode: "command",
        requestId,
        prompt: pending.prompt,
        reply: "模拟命令已完成",
        error: null,
      });
      return { decision, requestId, threadId: "mock-command-thread" };
    }
    this.#requireConnected();
    this.store.setCompanion({
      status: "running",
      mode: "command",
      requestId,
      prompt: pending.prompt,
      reply: null,
      error: null,
    });
    try {
      const selected = this.store.snapshot().task;
      const sourceThread = selected?.id ? this.store.getThread(selected.id) : null;
      const commandCwd = typeof sourceThread?.cwd === "string" && path.isAbsolute(sourceThread.cwd)
        ? sourceThread.cwd
        : this.cwd;
      const threadId = await this.#startThread({
        cwd: commandCwd,
        ephemeral: false,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        developerInstructions: COMMAND_INSTRUCTIONS,
        serviceName: "codex-desk-pet-command",
      });
      await this.bridge.client.request("thread/name/set", {
        threadId,
        name: `桌宠命令：${pending.prompt.slice(0, 32)}`,
      });
      this.#runTurn(threadId, pending.prompt)
        .then((result) => {
          this.store.setCompanion({
            status: "completed",
            mode: "command",
            requestId,
            prompt: pending.prompt,
            reply: result.reply,
            threadId,
            turnId: result.turnId,
            error: null,
          });
        })
        .catch((error) => {
          this.store.setCompanion({
            status: "failed",
            mode: "command",
            requestId,
            prompt: pending.prompt,
            threadId,
            error: error.message,
          });
        });
      return { decision, requestId, threadId };
    } catch (error) {
      this.store.setCompanion({
        status: "failed",
        mode: "command",
        requestId,
        prompt: pending.prompt,
        error: error.message,
      });
      throw error;
    }
  }

  close() {
    this.bridge.off("notification", this.onNotification);
    for (const entry of this.#turns.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("宠物服务已关闭"));
    }
    this.#turns.clear();
  }

  #requireConnected() {
    if (!this.bridge.client?.running) throw new Error("Codex App Server 当前未连接");
  }

  async #startThread({
    cwd = this.cwd,
    ephemeral,
    approvalPolicy,
    sandbox,
    developerInstructions,
    serviceName,
  }) {
    const response = await this.bridge.client.request("thread/start", {
      cwd,
      approvalPolicy,
      sandbox,
      ephemeral,
      environments: [],
      dynamicTools: [],
      personality: "friendly",
      developerInstructions,
      serviceName,
    });
    const threadId = response?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Codex 没有返回有效会话");
    }
    return threadId;
  }

  async #runTurn(threadId, input) {
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
      this.#turns.delete(threadId);
      entry.reject(new Error("等待 Codex 回复超时"));
    }, this.timeoutMs);
    entry.timer.unref?.();
    this.#turns.set(threadId, entry);
    try {
      const response = await this.bridge.client.request("turn/start", {
        threadId,
        input: Array.isArray(input)
          ? input
          : [{ type: "text", text: input, text_elements: [] }],
        effort: "low",
        summary: "none",
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
