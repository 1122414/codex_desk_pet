import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEVICE_BOARD_ID,
  DEVICE_FIRMWARE_VERSION,
  DEVICE_PROTOCOL_VERSION,
} from "../shared/device-protocol.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;

export const FIRMWARE_FLASH_LAYOUT = Object.freeze([
  // ESP32-P4 reserves the first 8 KiB of flash for FE data. Its ROM loads the
  // bootloader from 0x2000, unlike ESP32-S3 where the bootloader begins at 0x0.
  Object.freeze({ name: "bootloader", file: "bootloader.bin", offset: 0x002000, maximumBytes: 0x006000 }),
  Object.freeze({ name: "partitions", file: "partitions.bin", offset: 0x008000, maximumBytes: 0x001000 }),
  Object.freeze({ name: "ota-initializer", file: "boot_app0.bin", offset: 0x00e000, maximumBytes: 0x002000 }),
  Object.freeze({ name: "application", file: "firmware.bin", offset: 0x010000, maximumBytes: 0x640000 }),
  Object.freeze({ name: "voice-data", file: "voice_data.bin", offset: 0xc90000, maximumBytes: 0x2d0000 }),
  Object.freeze({ name: "bundled-pet", file: "spiffs.bin", offset: 0xf60000, maximumBytes: 0x090000 }),
]);

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validArtifact(artifact) {
  return Boolean(
    artifact &&
    typeof artifact === "object" &&
    !Array.isArray(artifact) &&
    FILE_PATTERN.test(artifact.file) &&
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes > 0 &&
    SHA256_PATTERN.test(artifact.sha256)
  );
}

export function createFirmwareManifest({
  releaseVersion = DEVICE_FIRMWARE_VERSION,
  components,
  factoryImage,
} = {}) {
  if (
    !Array.isArray(components) ||
    components.length !== FIRMWARE_FLASH_LAYOUT.length ||
    !validArtifact(factoryImage)
  ) {
    throw new TypeError("Firmware artifacts are incomplete");
  }
  for (const [index, expected] of FIRMWARE_FLASH_LAYOUT.entries()) {
    const component = components[index];
    if (
      !validArtifact(component) ||
      component.name !== expected.name ||
      component.file !== expected.file ||
      component.offset !== expected.offset ||
      component.bytes > expected.maximumBytes
    ) {
      throw new TypeError(`Firmware component is invalid: ${expected.name}`);
    }
  }
  return {
    schemaVersion: 1,
    product: "codex-desk-buddy",
    releaseVersion,
    firmwareVersion: DEVICE_FIRMWARE_VERSION,
    boardId: DEVICE_BOARD_ID,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    flashBytes: 16 * 1024 * 1024,
    factoryImage,
    components,
  };
}

export function validateFirmwareManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.product !== "codex-desk-buddy" ||
    manifest.firmwareVersion !== DEVICE_FIRMWARE_VERSION ||
    manifest.boardId !== DEVICE_BOARD_ID ||
    manifest.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
    manifest.flashBytes !== 16 * 1024 * 1024
  ) {
    throw new Error("Firmware manifest is incompatible with this Bridge");
  }
  return createFirmwareManifest({
    releaseVersion: manifest.releaseVersion,
    components: manifest.components,
    factoryImage: manifest.factoryImage,
  });
}

async function verifyArtifact(directory, artifact) {
  if (!validArtifact(artifact)) throw new Error("Firmware artifact metadata is invalid");
  const root = path.resolve(directory);
  const target = path.resolve(root, artifact.file);
  if (path.dirname(target) !== root) throw new Error("Firmware artifact path escapes its release directory");
  const data = await readFile(target);
  if (data.length !== artifact.bytes || sha256(data) !== artifact.sha256) {
    throw new Error(`Firmware artifact failed verification: ${artifact.file}`);
  }
  return data;
}

export async function verifyFirmwareRelease(directory) {
  const manifestPath = path.join(path.resolve(directory), "manifest.json");
  const raw = await readFile(manifestPath);
  if (raw.length > MAX_MANIFEST_BYTES) throw new Error("Firmware manifest is too large");
  const manifest = validateFirmwareManifest(JSON.parse(raw.toString("utf8")));
  await Promise.all([
    verifyArtifact(directory, manifest.factoryImage),
    ...manifest.components.map((component) => verifyArtifact(directory, component)),
  ]);
  return manifest;
}
