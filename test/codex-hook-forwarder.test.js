import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forwarder = path.join(
  root,
  "plugins",
  "codex-desk-buddy",
  "scripts",
  "forward-hook.mjs",
);

test("plugin hook forwards only bounded lifecycle metadata with its local token", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hook-forward-"));
  const tokenFile = path.join(temporary, "hook-token");
  const token = "8".repeat(64);
  await writeFile(tokenFile, `${token}\n`);
  let resolveRequest;
  const receivedRequest = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const received = {
        path: request.url,
        token: request.headers["x-codex-desk-hook-token"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(202);
      response.end();
      resolveRequest(received);
  });
  t.after(() => new Promise((close) => server.close(close)));
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const child = spawn(process.execPath, [forwarder], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_DESK_PORT: String(address.port),
      CODEX_DESK_HOOK_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "forward-session-1",
    turn_id: "forward-turn-1",
    cwd: "/private/project",
    prompt: `  Build\n${"x".repeat(300)}  `,
    transcript_path: "/private/secret/transcript.jsonl",
    permission_mode: "default",
  }));

  const received = await receivedRequest;
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(Buffer.concat(stdout).length, 0);
  assert.equal(Buffer.concat(stderr).length, 0);
  assert.equal(received.path, "/api/hooks/codex");
  assert.equal(received.token, token);
  assert.equal(received.body.event, "UserPromptSubmit");
  assert.equal(received.body.sessionId, "forward-session-1");
  assert.equal(received.body.workspaceName, "project");
  assert.equal(received.body.title.length, 120);
  assert.equal(Object.hasOwn(received.body, "transcript_path"), false);
  assert.equal(JSON.stringify(received.body).includes("secret/transcript"), false);
});

test("permission hook returns the documented Codex allow decision", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hook-permission-"));
  const tokenFile = path.join(temporary, "hook-token");
  const token = "7".repeat(64);
  await writeFile(tokenFile, `${token}\n`);
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ decision: "allow" }));
  });
  t.after(() => new Promise((close) => server.close(close)));
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const child = spawn(process.execPath, [forwarder], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_DESK_PORT: String(server.address().port),
      CODEX_DESK_HOOK_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify({
    hook_event_name: "PermissionRequest",
    session_id: "permission-session-1",
    turn_id: "permission-turn-1",
    cwd: "/private/project",
    tool_name: "Bash",
    tool_input: {
      command: "npm test",
      description: "运行测试",
    },
    transcript_path: "/private/secret/transcript.jsonl",
  }));
  const [code] = await once(child, "exit");

  assert.equal(code, 0);
  assert.equal(Buffer.concat(stderr).length, 0);
  assert.equal(received.path, "/api/hooks/codex/permission");
  assert.equal(received.body.detail, "npm test");
  assert.equal(received.body.detailComplete, true);
  assert.equal(received.body.reason, "运行测试");
  assert.equal(Object.hasOwn(received.body, "tool_input"), false);
  assert.equal(JSON.stringify(received.body).includes("secret/transcript"), false);
  assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString("utf8")), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
});
