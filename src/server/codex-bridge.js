import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JsonRpcClient } from "./json-rpc-client.js";
import { readLatestSessionTokenUsage } from "./session-token-reader.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);
const MAX_DEVICE_APPROVAL_BYTES = 96;
const MAX_DEVICE_APPROVAL_LINES = 3;

function filePathsFromItem(item) {
  if (item?.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  return item.changes.map((change) => change.path).filter((value) => typeof value === "string");
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function summarizePermissionPath(path) {
  if (!isPlainObject(path)) return null;
  if (path.type === "path" && typeof path.path === "string" && path.path) {
    return path.path;
  }
  if (
    path.type === "glob_pattern" &&
    typeof path.pattern === "string" &&
    path.pattern
  ) {
    return `匹配 ${path.pattern}`;
  }
  if (path.type === "special" && isPlainObject(path.value)) {
    const suffix = typeof path.value.subpath === "string" && path.value.subpath
      ? `/${path.value.subpath}`
      : "";
    if (path.value.kind === "unknown" && typeof path.value.path === "string") {
      return `${path.value.path}${suffix}`;
    }
    if (typeof path.value.kind === "string" && path.value.kind) {
      return `${path.value.kind}${suffix}`;
    }
  }
  return null;
}

function summarizePermissions(profile) {
  if (!isPlainObject(profile)) {
    return { valid: false, lines: [], summary: "" };
  }
  if (Object.keys(profile).some((key) => !["fileSystem", "network"].includes(key))) {
    return { valid: false, lines: [], summary: "" };
  }
  const lines = [];
  if (profile.network !== undefined && profile.network !== null) {
    if (
      !isPlainObject(profile.network) ||
      Object.keys(profile.network).some((key) => key !== "enabled") ||
      ![true, false, null, undefined].includes(profile.network.enabled)
    ) {
      return { valid: false, lines: [], summary: "" };
    }
    if (profile.network.enabled === true) lines.push("网络访问");
  }
  if (profile.fileSystem !== undefined && profile.fileSystem !== null) {
    const fileSystem = profile.fileSystem;
    if (
      !isPlainObject(fileSystem) ||
      Object.keys(fileSystem).some((key) =>
        !["entries", "globScanMaxDepth", "read", "write"].includes(key))
    ) {
      return { valid: false, lines: [], summary: "" };
    }
    if (
      fileSystem.globScanMaxDepth !== undefined &&
      fileSystem.globScanMaxDepth !== null &&
      (!Number.isSafeInteger(fileSystem.globScanMaxDepth) ||
        fileSystem.globScanMaxDepth < 1)
    ) {
      return { valid: false, lines: [], summary: "" };
    }
    for (const [access, label] of [["read", "读"], ["write", "写"]]) {
      const paths = fileSystem[access];
      if (paths === undefined || paths === null) continue;
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path)) {
        return { valid: false, lines: [], summary: "" };
      }
      for (const path of paths) lines.push(`${label} ${path}`);
    }
    if (fileSystem.entries !== undefined && fileSystem.entries !== null) {
      if (!Array.isArray(fileSystem.entries)) {
        return { valid: false, lines: [], summary: "" };
      }
      for (const entry of fileSystem.entries) {
        const path = summarizePermissionPath(entry?.path);
        const label = { read: "读", write: "写", deny: "拒" }[entry?.access];
        if (!path || !label || Object.keys(entry).some((key) => !["access", "path"].includes(key))) {
          return { valid: false, lines: [], summary: "" };
        }
        lines.push(`${label} ${path}`);
      }
    }
  }
  return {
    valid: true,
    lines,
    summary: lines.join(" · "),
  };
}

function deviceApproval(detail, safeToApprove) {
  const lines = typeof detail === "string" ? detail.split("\n") : [];
  const complete =
    safeToApprove &&
    lines.length > 0 &&
    lines.length <= MAX_DEVICE_APPROVAL_LINES &&
    Buffer.byteLength(detail) <= MAX_DEVICE_APPROVAL_BYTES;
  return {
    deviceDetail: typeof detail === "string" ? detail : "",
    deviceSafeToApprove: complete,
  };
}

