import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PetCatalog } from "../src/server/pet-catalog.js";

test("pet catalog exposes a built-in pet and valid custom manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-pets-"));
  const petDir = path.join(root, "test-pet");
  await mkdir(petDir);
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "test-pet",
    displayName: "Test Pet",
    description: "Fixture",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(path.join(petDir, "spritesheet.webp"), "fixture");

  const catalog = new PetCatalog(root);
  const pets = await catalog.refresh();
  assert.deepEqual(pets.map((pet) => pet.id), ["codex-core", "test-pet"]);
  assert.equal(catalog.get("test-pet").kind, "custom");
  assert.equal(catalog.getAssetPath("test-pet"), path.join(await realpath(petDir), "spritesheet.webp"));
  assert.equal(catalog.getAssetPath("../escape"), null);
});

test("pet catalog ignores mismatched directory and manifest ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-invalid-pets-"));
  const petDir = path.join(root, "folder-name");
  await mkdir(petDir);
  await writeFile(path.join(petDir, "pet.json"), JSON.stringify({
    id: "different-name",
    displayName: "Invalid",
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(path.join(petDir, "spritesheet.webp"), "fixture");
  const catalog = new PetCatalog(root);
  assert.deepEqual((await catalog.refresh()).map((pet) => pet.id), ["codex-core"]);
});
