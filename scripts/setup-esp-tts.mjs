import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "firmware", ".pio", "esp-tts", "v1.2.0");
const commit = "018ed410245179225886859b33e9989218b3ec5e";
const base = `https://raw.githubusercontent.com/espressif/esp-sr/${commit}`;

const files = [
  {
    source: "LICENSE",
    target: "LICENSE",
    sha256: "7d916fb00bc0742c47cafb0d0144b67f826d76779730b1cb8796045ea6ba1b9a",
  },
  {
    source: "esp-tts/esp_tts_chinese/include/esp_tts.h",
    target: "include/esp_tts.h",
    sha256: "55430c22354dbf279bb3747a960bda74f678d6d28d25e731243ad6e13609d1c5",
  },
  {
    source: "esp-tts/esp_tts_chinese/include/esp_tts_voice.h",
    target: "include/esp_tts_voice.h",
    sha256: "9cf7986ff5fbe1fcbf45116409636e3fca7630c6461be1d1faa3577e1944792c",
  },
  {
    source: "esp-tts/esp_tts_chinese/include/esp_tts_voice_template.h",
    target: "include/esp_tts_voice_template.h",
    sha256: "d3e6aebae238a76c55445de63ba93a5d592575e4c6bb5bd9969ddcdb1fcf3bcd",
  },
  {
    source: "esp-tts/esp_tts_chinese/esp32s3/libesp_tts_chinese.a",
    target: "lib/libesp_tts_chinese.a",
    sha256: "7034c1075a464ae355eb4452d267e27831ecb519bf4629b85464be03796819f3",
  },
  {
    source: "esp-tts/esp_tts_chinese/esp32s3/libvoice_set_xiaole.a",
    target: "lib/libvoice_set_xiaole.a",
    sha256: "3cf241ca026f7497fec3ea961e83a7e7ccdfc7fa5440811be5e71ebc964fb08e",
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
  process.stdout.write(`ESP-SR v1.2.0 中文 TTS 已准备：${destination}\n`);
} catch (error) {
  await Promise.all(files.map((entry) => rm(
    `${path.join(destination, entry.target)}.tmp-${process.pid}`,
    { force: true },
  )));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
