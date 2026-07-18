import { JsonRpcClient } from "../src/server/json-rpc-client.js";

const mode = process.env.CODEX_DESK_MODE === "daemon" ? "daemon" : "direct";
const client = new JsonRpcClient({ mode });
client.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(message);
});

try {
  const initialized = await client.start();
  const result = await client.request("thread/list", {
    limit: 3,
    sortKey: "recency_at",
    sortDirection: "desc",
    archived: false,
    useStateDbOnly: true,
  });
  console.log(JSON.stringify({
    ok: true,
    mode,
    userAgent: initialized.userAgent,
    threadCount: result.data.length,
    statuses: result.data.map((thread) => thread.status.type),
  }, null, 2));
} finally {
  await client.stop();
}

