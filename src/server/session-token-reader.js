import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const DEFAULT_TAIL_BYTES = 256 * 1024;

function isInside(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function parseTokenRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") {
    return null;
  }
  const totalTokens = record.payload?.info?.total_token_usage?.total_tokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return null;
  return {
    totalTokens,
    observedAt: Date.parse(record.timestamp) || 0,
  };
}

export async function readLatestSessionTokenUsage(
  sessionPath,
  {
    codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex"),
    tailBytes = DEFAULT_TAIL_BYTES,
  } = {},
) {
  if (typeof sessionPath !== "string" || !sessionPath) return null;
  const sessionsRoot = await realpath(resolve(codexHome, "sessions"));
  const resolvedPath = await realpath(sessionPath);
  if (!isInside(resolvedPath, sessionsRoot)) {
    throw new Error("Codex session path is outside the configured sessions directory");
  }

  const handle = await open(resolvedPath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, Math.max(1, tailBytes));
    if (length === 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    const offset = stats.size - length;
    await handle.read(buffer, 0, length, offset);
    const lines = buffer.toString("utf8").split("\n");
    if (offset > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseTokenRecord(lines[index]);
      if (parsed) return parsed;
    }
    return null;
  } finally {
    await handle.close();
  }
}
