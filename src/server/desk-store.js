import { EventEmitter } from "node:events";
import {
  computeLevel,
  extractTotalTokens,
  getThreadRecency,
  mapThreadToPresentation,
  selectDisplayThread,
  sortDisplayThreads,
  summarizeThread,
  toEpochMs,
} from "../shared/codex-state.js";
import { getAnimation } from "../shared/pet-spec.js";
import {
  hookPresentation,
  normalizeCodexHookEvent,
} from "./codex-hook.js";

const DEFAULT_TELEMETRY = Object.freeze({
  batteryPercent: 100,
  charging: true,
  transport: "simulator",
  wifiRssi: null,
  lastSeenAt: null,
});
const MAX_DEVICE_TASKS = 12;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function safeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function localDateKey(now) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectWeeklyWindow(response) {
  const snapshots = [
    response?.rateLimitsByLimitId?.codex,
    response?.rateLimits,
  ].filter(Boolean);
  for (const snapshot of snapshots) {
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
    const exact = windows.find((window) => window.windowDurationMins === WEEKLY_WINDOW_MINUTES);
    if (exact) return { ...exact, limitName: snapshot.limitName ?? "Codex" };
  }
  return null;
}

function taskProgress(thread) {
  const plan = Array.isArray(thread.plan) ? thread.plan : [];
  if (plan.length) {
    const completed = plan.filter((step) => step?.status === "completed").length;
    return {
      known: true,
      completed,
      total: plan.length,
      percent: Math.round((completed / plan.length) * 100),
    };
  }
  const budget = safeInteger(thread.goal?.tokenBudget);
  const used = safeInteger(thread.goal?.tokensUsed);
  if (budget > 0) {
    return {
      known: true,
      completed: Math.min(used, budget),
      total: budget,
      percent: Math.min(100, Math.round((used / budget) * 100)),
    };
  }
  return { known: false, completed: 0, total: 0, percent: 0 };
}

function threadKind(thread) {
  return thread?.gitInfo ? "project" : "conversation";
}

