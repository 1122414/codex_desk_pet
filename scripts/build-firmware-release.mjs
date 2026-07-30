import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRMWARE_FLASH_LAYOUT,
  createFirmwareManifest,
  sha256,
  verifyFirmwareRelease,
} from "../src/server/firmware-release.js";
import { DEVICE_FIRMWARE_VERSION } from "../src/shared/device-protocol.js";
import { resolvePlatformioCommand } from "./platformio-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firmwareRoot = path.join(root, "firmware");
const buildRoot = path.join(firmwareRoot, ".pio", "build", "m5stack-tab5");
const ttsRoot = path.join(firmwareRoot, ".pio", "esp-tts", "p4-2f8c4b04");
const platformioRoot = process.env.PLATFORMIO_CORE_DIR ??
  path.join(os.homedir(), ".platformio");
const esptoolPackage = path.join(platformioRoot, "packages", "tool-esptoolpy");
const pio = resolvePlatformioCommand();
const releaseRoot = path.join(root, "dist", "firmware", `v${DEVICE_FIRMWARE_VERSION}`);
const allowDirty = process.argv.includes("--allow-dirty");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    env: {
      ...process.env,
      PLATFORMIO_SETTING_ENABLE_TELEMETRY: "no",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

async function artifact(source, layout) {
  const data = await readFile(source);
  if (data.length <= 0 || data.length > layout.maximumBytes) {
    throw new Error(`${layout.name} 超出分区上限`);
  }
  const target = path.join(releaseRoot, layout.file);
  await copyFile(source, target);
  return {
    name: layout.name,
    file: layout.file,
    offset: layout.offset,
    bytes: data.length,
    sha256: sha256(data),
  };
}

if (!allowDirty) {
  const dirty = run("git", ["status", "--porcelain"], { capture: true });
  if (dirty) throw new Error("工作区不是干净状态；请先提交变更，或仅在开发验证时使用 --allow-dirty");
}

run(process.execPath, [path.join(root, "scripts", "setup-esp-tts.mjs")]);
run(pio, ["run", "-d", firmwareRoot]);
run(pio, ["run", "-d", firmwareRoot, "-t", "buildfs"]);

const sources = new Map([
  ["bootloader", path.join(buildRoot, "bootloader.bin")],
  ["partitions", path.join(buildRoot, "partitions.bin")],
  ["ota-initializer", path.join(platformioRoot, "packages", "framework-arduinoespressif32", "tools", "partitions", "boot_app0.bin")],
  ["application", path.join(buildRoot, "firmware.bin")],
  ["voice-data", path.join(ttsRoot, "voice_data", "esp_tts_voice_data_xiaoxin_small.dat")],
  ["bundled-pet", path.join(buildRoot, "spiffs.bin")],
]);

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
const components = [];
for (const layout of FIRMWARE_FLASH_LAYOUT) {
  components.push(await artifact(sources.get(layout.name), layout));
}
await copyFile(path.join(ttsRoot, "LICENSE"), path.join(releaseRoot, "THIRD_PARTY_ESP_SR_LICENSE.txt"));

const factoryFile = path.join(releaseRoot, "codex-desk-buddy-tab5-factory.bin");
const mergeArgs = [
  "pkg",
  "exec",
  "--package",
  esptoolPackage,
  "--",
  "esptool.py",
  "--chip",
  "esp32p4",
  "merge-bin",
  "-o",
  factoryFile,
  "--flash-mode",
  "keep",
  "--flash-freq",
  "80m",
  "--flash-size",
  "16MB",
  ...components.flatMap((component) => [
    `0x${component.offset.toString(16)}`,
    path.join(releaseRoot, component.file),
  ]),
];
run(pio, mergeArgs);

const factoryData = await readFile(factoryFile);
const factoryImage = {
  file: path.basename(factoryFile),
  bytes: factoryData.length,
  sha256: sha256(factoryData),
};
const manifest = createFirmwareManifest({
  components,
  factoryImage,
});
await writeFile(
  path.join(releaseRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644 },
);
await verifyFirmwareRelease(releaseRoot);
const releaseSize = (await stat(factoryFile)).size;
process.stdout.write(
  `固件发布包已验证：${releaseRoot}\n` +
  `整机镜像：${factoryImage.file} (${releaseSize} bytes)\n` +
  `SHA-256：${factoryImage.sha256}\n`,
);
