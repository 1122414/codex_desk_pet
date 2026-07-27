import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  UsbCdcTransport,
  UsbDeviceManager,
} from "../src/server/transports/usb-cdc-transport.js";

class FakeUsbTransport extends EventEmitter {
  constructor(devicePath) {
    super();
    this.devicePath = devicePath;
    this.kind = "usb";
    this.wakeCount = 0;
  }

  send() {}

  wakeDevice() {
    this.wakeCount += 1;
  }

  close() {
    this.emit("close");
  }
}

test("USB transport wakes the device and requests descriptor release once", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  let closed = 0;
  const transport = new UsbCdcTransport({
    handle: 123,
    readable,
    writable,
    devicePath: "/dev/cu.usbmodem-test",
    closeHandle: () => {
      closed += 1;
    },
  });
  let output = "";
  writable.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  transport.wakeDevice();
  assert.equal(output, "\n");
  transport.close();
  transport.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});

test("USB transport writes wake byte through the open device handle", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const writes = [];
  const transport = new UsbCdcTransport({
    handle: {
      write: async (value) => {
        writes.push(value);
      },
    },
    readable,
    writable,
    devicePath: "/dev/cu.usbmodem-test",
    closeHandle: () => {},
  });

  transport.wakeDevice();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["\n"]);
  transport.close();
});

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
  assert.deepEqual(attached.map((transport) => transport.wakeCount), [1, 1]);
  await manager.scan();
  assert.equal(opened.length, 2);
  attached[0].close();
  await manager.scan();
  assert.equal(opened.filter((devicePath) => devicePath === "/dev/cu.usbmodem-test").length, 2);
});
