import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommandDeduplicator,
  DEVICE_BOARD_ID,
  DEVICE_FIRMWARE_VERSION,
  DEVICE_PROTOCOL_VERSION,
  MINIMUM_DEVICE_FIRMWARE_VERSION,
} from "../shared/device-protocol.js";
import {
  normalizeCodexHookApproval,
  normalizeCodexHookEvent,
} from "./codex-hook.js";
import { validateCareSettingsPatch } from "./settings-repository.js";

const MAX_BODY_BYTES = 16 * 1024;
const BRIDGE_VERSION = "0.2.0";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return [part, ""];
    try {
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    } catch {
      return [part.slice(0, index), ""];
    }
  }));
}

async function readJson(req) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

function requireCommandId(body) {
  if (typeof body.commandId !== "string" || body.commandId.length < 8 || body.commandId.length > 128) {
    throw new HttpError(400, "A valid commandId is required");
  }
}

function validHookToken(expected, supplied) {
  if (
    typeof expected !== "string" ||
    typeof supplied !== "string" ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !/^[a-f0-9]{64}$/.test(supplied)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export class DeskHttpServer {
  #server;
  #sseClients = new Set();
  #heartbeatTimer = null;
  #sessionId = randomUUID();
  #csrfToken = randomUUID();
  #deduplicator = new CommandDeduplicator(512);

  constructor({
    store,
    bridge,
    catalog,
    settings,
    deviceHub = null,
    hookToken = null,
    hookApprovalBroker = null,
    petAgent = null,
    careAgent = null,
    voiceAgent = null,
    observationScheduler = null,
    careMemory = null,
    publicDirectory = path.join(PROJECT_ROOT, "public"),
  }) {
    this.store = store;
    this.bridge = bridge;
    this.catalog = catalog;
    this.settings = settings;
    this.deviceHub = deviceHub;
    this.hookToken = hookToken;
    this.hookApprovalBroker = hookApprovalBroker;
    this.petAgent = petAgent;
    this.careAgent = careAgent;
    this.voiceAgent = voiceAgent;
    this.observationScheduler = observationScheduler;
    this.careMemory = careMemory;
    this.publicDirectory = path.resolve(publicDirectory);
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        const status = error.status ?? 500;
        json(res, status, { error: status === 500 ? "Internal server error" : error.message });
        if (status === 500) this.onError?.(error);
      });
    });
    this.store.on("change", (snapshot) => this.#broadcast(snapshot));
  }

  async listen({ host = "127.0.0.1", port = 4317 } = {}) {
    if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
      throw new Error("MVP HTTP server only permits loopback hosts");
    }
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    this.#heartbeatTimer = setInterval(() => {
      for (const res of this.#sseClients) res.write(": heartbeat\n\n");
    }, 15_000);
    this.#heartbeatTimer.unref?.();
    return this.address();
  }

  address() {
    return this.#server.address();
  }

  async close() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    for (const res of this.#sseClients) res.end();
    this.#sseClients.clear();
    if (!this.#server.listening) return;
    await new Promise((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }

  async #handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;

    if (req.method === "GET" && route === "/api/health") {
      json(res, 200, { ok: true, revision: this.store.revision, connection: this.store.snapshot().connection });
      return;
    }
    if (req.method === "GET" && route === "/api/session") {
      json(res, 200, { csrfToken: this.#csrfToken }, {
        "Set-Cookie": `codex_desk_session=${encodeURIComponent(this.#sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
      });
      return;
    }
    if (req.method === "GET" && route === "/api/snapshot") {
      json(res, 200, this.store.snapshot());
      return;
    }
    if (req.method === "GET" && route === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      this.#sseClients.add(res);
      this.#writeEvent(res, this.store.snapshot());
      req.on("close", () => this.#sseClients.delete(res));
      return;
    }
    if (req.method === "GET" && route === "/api/pets") {
      json(res, 200, { pets: await this.catalog.refresh(), selectedId: this.store.selectedPetId });
      return;
    }
    if (req.method === "GET" && route === "/api/devices") {
      if (!this.deviceHub) throw new HttpError(503, "Device service is unavailable");
      json(res, 200, { devices: this.deviceHub.listDevices() });
      return;
    }
    if (req.method === "GET" && route === "/api/care/settings") {
      json(res, 200, { care: (await this.settings.load()).care });
      return;
    }
    if (req.method === "GET" && route === "/api/care/events") {
      if (!this.careMemory) throw new HttpError(503, "主动关怀记忆服务不可用");
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, "limit 必须是 1～100 的整数");
      }
      await this.careMemory.load();
      const events = this.careMemory.listEvents({ limit }).map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        summary: event.summary,
      }));
      json(res, 200, { events });
      return;
    }
    if (req.method === "GET" && route === "/api/diagnostics") {
      json(res, 200, {
        bridgeVersion: BRIDGE_VERSION,
        target: {
          boardId: DEVICE_BOARD_ID,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
          minimumFirmwareVersion: MINIMUM_DEVICE_FIRMWARE_VERSION,
        },
        codex: this.bridge.diagnostics?.() ?? null,
        hooks: {
          endpointReady: Boolean(this.hookToken),
          approvalReady: Boolean(this.hookToken && this.hookApprovalBroker),
        },
        companion: {
          available: Boolean(this.petAgent),
          pendingCommand: this.petAgent?.pendingCommand ?? null,
        },
        devices: this.deviceHub?.listDevices() ?? [],
      });
      return;
    }

    if (req.method === "POST" && route === "/api/hooks/codex/permission") {
      if (!this.hookToken || !this.hookApprovalBroker) {
        throw new HttpError(503, "Codex hook approval receiver is unavailable");
      }
      if (!validHookToken(this.hookToken, req.headers["x-codex-desk-hook-token"])) {
        throw new HttpError(403, "Valid Codex hook token is required");
      }
      const body = await readJson(req);
      if (!normalizeCodexHookApproval(body)) {
        throw new HttpError(400, "Codex hook approval is invalid");
      }
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => controller.abort());
      const decision = await this.hookApprovalBroker.request(body, {
        signal: controller.signal,
      });
      if (!decision) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      json(res, 200, {
        decision: decision === "accept" ? "allow" : "deny",
      });
      return;
    }

    if (req.method === "POST" && route === "/api/hooks/codex") {
      if (!this.hookToken) throw new HttpError(503, "Codex hook receiver is unavailable");
      if (!validHookToken(this.hookToken, req.headers["x-codex-desk-hook-token"])) {
        throw new HttpError(403, "Valid Codex hook token is required");
      }
      const body = await readJson(req);
      const event = normalizeCodexHookEvent(body);
      if (!event) throw new HttpError(400, "Codex hook event is invalid");
      this.store.handleCodexHook(event);
      json(res, 202, { ok: true });
      return;
    }

    if (req.method === "GET" && route === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const staticFiles = new Map([
      ["/", [path.join(this.publicDirectory, "index.html"), "text/html; charset=utf-8"]],
      ["/app.css", [path.join(this.publicDirectory, "app.css"), "text/css; charset=utf-8"]],
      ["/app.js", [path.join(this.publicDirectory, "app.js"), "text/javascript; charset=utf-8"]],
      ["/shared/pet-spec.js", [path.join(PROJECT_ROOT, "src", "shared", "pet-spec.js"), "text/javascript; charset=utf-8"]],
    ]);
    if (req.method === "GET" && staticFiles.has(route)) {
      const [filePath, contentType] = staticFiles.get(route);
      const data = await readFile(filePath);
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
        "Cache-Control": route === "/" ? "no-store" : "private, max-age=60",
      });
      res.end(data);
      return;
    }

    const assetMatch = route.match(/^\/api\/pets\/([a-z0-9][a-z0-9-]{0,63})\/spritesheet$/);
    if (req.method === "GET" && assetMatch) {
      let asset;
      try {
        asset = await this.catalog.readAsset(assetMatch[1]);
      } catch (error) {
        throw new HttpError(409, error.message);
      }
      if (!asset) throw new HttpError(404, "Pet spritesheet was not found");
      const etag = `"sha256-${asset.sha256}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "private, max-age=300" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Content-Length": asset.bytes,
        "Cache-Control": "private, max-age=300",
        ETag: etag,
      });
      res.end(asset.data);
      return;
    }

    if (req.method === "POST") {
      this.#requireMutationAccess(req);
      const body = await readJson(req);
      requireCommandId(body);
      if (!this.#deduplicator.accept(body.commandId)) {
        json(res, 202, { ok: true, duplicate: true });
        return;
      }

      if (route === "/api/pet/select") {
        if (typeof body.petId !== "string" || !this.catalog.has(body.petId)) throw new HttpError(404, "Pet was not found");
        await this.settings.save({ selectedPetId: body.petId });
        this.store.setSelectedPet(body.petId);
        json(res, 200, { ok: true, selectedId: body.petId });
        return;
      }
      if (route === "/api/care/settings") {
        if (!this.observationScheduler) throw new HttpError(503, "主动关怀调度服务不可用");
        try {
          const current = await this.settings.load();
          const care = validateCareSettingsPatch(body.care, current.care);
          const saved = await this.settings.save({ care });
          await this.observationScheduler.refreshSettings();
          json(res, 200, { ok: true, care: saved.care });
        } catch (error) {
          throw new HttpError(
            error instanceof TypeError || error instanceof RangeError ? 400 : 503,
            error.message,
          );
        }
        return;
      }
      if (route === "/api/care/observe") {
        if (!this.observationScheduler) throw new HttpError(503, "主动关怀调度服务不可用");
        const result = await this.observationScheduler.requestNow("manual");
        if (!result.accepted) {
          const reason = {
            disabled: "主动关怀当前已关闭",
            unavailable: "当前没有可拍照的 Tab5",
            busy: "主动关怀当前正忙",
            "duplicate-guard": "仍在重复观察保护期内",
          }[result.reason] ?? "当前无法立即观察";
          throw new HttpError(409, reason);
        }
        json(res, 202, { ok: true, ...result });
        return;
      }
      if (route === "/api/care/stop") {
        if (!this.careAgent) throw new HttpError(503, "主动关怀对话服务不可用");
        const conversation = this.careAgent.stopConversation();
        const voice = this.voiceAgent
          ? await this.voiceAgent.stopCareConversation()
          : { stoppedSessions: 0 };
        const devices = this.deviceHub?.stopCareConversation?.() ?? { notifiedDevices: 0 };
        json(res, 200, {
          ok: true,
          conversation,
          voice,
          devices,
          enabled: this.store.snapshot().care.enabled,
        });
        return;
      }
      if (route === "/api/companion/chat") {
        if (!this.petAgent) throw new HttpError(503, "宠物对话服务不可用");
        try {
          const result = await this.petAgent.chat(body.text);
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          throw new HttpError(error instanceof TypeError || error instanceof RangeError ? 400 : 503, error.message);
        }
        return;
      }
      if (route === "/api/companion/command") {
        if (!this.petAgent) throw new HttpError(503, "宠物命令服务不可用");
        try {
          const command = this.petAgent.queueCommand(body.text);
          json(res, 202, { ok: true, command });
        } catch (error) {
          throw new HttpError(error instanceof TypeError || error instanceof RangeError ? 400 : 409, error.message);
        }
        return;
      }
      if (route === "/api/companion/command/decide") {
        if (!this.petAgent) throw new HttpError(503, "宠物命令服务不可用");
        if (typeof body.requestId !== "string" || !["accept", "decline"].includes(body.decision)) {
          throw new HttpError(400, "requestId 和 accept/decline 决定不能为空");
        }
        try {
          const result = await this.petAgent.decideCommand(body.requestId, body.decision);
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          throw new HttpError(409, error.message);
        }
        return;
      }
      if (route === "/api/approval/decide") {
        if (typeof body.requestId !== "string" || !["accept", "decline"].includes(body.decision)) {
          throw new HttpError(400, "requestId and an accept/decline decision are required");
        }
        await this.bridge.decideApproval(body.requestId, body.decision);
        json(res, 200, { ok: true, decision: body.decision });
        return;
      }
      if (route === "/api/telemetry") {
        if (!Number.isFinite(body.batteryPercent) || body.batteryPercent < 0 || body.batteryPercent > 100) {
          throw new HttpError(400, "batteryPercent must be between 0 and 100");
        }
        if (!["simulator", "usb", "wifi", "ble"].includes(body.transport)) throw new HttpError(400, "transport is invalid");
        this.store.setTelemetry({
          batteryPercent: Math.round(body.batteryPercent),
          charging: Boolean(body.charging),
          transport: body.transport,
          wifiRssi: Number.isFinite(body.wifiRssi) ? Math.round(body.wifiRssi) : null,
        });
        json(res, 200, { ok: true });
        return;
      }
      if (route === "/api/devices/pairing") {
        if (!this.deviceHub) throw new HttpError(503, "Device service is unavailable");
        json(res, 201, { ok: true, ...this.deviceHub.createPairingOffer() });
        return;
      }
      if (route === "/api/devices/revoke") {
        if (!this.deviceHub) throw new HttpError(503, "Device service is unavailable");
        if (typeof body.deviceId !== "string") throw new HttpError(400, "deviceId is required");
        const revoked = await this.deviceHub.revokeDevice(body.deviceId);
        if (!revoked) throw new HttpError(404, "Paired device was not found");
        json(res, 200, { ok: true, deviceId: body.deviceId });
        return;
      }
      if (route === "/api/devices/wifi") {
        if (!this.deviceHub) throw new HttpError(503, "Device service is unavailable");
        try {
          const result = this.deviceHub.provisionWifi(body.deviceId, body);
          json(res, 202, { ok: true, ...result });
        } catch (error) {
          throw new HttpError(409, error.message);
        }
        return;
      }
      if (route === "/api/state/preview") {
        const animation = body.animation === null ? null : body.animation;
        try {
          this.store.setPreviewAnimation(animation);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        json(res, 200, { ok: true, animation });
        return;
      }
      if (route === "/api/mock/approval" && this.bridge.isMock) {
        const approval = this.bridge.createMockApproval();
        json(res, 201, { ok: true, requestId: approval.id });
        return;
      }
    }

    throw new HttpError(404, "Not found");
  }

  #requireMutationAccess(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.codex_desk_session !== this.#sessionId || req.headers["x-codex-desk-csrf"] !== this.#csrfToken) {
      throw new HttpError(403, "Valid local session and CSRF token are required");
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw new HttpError(403, "Cross-site requests are not allowed");
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) throw new HttpError(403, "Request origin does not match");
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(403, "Request origin is invalid");
      }
    }
  }

  #broadcast(snapshot) {
    for (const res of this.#sseClients) this.#writeEvent(res, snapshot);
  }

  #writeEvent(res, snapshot) {
    res.write(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }
}
