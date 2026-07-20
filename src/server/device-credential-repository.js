import { randomInt, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPairingSecret,
  normalizeDeviceInfo,
} from "../shared/device-protocol.js";

const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CREDENTIAL_FILE_BYTES = 256 * 1024;

function defaultCredentialPath() {
  return path.join(os.homedir(), ".codex-desk", "devices.json");
}

function normalizeRecord(deviceId, record) {
  if (!DEVICE_ID_PATTERN.test(deviceId) || !record || typeof record !== "object" || Array.isArray(record)) return null;
  if (!SECRET_PATTERN.test(record.secret)) return null;
  return {
    deviceId,
    displayName: typeof record.displayName === "string" ? record.displayName.slice(0, 80) : deviceId,
    secret: record.secret,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    lastSeenAt: Number.isFinite(record.lastSeenAt) ? record.lastSeenAt : null,
    revokedAt: Number.isFinite(record.revokedAt) ? record.revokedAt : null,
    deviceInfo: normalizeDeviceInfo(record.deviceInfo),
  };
}

export class DeviceCredentialRepository {
  #devices = new Map();
  #loaded = false;
  #saveQueue = Promise.resolve();

  constructor(filePath = defaultCredentialPath()) {
    this.filePath = filePath;
  }

  async load() {
    if (this.#loaded) return this.list();
    try {
      const raw = await readFile(this.filePath);
      if (raw.length > MAX_CREDENTIAL_FILE_BYTES) throw new Error("Device credential file is too large");
      const parsed = JSON.parse(raw.toString("utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        parsed.version !== 1 ||
        !parsed.devices ||
        typeof parsed.devices !== "object" ||
        Array.isArray(parsed.devices)
      ) {
        throw new Error("Device credential file has an unsupported format");
      }
      for (const [deviceId, record] of Object.entries(parsed?.devices ?? {})) {
        const normalized = normalizeRecord(deviceId, record);
        if (normalized) this.#devices.set(deviceId, normalized);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.#loaded = true;
    return this.list();
  }

  async pair({ deviceId, displayName = deviceId, secret = createPairingSecret(), now = Date.now() }) {
    await this.load();
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("Device id is invalid");
    if (!SECRET_PATTERN.test(secret)) throw new Error("Device secret is invalid");
    const record = {
      deviceId,
      displayName: String(displayName).slice(0, 80),
      secret,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      deviceInfo: null,
    };
    this.#devices.set(deviceId, record);
    await this.#save();
    return { ...record };
  }

  async getSecret(deviceId) {
    await this.load();
    const record = this.#devices.get(deviceId);
    return record && record.revokedAt === null ? record.secret : null;
  }

  async touch(deviceId, now = Date.now(), deviceInfo = null) {
    await this.load();
    const record = this.#devices.get(deviceId);
    if (!record || record.revokedAt !== null) return false;
    record.lastSeenAt = now;
    const normalizedInfo = normalizeDeviceInfo(deviceInfo);
    if (normalizedInfo) record.deviceInfo = normalizedInfo;
    await this.#save();
    return true;
  }

  async revoke(deviceId, now = Date.now()) {
    await this.load();
    const record = this.#devices.get(deviceId);
    if (!record || record.revokedAt !== null) return false;
    record.revokedAt = now;
    await this.#save();
    return true;
  }

  list() {
    return [...this.#devices.values()]
      .filter((record) => record.revokedAt === null)
      .map(({ secret: _secret, ...record }) => ({ ...record }));
  }

  async #save() {
    const save = this.#saveQueue.then(async () => {
      const directory = path.dirname(this.filePath);
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const devices = Object.fromEntries([...this.#devices].map(([deviceId, record]) => [deviceId, record]));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.filePath);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
    this.#saveQueue = save.catch(() => {});
    return save;
  }
}

export class PairingCodeManager {
  #offers = new Map();

  constructor({
    ttlMs = 5 * 60_000,
    maxOffers = 8,
    now = Date.now,
    randomCode = () => randomInt(0, 1_000_000),
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError("Pairing code lifetime must be positive");
    if (!Number.isInteger(maxOffers) || maxOffers < 1) throw new RangeError("Pairing offer limit must be positive");
    if (typeof now !== "function" || typeof randomCode !== "function") {
      throw new TypeError("Pairing code clock and generator must be functions");
    }
    this.ttlMs = ttlMs;
    this.maxOffers = maxOffers;
    this.now = now;
    this.randomCode = randomCode;
  }

  createOffer() {
    this.expire();
    if (this.#offers.size >= this.maxOffers) throw new Error("Too many pairing codes are active");
    let code = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = this.randomCode();
      if (!Number.isInteger(candidate) || candidate < 0 || candidate >= 1_000_000) {
        throw new Error("Pairing code generator returned an invalid value");
      }
      const formatted = String(candidate).padStart(6, "0");
      if (!this.#offers.has(formatted)) {
        code = formatted;
        break;
      }
    }
    if (code === null) throw new Error("Could not allocate a unique pairing code");
    const offer = { code, expiresAt: this.now() + this.ttlMs };
    this.#offers.set(code, offer);
    return { ...offer };
  }

  claim(code) {
    this.expire();
    const offer = this.#offers.get(code);
    if (!offer) return false;
    this.#offers.delete(code);
    return true;
  }

  expire(now = this.now()) {
    for (const [code, offer] of this.#offers) {
      if (offer.expiresAt <= now) this.#offers.delete(code);
    }
  }
}
