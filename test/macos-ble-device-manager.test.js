import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  MacBleDeviceManager,
  buildMacBleHelper,
} from "../src/server/transports/macos-ble-device-manager.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.setEncoding("utf8");
    this.stdin.once("finish", () => this.emit("exit", 0, null));
  }

  kill() {
    this.emit("exit", null, "SIGTERM");
  }
}

test("buildMacBleHelper caches a compiler result by source contents", async () => {
  const calls = [];
  const signed = [];
  const cacheRoot = `/tmp/codex-desk-ble-test-${process.pid}-${Date.now()}`;
  const source = new URL("../src/server/transports/macos-core-bluetooth-helper.m", import.meta.url);
  const compile = async (_source, target) => {
    calls.push(target);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, "helper");
  };
  const signBundle = async (bundle) => signed.push(bundle);
  const first = await buildMacBleHelper({
    source,
    cacheRoot,
    compile,
    signBundle,
  });
  const second = await buildMacBleHelper({
    source,
    cacheRoot,
    compile,
    signBundle,
  });
  assert.equal(first, second);
  assert.match(first, /CodexDeskBluetooth\.app\/Contents\/MacOS\/CodexDeskBluetooth$/);
  assert.equal(calls.length, 1);
  assert.equal(signed.length, 1);
  const info = await readFile(resolve(dirname(first), "../Info.plist"), "utf8");
  assert.match(info, /com\.codex-desk\.bridge\.bluetooth/);
  assert.match(info, /NSBluetoothAlwaysUsageDescription/);
});

test("MacBleDeviceManager attaches a BLE transport and forwards fragments", async () => {
  const child = new FakeChild();
  const transports = [];
  const hub = {
    attachTransport(transport) {
      transport.on("error", () => {});
      transports.push(transport);
    },
  };
  const manager = new MacBleDeviceManager({
    hub,
    enabled: true,
    buildHelper: async () => "/tmp/fake-ble-helper",
    spawnHelper: () => child,
  });
  await manager.start();
  const attached = once(manager, "attached");
  child.stdout.write(`${JSON.stringify({
    type: "connected",
    id: "peripheral-1",
    name: "Codex Pet",
    maximumWriteBytes: 512,
  })}\n`);
  await attached;
  assert.equal(transports.length, 1);
  assert.equal(transports[0].kind, "ble");

  const fragment = Buffer.from("fragment");
  const received = once(transports[0].adapter, "fragment");
  child.stdout.write(`${JSON.stringify({
    type: "fragment",
    data: fragment.toString("base64"),
  })}\n`);
  assert.deepEqual((await received)[0], fragment);

  const writtenPromise = new Promise((resolve) => child.stdin.once("data", resolve));
  transports[0].adapter.writeFragment(fragment);
  const written = await writtenPromise;
  assert.deepEqual(JSON.parse(written), {
    type: "write",
    data: fragment.toString("base64"),
  });
  await manager.close();
});

test("MacBleDeviceManager closes the active transport on disconnect", async () => {
  const child = new FakeChild();
  let transport;
  const manager = new MacBleDeviceManager({
    hub: { attachTransport(value) { transport = value; } },
    enabled: true,
    buildHelper: async () => "/tmp/fake-ble-helper",
    spawnHelper: () => child,
  });
  await manager.start();
  const attached = once(manager, "attached");
  child.stdout.write('{"type":"connected","id":"peripheral-1","name":"Codex Pet"}\n');
  await attached;
  const closed = once(transport, "close");
  child.stdout.write('{"type":"disconnected","id":"peripheral-1","reason":"radio lost"}\n');
  await closed;
  assert.equal(transport.open, false);
  await manager.close();
});

test("MacBleDeviceManager ignores helper stdin EPIPE during shutdown", async () => {
  const child = new FakeChild();
  const manager = new MacBleDeviceManager({
    hub: { attachTransport() {} },
    enabled: true,
    buildHelper: async () => "/tmp/fake-ble-helper",
    spawnHelper: () => child,
  });
  await manager.start();
  child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  await manager.close();
});