function workspaceLabel(thread) {
  if (typeof thread?.cwd !== "string" || !thread.cwd) return "";
  return thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

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
    this.rateLimits = null;
    this.accountUsage = null;
    this.localTodayTokens = {
      dateKey: null,
      tokens: 0,
      available: false,
    };
    this.companion = {
      status: "idle",
      mode: null,
      requestId: null,
      prompt: null,
      reply: null,
      threadId: null,
      turnId: null,
      error: null,
      updatedAt: null,
    };
    this.voice = {
      status: "idle",
      mode: null,
      transcript: null,
      error: null,
      deviceId: null,
      updatedAt: null,
    };
    this.vision = {
      status: "idle",
      captureId: null,
      deviceId: null,
      width: null,
      height: null,
      bytes: null,
      reply: null,
      error: null,
      updatedAt: null,
    };
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

  patchThread(id, patch, { touchActivity = true } = {}) {
    const existing = this.#threads.get(id) ?? { id, preview: "", status: { type: "notLoaded" }, turns: [] };
    this.#threads.set(id, {
      ...existing,
      ...patch,
      ...(touchActivity ? { lastEventAt: Date.now() } : {}),
    });
    this.#changed("thread");
  }

  handleNotification(method, params = {}) {
    switch (method) {
      case "error":
        this.patchThread(params.threadId, {
          lastError: params.error ?? null,
          errorWillRetry: Boolean(params.willRetry),
          ...(params.willRetry ? {} : { status: { type: "systemError" } }),
        });
        return;
      case "thread/started":
        this.upsertThread(params.thread);
        return;
      case "thread/status/changed":
        this.patchThread(params.threadId, {
          status: params.status,
          ...(params.status?.type === "systemError" ? {} : { lastError: null, errorWillRetry: false }),
        });
        return;
      case "thread/name/updated":
        this.patchThread(params.threadId, { name: params.name });
        return;
      case "turn/started":
      case "turn/completed":
        this.patchThread(params.threadId, {
          lastTurn: params.turn,
          reviewing: false,
          ...(method === "turn/started" ? { lastError: null, errorWillRetry: false } : {}),
        });
        return;
      case "turn/plan/updated":
        this.patchThread(params.threadId, {
          plan: Array.isArray(params.plan) ? params.plan : [],
          planExplanation: params.explanation ?? null,
          planTurnId: params.turnId ?? null,
        });
        return;
      case "thread/goal/updated":
        this.patchThread(params.threadId, { goal: params.goal ?? null });
        return;
      case "thread/goal/cleared":
        this.patchThread(params.threadId, { goal: null });
        return;
      case "account/rateLimits/updated": {
        const update = params.rateLimits ?? null;
        const limitId = update?.limitId;
        const byLimitId = { ...(this.rateLimits?.rateLimitsByLimitId ?? {}) };
        if (limitId) byLimitId[limitId] = update;
        this.setRateLimits({
          ...this.rateLimits,
          rateLimits: update ?? this.rateLimits?.rateLimits ?? null,
          rateLimitsByLimitId: Object.keys(byLimitId).length ? byLimitId : null,
        });
        return;
      }
      case "item/autoApprovalReview/started":
        this.patchThread(params.threadId, { reviewing: true });
        return;
      case "item/autoApprovalReview/completed":
        this.patchThread(params.threadId, { reviewing: false });
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
        this.patchThread(
          params.threadId,
          { tokenUsage: params.tokenUsage },
          { touchActivity: false },
        );
        return;
      case "thread/closed":
      case "thread/deleted":
        this.#threads.delete(params.threadId);
        this.#changed("thread");
        return;
      default:
    }
  }

  handleCodexHook(value, now = Date.now()) {
    const event = normalizeCodexHookEvent(value, { now });
    if (!event) throw new Error("Codex hook event is invalid");
    const presentation = hookPresentation(event.event);
    const existing = this.#threads.get(event.sessionId) ?? {
      id: event.sessionId,
      preview: event.title ?? event.workspaceName ?? "Codex 任务",
      status: { type: "notLoaded" },
      turns: [],
    };
    const existingAt = toEpochMs(existing.hookUpdatedAt);
    const existingPriority = Number(existing.hookPriority ?? 0);
    if (
      event.occurredAt < existingAt ||
      (event.occurredAt === existingAt && presentation.priority < existingPriority)
    ) {
      return false;
    }
    this.#threads.set(event.sessionId, {
      ...existing,
      ...(event.title && !existing.name ? { preview: event.title } : {}),
      hookState: presentation.state,
      hookPriority: presentation.priority,
      hookEvent: event.event,
      hookTurnId: event.turnId,
      hookToolName: event.toolName,
      hookUpdatedAt: event.occurredAt,
      ...(event.event === "Stop" ? { hookCompletedAt: event.occurredAt } : {}),
      lastEventAt: event.occurredAt,
    });
    this.#changed("codex-hook");
    return true;
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

  clearApprovals(decision = "connection-lost", predicate = () => true) {
    const approvals = [...this.#approvals.values()].filter(predicate);
    for (const approval of approvals) this.#approvals.delete(approval.id);
    for (const threadId of new Set(approvals.map((approval) => approval.threadId))) {
      const stillPending = [...this.#approvals.values()].some(
        (candidate) => candidate.threadId === threadId,
      );
      this.patchThread(threadId, { pendingApproval: stillPending });
    }
    if (approvals.length) this.#changed("approval");
    return approvals.map((approval) => ({ ...approval, decision }));
  }

  setPendingUserInput(request) {
    this.pendingUserInput = request;
    if (request?.threadId) this.patchThread(request.threadId, { pendingUserInput: true });
    else this.#changed("user-input");
  }

  clearPendingUserInput(requestId = null) {
    if (!this.pendingUserInput) return false;
    if (requestId !== null && String(this.pendingUserInput.rpcId) !== String(requestId)) return false;
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

  setRateLimits(rateLimits) {
    this.rateLimits = rateLimits ?? null;
    this.#changed("rate-limits");
  }

  setAccountUsage(accountUsage) {
    this.accountUsage = accountUsage ?? null;
    this.#changed("account-usage");
  }

  setLocalTodayTokens(value) {
    const next = {
      dateKey: value?.dateKey ?? null,
      tokens: safeInteger(value?.tokens),
      available: Boolean(value?.available),
    };
    if (
      next.dateKey === this.localTodayTokens.dateKey &&
      next.tokens === this.localTodayTokens.tokens &&
      next.available === this.localTodayTokens.available
    ) return;
    this.localTodayTokens = next;
    this.#changed("local-today-tokens");
  }

  setPreviewAnimation(animation) {
    if (animation !== null) getAnimation(animation);
    this.previewAnimation = animation;
    this.#changed("preview");
  }

  setCompanion(patch) {
    this.companion = {
      ...this.companion,
      ...patch,
      updatedAt: Date.now(),
    };
    this.#changed("companion");
  }

  setVoice(patch) {
    this.voice = {
      ...this.voice,
      ...patch,
      updatedAt: Date.now(),
    };
    this.#changed("voice");
  }

  setVision(patch) {
    this.vision = {
      ...this.vision,
      ...patch,
      updatedAt: Date.now(),
    };
    this.#changed("vision");
  }

  snapshot(now = Date.now()) {
    const threads = [...this.#threads.values()];
    const selected = selectDisplayThread(threads, { now });
    const mapped = selected ? mapThreadToPresentation(selected, { now }) : { state: "ready", animation: "idle" };
    const totalTokens = extractTotalTokens(selected?.tokenUsage) ||
      safeInteger(selected?.goal?.tokensUsed);
    const level = computeLevel(totalTokens, this.tokensPerLevel);
    const previewBlocked = mapped.state === "needs-input" || mapped.state === "blocked";
    const previewing = this.previewAnimation !== null && !previewBlocked;
    const approval = selected
      ? [...this.#approvals.values()].find((candidate) => candidate.threadId === selected.id)
      : [...this.#approvals.values()][0];
    const tasks = sortDisplayThreads(threads, { now })
      .slice(0, MAX_DEVICE_TASKS)
      .map((thread) => {
        const presentation = mapThreadToPresentation(thread, { now });
        return {
          id: thread.id,
          title: summarizeThread(thread).slice(0, 56),
          kind: threadKind(thread),
          workspace: workspaceLabel(thread).slice(0, 40),
          state: presentation.state,
          updatedAt: Math.floor(getThreadRecency(thread) / 1_000),
          tokens: extractTotalTokens(thread.tokenUsage) || safeInteger(thread.goal?.tokensUsed),
          progress: taskProgress(thread),
          goalStatus: thread.goal?.status ?? null,
        };
      });
    const weekly = selectWeeklyWindow(this.rateLimits);
    const todayKey = localDateKey(now);
    const dailyBuckets = Array.isArray(this.accountUsage?.dailyUsageBuckets)
      ? this.accountUsage.dailyUsageBuckets
      : [];
    const todayBuckets = dailyBuckets
      .filter((bucket) => bucket?.startDate === todayKey);
    const todayTokens = todayBuckets
      .reduce((sum, bucket) => sum + safeInteger(bucket?.tokens), 0);
    const officialTodayAvailable = todayBuckets.length > 0;
    const localTodayAvailable =
      this.localTodayTokens.available &&
      this.localTodayTokens.dateKey === todayKey;
    const activeStates = new Set(["running", "needs-input", "reviewing"]);
    const activeCount = threads.filter((thread) => (
      activeStates.has(mapThreadToPresentation(thread, { now }).state)
    )).length;

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
        kind: threadKind(selected),
        workspace: workspaceLabel(selected),
        updatedAt: selected.updatedAt ?? selected.recencyAt ?? null,
        threadStatus: selected.status?.type ?? "notLoaded",
      } : null,
      tasks,
      taskCounts: {
        total: threads.length,
        active: activeCount,
        visible: tasks.length,
      },
      tokens: { total: totalTokens, level },
      accountTokens: {
        lifetime: safeInteger(this.accountUsage?.summary?.lifetimeTokens),
        today: officialTodayAvailable
          ? todayTokens
          : localTodayAvailable ? this.localTodayTokens.tokens : 0,
        todayAvailable: officialTodayAvailable || localTodayAvailable,
      },
      quota: weekly ? {
        available: true,
        usedPercent: Math.max(0, Math.min(100, Math.round(Number(weekly.usedPercent) || 0))),
        resetsAt: safeInteger(weekly.resetsAt),
        windowMinutes: safeInteger(weekly.windowDurationMins),
        name: weekly.limitName,
      } : {
        available: false,
        usedPercent: 0,
        resetsAt: 0,
        windowMinutes: 0,
        name: "Codex",
      },
      clock: {
        unixMs: now,
        utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
      },
      pet: { selectedId: this.selectedPetId },
      approval: serializeApproval(approval),
      userInput: serializeUserInput(this.pendingUserInput),
      companion: { ...this.companion },
      voice: { ...this.voice },
      vision: { ...this.vision },
      telemetry: { ...this.telemetry },
      capabilities: {
        approvalDecisions: ["accept", "decline"],
        petSelection: true,
        voice: true,
        vision: true,
        sound: true,
        companionChat: true,
        companionCommands: true,
        threadConversation: true,
        transports: ["usb", "wifi", "ble"],
      },
    };
  }

  #changed(reason) {
    this.#revision += 1;
    this.emit("change", this.snapshot(), reason);
  }
}
