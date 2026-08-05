#!/usr/bin/env python3
"""Local Qwen3-TTS sidecar for Codex Desk Buddy."""

import argparse
import audioop
from io import BytesIO
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import wave

import numpy as np
from scipy.signal import resample_poly
from mlx_audio.tts.utils import load_model


TARGET_SAMPLE_RATE = 16_000
MAX_TEXT_BYTES = 480
WARMUP_TEXT = "嗯，我在。"
STREAMING_INTERVAL_SECONDS = 0.32


def parse_profile(path):
    profile = json.loads(Path(path).read_text(encoding="utf-8"))
    reference_text = str(profile.get("referenceText", "")).strip()
    if not reference_text:
        raise ValueError("语音配置缺少 referenceText")
    return reference_text


def pcm16_bytes(samples):
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise ValueError("本地神经语音没有生成音频")
    samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm = np.clip(samples, -1.0, 1.0)
    return np.rint(pcm * 32767.0).astype("<i2").tobytes()


def wav_bytes(samples, sample_rate):
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise ValueError("本地神经语音没有生成音频")
    if sample_rate != TARGET_SAMPLE_RATE:
        divisor = math.gcd(sample_rate, TARGET_SAMPLE_RATE)
        samples = resample_poly(
            samples,
            TARGET_SAMPLE_RATE // divisor,
            sample_rate // divisor,
        )
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(TARGET_SAMPLE_RATE)
        wav.writeframes(pcm16_bytes(samples))
    return output.getvalue()


class VoiceEngine:
    def __init__(self, model_path, reference_audio, reference_text):
        self.model = load_model(Path(model_path))
        self.reference_audio = str(reference_audio)
        self.reference_text = reference_text
        self.lock = threading.Lock()

    def synthesize(self, text):
        with self.lock:
            result = next(self.model.generate(
                text,
                ref_audio=self.reference_audio,
                ref_text=self.reference_text,
                lang_code="Chinese",
                stream=False,
                max_tokens=1024,
            ))
        return wav_bytes(result.audio, int(result.sample_rate))

    def stream(self, text):
        with self.lock:
            resample_state = None
            source_sample_rate = None
            for result in self.model.generate(
                text,
                ref_audio=self.reference_audio,
                ref_text=self.reference_text,
                lang_code="Chinese",
                stream=True,
                streaming_interval=STREAMING_INTERVAL_SECONDS,
                temperature=0.65,
                top_p=0.9,
                max_tokens=1_024,
            ):
                current_sample_rate = int(result.sample_rate)
                pcm = pcm16_bytes(result.audio)
                if current_sample_rate != TARGET_SAMPLE_RATE:
                    if source_sample_rate not in (None, current_sample_rate):
                        resample_state = None
                    pcm, resample_state = audioop.ratecv(
                        pcm,
                        2,
                        1,
                        current_sample_rate,
                        TARGET_SAMPLE_RATE,
                        resample_state,
                    )
                source_sample_rate = current_sample_rate
                if pcm:
                    yield pcm

    def warm(self):
        self.synthesize(WARMUP_TEXT)


def create_handler(engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):
            return

        def send_json(self, status, body):
            encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            if self.path != "/health":
                self.send_json(404, {"ok": False, "error": "not found"})
                return
            self.send_json(200, {"ok": True, "sampleRate": TARGET_SAMPLE_RATE})

        def do_POST(self):
            if self.path != "/v1/speech":
                self.send_json(404, {"ok": False, "error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length < 1 or length > 2_048:
                self.send_json(400, {"ok": False, "error": "invalid request body"})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                text = str(payload.get("text", "")).strip()
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(400, {"ok": False, "error": "invalid JSON"})
                return
            if not text or len(text.encode("utf-8")) > MAX_TEXT_BYTES:
                self.send_json(400, {"ok": False, "error": "invalid text"})
                return
            if payload.get("stream") is True:
                self.stream_audio(text)
                return
            try:
                audio = engine.synthesize(text)
            except Exception as error:  # The Node bridge falls back to macOS TTS.
                self.send_json(500, {"ok": False, "error": str(error)[:240]})
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)

        def stream_audio(self, text):
            try:
                audio_stream = engine.stream(text)
                first = next(audio_stream)
            except StopIteration:
                self.send_json(500, {"ok": False, "error": "empty local speech stream"})
                return
            except Exception as error:
                self.send_json(500, {"ok": False, "error": str(error)[:240]})
                return
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/x-codex-pcm; format=s16le; rate=16000",
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                self.write_stream_chunk(first)
                for audio in audio_stream:
                    self.write_stream_chunk(audio)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

        def write_stream_chunk(self, audio):
            if not audio or len(audio) % 2:
                raise ValueError("invalid local speech stream chunk")
            self.wfile.write(f"{len(audio):X}\r\n".encode("ascii"))
            self.wfile.write(audio)
            self.wfile.write(b"\r\n")
            self.wfile.flush()

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--reference-audio", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4320)
    args = parser.parse_args()

    model_path = Path(args.model)
    reference_audio = Path(args.reference_audio)
    if not model_path.is_dir() or not reference_audio.is_file():
        raise SystemExit("本地神经语音模型或参考音频未准备好")
    engine = VoiceEngine(model_path, reference_audio, parse_profile(args.profile))
    engine.warm()
    server = ThreadingHTTPServer((args.host, args.port), create_handler(engine))
    server.serve_forever()


if __name__ == "__main__":
    main()
