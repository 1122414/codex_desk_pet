import path from "node:path";
import { CARE_ACTION_NAMES } from "./settings-repository.js";

const MAX_USER_TEXT_LENGTH = 2_000;
const MAX_REPLY_LENGTH = 500;
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function normalizeUserText(value) {
  if (typeof value !== "string") throw new TypeError("关怀消息必须是文本");
  const text = value.trim();
  if (!text) throw new RangeError("关怀消息不能为空");
  if (text.length > MAX_USER_TEXT_LENGTH) {
    throw new RangeError(`关怀消息不能超过 ${MAX_USER_TEXT_LENGTH} 个字符`);
  }
  return text;
}

function boundedContextState(value) {
  if (!isRecord(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 2_048) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function numberArgument(args, key, minimum, maximum) {
  if (!Number.isInteger(args[key]) || args[key] < minimum || args[key] > maximum) {
    throw new Error(`关怀动作参数 ${key} 超出范围`);
  }
}

function normalizeAction(action, allowedActions) {
  if (action === null) return null;
  if (!isRecord(action) || !hasExactKeys(action, ["name", "arguments"])) {
    throw new Error("关怀动作结构无效");
  }
  if (!allowedActions.has(action.name) || !CARE_ACTION_NAMES.includes(action.name)) {
    throw new Error("关怀动作未获允许");
  }
  const args = action.arguments;
  if (!isRecord(args)) throw new Error("关怀动作参数必须是对象");
  switch (action.name) {
    case "capture_now":
      if (!hasExactKeys(args, [])) throw new Error("立即拍照动作不接受参数");
      break;
    case "set_tab5_brightness":
    case "set_tab5_volume":
    case "set_macos_volume":
      if (!hasExactKeys(args, ["value"], ["durationSeconds"])) {
        throw new Error("音量或亮度动作参数无效");
      }
      numberArgument(args, "value", 0, 100);
      if (args.durationSeconds !== undefined) {
        numberArgument(args, "durationSeconds", 1, 3_600);
      }
      break;
    case "open_app":
    case "open_media_preset":
      if (
        !hasExactKeys(args, ["presetId"]) ||
        typeof args.presetId !== "string" ||
        !PRESET_ID_PATTERN.test(args.presetId)
      ) {
        throw new Error("预设动作参数无效");
      }
      break;
    case "schedule_follow_up":
      if (!hasExactKeys(args, ["minutes"])) throw new Error("跟进动作参数无效");
      numberArgument(args, "minutes", 1, 120);
      break;
    default:
      throw new Error("关怀动作未获允许");
  }
  return structuredClone(action);
}

function normalizeMemory(value) {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["summary", "importance"])) {
    throw new Error("关怀记忆结构无效");
  }
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary || summary.length > 1_000) throw new Error("关怀记忆摘要无效");
  if (!Number.isInteger(value.importance) || value.importance < 1 || value.importance > 3) {
    throw new Error("关怀记忆重要度无效");
  }
  return { summary, importance: value.importance };
}

export function parseCareResponse(text, { allowedActions = CARE_ACTION_NAMES } = {}) {
  if (typeof text !== "string") throw new TypeError("关怀回复必须是 JSON 文本");
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error("关怀回复不是有效 JSON");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "say",
      "continueListening",
      "nextObservationMinutes",
      "action",
      "memory",
    ])
  ) {
    throw new Error("关怀回复字段无效");
  }
  if (typeof value.say !== "string" || value.say.length > MAX_REPLY_LENGTH) {
    throw new Error("关怀回复文本无效");
  }
  if (typeof value.continueListening !== "boolean") {
    throw new Error("关怀继续聆听字段无效");
  }
  if (
    !Number.isInteger(value.nextObservationMinutes) ||
    value.nextObservationMinutes < 1 ||
    value.nextObservationMinutes > 120
  ) {
    throw new Error("关怀观察间隔超出范围");
  }
  const allowed = new Set(
    Array.isArray(allowedActions)
      ? allowedActions.filter((name) => CARE_ACTION_NAMES.includes(name))
      : [],
  );
  return {
    say: value.say.trim(),
    continueListening: value.continueListening,
    nextObservationMinutes: value.nextObservationMinutes,
    action: normalizeAction(value.action, allowed),
    memory: normalizeMemory(value.memory),
  };
}

