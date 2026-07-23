import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "firmware", ".pio", "esp-tts", "p4-2f8c4b04");
const commit = "2f8c4b0459db5bbb39abd77adae27962d6d94bcb";
const base = `https://raw.githubusercontent.com/espressif/esp-sr/${commit}`;

const files = [
  {
    source: "LICENSE",
    target: "LICENSE",
    sha256: "7d916fb00bc0742c47cafb0d0144b67f826d76779730b1cb8796045ea6ba1b9a",
  },
  {
    source: "esp-tts/esp_tts_chinese/esp32p4/libesp_tts_chinese.a",
    target: "lib/libesp_tts_chinese.a",
    sha256: "ec8a5137aebf70b6af63750ca70b16b7b46d26e37c357157d689b2b2cfca84de",
  },
  {
    source: "esp-tts/esp_tts_chinese/esp32p4/libvoice_set_xiaole.a",
    target: "lib/libvoice_set_xiaole.a",
    sha256: "46e1b3a881ee2e8c2d453b0451991b1f2a8b0d9d79cb1fd6a05b148ece1150ca",
  },
  {
    source: "esp-tts/esp_tts_chinese/esp_tts_voice_data_xiaoxin_small.dat",
    target: "voice_data/esp_tts_voice_data_xiaoxin_small.dat",
    sha256: "cc9a81fd716b3c07fae3ca2f802dc026081896f2e34db9b9db117d4de5a85c01",
  },
];

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function validFile(target, sha256) {
  try {
    return digest(await readFile(target)) === sha256;
  } catch {
    return false;
  }
}

async function download(entry) {
  const target = path.join(destination, entry.target);
  if (await validFile(target, entry.sha256)) {
    process.stdout.write(`已验证 ${entry.target}\n`);
    return;
  }

  const response = await fetch(`${base}/${entry.source}`);
  if (!response.ok) {
    throw new Error(`下载 ${entry.source} 失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = digest(buffer);
  if (actual !== entry.sha256) {
    throw new Error(`校验 ${entry.source} 失败：期望 ${entry.sha256}，得到 ${actual}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, buffer, { mode: 0o644 });
  await rename(temporary, target);
  process.stdout.write(`已安装 ${entry.target}\n`);
}

try {
  await Promise.all(files.map(download));
  process.stdout.write(`ESP-SR ESP32-P4 中文 TTS 已准备：${destination}\n`);
} catch (error) {
  await Promise.all(files.map((entry) => rm(
    `${path.join(destination, entry.target)}.tmp-${process.pid}`,
    { force: true },
  )));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
