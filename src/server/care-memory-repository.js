import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const PROFILE_VERSION = 1;
const EVENT_VERSION = 1;
const MAX_PROFILE_FILE_BYTES = 128 * 1024;
const MAX_EVENT_LINE_BYTES = 16 * 1024;
const MAX_EVENT_DATA_BYTES = 4 * 1024;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DEFAULT_CARE_PROFILE = Object.freeze({
  version: PROFILE_VERSION,
  persona: "",
  summary: "",
  preferences: Object.freeze([]),
  frequentApps: Object.freeze([]),
  recentConversation: null,
  updatedAt: null,
});

function defaultDirectoryPath() {
  return path.join(os.homedir(), ".codex-desk");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maximumLength) {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function boundedTextList(value, maximumItems, maximumLength) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = boundedText(item, maximumLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximumItems) break;
  }
  return result;
}

function normalizeTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function normalizeRecentConversation(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("Care profile recent conversation is invalid");
  const threadId = boundedText(value.threadId, 128);
  const summary = boundedText(value.summary, 2_000);
  const updatedAt = normalizeTimestamp(value.updatedAt);
  if (!threadId && !summary && updatedAt === null) return null;
  return {
    threadId: threadId || null,
    summary,
    updatedAt,
  };
}

function normalizeProfile(value, { requireVersion = false } = {}) {
  if (!isRecord(value)) throw new Error("Care profile must be a JSON object");
  if (requireVersion && value.version !== PROFILE_VERSION) {
    throw new Error("Care profile has an unsupported format");
  }
  if (value.preferences !== undefined && !Array.isArray(value.preferences)) {
    throw new Error("Care profile preferences are invalid");
  }
  if (value.frequentApps !== undefined && !Array.isArray(value.frequentApps)) {
    throw new Error("Care profile frequent apps are invalid");
  }
  if (value.persona !== undefined && typeof value.persona !== "string") {
    throw new Error("Care profile persona is invalid");
  }
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new Error("Care profile summary is invalid");
  }
  return {
    version: PROFILE_VERSION,
    persona: boundedText(value.persona, 2_000),
    summary: boundedText(value.summary, 4_000),
    preferences: boundedTextList(value.preferences, 50, 200),
    frequentApps: boundedTextList(value.frequentApps, 20, 80),
    recentConversation: normalizeRecentConversation(value.recentConversation),
    updatedAt: normalizeTimestamp(value.updatedAt),
  };
}

function normalizeEventData(value) {
  if (value === undefined) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Care event data must be JSON serializable");
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_EVENT_DATA_BYTES) {
    throw new Error("Care event data is too large");
  }
  return JSON.parse(serialized);
}

function normalizeEvent(value, { now, createDefaults = false } = {}) {
  if (!isRecord(value)) throw new Error("Care event must be a JSON object");
  if (!createDefaults && value.version !== EVENT_VERSION) {
    throw new Error("Care event has an unsupported format");
  }
  const id = boundedText(value.id, 128) || (createDefaults ? randomUUID() : "");
  const type = boundedText(value.type, 64);
  const occurredAt = normalizeTimestamp(value.occurredAt) ?? (createDefaults ? now : null);
  if (!IDENTIFIER_PATTERN.test(id)) throw new Error("Care event id is invalid");
  if (!EVENT_TYPE_PATTERN.test(type)) throw new Error("Care event type is invalid");
  if (occurredAt === null) throw new Error("Care event timestamp is invalid");
  const deviceId = value.deviceId === null || value.deviceId === undefined
    ? null
    : boundedText(value.deviceId, 128);
  const conversationId = value.conversationId === null || value.conversationId === undefined
    ? null
    : boundedText(value.conversationId, 128);
  if (value.deviceId !== null && value.deviceId !== undefined && !IDENTIFIER_PATTERN.test(deviceId)) {
    throw new Error("Care event device id is invalid");
  }
  if (
    value.conversationId !== null &&
    value.conversationId !== undefined &&
    !IDENTIFIER_PATTERN.test(conversationId)
  ) {
    throw new Error("Care event conversation id is invalid");
  }
  return {
    version: EVENT_VERSION,
    id,
    type,
    occurredAt,
    deviceId,
    conversationId,
    summary: boundedText(value.summary, 1_000),
    data: normalizeEventData(value.data),
  };
}

