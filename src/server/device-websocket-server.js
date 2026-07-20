import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServerTransport } from "./transports/websocket-transport.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function rejectUpgrade(socket, status = "400 Bad Request") {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class DeviceWebSocketServer {
  #server;
  #transports = new Set();

  constructor({ hub } = {}) {
    if (!hub) throw new TypeError("DeviceWebSocketServer requires a DeviceHub");
    this.hub = hub;
    this.#server = createServer((_req, res) => {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": 9,
        "X-Content-Type-Options": "nosniff",
      });
      res.end("Not found");
    });
    this.#server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
  }

  async listen({ host = "127.0.0.1", port = 4318 } = {}) {
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    return this.address();
  }

  address() {
    return this.#server.address();
  }

  async close() {
    for (const transport of [...this.#transports]) transport.close(1001);
    this.#transports.clear();
    if (!this.#server.listening) return;
    await new Promise((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }

  #upgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    const key = req.headers["sec-websocket-key"];
    if (
      url.pathname !== "/device/ws" ||
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      req.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string"
    ) {
      rejectUpgrade(socket);
      return;
    }
    let decodedKey;
    try {
      decodedKey = Buffer.from(key, "base64");
    } catch {
      rejectUpgrade(socket);
      return;
    }
    if (decodedKey.length !== 16) {
      rejectUpgrade(socket);
      return;
    }
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    const transport = new WebSocketServerTransport(socket);
    this.#transports.add(transport);
    transport.once("close", () => this.#transports.delete(transport));
    try {
      this.hub.attachTransport(transport);
    } catch {
      transport.close(1013);
      return;
    }
    if (head.length) transport.acceptData(head);
  }
}
