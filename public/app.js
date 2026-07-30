import {
  LOOK_DIRECTIONS,
  PET_CELL,
  STANDARD_ANIMATIONS,
  getLookDirection,
} from "/shared/pet-spec.js";

const STATE_LABELS = {
  ready: "待命",
  running: "运行中",
  "needs-input": "等待确认",
  reviewing: "审查中",
  completed: "已完成",
  blocked: "遇到问题",
};

const ANIMATION_LABELS = {
  idle: "待命",
  "running-right": "向右移动",
  "running-left": "向左移动",
  waving: "挥手",
  jumping: "跳跃",
  failed: "失败",
  waiting: "等待输入",
  running: "执行任务",
  review: "审查",
};

const CARE_STATUS_LABELS = {
  idle: "待命",
  observing: "正在观察",
  thinking: "正在思考",
  speaking: "正在说话",
  listening: "正在聆听",
  acting: "正在执行动作",
  failed: "关怀失败",
};

const CARE_PRESENTATIONS = {
  observing: { state: "reviewing", animation: "review" },
  thinking: { state: "reviewing", animation: "review" },
  speaking: { state: "running", animation: "waving" },
  listening: { state: "needs-input", animation: "waiting" },
  acting: { state: "running", animation: "running" },
};

const CARE_ACTION_LABELS = {
  capture_now: "立即再观察",
  set_tab5_brightness: "调整 Tab5 亮度",
  set_tab5_volume: "调整 Tab5 音量",
  open_app: "打开应用预设",
  open_media_preset: "打开媒体预设",
  set_macos_volume: "调整 Mac 音量",
  schedule_follow_up: "安排后续观察",
};

const LOOK_ARROWS = ["↑", "↗", "↗", "↗", "→", "↘", "↘", "↘", "↓", "↙", "↙", "↙", "←", "↖", "↖", "↖"];

const elements = Object.fromEntries([
  "device-screen", "screen-connection", "screen-time", "screen-battery", "pet-stage", "pet-canvas",
  "device-prev", "device-next", "screen-pet-name", "screen-state", "approval-card", "approval-title",
  "approval-detail", "approval-reason", "approval-decline", "approval-accept", "screen-task", "screen-tokens",
  "approval-dialog", "approval-dialog-title", "approval-dialog-detail", "approval-dialog-reason",
  "approval-dialog-cancel", "approval-dialog-accept",
  "level-progress", "screen-level", "screen-transport", "bridge-status", "pet-select", "pet-version",
  "pet-description", "animation-grid", "restore-sync", "look-grid", "look-support", "sound-toggle",
  "voice-toggle", "battery-slider", "battery-value", "mock-tools", "mock-approval", "toast",
  "start-pairing", "pairing-code", "device-list",
  "wifi-device-id", "wifi-ssid", "wifi-password", "bridge-host", "bridge-port", "provision-wifi",
  "companion-reply", "companion-input", "companion-chat", "companion-command",
  "companion-confirm", "companion-command-text", "companion-decline", "companion-accept",
  "care-enabled", "care-status", "care-next-observation", "care-minimum-minutes",
  "care-maximum-minutes", "care-auto-listen-seconds", "care-persona", "care-action-list",
  "care-app-presets", "care-media-presets", "care-save", "care-observe-now", "care-stop",
  "care-events",
].map((id) => [id, document.getElementById(id)]));

let csrfToken = "";
let snapshot = null;
let pets = [];
let careSettings = null;
let lastCareEventId = null;
let localLookDegree = null;
let localLookTimer = null;
let toastTimer = null;
let dialogApprovalId = null;
let soundEnabled = localStorage.getItem("codex-desk-sound") === "true";
let voiceEnabled = localStorage.getItem("codex-desk-voice") === "true";
let audioContext = null;

function commandId() {
  return crypto.randomUUID();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

async function mutate(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Desk-CSRF": csrfToken,
    },
    body: JSON.stringify({ ...body, commandId: commandId() }),
  });
}

class PetAnimator {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.pet = null;
    this.image = null;
    this.animation = "idle";
    this.lookDegree = null;
    this.frame = 0;
    this.timer = null;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  async setPet(pet) {
    if (this.pet?.id === pet?.id) return;
    this.pet = pet;
    this.image = null;
    if (pet?.assetUrl) {
      try {
        this.image = await this.loadImage(pet.assetUrl);
      } catch {
        showToast(`${pet.displayName} 图集加载失败，已使用内置 Pet`);
      }
    }
    this.restart();
  }

  setAnimation(animation, lookDegree = null) {
    if (this.animation === animation && this.lookDegree === lookDegree) return;
    this.animation = animation;
    this.lookDegree = lookDegree;
    this.restart();
  }

