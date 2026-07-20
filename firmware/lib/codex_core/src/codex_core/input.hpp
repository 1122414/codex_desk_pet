#pragma once

#include <cstdint>

namespace codex {

struct Point {
  std::int16_t x = 0;
  std::int16_t y = 0;
};

struct Rect {
  std::int16_t x = 0;
  std::int16_t y = 0;
  std::int16_t width = 0;
  std::int16_t height = 0;

  bool contains(Point point) const;
};

enum class TouchPhase : std::uint8_t {
  Pressed,
  Moved,
  Released,
  Cancelled,
};

enum class ButtonId : std::uint8_t {
  Left,
  Right,
};

enum class ActionType : std::uint8_t {
  None,
  PreviousPet,
  NextPet,
  LookAt,
  AcceptApproval,
  DeclineApproval,
};

struct InputAction {
  ActionType type = ActionType::None;
  float look_degrees = 0.0F;
};

class InputController {
 public:
  InputAction onTouch(
      TouchPhase phase,
      Point point,
      std::uint64_t now_ms,
      bool approval_visible,
      bool approval_safe);
  InputAction onButton(ButtonId button, bool approval_visible, bool approval_safe);
  void cancel();

 private:
  enum class PressTarget : std::uint8_t {
    None,
    Pet,
    Accept,
    Decline,
  };

  static constexpr Rect kPetArea{0, 25, 320, 156};
  static constexpr Rect kDeclineButton{14, 162, 112, 40};
  static constexpr Rect kAcceptButton{134, 162, 172, 40};
  static constexpr std::uint64_t kMinimumApprovalPressMs = 80;
  static constexpr std::uint64_t kMaximumApprovalPressMs = 1'500;
  static constexpr std::uint64_t kApprovalCooldownMs = 800;
  static constexpr std::int16_t kSwipeDistance = 40;

  PressTarget press_target_ = PressTarget::None;
  Point press_point_{};
  std::uint64_t pressed_at_ = 0;
  std::uint64_t approval_cooldown_until_ = 0;
};

}  // namespace codex
