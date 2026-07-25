#include "tab5_ui.hpp"

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
constexpr std::int16_t kKeyX = 330;
constexpr std::int16_t kKeyY = 204;
constexpr std::int16_t kKeyWidth = 208;
constexpr std::int16_t kKeyHeight = 88;

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

std::size_t utf8CharacterLength(const char value) {
  const auto byte = static_cast<std::uint8_t>(value);
  if ((byte & 0x80U) == 0U) return 1;
  if ((byte & 0xe0U) == 0xc0U) return 2;
  if ((byte & 0xf0U) == 0xe0U) return 3;
  if ((byte & 0xf8U) == 0xf0U) return 4;
  return 1;
}

}  // namespace

bool Tab5Ui::begin(
    PetStore& pet_store,
    const String& device_id,
    const String& setup_code) {
  pet_store_ = &pet_store;
  device_id_ = device_id;
  setup_code_ = setup_code;
  canvas_.setPsram(true);
  if (canvas_.createSprite(kScreenWidth, kScreenHeight) == nullptr) return false;
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

UiAction Tab5Ui::poll(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired) {
  return pollTouch(snapshot, now_ms, paired);
}

void Tab5Ui::render(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired,
    const String& connection_detail,
    const std::uint8_t transfer_progress) {
  if (!paired) {
    if (pairing_screen_rendered_ &&
        rendered_pairing_code_ == pairing_code_ &&
        rendered_connection_detail_ == connection_detail) {
      return;
    }
  } else if (now_ms - last_rendered_at_ < 50) {
    return;
  }
  last_rendered_at_ = now_ms;
  canvas_.fillScreen(kBackground);
  if (paired) {
    pairing_screen_rendered_ = false;
    drawNormal(snapshot, now_ms, connection_detail, transfer_progress);
  } else {
    drawPairing(connection_detail);
    pairing_screen_rendered_ = true;
    rendered_pairing_code_ = pairing_code_;
    rendered_connection_detail_ = connection_detail;
  }
  canvas_.pushSprite(0, 0);
}

bool Tab5Ui::approvalCanAccept(const Approval& approval) const {
  if (!approval.present || !approval.safe_to_approve || approval.detail.empty() ||
      approval.detail.size() > 96) return false;
  return std::count(approval.detail.begin(), approval.detail.end(), '\n') <= 2;
}

UiAction Tab5Ui::pollTouch(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const bool paired) {
  const auto count = M5.Touch.getCount();
  if (count > 0) {
    const auto detail = M5.Touch.getDetail(0);
    const Point point{
        static_cast<std::int16_t>(std::clamp<std::int32_t>(detail.x, 0, kScreenWidth - 1)),
        static_cast<std::int16_t>(std::clamp<std::int32_t>(detail.y, 0, kScreenHeight - 1)),
    };
    last_touch_ = point;
    // M5Unified keeps a released point in getCount() for one update with a
    // touch_end state. Handle that release directly instead of waiting for a
    // later zero-count update, which can lose short taps on Tab5.
    const auto released = detail.wasReleased();
    const auto phase = released
                           ? TouchPhase::Released
                           : (touch_active_ ? TouchPhase::Moved
                                            : TouchPhase::Pressed);
    touch_active_ = !released;
    if (!paired) return pairingTouch(point, phase);
    const auto safe = approvalCanAccept(snapshot.approval);
    if (released && !snapshot.approval.present) {
      if (kPreviousPetButton.contains(point)) {
        input_.cancel();
        return {UiActionType::PreviousPet, {}};
      }
      if (kNextPetButton.contains(point)) {
        input_.cancel();
        return {UiActionType::NextPet, {}};
      }
    }
    return mapInputAction(input_.onTouch(
        phase, point, now_ms, snapshot.approval.present, safe));
  }
  if (!touch_active_) return {};
  touch_active_ = false;
  if (!paired) return pairingTouch(last_touch_, TouchPhase::Released);
  const auto safe = approvalCanAccept(snapshot.approval);
  if (!snapshot.approval.present) {
    if (kPreviousPetButton.contains(last_touch_)) {
      input_.cancel();
      return {UiActionType::PreviousPet, {}};
    }
    if (kNextPetButton.contains(last_touch_)) {
      input_.cancel();
      return {UiActionType::NextPet, {}};
    }
  }
  return mapInputAction(input_.onTouch(
      TouchPhase::Released,
      last_touch_,
      now_ms,
      snapshot.approval.present,
      safe));
}

UiAction Tab5Ui::mapInputAction(const InputAction& action) {
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

UiAction Tab5Ui::pairingTouch(const Point point, const TouchPhase phase) {
  // Pairing keys are harmless and should react at the initial contact point.
  // Waiting for release makes short taps easy to lose during a full-screen
  // update and allows finger drift to select a neighboring key.
  if (phase != TouchPhase::Pressed || point.y < kKeyY ||
      point.y >= kKeyY + kKeyHeight * 4 || point.x < kKeyX ||
      point.x >= kKeyX + kKeyWidth * 3) {
    return {};
  }
  const auto column = (point.x - kKeyX) / kKeyWidth;
  const auto row = (point.y - kKeyY) / kKeyHeight;
  if (row < 3) {
    if (pairing_code_.length() < 6) {
      pairing_code_ += static_cast<char>('1' + row * 3 + column);
    }
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

void Tab5Ui::drawNormal(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const String& connection_detail,
    const std::uint8_t transfer_progress) {
  drawStatus(snapshot, connection_detail);
  if (snapshot.approval.present) {
    drawApproval(snapshot.approval);
    return;
  }

  canvas_.fillRoundRect(kPetArea.x, kPetArea.y, kPetArea.width, kPetArea.height, 20, kPanel);
  drawPet(snapshot, now_ms);

  canvas_.fillRoundRect(540, 104, 680, 184, 18, kPanel);
  canvas_.setTextColor(kMuted, kPanel);
  canvas_.setTextSize(1);
  canvas_.drawString("最近运行", 568, 130);
  canvas_.setTextColor(kText, kPanel);
  canvas_.setTextSize(2);
  drawTruncated(String(snapshot.task_title.c_str()), 568, 164, 620);
  canvas_.setTextSize(1);
  canvas_.setTextColor(stateColor(snapshot.state), kPanel);
  canvas_.drawString(stateLabel(snapshot.state), 568, 236);

  canvas_.fillRoundRect(540, 320, 680, 194, 18, kPanel);
  canvas_.setTextColor(kMuted, kPanel);
  canvas_.drawString("Codex 进度", 568, 348);
  canvas_.setTextColor(kText, kPanel);
  canvas_.setTextSize(2);
  canvas_.drawString("Lv." + String(snapshot.tokens.level), 568, 382);
  canvas_.setTextSize(1);
  canvas_.drawString(String(snapshot.tokens.total) + " tokens", 568, 434);
  const auto target = std::max<std::uint32_t>(snapshot.tokens.target, 1);
  const auto current = std::min(snapshot.tokens.current, target);
  canvas_.drawRoundRect(800, 398, 370, 18, 9, kMuted);
  canvas_.fillRoundRect(802, 400, 366 * current / target, 14, 7, kBlue);
  if (transfer_progress > 0 && transfer_progress < 100) {
    canvas_.setTextColor(kMuted, kPanel);
    canvas_.drawString("Pet 同步 " + String(transfer_progress) + "%", 800, 444);
  }

  canvas_.fillRoundRect(
      kPreviousPetButton.x, kPreviousPetButton.y,
      kPreviousPetButton.width, kPreviousPetButton.height, 14, kPanelLight);
  canvas_.fillRoundRect(
      kNextPetButton.x, kNextPetButton.y,
      kNextPetButton.width, kNextPetButton.height, 14, kPanelLight);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextColor(kText, kPanelLight);
  canvas_.setTextSize(2);
  canvas_.drawString("‹ 上一个", kPreviousPetButton.x + kPreviousPetButton.width / 2,
                     kPreviousPetButton.y + kPreviousPetButton.height / 2);
  canvas_.drawString("下一个 ›", kNextPetButton.x + kNextPetButton.width / 2,
                     kNextPetButton.y + kNextPetButton.height / 2);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawPairing(const String& connection_detail) {
  canvas_.setTextDatum(top_center);
  canvas_.setTextColor(kText, kBackground);
  canvas_.setTextSize(3);
  canvas_.drawString("Codex Desk 配对", kScreenWidth / 2, 52);
  canvas_.setTextSize(1);
  canvas_.setTextColor(kMuted, kBackground);
  canvas_.drawString("先用 USB-C 数据线连接电脑，在电脑端生成 6 位配对码", kScreenWidth / 2, 118);
  canvas_.fillRoundRect(430, 150, 420, 48, 12, kPanel);
  canvas_.setTextColor(kOrange, kPanel);
  canvas_.setTextSize(2);
  canvas_.drawString(pairing_code_, kScreenWidth / 2, 160);
  static constexpr const char* keys[12] = {
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "清空", "0", "确定"};
  for (int row = 0; row < 4; ++row) {
    for (int column = 0; column < 3; ++column) {
      const auto x = kKeyX + column * kKeyWidth;
      const auto y = kKeyY + row * kKeyHeight;
      canvas_.fillRoundRect(x + 5, y + 5, kKeyWidth - 10, kKeyHeight - 10, 12, kPanelLight);
      canvas_.setTextColor(kText, kPanelLight);
      canvas_.setTextSize(2);
      canvas_.drawString(keys[row * 3 + column], x + kKeyWidth / 2, y + 26);
    }
  }
  canvas_.setTextColor(kMuted, kBackground);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(bottom_center);
  canvas_.drawString("设备 " + device_id_ + " · Wi-Fi 在 USB 配对后由电脑端设置", kScreenWidth / 2, 680);
  if (!connection_detail.isEmpty()) drawTruncated(connection_detail, 120, 636, 1040);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawPet(const Snapshot& snapshot, const std::uint64_t now_ms) {
  const auto index = frameIndex(snapshot, now_ms);
  String error;
  const auto custom = snapshot.selected_pet_id != "codex-core" && pet_store_ != nullptr &&
      pet_store_->loadFrame(
          snapshot.selected_pet_id.c_str(), index, frame_pixels_,
          static_cast<std::size_t>(kPetFrameWidth) * kPetFrameHeight, error);
  if (custom) {
    canvas_.pushImage(80, 144, kPetFrameWidth, kPetFrameHeight, frame_pixels_, kPetTransparentColor);
  } else {
    drawFallbackPet(snapshot.animation, index % 8);
  }
}

void Tab5Ui::drawFallbackPet(const Animation animation, const std::uint8_t frame) {
  const auto bob = static_cast<std::int16_t>(
      (animation == Animation::Jumping ? -42 : 0) + (frame % 2 == 0 ? 0 : -8));
  const auto cx = 272;
  const auto cy = 352 + bob;
  canvas_.fillCircle(cx, cy, 128, kPanelLight);
  canvas_.fillTriangle(cx - 106, cy - 78, cx - 54, cy - 164, cx - 12, cy - 104, kPanelLight);
  canvas_.fillTriangle(cx + 106, cy - 78, cx + 54, cy - 164, cx + 12, cy - 104, kPanelLight);
  const auto eye_dx = look_until_ > millis()
      ? static_cast<std::int16_t>(std::cos(look_degrees_ * 3.14159265F / 180.0F) * 12)
      : 0;
  const auto eye_dy = look_until_ > millis()
      ? static_cast<std::int16_t>(std::sin(look_degrees_ * 3.14159265F / 180.0F) * 12)
      : 0;
  canvas_.fillCircle(cx - 48 + eye_dx, cy - 16 + eye_dy, 14, kText);
  canvas_.fillCircle(cx + 48 + eye_dx, cy - 16 + eye_dy, 14, kText);
  if (animation == Animation::Failed) {
    canvas_.drawLine(cx - 26, cy + 58, cx + 26, cy + 40, kRed);
  } else {
    canvas_.drawArc(cx, cy + 30, 42, 31, 20, 160, kGreen);
  }
  canvas_.fillRoundRect(cx - 120, cy + 116, 240, 54, 26, kPanelLight);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextColor(
      stateColor(animation == Animation::Failed ? PresentationState::Blocked : PresentationState::Ready),
      kPanelLight);
  canvas_.setTextSize(2);
  canvas_.drawString("CODEX", cx, cy + 143);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawApproval(const Approval& approval) {
  canvas_.fillRoundRect(48, 100, 1184, 584, 22, kPanel);
  canvas_.setTextColor(kOrange, kPanel);
  canvas_.setTextSize(2);
  canvas_.drawString(String(approval.title.c_str()), 88, 140);
  canvas_.setTextSize(1);
  canvas_.setTextColor(kText, kPanel);
  drawWrapped(String(approval.detail.c_str()), 88, 210, 1080, 2, 38);
  canvas_.setTextColor(kMuted, kPanel);
  drawWrapped(String(approval.reason.c_str()), 88, 304, 1080, 2, 34);
  canvas_.fillRoundRect(
      kDeclineButton.x, kDeclineButton.y,
      kDeclineButton.width, kDeclineButton.height, 14, kPanelLight);
  const auto safe = approvalCanAccept(approval);
  canvas_.fillRoundRect(
      kAcceptButton.x, kAcceptButton.y,
      kAcceptButton.width, kAcceptButton.height, 14, safe ? kGreen : kPanelLight);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextSize(2);
  canvas_.setTextColor(kText, kPanelLight);
  canvas_.drawString("拒绝", kDeclineButton.x + kDeclineButton.width / 2,
                     kDeclineButton.y + kDeclineButton.height / 2);
  canvas_.setTextColor(safe ? kBackground : kMuted, safe ? kGreen : kPanelLight);
  canvas_.drawString(safe ? "仅允许本次" : "请在电脑确认",
                     kAcceptButton.x + kAcceptButton.width / 2,
                     kAcceptButton.y + kAcceptButton.height / 2);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawStatus(const Snapshot& snapshot, const String& connection_detail) {
  canvas_.fillRect(0, 0, kScreenWidth, 72, kPanel);
  canvas_.fillCircle(32, 36, 12, snapshot.bridge_connected ? kGreen : kRed);
  canvas_.setTextColor(stateColor(snapshot.state), kPanel);
  canvas_.setTextSize(2);
  canvas_.setTextDatum(middle_left);
  canvas_.drawString(stateLabel(snapshot.state), 62, 36);
  canvas_.setTextColor(kMuted, kPanel);
  canvas_.setTextSize(1);
  canvas_.drawString(connection_detail, 250, 36);
  std::time_t now = std::time(nullptr);
  std::tm local{};
  localtime_r(&now, &local);
  char time_text[8]{};
  if (now > 1'700'000'000) {
    snprintf(time_text, sizeof(time_text), "%02d:%02d", local.tm_hour, local.tm_min);
  } else {
    snprintf(time_text, sizeof(time_text), "--:--");
  }
  const auto battery = std::min<std::uint8_t>(snapshot.telemetry.battery_percent, 100);
  canvas_.setTextDatum(middle_right);
  canvas_.drawString(String(battery) + "%  " + time_text, 1240, 36);
  canvas_.setTextDatum(top_left);
  canvas_.setTextSize(1);
}

void Tab5Ui::drawTruncated(
    const String& text,
    const std::int16_t x,
    const std::int16_t y,
    const std::int16_t width) {
  canvas_.setClipRect(x, y, width, canvas_.fontHeight());
  canvas_.drawString(text, x, y);
  canvas_.clearClipRect();
}

void Tab5Ui::drawWrapped(
    const String& text,
    const std::int16_t x,
    std::int16_t y,
    const std::int16_t width,
    const std::uint8_t maximum_lines,
    const std::int16_t line_height) {
  String line;
  std::uint8_t line_count = 0;
  for (std::size_t index = 0; index < text.length();) {
    const auto bytes = std::min(utf8CharacterLength(text[index]), text.length() - index);
    const auto character = text.substring(index, index + bytes);
    index += bytes;
    if (character == "\n") {
      canvas_.drawString(line, x, y);
      line = "";
      y += line_height;
      if (++line_count >= maximum_lines) return;
      continue;
    }
    const auto candidate = line + character;
    if (!line.isEmpty() && canvas_.textWidth(candidate) > width) {
      canvas_.drawString(line, x, y);
      line = character;
      y += line_height;
      if (++line_count >= maximum_lines) return;
    } else {
      line = candidate;
    }
  }
  if (!line.isEmpty() && line_count < maximum_lines) {
    canvas_.drawString(line, x, y);
  }
}

std::uint8_t Tab5Ui::frameIndex(
    const Snapshot& snapshot,
    const std::uint64_t now_ms) {
  if (look_until_ > now_ms && !snapshot.pets.empty()) {
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