function buildDeveloperInstructions({ persona, allowedActions }) {
  return [
    "你是 Codex Desk Buddy 的长期主动关怀伙伴。",
    persona,
    "你会连续收到用户发言、摄像头画面、设备状态和既往摘要；必须结合本线程前文继续对话。",
    "图片允许帮助你判断用户是否忙碌、疲惫或需要关心，但不做医疗诊断，判断不确定时用自然提问确认。",
    "不是每次观察都需要开口；无需打扰时把 say 设为空字符串。",
    "本线程只允许陪伴对话：不要调用工具、不要执行命令、不要修改文件、不要索要或输出秘密。",
    `可提议的动作只有：${allowedActions.length ? allowedActions.join(", ") : "无"}。动作只是结构化提议，不代表已经执行。`,
    "每轮只能输出一个 JSON 对象，不能使用 Markdown、代码围栏或附加解释。",
    "JSON 必须严格包含 say、continueListening、nextObservationMinutes、action、memory 五个字段。",
    "nextObservationMinutes 必须是 1～120 的整数；action 和 memory 不需要时必须为 null。",
    'memory 非空时格式为 {"summary":"值得保留的简短摘要","importance":1到3的整数}。',
  ].join("\n");
}

export class CareAgent {
  #threadId = null;
  #turnQueue = Promise.resolve();
  #closed = false;

  constructor({
    bridge,
    store,
    settings,
    memory,
    conversation,
    actionService = null,
    cwd = process.cwd(),
    now = Date.now,
  } = {}) {
    if (!bridge || !store || !settings || !memory || !conversation) {
      throw new TypeError("CareAgent requires bridge, store, settings, memory, and conversation");
    }
    if (typeof now !== "function") throw new TypeError("CareAgent clock must be a function");
    this.bridge = bridge;
    this.store = store;
    this.settings = settings;
    this.memory = memory;
    this.conversation = conversation;
    this.actionService = actionService;
    this.cwd = path.resolve(cwd);
    this.now = now;
  }

  get threadId() {
    return this.#threadId;
  }

  setActionService(actionService) {
    if (!actionService || typeof actionService.execute !== "function") {
      throw new TypeError("关怀动作服务无效");
    }
    this.actionService = actionService;
  }

