#include "tab5_ui.hpp"

#include <esp_heap_caps.h>
#include <SPIFFS.h>

#include <algorithm>
#include <cmath>
#include <cstring>
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
constexpr std::int16_t kTaskRowHeight = 72;
constexpr std::uint8_t kVisibleTaskRows = 5;
constexpr std::uint16_t kBundledPetWidth = 192;
constexpr std::uint16_t kBundledPetHeight = 208;
constexpr std::size_t kBundledPetPixels =
    static_cast<std::size_t>(kBundledPetWidth) * kBundledPetHeight;

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

String compactNumber(const std::uint64_t value) {
  char text[24]{};
  if (value >= 1'000'000'000ULL) {
    snprintf(text, sizeof(text), "%.2fB", static_cast<double>(value) / 1'000'000'000.0);
  } else if (value >= 1'000'000ULL) {
    snprintf(text, sizeof(text), "%.2fM", static_cast<double>(value) / 1'000'000.0);
  } else if (value >= 1'000ULL) {
    snprintf(text, sizeof(text), "%.1fK", static_cast<double>(value) / 1'000.0);
  } else {
    snprintf(text, sizeof(text), "%llu", static_cast<unsigned long long>(value));
  }
  return String(text);
}

const char* shortStateLabel(const PresentationState state) {
  switch (state) {
    case PresentationState::Running: return "运行";
    case PresentationState::NeedsInput: return "待确认";
    case PresentationState::Reviewing: return "审查";
    case PresentationState::Completed: return "完成";
    case PresentationState::Blocked: return "阻塞";
    case PresentationState::Ready: return "最近";
  }
  return "最近";
}

}  // namespace

bool Tab5Ui::begin(
    PetStore& pet_store,
    const String& device_id,
    const String& setup_code) {
  pet_store_ = &pet_store;
  device_id_ = device_id;
  setup_code_ = setup_code;
  M5.Display.setFont(&fonts::efontCN_16);
  frame_pixels_ = static_cast<std::uint16_t*>(heap_caps_malloc(
      kPetFrameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (frame_pixels_ == nullptr) {
    frame_pixels_ = static_cast<std::uint16_t*>(malloc(kPetFrameBytes));
  }
  M5.Display.setBrightness(128);
  M5.Speaker.setVolume(48);
  bundled_pet_ready_ = SPIFFS.begin(false);
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
        rendered_connection_detail_ == connection_detail) {
      if (rendered_pairing_code_ != pairing_code_) {
        drawPairingCode();
        rendered_pairing_code_ = pairing_code_;
      }
      return;
    }
  } else if (now_ms - last_rendered_at_ < 100) {
    return;
  }
  last_rendered_at_ = now_ms;
  M5.Display.startWrite();
  M5.Display.fillScreen(kBackground);
  if (paired) {
    pairing_screen_rendered_ = false;
    drawNormal(snapshot, now_ms, connection_detail, transfer_progress);
  } else {
    drawPairing(connection_detail);
    pairing_screen_rendered_ = true;
    rendered_pairing_code_ = pairing_code_;
    rendered_connection_detail_ = connection_detail;
  }
  M5.Display.endWrite();
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
    const auto released = detail.wasReleased();
    const auto pressed = detail.wasPressed();
    const auto phase = released ? TouchPhase::Released
                                : (pressed ? TouchPhase::Pressed
                                           : TouchPhase::Moved);
    touch_active_ = !released;
    if (!paired) {
      if (released) {
        pairing_released_at_ = now_ms;
        return {};
      }
      if (!pressed) return {};
      if (pairing_touch_latched_) {
        if (pairing_released_at_ == 0 ||
            now_ms - pairing_released_at_ < 40) {
          return {};
        }
        pairing_touch_latched_ = false;
      }
      pairing_touch_latched_ = true;
      pairing_released_at_ = 0;
      return pairingTouch(point, phase);
    }
    if (!snapshot.approval.present) {
      const auto maximum_scroll = snapshot.tasks.size() > kVisibleTaskRows
          ? snapshot.tasks.size() - kVisibleTaskRows
          : 0;
      if (pressed && kTaskListArea.contains(point)) {
        input_.cancel();
        task_touch_active_ = true;
        task_touch_start_y_ = point.y;
        task_scroll_start_ = std::min<std::size_t>(
            task_scroll_offset_, maximum_scroll);
        return {};
      }
      if (task_touch_active_) {
        const auto delta = task_touch_start_y_ - point.y;
        const auto rows = delta >= 0
            ? (delta + kTaskRowHeight / 2) / kTaskRowHeight
            : -((-delta + kTaskRowHeight / 2) / kTaskRowHeight);
        task_scroll_offset_ = static_cast<std::uint8_t>(std::clamp<int>(
            static_cast<int>(task_scroll_start_) + rows,
            0,
            static_cast<int>(maximum_scroll)));
        if (released) task_touch_active_ = false;
        return {};
      }
    }
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
  if (!paired) {
    pairing_released_at_ = now_ms;
    return {};
  }
  if (task_touch_active_) {
    task_touch_active_ = false;
    return {};
  }
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

void Tab5Ui::drawPairingCode() {
  M5.Display.startWrite();
  M5.Display.setFont(&fonts::efontCN_16);
  M5.Display.setTextDatum(top_center);
  M5.Display.fillRoundRect(430, 150, 420, 48, 12, kPanel);
  M5.Display.setTextColor(kOrange, kPanel);
  M5.Display.setTextSize(2);
  M5.Display.drawString(pairing_code_, kScreenWidth / 2, 160);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
  M5.Display.endWrite();
}

void Tab5Ui::drawNormal(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const String& connection_detail,
    const std::uint8_t transfer_progress) {
  drawStatus(snapshot, now_ms, connection_detail);
  if (snapshot.approval.present) {
    drawApproval(snapshot.approval);
    return;
  }

  M5.Display.fillRoundRect(kPetArea.x, kPetArea.y, kPetArea.width, kPetArea.height, 20, kPanel);
  drawPet(snapshot, now_ms);
  drawQuota(snapshot);
  drawTokenSummary(snapshot);
  drawTaskList(snapshot, now_ms);

  M5.Display.fillRoundRect(
      kPreviousPetButton.x, kPreviousPetButton.y,
      kPreviousPetButton.width, kPreviousPetButton.height, 14, kPanelLight);
  M5.Display.fillRoundRect(
      kNextPetButton.x, kNextPetButton.y,
      kNextPetButton.width, kNextPetButton.height, 14, kPanelLight);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(kText, kPanelLight);
  drawChevron(kPreviousPetButton, false);
  drawChevron(kNextPetButton, true);
  M5.Display.setTextSize(1);
  M5.Display.drawString("切换宠物", 228, 660);
  if (transfer_progress > 0 && transfer_progress < 100) {
    M5.Display.setTextColor(kOrange, kPanel);
    M5.Display.drawString(
        "同步 " + String(transfer_progress) + "%",
        228,
        606);
  }
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
}

void Tab5Ui::drawPairing(const String& connection_detail) {
  M5.Display.setTextDatum(top_center);
  M5.Display.setTextColor(kText, kBackground);
  M5.Display.setTextSize(3);
  M5.Display.drawString("Codex Desk 配对", kScreenWidth / 2, 52);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(kMuted, kBackground);
  M5.Display.drawString("先用 USB-C 数据线连接电脑，在电脑端生成 6 位配对码", kScreenWidth / 2, 118);
  M5.Display.fillRoundRect(430, 150, 420, 48, 12, kPanel);
  M5.Display.setTextColor(kOrange, kPanel);
  M5.Display.setTextSize(2);
  M5.Display.drawString(pairing_code_, kScreenWidth / 2, 160);
  static constexpr const char* keys[12] = {
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "清空", "0", "确定"};
  for (int row = 0; row < 4; ++row) {
    for (int column = 0; column < 3; ++column) {
      const auto x = kKeyX + column * kKeyWidth;
      const auto y = kKeyY + row * kKeyHeight;
      M5.Display.fillRoundRect(x + 5, y + 5, kKeyWidth - 10, kKeyHeight - 10, 12, kPanelLight);
      M5.Display.setTextColor(kText, kPanelLight);
      M5.Display.setTextSize(2);
      M5.Display.drawString(keys[row * 3 + column], x + kKeyWidth / 2, y + 26);
    }
  }
  M5.Display.setTextColor(kMuted, kBackground);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(bottom_center);
  M5.Display.drawString("设备 " + device_id_ + " · Wi-Fi 在 USB 配对后由电脑端设置", kScreenWidth / 2, 680);
  if (!connection_detail.isEmpty()) drawTruncated(connection_detail, 120, 636, 1040);
  M5.Display.setTextDatum(top_left);
}

void Tab5Ui::drawPet(const Snapshot& snapshot, const std::uint64_t now_ms) {
  const auto index = frameIndex(snapshot, now_ms);
  String error;
  const auto custom = snapshot.selected_pet_id != "codex-core" && pet_store_ != nullptr &&
      pet_store_->loadFrame(
          snapshot.selected_pet_id.c_str(), index, frame_pixels_,
          static_cast<std::size_t>(kPetFrameWidth) * kPetFrameHeight, error);
  auto drawn = custom;
  if (drawn) {
    M5.Display.pushImage(36, 108, kPetFrameWidth, kPetFrameHeight, frame_pixels_, kPetTransparentColor);
  } else if (
      snapshot.selected_pet_id == "chibi-skadi" &&
      drawBundledPet(index)) {
    drawn = true;
  }
  if (!drawn) {
    drawFallbackPet(snapshot.animation, index % 8);
  }
  String pet_name(snapshot.selected_pet_id.c_str());
  const auto selected = std::find_if(
      snapshot.pets.begin(), snapshot.pets.end(),
      [&snapshot](const PetSummary& pet) { return pet.id == snapshot.selected_pet_id; });
  if (selected != snapshot.pets.end() && !selected->display_name.empty()) {
    pet_name = String(selected->display_name.c_str());
  }
  M5.Display.setTextColor(kText, kPanel);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
  drawTruncated(pet_name, 62, 546, 332);
  M5.Display.setTextColor(stateColor(snapshot.state), kPanel);
  M5.Display.setTextDatum(middle_center);
  M5.Display.drawString(stateLabel(snapshot.state), 228, 590);
  M5.Display.setTextDatum(top_left);
}

bool Tab5Ui::drawBundledPet(const std::uint8_t frame_index) {
  if (!bundled_pet_ready_) return false;
  const auto row = std::min<std::uint8_t>(frame_index / 8, 8);
  const auto variant = frame_index % 8 >= 4 ? 1 : 0;
  char path[40]{};
  snprintf(path, sizeof(path), "/bundled-pet/r%uf%u.rle", row, variant);
  if (bundled_pet_cached_path_ != path) {
    auto file = SPIFFS.open(path, FILE_READ);
    if (!file || file.size() < 12 || file.size() > 160 * 1024) return false;
    bundled_pet_buffer_.resize(file.size());
    const auto read = file.read(
        bundled_pet_buffer_.data(),
        bundled_pet_buffer_.size());
    file.close();
    if (read != bundled_pet_buffer_.size()) {
      bundled_pet_buffer_.clear();
      bundled_pet_cached_path_ = "";
      return false;
    }
    const auto* data = bundled_pet_buffer_.data();
    if (
        memcmp(data, "CPR1", 4) != 0 ||
        (static_cast<std::uint16_t>(data[4]) |
         (static_cast<std::uint16_t>(data[5]) << 8U)) != kBundledPetWidth ||
        (static_cast<std::uint16_t>(data[6]) |
         (static_cast<std::uint16_t>(data[7]) << 8U)) != kBundledPetHeight) {
      bundled_pet_buffer_.clear();
      bundled_pet_cached_path_ = "";
      return false;
    }
    std::size_t source_index = 0;
    std::size_t offset = 8;
    while (offset + 4 <= bundled_pet_buffer_.size()) {
      const auto length = static_cast<std::uint16_t>(data[offset]) |
          (static_cast<std::uint16_t>(data[offset + 1]) << 8U);
      const auto color = static_cast<std::uint16_t>(data[offset + 2]) |
          (static_cast<std::uint16_t>(data[offset + 3]) << 8U);
      if (length == 0 || source_index + length > kBundledPetPixels) {
        bundled_pet_cached_path_ = "";
        return false;
      }
      for (std::uint16_t index = 0; index < length; ++index, ++source_index) {
        const auto source_x = source_index % kBundledPetWidth;
        const auto source_y = source_index / kBundledPetWidth;
        const auto destination =
            (source_y * 2U * kPetFrameWidth) + source_x * 2U;
        frame_pixels_[destination] = color;
        frame_pixels_[destination + 1] = color;
        frame_pixels_[destination + kPetFrameWidth] = color;
        frame_pixels_[destination + kPetFrameWidth + 1] = color;
      }
      offset += 4;
    }
    if (
        source_index != kBundledPetPixels ||
        offset != bundled_pet_buffer_.size()) {
      bundled_pet_cached_path_ = "";
      return false;
    }
    bundled_pet_cached_path_ = path;
  }
  M5.Display.pushImage(
      36,
      108,
      kPetFrameWidth,
      kPetFrameHeight,
      frame_pixels_,
      kPetTransparentColor);
  return true;
}

void Tab5Ui::drawFallbackPet(const Animation animation, const std::uint8_t frame) {
  const auto bob = static_cast<std::int16_t>(
      (animation == Animation::Jumping ? -42 : 0) + (frame % 2 == 0 ? 0 : -8));
  const auto cx = 228;
  const auto cy = 320 + bob;
  M5.Display.fillCircle(cx, cy, 128, kPanelLight);
  M5.Display.fillTriangle(cx - 106, cy - 78, cx - 54, cy - 164, cx - 12, cy - 104, kPanelLight);
  M5.Display.fillTriangle(cx + 106, cy - 78, cx + 54, cy - 164, cx + 12, cy - 104, kPanelLight);
  const auto eye_dx = look_until_ > millis()
      ? static_cast<std::int16_t>(std::cos(look_degrees_ * 3.14159265F / 180.0F) * 12)
      : 0;
  const auto eye_dy = look_until_ > millis()
      ? static_cast<std::int16_t>(std::sin(look_degrees_ * 3.14159265F / 180.0F) * 12)
      : 0;
  M5.Display.fillCircle(cx - 48 + eye_dx, cy - 16 + eye_dy, 14, kText);
  M5.Display.fillCircle(cx + 48 + eye_dx, cy - 16 + eye_dy, 14, kText);
  if (animation == Animation::Failed) {
    M5.Display.drawLine(cx - 26, cy + 58, cx + 26, cy + 40, kRed);
  } else {
    M5.Display.drawArc(cx, cy + 30, 42, 31, 20, 160, kGreen);
  }
  M5.Display.fillRoundRect(cx - 120, cy + 116, 240, 54, 26, kPanelLight);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(
      stateColor(animation == Animation::Failed ? PresentationState::Blocked : PresentationState::Ready),
      kPanelLight);
  M5.Display.setTextSize(2);
  M5.Display.drawString("CODEX", cx, cy + 143);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
}

void Tab5Ui::drawApproval(const Approval& approval) {
  M5.Display.fillRoundRect(48, 100, 1184, 584, 22, kPanel);
  M5.Display.setTextColor(kOrange, kPanel);
  M5.Display.setTextSize(2);
  M5.Display.drawString(String(approval.title.c_str()), 88, 140);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(kText, kPanel);
  drawWrapped(String(approval.detail.c_str()), 88, 210, 1080, 2, 38);
  M5.Display.setTextColor(kMuted, kPanel);
  drawWrapped(String(approval.reason.c_str()), 88, 304, 1080, 2, 34);
  M5.Display.fillRoundRect(
      kDeclineButton.x, kDeclineButton.y,
      kDeclineButton.width, kDeclineButton.height, 14, kPanelLight);
  const auto safe = approvalCanAccept(approval);
  M5.Display.fillRoundRect(
      kAcceptButton.x, kAcceptButton.y,
      kAcceptButton.width, kAcceptButton.height, 14, safe ? kGreen : kPanelLight);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextSize(2);
  M5.Display.setTextColor(kText, kPanelLight);
  M5.Display.drawString("拒绝", kDeclineButton.x + kDeclineButton.width / 2,
                     kDeclineButton.y + kDeclineButton.height / 2);
  M5.Display.setTextColor(safe ? kBackground : kMuted, safe ? kGreen : kPanelLight);
  M5.Display.drawString(safe ? "仅允许本次" : "请在电脑确认",
                     kAcceptButton.x + kAcceptButton.width / 2,
                     kAcceptButton.y + kAcceptButton.height / 2);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
}

void Tab5Ui::drawStatus(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const String& connection_detail) {
  M5.Display.fillRect(0, 0, kScreenWidth, 72, kPanel);
  M5.Display.fillCircle(32, 36, 12, snapshot.bridge_connected ? kGreen : kRed);
  M5.Display.setTextColor(stateColor(snapshot.state), kPanel);
  M5.Display.setTextSize(2);
  M5.Display.setTextDatum(middle_left);
  M5.Display.drawString(stateLabel(snapshot.state), 62, 36);
  M5.Display.setTextColor(kMuted, kPanel);
  M5.Display.setTextSize(1);
  drawTruncated(connection_detail, 210, 28, 650);

  const auto unix_seconds = currentUnixSeconds(snapshot, now_ms);
  std::time_t now = static_cast<std::time_t>(
      unix_seconds + snapshot.clock.utc_offset_minutes * 60);
  std::tm local{};
  gmtime_r(&now, &local);
  char time_text[24]{};
  if (unix_seconds > 1'700'000'000) {
    snprintf(
        time_text,
        sizeof(time_text),
        "%02d/%02d  %02d:%02d",
        local.tm_mon + 1,
        local.tm_mday,
        local.tm_hour,
        local.tm_min);
  } else {
    snprintf(time_text, sizeof(time_text), "--/--  --:--");
  }

  const auto transport_x = 900;
  M5.Display.setTextColor(snapshot.bridge_connected ? kBlue : kMuted, kPanel);
  if (snapshot.telemetry.transport == TransportKind::Wifi) {
    M5.Display.drawArc(transport_x, 37, 20, 17, 210, 330, kBlue);
    M5.Display.drawArc(transport_x, 37, 12, 9, 215, 325, kBlue);
    M5.Display.fillCircle(transport_x, 43, 3, kBlue);
  } else {
    M5.Display.drawLine(transport_x - 18, 38, transport_x + 10, 38, kBlue);
    M5.Display.drawLine(transport_x + 10, 38, transport_x + 18, 30, kBlue);
    M5.Display.drawLine(transport_x + 10, 38, transport_x + 18, 46, kBlue);
    M5.Display.drawLine(transport_x + 18, 30, transport_x + 18, 24, kBlue);
    M5.Display.fillCircle(transport_x + 18, 47, 3, kBlue);
  }
  M5.Display.setTextDatum(middle_left);
  M5.Display.setTextColor(kMuted, kPanel);
  M5.Display.drawString(time_text, 940, 36);

  const auto battery = std::min<std::uint8_t>(snapshot.telemetry.battery_percent, 100);
  M5.Display.drawRoundRect(1178, 25, 42, 22, 4, kMuted);
  M5.Display.fillRect(1220, 31, 4, 10, kMuted);
  M5.Display.fillRoundRect(
      1181,
      28,
      36 * battery / 100,
      16,
      2,
      snapshot.telemetry.charging ? kGreen : kBlue);
  M5.Display.setTextDatum(middle_right);
  M5.Display.drawString(String(battery) + "%", 1264, 36);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextSize(1);
}

void Tab5Ui::drawQuota(const Snapshot& snapshot) {
  constexpr Rect panel{448, 88, 390, 130};
  M5.Display.fillRoundRect(panel.x, panel.y, panel.width, panel.height, 16, kPanel);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(kMuted, kPanel);
  M5.Display.setTextSize(1);
  M5.Display.drawString("本周额度", 470, 106);
  const auto used = snapshot.quota.available ? snapshot.quota.used_percent : 0;
  const auto remaining = snapshot.quota.available ? 100 - used : 0;
  M5.Display.setTextColor(snapshot.quota.available ? kText : kMuted, kPanel);
  M5.Display.setTextSize(2);
  M5.Display.drawString(
      snapshot.quota.available
          ? String(remaining) + "%"
          : "--",
      470,
      136);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(kMuted, kPanel);
  if (snapshot.quota.available) {
    M5.Display.drawString(
        "剩余 · 已用 " + String(used) + "%",
        578,
        146);
  }
  String reset_text = "等待 Bridge 同步";
  if (snapshot.quota.available && snapshot.quota.resets_at > 0) {
    auto reset = static_cast<std::time_t>(
        snapshot.quota.resets_at + snapshot.clock.utc_offset_minutes * 60);
    std::tm local{};
    gmtime_r(&reset, &local);
    char text[32]{};
    snprintf(
        text,
        sizeof(text),
        "重置 %02d/%02d %02d:%02d",
        local.tm_mon + 1,
        local.tm_mday,
        local.tm_hour,
        local.tm_min);
    reset_text = text;
  }
  M5.Display.drawString(reset_text, 470, 178);
  M5.Display.drawRoundRect(470, 198, 344, 10, 5, kPanelLight);
  M5.Display.fillRoundRect(472, 200, 340 * used / 100, 6, 3, used >= 90 ? kRed : kBlue);
}

void Tab5Ui::drawTokenSummary(const Snapshot& snapshot) {
  constexpr Rect panel{854, 88, 402, 130};
  M5.Display.fillRoundRect(panel.x, panel.y, panel.width, panel.height, 16, kPanel);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(kMuted, kPanel);
  M5.Display.setTextSize(1);
  M5.Display.drawString("TOKEN", 876, 106);
  const auto task_tokens = !snapshot.tasks.empty()
      ? snapshot.tasks.front().tokens
      : snapshot.tokens.total;
  M5.Display.setTextColor(kText, kPanel);
  M5.Display.setTextSize(2);
  M5.Display.drawString(compactNumber(task_tokens), 876, 136);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(kMuted, kPanel);
  M5.Display.drawString("当前任务", 1000, 146);
  M5.Display.drawString(
      snapshot.account_tokens.today_available
          ? "今日 " + compactNumber(snapshot.account_tokens.today)
          : "今日 --",
      876,
      184);
  M5.Display.drawString(
      "累计 " + compactNumber(snapshot.account_tokens.lifetime),
      1060,
      184);
}

void Tab5Ui::drawTaskList(
    const Snapshot& snapshot,
    const std::uint64_t now_ms) {
  constexpr Rect panel{448, 234, 808, 462};
  M5.Display.fillRoundRect(panel.x, panel.y, panel.width, panel.height, 16, kPanel);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(kText, kPanel);
  M5.Display.setTextSize(1);
  M5.Display.drawString("任务", 470, 252);
  M5.Display.setTextColor(kBlue, kPanel);
  M5.Display.drawString(
      String(snapshot.task_counts.active) + " 个进行中",
      536,
      252);
  M5.Display.setTextDatum(top_right);
  M5.Display.setTextColor(kMuted, kPanel);
  M5.Display.drawString(
      "显示 " + String(snapshot.task_counts.visible) + "/" +
          String(snapshot.task_counts.total),
      1218,
      252);
  M5.Display.setTextDatum(top_left);

  const auto maximum_scroll = snapshot.tasks.size() > kVisibleTaskRows
      ? snapshot.tasks.size() - kVisibleTaskRows
      : 0;
  task_scroll_offset_ = static_cast<std::uint8_t>(
      std::min<std::size_t>(task_scroll_offset_, maximum_scroll));
  if (snapshot.tasks.empty()) {
    M5.Display.setTextColor(kMuted, kPanel);
    M5.Display.setTextDatum(middle_center);
    M5.Display.drawString("暂无任务 · Bridge 已连接", 840, 476);
    M5.Display.setTextDatum(top_left);
    return;
  }

  const auto now_seconds = currentUnixSeconds(snapshot, now_ms);
  const auto end = std::min<std::size_t>(
      snapshot.tasks.size(),
      task_scroll_offset_ + kVisibleTaskRows);
  for (std::size_t index = task_scroll_offset_; index < end; ++index) {
    const auto& task = snapshot.tasks[index];
    const auto row = static_cast<std::int16_t>(index - task_scroll_offset_);
    const auto y = kTaskListArea.y + row * kTaskRowHeight;
    const auto background = row % 2 == 0 ? kPanelLight : kPanel;
    M5.Display.fillRoundRect(464, y, 758, 64, 10, background);
    M5.Display.fillCircle(482, y + 22, 6, stateColor(task.state));
    M5.Display.setTextColor(kText, background);
    M5.Display.setTextSize(1);
    drawTruncated(String(task.title.c_str()), 500, y + 10, 500);
    M5.Display.setTextDatum(top_right);
    M5.Display.setTextColor(stateColor(task.state), background);
    M5.Display.drawString(shortStateLabel(task.state), 1202, y + 10);
    M5.Display.setTextColor(kMuted, background);
    String recency = "--";
    if (now_seconds > 0 && task.updated_at > 0) {
      const auto age = now_seconds > task.updated_at
          ? now_seconds - task.updated_at
          : 0;
      if (age < 60) recency = "刚刚";
      else if (age < 3600) recency = String(age / 60) + " 分钟前";
      else if (age < 86400) recency = String(age / 3600) + " 小时前";
      else recency = String(age / 86400) + " 天前";
    }
    M5.Display.drawString(recency, 1202, y + 36);
    M5.Display.setTextDatum(top_left);
    M5.Display.drawString(compactNumber(task.tokens) + " tok", 500, y + 36);
    if (task.progress.known) {
      M5.Display.drawRoundRect(684, y + 43, 270, 8, 4, kMuted);
      M5.Display.fillRoundRect(
          686,
          y + 45,
          266 * task.progress.percent / 100,
          4,
          2,
          kBlue);
      M5.Display.drawString(String(task.progress.percent) + "%", 964, y + 36);
    } else if (task.state == PresentationState::Running) {
      const auto phase = static_cast<std::int16_t>((now_ms / 40) % 210);
      M5.Display.drawRoundRect(684, y + 43, 270, 8, 4, kMuted);
      M5.Display.fillRoundRect(686 + phase, y + 45, 54, 4, 2, kBlue);
    }
  }

  if (maximum_scroll > 0) {
    constexpr std::int16_t track_y = 290;
    constexpr std::int16_t track_height = 360;
    const auto thumb_height = std::max<std::int16_t>(
        48,
        track_height * kVisibleTaskRows / snapshot.tasks.size());
    const auto travel = track_height - thumb_height;
    const auto thumb_y = track_y +
        travel * task_scroll_offset_ / std::max<std::size_t>(maximum_scroll, 1);
    M5.Display.fillRoundRect(1236, track_y, 6, track_height, 3, kPanelLight);
    M5.Display.fillRoundRect(1236, thumb_y, 6, thumb_height, 3, kBlue);
  }
}

void Tab5Ui::drawChevron(const Rect& bounds, const bool points_right) {
  const auto cx = bounds.x + bounds.width / 2;
  const auto cy = bounds.y + bounds.height / 2;
  const auto direction = points_right ? 1 : -1;
  M5.Display.drawLine(cx - 8 * direction, cy - 11, cx + 6 * direction, cy, kText);
  M5.Display.drawLine(cx + 6 * direction, cy, cx - 8 * direction, cy + 11, kText);
}

std::uint64_t Tab5Ui::currentUnixSeconds(
    const Snapshot& snapshot,
    const std::uint64_t now_ms) {
  if (snapshot.clock.unix_ms != 0 &&
      snapshot.clock.unix_ms != last_clock_unix_ms_) {
    last_clock_unix_ms_ = snapshot.clock.unix_ms;
    clock_received_at_ms_ = now_ms;
  }
  if (last_clock_unix_ms_ > 0) {
    return (last_clock_unix_ms_ +
            (now_ms >= clock_received_at_ms_ ? now_ms - clock_received_at_ms_ : 0)) /
        1000;
  }
  const auto local = std::time(nullptr);
  return local > 1'700'000'000 ? static_cast<std::uint64_t>(local) : 0;
}

void Tab5Ui::drawTruncated(
    const String& text,
    const std::int16_t x,
    const std::int16_t y,
    const std::int16_t width) {
  M5.Display.setClipRect(x, y, width, M5.Display.fontHeight());
  M5.Display.drawString(text, x, y);
  M5.Display.clearClipRect();
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
      M5.Display.drawString(line, x, y);
      line = "";
      y += line_height;
      if (++line_count >= maximum_lines) return;
      continue;
    }
    const auto candidate = line + character;
    if (!line.isEmpty() && M5.Display.textWidth(candidate) > width) {
      M5.Display.drawString(line, x, y);
      line = character;
      y += line_height;
      if (++line_count >= maximum_lines) return;
    } else {
      line = candidate;
    }
  }
  if (!line.isEmpty() && line_count < maximum_lines) {
    M5.Display.drawString(line, x, y);
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
