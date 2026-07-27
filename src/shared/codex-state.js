const DEFAULT_COMPLETION_WINDOW_MS = 4_000;
const DEFAULT_HOOK_ACTIVITY_WINDOW_MS = 30 * 60_000;

export const DEVICE_STATES = Object.freeze({
  READY: "ready",
  RUNNING: "running",
  NEEDS_INPUT: "needs-input",
  REVIEWING: "reviewing",
  COMPLETED: "completed",
  BLOCKED: "blocked",
});

export function toEpochMs(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

export function getThreadRecency(thread) {
  return Math.max(
    toEpochMs(thread.recencyAt),
    toEpochMs(thread.updatedAt),
    toEpochMs(thread.createdAt),
    toEpochMs(thread.lastEventAt),
  );
}

export function getLastTurn(thread) {
  if (thread.lastTurn) return thread.lastTurn;
  if (!Array.isArray(thread.turns) || thread.turns.length === 0) return null;
  return thread.turns[thread.turns.length - 1];
}

export function mapThreadToPresentation(thread, options = {}) {
  const now = options.now ?? Date.now();
  const completionWindowMs = options.completionWindowMs ?? DEFAULT_COMPLETION_WINDOW_MS;
  const hookActivityWindowMs = options.hookActivityWindowMs ?? DEFAULT_HOOK_ACTIVITY_WINDOW_MS;
  const status = thread?.status ?? { type: "notLoaded" };
  const flags = new Set(status.activeFlags ?? []);
  const lastTurn = getLastTurn(thread ?? {});
  const hookAge = Math.max(0, now - toEpochMs(thread?.hookUpdatedAt));
  const freshHook = Boolean(
    thread?.hookState &&
    Number.isFinite(hookAge) &&
    hookAge <= hookActivityWindowMs,
  );
  const goalStatus = thread?.goal?.status;

  if (
    status.type === "systemError" ||
    lastTurn?.status === "failed" ||
    ["blocked", "usageLimited", "budgetLimited"].includes(goalStatus)
  ) {
    return { state: DEVICE_STATES.BLOCKED, animation: "failed" };
  }

  if (
    thread?.pendingApproval ||
    thread?.pendingUserInput ||
    flags.has("waitingOnApproval") ||
    flags.has("waitingOnUserInput") ||
    (freshHook && thread.hookState === DEVICE_STATES.NEEDS_INPUT)
  ) {
    return { state: DEVICE_STATES.NEEDS_INPUT, animation: "waiting" };
  }

  if (thread?.reviewing) {
    return { state: DEVICE_STATES.REVIEWING, animation: "review" };
  }

  if (
    goalStatus === "active" ||
    status.type === "active" ||
    lastTurn?.status === "inProgress" ||
    (freshHook && thread.hookState === DEVICE_STATES.RUNNING)
  ) {
    return { state: DEVICE_STATES.RUNNING, animation: "running" };
  }

  const hookCompleted = freshHook && thread.hookState === DEVICE_STATES.COMPLETED;
  const goalCompleted = goalStatus === "complete";
  const completedAt = Math.max(
    toEpochMs(lastTurn?.completedAt),
    goalCompleted ? toEpochMs(thread?.goal?.updatedAt) : 0,
    hookCompleted
      ? toEpochMs(thread.hookCompletedAt)
      : 0,
  );
  const elapsed = completedAt ? Math.max(0, now - completedAt) : Infinity;
  if ((lastTurn?.status === "completed" || hookCompleted || goalCompleted) && elapsed <= completionWindowMs) {
    return {
      state: DEVICE_STATES.COMPLETED,
      animation: elapsed <= Math.min(1_500, completionWindowMs) ? "jumping" : "waving",
    };
  }

  return { state: DEVICE_STATES.READY, animation: "idle" };
}

function threadPriority(thread, now) {
  const presentation = mapThreadToPresentation(thread, { now });
  const priority = {
    [DEVICE_STATES.NEEDS_INPUT]: 6,
    [DEVICE_STATES.RUNNING]: 5,
    [DEVICE_STATES.REVIEWING]: 4,
    [DEVICE_STATES.BLOCKED]: 3,
    [DEVICE_STATES.COMPLETED]: 2,
    [DEVICE_STATES.READY]: 1,
  }[presentation.state];
  return { priority, recency: getThreadRecency(thread) };
}

export function selectDisplayThread(threads, options = {}) {
  if (!Array.isArray(threads) || threads.length === 0) return null;
  const now = options.now ?? Date.now();

  return sortDisplayThreads(threads, { now })[0];
}

export function sortDisplayThreads(threads, options = {}) {
  if (!Array.isArray(threads)) return [];
  const now = options.now ?? Date.now();
  return [...threads].sort((left, right) => {
    const a = threadPriority(left, now);
    const b = threadPriority(right, now);
    return b.priority - a.priority || b.recency - a.recency || String(left.id).localeCompare(String(right.id));
  });
}

export function extractTotalTokens(tokenUsage) {
  const total = tokenUsage?.total?.totalTokens ?? tokenUsage?.totalTokens ?? 0;
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

export function computeLevel(totalTokens, tokensPerLevel = 50_000) {
  if (!Number.isFinite(tokensPerLevel) || tokensPerLevel <= 0) {
    throw new RangeError("tokensPerLevel must be greater than zero");
  }
  const safeTokens = Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : 0;
  const level = Math.floor(safeTokens / tokensPerLevel) + 1;
  const current = safeTokens % tokensPerLevel;
  return {
    level,
    current,
    target: tokensPerLevel,
    progress: current / tokensPerLevel,
  };
}

export function summarizeThread(thread) {
  if (!thread) return "暂无 Codex 任务";
  const text = thread.name || thread.preview || "未命名 Codex 任务";
  return String(text).replace(/\s+/g, " ").trim().slice(0, 120);
}
