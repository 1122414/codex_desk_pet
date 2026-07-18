import { EventEmitter } from "node:events";
import {
  computeLevel,
  extractTotalTokens,
  mapThreadToPresentation,
  selectDisplayThread,
  summarizeThread,
} from "../shared/codex-state.js";
import { getAnimation } from "../shared/pet-spec.js";

const DEFAULT_TELEMETRY = Object.freeze({
  batteryPercent: 100,
  charging: true,
  transport: "simulator",
  wifiRssi: null,
  lastSeenAt: null,
});

function serializeApproval(approval) {
  if (!approval) return null;
  const { rpcId: _rpcId, ...publicApproval } = approval;
  return { ...publicApproval };
}

function serializeUserInput(request) {
  if (!request) return null;
  const { rpcId: _rpcId, ...publicRequest } = request;
  return { ...publicRequest };
}

export class DeskStore extends EventEmitter {
  #revision = 0;
  #threads = new Map();
  #approvals = new Map();

  constructor({ selectedPetId = "codex-core", tokensPerLevel = 50_000 } = {}) {
    super();
    this.selectedPetId = selectedPetId;
    this.tokensPerLevel = tokensPerLevel;
    this.connection = { status: "disconnected", mode: "direct", error: null };
    this.telemetry = { ...DEFAULT_TELEMETRY };
    this.pendingUserInput = null;
    this.previewAnimation = null;
  }

  get revision() {
    return this.#revision;
  }

  setConnection(connection) {
    this.connection = { ...this.connection, ...connection };
    this.#changed("connection");
  }

  replaceThreads(threads) {
    const next = new Map();
    for (const thread of threads ?? []) {
      const existing = this.#threads.get(thread.id) ?? {};
      next.set(thread.id, { ...existing, ...thread });
    }
    for (const approval of this.#approvals.values()) {
      const thread = next.get(approval.threadId) ?? this.#threads.get(approval.threadId) ?? {
        id: approval.threadId,
        preview: approval.title,
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [],
      };
      next.set(approval.threadId, { ...thread, pendingApproval: true });
    }
    this.#threads = next;
    this.#changed("threads");
  }

  upsertThread(thread) {
    if (!thread?.id) return;
    this.#threads.set(thread.id, { ...(this.#threads.get(thread.id) ?? {}), ...thread, lastEventAt: Date.now() });
    this.#changed("thread");
  }

  patchThread(id, patch) {
    const existing = this.#threads.get(id) ?? { id, preview: "", status: { type: "notLoaded" }, turns: [] };
    this.#threads.set(id, { ...existing, ...patch, lastEventAt: Date.now() });
    this.#changed("thread");
  }

  handleNotification(method, params = {}) {
    switch (method) {
      case "thread/started":
        this.upsertThread(params.thread);
        return;
      case "thread/status/changed":
        this.patchThread(params.threadId, { status: params.status });
        return;
      case "turn/started":
      case "turn/completed":
        this.patchThread(params.threadId, { lastTurn: params.turn, reviewing: false });
        return;
      case "item/started":
      case "item/completed": {
        const reviewing = params.item?.type === "enteredReviewMode"
          ? true
          : params.item?.type === "exitedReviewMode" ? false : undefined;
        this.patchThread(params.threadId, {
          ...(reviewing === undefined ? {} : { reviewing }),
          lastItem: params.item,
        });
        return;
      }
      case "thread/tokenUsage/updated":
        this.patchThread(params.threadId, { tokenUsage: params.tokenUsage });
        return;
      case "thread/closed":
      case "thread/deleted":
        this.#threads.delete(params.threadId);
        this.#changed("thread");
        return;
      default:
    }
  }

  addApproval(approval) {
    this.#approvals.set(approval.id, { ...approval, status: "pending", receivedAt: Date.now() });
    this.patchThread(approval.threadId, { pendingApproval: true });
  }

  getApproval(id) {
    const approval = this.#approvals.get(id);
    return approval ? { ...approval } : null;
  }

  updateApproval(id, patch) {
    const approval = this.#approvals.get(id);
    if (!approval) return false;
    this.#approvals.set(id, { ...approval, ...patch });
    this.#changed("approval");
    return true;
  }

  getThread(id) {
    const thread = this.#threads.get(id);
    return thread ? { ...thread } : null;
  }

  resolveApproval(id, decision) {
    const approval = this.#approvals.get(id);
    if (!approval) return null;
    this.#approvals.delete(id);
    const stillPending = [...this.#approvals.values()].some((candidate) => candidate.threadId === approval.threadId);
    this.patchThread(approval.threadId, { pendingApproval: stillPending });
    this.#changed("approval");
    return { ...approval, decision };
  }

  setPendingUserInput(request) {
    this.pendingUserInput = request;
    if (request?.threadId) this.patchThread(request.threadId, { pendingUserInput: true });
    else this.#changed("user-input");
  }

  clearPendingUserInput(requestId) {
    if (!this.pendingUserInput || String(this.pendingUserInput.rpcId) !== String(requestId)) return false;
    const threadId = this.pendingUserInput.threadId;
    this.pendingUserInput = null;
    if (threadId) this.patchThread(threadId, { pendingUserInput: false });
    else this.#changed("user-input");
    return true;
  }

  setSelectedPet(id) {
    if (id === this.selectedPetId) return;
    this.selectedPetId = id;
    this.#changed("pet");
  }

  setTelemetry(telemetry) {
    this.telemetry = { ...this.telemetry, ...telemetry, lastSeenAt: Date.now() };
    this.#changed("telemetry");
  }

  setPreviewAnimation(animation) {
    if (animation !== null) getAnimation(animation);
    this.previewAnimation = animation;
    this.#changed("preview");
  }

  snapshot(now = Date.now()) {
    const threads = [...this.#threads.values()];
    const selected = selectDisplayThread(threads, { now });
    const mapped = selected ? mapThreadToPresentation(selected, { now }) : { state: "ready", animation: "idle" };
    const totalTokens = extractTotalTokens(selected?.tokenUsage);
    const level = computeLevel(totalTokens, this.tokensPerLevel);
    const previewBlocked = mapped.state === "needs-input" || mapped.state === "blocked";
    const previewing = this.previewAnimation !== null && !previewBlocked;
    const approval = selected
      ? [...this.#approvals.values()].find((candidate) => candidate.threadId === selected.id)
      : [...this.#approvals.values()][0];

    return {
      revision: this.#revision,
      emittedAt: now,
      connection: { ...this.connection },
      presentation: {
        state: mapped.state,
        animation: previewing ? this.previewAnimation : mapped.animation,
        previewing,
      },
      task: selected ? {
        id: selected.id,
        title: summarizeThread(selected),
        updatedAt: selected.updatedAt ?? selected.recencyAt ?? null,
        threadStatus: selected.status?.type ?? "notLoaded",
      } : null,
      tokens: { total: totalTokens, level },
      pet: { selectedId: this.selectedPetId },
      approval: serializeApproval(approval),
      userInput: serializeUserInput(this.pendingUserInput),
      telemetry: { ...this.telemetry },
      capabilities: {
        approvalDecisions: ["accept", "decline"],
        petSelection: true,
        voice: true,
        sound: true,
        transports: ["usb", "wifi"],
      },
    };
  }

  #changed(reason) {
    this.#revision += 1;
    this.emit("change", this.snapshot(), reason);
  }
}
