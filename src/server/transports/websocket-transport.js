import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";
import { parseEnvelope, serializeEnvelope, TRANSPORT_PROFILES } from "../../shared/device-protocol.js";

const MAX_WEBSOCKET_PAYLOAD_BYTES = TRANSPORT_PROFILES.wifi.maxEnvelopeBytes;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeWebSocketFrame(payload, { opcode = 0x1, masked = false, maskKey = randomBytes(4) } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const extendedBytes = data.length < 126 ? 0 : data.length <= 0xffff ? 2 : 8;
  const headerBytes = 2 + extendedBytes + (masked ? 4 : 0);
  const frame = Buffer.allocUnsafe(headerBytes + data.length);
  frame[0] = 0x80 | opcode;
  if (extendedBytes === 0) {
    frame[1] = (masked ? 0x80 : 0) | data.length;
  } else if (extendedBytes === 2) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame.writeUInt16BE(data.length, 2);
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(data.length), 2);
  }
  let offset = 2 + extendedBytes;
  if (masked) {
    if (!Buffer.isBuffer(maskKey) || maskKey.length !== 4) throw new TypeError("WebSocket mask key must contain four bytes");
    maskKey.copy(frame, offset);
    offset += 4;
  }
  for (let index = 0; index < data.length; index += 1) {
    frame[offset + index] = masked ? data[index] ^ maskKey[index % 4] : data[index];
  }
  return frame;
}

export class WebSocketFrameDecoder {
  #buffer = Buffer.alloc(0);

  constructor({ expectMasked, maxPayloadBytes = MAX_WEBSOCKET_PAYLOAD_BYTES } = {}) {
    this.expectMasked = expectMasked;
    this.maxPayloadBytes = maxPayloadBytes;
  }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames = [];
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      if (first & 0x70) throw new Error("WebSocket extensions are not supported");
      if (this.expectMasked !== undefined && masked !== this.expectMasked) {
        throw new Error(masked ? "Server WebSocket frames must not be masked" : "Client WebSocket frames must be masked");
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) break;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) break;
        const bigLength = this.#buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
        length = Number(bigLength);
        offset = 10;
      }
      if (length > this.maxPayloadBytes) throw new Error("WebSocket frame exceeds the payload limit");
      if (opcode >= 0x8 && (!fin || length > 125)) throw new Error("WebSocket control frame is invalid");
      const maskBytes = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskBytes + length) break;
      const mask = masked ? this.#buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      frames.push({ fin, opcode, payload });
      this.#buffer = this.#buffer.subarray(offset + length);
    }
    return frames;
  }
}

export class WebSocketServerTransport extends EventEmitter {
  #decoder = new WebSocketFrameDecoder({ expectMasked: true });
  #fragments = [];
  #fragmentBytes = 0;
  #closed = false;

  constructor(socket) {
    super();
    this.kind = "wifi";
    this.socket = socket;
    this.onData = (chunk) => this.acceptData(chunk);
    this.onClose = () => this.#finishClose();
    this.onSocketError = (error) => this.emit("error", error);
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
    socket.on("end", this.onClose);
    socket.on("error", this.onSocketError);
  }

  get open() {
    return !this.#closed && !this.socket.destroyed;
  }

  send(envelope) {
    if (!this.open) throw new Error("Wi-Fi WebSocket transport is closed");
    this.socket.write(encodeWebSocketFrame(serializeEnvelope(envelope, "wifi")));
  }

  acceptData(chunk) {
    if (this.#closed || !chunk?.length) return;
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
    } catch (error) {
      this.emit("error", error);
      this.close(1002);
    }
  }

  close(code = 1000) {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.socket.destroyed) {
      const payload = Buffer.allocUnsafe(2);
      payload.writeUInt16BE(code);
      this.socket.end(encodeWebSocketFrame(payload, { opcode: 0x8 }));
    }
    this.#detach();
    this.emit("close");
  }

  #handleFrame(frame) {
    if (frame.opcode === 0x8) {
      this.close(1000);
      return;
    }
    if (frame.opcode === 0x9) {
      this.socket.write(encodeWebSocketFrame(frame.payload, { opcode: 0xA }));
      return;
    }
    if (frame.opcode === 0xA) return;
    if (frame.opcode === 0x1) {
      if (this.#fragments.length) throw new Error("A fragmented WebSocket message is already active");
      this.#fragments.push(frame.payload);
      this.#fragmentBytes = frame.payload.length;
    } else if (frame.opcode === 0x0) {
      if (!this.#fragments.length) throw new Error("Unexpected WebSocket continuation frame");
      this.#fragments.push(frame.payload);
      this.#fragmentBytes += frame.payload.length;
    } else {
      throw new Error("Only text WebSocket messages are supported");
    }
    if (this.#fragmentBytes > MAX_WEBSOCKET_PAYLOAD_BYTES) throw new Error("WebSocket message exceeds the payload limit");
    if (!frame.fin) return;
    const serialized = utf8Decoder.decode(Buffer.concat(this.#fragments));
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.emit("message", parseEnvelope(serialized, "wifi"));
  }

  #finishClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.emit("close");
  }

  #detach() {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("end", this.onClose);
    this.socket.off("error", this.onSocketError);
  }
}

export class WebSocketClientTransport extends EventEmitter {
  #closed = false;

  static async connect(url, WebSocketImpl = globalThis.WebSocket) {
    if (typeof WebSocketImpl !== "function") throw new Error("A WebSocket client implementation is required");
    const socket = new WebSocketImpl(url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        socket.removeEventListener("open", onOpen);
        reject(new Error("Wi-Fi WebSocket connection failed"));
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    return new WebSocketClientTransport(socket);
  }

  constructor(socket) {
    super();
    this.kind = "wifi";
    this.socket = socket;
    this.onMessage = (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("Wi-Fi WebSocket requires text messages");
        this.emit("message", parseEnvelope(event.data, "wifi"));
      } catch (error) {
        this.emit("error", error);
      }
    };
    this.onClose = () => this.#finishClose();
    this.onError = () => this.emit("error", new Error("Wi-Fi WebSocket transport failed"));
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("error", this.onError);
  }

  get open() {
    return !this.#closed && this.socket.readyState === this.socket.OPEN;
  }

  send(envelope) {
    if (!this.open) throw new Error("Wi-Fi WebSocket transport is closed");
    this.socket.send(serializeEnvelope(envelope, "wifi"));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.socket.close();
    this.emit("close");
  }

  #finishClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.emit("close");
  }

  #detach() {
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onError);
  }
}
