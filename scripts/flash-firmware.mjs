import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFirmwareWritePlan,
  verifyFirmwareRelease,
} from "../src/server/firmware-release.js";
import { DEVICE_FIRMWARE_VERSION } from "../src/shared/device-protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);

function option(name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

const port = option("--port");
const releaseRoot = path.resolve(
  option("--release") ??
  path.join(root, "dist", "firmware", `v${DEVICE_FIRMWARE_VERSION}`),
);
const erase = arguments_.includes("--erase");
if (
  !port ||
  port.startsWith("-") ||
  port.length > 256 ||
  arguments_.some((value, index) =>
    ["--port", "--release"].includes(value) && !arguments_[index + 1])
) {
  throw new Error(
    "用法：npm run flash:firmware -- --port /dev/cu.usbmodemXXXX " +
    "[--release dist/firmware/v0.4.1] [--erase]",
  );
}

const manifest = await verifyFirmwareRelease(releaseRoot);
const platformioRoot = process.env.PLATFORMIO_CORE_DIR ??
  path.join(os.homedir(), ".platformio");
const esptoolPackage = path.join(platformioRoot, "packages", "tool-esptoolpy");
const pio = process.env.PIO || "pio";

function runEsptool(args) {
  const result = spawnSync(pio, [
    "pkg",
    "exec",
    "--package",
    esptoolPackage,
    "--",
    "esptool.py",
    "--chip",
    "esp32p4",
    "--port",
    port,
    ...args,
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PLATFORMIO_SETTING_ENABLE_TELEMETRY: "no",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Tab5 烧录失败");
}

if (erase) runEsptool(["erase-flash"]);
const writePlan = createFirmwareWritePlan(manifest, { erase });
runEsptool([
  "--baud",
  "921600",
  "write-flash",
  "--flash-mode",
  "qio",
  "--flash-freq",
  "80m",
  "--flash-size",
  "16MB",
  ...writePlan.flatMap((item) => [
    `0x${item.offset.toString(16)}`,
    path.join(releaseRoot, item.file),
  ]),
]);
process.stdout.write(
  `Tab5 已写入固件 ${manifest.firmwareVersion}` +
  `${erase ? "（已清除设备配置）" : "（已保留配对与网络配置）"}；` +
  "请等待设备重启。\n",
);