async function ensurePrivateDirectory(filePath) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writeAtomic(filePath, content) {
  await ensurePrivateDirectory(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class CareMemoryRepository extends EventEmitter {
  #profile = structuredClone(DEFAULT_CARE_PROFILE);
  #events = [];
  #diagnostics = [];
  #loaded = false;
  #loadPromise = null;
  #writeQueue = Promise.resolve();

  constructor({
    directoryPath = defaultDirectoryPath(),
    profilePath = path.join(directoryPath, "care-profile.json"),
    eventsPath = path.join(directoryPath, "care-events.jsonl"),
    retentionDays = 30,
    maxEvents = 5_000,
    now = Date.now,
  } = {}) {
    super();
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
      throw new RangeError("Care event retention days must be between 1 and 3650");
    }
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000) {
      throw new RangeError("Care event limit must be between 1 and 100000");
    }
    if (typeof now !== "function") throw new TypeError("Care memory clock must be a function");
    this.profilePath = profilePath;
    this.eventsPath = eventsPath;
    this.retentionDays = retentionDays;
    this.maxEvents = maxEvents;
    this.now = now;
  }

  async load() {
    if (this.#loaded) return this.snapshot();
    if (this.#loadPromise) return this.#loadPromise;
    this.#loadPromise = this.#load().finally(() => {
      this.#loadPromise = null;
    });
    return this.#loadPromise;
  }

  snapshot() {
    return {
      profile: structuredClone(this.#profile),
      eventCount: this.#events.length,
      recentEvent: this.#events.length
        ? structuredClone(this.#events[this.#events.length - 1])
        : null,
      diagnostics: structuredClone(this.#diagnostics.slice(-20)),
    };
  }

  listEvents({ limit = 100 } = {}) {
    const normalizedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 1_000)) : 100;
    return structuredClone(this.#events.slice(-normalizedLimit));
  }

  async saveProfile(patch) {
    await this.load();
    const candidate = isRecord(patch) ? patch : {};
    const profile = normalizeProfile({
      ...this.#profile,
      ...candidate,
      recentConversation: candidate.recentConversation === undefined
        ? this.#profile.recentConversation
        : candidate.recentConversation,
      updatedAt: candidate.updatedAt ?? this.now(),
    });
    return this.#enqueue(async () => {
      await writeAtomic(this.profilePath, `${JSON.stringify(profile, null, 2)}\n`);
      this.#profile = profile;
      this.emit("change", this.snapshot());
      return structuredClone(profile);
    });
  }

  async appendEvent(event) {
    await this.load();
    const normalized = normalizeEvent(event, { now: this.now(), createDefaults: true });
    return this.#enqueue(async () => {
      const nextEvents = [...this.#events, normalized];
      const compacted = this.#retainedEvents(nextEvents, this.now());
      if (compacted.length !== nextEvents.length) {
        await this.#writeEvents(compacted);
      } else {
        await ensurePrivateDirectory(this.eventsPath);
        await appendFile(this.eventsPath, `${JSON.stringify(normalized)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(this.eventsPath, 0o600);
      }
      this.#events = compacted;
      this.emit("change", this.snapshot());
      return structuredClone(normalized);
    });
  }

  async compact(now = this.now()) {
    await this.load();
    return this.#enqueue(async () => {
      const retained = this.#retainedEvents(this.#events, now);
      const removed = this.#events.length - retained.length;
      if (removed > 0) {
        await this.#writeEvents(retained);
        this.#events = retained;
        this.emit("change", this.snapshot());
      }
      return removed;
    });
  }

  async close() {
    await this.#writeQueue;
  }

  async #load() {
    const profile = await this.#readProfile();
    const { events, dirty } = await this.#readEvents();
    const retained = this.#retainedEvents(events, this.now());
    if (dirty || retained.length !== events.length) await this.#writeEvents(retained);
    this.#profile = profile;
    this.#events = retained;
    this.#loaded = true;
    return this.snapshot();
  }

  async #readProfile() {
    try {
      const raw = await readFile(this.profilePath);
      if (raw.length > MAX_PROFILE_FILE_BYTES) throw new Error("Care profile file is too large");
      return normalizeProfile(JSON.parse(raw.toString("utf8")), { requireVersion: true });
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(DEFAULT_CARE_PROFILE);
      throw error;
    }
  }

  async #readEvents() {
    const events = [];
    let dirty = false;
    let lineNumber = 0;
    const input = createReadStream(this.eventsPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
          dirty = true;
          this.#report(`关怀事件第 ${lineNumber} 行过大，已跳过`);
          continue;
        }
        try {
          events.push(normalizeEvent(JSON.parse(line), { now: this.now() }));
        } catch (error) {
          dirty = true;
          this.#report(`关怀事件第 ${lineNumber} 行无效，已跳过：${error.message}`);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      lines.close();
      input.destroy();
    }
    return { events, dirty };
  }

  #retainedEvents(events, now) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1_000;
    return events
      .filter((event) => event.occurredAt >= cutoff)
      .slice(-this.maxEvents);
  }

  async #writeEvents(events) {
    const content = events.map((event) => JSON.stringify(event)).join("\n");
    await writeAtomic(this.eventsPath, content ? `${content}\n` : "");
  }

  #report(message) {
    const diagnostic = { message: String(message).slice(0, 500), occurredAt: this.now() };
    this.#diagnostics.push(diagnostic);
    if (this.#diagnostics.length > 100) this.#diagnostics.shift();
    this.emit("diagnostic", diagnostic);
  }

  #enqueue(operation) {
    const task = this.#writeQueue.then(operation);
    this.#writeQueue = task.catch(() => {});
    return task;
  }
}
