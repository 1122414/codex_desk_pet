import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { parseEnvelope, serializeEnvelope, TRANSPORT_PROFILES } from "../../shared/device-protocol.js";

export class JsonLineTransport extends EventEmitter {
  #buffer = "";
  #closed = false;
  #decoder = new StringDecoder("utf8");

  constructor({ readable, writable, kind = "usb" } = {}) {
    super();
    if (!readable?.on || typeof writable?.write !== "function") {
      throw new TypeError("JsonLineTransport requires readable and writable streams");
    }
    if (!TRANSPORT_PROFILES[kind]) throw new TypeError(`Unknown transport profile: ${kind}`);
    this.readable = readable;
    this.writable = writable;
    this.kind = kind;
    this.maxBufferBytes = TRANSPORT_PROFILES[kind].maxEnvelopeBytes * 2;
    this.onData = (chunk) => this.#onData(chunk);
    this.onEnd = () => this.close();
    this.onStreamError = (error) => this.#fail(error);
    // A USB device can emit stale boot or partial-frame bytes before a session
    // attaches its own error listener. Keep those bytes from terminating Node.
    this.on("error", () => {});
    readable.on("data", this.onData);
    readable.on("end", this.onEnd);
    readable.on("close", this.onEnd);
    readable.on("error", this.onStreamError);
    writable.on?.("error", this.onStreamError);
  }

  get open() {
    return !this.#closed;
  }

  send(envelope) {
    if (
      this.#closed ||
      this.writable.destroyed === true ||
      this.writable.writable === false
    ) {
      throw new Error(`${this.kind} transport is closed`);
    }
    const line = `${serializeEnvelope(envelope, this.kind)}\n`;
    this.writable.write(line);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.readable.off("data", this.onData);
    this.readable.off("end", this.onEnd);
    this.readable.off("close", this.onEnd);
    this.readable.off("error", this.onStreamError);
    this.writable.off?.("error", this.onStreamError);
    this.emit("close");
  }

  #onData(chunk) {
    this.#buffer += this.#decoder.write(Buffer.from(chunk));
    if (Buffer.byteLength(this.#buffer) > this.maxBufferBytes) {
      this.#buffer = "";
      this.#fail(new Error(`${this.kind} transport receive buffer exceeded its limit`));
      return;
    }
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emit("message", parseEnvelope(line, this.kind));
      } catch (error) {
        const bytes = Buffer.from(line, "utf8");
        error.message +=
          ` (${bytes.length} bytes, prefix ${bytes.subarray(0, 24).toString("hex")})`;
        this.#fail(error);
        return;
      }
    }
  }

  #fail(error) {
    if (this.#closed) return;
    this.emit("diagnostic", error.message);
    this.emit("error", error);
    this.close();
  }
}
