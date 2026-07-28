import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BleGattTransport } from "./ble-gatt-transport.js";

const helperSource = fileURLToPath(new URL("./macos-core-bluetooth-helper.m", import.meta.url));
const helperBundleName = "CodexDeskBluetooth.app";
const helperExecutableName = "CodexDeskBluetooth";
const helperBundleIdentifier = "com.codex-desk.bridge.bluetooth";

function encodeCommand(command) {
  return `${JSON.stringify(command)}\n`;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function runCompiler(source, target) {
  await new Promise((resolve, reject) => {
    const compiler = spawn(
      "/usr/bin/xcrun",
      [
        "clang",
        "-fobjc-arc",
        "-O",
        "-mmacosx-version-min=12.0",
        "-framework",
        "CoreBluetooth",
        "-framework",
        "Foundation",
        source,
        "-o",
        target,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          CLANG_MODULE_CACHE_PATH: path.join(path.dirname(target), "module-cache"),
        },
      },
    );
    let errorOutput = "";
    compiler.stderr.setEncoding("utf8");
    compiler.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    compiler.once("error", reject);
    compiler.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `macOS BLE helper compilation failed (${signal ?? code}): ${errorOutput.trim()}`,
      ));
    });
  });
}

function helperInfoPlist(token) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleDevelopmentRegion</key>",
    "  <string>zh_CN</string>",
    "  <key>CFBundleExecutable</key>",
    `  <string>${helperExecutableName}</string>`,
    "  <key>CFBundleIdentifier</key>",
    `  <string>${helperBundleIdentifier}</string>`,
    "  <key>CFBundleInfoDictionaryVersion</key>",
    "  <string>6.0</string>",
    "  <key>CFBundleName</key>",
    "  <string>Codex Desk Bluetooth</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>CFBundleShortVersionString</key>",
    "  <string>1.0</string>",
    "  <key>CFBundleVersion</key>",
    `  <string>${token}</string>`,
    "  <key>LSUIElement</key>",
    "  <true/>",
    "  <key>NSBluetoothAlwaysUsageDescription</key>",
    "  <string>Codex Desk 需要通过蓝牙连接桌面宠物设备。</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function runCodesign(bundle) {
  await new Promise((resolve, reject) => {
    const signer = spawn(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--identifier",
        helperBundleIdentifier,
        bundle,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errorOutput = "";
    signer.stderr.setEncoding("utf8");
    signer.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    signer.once("error", reject);
    signer.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `macOS BLE helper signing failed (${signal ?? code}): ${errorOutput.trim()}`,
      ));
    });
  });
}

export async function buildMacBleHelper({
  source = helperSource,
  cacheRoot = path.join(os.homedir(), ".codex-desk", "bin"),
  compile = runCompiler,
  signBundle = runCodesign,
} = {}) {
  const contents = await readFile(source);
  const token = createHash("sha256")
    .update(contents)
    .update(process.arch)
    .digest("hex")
    .slice(0, 16);
  const bundle = path.join(cacheRoot, helperBundleName);
  const binary = path.join(bundle, "Contents", "MacOS", helperExecutableName);
  const marker = path.join(bundle, "Contents", "Resources", "source-hash");
  try {
    if (await exists(binary) && (await readFile(marker, "utf8")).trim() === token) {
      return binary;
    }
  } catch {
    // Rebuild incomplete or stale helper bundles.
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const stagingBundle = path.join(
    cacheRoot,
    `.${helperBundleName}.${process.pid}.${token}.tmp`,
  );
  const backupBundle = path.join(cacheRoot, `.${helperBundleName}.previous`);
  const stagingContents = path.join(stagingBundle, "Contents");
  const stagingBinary = path.join(stagingContents, "MacOS", helperExecutableName);
  await rm(stagingBundle, { recursive: true, force: true });
  try {
    await mkdir(path.dirname(stagingBinary), { recursive: true, mode: 0o700 });
    await mkdir(path.join(stagingContents, "Resources"), {
      recursive: true,
      mode: 0o700,
    });
    await compile(source, stagingBinary);
    await chmod(stagingBinary, 0o700);
    await writeFile(
      path.join(stagingContents, "Info.plist"),
      helperInfoPlist(token),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(stagingContents, "Resources", "source-hash"),
      `${token}\n`,
      { mode: 0o600 },
    );
    await signBundle(stagingBundle);
    await rm(backupBundle, { recursive: true, force: true });
    try {
      await rename(bundle, backupBundle);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagingBundle, bundle);
    } catch (error) {
      await rename(backupBundle, bundle).catch(() => {});
      throw error;
    }
    await rm(backupBundle, { recursive: true, force: true });
  } catch (error) {
    await rm(stagingBundle, { recursive: true, force: true });
    throw error;
  }
  return binary;
}

