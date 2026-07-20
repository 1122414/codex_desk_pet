#include "codex_core/input.hpp"

#include <cmath>

#include "codex_core/animation.hpp"

namespace codex {

bool Rect::contains(const Point point) const {
  return point.x >= x && point.y >= y && point.x < x + width &&
         point.y < y + height;
}

InputAction InputController::onTouch(
    const TouchPhase phase,
    const Point point,
    const std::uint64_t now_ms,
    const bool approval_visible,
    const bool approval_safe) {
  if (phase == TouchPhase::Cancelled) {
    cancel();
    return {};
  }

  if (phase == TouchPhase::Pressed) {
    press_point_ = point;
    pressed_at_ = now_ms;
    if (approval_visible && kDeclineButton.contains(point)) {
      press_target_ = PressTarget::Decline;
    } else if (approval_visible && approval_safe &&
               kAcceptButton.contains(point)) {
      press_target_ = PressTarget::Accept;
    } else if (!approval_visible && kPetArea.contains(point)) {
      press_target_ = PressTarget::Pet;
    } else {
      press_target_ = PressTarget::None;
    }
    return {};
  }

  if (phase != TouchPhase::Released || press_target_ == PressTarget::None) {
    return {};
  }

  const auto target = press_target_;
  press_target_ = PressTarget::None;
  const auto elapsed = now_ms >= pressed_at_ ? now_ms - pressed_at_ : 0;

  if (target == PressTarget::Accept || target == PressTarget::Decline) {
    const auto same_target =
        target == PressTarget::Accept ? kAcceptButton.contains(point)
                                      : kDeclineButton.contains(point);
    if (!same_target || elapsed < kMinimumApprovalPressMs ||
        elapsed > kMaximumApprovalPressMs ||
        now_ms < approval_cooldown_until_) {
      return {};
    }
    approval_cooldown_until_ = now_ms + kApprovalCooldownMs;
    return {
        target == PressTarget::Accept ? ActionType::AcceptApproval
                                      : ActionType::DeclineApproval,
        0.0F,
    };
  }

  const auto dx = static_cast<std::int16_t>(point.x - press_point_.x);
  const auto dy = static_cast<std::int16_t>(point.y - press_point_.y);
  if (std::abs(dx) >= kSwipeDistance && std::abs(dx) > std::abs(dy)) {
    return {dx < 0 ? ActionType::NextPet : ActionType::PreviousPet, 0.0F};
  }

  constexpr float kPi = 3.14159265358979323846F;
  const auto radians = std::atan2(
      static_cast<float>(point.y - 94),
      static_cast<float>(point.x - 160));
  auto degrees = radians * 180.0F / kPi;
  if (degrees < 0.0F) {
    degrees += 360.0F;
  }
  return {ActionType::LookAt, lookDirectionDegrees(lookDirectionIndex(degrees))};
}

InputAction InputController::onButton(
    const ButtonId button,
    const bool approval_visible,
    const bool approval_safe) {
  if (approval_visible) {
    if (button == ButtonId::Left) {
      return {ActionType::DeclineApproval, 0.0F};
    }
    return {
        approval_safe ? ActionType::AcceptApproval : ActionType::None,
        0.0F,
    };
  }
  return {
      button == ButtonId::Left ? ActionType::PreviousPet
                               : ActionType::NextPet,
      0.0F,
  };
}

void InputController::cancel() {
  press_target_ = PressTarget::None;
  pressed_at_ = 0;
}

}  // namespace codex
