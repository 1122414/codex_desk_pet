#include "codex_core/audio.hpp"

namespace codex {
namespace {

constexpr AudioPlan kReady{
    "准备就绪",
    {{{520, 70, 0}, {}, {}}},
    1,
};
constexpr AudioPlan kRunning{
    "代码助手正在运行",
    {{{620, 90, 0}, {}, {}}},
    1,
};
constexpr AudioPlan kNeedsInput{
    "代码助手需要确认",
    {{{880, 120, 20}, {880, 120, 0}, {}}},
    2,
};
constexpr AudioPlan kReviewing{
    "代码助手正在审查",
    {{{740, 100, 0}, {}, {}}},
    1,
};
constexpr AudioPlan kCompleted{
    "任务已完成",
    {{{660, 80, 15}, {880, 150, 0}, {}}},
    2,
};
constexpr AudioPlan kBlocked{
    "任务遇到问题",
    {{{260, 220, 0}, {}, {}}},
    1,
};
constexpr AudioPlan kPetInstalled{
    "宠物已安装",
    {{{920, 120, 0}, {}, {}}},
    1,
};
constexpr AudioPlan kPetSwitched{
    "宠物已切换",
    {{{520, 60, 0}, {}, {}}},
    1,
};
constexpr AudioPlan kPairingSucceeded{
    "配对成功",
    {{{660, 70, 15}, {920, 130, 0}, {}}},
    2,
};

}  // namespace

AudioCue audioCueForState(const PresentationState state) {
  switch (state) {
    case PresentationState::Ready: return AudioCue::Ready;
    case PresentationState::Running: return AudioCue::Running;
    case PresentationState::NeedsInput: return AudioCue::NeedsInput;
    case PresentationState::Reviewing: return AudioCue::Reviewing;
    case PresentationState::Completed: return AudioCue::Completed;
    case PresentationState::Blocked: return AudioCue::Blocked;
  }
  return AudioCue::Ready;
}

const AudioPlan& audioPlan(const AudioCue cue) {
  switch (cue) {
    case AudioCue::Ready: return kReady;
    case AudioCue::Running: return kRunning;
    case AudioCue::NeedsInput: return kNeedsInput;
    case AudioCue::Reviewing: return kReviewing;
    case AudioCue::Completed: return kCompleted;
    case AudioCue::Blocked: return kBlocked;
    case AudioCue::PetInstalled: return kPetInstalled;
    case AudioCue::PetSwitched: return kPetSwitched;
    case AudioCue::PairingSucceeded: return kPairingSucceeded;
  }
  return kReady;
}

}  // namespace codex
