import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ALLOWED_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
]);
const MAX_INPUT_BYTES = 64 * 1024;

function text(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function boundedDetail(value, maximumBytes = 4_096) {
  if (typeof value !== "string") return { value: null, complete: false };
  const normalized = value.trim();
  if (!normalized) return { value: null, complete: false };
  const bytes = Buffer.from(normalized);
  if (bytes.length <= maximumBytes) return { value: normalized, complete: true };
  return {
    value: bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, ""),
    complete: false,
  };
}

function approvalDetail(input) {
  const toolName = text(input?.tool_name ?? input?.toolName, 128);
  const toolInput = input?.tool_input;
  if (
    (toolName === "Bash" || toolName === "apply_patch") &&
    toolInput &&
    typeof toolInput === "object" &&
    !Array.isArray(toolInput)
  ) {
    return boundedDetail(toolInput.command);
  }
  try {
    return boundedDetail(JSON.stringify(toolInput));
  } catch {
    return { value: null, complete: false };
  }
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function send(body, token, {
  endpoint = "/api/hooks/codex",
  timeoutMs = 1_000,
} = {}) {
  const data = Buffer.from(JSON.stringify(body));
  const port = Number(process.env.CODEX_DESK_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value = null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
        "X-Codex-Desk-Hook-Token": token,
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 2_048) chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200 || bytes > 2_048) {
          finish();
          return;
        }
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish();
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      finish();
    });
    request.on("error", () => finish());
    request.end(data);
  });
}

const input = await readInput();
const event = text(input?.hook_event_name, 64);
const sessionId = text(input?.session_id, 128);
if (!input || !ALLOWED_EVENTS.has(event) || !sessionId) process.exit(0);

const tokenFile = process.env.CODEX_DESK_HOOK_TOKEN_FILE ??
  path.join(os.homedir(), ".codex-desk", "hook-token");
let token;
try {
  token = (await readFile(tokenFile, "utf8")).trim();
} catch {
  process.exit(0);
}
if (!/^[a-f0-9]{64}$/.test(token)) process.exit(0);

const prompt = event === "UserPromptSubmit"
  ? text(input.prompt ?? input.user_prompt ?? input.message, 120)
  : null;
const lifecycle = {
  version: 1,
  event,
  sessionId,
  turnId: text(input.turn_id, 128),
  title: prompt,
  workspaceName: text(path.basename(text(input.cwd, 1_024) ?? ""), 80),
  toolName: text(input.tool_name ?? input.toolName, 128),
  occurredAt: Date.now(),
};

if (event === "PermissionRequest") {
  const detail = approvalDetail(input);
  const response = await send({
    ...lifecycle,
    requestId: randomUUID(),
    detail: detail.value,
    detailComplete: detail.complete,
    reason: text(input.tool_input?.description, 160),
  }, token, {
    endpoint: "/api/hooks/codex/permission",
    timeoutMs: 116_000,
  });
  if (response?.decision === "allow" || response?.decision === "deny") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: response.decision,
          ...(response.decision === "deny"
            ? { message: "由 Codex Desk Buddy 拒绝。" }
            : {}),
        },
      },
    }));
  }
} else {
  await send(lifecycle, token);
}
