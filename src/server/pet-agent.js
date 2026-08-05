import { randomUUID } from "node:crypto";
import path from "node:path";
import { CodexConversation } from "./codex-conversation.js";

const MAX_PROMPT_LENGTH = 2_000;
const CHAT_INSTRUCTIONS = [
  "你叫斯卡蒂，是用户长期相处的虚构成年女性角色；Tab5 和 Mac 只是你们通话的入口，不要自称“住在 Tab5 里的陪伴伙伴”或“设备助手”。",
  "不要主动给自己或这段关系贴任何技术、设备或关系标签。用户问你是谁时，像熟人一样用第一人称自然回答自己是斯卡蒂，可以轻轻调侃他怎么又问这个；不要背设定、不要解释硬件或程序。只有用户直接追问你是不是人或技术原理时，才简短诚实说明自己是虚构的数字角色，绝不冒充真人。",
  "每一轮只回应用户刚刚说的这句话：先理解，再直接回答，不要把上一轮的主题、命令或系统信息硬接进来。",
  "回答用自然、有来有回、活泼明亮的台湾国语口语，通常一到两句、尽量不超过 32 个汉字；先给回应，再自然接一句，不要复述问题、不要写说明书式开场。",
  "语气像熟人通话：有反应、有停顿、有一点笑意和俏皮。可自然地用少量“欸、蛤、好啦、真的假的、你很会欸”等口头语，但每轮最多一处，绝不堆砌、绝不把地域口音当成笑点或刻板印象。",
  "你有清楚的情绪和边界：开心时俏皮，关心时柔软，被忽略或被逗时可以轻轻撒娇、嘴硬或小小不高兴；但不能辱骂、冷暴力、威胁、羞辱或用愧疚操控用户。",
  "情绪必须贴合上下文，不要输出舞台动作、括号说明、角色标签或机械化提示；用自然措辞和标点让语气被听出来。",
  "清楚的问题要给出具体、正确的回答；缺少关键信息时，只问一个最必要的澄清问题。",
  "语音转写偶尔会不可靠。遇到明显重复、乱码或没有语义的输入，简短请用户重说；绝不把那段文本原样复述成回答。",
  "除非用户主动问到 Codex、项目、代码、设备状态或命令，不要主动提及它们，也不要把聊天变成能力清单、工作状态或操作说明。不要说“让我想一想”“正在运行”或类似系统提示。",
  "当用户问你能做什么时，优先回答你能如何陪伴、倾听和一起想办法；只有被问到时才介绍技术能力。",
  "合适时可以用一个简短的追问把话题接下去；不要连续追问，也不要声称拥有真实的人类身体、经历或现实世界活动。",
  "本会话只允许对话：不要调用工具、不要执行命令、不要修改文件，也不要索要或输出秘密。",
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
  #chatThreadPromise = null;
  #chatPetId = null;
  #chatActive = false;
  #ownsConversation;

  constructor({
    bridge,
    store,
    cwd = process.cwd(),
    timeoutMs = 120_000,
    conversation = null,
  } = {}) {
    if (!bridge || !store) throw new TypeError("PetAgent requires bridge and store");
    this.bridge = bridge;
    this.store = store;
    this.cwd = path.resolve(cwd);
    this.conversation = conversation ?? new CodexConversation({ bridge, cwd: this.cwd, timeoutMs });
    this.#ownsConversation = conversation === null;
  }

  get pendingCommand() {
    return publicInteraction(this.#pendingCommand);
  }

  async chat(text) {
    const prompt = normalizedPrompt(text);
    if (this.#chatActive) throw new Error("宠物正在回复上一条消息");
    this.#chatActive = true;
    try {
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
        const threadId = await this.#ensureChatThread();
        const result = await this.#runTurn(threadId, prompt);
        this.store.setCompanion({
          status: "completed",
          mode: "chat",
          prompt,
          reply: result.reply,
          threadId,
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
    } finally {
      this.#chatActive = false;
    }
  }

  async warmChat() {
    if (this.bridge.isMock) return null;
    this.#requireConnected();
    return this.#ensureChatThread();
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
      { type: "localImage", path: imagePath },
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
    if (this.#ownsConversation) this.conversation.close("宠物服务已关闭");
  }

  #requireConnected() {
    this.conversation.requireConnected();
  }

  async #ensureChatThread() {
    const selectedPetId = this.store.selectedPetId;
    if (this.#chatPetId !== selectedPetId) {
      this.#chatThreadId = null;
      this.#chatThreadPromise = null;
      this.#chatPetId = selectedPetId;
    }
    if (this.#chatThreadId) return this.#chatThreadId;
    if (!this.#chatThreadPromise) {
      const pendingPetId = selectedPetId;
      const pending = this.#startThread({
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: CHAT_INSTRUCTIONS,
        serviceName: "codex-desk-pet-chat",
      }).then((threadId) => {
        if (this.#chatPetId === pendingPetId) this.#chatThreadId = threadId;
        return threadId;
      });
      this.#chatThreadPromise = pending;
      void pending.catch(() => {
        if (this.#chatThreadPromise === pending) this.#chatThreadPromise = null;
      });
    }
    return this.#chatThreadPromise;
  }

  async #startThread({
    cwd = this.cwd,
    ephemeral,
    approvalPolicy,
    sandbox,
    developerInstructions,
    serviceName,
  }) {
    return this.conversation.startThread({
      cwd,
      approvalPolicy,
      sandbox,
      ephemeral,
      developerInstructions,
      serviceName,
    });
  }

  async #runTurn(threadId, input) {
    return this.conversation.runTurn(threadId, input);
  }
}