  restart() {
    clearTimeout(this.timer);
    this.frame = 0;
    this.draw();
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.lookDegree !== null) return;
    const spec = STANDARD_ANIMATIONS[this.animation] ?? STANDARD_ANIMATIONS.idle;
    const delay = this.reducedMotion ? 900 : spec.durations[this.frame % spec.durations.length];
    this.timer = setTimeout(() => {
      this.frame = (this.frame + 1) % spec.durations.length;
      this.draw();
      this.schedule();
    }, delay);
  }

  draw() {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.image) this.drawAtlasFrame();
    else this.drawBuiltin();
  }

  drawAtlasFrame() {
    const supportsLook = this.pet.spriteVersionNumber === 2 && this.image.naturalHeight >= 2288;
    let row;
    let column;
    if (this.lookDegree !== null && supportsLook) {
      const direction = getLookDirection(this.lookDegree);
      row = direction.row;
      column = direction.column;
    } else {
      const spec = STANDARD_ANIMATIONS[this.animation] ?? STANDARD_ANIMATIONS.idle;
      row = spec.row;
      column = this.frame % spec.durations.length;
    }
    this.context.drawImage(
      this.image,
      column * PET_CELL.width,
      row * PET_CELL.height,
      PET_CELL.width,
      PET_CELL.height,
      0,
      0,
      PET_CELL.width,
      PET_CELL.height,
    );
  }

  drawBuiltin() {
    const ctx = this.context;
    const spec = STANDARD_ANIMATIONS[this.animation] ?? STANDARD_ANIMATIONS.idle;
    const phase = this.frame / Math.max(1, spec.durations.length - 1);
    const cycle = Math.sin(phase * Math.PI * 2);
    const look = this.lookDegree === null ? null : getLookDirection(this.lookDegree).degree * Math.PI / 180;
    let x = 96;
    let y = 112;
    let tilt = 0;
    let squash = 1;
    let accent = "#56f59d";
    if (this.animation === "jumping") y -= Math.sin(phase * Math.PI) * 34;
    if (this.animation === "running-right") { x += cycle * 7; tilt = .12; }
    if (this.animation === "running-left") { x -= cycle * 7; tilt = -.12; }
    if (this.animation === "failed") { y += 15; squash = .84; accent = "#ff6b6b"; }
    if (this.animation === "waiting") { tilt = cycle * .06; accent = "#ffbd66"; }
    if (this.animation === "running") { squash = 1 + cycle * .035; }
    if (this.animation === "review") { tilt = -.04 + cycle * .02; accent = "#92b7ff"; }
    if (this.animation === "idle") y += cycle * 2;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.scale(1, squash);
    ctx.lineCap = "round";

    ctx.strokeStyle = "#23302b";
    ctx.lineWidth = 13;
    const leftArmY = this.animation === "waving" ? -49 - Math.abs(cycle) * 9 : -10;
    ctx.beginPath();
    ctx.moveTo(-47, -12);
    ctx.lineTo(-68, leftArmY);
    ctx.moveTo(47, -12);
    ctx.lineTo(67, this.animation === "review" ? -26 : -7);
    ctx.stroke();

    ctx.fillStyle = "#101715";
    ctx.strokeStyle = "#3c5149";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(-53, -65, 106, 120, 45);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.globalAlpha = .18;
    ctx.beginPath();
    ctx.arc(0, 13, 31 + (this.animation === "running" ? cycle * 4 : 0), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 5;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.arc(0, 13, 19, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(0, 13, 7, 0, Math.PI * 2);
    ctx.fill();

    const eyeOffsetX = look === null ? 0 : Math.sin(look) * 5;
    const eyeOffsetY = look === null ? 0 : -Math.cos(look) * 4;
    const eyeHeight = this.animation === "review" ? 3 : this.animation === "failed" ? 5 : 8;
    ctx.fillStyle = "#e8fff2";
    ctx.beginPath();
    ctx.ellipse(-20 + eyeOffsetX, -27 + eyeOffsetY, 7, eyeHeight, 0, 0, Math.PI * 2);
    ctx.ellipse(20 + eyeOffsetX, -27 + eyeOffsetY, 7, eyeHeight, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#27322e";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(-26, 53);
    ctx.lineTo(-31 + (this.animation.startsWith("running-") ? cycle * 8 : 0), 72);
    ctx.moveTo(26, 53);
    ctx.lineTo(31 - (this.animation.startsWith("running-") ? cycle * 8 : 0), 72);
    ctx.stroke();
    ctx.restore();
  }

  loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }
}

const animator = new PetAnimator(elements["pet-canvas"]);

function currentPet() {
  return pets.find((pet) => pet.id === snapshot?.pet.selectedId) ?? pets[0] ?? null;
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m tk`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k tk`;
  return `${value} tk`;
}

function updateClock() {
  elements["screen-time"].textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function activePresentation(value = snapshot) {
  const carePresentation = CARE_PRESENTATIONS[value?.care?.status];
  return carePresentation
    ? { ...value.presentation, ...carePresentation, previewing: false }
    : value?.presentation;
}

async function render(nextSnapshot) {
  const oldState = snapshot?.presentation.state;
  const oldPetId = snapshot?.pet.selectedId;
  snapshot = nextSnapshot;
  if (oldPetId && oldPetId !== snapshot.pet.selectedId) resetLocalLookState();
  const connected = snapshot.connection.status === "connected";
  const connectionLabels = {
    connected: `${snapshot.connection.mode.toUpperCase()} · 已连接`,
    connecting: "正在连接",
    reconnecting: "连接中断 · 正在重连",
    disconnected: "已断开",
    error: "连接异常",
  };
  elements["screen-connection"].classList.toggle("connected", connected);
  elements["screen-connection"].lastChild.textContent = connected
    ? "已连接"
    : snapshot.connection.status === "reconnecting" ? "重连中" : "离线";
  elements["bridge-status"].classList.toggle("connected", connected);
  elements["bridge-status"].querySelector("span").textContent =
    connectionLabels[snapshot.connection.status] ?? "连接异常";

  const pet = currentPet();
  if (pet) {
    elements["screen-pet-name"].textContent = pet.displayName;
    elements["pet-version"].textContent = pet.spriteVersionNumber === 2 ? "V2 · 11行" : "V1 · 9行";
    elements["pet-description"].textContent = pet.description || "来自 Codex Pet 目录";
    elements["look-support"].textContent = pet.spriteVersionNumber === 2 ? "V2 可用" : "V1 不支持";
    for (const button of elements["look-grid"].querySelectorAll("button")) button.disabled = pet.spriteVersionNumber !== 2 && pet.kind !== "builtin";
    elements["pet-select"].value = pet.id;
    await animator.setPet(pet);
  }

  const lookDegree = localLookDegree;
  const presentation = activePresentation();
  animator.setAnimation(presentation.animation, lookDegree);
  elements["screen-state"].textContent = lookDegree !== null
    ? `看向 ${getLookDirection(lookDegree).degree}°`
    : snapshot.care?.status !== "idle" && CARE_STATUS_LABELS[snapshot.care?.status]
      ? CARE_STATUS_LABELS[snapshot.care.status]
      : presentation.previewing
        ? `预览·${ANIMATION_LABELS[presentation.animation]}`
        : STATE_LABELS[presentation.state] || presentation.state;
  elements["screen-task"].textContent = snapshot.task?.title || "暂无 Codex 任务";
  elements["screen-tokens"].textContent = formatTokens(snapshot.tokens.total);
  elements["screen-level"].textContent = `Lv.${snapshot.tokens.level.level}`;
  elements["level-progress"].style.width = `${snapshot.tokens.level.progress * 100}%`;

  const battery = snapshot.telemetry.batteryPercent;
  elements["screen-battery"].querySelector("i").style.width = `${battery}%`;
  elements["screen-battery"].classList.toggle("low", battery <= 20);
  elements["screen-battery"].setAttribute("aria-label", `电池 ${battery}%`);
  elements["battery-slider"].value = battery;
  elements["battery-value"].textContent = `${battery}%`;
  elements["screen-transport"].textContent = { simulator: "SIM", usb: "USB", wifi: "WIFI", ble: "BLE" }[snapshot.telemetry.transport] || "—";
  document.querySelectorAll("[data-transport]").forEach((button) => button.classList.toggle("active", button.dataset.transport === snapshot.telemetry.transport));

  renderApproval(snapshot.approval);
  renderCompanion(snapshot.companion);
  renderCare(snapshot.care);
  elements["mock-tools"].hidden = snapshot.connection.mode !== "mock";
  document.querySelectorAll(".animation-button").forEach((button) => button.classList.toggle("active", button.dataset.animation === presentation.animation && localLookDegree === null));

  if (oldState && oldState !== snapshot.presentation.state) announceState(snapshot.presentation.state);
}

function renderCare(care) {
  if (!care) return;
  const enabled = Boolean(care.enabled);
  setToggle(elements["care-enabled"], enabled, "主动关怀");
  elements["care-status"].dataset.status = enabled ? care.status : "idle";
  elements["care-status"].textContent = enabled
    ? CARE_STATUS_LABELS[care.status] || care.status
    : "已关闭";
  if (!enabled) {
    elements["care-next-observation"].textContent = "不会自动使用摄像头";
  } else if (care.error) {
    elements["care-next-observation"].textContent = care.error;
  } else if (Number.isFinite(care.nextObservationAt)) {
    const date = new Date(care.nextObservationAt);
    const relativeMinutes = Math.max(0, Math.ceil((care.nextObservationAt - Date.now()) / 60_000));
    elements["care-next-observation"].textContent =
      `下次约 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}` +
      `（${relativeMinutes} 分钟后）`;
  } else {
    elements["care-next-observation"].textContent = "等待可用摄像头";
  }
  const busy = ["observing", "thinking", "speaking", "listening", "acting"].includes(care.status);
  elements["care-observe-now"].disabled = !enabled || busy;
  elements["care-stop"].disabled = !busy && !care.conversationId;
  if (care.recentEvent?.id && care.recentEvent.id !== lastCareEventId) {
    lastCareEventId = care.recentEvent.id;
    loadCareEvents();
  }
}

function renderCompanion(companion) {
  if (!companion) return;
  const statusLabels = {
    idle: "可以闲聊，也可以先提交一条 Codex 命令等待确认。",
    thinking: "宠物正在思考…",
    "awaiting-confirmation": "命令等待你的确认。",
    running: "Codex 正在执行已确认的命令…",
    completed: companion.reply || "已完成。",
    declined: "命令已取消。",
    failed: `失败：${companion.error || "未知错误"}`,
  };
  elements["companion-reply"].textContent =
    companion.reply || statusLabels[companion.status] || companion.status;
  const waiting = companion.status === "awaiting-confirmation" && companion.requestId;
  elements["companion-confirm"].hidden = !waiting;
  elements["companion-command-text"].textContent = waiting ? companion.prompt : "";
  elements["companion-chat"].disabled = ["thinking", "running"].includes(companion.status);
  elements["companion-command"].disabled =
    ["thinking", "running", "awaiting-confirmation"].includes(companion.status);
}

function renderApproval(approval) {
  elements["approval-card"].hidden = !approval;
  if (!approval) {
    if (elements["approval-dialog"].open) elements["approval-dialog"].close();
    dialogApprovalId = null;
    return;
  }
  if (elements["approval-dialog"].open && dialogApprovalId !== approval.id) {
    elements["approval-dialog"].close();
    dialogApprovalId = null;
  }
  elements["approval-title"].textContent = approval.title;
  const detail = approval.displayDetail ||
    (approval.kind === "command"
      ? approval.command || "命令详情尚未加载"
      : approval.filePaths?.length
        ? approval.filePaths.join(" · ")
        : approval.grantRoot || "审批详情尚未加载");
  elements["approval-detail"].textContent = detail;
  elements["approval-reason"].textContent =
    [approval.reason, approval.cwd, approval.networkHost].filter(Boolean).join(" · ") || "请确认是否允许本次操作";
  elements["approval-accept"].disabled = !approval.safeToApprove || !approval.availableDecisions.includes("accept");
  elements["approval-accept"].title = approval.safeToApprove ? "" : "审批详情不完整，只能拒绝";
}

function populateControls() {
  elements["animation-grid"].replaceChildren(...Object.keys(STANDARD_ANIMATIONS).map((animation) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "animation-button";
    button.dataset.animation = animation;
    button.textContent = ANIMATION_LABELS[animation];
    button.addEventListener("click", () => previewAnimation(animation));
    return button;
  }));

  elements["look-grid"].replaceChildren(...LOOK_DIRECTIONS.map((direction, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "look-button";
    button.title = `${direction.degree}°`;
    button.textContent = LOOK_ARROWS[index];
    button.addEventListener("click", () => previewLook(direction.degree));
    return button;
  }));

  elements["care-action-list"].replaceChildren(...Object.entries(CARE_ACTION_LABELS).map(([name, label]) => {
    const wrapper = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "care-action";
    checkbox.value = name;
    wrapper.append(checkbox, document.createTextNode(label));
    return wrapper;
  }));
}

function formatPresetLines(presets, valueKey) {
  return presets.map((preset) => `${preset.id} | ${preset.label} | ${preset[valueKey]}`).join("\n");
}

function parsePresetLines(text, valueKey, label) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 20) throw new Error(`${label}最多允许 20 项`);
  return lines.map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw new Error(`${label}第 ${index + 1} 行必须使用“ID | 名称 | 值”格式`);
    }
    return { id: parts[0], label: parts[1], [valueKey]: parts[2] };
  });
}

