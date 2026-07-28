#pragma once

#include <cstdint>
#include <string>

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

struct InputLayout {
  Rect pet_area;
  Rect decline_button;
  Rect accept_button;
  Point pet_center;
  std::int16_t swipe_distance = 40;
};

inline constexpr InputLayout kCompactInputLayout{
    {0, 25, 320, 156},
    {14, 162, 112, 40},
    {134, 162, 172, 40},
    {160, 94},
    40,
};

class InputController {
 public:
  explicit InputController(InputLayout layout = kCompactInputLayout);
  void setLayout(InputLayout layout);
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

  static constexpr std::uint64_t kMinimumApprovalPressMs = 80;
  static constexpr std::uint64_t kMaximumApprovalPressMs = 1'500;
  static constexpr std::uint64_t kApprovalCooldownMs = 800;

  InputLayout layout_;
  PressTarget press_target_ = PressTarget::None;
  Point press_point_{};
  std::uint64_t pressed_at_ = 0;
  std::uint64_t approval_cooldown_until_ = 0;
};

class PetSelectionGuard {
 public:
  bool accept(
      const std::string& current_id,
      const std::string& target_id,
      int offset,
      std::uint64_t now_ms);

 private:
  static constexpr std::uint64_t kRepeatWindowMs = 6'000;

  std::string previous_id_;
  int last_offset_ = 0;
  std::uint64_t last_action_at_ = 0;
};

}  // namespace codex
