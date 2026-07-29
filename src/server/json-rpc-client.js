import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class JsonLineDecoder {
  #buffer = "";

  push(chunk) {
    this.#buffer += chunk.toString("utf8");
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.map((line) => line.trim()).filter(Boolean);
  }

  flush() {
    const line = this.#buffer.trim();
    this.#buffer = "";
    return line ? [line] : [];
  }

  reset() {
    this.#buffer = "";
  }
}

export class JsonRpcClient extends EventEmitter {
  #child = null;
  #nextRequestId = 1;
  #pending = new Map();
  #decoder = new JsonLineDecoder();
  #intentionallyStopped = new WeakSet();

  constructor({
    command = process.env.CODEX_DESK_CODEX_COMMAND ?? "codex",
    mode = "direct",
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnProcess = spawn,
  } = {}) {
    super();
    this.command = command;
    this.mode = mode;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnProcess = spawnProcess;
  }

  get running() {
    return Boolean(this.#child && this.#child.exitCode === null && !this.#child.killed);
  }

  async start() {
    if (this.running) return;
    this.#decoder.reset();
    const args = this.mode === "daemon"
      ? ["app-server", "proxy"]
      : ["app-server", "--enable", "realtime_conversation", "--stdio"];
    const child = this.spawnProcess(this.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.#child = child;

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        if (this.#child === child) this.#child = null;
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    child.stdout.on("data", (chunk) => {
      for (const line of this.#decoder.push(chunk)) this.#handleLine(line);
    });
    child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString("utf8").trim()));
    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => {
      const error = new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      if (this.#child === child) this.#child = null;
      this.emit("exit", code, signal, { intentional: this.#intentionallyStopped.has(child) });
    });

    const initialized = await this.request("initialize", {
      clientInfo: { name: "codex-desk-buddy", title: "Codex Desk Buddy", version: "0.4.1" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    this.notify("initialized");
    return initialized;
  }

  request(method, params = undefined) {
    if (!this.running) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    if (!this.running) throw new Error("Codex App Server is not running");
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id, result) {
    if (!this.running) throw new Error("Codex App Server is not running");
    this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    if (!this.running) throw new Error("Codex App Server is not running");
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async stop() {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    this.#intentionallyStopped.add(child);
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.#child?.stdin?.writable || !this.#child.stdin.write(line)) {
      if (!this.#child?.stdin?.writable) throw new Error("Codex App Server input is closed");
    }
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("diagnostic", `Ignored non-JSON App Server output: ${line.slice(0, 240)}`);
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `App Server request failed: ${pending.method}`);
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message.method, message.params ?? {});
  }
}