function renderCareSettings(care) {
  careSettings = care;
  elements["care-minimum-minutes"].value = care.observationMinimumMinutes;
  elements["care-maximum-minutes"].value = care.observationMaximumMinutes;
  elements["care-auto-listen-seconds"].value = care.autoListenSeconds;
  elements["care-persona"].value = care.persona;
  elements["care-app-presets"].value = formatPresetLines(care.appPresets, "bundleId");
  elements["care-media-presets"].value = formatPresetLines(care.mediaPresets, "url");
  const allowed = new Set(care.allowedActions);
  for (const checkbox of elements["care-action-list"].querySelectorAll("input")) {
    checkbox.checked = allowed.has(checkbox.value);
  }
  setToggle(elements["care-enabled"], care.enabled, "主动关怀");
}

async function loadCareSettings() {
  const { care } = await fetchJson("/api/care/settings");
  renderCareSettings(care);
}

async function loadCareEvents() {
  try {
    const { events } = await fetchJson("/api/care/events?limit=12");
    if (!events.length) {
      elements["care-events"].replaceChildren(Object.assign(document.createElement("li"), {
        textContent: "暂无关怀活动",
      }));
      return;
    }
    elements["care-events"].replaceChildren(...events.slice().reverse().map((event) => {
      const item = document.createElement("li");
      const time = document.createElement("time");
      time.dateTime = new Date(event.occurredAt).toISOString();
      time.textContent = new Date(event.occurredAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const summary = document.createElement("span");
      summary.textContent = event.summary || event.type;
      summary.title = event.type;
      item.append(time, summary);
      return item;
    }));
  } catch (error) {
    elements["care-events"].replaceChildren(Object.assign(document.createElement("li"), {
      textContent: `活动读取失败：${error.message}`,
    }));
  }
}

async function saveCareSettings(overrides = {}) {
  const minimum = Number(elements["care-minimum-minutes"].value);
  const maximum = Number(elements["care-maximum-minutes"].value);
  const autoListenSeconds = Number(elements["care-auto-listen-seconds"].value);
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 1 ||
    maximum > 120 ||
    minimum > maximum ||
    !Number.isInteger(autoListenSeconds) ||
    autoListenSeconds < 5 ||
    autoListenSeconds > 60
  ) {
    throw new Error("观察间隔必须为 1～120 分钟且最短不大于最长；自动聆听必须为 5～60 秒");
  }
  const care = {
    enabled: careSettings?.enabled ?? true,
    observationMinimumMinutes: minimum,
    observationMaximumMinutes: maximum,
    autoListenSeconds,
    duplicateGuardSeconds: careSettings?.duplicateGuardSeconds ?? 90,
    persona: elements["care-persona"].value,
    allowedActions: [...elements["care-action-list"].querySelectorAll("input:checked")]
      .map((checkbox) => checkbox.value),
    appPresets: parsePresetLines(elements["care-app-presets"].value, "bundleId", "应用预设"),
    mediaPresets: parsePresetLines(elements["care-media-presets"].value, "url", "媒体预设"),
    ...overrides,
  };
  const result = await mutate("/api/care/settings", { care });
  renderCareSettings(result.care);
  return result.care;
}

