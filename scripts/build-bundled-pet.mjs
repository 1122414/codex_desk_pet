import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(
  process.argv[2] ??
  path.join(process.env.HOME, ".codex", "pets", "chibi-skadi", "spritesheet.webp"),
);
const output = path.join(root, "firmware", "data", "bundled-pet");
const cellWidth = 192;
const cellHeight = 208;
const columns = 8;
const rows = 9;
const sourceFrames = [0, 4];
const transparentColor = 0x0001;

function rgb565(red, green, blue) {
  const value = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
  return value === transparentColor ? 0 : value;
}

function encodeFrame(rgba) {
  const runs = [];
  let color = -1;
  let length = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const next = rgba[offset + 3] < 128
      ? transparentColor
      : rgb565(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
    if (next === color && length < 0xffff) {
      length += 1;
      continue;
    }
    if (length > 0) runs.push({ length, color });
    color = next;
    length = 1;
  }
  if (length > 0) runs.push({ length, color });

  const output = Buffer.allocUnsafe(8 + runs.length * 4);
  output.write("CPR1", 0, "ascii");
  output.writeUInt16LE(cellWidth, 4);
  output.writeUInt16LE(cellHeight, 6);
  let offset = 8;
  for (const run of runs) {
    output.writeUInt16LE(run.length, offset);
    output.writeUInt16LE(run.color, offset + 2);
    offset += 4;
  }
  const compressed = deflateSync(output, { level: 9 });
  const packed = Buffer.allocUnsafe(8 + compressed.length);
  packed.write("CPZ1", 0, "ascii");
  packed.writeUInt32LE(output.length, 4);
  compressed.copy(packed, 8);
  return packed;
}

const metadata = await sharp(source).metadata();
if (metadata.width !== cellWidth * columns || metadata.height !== cellHeight * rows) {
  throw new Error(
    `预期 ${cellWidth * columns}x${cellHeight * rows} 的 v1 Pet 图集，实际为 ` +
    `${metadata.width}x${metadata.height}`,
  );
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (let row = 0; row < rows; row += 1) {
  for (let index = 0; index < sourceFrames.length; index += 1) {
    const column = sourceFrames[index];
    const { data, info } = await sharp(source)
      .extract({
        left: column * cellWidth,
        top: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== cellWidth || info.height !== cellHeight || info.channels !== 4) {
      throw new Error("内置 Pet 帧解码尺寸异常");
    }
    await writeFile(
      path.join(output, `r${row}f${index}.rle`),
      encodeFrame(data),
    );
  }
}

process.stdout.write(`已生成 ${rows * sourceFrames.length} 帧 RLE 内置 Pet：${output}\n`);
