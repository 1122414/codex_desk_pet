import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function defaultHookTokenPath() {
  return path.join(os.homedir(), ".codex-desk", "hook-token");
}

export class HookTokenRepository {
  constructor(filePath = defaultHookTokenPath()) {
    this.filePath = filePath;
  }

  async loadOrCreate() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const token = raw.trim();
      if (!TOKEN_PATTERN.test(token)) throw new Error("Codex hook token file is invalid");
      await chmod(this.filePath, 0o600);
      return token;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const token = randomBytes(32).toString("hex");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporary, `${token}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return token;
  }
}