async function toggleCareEnabled() {
  elements["care-enabled"].disabled = true;
  try {
    const enabled = !careSettings?.enabled;
    const result = await mutate("/api/care/settings", { care: { enabled } });
    renderCareSettings(result.care);
    showToast(enabled ? "主动关怀已开启" : "主动关怀已关闭");
  } catch (error) {
    showToast(`设置保存失败：${error.message}`);
  } finally {
    elements["care-enabled"].disabled = false;
  }
}

async function observeNow() {
  elements["care-observe-now"].disabled = true;
  try {
    await mutate("/api/care/observe", {});
    showToast("已经请求 Tab5 立即拍照观察");
  } catch (error) {
    showToast(error.message);
  } finally {
    if (snapshot) renderCare(snapshot.care);
  }
}

async function stopCareConversation() {
  elements["care-stop"].disabled = true;
  try {
    const result = await mutate("/api/care/stop", {});
    showToast(result.enabled ? "本轮关怀对话已停止，自动关怀仍保持开启" : "本轮关怀对话已停止");
    await loadCareEvents();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (snapshot) renderCare(snapshot.care);
  }
}

async function loadPets() {
  const result = await fetchJson("/api/pets");
  pets = result.pets;
  elements["pet-select"].replaceChildren(...pets.map((pet) => {
    const option = document.createElement("option");
    option.value = pet.id;
    option.textContent = `${pet.displayName} · ${pet.kind === "builtin" ? "内置" : `V${pet.spriteVersionNumber}`}`;
    return option;
  }));
}

