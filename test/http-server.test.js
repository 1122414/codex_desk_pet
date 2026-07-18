import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../src/server/codex-bridge.js";
import { DeskStore } from "../src/server/desk-store.js";
import { DeskHttpServer } from "../src/server/http-server.js";
import { PetCatalog } from "../src/server/pet-catalog.js";
import { SettingsRepository } from "../src/server/settings-repository.js";

test("HTTP API requires a same-origin session for state changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-http-"));
  const catalog = new PetCatalog(path.join(root, "pets"));
  await catalog.refresh();
  const settings = new SettingsRepository(path.join(root, "settings.json"));
  const store = new DeskStore();
  const bridge = new CodexBridge({ store, mode: "mock" });
  await bridge.start();
  const server = new DeskHttpServer({ store, bridge, catalog, settings });
  const address = await server.listen({ port: 0 });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const denied = await fetch(`${base}/api/pet/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: "command-0001", petId: "codex-core" }),
  });
  assert.equal(denied.status, 403);

  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await session.json();
  const selected = await fetch(`${base}/api/pet/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "command-0002", petId: "codex-core" }),
  });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).selectedId, "codex-core");
});

