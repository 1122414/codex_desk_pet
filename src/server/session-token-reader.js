import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const DEFAULT_TAIL_BYTES = 256 * 1024;
const SEARCH_PROBE_BYTES = 64 * 1024;
const TIMESTAMP_PREFIX_BYTES = 512;
const resultCache = new Map();
const baselineCache = new Map();

function isInside(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function parseTokenRecord(line) {
  if (!line.includes('"type":"token_count"')) return null;
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

function localDay(now) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  date.setHours(0, 0, 0, 0);
  return {
    dateKey: `${year}-${month}-${day}`,
    startedAt: date.getTime(),
  };
}

function timestampFromPrefix(value) {
  const match = value.match(/"timestamp"\s*:\s*"([^"]+)"/);
  if (!match) return 0;
  return Date.parse(match[1]) || 0;
}

async function nextLineStart(handle, offset, size) {
  if (offset <= 0) return 0;
  let position = Math.min(offset, size);
  while (position < size) {
    const length = Math.min(SEARCH_PROBE_BYTES, size - position);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (!bytesRead) return size;
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline >= 0) return position + newline + 1;
    position += bytesRead;
  }
  return size;
}

async function recordTimestamp(handle, lineStart, size) {
  if (lineStart >= size) return 0;
  const length = Math.min(TIMESTAMP_PREFIX_BYTES, size - lineStart);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, lineStart);
  return timestampFromPrefix(buffer.subarray(0, bytesRead).toString("utf8"));
}

async function approximateDayBoundary(handle, size, startedAt) {
  let low = 0;
  let high = size;
  for (
    let iteration = 0;
    iteration < 48 && high - low > SEARCH_PROBE_BYTES;
    iteration += 1
  ) {
    const middle = low + Math.floor((high - low) / 2);
    const lineStart = await nextLineStart(handle, middle, size);
    if (lineStart >= size) {
      high = middle;
      continue;
    }
    const timestamp = await recordTimestamp(handle, lineStart, size);
    if (!timestamp || timestamp < startedAt) {
      low = Math.max(middle + 1, lineStart + 1);
    } else {
      high = middle;
    }
  }
  return nextLineStart(handle, Math.min(high, size), size);
}

async function findPreviousToken(
  handle,
  endOffset,
  predicate = () => true,
  chunkBytes = DEFAULT_TAIL_BYTES,
) {
  let position = endOffset;
  let carry = "";
  while (position > 0) {
    const length = Math.min(chunkBytes, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const parts = `${buffer.subarray(0, bytesRead).toString("utf8")}${carry}`
      .split("\n");
    carry = parts.shift() ?? "";
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const parsed = parseTokenRecord(parts[index]);
      if (parsed && predicate(parsed)) return parsed;
    }
  }
  const parsed = parseTokenRecord(carry);
  return parsed && predicate(parsed) ? parsed : null;
}

export async function readLatestSessionTokenUsage(
  sessionPath,
  {
    codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex"),
    now = Date.now(),
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
    if (stats.size === 0) return null;
    const day = localDay(now);
    const cached = resultCache.get(resolvedPath);
    if (
      cached?.size === stats.size &&
      cached?.mtimeMs === stats.mtimeMs &&
      cached?.dateKey === day.dateKey
    ) {
      return { ...cached.result };
    }

    const chunkBytes = Math.max(1, tailBytes);
    const latest = await findPreviousToken(
      handle,
      stats.size,
      () => true,
      chunkBytes,
    );
    if (!latest) return null;

    let todayTokens = 0;
    if (latest.observedAt >= day.startedAt) {
      let baseline = baselineCache.get(resolvedPath);
      if (baseline?.dateKey !== day.dateKey) {
        const boundary = await approximateDayBoundary(
          handle,
          stats.size,
          day.startedAt,
        );
        const previous = await findPreviousToken(
          handle,
          boundary,
          (record) => record.observedAt < day.startedAt,
          chunkBytes,
        );
        baseline = {
          dateKey: day.dateKey,
          totalTokens: previous?.totalTokens ?? 0,
        };
        baselineCache.set(resolvedPath, baseline);
      }
      todayTokens = Math.max(0, latest.totalTokens - baseline.totalTokens);
    }
    const result = {
      ...latest,
      dateKey: day.dateKey,
      todayTokens,
      todayAvailable: true,
    };
    resultCache.set(resolvedPath, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      dateKey: day.dateKey,
      result,
    });
    return { ...result };
  } finally {
    await handle.close();
  }
}
