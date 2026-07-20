#include "codex_core/types.hpp"

#include <array>
#include <utility>

namespace codex {
namespace {

constexpr std::array<std::pair<const char*, Animation>, 9> kAnimations{{
    {"idle", Animation::Idle},
    {"running-right", Animation::RunningRight},
    {"running-left", Animation::RunningLeft},
    {"waving", Animation::Waving},
    {"jumping", Animation::Jumping},
    {"failed", Animation::Failed},
    {"waiting", Animation::Waiting},
    {"running", Animation::Running},
    {"review", Animation::Review},
}};

constexpr std::array<std::pair<const char*, PresentationState>, 6> kStates{{
    {"ready", PresentationState::Ready},
    {"running", PresentationState::Running},
    {"needs-input", PresentationState::NeedsInput},
    {"reviewing", PresentationState::Reviewing},
    {"completed", PresentationState::Completed},
    {"blocked", PresentationState::Blocked},
}};

}  // namespace

const char* animationName(const Animation animation) {
  for (const auto& entry : kAnimations) {
    if (entry.second == animation) {
      return entry.first;
    }
  }
  return "idle";
}

const char* stateName(const PresentationState state) {
  for (const auto& entry : kStates) {
    if (entry.second == state) {
      return entry.first;
    }
  }
  return "ready";
}

bool parseAnimation(const std::string& value, Animation& animation) {
  for (const auto& entry : kAnimations) {
    if (value == entry.first) {
      animation = entry.second;
      return true;
    }
  }
  return false;
}

bool parsePresentationState(const std::string& value, PresentationState& state) {
  for (const auto& entry : kStates) {
    if (value == entry.first) {
      state = entry.second;
      return true;
    }
  }
  return false;
}

}  // namespace codex
