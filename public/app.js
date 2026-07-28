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
  "thread-list", "thread-count", "thread-dialog", "thread-dialog-kind",
  "thread-dialog-title", "thread-dialog-meta", "thread-dialog-messages",
].map((id) => [id, document.getElementById(id)]));

let csrfToken = "";
let snapshot = null;
let pets = [];
let localLookDegree = null;
let localLookTimer = null;
let toastTimer = null;
let dialogApprovalId = null;
let soundEnabled = localStorage.getItem("codex-desk-sound") === "true";
let voiceEnabled = localStorage.getItem("codex-desk-voice") === "true";
let audioContext = null;
let openThreadId = null;
let threadRequestSequence = 0;

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

function isSkadiPetId(petId) {
  return petId === "chibi-skadi" || petId?.startsWith("chibi-skadi-");
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m tk`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k tk`;
  return `${value} tk`;
}

function formatThreadRecency(updatedAt) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000) - Number(updatedAt || 0));
  if (!updatedAt) return "时间未知";
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function updateClock() {
  elements["screen-time"].textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

async function render(nextSnapshot) {
  const oldState = snapshot?.presentation.state;
  const oldPetId = snapshot?.pet.selectedId;
  snapshot = nextSnapshot;
  document.body.dataset.theme = isSkadiPetId(snapshot.pet.selectedId)
    ? "chibi-skadi"
    : "default";
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
  animator.setAnimation(snapshot.presentation.animation, lookDegree);
  elements["screen-state"].textContent = lookDegree !== null
    ? `看向 ${getLookDirection(lookDegree).degree}°`
    : snapshot.presentation.previewing
      ? `预览·${ANIMATION_LABELS[snapshot.presentation.animation]}`
      : STATE_LABELS[snapshot.presentation.state] || snapshot.presentation.state;
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
  renderThreadList(snapshot.tasks ?? [], snapshot.task?.id);
  elements["mock-tools"].hidden = snapshot.connection.mode !== "mock";
  document.querySelectorAll(".animation-button").forEach((button) => button.classList.toggle("active", button.dataset.animation === snapshot.presentation.animation && localLookDegree === null));

  if (oldState && oldState !== snapshot.presentation.state) announceState(snapshot.presentation.state);
}

function renderThreadList(threads, selectedId) {
  elements["thread-count"].textContent = `${threads.length} 条`;
  if (!threads.length) {
    const empty = document.createElement("span");
    empty.className = "thread-empty";
    empty.textContent = "暂无项目或对话";
    elements["thread-list"].replaceChildren(empty);
    return;
  }
  elements["thread-list"].replaceChildren(...threads.map((thread) => {
    const kind = thread.kind === "project" ? "project" : "conversation";
    const card = document.createElement("button");
    card.type = "button";
    card.className = `thread-card thread-${kind}`;
    card.classList.toggle("selected", thread.id === selectedId);
    card.setAttribute(
      "aria-label",
      `打开${kind === "project" ? "项目" : "对话"}：${thread.title}`,
    );

    const icon = document.createElement("span");
    icon.className = "thread-card-icon";
    icon.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    content.className = "thread-card-content";
    const heading = document.createElement("span");
    heading.className = "thread-card-heading";
    const badge = document.createElement("span");
    badge.className = "thread-card-badge";
    badge.textContent = kind === "project" ? "项目" : "对话";
    const title = document.createElement("strong");
    title.textContent = thread.title || "未命名会话";
    heading.append(badge, title);

    const meta = document.createElement("span");
    meta.className = "thread-card-meta";
    meta.textContent = [
      kind === "project" && thread.workspace ? thread.workspace : null,
      formatThreadRecency(thread.updatedAt),
      formatTokens(Number(thread.tokens || 0)),
    ].filter(Boolean).join(" · ");
    content.append(heading, meta);

    const state = document.createElement("span");
    state.className = `thread-card-state state-${thread.state || "ready"}`;
    state.textContent = STATE_LABELS[thread.state] || thread.state || "待命";
    card.append(icon, content, state);
    card.addEventListener("click", () => openThread(thread));
    return card;
  }));
}

async function openThread(thread) {
  const requestSequence = ++threadRequestSequence;
  openThreadId = thread.id;
  const project = thread.kind === "project";
  elements["thread-dialog"].classList.toggle("thread-dialog-project", project);
  elements["thread-dialog"].classList.toggle("thread-dialog-conversation", !project);
  elements["thread-dialog-kind"].textContent = project ? "项目" : "纯对话";
  elements["thread-dialog-title"].textContent = thread.title || "未命名会话";
  elements["thread-dialog-meta"].textContent =
    project && thread.workspace ? thread.workspace : "最近消息";
  const loading = document.createElement("p");
  loading.className = "thread-loading";
  loading.textContent = "正在读取会话…";
  elements["thread-dialog-messages"].replaceChildren(loading);
  if (!elements["thread-dialog"].open) elements["thread-dialog"].showModal();

  try {
    const detail = await fetchJson(
      `/api/threads/${encodeURIComponent(thread.id)}/conversation`,
    );
    if (requestSequence !== threadRequestSequence || openThreadId !== thread.id) return;
    renderThreadConversation(detail);
  } catch (error) {
    if (requestSequence !== threadRequestSequence || openThreadId !== thread.id) return;
    const failure = document.createElement("p");
    failure.className = "thread-error";
    failure.textContent = `读取失败：${error.message}`;
    elements["thread-dialog-messages"].replaceChildren(failure);
  }
}

function renderThreadConversation(detail) {
  const project = detail.kind === "project";
  elements["thread-dialog"].classList.toggle("thread-dialog-project", project);
  elements["thread-dialog"].classList.toggle("thread-dialog-conversation", !project);
  elements["thread-dialog-kind"].textContent = project ? "项目" : "纯对话";
  elements["thread-dialog-title"].textContent = detail.title || "未命名会话";
  const visible = detail.messages?.length ?? 0;
  elements["thread-dialog-meta"].textContent = [
    project && detail.workspace ? detail.workspace : null,
    `最近 ${visible}/${detail.totalMessages ?? visible} 条`,
    detail.truncated ? "长内容已精简" : null,
  ].filter(Boolean).join(" · ");

  if (!visible) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "这个会话还没有可显示的消息";
    elements["thread-dialog-messages"].replaceChildren(empty);
    return;
  }
  elements["thread-dialog-messages"].replaceChildren(...detail.messages.map((message) => {
    const user = message.role === "user";
    const bubble = document.createElement("article");
    bubble.className = `thread-message ${user ? "thread-message-user" : "thread-message-assistant"}`;
    const role = document.createElement("strong");
    role.textContent = user ? "YOU // 指挥官" : "SKADI // CODEX";
    const text = document.createElement("p");
    text.textContent = message.text;
    bubble.append(role, text);
    return bubble;
  }));
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
  animator.setAnimation(snapshot?.presentation.animation ?? "idle", degree);
  elements["screen-state"].textContent = `看向 ${getLookDirection(degree).degree}°`;
  document.querySelectorAll(".look-button").forEach((button, index) => button.classList.toggle("active", LOOK_DIRECTIONS[index].degree === getLookDirection(degree).degree));
  clearTimeout(localLookTimer);
}

function clearLocalLook() {
  resetLocalLookState();
  if (snapshot) {
    animator.setAnimation(snapshot.presentation.animation, null);
    elements["screen-state"].textContent = STATE_LABELS[snapshot.presentation.state] || snapshot.presentation.state;
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
  elements["thread-dialog"].addEventListener("close", () => {
    openThreadId = null;
    threadRequestSequence += 1;
  });

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
    await render(await fetchJson("/api/snapshot"));
    connectEvents();
    setInterval(loadDevices, 5_000);
  } catch (error) {
    showToast(`初始化失败：${error.message}`);
  }
}

init();