function normalizeApproval(message, relatedItem = null) {
  const params = message.params ?? {};
  const isLegacyCommand = message.method === "execCommandApproval";
  const isCommand = message.method === "item/commandExecution/requestApproval" || isLegacyCommand;
  const isPermission = message.method === "item/permissions/requestApproval";
  const threadId = params.threadId ?? params.conversationId ?? "unknown";
  const actionCommands = Array.isArray(params.commandActions)
    ? params.commandActions.map((action) => action?.command).filter((value) => typeof value === "string" && value.trim())
    : [];
  const declaredCommand = isLegacyCommand && Array.isArray(params.command) ? params.command.join(" ") : params.command;
  const command = typeof declaredCommand === "string" && declaredCommand.trim()
    ? declaredCommand
    : actionCommands.join("\n");
  const filePaths = params.fileChanges ? Object.keys(params.fileChanges) : filePathsFromItem(relatedItem);
  const declaredDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((decision) => typeof decision === "string" && ["accept", "decline"].includes(decision))
    : ["accept", "decline"];
  const availableDecisions = declaredDecisions.includes("decline") ? declaredDecisions : [...declaredDecisions, "decline"];
  const requestedPermissions = isPermission && isPlainObject(params.permissions)
    ? structuredClone(params.permissions)
    : null;
  const permissionDetails = summarizePermissions(
    isPermission ? params.permissions : params.additionalPermissions,
  );
  const hasAdditionalPermissions = params.additionalPermissions !== undefined &&
    params.additionalPermissions !== null;
  const networkHost = params.networkApprovalContext?.host ?? null;
  const isNetwork = Boolean(
    isCommand &&
    !command?.trim() &&
    typeof networkHost === "string" &&
    networkHost,
  );
  const kind = isPermission
    ? "permission"
    : isNetwork ? "network" : isCommand ? "command" : "file-change";
  const title = {
    command: "Codex 请求执行命令",
    network: "Codex 请求访问网络",
    "file-change": "Codex 请求修改文件",
    permission: "Codex 请求额外权限",
  }[kind];
  const detailLines = isPermission
    ? permissionDetails.lines
    : isCommand
      ? [
          command?.trim() || (isNetwork ? `网络 ${networkHost}` : ""),
          ...(hasAdditionalPermissions ? permissionDetails.lines : []),
        ].filter(Boolean)
      : [...filePaths, ...(!filePaths.length && params.grantRoot ? [params.grantRoot] : [])];
  const displayDetail = isPermission
    ? permissionDetails.summary
    : detailLines.join("\n");
  const safeToApprove = isPermission
    ? Boolean(requestedPermissions && permissionDetails.valid && permissionDetails.lines.length)
    : isCommand
      ? Boolean(
          (command?.trim() || isNetwork) &&
          (!hasAdditionalPermissions || permissionDetails.valid),
        )
      : Boolean(filePaths.length || params.grantRoot);
  return {
    id: randomUUID(),
    rpcId: message.id,
    rpcMethod: message.method,
    threadId,
    turnId: params.turnId ?? null,
    itemId: params.itemId ?? params.callId ?? null,
    kind,
    title,
    command: typeof command === "string" ? command : null,
    cwd: params.cwd ?? null,
    reason: params.reason ?? null,
    networkHost,
    grantRoot: params.grantRoot ?? null,
    filePaths,
    requestedPermissions,
    permissionSummary: permissionDetails.summary || null,
    displayDetail,
    availableDecisions,
    safeToApprove,
    ...deviceApproval(displayDetail, safeToApprove),
  };
}

export class CodexBridge extends EventEmitter {
  #pollTimer = null;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #connectPromise = null;
  #requestMap = new Map();
  #clientBound = false;
  #started = false;
  #stopping = false;
  #lastAccountRefreshAt = 0;
  #lastGoalRefreshAt = 0;

