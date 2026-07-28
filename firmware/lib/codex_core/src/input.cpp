#include "codex_core/input.hpp"

#include <cmath>

#include "codex_core/animation.hpp"

namespace codex {

bool Rect::contains(const Point point) const {
  return point.x >= x && point.y >= y && point.x < x + width &&
         point.y < y + height;
}

InputController::InputController(const InputLayout layout) : layout_(layout) {}

void InputController::setLayout(const InputLayout layout) {
  layout_ = layout;
  cancel();
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
    if (approval_visible && layout_.decline_button.contains(point)) {
      press_target_ = PressTarget::Decline;
    } else if (approval_visible && approval_safe &&
               layout_.accept_button.contains(point)) {
      press_target_ = PressTarget::Accept;
    } else if (!approval_visible && layout_.pet_area.contains(point)) {
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
        target == PressTarget::Accept ? layout_.accept_button.contains(point)
                                      : layout_.decline_button.contains(point);
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
  if (std::abs(dx) >= layout_.swipe_distance && std::abs(dx) > std::abs(dy)) {
    return {dx < 0 ? ActionType::NextPet : ActionType::PreviousPet, 0.0F};
  }

  constexpr float kPi = 3.14159265358979323846F;
  const auto radians = std::atan2(
      static_cast<float>(point.y - layout_.pet_center.y),
      static_cast<float>(point.x - layout_.pet_center.x));
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

bool PetSelectionGuard::accept(
    const std::string& current_id,
    const std::string& target_id,
    const int offset,
    const std::uint64_t now_ms) {
  if (current_id.empty() || target_id.empty() || offset == 0) return false;
  const auto within_repeat_window =
      last_action_at_ != 0 &&
      now_ms >= last_action_at_ &&
      now_ms - last_action_at_ < kRepeatWindowMs;
  if (
      within_repeat_window &&
      offset == last_offset_ &&
      target_id == previous_id_) {
    return false;
  }
  previous_id_ = current_id;
  last_offset_ = offset;
  last_action_at_ = now_ms;
  return true;
}

}  // namespace codex
