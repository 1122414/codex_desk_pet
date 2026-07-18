import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JsonRpcClient } from "./json-rpc-client.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

function filePathsFromItem(item) {
  if (item?.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  return item.changes.map((change) => change.path).filter((value) => typeof value === "string");
}

function normalizeApproval(message, relatedItem = null) {
  const params = message.params ?? {};
  const isLegacyCommand = message.method === "execCommandApproval";
  const isCommand = message.method === "item/commandExecution/requestApproval" || isLegacyCommand;
  const threadId = params.threadId ?? params.conversationId ?? "unknown";
  const command = isLegacyCommand && Array.isArray(params.command) ? params.command.join(" ") : params.command;
  const filePaths = params.fileChanges ? Object.keys(params.fileChanges) : filePathsFromItem(relatedItem);
  const declaredDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((decision) => typeof decision === "string" && ["accept", "decline"].includes(decision))
    : ["accept", "decline"];
  const availableDecisions = declaredDecisions.includes("decline") ? declaredDecisions : [...declaredDecisions, "decline"];
  const safeToApprove = isCommand ? Boolean(command?.trim()) : Boolean(filePaths.length || params.grantRoot);
  return {
    id: randomUUID(),
    rpcId: message.id,
    rpcMethod: message.method,
    threadId,
    turnId: params.turnId ?? null,
    itemId: params.itemId ?? params.callId ?? null,
    kind: isCommand ? "command" : "file-change",
    title: isCommand ? "Codex 请求执行命令" : "Codex 请求修改文件",
    command: typeof command === "string" ? command : null,
    cwd: params.cwd ?? null,
    reason: params.reason ?? null,
    grantRoot: params.grantRoot ?? null,
    filePaths,
    availableDecisions,
    safeToApprove,
  };
}

export class CodexBridge extends EventEmitter {
  #pollTimer = null;
  #requestMap = new Map();

  constructor({ store, mode = "direct", pollIntervalMs = 2_500, client = null } = {}) {
    super();
    if (!store) throw new TypeError("CodexBridge requires a DeskStore");
    this.store = store;
    this.mode = mode;
    this.pollIntervalMs = pollIntervalMs;
    this.client = client;
  }

  get isMock() {
    return this.mode === "mock";
  }

  async start() {
    if (this.isMock) {
      this.store.setConnection({ status: "connected", mode: "mock", error: null });
      this.store.replaceThreads([{
        id: "mock-thread",
        name: "制作 Codex Desk Buddy MVP",
        preview: "制作 Codex Desk Buddy MVP",
        createdAt: Date.now() / 1_000 - 300,
        updatedAt: Date.now() / 1_000,
        status: { type: "active", activeFlags: [] },
        lastTurn: { id: "mock-turn", status: "inProgress" },
        tokenUsage: { total: { totalTokens: 12_840 } },
      }]);
      return;
    }

    this.store.setConnection({ status: "connecting", mode: this.mode, error: null });
    this.client ??= new JsonRpcClient({ mode: this.mode });
    this.client.on("notification", (method, params) => this.#handleNotification(method, params));
    this.client.on("request", (message) => this.#handleServerRequest(message));
    this.client.on("diagnostic", (message) => this.emit("diagnostic", message));
    this.client.on("error", (error) => this.#handleDisconnect(error));
    this.client.on("exit", () => this.#handleDisconnect(new Error("Codex App Server disconnected")));

    try {
      await this.client.start();
      this.store.setConnection({ status: "connected", mode: this.mode, error: null });
      await this.refreshThreads();
      this.#pollTimer = setInterval(() => {
        this.refreshThreads().catch((error) => this.emit("diagnostic", error.message));
      }, this.pollIntervalMs);
      this.#pollTimer.unref?.();
    } catch (error) {
      this.store.setConnection({ status: "error", mode: this.mode, error: error.message });
      throw error;
    }
  }

  async refreshThreads() {
    if (this.isMock) return;
    const response = await this.client.request("thread/list", {
      limit: 30,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    });
    this.store.replaceThreads(response?.data ?? []);
  }

  async decideApproval(id, decision) {
    if (!["accept", "decline"].includes(decision)) throw new RangeError("Only accept or decline is allowed");
    const approval = this.store.getApproval(id);
    if (!approval || approval.status !== "pending") throw new Error("Approval request is no longer pending");
    if (!approval.availableDecisions.includes(decision)) throw new Error("Approval decision is not offered by Codex");
    if (decision === "accept" && !approval.safeToApprove) throw new Error("Approval details are incomplete; accept is disabled");

    if (!this.isMock) {
      const request = this.#requestMap.get(id);
      if (!request || request.rpcId !== approval.rpcId) throw new Error("Approval request cannot be safely correlated");
      const legacy = request.method === "execCommandApproval" || request.method === "applyPatchApproval";
      const wireDecision = legacy
        ? (decision === "accept" ? "approved" : "denied")
        : decision;
      this.client.respond(request.rpcId, { decision: wireDecision });
      this.#requestMap.delete(id);
    }

    return this.store.resolveApproval(id, decision);
  }

  createMockApproval() {
    if (!this.isMock) throw new Error("Mock approvals are only available in mock mode");
    const approval = {
      id: randomUUID(),
      rpcId: "mock-rpc",
      rpcMethod: "item/commandExecution/requestApproval",
      threadId: "mock-thread",
      turnId: "mock-turn",
      itemId: "mock-item",
      kind: "command",
      title: "Codex 请求执行命令",
      command: "npm test",
      cwd: process.cwd(),
      reason: "运行项目测试",
      grantRoot: null,
      filePaths: [],
      availableDecisions: ["accept", "decline"],
      safeToApprove: true,
    };
    this.store.addApproval(approval);
    return approval;
  }

  async stop() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    await this.client?.stop();
    this.store.setConnection({ status: "disconnected", error: null });
  }

  #handleServerRequest(message) {
    if (APPROVAL_METHODS.has(message.method)) {
      const relatedItem = this.store.getThread(message.params?.threadId ?? message.params?.conversationId)?.lastItem;
      const approval = normalizeApproval(message, relatedItem);
      this.#requestMap.set(approval.id, { rpcId: message.id, method: message.method });
      this.store.addApproval(approval);
      if (!approval.safeToApprove && !this.isMock && approval.threadId !== "unknown") {
        this.#enrichApproval(approval).catch((error) => this.emit("diagnostic", `Approval detail lookup failed: ${error.message}`));
      }
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      this.store.setPendingUserInput({
        id: randomUUID(),
        rpcId: message.id,
        threadId: message.params?.threadId,
        title: "Codex 需要更多信息",
        questions: message.params?.questions ?? [],
        respondOnComputer: true,
      });
      return;
    }
    this.client.respondError(message.id, -32601, `Codex Desk Buddy does not handle ${message.method}`);
  }

  #handleNotification(method, params) {
    if (method === "serverRequest/resolved") {
      for (const [id, request] of this.#requestMap) {
        if (String(request.rpcId) === String(params.requestId)) {
          this.#requestMap.delete(id);
          this.store.resolveApproval(id, "resolved-elsewhere");
          break;
        }
      }
      this.store.clearPendingUserInput(params.requestId);
    }
    this.store.handleNotification(method, params);
  }

  async #enrichApproval(approval) {
    const response = await this.client.request("thread/read", { threadId: approval.threadId, includeTurns: true });
    const items = (response?.thread?.turns ?? []).flatMap((turn) => turn.items ?? []);
    const item = items.find((candidate) => candidate.id === approval.itemId);
    const filePaths = filePathsFromItem(item);
    if (filePaths.length) this.store.updateApproval(approval.id, { filePaths, safeToApprove: true });
  }

  #handleDisconnect(error) {
    this.store.setConnection({ status: "error", mode: this.mode, error: error.message });
  }
}
