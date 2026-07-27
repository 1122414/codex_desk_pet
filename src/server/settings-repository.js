import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_SETTINGS = Object.freeze({ selectedPetId: "codex-core" });

export class SettingsRepository {
  constructor(filePath = path.join(os.homedir(), ".codex-desk", "settings.json")) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return {
        ...DEFAULT_SETTINGS,
        ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
      };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return { ...DEFAULT_SETTINGS };
      throw error;
    }
  }

  async save(settings) {
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
