#!/usr/bin/env python3
"""Create one reusable fictional Taiwan-Mandarin companion voice reference."""

import argparse
from io import BytesIO
import json
from pathlib import Path
import wave

import numpy as np
from mlx_audio.tts.utils import load_model


REFERENCE_TEXT = "欸，回来啦？我是斯卡蒂。你想讲什么就讲呀，我会听。只是别故意晾着我太久，好不好？"
VOICE_DESCRIPTION = (
    "二十多岁的成年台湾女性，使用自然清楚的台湾国语。声线明亮、柔软、近距离，"
    "像在电话里和熟人聊天，不是播音腔或机械朗读；语速中等，句尾有自然起伏和轻微笑意。"
    "她能温柔地关心、俏皮地打趣，也会有一点点嘴硬和撒娇，但不夸张、不幼态、"
    "不模仿任何真实人物或公众人物。"
)


def wav_bytes(samples, sample_rate):
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise ValueError("声音设计没有生成音频")
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = np.rint(pcm * 32767.0).astype("<i2")
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    output = Path(args.output)
    profile = Path(args.profile)
    if output.exists() and profile.exists() and not args.force:
        print(f"已保留现有虚构角色声：{output}")
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    model = load_model(Path(args.model))
    result = next(model.generate_voice_design(
        REFERENCE_TEXT,
        instruct=VOICE_DESCRIPTION,
        language="Chinese",
        temperature=0.75,
        top_p=0.9,
        stream=False,
        max_tokens=512,
    ))
    output.write_bytes(wav_bytes(result.audio, int(result.sample_rate)))
    profile.write_text(json.dumps({
        "name": "Skadi Taiwan Mandarin",
        "referenceText": REFERENCE_TEXT,
        "voiceDescription": VOICE_DESCRIPTION,
        "source": "Qwen3-TTS VoiceDesign",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已创建虚构台湾国语角色声：{output}")


if __name__ == "__main__":
    main()
