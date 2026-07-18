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
  "level-progress", "screen-level", "screen-transport", "bridge-status", "pet-select", "pet-version",
  "pet-description", "animation-grid", "restore-sync", "look-grid", "look-support", "sound-toggle",
  "voice-toggle", "battery-slider", "battery-value", "mock-tools", "mock-approval", "toast",
].map((id) => [id, document.getElementById(id)]));

let csrfToken = "";
let snapshot = null;
let pets = [];
let localLookDegree = null;
let localLookTimer = null;
let toastTimer = null;
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

async function render(nextSnapshot) {
  const oldState = snapshot?.presentation.state;
  snapshot = nextSnapshot;
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
  elements["screen-transport"].textContent = { simulator: "SIM", usb: "USB", wifi: "WIFI" }[snapshot.telemetry.transport] || "—";
  document.querySelectorAll("[data-transport]").forEach((button) => button.classList.toggle("active", button.dataset.transport === snapshot.telemetry.transport));

  renderApproval(snapshot.approval);
  elements["mock-tools"].hidden = snapshot.connection.mode !== "mock";
  document.querySelectorAll(".animation-button").forEach((button) => button.classList.toggle("active", button.dataset.animation === snapshot.presentation.animation && localLookDegree === null));

  if (oldState && oldState !== snapshot.presentation.state) announceState(snapshot.presentation.state);
}

function renderApproval(approval) {
  elements["approval-card"].hidden = !approval;
  if (!approval) return;
  elements["approval-title"].textContent = approval.title;
  const detail = approval.kind === "command"
    ? approval.command || "命令详情尚未加载"
    : approval.filePaths?.length ? approval.filePaths.join(" · ") : approval.grantRoot || "文件详情尚未加载";
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
  localLookDegree = null;
  clearTimeout(localLookTimer);
  document.querySelectorAll(".look-button").forEach((button) => button.classList.remove("active"));
  if (snapshot) {
    animator.setAnimation(snapshot.presentation.animation, null);
    elements["screen-state"].textContent = STATE_LABELS[snapshot.presentation.state] || snapshot.presentation.state;
  }
}

async function decideApproval(decision) {
  if (!snapshot?.approval) return;
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
  elements["mock-approval"].addEventListener("click", async () => {
    try { await mutate("/api/mock/approval", {}); } catch (error) { showToast(error.message); }
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
  setInterval(updateClock, 10_000);

  try {
    const session = await fetchJson("/api/session");
    csrfToken = session.csrfToken;
    await loadPets();
    await render(await fetchJson("/api/snapshot"));
    connectEvents();
  } catch (error) {
    showToast(`初始化失败：${error.message}`);
  }
}

init();
