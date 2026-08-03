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
  const usbTransport = await readFile(
    path.join(root, "firmware", "src", "transports", "usb_transport.cpp"),
    "utf8",
  );
  if (!usbTransport.includes("void UsbTransport::prepareSerialBuffers()") ||
      !usbTransport.includes("Serial.setTxBufferSize(kMaximumLineBytes + 1U)")) {
    throw new Error(
      "USB CDC 发送缓冲必须容纳完整协议帧和换行符，避免握手 JSON 被截断",
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
    !tab5Ui.includes("constexpr std::uint8_t kDefaultSpeakerVolume = 204;") ||
    !tab5Ui.includes("M5.Speaker.setVolume(kDefaultSpeakerVolume);")
  ) {
    throw new Error("Tab5 默认扬声器音量必须使用一致的 80% 原始值");
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
  if (
    !tab5Ui.includes("voice_touch_mode_") ||
    !tab5Ui.includes("UiAction{UiActionType::VoiceStart, mode}") ||
    !tab5Ui.includes('chat_recording ? "停止" : "对话"') ||
    !tab5Ui.includes('command_recording ? "停止" : "命令"')
  ) {
    throw new Error("Tab5 语音按钮必须点按开始，并清楚标出当前可停止的模式");
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
  if (
    !firmwareApp.includes("voice_.start(*client, action.value, false, 60)") ||
    !firmwareApp.includes("ui_.setVoiceRecording(true, action.value)")
  ) {
    throw new Error("Tab5 手动语音必须点按开始、再次点按结束，并保留时长上限");
  }
  const deviceVoice = await readFile(
    path.join(root, "firmware", "src", "device_voice.cpp"),
    "utf8",
  );
  const maximumDurationIndex = deviceVoice.indexOf(
    "elapsed(now_ms, recording_started_at_ms_, maximum_duration_ms_)",
  );
  const microphonePendingIndex = deviceVoice.indexOf(
    "M5.Mic.isRecording() != 0",
  );
  if (
    maximumDurationIndex === -1 ||
    microphonePendingIndex === -1 ||
    maximumDurationIndex > microphonePendingIndex ||
    deviceVoice.includes("kChunkTimeoutMs")
  ) {
    throw new Error("Tab5 语音必须在麦克风分块未完成时仍执行总时长兜底，且不能短超时误结束");
  }
  const deviceProtocol = await readFile(
    path.join(root, "firmware", "src", "device_protocol.cpp"),
    "utf8",
  );
  const voiceAudioStart = deviceProtocol.indexOf(
    "bool DeviceProtocolClient::sendVoiceAudio(",
  );
  const voiceStopStart = deviceProtocol.indexOf(
    "bool DeviceProtocolClient::sendVoiceStop()",
  );
  const voiceAudio = deviceProtocol.slice(voiceAudioStart, voiceStopStart);
  if (
    voiceAudioStart === -1 ||
    voiceStopStart === -1 ||
    !voiceAudio.includes('sendEnvelope(\n      "event",') ||
    voiceAudio.includes("false)")
  ) {
    throw new Error("Tab5 语音音频事件必须使用递增的可靠序号，不能让后续音频或停止消息被判重");
  }
  const ledcClockSourceIndex = firmwareApp.indexOf(
    "ledcSetClockSource(LEDC_USE_PLL_DIV_CLK);",
  );
  const m5BeginIndex = firmwareApp.indexOf("M5.begin(config);");
  if (
    ledcClockSourceIndex === -1 ||
    m5BeginIndex === -1 ||
    ledcClockSourceIndex > m5BeginIndex
  ) {
    throw new Error(
      "Tab5 必须在 M5Unified 使用 LEDC 前统一选择 80MHz PLL 时钟源",
    );
  }
  if (firmwareApp.includes("esp_task_wdt_add(nullptr)")) {
    throw new Error("Tab5 UI 主循环不能订阅会触发循环重启的任务看门狗");
  }
  if (!firmwareApp.includes('pet_id == "chibi-skadi"')) {
    throw new Error("Tab5 内置 Pet 不得重复请求外部素材包");
  }
  if (
    !firmwareApp.includes("kPetRequestSettlingMs = 500") ||
    !firmwareApp.includes("pet_request_not_before_ = millis() + kPetRequestSettlingMs") ||
    !firmwareApp.includes("if (now_ms < pet_request_not_before_) return;")
  ) {
    throw new Error("Tab5 必须在确认快照后延迟主题请求，避免 ACK 与资源请求争用 USB CDC");
  }
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
      'code == "RESYNC_REQUIRED" || code == "INVALID_SESSION") {\n      startHandshake(millis(), true);',
    )
  ) {
    throw new Error("Tab5 协议重同步必须重置双向序号，避免永久重连循环");
  }
  const protocolVersionMaterialUses = deviceProtocol.match(
    /String\(static_cast<unsigned int>\(kProtocolVersion\)\)/g,
  )?.length ?? 0;
  if (protocolVersionMaterialUses !== 3) {
    throw new Error(
      "Tab5 握手签名、加密密钥与附加认证数据必须统一使用当前协议版本常量",
    );
  }
  if (!deviceProtocol.includes('type != "ack" &&\n      type != "error"')) {
    throw new Error("Tab5 认证前不得对错误报文再次回复错误");
  }
  if (
    !usbTransport.includes("frame += '\\n'") ||
    !usbTransport.includes("Serial.write(") ||
    !usbTransport.includes("return written == frame.length()") ||
    usbTransport.includes("Serial.flush()")
  ) {
    throw new Error("Tab5 USB 协议帧必须单次写入且不得强制清空 CDC 待发队列");
  }
  if (
    !firmwareApp.includes("UsbTransport::prepareSerialBuffers();") ||
    firmwareApp.indexOf("UsbTransport::prepareSerialBuffers();") >
      firmwareApp.indexOf("M5.begin(config);")
  ) {
    throw new Error("Tab5 必须在 M5Unified 初始化串口前预配置 USB CDC 缓冲区");
  }
  const deviceCamera = await readFile(
    path.join(root, "firmware", "src", "device_camera.cpp"),
    "utf8",
  );
  if (
    !deviceCamera.includes("i2c_master_get_bus_handle(") ||
    deviceCamera.includes("i2cBusHandle(")
  ) {
    throw new Error(
      "Tab5 摄像头必须复用 M5Unified 已初始化的 ESP-IDF I2C 总线句柄",
    );
  }
  if (
    !deviceCamera.includes("camera_power.digitalWrite(6, false)") ||
    !deviceCamera.includes("camera_power.digitalWrite(6, true)") ||
    !deviceCamera.includes("delay(10)") ||
    !deviceCamera.includes("delay(100)")
  ) {
    throw new Error("Tab5 摄像头初始化前必须在主时钟稳定后复位并等待传感器");
  }
  if (
    !deviceCamera.includes("kCameraClockPin = GPIO_NUM_36") ||
    !deviceCamera.includes("kCameraClockHz = 24'000'000") ||
    !deviceCamera.includes("timer_config.timer_num = LEDC_TIMER_2") ||
    !deviceCamera.includes("channel_config.channel = LEDC_CHANNEL_6") ||
    !deviceCamera.includes("ledc_channel_config(&channel_config)") ||
    !deviceCamera.includes("ledc_get_freq(") ||
    !deviceCamera.includes("timer_config.clk_cfg = LEDC_USE_PLL_DIV_CLK") ||
    !deviceCamera.includes("frequency_delta > kCameraClockHz / 100U")
  ) {
    throw new Error(
      "Tab5 摄像头必须用独立 LEDC 资源为 GPIO36 提供 24MHz 主时钟",
    );
  }
  if (
    !deviceCamera.includes("camera_power.getWriteValue(6)") ||
    !deviceCamera.includes("kCameraSccbAddress = 0x36") ||
    !deviceCamera.includes("kCameraSensorId = 0xeb52") ||
    !deviceCamera.includes("i2c_master_probe(") ||
    !deviceCamera.includes("i2c_master_transmit_receive(") ||
    !deviceCamera.includes("verifyCameraSensor(i2c_handle, error)") ||
    !deviceCamera.includes("kCameraProbeAttempts = 10")
  ) {
    throw new Error(
      "Tab5 摄像头必须验证复位电平、0x36 控制地址与 SC202CS/SC2356 型号",
    );
  }
  if (
    !deviceCamera.includes("M5.In_I2C.release()") ||
    !deviceCamera.includes("camera_owns_i2c_ = true") ||
    !deviceCamera.includes("kCameraI2cPort = I2C_NUM_0") ||
    !deviceCamera.includes("kCameraSclPin = 32") ||
    !deviceCamera.includes("kCameraSdaPin = 31") ||
    !deviceCamera.includes("csi_config.begin(camera_config, true)") ||
    !deviceCamera.includes("M5.In_I2C.begin()")
  ) {
    throw new Error(
      "Tab5 拍照期间必须让 esp_video 独占内部 I2C，并在结束后恢复 M5Unified",
    );
  }
  if (
    deviceCamera.includes("previous_log_level_") ||
    deviceCamera.includes("camera_logs_suppressed_")
  ) {
    throw new Error(
      "Tab5 摄像头结束时不得恢复 ESP 日志，避免污染 USB JSON 协议",
    );
  }
  const captureMetadataIndex = deviceCamera.indexOf(
    "if (!makeCaptureId(capture_id_))",
  );
  const initializeCaptureIndex = deviceCamera.indexOf(
    "if (!initializeCamera(error))",
  );
  if (
    !deviceCamera.includes("capture_id_.reserve(16)") ||
    !deviceCamera.includes("sha256_.reserve(64)") ||
    !deviceCamera.includes("bool writeHexDigest(") ||
    captureMetadataIndex === -1 ||
    initializeCaptureIndex === -1 ||
    captureMetadataIndex > initializeCaptureIndex
  ) {
    throw new Error(
      "Tab5 必须在占用 JPEG 编码内存前预分配并生成照片元数据",
    );
  }
  if (
    !firmwareApp.includes("captureWithReleasedStorage(") ||
    !firmwareApp.includes("pet_store_.suspendForCamera(error)") ||
    !firmwareApp.includes("pet_store_.resumeAfterCamera(storage_error)") ||
    !firmwareApp.includes("ui_.suspendBundledStorageForCamera()") ||
    !firmwareApp.includes("ui_.resumeBundledStorageAfterCamera()") ||
    !firmwareApp.includes("delay(25)")
  ) {
    throw new Error(
      "Tab5 拍照时必须暂时释放 microSD 与 SPIFFS 的 VFS 槽位，并在结束后恢复主题存储",
    );
  }
  if (
    !firmwareApp.includes("esp_log_set_vprintf(discardEspLog)") ||
    !firmwareApp.includes('esp_log_level_set("*", ESP_LOG_NONE)')
  ) {
    throw new Error("Tab5 应在启动后永久关闭 ESP 日志，避免日志污染 USB JSON 协议");
  }
  if (
    !tab5Ui.includes("lgfx_tinfl_decompress(") ||
    !tab5Ui.includes("std::malloc(sizeof(lgfx_tinfl_decompressor))") ||
    tab5Ui.includes("lgfx_tinfl_decompress_mem_to_mem(")
  ) {
    throw new Error(
      "Tab5 内置主题解压器状态必须存放在堆上，避免 loopTask 栈溢出重启",
    );
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
