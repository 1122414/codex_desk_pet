import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  DEVICE_FRAME,
  DEVICE_PET_FORMAT,
  convertSpritesheetToDeviceAsset,
} from "../src/server/device-pet-asset.js";

test("WebP Pet conversion produces ordered transparent RGB565 frames for CoreS3", async () => {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1536" height="2288">
      <rect x="0" y="0" width="192" height="208" fill="#ff0000"/>
      <rect x="192" y="0" width="192" height="208" fill="#00ff00"/>
      <rect x="0" y="208" width="192" height="208" fill="#0000ff"/>
    </svg>
  `);
  const webp = await sharp(svg).webp({ lossless: true }).toBuffer();
  const asset = await convertSpritesheetToDeviceAsset({ data: webp, spriteVersionNumber: 2 });
  const frameBytes = DEVICE_FRAME.width * DEVICE_FRAME.height * 2;

  assert.equal(asset.format, DEVICE_PET_FORMAT);
  assert.equal(asset.frameCount, 88);
  assert.equal(asset.bytes, 88 * frameBytes);
  assert.equal(asset.data.readUInt16LE(0), 0xf800);
  assert.equal(asset.data.readUInt16LE(frameBytes), 0x07e0);
  assert.equal(asset.data.readUInt16LE(frameBytes * 2), DEVICE_FRAME.transparentColor);
  assert.equal(asset.data.readUInt16LE(frameBytes * 8), 0x001f);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
});

test("Pet conversion rejects mismatched atlas dimensions", async () => {
  const webp = await sharp({
    create: { width: 32, height: 32, channels: 4, background: "transparent" },
  }).webp().toBuffer();
  await assert.rejects(
    () => convertSpritesheetToDeviceAsset({ data: webp, spriteVersionNumber: 2 }),
    /must be 1536x2288/,
  );
});
