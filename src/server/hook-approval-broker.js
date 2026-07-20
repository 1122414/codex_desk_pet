import { randomUUID } from "node:crypto";
import { normalizeCodexHookApproval } from "./codex-hook.js";

const MAX_DEVICE_APPROVAL_BYTES = 96;
const MAX_DEVICE_APPROVAL_LINES = 3;

function approvalKind(toolName) {
  if (toolName === "Bash") return "command";
  if (toolName === "apply_patch") return "file-change";
  return "permission";
}

function approvalTitle(kind) {
  return {
    command: "Codex 请求执行命令",
    "file-change": "Codex 请求修改文件",
    permission: "Codex 工具请求权限",
  }[kind];
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

export class HookApprovalBroker {
  #pending = new Map();

  constructor({ store, timeoutMs = 115_000 } = {}) {
    if (!store) throw new TypeError("HookApprovalBroker requires a DeskStore");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 119_000) {
      throw new RangeError("Hook approval timeout must be between 1 and 119 seconds");
    }
    this.store = store;
    this.timeoutMs = timeoutMs;
  }

  async request(value, { signal, now = Date.now() } = {}) {
    const hook = normalizeCodexHookApproval(value, { now });
    if (!hook) throw new Error("Codex hook approval is invalid");
    const duplicate = [...this.#pending.values()].find(
      (entry) => entry.hookRequestId === hook.requestId,
    );
    if (duplicate) return duplicate.promise;

    const kind = approvalKind(hook.toolName);
    const safeToApprove = Boolean(hook.detailComplete && hook.detail);
    const id = randomUUID();
    const approval = {
      id,
      rpcId: null,
      rpcMethod: "hook/PermissionRequest",
      source: "codex-hook",
      hookRequestId: hook.requestId,
      threadId: hook.sessionId,
      turnId: hook.turnId,
      itemId: null,
      kind,
      title: approvalTitle(kind),
      command: kind === "command" ? hook.detail : null,
      cwd: null,
      reason: hook.reason,
      networkHost: null,
      grantRoot: null,
      filePaths: [],
      requestedPermissions: null,
      permissionSummary: kind === "permission" ? hook.detail : null,
      displayDetail: hook.detail ?? "",
      availableDecisions: ["accept", "decline"],
      safeToApprove,
      ...deviceApproval(hook.detail, safeToApprove),
    };

    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = {
      approvalId: id,
      hookRequestId: hook.requestId,
      promise,
      settle,
      timer: null,
      abort: null,
      signal,
    };
    entry.timer = setTimeout(() => this.#finish(entry, null, "timeout"), this.timeoutMs);
    entry.timer.unref?.();
    if (signal) {
      entry.abort = () => this.#finish(entry, null, "cancelled");
      signal.addEventListener("abort", entry.abort, { once: true });
    }
    this.#pending.set(id, entry);
    this.store.addApproval(approval);
    this.store.handleCodexHook(value, now);
    return promise;
  }

  decide(id, decision) {
    if (!["accept", "decline"].includes(decision)) {
      throw new RangeError("Only accept or decline is allowed");
    }
    const entry = this.#pending.get(id);
    const approval = this.store.getApproval(id);
    if (!entry || !approval || approval.status !== "pending") {
      throw new Error("Approval request is no longer pending");
    }
    if (decision === "accept" && !approval.safeToApprove) {
      throw new Error("Approval details are incomplete; accept is disabled");
    }
    this.#finish(entry, decision, decision);
    return { ...approval, decision };
  }

  close() {
    for (const entry of [...this.#pending.values()]) {
      this.#finish(entry, null, "connection-lost");
    }
  }

  #finish(entry, result, storeDecision) {
    if (!this.#pending.delete(entry.approvalId)) return;
    clearTimeout(entry.timer);
    if (entry.abort) {
      entry.signal?.removeEventListener("abort", entry.abort);
    }
    const approval = this.store.resolveApproval(entry.approvalId, storeDecision);
    if (result && approval) {
      const now = Date.now();
      this.store.patchThread(approval.threadId, {
        hookState: "running",
        hookPriority: 2,
        hookEvent: "PermissionDecision",
        hookUpdatedAt: now,
      });
    }
    entry.settle(result);
  }
}