export class MacBleGattAdapter extends EventEmitter {
  #closed = false;

  constructor({ manager, peripheralId }) {
    super();
    this.manager = manager;
    this.peripheralId = peripheralId;
  }

  writeFragment(fragment) {
    if (this.#closed) throw new Error("BLE adapter is closed");
    this.manager.write({
      type: "write",
      data: Buffer.from(fragment).toString("base64"),
    });
  }

  receive(fragment) {
    if (!this.#closed) this.emit("fragment", fragment);
  }

  disconnect(reason = "disconnected") {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close", reason);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.manager.write({ type: "disconnect" });
    this.emit("close");
  }
}

export class MacBleDeviceManager extends EventEmitter {
  #started = false;
  #closed = false;
  #restartTimer = null;
  #child = null;
  #adapter = null;
  #stdoutBuffer = "";

  constructor({
    hub,
    enabled = process.platform === "darwin",
    buildHelper = buildMacBleHelper,
    spawnHelper = (binary) => spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] }),
    restartDelayMs = 2_000,
  } = {}) {
    super();
    if (!hub?.attachTransport) throw new TypeError("MacBleDeviceManager requires a device hub");
    this.hub = hub;
    this.enabled = enabled;
    this.buildHelper = buildHelper;
    this.spawnHelper = spawnHelper;
    this.restartDelayMs = restartDelayMs;
  }

  async start() {
    if (this.#started || !this.enabled) return;
    this.#started = true;
    this.#closed = false;
    try {
      const binary = await this.buildHelper();
      this.#launch(binary);
    } catch (error) {
      this.emit("diagnostic", error.message);
      this.#scheduleRestart();
    }
  }

  write(command) {
    if (!this.#child?.stdin?.writable) throw new Error("macOS BLE helper is unavailable");
    this.#child.stdin.write(encodeCommand(command));
  }

  async close() {
    this.#closed = true;
    this.#started = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#adapter?.disconnect("manager closed");
    this.#adapter = null;
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    if (child.stdin.writable) child.stdin.end(encodeCommand({ type: "close" }));
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 1_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #launch(binary) {
    if (this.#closed) return;
    const child = this.spawnHelper(binary);
    this.#child = child;
    this.#stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", (error) => {
      if (!this.#closed && error.code !== "EPIPE") {
        this.emit("diagnostic", `BLE helper input failed: ${error.message}`);
      }
    });
    child.stdout.on("data", (chunk) => this.#acceptOutput(chunk));
    child.stderr.on("data", (chunk) => {
      const message = chunk.trim();
      if (message) this.emit("diagnostic", `BLE helper: ${message}`);
    });
    child.once("error", (error) => this.emit("diagnostic", `BLE helper failed: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#adapter?.disconnect("helper exited");
      this.#adapter = null;
      if (!this.#closed) {
        this.emit("diagnostic", `BLE helper exited (${signal ?? code ?? "unknown"})`);
        this.#scheduleRestart(binary);
      }
    });
  }

  #acceptOutput(chunk) {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.#handleMessage(JSON.parse(line));
      } catch (error) {
        this.emit("diagnostic", `BLE helper output is invalid: ${error.message}`);
      }
    }
  }

  #handleMessage(message) {
    switch (message?.type) {
      case "state":
        this.emit("state", message.state);
        if (["unauthorized", "unsupported"].includes(message.state)) {
          this.emit("diagnostic", `macOS Bluetooth is ${message.state}`);
        }
        break;
      case "discovered":
        this.emit("discovered", message);
        break;
      case "connected": {
        this.#adapter?.disconnect("replaced");
        const adapter = new MacBleGattAdapter({
          manager: this,
          peripheralId: message.id,
        });
        this.#adapter = adapter;
        const transport = new BleGattTransport({ adapter });
        this.hub.attachTransport(transport);
        this.emit("attached", message);
        break;
      }
      case "fragment":
        if (typeof message.data !== "string") throw new Error("BLE fragment data is missing");
        this.#adapter?.receive(Buffer.from(message.data, "base64"));
        break;
      case "disconnected":
        this.#adapter?.disconnect(message.reason);
        this.#adapter = null;
        this.emit("detached", message);
        break;
      case "diagnostic":
        if (typeof message.message === "string") this.emit("diagnostic", message.message);
        break;
      default:
        break;
    }
  }

  #scheduleRestart(binary = null) {
    if (this.#closed || this.#restartTimer) return;
    this.#restartTimer = setTimeout(async () => {
      this.#restartTimer = null;
      if (this.#closed) return;
      try {
        this.#launch(binary ?? await this.buildHelper());
      } catch (error) {
        this.emit("diagnostic", error.message);
        this.#scheduleRestart();
      }
    }, this.restartDelayMs);
    this.#restartTimer.unref?.();
  }
}
