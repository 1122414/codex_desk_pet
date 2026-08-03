#pragma once

#include <M5Unified.h>

#include <array>
#include <cstdint>

#include "codex_core/voice_activity.hpp"
#include "device_protocol.hpp"

namespace codex::firmware {

enum class VoiceStopReason : std::uint8_t {
  None,
  Manual,
  SpeechComplete,
  NoSpeechTimeout,
  LinkError,
};

class DeviceVoice {
 public:
  bool start(
      DeviceProtocolClient& client,
      const String& mode,
      bool automatic_stop = false,
      std::uint8_t maximum_duration_seconds = 20);
  void poll();
  bool stop(VoiceStopReason reason = VoiceStopReason::Manual);
  bool recording() const { return recording_; }
  VoiceStopReason lastStopReason() const { return last_stop_reason_; }
  const String& mode() const { return mode_; }

 private:
  static constexpr std::uint32_t kSampleRate = 16'000;
  static constexpr std::size_t kSamplesPerChunk = 640;
  static constexpr std::uint32_t kChunkTimeoutMs = 1'500;

  bool beginChunk();
  bool sendCompletedChunk();

  DeviceProtocolClient* client_ = nullptr;
  String mode_;
  VoiceActivityDetector activity_;
  std::array<std::int16_t, kSamplesPerChunk> samples_{};
  bool recording_ = false;
  bool chunk_pending_ = false;
  bool automatic_stop_ = false;
  std::uint32_t recording_started_at_ms_ = 0;
  std::uint32_t maximum_duration_ms_ = 20'000;
  std::uint32_t chunk_started_at_ms_ = 0;
  VoiceStopReason last_stop_reason_ = VoiceStopReason::None;
};

}  // namespace codex::firmware
