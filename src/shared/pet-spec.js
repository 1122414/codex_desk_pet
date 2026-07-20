export const PET_CELL = Object.freeze({ width: 192, height: 208, columns: 8 });

export const PET_ATLAS = Object.freeze({
  1: Object.freeze({ width: 1536, height: 1872, rows: 9 }),
  2: Object.freeze({ width: 1536, height: 2288, rows: 11 }),
});

export const STANDARD_ANIMATIONS = Object.freeze({
  idle: Object.freeze({ row: 0, durations: [280, 110, 110, 140, 140, 320] }),
  "running-right": Object.freeze({ row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] }),
  "running-left": Object.freeze({ row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] }),
  waving: Object.freeze({ row: 3, durations: [140, 140, 140, 280] }),
  jumping: Object.freeze({ row: 4, durations: [140, 140, 140, 140, 280] }),
  failed: Object.freeze({ row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] }),
  waiting: Object.freeze({ row: 6, durations: [150, 150, 150, 150, 150, 260] }),
  running: Object.freeze({ row: 7, durations: [120, 120, 120, 120, 120, 220] }),
  review: Object.freeze({ row: 8, durations: [150, 150, 150, 150, 150, 280] }),
});

export const LOOK_DIRECTIONS = Object.freeze(
  Array.from({ length: 16 }, (_, index) => Object.freeze({
    degree: index * 22.5,
    row: index < 8 ? 9 : 10,
    column: index % 8,
  })),
);

export function getAnimation(name) {
  const animation = STANDARD_ANIMATIONS[name];
  if (!animation) {
    throw new RangeError(`Unknown pet animation: ${name}`);
  }
  return animation;
}

export function getLookDirection(degree) {
  if (!Number.isFinite(degree)) {
    throw new TypeError("Look direction must be a finite number");
  }
  const normalized = ((degree % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  return LOOK_DIRECTIONS[index];
}

export function resolveSpriteVersion(manifest = {}, dimensions = {}) {
  const declared = manifest.spriteVersionNumber;
  const byDimensions = Object.entries(PET_ATLAS).find(([, atlas]) => (
    atlas.width === dimensions.width && atlas.height === dimensions.height
  ));

  if (declared !== undefined && declared !== 1 && declared !== 2) {
    throw new RangeError("spriteVersionNumber must be 1 or 2");
  }

  if (declared && byDimensions && Number(byDimensions[0]) !== declared) {
    throw new Error("Pet manifest version does not match spritesheet dimensions");
  }

  if (declared) return declared;
  if (byDimensions) return Number(byDimensions[0]);
  return 1;
}

export function validatePetManifest(manifest, dimensions = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Pet manifest must be an object");
  }

  for (const field of ["id", "displayName", "spritesheetPath"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new TypeError(`Pet manifest requires a non-empty ${field}`);
    }
  }

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id)) {
    throw new Error("Pet id must use lowercase letters, numbers, and hyphens");
  }

  if (manifest.spritesheetPath !== "spritesheet.webp") {
    throw new Error("Pet spritesheetPath must be spritesheet.webp");
  }

  const displayName = manifest.displayName.trim();
  const description = typeof manifest.description === "string" ? manifest.description.trim() : "";
  if (displayName.length > 80) throw new Error("Pet displayName must be at most 80 characters");
  if (description.length > 240) throw new Error("Pet description must be at most 240 characters");
  if (manifest.spritesheetSha256 !== undefined && !/^[a-f0-9]{64}$/.test(manifest.spritesheetSha256)) {
    throw new Error("Pet spritesheetSha256 must be a lowercase SHA-256 digest");
  }

  const spriteVersionNumber = resolveSpriteVersion(manifest, dimensions);
  if (Number.isFinite(dimensions.width) || Number.isFinite(dimensions.height)) {
    const expected = PET_ATLAS[spriteVersionNumber];
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      throw new Error(`Pet spritesheet must be ${expected.width}x${expected.height} for v${spriteVersionNumber}`);
    }
  }

  return {
    id: manifest.id,
    displayName,
    description,
    spriteVersionNumber,
    spritesheetPath: manifest.spritesheetPath,
    ...(manifest.spritesheetSha256 === undefined ? {} : { spritesheetSha256: manifest.spritesheetSha256 }),
  };
}
