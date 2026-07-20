import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../src/server/codex-bridge.js";
import { DeskStore } from "../src/server/desk-store.js";
import { DeskHttpServer } from "../src/server/http-server.js";
import { PetCatalog } from "../src/server/pet-catalog.js";
import { SettingsRepository } from "../src/server/settings-repository.js";

function makeV1Webp() {
  const file = Buffer.alloc(30);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WEBP", 8, "ascii");
  file.write("VP8X", 12, "ascii");
  file.writeUInt32LE(10, 16);
  file.writeUIntLE(1536 - 1, 24, 3);
  file.writeUIntLE(1872 - 1, 27, 3);
  return file;
}

test("HTTP API requires a same-origin session for state changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-http-"));
  const petsRoot = path.join(root, "pets");
  const customPetDir = path.join(petsRoot, "http-pet");
  await mkdir(customPetDir, { recursive: true });
  await writeFile(path.join(customPetDir, "pet.json"), JSON.stringify({
    id: "http-pet",
    displayName: "HTTP Pet",
    spritesheetPath: "spritesheet.webp",
  }));
  const spritesheet = makeV1Webp();
  await writeFile(path.join(customPetDir, "spritesheet.webp"), spritesheet);
  const catalog = new PetCatalog(petsRoot);
  await catalog.refresh();
  const settings = new SettingsRepository(path.join(root, "settings.json"));
  const store = new DeskStore();
  const bridge = new CodexBridge({ store, mode: "mock" });
  await bridge.start();
  const deviceHub = {
    listDevices: () => [{ deviceId: "core-s3-1", displayName: "Desk Unit", connected: false, transports: [] }],
    createPairingOffer: () => ({ code: "123456", expiresAt: 123_000 }),
    revokeDevice: async (deviceId) => deviceId === "core-s3-1",
  };
  const server = new DeskHttpServer({ store, bridge, catalog, settings, deviceHub });
  const address = await server.listen({ port: 0 });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await page.text(), /Codex Desk Buddy/);

  const sharedModule = await fetch(`${base}/shared/pet-spec.js`);
  assert.equal(sharedModule.status, 200);
  assert.match(await sharedModule.text(), /STANDARD_ANIMATIONS/);

  const petList = await fetch(`${base}/api/pets`);
  const { pets } = await petList.json();
  const customPet = pets.find((pet) => pet.id === "http-pet");
  assert.equal(customPet.spriteVersionNumber, 1);
  assert.equal(customPet.atlasHeight, 1872);

  const petAsset = await fetch(`${base}${customPet.assetUrl}`);
  assert.equal(petAsset.status, 200);
  assert.equal(petAsset.headers.get("content-type"), "image/webp");
  assert.deepEqual(Buffer.from(await petAsset.arrayBuffer()), spritesheet);
  const notModified = await fetch(`${base}${customPet.assetUrl}`, {
    headers: { "If-None-Match": petAsset.headers.get("etag") },
  });
  assert.equal(notModified.status, 304);

  const devices = await fetch(`${base}/api/devices`);
  assert.equal((await devices.json()).devices[0].deviceId, "core-s3-1");

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

  const pairing = await fetch(`${base}/api/devices/pairing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "command-0003" }),
  });
  assert.deepEqual(await pairing.json(), { ok: true, code: "123456", expiresAt: 123_000 });

  const revoked = await fetch(`${base}/api/devices/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "command-0004", deviceId: "core-s3-1" }),
  });
  assert.equal(revoked.status, 200);
});
