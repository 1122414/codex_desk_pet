#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "codex_core/types.hpp"

namespace codex {

struct AnimationSpec {
  std::uint8_t row = 0;
  std::uint8_t frame_count = 0;
  std::array<std::uint16_t, 8> durations_ms{};
};

const AnimationSpec& animationSpec(Animation animation);
std::uint8_t lookDirectionIndex(float degrees);
float lookDirectionDegrees(std::uint8_t index);

class AnimationPlayer {
 public:
  void set(Animation animation, std::uint64_t now_ms);
  std::uint8_t frame(std::uint64_t now_ms);
  Animation animation() const;

 private:
  Animation animation_ = Animation::Idle;
  std::uint8_t frame_ = 0;
  std::uint64_t frame_started_at_ = 0;
};

}  // namespace codex