async function loadDevices() {
  try {
    const { devices } = await fetchJson("/api/devices");
    const usbDevices = devices.filter((device) => device.connected && device.transports.includes("usb"));
    elements["wifi-device-id"].replaceChildren(...(usbDevices.length
      ? usbDevices.map((device) => Object.assign(document.createElement("option"), {
        value: device.deviceId,
        textContent: `${device.displayName} · USB 已连接`,
      }))
      : [Object.assign(document.createElement("option"), {
        value: "",
        textContent: "请先通过 USB 配对并保持连接",
      })]));
    elements["wifi-device-id"].disabled = usbDevices.length === 0;
    elements["provision-wifi"].disabled = usbDevices.length === 0;
    if (!devices.length) {
      elements["device-list"].replaceChildren(Object.assign(document.createElement("span"), { textContent: "暂无已配对设备" }));
      return;
    }
    elements["device-list"].replaceChildren(...devices.map((device) => {
      const row = document.createElement("div");
      row.className = "device-row";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = device.displayName;
      const status = document.createElement("small");
      status.textContent = device.connected
        ? `${device.primaryTransport.toUpperCase()} · 已连接`
        : "离线";
      const diagnostics = document.createElement("small");
      diagnostics.textContent = device.deviceInfo
        ? `${device.deviceInfo.boardId} · 固件 ${device.deviceInfo.firmwareVersion}` +
          `${device.protocolVersion ? ` · 协议 v${device.protocolVersion}` : ""}` +
          ` · 语音${device.deviceInfo.health.voiceDataReady ? "正常" : "未就绪"}` +
          ` · microSD ${device.deviceInfo.health.storageReady ? "正常" : "未就绪"}`
        : "尚无设备版本信息，请连接一次设备";
      const compatibility = document.createElement("span");
      compatibility.className = `device-status ${device.compatibility?.status ?? "unknown"}`;
      compatibility.textContent = {
        compatible: "兼容",
        degraded: "可用但需处理",
        incompatible: "不兼容",
        unknown: "等待诊断",
      }[device.compatibility?.status] ?? "等待诊断";
      if (device.compatibility?.issues?.length) {
        compatibility.title = device.compatibility.issues.join("；");
      }
      info.append(name, status, diagnostics, compatibility);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "撤销";
      revoke.addEventListener("click", () => revokeDevice(device.deviceId));
      row.append(info, revoke);
      return row;
    }));
  } catch (error) {
    elements["device-list"].textContent = error.message;
  }
}

