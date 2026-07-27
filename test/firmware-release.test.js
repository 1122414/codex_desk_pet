import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FIRMWARE_FLASH_LAYOUT,
  createFirmwareManifest,
  sha256,
  verifyFirmwareRelease,
} from "../src/server/firmware-release.js";

test("firmware release manifest verifies every component and detects tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-release-"));
  await mkdir(root, { recursive: true });
  const components = [];
  for (const [index, layout] of FIRMWARE_FLASH_LAYOUT.entries()) {
    const data = Buffer.alloc(index + 2, index + 1);
    await writeFile(path.join(root, layout.file), data);
    components.push({
      name: layout.name,
      file: layout.file,
      offset: layout.offset,
      bytes: data.length,
      sha256: sha256(data),
    });
  }
  const factory = Buffer.from("factory-image");
  const factoryImage = {
    file: "codex-desk-buddy-tab5-factory.bin",
    bytes: factory.length,
    sha256: sha256(factory),
  };
  await writeFile(path.join(root, factoryImage.file), factory);
  const manifest = createFirmwareManifest({ components, factoryImage });
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await verifyFirmwareRelease(root), manifest);

  await writeFile(path.join(root, "voice_data.bin"), Buffer.from("tampered"));
  await assert.rejects(() => verifyFirmwareRelease(root), /failed verification/);
});

test("firmware manifest rejects a component that crosses its assigned partition", () => {
  const components = FIRMWARE_FLASH_LAYOUT.map((layout) => ({
    name: layout.name,
    file: layout.file,
    offset: layout.offset,
    bytes: 1,
    sha256: "a".repeat(64),
  }));
  components[3].bytes = FIRMWARE_FLASH_LAYOUT[3].maximumBytes + 1;
  assert.throws(() => createFirmwareManifest({
    components,
    factoryImage: {
      file: "factory.bin",
      bytes: 1,
      sha256: "b".repeat(64),
    },
  }), /application/);
});

test("Tab5 release places the ESP32-P4 bootloader at its ROM boot offset", () => {
  const bootloader = FIRMWARE_FLASH_LAYOUT[0];
  const application = FIRMWARE_FLASH_LAYOUT[3];
  const voiceData = FIRMWARE_FLASH_LAYOUT[4];
  const bundledPet = FIRMWARE_FLASH_LAYOUT[5];
  assert.equal(bootloader.name, "bootloader");
  assert.equal(bootloader.offset, 0x2000);
  assert.equal(bootloader.maximumBytes, 0x6000);
  assert.deepEqual(
    { offset: application.offset, maximumBytes: application.maximumBytes },
    { offset: 0x10000, maximumBytes: 0x5e0000 },
  );
  assert.deepEqual(
    { offset: voiceData.offset, maximumBytes: voiceData.maximumBytes },
    { offset: 0xbd0000, maximumBytes: 0x2d0000 },
  );
  assert.deepEqual(
    { offset: bundledPet.offset, maximumBytes: bundledPet.maximumBytes },
    { offset: 0xea0000, maximumBytes: 0x150000 },
  );
});
