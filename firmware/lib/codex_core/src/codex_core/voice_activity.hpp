#pragma once

#include <cstddef>
#include <cstdint>

namespace codex {

enum class VoiceActivityResult : std::uint8_t {
  Listening,
  SpeechEnded,
  NoSpeechTimeout,
  SpeechTimeout,
};

class VoiceActivityDetector {
 public:
  void begin(
      std::uint64_t now_ms,
      std::uint32_t maximum_duration_ms,
      std::uint32_t silence_duration_ms = kDefaultSilenceDurationMs);
  VoiceActivityResult observe(
      const std::int16_t* samples,
      std::size_t sample_count,
      std::uint64_t now_ms);
  bool heardSpeech() const { return heard_speech_; }

 private:
  static constexpr std::uint32_t kDefaultSilenceDurationMs = 2'500;
  static constexpr std::uint32_t kSpeechLevelThreshold = 500;

  std::uint64_t started_at_ = 0;
  std::uint64_t last_speech_at_ = 0;
  std::uint32_t maximum_duration_ms_ = 20'000;
  std::uint32_t silence_duration_ms_ = kDefaultSilenceDurationMs;
  bool heard_speech_ = false;
};

}  // namespace codex