async function startPairing() {
  try {
    const offer = await mutate("/api/devices/pairing", {});
    elements["pairing-code"].hidden = false;
    elements["pairing-code"].textContent = offer.code;
    showToast("请保持 USB 连接，并在 5 分钟内到设备屏幕输入配对码");
  } catch (error) {
    showToast(error.message);
  }
}

async function provisionWifi() {
  const deviceId = elements["wifi-device-id"].value;
  const ssid = elements["wifi-ssid"].value.trim();
  const password = elements["wifi-password"].value;
  const bridgeHost = elements["bridge-host"].value.trim();
  const bridgePort = Number(elements["bridge-port"].value);
  if (!deviceId || !ssid || !bridgeHost ||
      !Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
    showToast("请保持已配对 Tab5 的 USB 连接，并完整填写 Wi‑Fi 与电脑局域网 IPv4");
    return;
  }
  elements["provision-wifi"].disabled = true;
  try {
    await mutate("/api/devices/wifi", {
      deviceId,
      ssid,
      password,
      bridgeHost,
      bridgePort,
    });
    elements["wifi-password"].value = "";
    showToast("Wi‑Fi 配置已加密写入，Tab5 正在重启；拔掉 USB 后会尝试连接电脑");
  } catch (error) {
    showToast(`Wi‑Fi 配置失败：${error.message}`);
  } finally {
    await loadDevices();
  }
}

async function revokeDevice(deviceId) {
  try {
    await mutate("/api/devices/revoke", { deviceId });
    await loadDevices();
    showToast("设备凭据已撤销");
  } catch (error) {
    showToast(error.message);
  }
}

async function selectPetOffset(offset) {
  if (!snapshot || pets.length < 2) return;
  const index = Math.max(0, pets.findIndex((pet) => pet.id === snapshot.pet.selectedId));
  const next = pets[(index + offset + pets.length) % pets.length];
  await selectPet(next.id);
}

async function selectPet(petId) {
  try {
    await mutate("/api/pet/select", { petId });
  } catch (error) {
    showToast(error.message);
  }
}

async function previewAnimation(animation) {
  clearLocalLook();
  try {
    await mutate("/api/state/preview", { animation });
  } catch (error) {
    showToast(error.message);
  }
}

function previewLook(degree) {
  const pet = currentPet();
  if (pet?.spriteVersionNumber !== 2 && pet?.kind !== "builtin") return;
  localLookDegree = degree;
  animator.setAnimation(activePresentation()?.animation ?? "idle", degree);
  elements["screen-state"].textContent = `看向 ${getLookDirection(degree).degree}°`;
  document.querySelectorAll(".look-button").forEach((button, index) => button.classList.toggle("active", LOOK_DIRECTIONS[index].degree === getLookDirection(degree).degree));
  clearTimeout(localLookTimer);
}

