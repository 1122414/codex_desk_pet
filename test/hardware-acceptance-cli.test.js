import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function event(id, type, occurredAt, extra = {}) {
  return {
    version: 1,
    id,
    type,
    occurredAt,
    deviceId: "tab5-cli",
    conversationId: "care-cli-thread",
    summary: type,
    data: null,
    ...extra,
  };
}

function runRecorder(arguments_, { stopAfterMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/run-hardware-care-acceptance.mjs",
      ...arguments_,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    if (stopAfterMs !== null) {
      const timer = setTimeout(() => child.kill("SIGINT"), stopAfterMs);
      timer.unref();
    }
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("hardware acceptance CLI checkpoints and completes against a controlled Bridge", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hardware-cli-"));
  const outputPath = path.join(root, "acceptance.json");
  const eventsPath = path.join(root, "care-events.jsonl");
  const occurredAt = Date.now() + 1_000;
  const events = [
    event("scheduled", "observation.requested", occurredAt, {
      summary: "scheduled",
      data: { reason: "scheduled", transport: "wifi" },
    }),
    event("observed", "observation.completed", occurredAt + 10),
    event("disconnected", "device.disconnected", occurredAt + 20, {
      data: { transport: "wifi" },
    }),
    event("connected", "device.connected", occurredAt + 30, {
      data: { transport: "wifi" },
    }),
  ];
  for (let round = 0; round < 5; round += 1) {
    events.push(
      event(`user-${round}`, "conversation.user_reply", occurredAt + 40 + round * 2),
      event(`assistant-${round}`, "conversation.assistant_reply", occurredAt + 41 + round * 2),
    );
  }
  [
    "set_tab5_brightness",
    "set_tab5_volume",
    "set_macos_volume",
    "open_media_preset",
    "capture_now",
    "schedule_follow_up",
  ].forEach((name, index) => {
    events.push(
      event(`requested-${index}`, "action.requested", occurredAt + 100 + index * 20, {
        summary: name,
        data: { name, arguments: {} },
      }),
      event(`completed-${index}`, "action.completed", occurredAt + 110 + index * 20, {
        summary: `${name} 完成`,
        data: { action: name, ok: true },
      }),
    );
  });
  await writeFile(
    eventsPath,
    `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );

  let observationRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/session") {
      response.setHeader(
        "Set-Cookie",
        "codex_desk_session=hardware-test; HttpOnly; SameSite=Strict; Path=/",
      );
      response.end(JSON.stringify({ csrfToken: "hardware-csrf" }));
      return;
    }
    if (request.url === "/api/care/observe" && request.method === "POST") {
      if (
        request.headers.cookie !== "codex_desk_session=hardware-test" ||
        request.headers.origin !== `http://127.0.0.1:${server.address().port}` ||
        request.headers["x-codex-desk-csrf"] !== "hardware-csrf"
      ) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "invalid csrf" }));
        return;
      }
      observationRequests += 1;
      response.statusCode = 202;
      response.end(JSON.stringify({ ok: true, reason: "manual" }));
      return;
    }
    if (request.url === "/api/snapshot") {
      response.end(JSON.stringify({
        care: { status: "idle", conversationId: "care-cli-thread" },
        voice: { status: "idle" },
        vision: { status: "idle" },
        telemetry: {
          deviceId: "tab5-cli",
          batteryPercent: 80,
          charging: true,
          wifiRssi: -55,
          temperatureC: 41.5,
          transport: "wifi",
        },
      }));
      return;
    }
    const device = {
      deviceId: "tab5-cli",
      connected: true,
      transports: ["wifi"],
      primaryTransport: "wifi",
      protocolVersion: 5,
      deviceInfo: {
        boardId: "m5stack-tab5-k145",
        firmwareVersion: "0.3.0",
      },
      compatibility: { compatible: true },
    };
    if (request.url === "/api/devices") {
      response.end(JSON.stringify({ devices: [device] }));
      return;
    }
    if (request.url === "/api/diagnostics") {
      response.end(JSON.stringify({
        bridgeVersion: "0.3.0",
        target: {
          boardId: "m5stack-tab5-k145",
          protocolVersion: 5,
          minimumFirmwareVersion: "0.3.0",
        },
        codex: { connected: true },
        runtime: {
          uptimeSeconds: 1_000,
          memory: {
            rssBytes: 80 * 1024 * 1024,
            heapUsedBytes: 20 * 1024 * 1024,
          },
        },
        devices: [device],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  const firstRun = await runRecorder([
    "--base-url",
    `http://127.0.0.1:${address.port}`,
    "--duration-hours",
    "0.0015",
    "--sample-seconds",
    "1",
    "--device-id",
    "tab5-cli",
    "--care-events",
    eventsPath,
    "--output",
    outputPath,
    "--trigger-observation",
  ], { stopAfterMs: 1_300 });
  assert.equal(firstRun.code, 1, firstRun.stderr || firstRun.stdout);
  const checkpoint = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(checkpoint.report.passed, false);
  assert.ok(checkpoint.samples.length >= 2);
  assert.equal(checkpoint.trigger.ok, true);
  assert.equal(observationRequests, 1);

  const result = await runRecorder([
    "--base-url",
    `http://127.0.0.1:${address.port}`,
    "--device-id",
    "tab5-cli",
    "--care-events",
    eventsPath,
    "--resume",
    outputPath,
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const record = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(record.report.passed, true);
  assert.ok(record.samples.length >= 5);
  assert.equal(record.report.checks.fiveRoundConversation.ok, true);
  assert.equal(record.report.checks.memoryStable.ok, true);
});
