import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDirectory = path.join(root, "firmware", "lib", "codex_core", "src");
const testSource = path.join(root, "firmware", "test_native", "main.cpp");
const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-desk-firmware-"));
const executable = path.join(temporary, "firmware-core-tests");

try {
  const platformIo = await readFile(
    path.join(root, "firmware", "platformio.ini"),
    "utf8",
  );
  if (!platformIo.includes("-DCORE_DEBUG_LEVEL=0")) {
    throw new Error(
      "USB CDC 同时承载设备协议，固件必须使用 CORE_DEBUG_LEVEL=0，避免日志破坏 JSON 报文",
    );
  }
  const firmwareMain = await readFile(
    path.join(root, "firmware", "src", "main.cpp"),
    "utf8",
  );
  if (!firmwareMain.includes("SET_LOOP_TASK_STACK_SIZE(32 * 1024)")) {
    throw new Error(
      "Tab5 主循环任务必须预留 32KB 栈，避免语音与媒体模块初始化触发栈保护故障",
    );
  }
  const usbTransport = await readFile(
    path.join(root, "firmware", "src", "transports", "usb_transport.cpp"),
    "utf8",
  );
  if (!usbTransport.includes("Serial.setTxBufferSize(kMaximumLineBytes)")) {
    throw new Error(
      "USB CDC 发送缓冲必须容纳完整协议帧，避免握手 JSON 被截断",
    );
  }
  if (!usbTransport.includes("host_activity_ || Serial.isConnected()")) {
    throw new Error(
      "ESP32-P4 USB 协议必须结合实际主机流量判断 CDC 已连接",
    );
  }
  if (
    !usbTransport.includes("wake_requested_ = true") ||
    !usbTransport.includes("consumeWakeRequest")
  ) {
    throw new Error(
      "ESP32-P4 USB 协议必须响应 Bridge 空行唤醒，确保刷写后无需重新插线也能握手",
    );
  }
  const tab5Ui = await readFile(
    path.join(root, "firmware", "src", "tab5_ui.cpp"),
    "utf8",
  );
  if (
    !tab5Ui.includes('"/bundled-pet/r%uf%u.rle"') ||
    tab5Ui.includes("drawPng(")
  ) {
    throw new Error(
      "Tab5 内置 Pet 必须使用预解码友好的 RLE 帧，避免 PNG 解码阻塞主循环",
    );
  }
  if (
    !tab5Ui.includes("canvas_.setPsram(true)") ||
    !tab5Ui.includes("canvas_.pushSprite(0, 0)")
  ) {
    throw new Error("Tab5 必须使用 PSRAM 双缓冲整帧提交，避免可见闪烁");
  }
  if (
    !tab5Ui.includes(
      "normal_screen_rendered_ && fingerprint == rendered_fingerprint_",
    )
  ) {
    throw new Error("Tab5 必须跳过内容未变化的整屏提交，避免周期性闪烁");
  }
  if (
    !tab5Ui.includes("frame_index != rendered_pet_frame_index_") ||
    !tab5Ui.includes("pushCanvasRegion(kPetSpriteArea)")
  ) {
    throw new Error("Tab5 动画帧必须局部提交，不能被静态界面缓存跳过");
  }
  const bundledPetDirectory = path.join(
    root,
    "firmware",
    "data",
    "bundled-pet",
  );
  const bundledPetFrames = (await readdir(bundledPetDirectory))
    .filter((file) => /^r[0-8]f[01]\.rle$/.test(file))
    .sort();
  if (bundledPetFrames.length !== 18) {
    throw new Error("Tab5 内置 Pet 必须包含 18 帧 RLE 资源");
  }
  for (const frame of bundledPetFrames) {
    const packed = await readFile(path.join(bundledPetDirectory, frame));
    if (
      packed.length < 16 ||
      packed.subarray(0, 4).toString("ascii") !== "CPZ1"
    ) {
      throw new Error(`Tab5 内置 Pet 压缩帧格式无效：${frame}`);
    }
    const data = inflateSync(packed.subarray(8));
    if (
      data.length !== packed.readUInt32LE(4) ||
      data.subarray(0, 4).toString("ascii") !== "CPR1" ||
      data.readUInt16LE(4) !== 192 ||
      data.readUInt16LE(6) !== 208 ||
      (data.length - 8) % 4 !== 0
    ) {
      throw new Error(`Tab5 内置 Pet 帧格式无效：${frame}`);
    }
    let pixels = 0;
    for (let offset = 8; offset < data.length; offset += 4) {
      pixels += data.readUInt16LE(offset);
    }
    if (pixels !== 192 * 208) {
      throw new Error(`Tab5 内置 Pet 帧像素数无效：${frame}`);
    }
  }
  const firmwareApp = await readFile(
    path.join(root, "firmware", "src", "firmware_app.cpp"),
    "utf8",
  );
  if (firmwareApp.includes("esp_task_wdt_add(nullptr)")) {
    throw new Error("Tab5 UI 主循环不能订阅会触发循环重启的任务看门狗");
  }
  if (!firmwareApp.includes('pet_id == "chibi-skadi"')) {
    throw new Error("Tab5 内置 Pet 不得重复请求外部素材包");
  }
  if (
    !firmwareApp.includes("camera_capture_pending_ = true;") ||
    !firmwareApp.includes('connection_detail_ = "正在拍照，请稍候";')
  ) {
    throw new Error("Tab5 拍照必须先刷新触摸反馈，再执行同步采集");
  }
  if (
    !firmwareApp.includes(
      '} else if (event == "voice.reply") {\n' +
      "    voice_.stop();\n" +
      "    audio_.setPaused(false);\n" +
      "    ui_.setVoiceRecording(false);",
    )
  ) {
    throw new Error("Tab5 收到语音结果后必须结束录音并恢复按钮");
  }
  if (
    tab5Ui.includes('voice_recording_ ? "松开"') ||
    !tab5Ui.includes('voice_chat_recording ? "结束" : "对话"') ||
    !tab5Ui.includes('voice_command_recording ? "结束" : "命令"')
  ) {
    throw new Error("Tab5 语音必须仅让当前模式采用单击开始、再次单击结束");
  }
  const deviceProtocol = await readFile(
    path.join(root, "firmware", "src", "device_protocol.cpp"),
    "utf8",
  );
  if (
    deviceProtocol.includes(
      "wake_requested &&\n      connected &&\n      state_ != State::Ready",
    )
  ) {
    throw new Error("Tab5 收到 USB 唤醒时必须允许重置旧认证会话");
  }
  if (
    !deviceProtocol.includes(
      'strcmp(transport_->kind(), "usb") == 0) {\n    startHandshake(now_ms, true);',
    )
  ) {
    throw new Error("Tab5 USB 主机唤醒必须重置协议序号后重新握手");
  }
  if (
    !deviceProtocol.includes(
      'sendError("RESYNC_REQUIRED");\n      if (strcmp(transport_->kind(), "usb") == 0) {\n        startHandshake(millis(), true);',
    )
  ) {
    throw new Error("Tab5 USB 序号失步后必须主动重置序号并重新握手");
  }
  if (!deviceProtocol.includes('type != "ack" &&\n      type != "error"')) {
    throw new Error("Tab5 认证前不得对错误报文再次回复错误");
  }
  if (
    deviceProtocol.includes('codex-desk-aead-v1\\",3') ||
    deviceProtocol.includes('material = "[3,\\"') ||
    deviceProtocol.includes('aad = "[3,\\"') ||
    (deviceProtocol.match(/String\(kProtocolVersion\)/g)?.length ?? 0) < 3
  ) {
    throw new Error("Tab5 握手与加密材料必须统一使用当前协议版本");
  }
  if (
    !usbTransport.includes("kChunkBytes = 128") ||
    !usbTransport.includes("Serial.flush()")
  ) {
    throw new Error("Tab5 USB 长报文必须分块并完整刷新到主机");
  }
  const sources = (await readdir(coreDirectory))
    .filter((file) => file.endsWith(".cpp"))
    .sort()
    .map((file) => path.join(coreDirectory, file));
  const compiler = process.env.CXX || "c++";
  const compile = spawnSync(compiler, [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    "-I",
    coreDirectory,
    ...sources,
    testSource,
    "-o",
    executable,
  ], { stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exit(compile.status ?? 1);

  const run = spawnSync(executable, [], { stdio: "inherit" });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
