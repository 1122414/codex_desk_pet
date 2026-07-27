#!/usr/bin/env node

import {
  inspectMacosLaunchAgent,
  installMacosLaunchAgent,
  removeMacosLaunchAgent,
} from "../src/server/macos-launch-agent.js";

const command = process.argv[2] ?? "install";

if (command === "--help" || command === "-h" || process.argv.length > 3) {
  console.log("Usage: macos-launch-agent.mjs [install|remove|status]");
} else if (command === "install") {
  const result = await installMacosLaunchAgent();
  console.log(`Codex Desk Bridge 已安装并启动：${result.plistPath}`);
  console.log(`运行目录：${result.runtimeDirectory}`);
  console.log(`日志目录：${result.logDirectory}`);
} else if (command === "remove") {
  const result = await removeMacosLaunchAgent();
  console.log(`Codex Desk Bridge 已停止并移除：${result.plistPath}`);
} else if (command === "status") {
  const result = inspectMacosLaunchAgent();
  console.log(result.loaded ? "Codex Desk Bridge 正在后台运行" : "Codex Desk Bridge 未加载");
  if (process.env.CODEX_DESK_DEBUG === "1" && result.detail) {
    console.log(result.detail);
  }
  process.exitCode = result.loaded ? 0 : 1;
} else {
  throw new Error("Usage: macos-launch-agent.mjs [install|remove|status]");
}
