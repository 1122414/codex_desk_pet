import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createEnvelope } from "../src/shared/device-protocol.js";
import {
  BleFragmentCodec,
  BleFragmentReassembler,
  BleGattTransport,
} from "../src/server/transports/ble-gatt-transport.js";

class FakeGattAdapter extends EventEmitter {
  connect(peer) {
    this.peer = peer;
  }

  writeFragment(fragment) {
    queueMicrotask(() => this.peer.emit("fragment", Buffer.from(fragment)));
  }
}

function createGattPair() {
  const left = new FakeGattAdapter();
  const right = new FakeGattAdapter();
  left.connect(right);
  right.connect(left);
  return { left, right };
}

test("BLE fragment codec reassembles out-of-order and duplicate MTU packets", () => {
  const serialized = JSON.stringify({ value: "x".repeat(1_500) });
  const fragments = BleFragmentCodec.fragment(serialized, 80);
  assert.ok(fragments.length > 20);
  assert.ok(fragments.every((fragment) => fragment.length <= 80));
  const reassembler = new BleFragmentReassembler();
  assert.equal(reassembler.accept(fragments[3]), null);
  assert.equal(reassembler.accept(fragments[3]), null);
  let result = null;
  for (const fragment of fragments.toReversed()) {
    const assembled = reassembler.accept(fragment);
    if (assembled !== null) result = assembled;
  }
  assert.equal(result, serialized);
});

test("BLE GATT transport carries a complete protocol envelope across fragments", async (t) => {
  const adapters = createGattPair();
  const left = new BleGattTransport({ adapter: adapters.left, mtuBytes: 72 });
  const right = new BleGattTransport({ adapter: adapters.right, mtuBytes: 72 });
  t.after(() => {
    left.close();
    right.close();
  });
  const message = createEnvelope({
    sequence: 1,
    type: "snapshot",
    payload: { task: "x".repeat(1_200), state: "running" },
    id: "ble-message-0001",
  });
  const received = new Promise((resolve) => right.once("message", resolve));
  left.send(message);
  assert.deepEqual(await received, message);
});
