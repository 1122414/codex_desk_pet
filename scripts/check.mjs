import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "public", "scripts", "test", "plugins"];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(target));
    else if (entry.isFile() && (target.endsWith(".js") || target.endsWith(".mjs"))) files.push(target);
  }
  return files;
}

const files = (await Promise.all(roots.map(collect))).flat().sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tests = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
if (tests.status !== 0) process.exit(tests.status ?? 1);

const firmware = spawnSync(process.execPath, ["scripts/check-firmware.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(firmware.status ?? 1);
