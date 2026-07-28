import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JsonLineDecoder, JsonRpcClient } from "../src/server/json-rpc-client.js";

test("JSON line decoder handles split and batched App Server messages", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"id":1'), []);
  assert.deepEqual(decoder.push('}\n{"method":"event"}\npar'), ['{"id":1}', '{"method":"event"}']);
  assert.deepEqual(decoder.push("tial"), []);
  assert.deepEqual(decoder.flush(), ["partial"]);
  decoder.push("stale");
  decoder.reset();
  assert.deepEqual(decoder.flush(), []);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      writable: true,
      write: (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          queueMicrotask(() => {
            this.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`));
          });
        }
        return true;
      },
    };
    queueMicrotask(() => this.emit("spawn"));
  }

  kill() {
    this.killed = true;
    this.stdin.writable = false;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    });
    return true;
  }
}

test("JSON-RPC client can restart cleanly and marks deliberate exits", async () => {
  const children = [];
  const launches = [];
  const client = new JsonRpcClient({
    spawnProcess: (command, args) => {
      const child = new FakeChild();
      children.push(child);
      launches.push({ command, args });
      return child;
    },
  });
  const exitDetails = [];
  client.on("exit", (_code, _signal, details) => exitDetails.push(details));

  await client.start();
  assert.equal(client.running, true);
  await client.stop();
  assert.deepEqual(exitDetails, [{ intentional: true }]);

  await client.start();
  assert.equal(client.running, true);
  assert.equal(children.length, 2);
  assert.deepEqual(launches, [
    {
      command: "codex",
      args: ["app-server", "--enable", "realtime_conversation", "--stdio"],
    },
    {
      command: "codex",
      args: ["app-server", "--enable", "realtime_conversation", "--stdio"],
    },
  ]);
  await client.stop();
});

test("JSON-RPC daemon mode keeps using the proxy entrypoint", async () => {
  let launch;
  const client = new JsonRpcClient({
    mode: "daemon",
    spawnProcess: (command, args) => {
      launch = { command, args };
      return new FakeChild();
    },
  });

  await client.start();
  assert.deepEqual(launch, {
    command: "codex",
    args: ["app-server", "proxy"],
  });
  await client.stop();
});
