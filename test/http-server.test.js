import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../src/server/codex-bridge.js";
import { DeskStore } from "../src/server/desk-store.js";
import { DeskHttpServer } from "../src/server/http-server.js";
import { HookApprovalBroker } from "../src/server/hook-approval-broker.js";
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

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for HTTP state");
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
  const hookApprovalBroker = new HookApprovalBroker({ store });
  const bridge = new CodexBridge({ store, mode: "mock", hookApprovalBroker });
  await bridge.start();
  const deviceHub = {
    listDevices: () => [{ deviceId: "core-s3-1", displayName: "Desk Unit", connected: false, transports: [] }],
    createPairingOffer: () => ({ code: "123456", expiresAt: 123_000 }),
    revokeDevice: async (deviceId) => deviceId === "core-s3-1",
    provisionWifi: (deviceId, provisioning) => ({
      deviceId,
      transport: provisioning.ssid === "Desk Wi-Fi" ? "usb" : "invalid",
    }),
  };
  const hookToken = "9".repeat(64);
  const server = new DeskHttpServer({
    store,
    bridge,
    catalog,
    settings,
    deviceHub,
    hookToken,
    hookApprovalBroker,
  });
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
  const diagnostics = await fetch(`${base}/api/diagnostics`);
  const diagnosticBody = await diagnostics.json();
  assert.equal(diagnosticBody.target.boardId, "m5stack-tab5-k145");
  assert.equal(diagnosticBody.target.protocolVersion, 3);
  assert.equal(diagnosticBody.codex.appServerUserAgent, "codex-desk-mock");
  assert.equal(diagnosticBody.hooks.endpointReady, true);
  assert.equal(diagnosticBody.hooks.approvalReady, true);

  const deniedHook = await fetch(`${base}/api/hooks/codex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      event: "UserPromptSubmit",
      sessionId: "hook-http-session",
      title: "跨客户端任务",
      occurredAt: Date.now(),
    }),
  });
  assert.equal(deniedHook.status, 403);
  const acceptedHook = await fetch(`${base}/api/hooks/codex`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Desk-Hook-Token": hookToken,
    },
    body: JSON.stringify({
      version: 1,
      event: "UserPromptSubmit",
      sessionId: "hook-http-session",
      title: "跨客户端任务",
      occurredAt: Date.now(),
    }),
  });
  assert.equal(acceptedHook.status, 202);
  const hookSnapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(hookSnapshot.task.title, "跨客户端任务");
  assert.equal(hookSnapshot.presentation.state, "running");

  const hookApprovalResponse = fetch(`${base}/api/hooks/codex/permission`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Desk-Hook-Token": hookToken,
    },
    body: JSON.stringify({
      version: 1,
      event: "PermissionRequest",
      requestId: "hook-http-request-1",
      sessionId: "hook-http-session",
      turnId: "hook-http-turn",
      toolName: "Bash",
      detail: "npm test",
      detailComplete: true,
      reason: "运行测试",
      occurredAt: Date.now(),
    }),
  });
  const hookApproval = await waitFor(() => store.snapshot().approval);
  assert.equal(hookApproval.source, "codex-hook");
  await bridge.decideApproval(hookApproval.id, "accept");
  assert.deepEqual(await (await hookApprovalResponse).json(), {
    decision: "allow",
  });
  const hookDenialResponse = fetch(`${base}/api/hooks/codex/permission`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Desk-Hook-Token": hookToken,
    },
    body: JSON.stringify({
      version: 1,
      event: "PermissionRequest",
      requestId: "hook-http-request-2",
      sessionId: "hook-http-session",
      turnId: "hook-http-turn",
      toolName: "apply_patch",
      detail: "*** Begin Patch\n*** End Patch",
      detailComplete: true,
      occurredAt: Date.now(),
    }),
  });
  const hookDenial = await waitFor(() => {
    const approval = store.snapshot().approval;
    return approval?.hookRequestId === "hook-http-request-2" ? approval : null;
  });
  await bridge.decideApproval(hookDenial.id, "decline");
  assert.deepEqual(await (await hookDenialResponse).json(), {
    decision: "deny",
  });

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

  const wifiProvisioning = await fetch(`${base}/api/devices/wifi`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({
      commandId: "command-wifi-0001",
      deviceId: "core-s3-1",
      ssid: "Desk Wi-Fi",
      password: "secret",
      bridgeHost: "192.168.1.20",
      bridgePort: 4318,
    }),
  });
  assert.equal(wifiProvisioning.status, 202);
  assert.deepEqual(await wifiProvisioning.json(), {
    ok: true,
    deviceId: "core-s3-1",
    transport: "usb",
  });

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
