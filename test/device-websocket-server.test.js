import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceSession } from "../src/server/device-session.js";
import { DeviceHub } from "../src/server/device-hub.js";
import { DeviceCredentialRepository } from "../src/server/device-credential-repository.js";
import { DeviceWebSocketServer } from "../src/server/device-websocket-server.js";
import { PetCatalog } from "../src/server/pet-catalog.js";
import { DeskStore } from "../src/server/desk-store.js";
import { SettingsRepository } from "../src/server/settings-repository.js";
import { WebSocketClientTransport } from "../src/server/transports/websocket-transport.js";

async function waitFor(predicate, timeoutMs = 750) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for WebSocket session");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("Wi-Fi WebSocket server carries an authenticated device session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-wifi-"));
  const credentials = new DeviceCredentialRepository(path.join(root, "devices.json"));
  await credentials.pair({ deviceId: "core-s3-wifi", secret: "f".repeat(64) });
  const store = new DeskStore();
  const hub = new DeviceHub({
    store,
    bridge: { decideApproval: async () => null },
    catalog: new PetCatalog(path.join(root, "pets")),
    settings: new SettingsRepository(path.join(root, "settings.json")),
    credentials,
  });
  await hub.start();
  const server = new DeviceWebSocketServer({ hub });
  const address = await server.listen({ port: 0 });
  t.after(async () => {
    await server.close();
    await hub.close();
  });

  const transport = await WebSocketClientTransport.connect(`ws://127.0.0.1:${address.port}/device/ws`);
  const device = new DeviceSession({
    role: "device",
    transport,
    deviceId: "core-s3-wifi",
    secret: "f".repeat(64),
  });
  t.after(() => device.close());
  const snapshots = [];
  device.on("snapshot", (snapshot) => snapshots.push(snapshot));
  device.start();
  await waitFor(() => device.ready && snapshots.length === 1);
  assert.equal(hub.listDevices()[0].primaryTransport, "wifi");
  assert.equal(snapshots[0].presentation.state, "ready");
});
