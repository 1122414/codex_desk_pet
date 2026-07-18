import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePetManifest } from "../shared/pet-spec.js";

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

export class PetCatalog {
  #assetPaths = new Map();
  #pets = [...BUILTIN_PETS];

  constructor(root = defaultPetRoot()) {
    this.root = path.resolve(root);
  }

  async refresh() {
    const discovered = [];
    const assetPaths = new Map();
    let rootRealPath;

    try {
      rootRealPath = await realpath(this.root);
    } catch (error) {
      if (error.code === "ENOENT") {
        this.#pets = [...BUILTIN_PETS];
        this.#assetPaths = assetPaths;
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
        const [manifestStat, spriteStat, directoryRealPath] = await Promise.all([
          lstat(manifestPath),
          lstat(spritesheetPath),
          realpath(directory),
        ]);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || !spriteStat.isFile() || spriteStat.isSymbolicLink()) continue;
        if (directoryRealPath !== directory || !directoryRealPath.startsWith(`${rootRealPath}${path.sep}`)) continue;

        const raw = await readFile(manifestPath, "utf8");
        if (Buffer.byteLength(raw) > 64 * 1024) continue;
        const manifest = validatePetManifest(JSON.parse(raw));
        if (manifest.id !== entry.name) continue;

        discovered.push({
          ...manifest,
          kind: "custom",
          assetUrl: `/api/pets/${encodeURIComponent(manifest.id)}/spritesheet`,
        });
        assetPaths.set(manifest.id, spritesheetPath);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code) && !(error instanceof SyntaxError)) {
          this.onWarning?.(`忽略无效 Pet ${entry.name}: ${error.message}`);
        }
      }
    }

    discovered.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.#pets = [...BUILTIN_PETS, ...discovered];
    this.#assetPaths = assetPaths;
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
}

