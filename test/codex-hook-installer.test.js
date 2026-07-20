import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectCodexHookInstallation,
  installCodexHooks,
  removeCodexHooks,
} from "../src/server/codex-hook-installer.js";
import { CODEX_HOOK_EVENTS } from "../src/server/codex-hook.js";

test("Codex hook installer is idempotent, preserves existing hooks, and removes only its own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hook-install-"));
  const sourceScript = path.join(root, "source.mjs");
  await writeFile(sourceScript, "process.exit(0);\n");
  await writeFile(path.join(root, "hooks.json"), JSON.stringify({
    description: "Existing hooks",
    custom: { keep: true },
    hooks: {
      Stop: [{
        hooks: [{
          type: "command",
          command: "node /existing/stop.mjs",
          timeout: 5,
        }],
      }],
    },
  }));

  const first = await installCodexHooks({ codexHome: root, sourceScript });
  await installCodexHooks({ codexHome: root, sourceScript });
  const installed = JSON.parse(await readFile(first.configPath, "utf8"));
  assert.deepEqual(installed.custom, { keep: true });
  assert.equal(installed.hooks.Stop.length, 2);
  for (const event of CODEX_HOOK_EVENTS) {
    const deskHandlers = installed.hooks[event].flatMap((group) => group.hooks)
      .filter((handler) => handler.statusMessage === "同步 Codex Desk Buddy 状态");
    assert.equal(deskHandlers.length, 1);
    assert.equal(
      deskHandlers[0].timeout,
      event === "PermissionRequest" ? 120 : 3,
    );
  }
  assert.equal((await inspectCodexHookInstallation(root)).configured, true);

  await removeCodexHooks({ codexHome: root });
  const removed = JSON.parse(await readFile(first.configPath, "utf8"));
  assert.equal(removed.hooks.Stop.length, 1);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "node /existing/stop.mjs");
  assert.equal((await inspectCodexHookInstallation(root)).configured, false);
});

test("Codex hook installer refuses to overwrite malformed configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-hook-invalid-"));
  const sourceScript = path.join(root, "source.mjs");
  await writeFile(sourceScript, "process.exit(0);\n");
  await writeFile(path.join(root, "hooks.json"), "{not-json");
  await assert.rejects(
    () => installCodexHooks({ codexHome: root, sourceScript }),
    /not valid JSON/,
  );
  assert.equal(await readFile(path.join(root, "hooks.json"), "utf8"), "{not-json");
});
