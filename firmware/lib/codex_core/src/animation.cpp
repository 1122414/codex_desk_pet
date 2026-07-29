#include "codex_core/animation.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace codex {
namespace {

constexpr std::array<AnimationSpec, 9> kSpecs{{
    {0, 6, {2500, 220, 220, 300, 300, 2500, 0, 0}},
    {1, 8, {240, 240, 240, 240, 240, 240, 240, 1200}},
    {2, 8, {240, 240, 240, 240, 240, 240, 240, 1200}},
    {3, 4, {300, 300, 300, 1500, 0, 0, 0, 0}},
    {4, 5, {300, 300, 300, 300, 1500, 0, 0, 0}},
    {5, 8, {320, 320, 320, 320, 320, 320, 320, 1800}},
    {6, 6, {400, 400, 400, 400, 400, 1800, 0, 0}},
    {7, 6, {240, 240, 240, 240, 240, 1200, 0, 0}},
    {8, 6, {350, 350, 350, 350, 350, 1600, 0, 0}},
}};

std::size_t animationIndex(const Animation animation) {
  const auto index = static_cast<std::size_t>(animation);
  if (index >= kSpecs.size()) {
    throw std::out_of_range("Unknown animation");
  }
  return index;
}

}  // namespace

const AnimationSpec& animationSpec(const Animation animation) {
  return kSpecs[animationIndex(animation)];
}

std::uint8_t lookDirectionIndex(const float degrees) {
  if (!std::isfinite(degrees)) {
    return 0;
  }
  auto normalized = std::fmod(degrees, 360.0F);
  if (normalized < 0.0F) {
    normalized += 360.0F;
  }
  return static_cast<std::uint8_t>(
      static_cast<int>(std::lround(normalized / 22.5F)) % 16);
}

float lookDirectionDegrees(const std::uint8_t index) {
  return static_cast<float>(index % 16) * 22.5F;
}

void AnimationPlayer::set(const Animation animation, const std::uint64_t now_ms) {
  if (animation_ == animation) {
    return;
  }
  animation_ = animation;
  frame_ = 0;
  frame_started_at_ = now_ms;
}

std::uint8_t AnimationPlayer::frame(const std::uint64_t now_ms) {
  const auto& spec = animationSpec(animation_);
  if (frame_started_at_ == 0) {
    frame_started_at_ = now_ms;
  }
  while (
      now_ms >= frame_started_at_ &&
      now_ms - frame_started_at_ >= spec.durations_ms[frame_]) {
    frame_started_at_ += spec.durations_ms[frame_];
    frame_ = static_cast<std::uint8_t>((frame_ + 1) % spec.frame_count);
  }
  return frame_;
}

Animation AnimationPlayer::animation() const {
  return animation_;
}

}  // namespace codex