  constructor({
    store,
    mode = "direct",
    pollIntervalMs = 2_500,
    client = null,
    reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000],
    reconnectJitterRatio = 0.2,
    random = Math.random,
    hookApprovalBroker = null,
    accountRefreshIntervalMs = 60_000,
    goalRefreshIntervalMs = 12_000,
    sessionTokenReader = readLatestSessionTokenUsage,
  } = {}) {
    super();
    if (!store) throw new TypeError("CodexBridge requires a DeskStore");
    if (!Array.isArray(reconnectDelaysMs) || reconnectDelaysMs.length === 0) {
      throw new TypeError("reconnectDelaysMs must contain at least one delay");
    }
    this.store = store;
    this.mode = mode;
    this.pollIntervalMs = pollIntervalMs;
    this.client = client;
    this.reconnectDelaysMs = reconnectDelaysMs;
    this.reconnectJitterRatio = reconnectJitterRatio;
    this.random = random;
    this.hookApprovalBroker = hookApprovalBroker;
    this.accountRefreshIntervalMs = accountRefreshIntervalMs;
    this.goalRefreshIntervalMs = goalRefreshIntervalMs;
    this.sessionTokenReader = sessionTokenReader;
    this.initialization = null;
  }

  get isMock() {
    return this.mode === "mock";
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    if (this.isMock) {
      this.initialization = { userAgent: "codex-desk-mock" };
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

    this.client ??= new JsonRpcClient({ mode: this.mode });
    this.#bindClient();
    try {
      await this.#connect();
    } catch (error) {
      this.#handleDisconnect(error);
      throw error;
    }
  }

  async #connect() {
    if (this.#connectPromise) return this.#connectPromise;
    const connecting = this.#connectOnce();
    this.#connectPromise = connecting;
    try {
      return await connecting;
    } finally {
      if (this.#connectPromise === connecting) this.#connectPromise = null;
    }
  }

  async #connectOnce() {
    if (this.#stopping || !this.#started) return;
    this.store.setConnection({
      status: this.#reconnectAttempt ? "reconnecting" : "connecting",
      mode: this.mode,
      error: null,
    });
    this.initialization = await this.client.start();
    if (this.#stopping || !this.#started) return;
    await this.refreshThreads();
    if (this.#stopping || !this.#started) return;
    this.#reconnectAttempt = 0;
    this.store.setConnection({ status: "connected", mode: this.mode, error: null });
    this.#startPolling();
  }

  #bindClient() {
    if (this.#clientBound) return;
    this.#clientBound = true;
    this.client.on("notification", (method, params) => this.#handleNotification(method, params));
    this.client.on("request", (message) => this.#handleServerRequest(message));
    this.client.on("diagnostic", (message) => this.emit("diagnostic", message));
    this.client.on("error", (error) => this.#handleDisconnect(error));
    this.client.on("exit", (_code, _signal, details = {}) => {
      if (!details.intentional) this.#handleDisconnect(new Error("Codex App Server disconnected"));
    });
  }

  async refreshThreads() {
    if (this.isMock) return;
    if (!this.client?.running) throw new Error("Codex App Server is not running");
    const response = await this.client.request("thread/list", {
      limit: 30,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    });
    const threads = response?.data ?? [];
    this.store.replaceThreads(threads);
    await Promise.all([
      this.#refreshAccountData(),
      this.#refreshGoals(threads),
      this.#refreshSessionTokens(threads),
    ]);
  }

  async #refreshSessionTokens(threads) {
    const candidates = (threads ?? [])
      .filter((thread) => typeof thread?.id === "string" && thread.id && thread.path)
      .slice(0, 12);
    const results = await Promise.allSettled(
      candidates.map((thread) => this.sessionTokenReader(thread.path)),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const totalTokens = result.value?.totalTokens;
        if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return;
        this.store.patchThread(
          candidates[index].id,
          {
            tokenUsage: {
              total: { totalTokens },
              observedAt: result.value.observedAt ?? 0,
            },
          },
          { touchActivity: false },
        );
      } else {
        this.emit(
          "diagnostic",
          `Session token lookup failed for ${candidates[index].id}: ${result.reason.message}`,
        );
      }
    });
  }

  async #refreshAccountData(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.#lastAccountRefreshAt &&
      now - this.#lastAccountRefreshAt < this.accountRefreshIntervalMs
    ) return;
    this.#lastAccountRefreshAt = now;
    const [rateLimits, usage] = await Promise.allSettled([
      this.client.request("account/rateLimits/read", {}),
      this.client.request("account/usage/read", {}),
    ]);
    if (rateLimits.status === "fulfilled") {
      this.store.setRateLimits(rateLimits.value);
    } else {
      this.emit("diagnostic", `Rate-limit lookup failed: ${rateLimits.reason.message}`);
    }
    if (usage.status === "fulfilled") {
      this.store.setAccountUsage(usage.value);
    } else {
      this.emit("diagnostic", `Account usage lookup failed: ${usage.reason.message}`);
    }
  }

  async #refreshGoals(threads, force = false) {
    const now = Date.now();
    if (
      !force &&
      this.#lastGoalRefreshAt &&
      now - this.#lastGoalRefreshAt < this.goalRefreshIntervalMs
    ) return;
    this.#lastGoalRefreshAt = now;
    const candidates = (threads ?? [])
      .filter((thread) => typeof thread?.id === "string" && thread.id)
      .slice(0, 12);
    const results = await Promise.allSettled(
      candidates.map((thread) => this.client.request("thread/goal/get", { threadId: thread.id })),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        this.store.patchThread(
          candidates[index].id,
          { goal: result.value?.goal ?? null },
          { touchActivity: false },
        );
      } else {
        this.emit(
          "diagnostic",
          `Goal lookup failed for ${candidates[index].id}: ${result.reason.message}`,
        );
      }
    });
  }

  async decideApproval(id, decision) {
    if (!["accept", "decline"].includes(decision)) throw new RangeError("Only accept or decline is allowed");
    const approval = this.store.getApproval(id);
    if (!approval || approval.status !== "pending") throw new Error("Approval request is no longer pending");
    if (!approval.availableDecisions.includes(decision)) throw new Error("Approval decision is not offered by Codex");
    if (decision === "accept" && !approval.safeToApprove) throw new Error("Approval details are incomplete; accept is disabled");
    if (approval.source === "codex-hook") {
      if (!this.hookApprovalBroker) throw new Error("Codex hook approval broker is unavailable");
      return this.hookApprovalBroker.decide(id, decision);
    }

    if (!this.isMock) {
      const request = this.#requestMap.get(id);
      if (!request || request.rpcId !== approval.rpcId) throw new Error("Approval request cannot be safely correlated");
      if (request.method === "item/permissions/requestApproval") {
        this.client.respond(request.rpcId, {
          permissions: decision === "accept"
            ? structuredClone(approval.requestedPermissions)
            : {},
          scope: "turn",
        });
      } else {
        const legacy = request.method === "execCommandApproval" || request.method === "applyPatchApproval";
        const wireDecision = legacy
          ? (decision === "accept" ? "approved" : "denied")
          : decision;
        this.client.respond(request.rpcId, { decision: wireDecision });
      }
      this.#requestMap.delete(id);
    }

    return this.store.resolveApproval(id, decision);
  }

  diagnostics() {
    return {
      mode: this.mode,
      connected: this.store.snapshot().connection.status === "connected",
      appServerUserAgent: this.initialization?.userAgent ?? null,
      approvalMethods: [...APPROVAL_METHODS],
    };
  }

  createMockApproval() {
    if (!this.isMock) throw new Error("Mock approvals are only available in mock mode");
    const approval = {
      id: randomUUID(),
      rpcId: "mock-rpc",
      rpcMethod: "item/commandExecution/requestApproval",
      source: "mock",
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
      requestedPermissions: null,
      permissionSummary: null,
      displayDetail: "npm test",
      availableDecisions: ["accept", "decline"],
      safeToApprove: true,
      ...deviceApproval("npm test", true),
    };
    this.store.addApproval(approval);
    return approval;
  }

  async stop() {
    this.#stopping = true;
    this.#started = false;
    this.#clearPolling();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#expirePendingRequests();
    await this.client?.stop();
    this.initialization = null;
    this.#lastAccountRefreshAt = 0;
    this.#lastGoalRefreshAt = 0;
    this.store.setConnection({ status: "disconnected", mode: this.mode, error: null });
  }

  #handleServerRequest(message) {
    if (APPROVAL_METHODS.has(message.method)) {
      const relatedItem = this.store.getThread(message.params?.threadId ?? message.params?.conversationId)?.lastItem;
      const approval = normalizeApproval(message, relatedItem);
      approval.source = "app-server";
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
    if (filePaths.length) {
      const displayDetail = filePaths.join("\n");
      this.store.updateApproval(approval.id, {
        filePaths,
        displayDetail,
        safeToApprove: true,
        ...deviceApproval(displayDetail, true),
      });
    }
  }

  #handleDisconnect(error) {
    if (this.#stopping || !this.#started) return;
    this.#clearPolling();
    this.#expirePendingRequests();
    this.store.setConnection({ status: "reconnecting", mode: this.mode, error: error.message });
    this.#scheduleReconnect();
  }

  #startPolling() {
    this.#clearPolling();
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) return;
    this.#pollTimer = setInterval(() => {
      this.refreshThreads().catch((error) => this.#handleDisconnect(error));
    }, this.pollIntervalMs);
    this.#pollTimer.unref?.();
  }

  #clearPolling() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer || this.#stopping || !this.#started) return;
    const index = Math.min(this.#reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const baseDelay = Math.max(0, Number(this.reconnectDelaysMs[index]) || 0);
    const jitter = baseDelay * this.reconnectJitterRatio * ((this.random() * 2) - 1);
    const delay = Math.max(0, Math.round(baseDelay + jitter));
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect().catch((error) => this.#handleDisconnect(error));
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #expirePendingRequests() {
    this.#requestMap.clear();
    this.store.clearApprovals(
      "connection-lost",
      (approval) => approval.source !== "codex-hook",
    );
    this.store.clearPendingUserInput();
  }
}
