import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolvePlatformioCommand } from "../scripts/platformio-command.mjs";

test("PlatformIO command prefers an explicit override", () => {
  assert.equal(resolvePlatformioCommand({
    explicit: "/tools/pio",
    coreDirectory: "/unused",
    fileExists: () => false,
  }), "/tools/pio");
});

test("PlatformIO command uses its managed environment before PATH", () => {
  const coreDirectory = path.resolve("/platformio-core");
  const expected = path.join(coreDirectory, "penv", "bin", "pio");
  assert.equal(resolvePlatformioCommand({
    explicit: "",
    coreDirectory,
    platform: "darwin",
    fileExists: (candidate) => candidate === expected,
  }), expected);
});

test("PlatformIO command falls back to PATH when no managed entry exists", () => {
  assert.equal(resolvePlatformioCommand({
    explicit: "",
    coreDirectory: "/missing",
    fileExists: () => false,
  }), "pio");
});
