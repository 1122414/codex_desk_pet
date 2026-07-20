import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDirectory = path.join(root, "firmware", "lib", "codex_core", "src");
const testSource = path.join(root, "firmware", "test_native", "main.cpp");
const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-desk-firmware-"));
const executable = path.join(temporary, "firmware-core-tests");

try {
  const sources = (await readdir(coreDirectory))
    .filter((file) => file.endsWith(".cpp"))
    .sort()
    .map((file) => path.join(coreDirectory, file));
  const compiler = process.env.CXX || "c++";
  const compile = spawnSync(compiler, [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    "-I",
    coreDirectory,
    ...sources,
    testSource,
    "-o",
    executable,
  ], { stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exit(compile.status ?? 1);

  const run = spawnSync(executable, [], { stdio: "inherit" });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
