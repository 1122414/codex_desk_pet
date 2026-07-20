import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { inspectWebp, PetCatalog } from "../src/server/pet-catalog.js";

function makeWebp(type, width, height) {
  let data;
  if (type === "VP8X") {
    data = Buffer.alloc(10);
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
  } else if (type === "VP8L") {
    data = Buffer.alloc(5);
    data[0] = 0x2f;
    data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  } else {
    data = Buffer.alloc(10);
    data.set([0x9d, 0x01, 0x2a], 3);
    data.writeUInt16LE(width, 6);
    data.writeUInt16LE(height, 8);
  }
  const paddedSize = data.length + (data.length % 2);
  const file = Buffer.alloc(12 + 8 + paddedSize);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WEBP", 8, "ascii");
  file.write(type === "VP8" ? "VP8 " : type, 12, "ascii");
  file.writeUInt32LE(data.length, 16);
  data.copy(file, 20);
  return file;
}

test("WebP metadata inspection supports extended, lossless, and lossy headers", () => {
  assert.deepEqual(inspectWebp(makeWebp("VP8X", 1536, 2288)), { width: 1536, height: 2288, codec: "VP8X" });
  assert.deepEqual(inspectWebp(makeWebp("VP8L", 1536, 1872)), { width: 1536, height: 1872, codec: "VP8L" });
  assert.deepEqual(inspectWebp(makeWebp("VP8", 1536, 1872)), { width: 1536, height: 1872, codec: "VP8" });
  assert.throws(() => inspectWebp(Buffer.from("not webp")), /complete WebP/);
});

test("pet catalog exposes a built-in pet and valid custom manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-pets-"));
  const petDir = path.join(root, "test-pet");
  await mkdir(petDir);
  const spritesheet = makeWebp("VP8X", 1536, 2288);
  const spritesheetSha256 = createHash("sha256").update(spritesheet).digest("hex");
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "test-pet",
    displayName: "Test Pet",
    description: "Fixture",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
    spritesheetSha256,
  }));
  await writeFile(path.join(petDir, "spritesheet.webp"), spritesheet);

  const catalog = new PetCatalog(root);
  const pets = await catalog.refresh();
  assert.deepEqual(pets.map((pet) => pet.id), ["codex-core", "test-pet"]);
  assert.equal(catalog.get("test-pet").kind, "custom");
  assert.equal(catalog.get("test-pet").spriteVersionNumber, 2);
  assert.equal(catalog.get("test-pet").atlasHeight, 2288);
  assert.equal(catalog.get("test-pet").assetSha256, spritesheetSha256);
  assert.match(catalog.get("test-pet").assetUrl, new RegExp(spritesheetSha256));
  assert.equal(catalog.getAssetPath("test-pet"), path.join(await realpath(petDir), "spritesheet.webp"));
  assert.equal(catalog.getAssetInfo("test-pet").bytes, spritesheet.length);
  assert.deepEqual((await catalog.readAsset("test-pet")).data, spritesheet);
  assert.equal(catalog.getAssetPath("../escape"), null);

  const changed = Buffer.from(spritesheet);
  changed[21] ^= 1;
  await writeFile(path.join(petDir, "spritesheet.webp"), changed);
  await assert.rejects(() => catalog.readAsset("test-pet"), /changed/);
});

test("device Pet assets are converted once per immutable source hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-device-pets-"));
  const petDir = path.join(root, "device-pet");
  await mkdir(petDir);
  const spritesheet = makeWebp("VP8X", 1536, 2288);
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "device-pet",
    displayName: "Device Pet",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(path.join(petDir, "spritesheet.webp"), spritesheet);
  let conversions = 0;
  const catalog = new PetCatalog(root, {
    deviceAssetConverter: async ({ data }) => {
      conversions += 1;
      return { data: Buffer.from(data), sha256: "a".repeat(64), bytes: data.length };
    },
  });
  await catalog.refresh();
  const first = await catalog.readDeviceAsset("device-pet");
  first.data[0] ^= 0xff;
  const second = await catalog.readDeviceAsset("device-pet");
  assert.equal(conversions, 1);
  assert.deepEqual(second.data, spritesheet);
  assert.equal(second.sourceSha256, createHash("sha256").update(spritesheet).digest("hex"));
});

test("pet catalog ignores mismatched ids, dimensions, and hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-invalid-pets-"));
  const wrongIdDir = path.join(root, "folder-name");
  await mkdir(wrongIdDir);
  await writeFile(path.join(wrongIdDir, "pet.json"), JSON.stringify({
    id: "different-name",
    displayName: "Invalid",
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(path.join(wrongIdDir, "spritesheet.webp"), makeWebp("VP8X", 1536, 1872));

  const wrongSizeDir = path.join(root, "wrong-size");
  await mkdir(wrongSizeDir);
  await writeFile(path.join(wrongSizeDir, "pet.json"), JSON.stringify({
    id: "wrong-size",
    displayName: "Wrong size",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(path.join(wrongSizeDir, "spritesheet.webp"), makeWebp("VP8X", 1536, 1872));

  const wrongHashDir = path.join(root, "wrong-hash");
  await mkdir(wrongHashDir);
  await writeFile(path.join(wrongHashDir, "pet.json"), JSON.stringify({
    id: "wrong-hash",
    displayName: "Wrong hash",
    spritesheetPath: "spritesheet.webp",
    spritesheetSha256: "0".repeat(64),
  }));
  await writeFile(path.join(wrongHashDir, "spritesheet.webp"), makeWebp("VP8X", 1536, 1872));

  const catalog = new PetCatalog(root);
  assert.deepEqual((await catalog.refresh()).map((pet) => pet.id), ["codex-core"]);
});
