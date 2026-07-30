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
    stopCareConversation: () => ({ notifiedDevices: 1 }),
  };
  const hookToken = "9".repeat(64);
  const petAgent = {
    pendingCommand: null,
    chat: async (text) => ({ reply: `宠物回复：${text}` }),
    queueCommand(text) {
      this.pendingCommand = { requestId: "pet-command-1", prompt: text, createdAt: Date.now() };
      return this.pendingCommand;
    },
    decideCommand: async (requestId, decision) => ({ requestId, decision }),
  };
  let settingsRefreshes = 0;
  let immediateObservations = 0;
  let careStops = 0;
  let voiceStops = 0;
  const observationScheduler = {
    refreshSettings: async () => { settingsRefreshes += 1; },
    requestNow: async () => {
      immediateObservations += 1;
      return {
        accepted: true,
        deviceId: "core-s3-1",
        reason: "manual",
        commandId: "camera-command-1",
      };
    },
  };
  const careAgent = {
    stopConversation: () => {
      careStops += 1;
      store.setCare({ status: "idle", conversationId: null });
      return { stopped: true, conversationId: "care-thread-1" };
    },
  };
  const voiceAgent = {
    stopCareConversation: async () => {
      voiceStops += 1;
      return { stoppedSessions: 1 };
    },
  };
  const careMemory = {
    load: async () => null,
    listEvents: ({ limit }) => [{
      id: "care-event-1",
      type: "conversation.assistant_reply",
      occurredAt: 1_800_000_000_000,
      summary: "记得休息一下",
      data: { private: true },
    }].slice(-limit),
  };
  const server = new DeskHttpServer({
    store,
    bridge,
    catalog,
    settings,
    deviceHub,
    hookToken,
    hookApprovalBroker,
    petAgent,
    careAgent,
    voiceAgent,
    observationScheduler,
    careMemory,
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
  const pageText = await page.text();
  assert.match(pageText, /Codex Desk Buddy/);
  assert.match(pageText, /id="care-enabled"/);
  assert.match(pageText, /id="care-observe-now"/);
  assert.match(pageText, /id="care-stop"/);

  const appModule = await fetch(`${base}/app.js`);
  assert.match(await appModule.text(), /CARE_PRESENTATIONS/);

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
  assert.equal(diagnosticBody.bridgeVersion, "0.3.0");
  assert.equal(diagnosticBody.target.boardId, "m5stack-tab5-k145");
  assert.equal(diagnosticBody.target.protocolVersion, 5);
  assert.ok(diagnosticBody.runtime.memory.rssBytes > 0);
  assert.equal(diagnosticBody.codex.appServerUserAgent, "codex-desk-mock");
  assert.equal(diagnosticBody.hooks.endpointReady, true);
  assert.equal(diagnosticBody.hooks.approvalReady, true);
  assert.equal(diagnosticBody.companion.available, true);

  const careSettingsResponse = await fetch(`${base}/api/care/settings`);
  assert.equal(careSettingsResponse.status, 200);
  assert.equal((await careSettingsResponse.json()).care.duplicateGuardSeconds, 90);
  const careEventsResponse = await fetch(`${base}/api/care/events?limit=1`);
  assert.deepEqual(await careEventsResponse.json(), {
    events: [{
      id: "care-event-1",
      type: "conversation.assistant_reply",
      occurredAt: 1_800_000_000_000,
      summary: "记得休息一下",
    }],
  });
  assert.equal((await fetch(`${base}/api/care/events?limit=101`)).status, 400);

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

  const invalidCareSettings = await fetch(`${base}/api/care/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({
      commandId: "care-settings-invalid-0001",
      care: {
        observationMinimumMinutes: 40,
        observationMaximumMinutes: 10,
      },
    }),
  });
  assert.equal(invalidCareSettings.status, 400);

  const savedCareSettings = await fetch(`${base}/api/care/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({
      commandId: "care-settings-save-0001",
      care: {
        observationMinimumMinutes: 4,
        observationMaximumMinutes: 9,
        autoListenSeconds: 15,
        allowedActions: ["schedule_follow_up"],
      },
    }),
  });
  assert.equal(savedCareSettings.status, 200);
  const savedCare = (await savedCareSettings.json()).care;
  assert.equal(savedCare.observationMinimumMinutes, 4);
  assert.equal(savedCare.observationMaximumMinutes, 9);
  assert.deepEqual(savedCare.allowedActions, ["schedule_follow_up"]);
  assert.equal(settingsRefreshes, 1);

  const immediateObservation = await fetch(`${base}/api/care/observe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "care-observe-now-0001" }),
  });
  assert.equal(immediateObservation.status, 202);
  assert.equal((await immediateObservation.json()).deviceId, "core-s3-1");
  assert.equal(immediateObservations, 1);

  store.setCare({
    status: "listening",
    enabled: true,
    conversationId: "care-thread-1",
  });
  const stoppedCare = await fetch(`${base}/api/care/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "care-stop-now-0001" }),
  });
  assert.equal(stoppedCare.status, 200);
  const stoppedCareBody = await stoppedCare.json();
  assert.equal(stoppedCareBody.enabled, true);
  assert.equal(stoppedCareBody.devices.notifiedDevices, 1);
  assert.equal(careStops, 1);
  assert.equal(voiceStops, 1);

  const companionChat = await fetch(`${base}/api/companion/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "companion-chat-0001", text: "你好" }),
  });
  assert.deepEqual(await companionChat.json(), { ok: true, reply: "宠物回复：你好" });

  const companionCommand = await fetch(`${base}/api/companion/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({ commandId: "companion-command-0001", text: "运行测试" }),
  });
  assert.equal(companionCommand.status, 202);
  const queuedCommand = await companionCommand.json();
  assert.equal(queuedCommand.command.requestId, "pet-command-1");

  const companionDecision = await fetch(`${base}/api/companion/command/decide`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Codex-Desk-CSRF": csrfToken,
      Origin: base,
    },
    body: JSON.stringify({
      commandId: "companion-decision-0001",
      requestId: "pet-command-1",
      decision: "accept",
    }),
  });
  assert.deepEqual(await companionDecision.json(), {
    ok: true,
    requestId: "pet-command-1",
    decision: "accept",
  });

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