function clearLocalLook() {
  resetLocalLookState();
  if (snapshot) {
    const presentation = activePresentation();
    animator.setAnimation(presentation.animation, null);
    elements["screen-state"].textContent =
      CARE_STATUS_LABELS[snapshot.care?.status] ||
      STATE_LABELS[presentation.state] ||
      presentation.state;
  }
}

function resetLocalLookState() {
  localLookDegree = null;
  clearTimeout(localLookTimer);
  document.querySelectorAll(".look-button").forEach((button) => button.classList.remove("active"));
}

async function decideApproval(decision, detailConfirmed = false) {
  if (!snapshot?.approval) return;
  if (
    decision === "accept" &&
    !snapshot.approval.deviceSafeToApprove &&
    !detailConfirmed
  ) {
    dialogApprovalId = snapshot.approval.id;
    elements["approval-dialog-title"].textContent = snapshot.approval.title;
    elements["approval-dialog-detail"].textContent =
      snapshot.approval.displayDetail || "审批详情不完整";
    elements["approval-dialog-reason"].textContent =
      [snapshot.approval.reason, snapshot.approval.cwd, snapshot.approval.networkHost]
        .filter(Boolean)
        .join(" · ") || "请完整检查上方内容后再允许";
    elements["approval-dialog"].showModal();
    return;
  }
  try {
    await mutate("/api/approval/decide", { requestId: snapshot.approval.id, decision });
    showToast(decision === "accept" ? "已允许本次操作" : "已拒绝本次操作");
  } catch (error) {
    showToast(error.message);
  }
}