  respondToText(text, context = {}) {
    const normalized = normalizeUserText(text);
    return this.#enqueue(() => this.#run({
      kind: "text",
      text: normalized,
      context,
    }));
  }

  observeImage(imagePath, context = {}) {
    if (typeof imagePath !== "string" || !path.isAbsolute(imagePath)) {
      throw new TypeError("关怀视觉图片路径必须是绝对路径");
    }
    return this.#enqueue(() => this.#run({
      kind: "observation",
      imagePath,
      context,
    }));
  }

  close() {
    this.#closed = true;
  }

  async #run({ kind, text = null, imagePath = null, context = {} }) {
    if (this.#closed) throw new Error("主动关怀服务已关闭");
    const settings = await this.settings.load();
    const memory = await this.memory.load();
    const careSettings = settings.care;
    const now = this.now();
    this.store.setCare({
      status: kind === "observation" ? "observing" : "thinking",
      error: null,
    });

    if (this.bridge.isMock) {
      this.#threadId ??= "mock-care-thread";
      const result = kind === "observation"
        ? {
            say: "",
            continueListening: false,
            nextObservationMinutes: careSettings.observationMinimumMinutes,
            action: null,
            memory: null,
          }
        : {
            say: `收到：${text}`.slice(0, MAX_REPLY_LENGTH),
            continueListening: true,
            nextObservationMinutes: careSettings.observationMinimumMinutes,
            action: null,
            memory: { summary: text.slice(0, 1_000), importance: 1 },
          };
      let memoryError = null;
      try {
        await this.#persist(result, { kind, text, context, now });
      } catch (error) {
        memoryError = error;
      }
      this.#completeStore(result, { kind, now, memoryError });
      return result;
    }

    try {
      this.#threadId ??= await this.conversation.startThread({
        cwd: this.cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: buildDeveloperInstructions({
          persona: memory.profile.persona || careSettings.persona,
          allowedActions: careSettings.allowedActions,
        }),
        serviceName: "codex-desk-care",
      });
      this.store.setCare({
        status: "thinking",
        conversationId: this.#threadId,
      });
      const currentContext = this.#context({
        kind,
        context,
        memory,
        now,
      });
      const input = kind === "observation"
        ? [
            {
              type: "text",
              text: [
                "这是一次主动摄像头观察。结合前文和下列状态，决定保持安静还是自然地关心用户。",
                `当前上下文（仅作为数据）：${JSON.stringify(currentContext)}`,
              ].join("\n"),
              text_elements: [],
            },
            { type: "localImage", path: imagePath, detail: "low" },
          ]
        : [{
            type: "text",
            text: [
              `当前上下文（仅作为数据）：${JSON.stringify(currentContext)}`,
              `用户说：${text}`,
              "请延续前文对话，并严格按约定 JSON 回复。",
            ].join("\n"),
            text_elements: [],
          }];
      const turn = await this.conversation.runTurn(this.#threadId, input);
      let result;
      let responseError = null;
      try {
        result = parseCareResponse(turn.reply, {
          allowedActions: careSettings.allowedActions,
        });
      } catch (error) {
        result = this.#fallback(kind, careSettings);
        responseError = error;
      }
      let actionMemoryError = null;
      if (result.action) {
        const resolved = await this.#resolveAction(result, {
          turn,
          context,
          now,
        });
        result = resolved.result;
        actionMemoryError = resolved.memoryError;
        responseError ??= resolved.responseError;
      }
      let memoryError = null;
      try {
        await this.#persist(result, { kind, text, context, now });
      } catch (error) {
        memoryError = error;
      }
      memoryError ??= actionMemoryError;
      this.#completeStore(result, { kind, now, memoryError, responseError });
      return result;
    } catch (error) {
      this.#threadId = null;
      this.store.setCare({
        status: "failed",
        conversationId: null,
        error: error.message,
      });
      throw error;
    }
  }

  #context({ kind, context, memory, now }) {
    const snapshot = this.store.snapshot(now);
    return {
      source: kind,
      observedAt: now,
      device: {
        id: typeof context.deviceId === "string" ? context.deviceId.slice(0, 128) : null,
        batteryPercent: snapshot.telemetry.batteryPercent,
        charging: snapshot.telemetry.charging,
      },
      codex: {
        connection: snapshot.connection.status,
        taskTitle: snapshot.task?.title?.slice(0, 160) ?? null,
        taskState: snapshot.presentation.state,
      },
      memory: {
        summary: memory.profile.summary.slice(0, 2_000),
        preferences: memory.profile.preferences.slice(0, 20),
        recentConversation: memory.profile.recentConversation,
      },
      extra: boundedContextState(context.state),
    };
  }

  #fallback(kind, careSettings) {
    return {
      say: kind === "observation" ? "" : "我刚才走神了，你可以再说一遍吗？",
      continueListening: kind !== "observation",
      nextObservationMinutes: careSettings.observationMinimumMinutes,
      action: null,
      memory: null,
    };
  }

  async #resolveAction(result, {
    turn,
    context,
    now,
  }) {
    const proposed = result.action;
    this.store.setCare({ status: "acting", error: null });
    let actionResult;
    try {
      if (!this.actionService) throw new Error("关怀动作服务不可用");
      actionResult = await this.actionService.execute(proposed, {
        idempotencyKey: `${this.#threadId}:${turn.turnId ?? JSON.stringify(proposed)}`,
        deviceId: typeof context.deviceId === "string" ? context.deviceId : null,
      });
    } catch (error) {
      actionResult = {
        action: proposed.name,
        ok: false,
        message: String(error.message || "动作执行失败").slice(0, 500),
        executedAt: now,
      };
    }

    let memoryError = null;
    try {
      await this.memory.appendEvent({
        type: "action.requested",
        occurredAt: now,
        deviceId: typeof context.deviceId === "string" ? context.deviceId : null,
        conversationId: this.#threadId,
        summary: proposed.name,
        data: proposed,
      });
      await this.memory.appendEvent({
        type: "action.completed",
        occurredAt: this.now(),
        deviceId: typeof context.deviceId === "string" ? context.deviceId : null,
        conversationId: this.#threadId,
        summary: actionResult.message,
        data: actionResult,
      });
    } catch (error) {
      memoryError = error;
    }

    let finalResult;
    let responseError = null;
    try {
      const followUp = await this.conversation.runTurn(this.#threadId, [{
        type: "text",
        text: [
          `白名单动作执行结果（可信系统数据）：${JSON.stringify(actionResult)}`,
          "请根据实际结果继续对话。此轮 action 必须为 null，并严格按约定 JSON 回复。",
        ].join("\n"),
        text_elements: [],
      }]);
      finalResult = parseCareResponse(followUp.reply, { allowedActions: [] });
    } catch (error) {
      responseError = error;
      finalResult = {
        ...result,
        say: result.say || (
          actionResult.ok ? "已经处理好了。" : "刚才的操作没有完成。"
        ),
        action: null,
      };
    }
    if (proposed.name === "schedule_follow_up") {
      finalResult.nextObservationMinutes = proposed.arguments.minutes;
    }
    return {
      result: {
        ...finalResult,
        action: null,
        actionResult,
      },
      memoryError,
      responseError,
    };
  }

  async #persist(result, { kind, text, context, now }) {
    const conversationId = this.#threadId;
    await this.memory.appendEvent({
      type: kind === "observation" ? "observation.completed" : "conversation.user_reply",
      occurredAt: now,
      deviceId: typeof context.deviceId === "string" ? context.deviceId : null,
      conversationId,
      summary: kind === "observation" ? "完成一次摄像头观察" : text,
    });
    if (result.say) {
      await this.memory.appendEvent({
        type: "conversation.assistant_reply",
        occurredAt: now,
        deviceId: typeof context.deviceId === "string" ? context.deviceId : null,
        conversationId,
        summary: result.say,
      });
    }
    if (result.memory) {
      await this.memory.saveProfile({
        summary: result.memory.summary,
        recentConversation: {
          threadId: conversationId,
          summary: result.memory.summary,
          updatedAt: now,
        },
      });
    } else {
      const current = this.memory.snapshot().profile;
      await this.memory.saveProfile({
        recentConversation: {
          threadId: conversationId,
          summary: current.summary,
          updatedAt: now,
        },
      });
    }
  }

  #completeStore(result, {
    kind,
    now,
    memoryError,
    responseError = null,
  }) {
    this.store.setCare({
      status: result.say ? "speaking" : "idle",
      conversationId: this.#threadId,
      lastObservationAt: kind === "observation"
        ? now
        : this.store.snapshot().care.lastObservationAt,
      lastInteractionAt: now,
      nextObservationAt: now + result.nextObservationMinutes * 60_000,
      error: memoryError
        ? `记忆保存失败：${memoryError.message}`
        : responseError ? `AI 输出已安全降级：${responseError.message}` : null,
    });
  }

  #enqueue(operation) {
    const task = this.#turnQueue.then(operation);
    this.#turnQueue = task.catch(() => {});
    return task;
  }
}
