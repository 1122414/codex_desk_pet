import { createHash } from "node:crypto";
import sharp from "sharp";
import { PET_ATLAS, PET_CELL } from "../shared/pet-spec.js";

export const DEVICE_PET_FORMAT = "rgb565-key-v1";
export const DEVICE_FRAME = Object.freeze({
  width: 384,
  height: 416,
  transparentColor: 0x0001,
});

function rgb565(red, green, blue) {
  const value = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
  return value === DEVICE_FRAME.transparentColor ? 0 : value;
}

export async function convertSpritesheetToDeviceAsset({
  data,
  spriteVersionNumber,
} = {}) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new TypeError("Pet spritesheet bytes are required");
  }
  const atlas = PET_ATLAS[spriteVersionNumber];
  if (!atlas) throw new RangeError("Pet sprite version is invalid");

  const image = sharp(data, { failOn: "error", limitInputPixels: 4_000_000 });
  const metadata = await image.metadata();
  if (metadata.width !== atlas.width || metadata.height !== atlas.height) {
    throw new Error(`Pet spritesheet must be ${atlas.width}x${atlas.height}`);
  }

  const resizedWidth = DEVICE_FRAME.width * PET_CELL.columns;
  const resizedHeight = DEVICE_FRAME.height * atlas.rows;
  const { data: rgba, info } = await image
    .ensureAlpha()
    .resize(resizedWidth, resizedHeight, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== resizedWidth || info.height !== resizedHeight || info.channels !== 4) {
    throw new Error("Pet conversion produced an unexpected pixel layout");
  }

  const frameCount = atlas.rows * PET_CELL.columns;
  const frameBytes = DEVICE_FRAME.width * DEVICE_FRAME.height * 2;
  const payload = Buffer.allocUnsafe(frameCount * frameBytes);
  let outputOffset = 0;
  for (let row = 0; row < atlas.rows; row += 1) {
    for (let column = 0; column < PET_CELL.columns; column += 1) {
      for (let y = 0; y < DEVICE_FRAME.height; y += 1) {
        const sourceY = row * DEVICE_FRAME.height + y;
        for (let x = 0; x < DEVICE_FRAME.width; x += 1) {
          const sourceX = column * DEVICE_FRAME.width + x;
          const sourceOffset = (sourceY * resizedWidth + sourceX) * 4;
          const color = rgba[sourceOffset + 3] < 128
            ? DEVICE_FRAME.transparentColor
            : rgb565(rgba[sourceOffset], rgba[sourceOffset + 1], rgba[sourceOffset + 2]);
          payload.writeUInt16LE(color, outputOffset);
          outputOffset += 2;
        }
      }
    }
  }

  return Object.freeze({
    data: payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
    bytes: payload.length,
    format: DEVICE_PET_FORMAT,
    frameWidth: DEVICE_FRAME.width,
    frameHeight: DEVICE_FRAME.height,
    frameCount,
    transparentColor: DEVICE_FRAME.transparentColor,
  });
}
