export const CODEX_HOOK_VERSION = 1;
export const CODEX_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOOK_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : null;
}

function boundedDetail(value, maximumBytes) {
  if (typeof value !== "string") return { text: null, complete: false };
  const detail = value.trim();
  if (!detail) return { text: null, complete: false };
  const bytes = Buffer.from(detail);
  if (bytes.length <= maximumBytes) return { text: detail, complete: true };
  return {
    text: bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, ""),
    complete: false,
  };
}

export function normalizeCodexHookEvent(value, { now = Date.now() } = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== CODEX_HOOK_VERSION ||
    !CODEX_HOOK_EVENTS.includes(value.event) ||
    typeof value.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(value.sessionId)
  ) {
    return null;
  }
  const suppliedAt = Number(value.occurredAt);
  const occurredAt = Number.isFinite(suppliedAt) && Math.abs(now - suppliedAt) <= 5 * 60_000
    ? Math.floor(suppliedAt)
    : now;
  return {
    version: CODEX_HOOK_VERSION,
    event: value.event,
    sessionId: value.sessionId,
    turnId: boundedText(value.turnId, 128),
    title: boundedText(value.title, 120),
    workspaceName: boundedText(value.workspaceName, 80),
    toolName: boundedText(value.toolName, 128),
    occurredAt,
  };
}

export function hookPresentation(event) {
  switch (event) {
    case "PermissionRequest":
      return { state: "needs-input", priority: 3 };
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return { state: "running", priority: 2 };
    case "Stop":
      return { state: "completed", priority: 4 };
    case "SessionStart":
      return { state: "ready", priority: 1 };
    default:
      return null;
  }
}

export function normalizeCodexHookApproval(value, options = {}) {
  const event = normalizeCodexHookEvent(value, options);
  if (
    !event ||
    event.event !== "PermissionRequest" ||
    typeof value.requestId !== "string" ||
    !HOOK_REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    return null;
  }
  const detail = boundedDetail(value.detail, 4_096);
  const reason = boundedText(value.reason, 160);
  return {
    ...event,
    requestId: value.requestId,
    detail: detail.text,
    detailComplete: value.detailComplete === true && detail.complete,
    reason,
  };
}
