import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const data = await readFile(path.join(bundledPetDirectory, frame));
    if (
      data.length < 12 ||
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
  if (!firmwareApp.includes("esp_task_wdt_delete(idle_task)")) {
    throw new Error(
      "Tab5 必须移除框架遗留的 idle 看门狗订阅，避免显示与音频负载触发误重启",
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
