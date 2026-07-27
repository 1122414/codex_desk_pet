import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMacosLaunchAgent,
  installMacosLaunchAgent,
} from "../src/server/macos-launch-agent.js";

test("macOS LaunchAgent pins absolute executables and device transports", () => {
  const plist = buildMacosLaunchAgent({
    nodePath: "/opt/node/bin/node",
    codexPath: "/Applications/Codex & Tools/codex",
    projectDirectory: "/Users/test/Codex Desk",
    logDirectory: "/Users/test/Library/Logs/CodexDeskBuddy",
    homeDirectory: "/Users/test",
    path: "/opt/node/bin:/usr/bin:/bin",
  });
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist, /Codex &amp; Tools/);
  assert.match(plist, /<key>CODEX_DESK_USB_AUTO<\/key>\n    <string>1<\/string>/);
  assert.match(plist, /<key>CODEX_DESK_BLE<\/key>\n    <string>1<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n    <true\/>/);
});

test("macOS LaunchAgent installation is atomic and idempotently reloads the service", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "codex-desk-launch-agent-"));
  const calls = [];
  const launchctl = (_command, args) => {
    calls.push(args);
    return { status: args[0] === "bootout" ? 3 : 0, stdout: "", stderr: "" };
  };
  const options = {
    projectDirectory: "/Users/test/codex-desk",
    homeDirectory,
    nodePath: "/opt/node/bin/node",
    codexPath: "/opt/codex/bin/codex",
    path: "/opt/node/bin:/opt/codex/bin:/usr/bin:/bin",
    uid: 501,
    launchctl,
    copyApplicationRuntime: false,
    platform: "darwin",
  };
  const first = await installMacosLaunchAgent(options);
  const second = await installMacosLaunchAgent(options);
  assert.equal(first.plistPath, second.plistPath);
  const plist = await readFile(first.plistPath, "utf8");
  assert.match(plist, /<string>\/Users\/test\/codex-desk\/src\/server\/index.js<\/string>/);
  assert.deepEqual(calls.slice(0, 3).map((args) => args[0]), [
    "bootout",
    "bootstrap",
    "enable",
  ]);
  assert.equal(calls.length, 6);
});

test("macOS service runs from Application Support instead of a protected project directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-desk-launch-runtime-"));
  const projectDirectory = join(root, "Documents", "codex-desk");
  const homeDirectory = join(root, "home");
  await mkdir(join(projectDirectory, "src", "server"), { recursive: true });
  await mkdir(join(projectDirectory, "public"), { recursive: true });
  await mkdir(join(projectDirectory, "node_modules"), { recursive: true });
  await mkdir(join(projectDirectory, ".codex-desk"), { recursive: true });
  await writeFile(join(projectDirectory, "src", "server", "index.js"), "export {};\n");
  await writeFile(join(projectDirectory, "public", "index.html"), "<!doctype html>\n");
  await writeFile(join(projectDirectory, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(projectDirectory, ".codex-desk", "settings.json"),
    '{"selectedPetId":"chibi-skadi"}\n',
  );

  const result = await installMacosLaunchAgent({
    projectDirectory,
    homeDirectory,
    nodePath: "/opt/node/bin/node",
    codexPath: "/opt/codex/bin/codex",
    uid: 501,
    start: false,
    platform: "darwin",
  });
  assert.equal(
    result.runtimeDirectory,
    join(homeDirectory, "Library", "Application Support", "CodexDeskBuddy", "app"),
  );
  assert.equal(
    await readFile(join(result.runtimeDirectory, "src", "server", "index.js"), "utf8"),
    "export {};\n",
  );
  assert.match(
    await readFile(result.plistPath, "utf8"),
    /Application Support\/CodexDeskBuddy\/app\/src\/server\/index.js/,
  );
  assert.equal(
    JSON.parse(await readFile(join(homeDirectory, ".codex-desk", "settings.json"), "utf8"))
      .selectedPetId,
    "chibi-skadi",
  );
});
