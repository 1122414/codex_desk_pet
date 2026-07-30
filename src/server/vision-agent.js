import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 3 * 1024;
const CAPTURE_TIMEOUT_MS = 30_000;
const CAPTURE_ID = /^[a-f0-9]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function validInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

export class VisionAgent {
  #captures = new Map();

  constructor({
    store,
    careAgent,
    settings = null,
    root = path.join(os.tmpdir(), "codex-desk-vision"),
    timeoutMs = CAPTURE_TIMEOUT_MS,
  } = {}) {
    if (!store || !careAgent) {
      throw new TypeError("VisionAgent requires store and CareAgent");
    }
    this.store = store;
    this.careAgent = careAgent;
    this.settings = settings;
    this.root = root;
    this.timeoutMs = timeoutMs;
  }

  acceptEvent(session, event) {
    if (!session?.ready || !["usb", "wifi"].includes(session.transport?.kind)) {
      throw new Error("视觉图片只允许通过已认证的 USB 或 Wi-Fi 链路");
    }
    switch (event?.event) {
      case "vision.capture.begin":
        return this.#begin(session, event);
      case "vision.capture.chunk":
        return this.#chunk(session, event);
      case "vision.capture.end":
        return this.#end(session, event);
      default:
        return false;
    }
  }

  disconnect(session) {
    for (const [key, capture] of this.#captures) {
      if (capture.session !== session) continue;
      clearTimeout(capture.timer);
      this.#captures.delete(key);
    }
  }

  close() {
    for (const capture of this.#captures.values()) clearTimeout(capture.timer);
    this.#captures.clear();
  }

  #begin(session, event) {
    if (
      typeof event.captureId !== "string" ||
      !CAPTURE_ID.test(event.captureId) ||
      event.mimeType !== "image/jpeg" ||
      !validInteger(event.totalBytes, 1, MAX_IMAGE_BYTES) ||
      !validInteger(event.width, 160, 2_048) ||
      !validInteger(event.height, 90, 2_048) ||
      typeof event.sha256 !== "string" ||
      !SHA256.test(event.sha256)
    ) {
      throw new Error("视觉图片清单无效");
    }
    const key = `${session.deviceId}:${event.captureId}`;
    if (this.#captures.has(key)) throw new Error("视觉图片传输已存在");
    const capture = {
      key,
      session,
      captureId: event.captureId,
      totalBytes: event.totalBytes,
      width: event.width,
      height: event.height,
      sha256: event.sha256,
      buffer: Buffer.alloc(event.totalBytes),
      offset: 0,
      timer: null,
    };
    capture.timer = setTimeout(() => {
      this.#captures.delete(key);
      this.store.setVision({
        status: "failed",
        captureId: capture.captureId,
        error: "摄像头图片传输超时",
      });
    }, this.timeoutMs);
    capture.timer.unref?.();
    this.#captures.set(key, capture);
    this.store.setVision({
      status: "receiving",
      captureId: capture.captureId,
      deviceId: session.deviceId,
      width: capture.width,
      height: capture.height,
      bytes: capture.totalBytes,
      reply: null,
      error: null,
    });
    return true;
  }

  #chunk(session, event) {
    const capture = this.#captureFor(session, event?.captureId);
    if (
      !validInteger(event.offset, 0, capture.totalBytes - 1) ||
      event.offset !== capture.offset ||
      typeof event.data !== "string" ||
      event.data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(event.data)
    ) {
      throw new Error("视觉图片分块无效");
    }
    const chunk = Buffer.from(event.data, "base64");
    if (
      chunk.length < 1 ||
      chunk.length > MAX_CHUNK_BYTES ||
      capture.offset + chunk.length > capture.totalBytes
    ) {
      throw new Error("视觉图片分块大小无效");
    }
    chunk.copy(capture.buffer, capture.offset);
    capture.offset += chunk.length;
    return true;
  }

  #end(session, event) {
    const capture = this.#captureFor(session, event?.captureId);
    if (capture.offset !== capture.totalBytes) {
      throw new Error("视觉图片尚未传输完整");
    }
    const digest = createHash("sha256").update(capture.buffer).digest("hex");
    if (digest !== capture.sha256) {
      this.#discard(capture);
      throw new Error("视觉图片完整性校验失败");
    }
    this.#discard(capture);
    this.#analyze(capture).catch((error) => this.#fail(capture, error));
    return true;
  }

  #discard(capture) {
    this.#captures.delete(capture.key);
    clearTimeout(capture.timer);
  }

  #captureFor(session, captureId) {
    if (typeof captureId !== "string" || !CAPTURE_ID.test(captureId)) {
      throw new Error("视觉图片编号无效");
    }
    const capture = this.#captures.get(`${session.deviceId}:${captureId}`);
    if (!capture || capture.session !== session) {
      throw new Error("视觉图片传输不存在");
    }
    return capture;
  }

  async #analyze(capture) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const imagePath = path.join(this.root, `${capture.captureId}.jpg`);
    await writeFile(imagePath, capture.buffer, { mode: 0o600 });
    this.store.setVision({ status: "analyzing", error: null });
    try {
      const result = await this.careAgent.observeImage(imagePath, {
        deviceId: capture.session.deviceId,
        state: {
          captureId: capture.captureId,
          width: capture.width,
          height: capture.height,
        },
      });
      const reply = this.#boundedText(result.say);
      this.store.setVision({ status: "completed", reply, error: null });
      capture.session.sendEvent({
        event: "care.reply",
        source: "observation",
        ok: true,
        text: reply,
        continueListening: result.continueListening,
        nextObservationMinutes: result.nextObservationMinutes,
        autoListenSeconds: await this.#autoListenSeconds(),
      });
    } finally {
      await rm(imagePath, { force: true });
    }
  }

  #fail(capture, error) {
    this.store.setVision({
      status: "failed",
      captureId: capture.captureId,
      error: error.message,
    });
    try {
      capture.session.sendEvent({
        event: "care.reply",
        source: "observation",
        ok: false,
        text: this.#boundedText(error.message),
        continueListening: false,
        nextObservationMinutes: null,
        autoListenSeconds: 20,
      });
    } catch {
      // The device may have disconnected.
    }
  }

  #boundedText(value, maximumBytes = 240) {
    const source = Buffer.from(String(value ?? ""), "utf8");
    if (source.length <= maximumBytes) return source.toString("utf8");
    let end = maximumBytes;
    while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
    return source.subarray(0, end).toString("utf8");
  }

  async #autoListenSeconds() {
    if (!this.settings?.load) return 20;
    try {
      const value = (await this.settings.load())?.care?.autoListenSeconds;
      return Number.isInteger(value) && value >= 5 && value <= 60 ? value : 20;
    } catch {
      return 20;
    }
  }
}