async function updateTelemetry(overrides = {}) {
  if (!snapshot) return;
  const telemetry = { ...snapshot.telemetry, ...overrides };
  try {
    await mutate("/api/telemetry", {
      batteryPercent: Number(telemetry.batteryPercent),
      charging: Boolean(telemetry.charging),
      transport: telemetry.transport,
      wifiRssi: telemetry.transport === "wifi" ? -52 : null,
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function sendCompanionChat() {
  const text = elements["companion-input"].value.trim();
  if (!text) return showToast("请先输入消息");
  elements["companion-chat"].disabled = true;
  try {
    const result = await mutate("/api/companion/chat", { text });
    elements["companion-input"].value = "";
    showToast(result.reply);
  } catch (error) {
    showToast(error.message);
  }
}

async function queueCompanionCommand() {
  const text = elements["companion-input"].value.trim();
  if (!text) return showToast("请先输入命令");
  try {
    await mutate("/api/companion/command", { text });
    elements["companion-input"].value = "";
  } catch (error) {
    showToast(error.message);
  }
}

async function decideCompanionCommand(decision) {
  const requestId = snapshot?.companion?.requestId;
  if (!requestId) return;
  try {
    await mutate("/api/companion/command/decide", { requestId, decision });
    showToast(decision === "accept" ? "已交给 Codex 执行" : "命令已取消");
  } catch (error) {
    showToast(error.message);
  }
}

function setToggle(button, enabled, label) {
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = `${label} ${enabled ? "开" : "关"}`;
}

function announceState(state) {
  const messages = {
    "needs-input": "Codex 需要你的确认",
    completed: "Codex 任务已完成",
    blocked: "Codex 遇到了问题",
  };
  if (!messages[state]) return;
  if (soundEnabled) playTone(state === "blocked" ? 190 : state === "completed" ? 660 : 440);
  if (voiceEnabled && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(messages[state]);
    utterance.lang = "zh-CN";
    utterance.rate = 1.05;
    speechSynthesis.speak(utterance);
  }
}

function playTone(frequency) {
  audioContext ??= new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  gain.gain.setValueAtTime(.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.11, audioContext.currentTime + .02);
  gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .22);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + .24);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2_600);
}

function bindInteractions() {
  elements["device-prev"].addEventListener("click", () => selectPetOffset(-1));
  elements["device-next"].addEventListener("click", () => selectPetOffset(1));
  elements["device-prev"].addEventListener("pointerdown", (event) => event.stopPropagation());
  elements["device-next"].addEventListener("pointerdown", (event) => event.stopPropagation());
  elements["pet-select"].addEventListener("change", (event) => selectPet(event.target.value));
  elements["restore-sync"].addEventListener("click", async () => {
    clearLocalLook();
    await previewAnimation(null);
  });
  elements["approval-accept"].addEventListener("click", () => decideApproval("accept"));
  elements["approval-decline"].addEventListener("click", () => decideApproval("decline"));
  elements["approval-dialog-accept"].addEventListener("click", () => {
    if (dialogApprovalId !== snapshot?.approval?.id) return;
    elements["approval-dialog"].close();
    decideApproval("accept", true);
  });
  elements["approval-dialog"].addEventListener("close", () => {
    dialogApprovalId = null;
  });
  elements["mock-approval"].addEventListener("click", async () => {
    try { await mutate("/api/mock/approval", {}); } catch (error) { showToast(error.message); }
  });
  elements["start-pairing"].addEventListener("click", startPairing);
  elements["provision-wifi"].addEventListener("click", provisionWifi);
  elements["companion-chat"].addEventListener("click", sendCompanionChat);
  elements["companion-command"].addEventListener("click", queueCompanionCommand);
  elements["companion-decline"].addEventListener("click", () => decideCompanionCommand("decline"));
  elements["companion-accept"].addEventListener("click", () => decideCompanionCommand("accept"));
  elements["companion-input"].addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      sendCompanionChat();
    }
  });
  elements["care-enabled"].addEventListener("click", toggleCareEnabled);
  elements["care-save"].addEventListener("click", async () => {
    elements["care-save"].disabled = true;
    try {
      await saveCareSettings();
      showToast("主动关怀设置已保存");
    } catch (error) {
      showToast(`设置保存失败：${error.message}`);
    } finally {
      elements["care-save"].disabled = false;
    }
  });
  elements["care-observe-now"].addEventListener("click", observeNow);
  elements["care-stop"].addEventListener("click", stopCareConversation);

  elements["sound-toggle"].addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("codex-desk-sound", String(soundEnabled));
    setToggle(elements["sound-toggle"], soundEnabled, "声音");
    if (soundEnabled) playTone(520);
  });
  elements["voice-toggle"].addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem("codex-desk-voice", String(voiceEnabled));
    setToggle(elements["voice-toggle"], voiceEnabled, "语音");
    if (voiceEnabled && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance("语音提示已开启");
      utterance.lang = "zh-CN";
      speechSynthesis.speak(utterance);
    }
  });
  elements["battery-slider"].addEventListener("input", (event) => { elements["battery-value"].textContent = `${event.target.value}%`; });
  elements["battery-slider"].addEventListener("change", (event) => updateTelemetry({ batteryPercent: Number(event.target.value) }));
  document.querySelectorAll("[data-transport]").forEach((button) => button.addEventListener("click", () => updateTelemetry({ transport: button.dataset.transport })));

  document.addEventListener("keydown", (event) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); selectPetOffset(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); selectPetOffset(1); }
    if (event.key === "Escape") clearLocalLook();
  });

  let pointerStart = null;
  elements["pet-stage"].addEventListener("pointerdown", (event) => {
    pointerStart = { x: event.clientX, y: event.clientY };
    elements["pet-stage"].setPointerCapture(event.pointerId);
    updatePointerLook(event);
  });
  elements["pet-stage"].addEventListener("pointermove", (event) => {
    if (pointerStart) updatePointerLook(event);
  });
  elements["pet-stage"].addEventListener("pointerup", (event) => {
    if (!pointerStart) return;
    const deltaX = event.clientX - pointerStart.x;
    pointerStart = null;
    if (Math.abs(deltaX) > 52) selectPetOffset(deltaX > 0 ? -1 : 1);
    localLookTimer = setTimeout(clearLocalLook, 850);
  });
  elements["pet-stage"].addEventListener("pointercancel", () => { pointerStart = null; clearLocalLook(); });
}

function updatePointerLook(event) {
  const pet = currentPet();
  if (!pet || (pet.spriteVersionNumber !== 2 && pet.kind !== "builtin")) return;
  const rect = elements["pet-stage"].getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) < 18) { clearLocalLook(); return; }
  const degree = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  previewLook(degree);
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("snapshot", (event) => render(JSON.parse(event.data)).catch((error) => showToast(error.message)));
  events.addEventListener("error", () => {
    elements["screen-connection"].classList.remove("connected");
    elements["bridge-status"].classList.remove("connected");
    elements["bridge-status"].querySelector("span").textContent = "正在重连";
  });
}

async function init() {
  populateControls();
  bindInteractions();
  setToggle(elements["sound-toggle"], soundEnabled, "声音");
  setToggle(elements["voice-toggle"], voiceEnabled, "语音");
  updateClock();
  elements["bridge-host"].value = location.hostname === "localhost" ? "" : location.hostname;
  setInterval(updateClock, 10_000);

  try {
    const session = await fetchJson("/api/session");
    csrfToken = session.csrfToken;
    await loadPets();
    await loadDevices();
    await loadCareSettings();
    await loadCareEvents();
    await render(await fetchJson("/api/snapshot"));
    connectEvents();
    setInterval(loadDevices, 5_000);
  } catch (error) {
    showToast(`初始化失败：${error.message}`);
  }
}

init();
