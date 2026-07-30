#include "codex_core/voice_activity.hpp"

#include <algorithm>
#include <cstdint>

namespace codex {

void VoiceActivityDetector::begin(
    const std::uint64_t now_ms,
    const std::uint32_t maximum_duration_ms) {
  started_at_ = now_ms;
  last_speech_at_ = now_ms;
  maximum_duration_ms_ = std::clamp<std::uint32_t>(
      maximum_duration_ms,
      5'000,
      60'000);
  heard_speech_ = false;
}

VoiceActivityResult VoiceActivityDetector::observe(
    const std::int16_t* samples,
    const std::size_t sample_count,
    const std::uint64_t now_ms) {
  std::uint64_t level_sum = 0;
  if (samples != nullptr) {
    for (std::size_t index = 0; index < sample_count; ++index) {
      const auto sample = static_cast<std::int32_t>(samples[index]);
      level_sum += static_cast<std::uint32_t>(sample < 0 ? -sample : sample);
    }
  }
  const auto average_level = sample_count == 0
      ? 0U
      : static_cast<std::uint32_t>(level_sum / sample_count);
  if (average_level >= kSpeechLevelThreshold) {
    heard_speech_ = true;
    last_speech_at_ = now_ms;
  }

  if (
      heard_speech_ &&
      now_ms >= last_speech_at_ &&
      now_ms - last_speech_at_ >= kSilenceDurationMs) {
    return VoiceActivityResult::SpeechEnded;
  }
  if (
      now_ms >= started_at_ &&
      now_ms - started_at_ >= maximum_duration_ms_) {
    return heard_speech_
        ? VoiceActivityResult::SpeechTimeout
        : VoiceActivityResult::NoSpeechTimeout;
  }
  return VoiceActivityResult::Listening;
}

}  // namespace codex
