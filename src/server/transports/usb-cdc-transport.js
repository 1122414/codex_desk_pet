import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { JsonLineTransport } from "./json-line-transport.js";

const execFileAsync = promisify(execFile);
const USB_DEVICE_NAME = /^(?:cu\.usbmodem[a-zA-Z0-9._-]*|ttyACM[0-9]+|ttyUSB[0-9]+)$/;

export async function listUsbCdcPorts() {
  const entries = await readdir("/dev", { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink() && USB_DEVICE_NAME.test(entry.name))
    .map((entry) => `/dev/${entry.name}`)
    .sort();
}

async function configureRawTerminal(devicePath) {
  if (!["darwin", "linux"].includes(process.platform)) return;
  const flag = process.platform === "darwin" ? "-f" : "-F";
  await execFileAsync("stty", [flag, devicePath, "raw", "-echo", "115200"], {
    timeout: 3_000,
    windowsHide: true,
  });
}

export class UsbCdcTransport extends JsonLineTransport {
  constructor({
    handle,
    readable,
    writable,
    devicePath,
    closeHandle = () => handle.close(),
  }) {
    super({ readable, writable, kind: "usb" });
    this.handle = handle;
    this.devicePath = devicePath;
    this.readableStream = readable;
    this.writableStream = writable;
    this.closeHandle = closeHandle;
  }

  static async open(devicePath, { configure = configureRawTerminal } = {}) {
    if (typeof devicePath !== "string" || !devicePath.startsWith("/dev/") || !USB_DEVICE_NAME.test(devicePath.slice(5))) {
      throw new Error("USB CDC device path is not allowed");
    }
    const [linkInfo, resolved] = await Promise.all([lstat(devicePath), realpath(devicePath)]);
    if (linkInfo.isSymbolicLink() || resolved !== devicePath) throw new Error("USB CDC device path must not be a symlink");
    const info = await stat(devicePath);
    if (!info.isCharacterDevice()) throw new Error("USB CDC path is not a character device");
    await configure(devicePath);
    const handle = await open(devicePath, "r+");
    const readable = handle.createReadStream({ autoClose: false });
    const writable = handle.createWriteStream({ autoClose: false });
    return new UsbCdcTransport({ handle, readable, writable, devicePath });
  }

  wakeDevice() {
    if (!this.open || this.writableStream.writable === false) return;
    if (typeof this.handle?.write === "function") {
      this.handle.write("\n")
        .catch((error) => this.emit("diagnostic", error.message));
      return;
    }
    this.writableStream.write("\n");
  }

  close() {
    if (!this.open) return;
    super.close();
    this.readableStream.destroy();
    this.writableStream.destroy();
    Promise.resolve(this.closeHandle())
      .catch((error) => this.emit("diagnostic", error.message));
  }
}

export class UsbDeviceManager extends EventEmitter {
  #transports = new Map();
  #timer = null;

  constructor({
    hub,
    explicitPaths = [],
    autoDiscover = false,
    pollIntervalMs = 2_000,
    listPorts = listUsbCdcPorts,
    openTransport = (devicePath) => UsbCdcTransport.open(devicePath),
  } = {}) {
    super();
    if (!hub) throw new TypeError("UsbDeviceManager requires a DeviceHub");
    this.hub = hub;
    this.explicitPaths = [...new Set(explicitPaths)];
    this.autoDiscover = autoDiscover;
    this.pollIntervalMs = pollIntervalMs;
    this.listPorts = listPorts;
    this.openTransport = openTransport;
  }

  async start() {
    await this.scan();
    this.#timer = setInterval(() => {
      this.scan().catch((error) => this.emit("diagnostic", error.message));
    }, this.pollIntervalMs);
    this.#timer.unref?.();
  }

  async scan() {
    const paths = new Set(this.explicitPaths);
    if (this.autoDiscover) {
      for (const devicePath of await this.listPorts()) paths.add(devicePath);
    }
    for (const devicePath of paths) {
      if (this.#transports.has(devicePath)) continue;
      try {
        const transport = await this.openTransport(devicePath);
        this.#transports.set(devicePath, transport);
        transport.once("close", () => this.#transports.delete(devicePath));
        this.hub.attachTransport(transport);
        transport.wakeDevice?.();
        this.emit("attached", devicePath);
      } catch (error) {
        this.emit("diagnostic", `${devicePath}: ${error.message}`);
      }
    }
  }

  async close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const transport of this.#transports.values()) transport.close();
    this.#transports.clear();
  }
}
