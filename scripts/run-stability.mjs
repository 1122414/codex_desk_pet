import { runStabilitySuite } from "../src/server/stability-suite.js";

const report = await runStabilitySuite();
process.stdout.write(
  "Codex Desk Buddy 稳定性故障注入通过\n" +
  `${JSON.stringify(report, null, 2)}\n`,
);
