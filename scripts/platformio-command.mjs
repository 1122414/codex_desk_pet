import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolvePlatformioCommand({
  explicit = process.env.PIO,
  coreDirectory = process.env.PLATFORMIO_CORE_DIR ??
    path.join(os.homedir(), ".platformio"),
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const candidates = platform === "win32"
    ? ["pio.exe", "platformio.exe"].map((name) =>
        path.join(coreDirectory, "penv", "Scripts", name))
    : ["pio", "platformio"].map((name) =>
        path.join(coreDirectory, "penv", "bin", name));
  return candidates.find((candidate) => fileExists(candidate)) ?? "pio";
}
