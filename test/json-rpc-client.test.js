import test from "node:test";
import assert from "node:assert/strict";
import { JsonLineDecoder } from "../src/server/json-rpc-client.js";

test("JSON line decoder handles split and batched App Server messages", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"id":1'), []);
  assert.deepEqual(decoder.push('}\n{"method":"event"}\npar'), ['{"id":1}', '{"method":"event"}']);
  assert.deepEqual(decoder.push("tial"), []);
  assert.deepEqual(decoder.flush(), ["partial"]);
});

