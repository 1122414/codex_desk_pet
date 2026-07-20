import test from "node:test";
import assert from "node:assert/strict";
import {
  WebSocketFrameDecoder,
  encodeWebSocketFrame,
} from "../src/server/transports/websocket-transport.js";

test("WebSocket frame codec decodes split masked client frames", () => {
  const payload = Buffer.from("x".repeat(700));
  const frame = encodeWebSocketFrame(payload, {
    masked: true,
    maskKey: Buffer.from([1, 2, 3, 4]),
  });
  const decoder = new WebSocketFrameDecoder({ expectMasked: true });
  assert.deepEqual(decoder.push(frame.subarray(0, 17)), []);
  const decoded = decoder.push(frame.subarray(17));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].opcode, 1);
  assert.deepEqual(decoded[0].payload, payload);
});

test("WebSocket frame codec rejects unmasked client frames and oversized payloads", () => {
  const decoder = new WebSocketFrameDecoder({ expectMasked: true, maxPayloadBytes: 10 });
  assert.throws(() => decoder.push(encodeWebSocketFrame("hello")), /must be masked/);
  const limited = new WebSocketFrameDecoder({ expectMasked: false, maxPayloadBytes: 2 });
  assert.throws(() => limited.push(encodeWebSocketFrame("large")), /payload limit/);
});
