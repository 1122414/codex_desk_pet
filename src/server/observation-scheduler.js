import { EventEmitter } from "node:events";

const BUSY_CARE_STATUSES = new Set([
  "observing",
  "thinking",
  "speaking",
  "listening",
  "acting",
]);
const BUSY_VOICE_STATUSES = new Set([
  "starting",
  "listening",
  "transcribing",
  "processing",
]);
const BUSY_VISION_STATUSES = new Set([
  "receiving",
  "analyzing",
]);
const CAPTURE_REASONS = new Set(["scheduled", "follow-up", "manual"]);

export class ObservationScheduler extends EventEmitter {
  #started = false;
  #available = false;
  #timer = null;
  #dueAt = null;
  #settings = null;
  #publishing = false;
  #lastCaptureByDevice = new Map();

  constructor({
    store,
    settings,
    selectDevice,
    capture,
    now = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    super();
    if (
      !store ||
      !settings ||
      typeof selectDevice !== "function" ||
      typeof capture !== "function"
    ) {
      throw new TypeError("ObservationScheduler requires store, settings, device selector, and capture");
    }
    if (
      typeof now !== "function" ||
      typeof random !== "function" ||
      typeof setTimer !== "function" ||
      typeof clearTimer !== "function"
    ) {
      throw new TypeError("ObservationScheduler clock and timer dependencies must be functions");
    }
    this.store = store;
    this.settingsRepository = settings;
    this.selectDevice = selectDevice;
    this.capture = capture;
    this.now = now;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onStoreChange = (snapshot) => this.#syncSnapshot(snapshot);
  }

  get dueAt() {
    return this.#dueAt;
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    this.store.on("change", this.onStoreChange);
    await this.refreshSettings();
  }

  stop() {
    if (!this.#started) return;
    this.#started = false;
    this.store.off("change", this.onStoreChange);
    this.#cancelTimer();
    this.#dueAt = null;
  }

  async refreshSettings() {
    const loaded = await this.settingsRepository.load();
    this.#settings = loaded.care;
    this.#publish({
      enabled: this.#settings.enabled,
      ...(!this.#settings.enabled ? { nextObservationAt: null } : {}),
    });
    if (!this.#settings.enabled) {
      this.#dueAt = null;
      this.#cancelTimer();
      return;
    }
    if (this.#available && this.#dueAt === null) this.schedule();
    else this.#arm();
  }

  setAvailable(available) {
    const normalized = Boolean(available);
    if (normalized === this.#available) return;
    this.#available = normalized;
    if (!normalized) {
      this.#dueAt = null;
      this.#cancelTimer();
      if (this.#started) this.#publish({ nextObservationAt: null });
      return;
    }
    if (this.#started && this.#settings?.enabled) this.schedule();
  }

  schedule(minutes = null) {
    if (!this.#started || !this.#settings?.enabled) return null;
    const selectedMinutes = minutes === null
      ? this.#randomMinutes()
      : minutes;
    if (
      typeof selectedMinutes !== "number" ||
      !Number.isFinite(selectedMinutes) ||
      selectedMinutes < 1 ||
      selectedMinutes > 120
    ) {
      throw new RangeError("Observation interval must be between 1 and 120 minutes");
    }
    this.#setDueAt(this.now() + Math.round(selectedMinutes * 60_000));
    return this.#dueAt;
  }

  async requestNow(reason = "manual") {
    if (!CAPTURE_REASONS.has(reason)) throw new RangeError("Observation reason is invalid");
    if (!this.#started || !this.#settings?.enabled) {
      return { accepted: false, reason: "disabled" };
    }
    return this.#attempt(reason);
  }

  handleCaptureResult({ deviceId, ok, error = null } = {}) {
    if (ok) return;
    this.#publish({
      status: "failed",
      error: String(error || "设备拒绝拍照").slice(0, 500),
    });
    if (this.#available && this.#settings?.enabled) this.schedule();
    this.emit("captureFailed", { deviceId, error: error || "设备拒绝拍照" });
  }

  #syncSnapshot(snapshot) {
    if (this.#publishing || !this.#started || !this.#settings?.enabled) return;
    if (
      snapshot?.vision?.status === "failed" &&
      this.#dueAt === null &&
      this.#available
    ) {
      this.#publish({
        status: "failed",
        error: snapshot.vision.error || "摄像头观察失败",
      });
      this.schedule();
      return;
    }
    const externalDueAt = snapshot?.care?.nextObservationAt;
    if (
      Number.isFinite(externalDueAt) &&
      externalDueAt >= 0 &&
      externalDueAt !== this.#dueAt
    ) {
      this.#dueAt = Math.floor(externalDueAt);
    }
    this.#arm(snapshot);
  }

  #randomMinutes() {
    const minimum = this.#settings.observationMinimumMinutes;
    const maximum = this.#settings.observationMaximumMinutes;
    const random = Math.max(0, Math.min(0.999999999, Number(this.random()) || 0));
    return minimum + Math.floor(random * (maximum - minimum + 1));
  }

  #setDueAt(dueAt) {
    this.#dueAt = dueAt;
    this.#publish({ nextObservationAt: dueAt });
    this.#arm();
  }

  #arm(snapshot = this.store.snapshot()) {
    this.#cancelTimer();
    if (
      !this.#started ||
      !this.#available ||
      !this.#settings?.enabled ||
      this.#dueAt === null ||
      this.#isBusy(snapshot)
    ) {
      return;
    }
    const delay = Math.max(0, this.#dueAt - this.now());
    this.#timer = this.setTimer(() => {
      this.#timer = null;
      this.#attempt("scheduled").catch((error) => {
        this.handleCaptureResult({ ok: false, error: error.message });
      });
    }, delay);
    this.#timer?.unref?.();
  }

  async #attempt(reason) {
    if (!this.#available) return { accepted: false, reason: "unavailable" };
    if (this.#isBusy(this.store.snapshot())) return { accepted: false, reason: "busy" };
    const deviceId = this.selectDevice();
    if (typeof deviceId !== "string" || !deviceId) {
      this.setAvailable(false);
      return { accepted: false, reason: "unavailable" };
    }
    const now = this.now();
    const duplicateGuardMs = this.#settings.duplicateGuardSeconds * 1_000;
    const lastCaptureAt = this.#lastCaptureByDevice.get(deviceId);
    if (Number.isFinite(lastCaptureAt) && now - lastCaptureAt < duplicateGuardMs) {
      this.#setDueAt(lastCaptureAt + duplicateGuardMs);
      return {
        accepted: false,
        reason: "duplicate-guard",
        retryAt: this.#dueAt,
      };
    }
    const result = await this.capture(deviceId, { reason });
    this.#lastCaptureByDevice.set(deviceId, now);
    this.#dueAt = null;
    this.#cancelTimer();
    this.#publish({
      status: "observing",
      nextObservationAt: null,
      error: null,
    });
    const accepted = {
      accepted: true,
      deviceId,
      reason,
      ...(result && typeof result === "object" ? result : {}),
    };
    this.emit("captureRequested", accepted);
    return accepted;
  }

  #isBusy(snapshot) {
    return BUSY_CARE_STATUSES.has(snapshot?.care?.status) ||
      BUSY_VOICE_STATUSES.has(snapshot?.voice?.status) ||
      BUSY_VISION_STATUSES.has(snapshot?.vision?.status);
  }

  #publish(patch) {
    this.#publishing = true;
    try {
      this.store.setCare(patch);
    } finally {
      this.#publishing = false;
    }
  }

  #cancelTimer() {
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = null;
  }
}
