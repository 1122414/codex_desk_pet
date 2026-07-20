import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePetManifest } from "../shared/pet-spec.js";

export const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export const BUILTIN_PETS = Object.freeze([
  Object.freeze({
    id: "codex-core",
    displayName: "Codex Core",
    description: "MVP 内置矢量宠物，可在没有图集时显示全部状态。",
    spriteVersionNumber: 2,
    kind: "builtin",
    assetUrl: null,
  }),
]);

function defaultPetRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "pets");
}

async function readRegularFile(filePath, maxBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Pet resource must be a regular file");
    if (info.size <= 0 || info.size > maxBytes) {
      throw new Error(`Pet resource size must be between 1 and ${maxBytes} bytes`);
    }
    return { info, data: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

function readUint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

export function inspectWebp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new Error("Pet spritesheet is not a complete WebP file");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Pet spritesheet must use WebP format");
  }
  const riffEnd = buffer.readUInt32LE(4) + 8;
  if (riffEnd > buffer.length || riffEnd < 20) throw new Error("Pet spritesheet has an invalid RIFF size");

  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkSize;
    if (chunkEnd > riffEnd) throw new Error("Pet spritesheet contains a truncated WebP chunk");

    if (type === "VP8X" && chunkSize >= 10) {
      return {
        width: readUint24LE(buffer, dataOffset + 4) + 1,
        height: readUint24LE(buffer, dataOffset + 7) + 1,
        codec: "VP8X",
      };
    }
    if (type === "VP8L" && chunkSize >= 5 && buffer[dataOffset] === 0x2f) {
      const bits = buffer.readUInt32LE(dataOffset + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        codec: "VP8L",
      };
    }
    if (
      type === "VP8 " &&
      chunkSize >= 10 &&
      buffer[dataOffset + 3] === 0x9d &&
      buffer[dataOffset + 4] === 0x01 &&
      buffer[dataOffset + 5] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
        codec: "VP8",
      };
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  throw new Error("Pet spritesheet does not contain a supported WebP image chunk");
}

export class PetCatalog {
  #assetPaths = new Map();
  #assetInfo = new Map();
  #pets = [...BUILTIN_PETS];

  constructor(root = defaultPetRoot()) {
    this.root = path.resolve(root);
  }

  async refresh() {
    const discovered = [];
    const assetPaths = new Map();
    const assetInfo = new Map();
    let rootRealPath;

    try {
      rootRealPath = await realpath(this.root);
    } catch (error) {
      if (error.code === "ENOENT") {
        this.#pets = [...BUILTIN_PETS];
        this.#assetPaths = assetPaths;
        this.#assetInfo = assetInfo;
        return this.list();
      }
      throw error;
    }

    const entries = await readdir(rootRealPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(rootRealPath, entry.name);
      const manifestPath = path.join(directory, "pet.json");
      const spritesheetPath = path.join(directory, "spritesheet.webp");

      try {
        const [manifestFile, spriteFile, directoryRealPath] = await Promise.all([
          readRegularFile(manifestPath, MAX_MANIFEST_BYTES),
          readRegularFile(spritesheetPath, MAX_SPRITESHEET_BYTES),
          realpath(directory),
        ]);
        if (directoryRealPath !== directory || !directoryRealPath.startsWith(`${rootRealPath}${path.sep}`)) continue;

        const dimensions = inspectWebp(spriteFile.data);
        const manifest = validatePetManifest(JSON.parse(manifestFile.data.toString("utf8")), dimensions);
        if (manifest.id !== entry.name) continue;
        const assetSha256 = createHash("sha256").update(spriteFile.data).digest("hex");
        if (manifest.spritesheetSha256 && manifest.spritesheetSha256 !== assetSha256) {
          throw new Error("Pet spritesheet SHA-256 does not match pet.json");
        }

        discovered.push({
          ...manifest,
          kind: "custom",
          assetUrl: `/api/pets/${encodeURIComponent(manifest.id)}/spritesheet?v=${assetSha256}`,
          assetSha256,
          assetBytes: spriteFile.info.size,
          atlasWidth: dimensions.width,
          atlasHeight: dimensions.height,
        });
        assetPaths.set(manifest.id, spritesheetPath);
        assetInfo.set(manifest.id, {
          path: spritesheetPath,
          sha256: assetSha256,
          bytes: spriteFile.info.size,
          width: dimensions.width,
          height: dimensions.height,
        });
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code) && !(error instanceof SyntaxError)) {
          this.onWarning?.(`忽略无效 Pet ${entry.name}: ${error.message}`);
        }
      }
    }

    discovered.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.#pets = [...BUILTIN_PETS, ...discovered];
    this.#assetPaths = assetPaths;
    this.#assetInfo = assetInfo;
    return this.list();
  }

  list() {
    return this.#pets.map((pet) => ({ ...pet }));
  }

  has(id) {
    return this.#pets.some((pet) => pet.id === id);
  }

  get(id) {
    const pet = this.#pets.find((candidate) => candidate.id === id);
    return pet ? { ...pet } : null;
  }

  getAssetPath(id) {
    return this.#assetPaths.get(id) ?? null;
  }

  getAssetInfo(id) {
    const info = this.#assetInfo.get(id);
    return info ? { ...info } : null;
  }

  async readAsset(id) {
    const expected = this.#assetInfo.get(id);
    if (!expected) return null;
    const current = await readRegularFile(expected.path, MAX_SPRITESHEET_BYTES);
    const sha256 = createHash("sha256").update(current.data).digest("hex");
    if (current.info.size !== expected.bytes || sha256 !== expected.sha256) {
      throw new Error("Pet spritesheet changed; refresh the pet catalog");
    }
    return {
      data: current.data,
      sha256,
      bytes: current.info.size,
      width: expected.width,
      height: expected.height,
    };
  }
}
