import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installCodexHooks,
  removeCodexHooks,
} from "../src/server/codex-hook-installer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = path.resolve(
  process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
);
const removing = process.argv.includes("--remove");
const result = removing
  ? await removeCodexHooks({ codexHome })
  : await installCodexHooks({
      codexHome,
      sourceScript: path.join(
        root,
        "plugins",
        "codex-desk-buddy",
        "scripts",
        "forward-hook.mjs",
      ),
    });

if (removing) {
  process.stdout.write(
    `已移除 Codex Desk Buddy Hooks：${result.configPath}\n` +
    "其他已有 Hooks 未改动。\n",
  );
} else {
  process.stdout.write(
    `已安装 Codex Desk Buddy Hooks：${result.configPath}\n` +
    `转发脚本：${result.targetScript}\n` +
    "请在 Codex 中打开 /hooks，检查并信任这组 Hooks，然后新建任务。\n",
  );
}
