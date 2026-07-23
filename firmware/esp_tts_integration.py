from pathlib import Path

Import("env")

root = Path(env.subst("$PROJECT_DIR")) / ".pio" / "esp-tts" / "p4-2f8c4b04"
lib_dir = root / "lib"
required = [
    lib_dir / "libesp_tts_chinese.a",
    lib_dir / "libvoice_set_xiaole.a",
    root / "voice_data" / "esp_tts_voice_data_xiaoxin_small.dat",
]
missing = [str(item) for item in required if not item.is_file()]
if missing:
    raise RuntimeError(
        "缺少 ESP32-P4 中文 TTS 文件。请先在仓库根目录运行 "
        "`npm run setup:firmware-tts`。\n" + "\n".join(missing)
    )

env.Append(
    LIBPATH=[str(lib_dir)],
    LIBS=["esp_tts_chinese", "voice_set_xiaole"],
)
