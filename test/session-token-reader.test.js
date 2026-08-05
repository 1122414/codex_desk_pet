import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestSessionTokenUsage } from "../src/server/session-token-reader.js";

test("session token reader returns the latest valid cumulative total", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-desk-token-"));
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions);
  const session = join(sessions, "rollout.jsonl");
  const now = new Date(2026, 6, 27, 12).getTime();
  await writeFile(session, [
    JSON.stringify({
      timestamp: "2026-07-27T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 12_345 } },
      },
    }),
    JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    JSON.stringify({
      timestamp: "2026-07-27T10:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 54_321 } },
      },
    }),
    "",
  ].join("\n"));

  assert.deepEqual(
    await readLatestSessionTokenUsage(session, { codexHome, now }),
    {
      totalTokens: 54_321,
      observedAt: Date.parse("2026-07-27T10:01:00.000Z"),
      dateKey: "2026-07-27",
      todayTokens: 54_321,
      todayAvailable: true,
    },
  );
});

test("session token reader subtracts the last total before local midnight", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-desk-token-day-"));
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions);
  const session = join(sessions, "rollout.jsonl");
  const now = new Date(2026, 6, 27, 12).getTime();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  await writeFile(session, [
    JSON.stringify({
      timestamp: new Date(dayStart.getTime() - 60_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 10_000 } },
      },
    }),
    JSON.stringify({
      timestamp: new Date(dayStart.getTime() + 60_000).toISOString(),
      type: "response_item",
      payload: { type: "message", text: "x".repeat(80_000) },
    }),
    JSON.stringify({
      timestamp: new Date(dayStart.getTime() + 120_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 12_000 } },
      },
    }),
    JSON.stringify({
      timestamp: new Date(dayStart.getTime() + 180_000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 15_000 } },
      },
    }),
    "",
  ].join("\n"));

  const result = await readLatestSessionTokenUsage(session, {
    codexHome,
    now,
    tailBytes: 1_024,
  });
  assert.equal(result.totalTokens, 15_000);
  assert.equal(result.todayTokens, 5_000);
  assert.equal(result.todayAvailable, true);
});

test("session token reader rejects paths outside Codex sessions", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-desk-token-"));
  await mkdir(join(codexHome, "sessions"));
  const outside = join(codexHome, "outside.jsonl");
  await writeFile(outside, "{}\n");

  await assert.rejects(
    readLatestSessionTokenUsage(outside, { codexHome }),
    /outside the configured sessions directory/,
  );
});
