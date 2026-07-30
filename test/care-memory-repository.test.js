import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CareMemoryRepository } from "../src/server/care-memory-repository.js";

test("care profile and events persist with bounded private storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-care-memory-"));
  const now = 1_800_000_000_000;
  const repository = new CareMemoryRepository({
    directoryPath: root,
    maxEvents: 3,
    now: () => now,
  });
  await repository.load();
  const profile = await repository.saveProfile({
    persona: "  直接又温柔  ",
    summary: "正在实现主动关怀",
    preferences: ["少说套话", "少说套话", "回答简短"],
    frequentApps: ["网易云音乐"],
    recentConversation: {
      threadId: "care-thread-1",
      summary: "讨论多轮对话",
      updatedAt: now - 100,
    },
  });
  assert.equal(profile.persona, "直接又温柔");
  assert.deepEqual(profile.preferences, ["少说套话", "回答简短"]);

  for (let index = 0; index < 4; index += 1) {
    await repository.appendEvent({
      type: "conversation.user_reply",
      occurredAt: now - 30 + index,
      conversationId: "care-thread-1",
      summary: `第 ${index + 1} 轮`,
      data: { index },
    });
  }
  await repository.close();
  assert.equal((await stat(path.join(root, "care-profile.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(root, "care-events.jsonl"))).mode & 0o777, 0o600);

  const reloaded = new CareMemoryRepository({
    directoryPath: root,
    maxEvents: 3,
    now: () => now,
  });
  const snapshot = await reloaded.load();
  assert.equal(snapshot.profile.summary, "正在实现主动关怀");
  assert.equal(snapshot.eventCount, 3);
  assert.deepEqual(
    reloaded.listEvents().map((event) => event.data.index),
    [1, 2, 3],
  );
});

test("corrupt care profiles are rejected without overwriting the source file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-care-corrupt-profile-"));
  const profilePath = path.join(root, "care-profile.json");
  await writeFile(profilePath, "{not-json");
  const repository = new CareMemoryRepository({ directoryPath: root });
  await assert.rejects(() => repository.load(), SyntaxError);
  assert.equal(await readFile(profilePath, "utf8"), "{not-json");
  await assert.rejects(
    () => repository.saveProfile({ summary: "不能覆盖损坏档案" }),
    SyntaxError,
  );
  assert.equal(await readFile(profilePath, "utf8"), "{not-json");
});

test("invalid and expired event rows are diagnosed and compacted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-care-corrupt-events-"));
  const now = 40 * 24 * 60 * 60 * 1_000;
  const validEvent = (id, occurredAt) => JSON.stringify({
    version: 1,
    id,
    type: "observation.completed",
    occurredAt,
    deviceId: null,
    conversationId: null,
    summary: id,
    data: null,
  });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "care-events.jsonl"), [
    validEvent("expired-event", 1),
    "{bad-json",
    JSON.stringify({ version: 9, id: "bad-version", type: "bad", occurredAt: now }),
    validEvent("recent-event", now - 1_000),
    "",
  ].join("\n"));
  const diagnostics = [];
  const repository = new CareMemoryRepository({
    directoryPath: root,
    retentionDays: 30,
    now: () => now,
  });
  repository.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
  const snapshot = await repository.load();
  assert.equal(snapshot.eventCount, 1);
  assert.equal(snapshot.recentEvent.id, "recent-event");
  assert.equal(diagnostics.length, 2);
  const persisted = await readFile(path.join(root, "care-events.jsonl"), "utf8");
  assert.match(persisted, /recent-event/);
  assert.doesNotMatch(persisted, /expired-event|bad-version|bad-json/);
});

test("care memory rejects oversized event data and invalid profile shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-care-bounds-"));
  const repository = new CareMemoryRepository({ directoryPath: root });
  await repository.load();
  await assert.rejects(
    () => repository.appendEvent({
      type: "conversation.user_reply",
      data: { text: "x".repeat(5_000) },
    }),
    /too large/,
  );
  await assert.rejects(
    () => repository.saveProfile({ preferences: "not-an-array" }),
    /preferences/,
  );
  assert.equal(repository.snapshot().eventCount, 0);
});
