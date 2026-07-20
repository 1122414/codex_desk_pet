#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "codex_core/types.hpp"

namespace codex {

enum class AudioCue : std::uint8_t {
  Ready,
  Running,
  NeedsInput,
  Reviewing,
  Completed,
  Blocked,
  PetInstalled,
  PetSwitched,
  PairingSucceeded,
};

struct ToneStep {
  std::uint16_t frequency_hz = 0;
  std::uint16_t duration_ms = 0;
  std::uint16_t pause_ms = 0;
};

struct AudioPlan {
  const char* chinese_phrase = nullptr;
  std::array<ToneStep, 3> fallback_tones{};
  std::size_t tone_count = 0;
};

AudioCue audioCueForState(PresentationState state);
const AudioPlan& audioPlan(AudioCue cue);

}  // namespace codex
