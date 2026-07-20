import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  DEVICE_PROTOCOL_VERSION,
  TRANSPORT_PROFILES,
  parseEnvelope,
  serializeEnvelope,
} from "../../shared/device-protocol.js";

const HEADER_BYTES = 17;
const TOKEN_BYTES = 8;

function messageToken(data) {
  return createHash("sha256").update(data).digest().subarray(0, TOKEN_BYTES);
}

export class BleFragmentCodec {
  static fragment(serialized, mtuBytes = TRANSPORT_PROFILES.ble.linkMtuBytes) {
    const data = Buffer.from(serialized, "utf8");
    if (data.length > TRANSPORT_PROFILES.ble.maxEnvelopeBytes) {
      throw new Error("BLE message exceeds the reassembly limit");
    }
    const payloadBytes = mtuBytes - HEADER_BYTES;
    if (!Number.isInteger(payloadBytes) || payloadBytes < 1) throw new RangeError("BLE MTU is too small");
    const total = Math.ceil(data.length / payloadBytes);
    if (total > 0xffff) throw new Error("BLE message requires too many fragments");
    const token = messageToken(data);
    const fragments = [];
    for (let index = 0; index < total; index += 1) {
      const part = data.subarray(index * payloadBytes, Math.min((index + 1) * payloadBytes, data.length));
      const fragment = Buffer.allocUnsafe(HEADER_BYTES + part.length);
      fragment[0] = DEVICE_PROTOCOL_VERSION;
      token.copy(fragment, 1);
      fragment.writeUInt16BE(index, 9);
      fragment.writeUInt16BE(total, 11);
      fragment.writeUInt32BE(data.length, 13);
      part.copy(fragment, HEADER_BYTES);
      fragments.push(fragment);
    }
    return fragments;
  }
}

export class BleFragmentReassembler {
  #messages = new Map();

  constructor({ maxMessages = 4, timeoutMs = 10_000, now = Date.now } = {}) {
    this.maxMessages = maxMessages;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  accept(fragment) {
    if (!Buffer.isBuffer(fragment) || fragment.length <= HEADER_BYTES) throw new Error("BLE fragment is invalid");
    if (fragment[0] !== DEVICE_PROTOCOL_VERSION) throw new Error("BLE fragment version is unsupported");
    this.expire();
    const token = fragment.subarray(1, 9).toString("hex");
    const index = fragment.readUInt16BE(9);
    const total = fragment.readUInt16BE(11);
    const totalBytes = fragment.readUInt32BE(13);
    if (total < 1 || index >= total || totalBytes < 1 || totalBytes > TRANSPORT_PROFILES.ble.maxEnvelopeBytes) {
      throw new Error("BLE fragment metadata is invalid");
    }
    let message = this.#messages.get(token);
    if (!message) {
      if (this.#messages.size >= this.maxMessages) throw new Error("BLE reassembly queue is full");
      message = { total, totalBytes, parts: new Map(), receivedAt: this.now() };
      this.#messages.set(token, message);
    }
    if (message.total !== total || message.totalBytes !== totalBytes) {
      this.#messages.delete(token);
      throw new Error("BLE fragment metadata changed during transfer");
    }
    const part = Buffer.from(fragment.subarray(HEADER_BYTES));
    const existing = message.parts.get(index);
    if (existing && !existing.equals(part)) {
      this.#messages.delete(token);
      throw new Error("BLE fragment duplicate contains different bytes");
    }
    message.parts.set(index, part);
    message.receivedAt = this.now();
    if (message.parts.size !== total) return null;

    const ordered = [];
    for (let partIndex = 0; partIndex < total; partIndex += 1) {
      const value = message.parts.get(partIndex);
      if (!value) return null;
      ordered.push(value);
    }
    const data = Buffer.concat(ordered);
    this.#messages.delete(token);
    if (data.length !== totalBytes || messageToken(data).toString("hex") !== token) {
      throw new Error("BLE message checksum failed");
    }
    return data.toString("utf8");
  }

  expire(now = this.now()) {
    for (const [token, message] of this.#messages) {
      if (now - message.receivedAt >= this.timeoutMs) this.#messages.delete(token);
    }
  }
}

export class BleGattTransport extends EventEmitter {
  #closed = false;
  #reassembler;

  constructor({ adapter, mtuBytes = TRANSPORT_PROFILES.ble.linkMtuBytes, now = Date.now } = {}) {
    super();
    if (!adapter?.on || typeof adapter.writeFragment !== "function") {
      throw new TypeError("BleGattTransport requires a GATT adapter");
    }
    this.kind = "ble";
    this.adapter = adapter;
    this.mtuBytes = mtuBytes;
    this.#reassembler = new BleFragmentReassembler({ now });
    this.onFragment = (fragment) => this.#onFragment(fragment);
    this.onAdapterClose = () => this.close();
    this.onAdapterError = (error) => this.emit("error", error);
    adapter.on("fragment", this.onFragment);
    adapter.on("close", this.onAdapterClose);
    adapter.on("error", this.onAdapterError);
  }

  get open() {
    return !this.#closed;
  }

  send(envelope) {
    if (this.#closed) throw new Error("BLE transport is closed");
    const serialized = serializeEnvelope(envelope, "ble");
    for (const fragment of BleFragmentCodec.fragment(serialized, this.mtuBytes)) {
      this.adapter.writeFragment(fragment);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.adapter.off("fragment", this.onFragment);
    this.adapter.off("close", this.onAdapterClose);
    this.adapter.off("error", this.onAdapterError);
    this.adapter.close?.();
    this.emit("close");
  }

  #onFragment(fragment) {
    try {
      const serialized = this.#reassembler.accept(fragment);
      if (serialized !== null) this.emit("message", parseEnvelope(serialized, "ble"));
    } catch (error) {
      this.emit("error", error);
    }
  }
}
