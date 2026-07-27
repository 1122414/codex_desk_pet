import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
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
    await sharp(source)
      .extract({
        left: column * cellWidth,
        top: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      })
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toFile(path.join(output, `r${row}f${index}.png`));
  }
}

process.stdout.write(`已生成 ${rows * sourceFrames.length} 帧内置 Pet：${output}\n`);
