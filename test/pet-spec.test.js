import test from "node:test";
import assert from "node:assert/strict";
import {
  getAnimation,
  getLookDirection,
  resolveSpriteVersion,
  validatePetManifest,
} from "../src/shared/pet-spec.js";

test("standard animation rows match the Codex pet contract", () => {
  assert.deepEqual(getAnimation("idle"), { row: 0, durations: [280, 110, 110, 140, 140, 320] });
  assert.equal(getAnimation("review").row, 8);
  assert.throws(() => getAnimation("unknown"), /Unknown pet animation/);
});

test("look direction snaps clockwise to the nearest 22.5 degree cell", () => {
  assert.deepEqual(getLookDirection(0), { degree: 0, row: 9, column: 0 });
  assert.deepEqual(getLookDirection(91), { degree: 90, row: 9, column: 4 });
  assert.deepEqual(getLookDirection(-90), { degree: 270, row: 10, column: 4 });
  assert.deepEqual(getLookDirection(359), { degree: 0, row: 9, column: 0 });
});

test("pet manifest validation supports v1 default and explicit v2", () => {
  const base = { id: "desk-fox", displayName: "Desk Fox", spritesheetPath: "spritesheet.webp" };
  assert.equal(validatePetManifest(base).spriteVersionNumber, 1);
  assert.equal(validatePetManifest({ ...base, spriteVersionNumber: 2 }).spriteVersionNumber, 2);
  assert.equal(resolveSpriteVersion({}, { width: 1536, height: 2288 }), 2);
  assert.throws(() => validatePetManifest({ ...base, id: "../escape" }), /Pet id/);
  assert.throws(() => validatePetManifest({ ...base, spritesheetPath: "../secret" }), /spritesheetPath/);
});

