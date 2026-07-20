import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createEnvelope } from "../src/shared/device-protocol.js";
import { JsonLineTransport } from "../src/server/transports/json-line-transport.js";

test("JSON-line transport carries split USB messages and rejects oversized input", async (t) => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const left = new JsonLineTransport({ readable: bToA, writable: aToB, kind: "usb" });
  const right = new JsonLineTransport({ readable: aToB, writable: bToA, kind: "usb" });
  t.after(() => {
    left.close();
    right.close();
    aToB.destroy();
    bToA.destroy();
  });

  const received = new Promise((resolve) => right.once("message", resolve));
  const message = createEnvelope({
    sequence: 1,
    type: "heartbeat",
    payload: { lastReceivedSequence: 0 },
    id: "usb-message-0001",
  });
  left.send(message);
  assert.deepEqual(await received, message);

  const error = new Promise((resolve) => right.once("error", resolve));
  aToB.write("x".repeat(right.maxBufferBytes + 1));
  assert.match((await error).message, /buffer exceeded/);
});

test("JSON-line transport preserves Chinese text split inside a UTF-8 character", async (t) => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const transport = new JsonLineTransport({ readable, writable, kind: "usb" });
  t.after(() => {
    transport.close();
    readable.destroy();
    writable.destroy();
  });
  const message = createEnvelope({
    sequence: 1,
    type: "event",
    payload: { event: "task.title", title: "正在运行中文任务" },
    id: "usb-unicode-0001",
  });
  const data = Buffer.from(`${JSON.stringify(message)}\n`);
  const splitAt = data.indexOf(Buffer.from("中")) + 1;
  const received = new Promise((resolve) => transport.once("message", resolve));
  readable.write(data.subarray(0, splitAt));
  readable.write(data.subarray(splitAt));
  assert.deepEqual(await received, message);
});
