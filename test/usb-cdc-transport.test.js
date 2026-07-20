import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { UsbDeviceManager } from "../src/server/transports/usb-cdc-transport.js";

class FakeUsbTransport extends EventEmitter {
  constructor(devicePath) {
    super();
    this.devicePath = devicePath;
    this.kind = "usb";
  }

  send() {}

  close() {
    this.emit("close");
  }
}

test("USB device manager attaches each configured CDC port once and reconnects after close", async (t) => {
  const attached = [];
  const opened = [];
  const hub = {
    attachTransport: (transport) => attached.push(transport),
  };
  const manager = new UsbDeviceManager({
    hub,
    explicitPaths: ["/dev/cu.usbmodem-test"],
    autoDiscover: true,
    pollIntervalMs: 60_000,
    listPorts: async () => ["/dev/cu.usbmodem-test", "/dev/ttyACM0"],
    openTransport: async (devicePath) => {
      opened.push(devicePath);
      return new FakeUsbTransport(devicePath);
    },
  });
  t.after(() => manager.close());
  await manager.start();
  assert.deepEqual(opened, ["/dev/cu.usbmodem-test", "/dev/ttyACM0"]);
  await manager.scan();
  assert.equal(opened.length, 2);
  attached[0].close();
  await manager.scan();
  assert.equal(opened.filter((devicePath) => devicePath === "/dev/cu.usbmodem-test").length, 2);
});
