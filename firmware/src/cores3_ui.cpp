#include "cores3_ui.hpp"

#include <esp_heap_caps.h>

#include <algorithm>
#include <cmath>
#include <ctime>

namespace codex::firmware {
namespace {

constexpr std::uint16_t kBackground = 0x0861;
constexpr std::uint16_t kPanel = 0x10e3;
constexpr std::uint16_t kPanelLight = 0x2145;
constexpr std::uint16_t kText = 0xef7d;
constexpr std::uint16_t kMuted = 0x8c71;
constexpr std::uint16_t kGreen = 0x4ee9;
constexpr std::uint16_t kOrange = 0xfd43;
constexpr std::uint16_t kRed = 0xf9e7;
constexpr std::uint16_t kBlue = 0x4d7f;

const char* stateLabel(const PresentationState state) {
  switch (state) {
    case PresentationState::Running: return "运行中";
    case PresentationState::NeedsInput: return "等待确认";
    case PresentationState::Reviewing: return "审查中";
    case PresentationState::Completed: return "已完成";
    case PresentationState::Blocked: return "遇到问题";
    case PresentationState::Ready: return "准备就绪";
  }
  return "准备就绪";
}

std::uint16_t stateColor(const PresentationState state) {
  switch (state) {
    case PresentationState::Completed: return kGreen;
    case PresentationState::NeedsInput:
    case PresentationState::Reviewing: return kOrange;
    case PresentationState::Blocked: return kRed;
    case PresentationState::Running: return kBlue;
    case PresentationState::Ready: return kMuted;
  }
  return kMuted;
}

}  // namespace

bool CoreS3Ui::begin(
    PetStore& pet_store,
    const String& device_id,
    const String& setup_code) {
  pet_store_ = &pet_store;
  device_id_ = device_id;
  setup_code_ = setup_code;
  pinMode(kLeftButtonPin, INPUT_PULLUP);
  pinMode(kRightButtonPin, INPUT_PULLUP);
  left_button_.stable = left_button_.observed = digitalRead(kLeftButtonPin);
  right_button_.stable = right_button_.observed = digitalRead(kRightButtonPin);
  canvas_.setPsram(true);
  if (canvas_.createSprite(320, 240) == nullptr) return false;
  canvas_.setFont(&fonts::efontCN_16);
  frame_pixels_ = static_cast<std::uint16_t*>(heap_caps_malloc(
      kPetFrameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (frame_pixels_ == nullptr) {
    frame_pixels_ = static_cast<std::uint16_t*>(malloc(kPetFrameBytes));
  }
  M5.Display.setBrightness(128);
  M5.Speaker.setVolume(96);
  return frame_pixels_ != nullptr;
}

UiAction CoreS3Ui::poll(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired) {
  if (const auto action = pollTouch(snapshot, now_ms, paired);
      action.type != UiActionType::None) return action;
  return pollButtons(snapshot, now_ms, paired);
}

void CoreS3Ui::render(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired,
    const String& connection_detail,
    const std::uint8_t transfer_progress) {
  if (now_ms - last_rendered_at_ < 40) return;
  last_rendered_at_ = now_ms;
  canvas_.fillScreen(kBackground);
  if (paired) drawNormal(snapshot, now_ms, connection_detail, transfer_progress);
  else drawPairing(connection_detail);
  canvas_.pushSprite(0, 0);
}

void CoreS3Ui::playStateCue(const PresentationState state) {
  switch (state) {
    case PresentationState::Running:
      M5.Speaker.tone(620, 90);
      break;
    case PresentationState::NeedsInput:
      M5.Speaker.tone(880, 120);
      delay(140);
      M5.Speaker.tone(880, 120);
      break;
    case PresentationState::Completed:
      M5.Speaker.tone(660, 80);
      delay(95);
      M5.Speaker.tone(880, 150);
      break;
    case PresentationState::Blocked:
      M5.Speaker.tone(260, 220);
      break;
    case PresentationState::Reviewing:
      M5.Speaker.tone(740, 100);
      break;
    case PresentationState::Ready:
      break;
  }
}

bool CoreS3Ui::approvalCanAccept(const Approval& approval) const {
  if (!approval.present || !approval.safe_to_approve || approval.detail.empty() ||
      approval.detail.size() > 96) return false;
  return std::count(approval.detail.begin(), approval.detail.end(), '\n') <= 2;
}

UiAction CoreS3Ui::pollTouch(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired) {
  const auto count = M5.Touch.getCount();
  if (count > 0) {
    const auto detail = M5.Touch.getDetail(0);
    const Point point{
        static_cast<std::int16_t>(std::clamp<std::int32_t>(detail.x, 0, 319)),
        static_cast<std::int16_t>(std::clamp<std::int32_t>(detail.y, 0, 239)),
    };
    last_touch_ = point;
    const auto phase = touch_active_ ? TouchPhase::Moved : TouchPhase::Pressed;
    touch_active_ = true;
    if (!paired) return pairingTouch(point, phase);
    const auto safe = approvalCanAccept(snapshot.approval);
    return mapInputAction(input_.onTouch(
        phase, point, now_ms, snapshot.approval.present, safe));
  }
  if (!touch_active_) return {};
  touch_active_ = false;
  if (!paired) return pairingTouch(last_touch_, TouchPhase::Released);
  const auto safe = approvalCanAccept(snapshot.approval);
  return mapInputAction(input_.onTouch(
      TouchPhase::Released,
      last_touch_,
      now_ms,
      snapshot.approval.present,
      safe));
}

UiAction CoreS3Ui::pollButtons(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired) {
  if (!paired) return {};
  const auto safe = approvalCanAccept(snapshot.approval);
  if (buttonPressed(left_button_, now_ms)) {
    return mapInputAction(input_.onButton(ButtonId::Left, snapshot.approval.present, safe));
  }
  if (buttonPressed(right_button_, now_ms)) {
    return mapInputAction(input_.onButton(ButtonId::Right, snapshot.approval.present, safe));
  }
  return {};
}

UiAction CoreS3Ui::mapInputAction(const InputAction& action) {
  switch (action.type) {
    case ActionType::PreviousPet: return {UiActionType::PreviousPet, {}};
    case ActionType::NextPet: return {UiActionType::NextPet, {}};
    case ActionType::AcceptApproval: return {UiActionType::AcceptApproval, {}};
    case ActionType::DeclineApproval: return {UiActionType::DeclineApproval, {}};
    case ActionType::LookAt:
      look_degrees_ = action.look_degrees;
      look_until_ = millis() + 850;
      return {};
    case ActionType::None: return {};
  }
  return {};
}

bool CoreS3Ui::buttonPressed(
    DebouncedButton& button,
    const std::uint64_t now_ms) {
  const auto current = static_cast<bool>(digitalRead(button.pin));
  if (current != button.observed) {
    button.observed = current;
    button.changed_at = now_ms;
  }
  if (current == button.stable || now_ms - button.changed_at < kDebounceMs) return false;
  button.stable = current;
  return !current;
}

UiAction CoreS3Ui::pairingTouch(const Point point, const TouchPhase phase) {
  if (phase != TouchPhase::Released || point.y < 70 || point.y >= 230) return {};
  const auto column = std::clamp((point.x - 43) / 78, 0, 2);
  const auto row = std::clamp((point.y - 70) / 40, 0, 3);
  if (point.x < 43 || point.x >= 277) return {};
  if (row < 3) {
    if (pairing_code_.length() < 6) pairing_code_ += static_cast<char>('1' + row * 3 + column);
    return {};
  }
  if (column == 0) {
    pairing_code_ = "";
  } else if (column == 1) {
    if (pairing_code_.length() < 6) pairing_code_ += '0';
  } else if (pairing_code_.length() == 6) {
    const auto code = pairing_code_;
    pairing_code_ = "";
    return {UiActionType::SubmitPairingCode, code};
  }
  return {};
}

void CoreS3Ui::drawNormal(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const String& connection_detail,
    const std::uint8_t transfer_progress) {
  drawStatus(snapshot, connection_detail);
  if (snapshot.approval.present) {
    drawApproval(snapshot.approval);
    return;
  }
  drawPet(snapshot, now_ms);
  canvas_.fillRoundRect(8, 181, 304, 51, 8, kPanel);
  canvas_.setTextColor(kText, kPanel);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
  drawTruncated(String(snapshot.task_title.c_str()), 16, 187, 220);
  canvas_.setTextColor(kMuted, kPanel);
  canvas_.drawString(
      "Lv." + String(snapshot.tokens.level) + "  " + String(snapshot.tokens.total) + " tokens",
      16, 207);
  if (transfer_progress > 0 && transfer_progress < 100) {
    canvas_.drawRoundRect(240, 207, 60, 8, 4, kMuted);
    canvas_.fillRoundRect(241, 208, 58 * transfer_progress / 100, 6, 3, kBlue);
  }
  canvas_.fillTriangle(10, 206, 18, 198, 18, 214, kMuted);
  canvas_.fillTriangle(310, 206, 302, 198, 302, 214, kMuted);
}

void CoreS3Ui::drawPairing(const String& connection_detail) {
  canvas_.setTextDatum(top_center);
  canvas_.setTextColor(kText, kBackground);
  canvas_.setTextSize(1);
  canvas_.drawString("Codex Desk 配对", 160, 8);
  canvas_.setTextColor(kMuted, kBackground);
  canvas_.drawString("电脑生成6位配对码后在这里输入", 160, 26);
  canvas_.fillRoundRect(54, 43, 212, 24, 6, kPanel);
  canvas_.setTextColor(kOrange, kPanel);
  canvas_.drawString(pairing_code_, 160, 47);
  static constexpr const char* keys[12] = {
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "清空", "0", "确定"};
  for (int row = 0; row < 4; ++row) {
    for (int column = 0; column < 3; ++column) {
      const auto x = 43 + column * 78;
      const auto y = 70 + row * 40;
      canvas_.fillRoundRect(x + 2, y + 2, 74, 36, 5, kPanelLight);
      canvas_.setTextColor(kText, kPanelLight);
      canvas_.drawString(keys[row * 3 + column], x + 39, y + 10);
    }
  }
  canvas_.setTextColor(kMuted, kBackground);
  canvas_.setTextDatum(bottom_center);
  canvas_.drawString("配网码 " + setup_code_ + " · " + device_id_, 160, 239);
  canvas_.setTextDatum(top_left);
  if (!connection_detail.isEmpty()) drawTruncated(connection_detail, 8, 228, 304);
}

void CoreS3Ui::drawPet(const Snapshot& snapshot, const std::uint64_t now_ms) {
  const auto index = frameIndex(snapshot, now_ms);
  String error;
  const auto custom = snapshot.selected_pet_id != "codex-core" && pet_store_ != nullptr &&
      pet_store_->loadFrame(
          snapshot.selected_pet_id.c_str(), index, frame_pixels_,
          static_cast<std::size_t>(kPetFrameWidth) * kPetFrameHeight, error);
  if (custom) {
    canvas_.pushImage(88, 25, kPetFrameWidth, kPetFrameHeight, frame_pixels_, kPetTransparentColor);
  } else {
    drawFallbackPet(snapshot.animation, index % 8);
  }
}

void CoreS3Ui::drawFallbackPet(const Animation animation, const std::uint8_t frame) {
  const auto bob = static_cast<std::int16_t>(
      (animation == Animation::Jumping ? -12 : 0) + (frame % 2 == 0 ? 0 : -2));
  const auto cx = 160;
  const auto cy = 100 + bob;
  canvas_.fillCircle(cx, cy, 47, kPanelLight);
  canvas_.fillTriangle(cx - 39, cy - 28, cx - 19, cy - 62, cx - 4, cy - 39, kPanelLight);
  canvas_.fillTriangle(cx + 39, cy - 28, cx + 19, cy - 62, cx + 4, cy - 39, kPanelLight);
  const auto eye_dx = look_until_ > millis()
      ? static_cast<std::int16_t>(std::cos(look_degrees_ * 3.14159265F / 180.0F) * 4)
      : 0;
  const auto eye_dy = look_until_ > millis()
      ? static_cast<std::int16_t>(std::sin(look_degrees_ * 3.14159265F / 180.0F) * 4)
      : 0;
  canvas_.fillCircle(cx - 18 + eye_dx, cy - 6 + eye_dy, 5, kText);
  canvas_.fillCircle(cx + 18 + eye_dx, cy - 6 + eye_dy, 5, kText);
  if (animation == Animation::Failed) {
    canvas_.drawLine(cx - 8, cy + 21, cx + 8, cy + 15, kRed);
  } else {
    canvas_.drawArc(cx, cy + 12, 15, 11, 20, 160, kGreen);
  }
  canvas_.fillRoundRect(cx - 54, cy + 44, 108, 27, 12, kPanelLight);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextColor(stateColor(
      animation == Animation::Failed ? PresentationState::Blocked : PresentationState::Ready), kPanelLight);
  canvas_.drawString("CODEX", cx, cy + 57);
  canvas_.setTextDatum(top_left);
}

void CoreS3Ui::drawApproval(const Approval& approval) {
  canvas_.fillRoundRect(8, 27, 304, 205, 9, kPanel);
  canvas_.setTextColor(kOrange, kPanel);
  canvas_.setTextDatum(top_left);
  canvas_.drawString(String(approval.title.c_str()), 16, 35);
  canvas_.setTextColor(kText, kPanel);
  drawTruncated(String(approval.detail.c_str()), 16, 57, 286);
  canvas_.setTextColor(kMuted, kPanel);
  drawTruncated(String(approval.reason.c_str()), 16, 111, 286);
  canvas_.fillRoundRect(14, 162, 112, 40, 7, kPanelLight);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextColor(kText, kPanelLight);
  canvas_.drawString("拒绝", 70, 182);
  const auto safe = approvalCanAccept(approval);
  canvas_.fillRoundRect(134, 162, 172, 40, 7, safe ? kGreen : kPanelLight);
  canvas_.setTextColor(safe ? kBackground : kMuted, safe ? kGreen : kPanelLight);
  canvas_.drawString(safe ? "仅允许本次" : "请在电脑确认", 220, 182);
  canvas_.setTextDatum(top_left);
}

void CoreS3Ui::drawStatus(const Snapshot& snapshot, const String& connection_detail) {
  canvas_.fillRect(0, 0, 320, 24, kPanel);
  canvas_.fillCircle(9, 12, 4, snapshot.bridge_connected ? kGreen : kRed);
  canvas_.setTextColor(stateColor(snapshot.state), kPanel);
  canvas_.setTextDatum(middle_left);
  canvas_.drawString(stateLabel(snapshot.state), 18, 12);
  canvas_.setTextDatum(middle_right);
  std::time_t now = std::time(nullptr);
  std::tm local{};
  localtime_r(&now, &local);
  char time_text[8]{};
  if (now > 1'700'000'000) snprintf(time_text, sizeof(time_text), "%02d:%02d", local.tm_hour, local.tm_min);
  else snprintf(time_text, sizeof(time_text), "--:--");
  const auto battery = std::min<std::uint8_t>(snapshot.telemetry.battery_percent, 100);
  canvas_.setTextColor(kMuted, kPanel);
  canvas_.drawString(String(battery) + "%  " + time_text, 312, 12);
  canvas_.setTextDatum(top_left);
  (void)connection_detail;
}

void CoreS3Ui::drawTruncated(
    const String& text,
    const std::int16_t x,
    const std::int16_t y,
    const std::int16_t width) {
  canvas_.setClipRect(x, y, width, 38);
  canvas_.drawString(text, x, y);
  canvas_.clearClipRect();
}

std::uint8_t CoreS3Ui::frameIndex(
    const Snapshot& snapshot,
    const std::uint64_t now_ms) {
  if (look_until_ > now_ms && snapshot.pets.size() > 0) {
    const auto selected = std::find_if(
        snapshot.pets.begin(), snapshot.pets.end(),
        [&snapshot](const PetSummary& pet) { return pet.id == snapshot.selected_pet_id; });
    if (selected != snapshot.pets.end() && selected->sprite_version == 2) {
      return static_cast<std::uint8_t>(72 + lookDirectionIndex(look_degrees_));
    }
  }
  animation_player_.set(snapshot.animation, now_ms);
  const auto& spec = animationSpec(snapshot.animation);
  return static_cast<std::uint8_t>(spec.row * 8 + animation_player_.frame(now_ms));
}

}  // namespace codex::firmware
