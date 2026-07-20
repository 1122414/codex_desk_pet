import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DeviceCredentialRepository,
  PairingCodeManager,
} from "../src/server/device-credential-repository.js";

test("device credentials persist atomically without exposing secrets in listings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-devices-"));
  const filePath = path.join(root, "private", "devices.json");
  const repository = new DeviceCredentialRepository(filePath);
  const paired = await repository.pair({
    deviceId: "core-s3-1",
    displayName: "Desk Unit",
    secret: "d".repeat(64),
    now: 100,
  });
  assert.equal(paired.secret, "d".repeat(64));
  assert.equal(Object.hasOwn(repository.list()[0], "secret"), false);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const reloaded = new DeviceCredentialRepository(filePath);
  assert.equal(await reloaded.getSecret("core-s3-1"), "d".repeat(64));
  await reloaded.revoke("core-s3-1", 200);
  assert.equal(await reloaded.getSecret("core-s3-1"), null);
  assert.deepEqual(reloaded.list(), []);
  assert.doesNotMatch(await readFile(filePath, "utf8"), /undefined/);
});

test("pairing codes are single-use and expire", () => {
  let now = 1_000;
  const manager = new PairingCodeManager({
    ttlMs: 100,
    now: () => now,
    randomCode: () => 42,
  });
  const offer = manager.createOffer();
  assert.deepEqual(offer, { code: "000042", expiresAt: 1_100 });
  assert.equal(manager.claim(offer.code), true);
  assert.equal(manager.claim(offer.code), false);
  const second = manager.createOffer();
  now = 1_101;
  assert.equal(manager.claim(second.code), false);
});

test("corrupt credential data is rejected instead of being silently overwritten", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-devices-corrupt-"));
  const filePath = path.join(root, "private", "devices.json");
  await mkdir(path.dirname(filePath));
  await writeFile(filePath, "{not-json");
  const repository = new DeviceCredentialRepository(filePath);
  await assert.rejects(() => repository.load(), SyntaxError);
  assert.equal(await readFile(filePath, "utf8"), "{not-json");
});

test("pairing code allocation fails safely after repeated collisions", () => {
  const manager = new PairingCodeManager({ randomCode: () => 7 });
  manager.createOffer();
  assert.throws(() => manager.createOffer(), /unique pairing code/);
});

test("pairing code manager bounds outstanding offers", () => {
  let code = 0;
  const manager = new PairingCodeManager({ maxOffers: 2, randomCode: () => code++ });
  manager.createOffer();
  manager.createOffer();
  assert.throws(() => manager.createOffer(), /Too many pairing codes/);
});
