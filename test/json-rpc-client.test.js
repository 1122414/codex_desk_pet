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
    this.messages = [];
    this.stdin = new EventEmitter();
    this.stdin.writable = true;
    this.stdin.write = (line) => {
      const message = JSON.parse(line);
      this.messages.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => {
          this.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`));
        });
      }
      return true;
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
  const client = new JsonRpcClient({
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  const exitDetails = [];
  client.on("exit", (_code, _signal, details) => exitDetails.push(details));

  await client.start();
  assert.equal(client.running, true);
  assert.equal(children[0].messages[0].params.clientInfo.version, "0.3.0");
  await client.stop();
  assert.deepEqual(exitDetails, [{ intentional: true }]);

  await client.start();
  assert.equal(client.running, true);
  assert.equal(children.length, 2);
  await client.stop();
});

test("JSON-RPC client consumes App Server stdin errors", async () => {
  let child;
  const client = new JsonRpcClient({
    spawnProcess: () => {
      child = new FakeChild();
      return child;
    },
  });
  const diagnostics = [];
  client.on("diagnostic", (message) => diagnostics.push(message));

  await client.start();
  child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  assert.match(diagnostics.at(-1), /Codex App Server input failed: broken pipe/);
  await client.stop();
});

test("JSON-RPC client consumes stdin errors emitted before spawn settles", async () => {
  let child;
  const client = new JsonRpcClient({
    spawnProcess: () => {
      child = new FakeChild();
      queueMicrotask(() => {
        child.stdin.emit("error", Object.assign(new Error("early broken pipe"), { code: "EPIPE" }));
      });
      return child;
    },
  });
  const diagnostics = [];
  client.on("diagnostic", (message) => diagnostics.push(message));

  await client.start();
  assert.match(diagnostics.at(-1), /Codex App Server input failed: early broken pipe/);
  await client.stop();
});
