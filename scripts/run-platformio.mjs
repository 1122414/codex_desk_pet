import { spawnSync } from "node:child_process";
import { resolvePlatformioCommand } from "./platformio-command.mjs";

const command = resolvePlatformioCommand();
const result = spawnSync(command, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    PLATFORMIO_SETTING_ENABLE_TELEMETRY: "no",
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
