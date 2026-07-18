import { CodexBridge } from "./codex-bridge.js";
import { DeskStore } from "./desk-store.js";
import { DeskHttpServer } from "./http-server.js";
import { PetCatalog } from "./pet-catalog.js";
import { SettingsRepository } from "./settings-repository.js";

const mode = process.env.CODEX_DESK_MODE ?? "direct";
if (!new Set(["direct", "daemon", "mock"]).has(mode)) throw new Error("CODEX_DESK_MODE must be direct, daemon, or mock");

const catalog = new PetCatalog();
catalog.onWarning = (message) => console.warn(message);
await catalog.refresh();

const settings = new SettingsRepository();
const saved = await settings.load();
const selectedPetId = catalog.has(saved.selectedPetId) ? saved.selectedPetId : "codex-core";
const store = new DeskStore({ selectedPetId });
const bridge = new CodexBridge({ store, mode });
bridge.on("diagnostic", (message) => {
  if (process.env.CODEX_DESK_DEBUG === "1") console.warn(`[codex] ${message}`);
});

try {
  await bridge.start();
} catch (error) {
  console.warn(`Codex bridge is unavailable: ${error.message}`);
}

const server = new DeskHttpServer({ store, bridge, catalog, settings });
server.onError = (error) => console.error(error);
const address = await server.listen({ port: Number(process.env.PORT ?? 4317) });
console.log(`Codex Desk Buddy is running at http://127.0.0.1:${address.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.close();
  await bridge.stop();
}

process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));

