import { EventEmitter } from "node:events";
import { parseEnvelope, serializeEnvelope } from "../../shared/device-protocol.js";

class MemoryTransportEndpoint extends EventEmitter {
  #peer = null;
  #dropCount = 0;
  #duplicateCount = 0;
  #holdCount = 0;
  #held = [];

  constructor({ kind = "memory", latencyMs = 0 } = {}) {
    super();
    this.kind = kind;
    this.latencyMs = latencyMs;
    this.open = true;
  }

  connect(peer) {
    this.#peer = peer;
  }

  send(envelope) {
    if (!this.open || !this.#peer?.open) throw new Error(`${this.kind} transport is closed`);
    const serialized = serializeEnvelope(envelope, this.kind);
    const copy = parseEnvelope(serialized, this.kind);
    if (this.#dropCount > 0) {
      this.#dropCount -= 1;
      return;
    }
    if (this.#holdCount > 0) {
      this.#holdCount -= 1;
      this.#held.push(copy);
      return;
    }
    const copies = this.#duplicateCount > 0 ? 2 : 1;
    if (this.#duplicateCount > 0) this.#duplicateCount -= 1;
    for (let index = 0; index < copies; index += 1) this.#deliver(copy);
  }

  dropNext(count = 1) {
    this.#dropCount += count;
  }

  duplicateNext(count = 1) {
    this.#duplicateCount += count;
  }

  holdNext(count = 1) {
    this.#holdCount += count;
  }

  flushHeld() {
    const held = this.#held.splice(0);
    for (const envelope of held) this.#deliver(envelope);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
    if (this.#peer?.open) {
      this.#peer.open = false;
      this.#peer.emit("close");
    }
  }

  #deliver(envelope) {
    const deliver = () => {
      if (this.open && this.#peer?.open) this.#peer.emit("message", structuredClone(envelope));
    };
    if (this.latencyMs > 0) {
      const timer = setTimeout(deliver, this.latencyMs);
      timer.unref?.();
    } else {
      queueMicrotask(deliver);
    }
  }
}

export function createMemoryTransportPair(options = {}) {
  const left = new MemoryTransportEndpoint(options);
  const right = new MemoryTransportEndpoint(options);
  left.connect(right);
  right.connect(left);
  return { left, right };
}
