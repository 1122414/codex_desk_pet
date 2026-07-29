#include "tab5_ui.hpp"

#include <esp_heap_caps.h>
#include <SPIFFS.h>
#include <lgfx/utility/lgfx_miniz.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <ctime>
#include <iterator>

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
constexpr std::uint16_t kSkadiBackground = 0x00a4;
constexpr std::uint16_t kSkadiPanel = 0x0906;
constexpr std::uint16_t kSkadiPanelLight = 0x1148;
constexpr std::uint16_t kSkadiCard = 0x19cb;
constexpr std::uint16_t kSkadiText = 0xdfbf;
constexpr std::uint16_t kSkadiMuted = 0x8d58;
constexpr std::uint16_t kSkadiIce = 0x773e;
constexpr std::uint16_t kSkadiCoral = 0xf475;
constexpr std::uint16_t kSkadiLavender = 0xac9d;
constexpr std::uint16_t kSkadiBlue = 0x4bf5;
constexpr std::uint16_t kSkadiPearl = 0xfe7b;
constexpr std::uint16_t kFeibiBackground = 0x1843;
constexpr std::uint16_t kFeibiPanel = 0x2886;
constexpr std::uint16_t kFeibiPanelLight = 0x4109;
constexpr std::uint16_t kFeibiCard = 0x596a;
constexpr std::uint16_t kFeibiText = 0xffbb;
constexpr std::uint16_t kFeibiMuted = 0xc517;
constexpr std::uint16_t kFeibiGold = 0xf60d;
constexpr std::uint16_t kFeibiRose = 0xec75;
constexpr std::uint16_t kFeibiViolet = 0xab79;
constexpr std::uint16_t kFeibiCream = 0xff35;
constexpr std::uint16_t kFeibiBorder = 0x722c;
constexpr std::int16_t kKeyX = 330;
constexpr std::int16_t kKeyY = 204;
constexpr std::int16_t kKeyWidth = 208;
constexpr std::int16_t kKeyHeight = 88;
constexpr std::int16_t kTaskRowHeight = 72;
constexpr std::uint8_t kVisibleTaskRows = 5;
constexpr std::int16_t kDetailMessageRowHeight = 124;
constexpr std::int16_t kTouchMoveThreshold = 8;
constexpr std::int16_t kRegionChunkRows = 64;
constexpr std::int16_t kRegionBufferWidth = 808;
constexpr std::uint64_t kTaskScrollFrameIntervalMs = 16;
constexpr std::uint64_t kPetButtonReleaseGuardMs = 120;
constexpr std::uint8_t kPetAnimationRowFrames = 8;
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

bool isSkadiTheme(const Snapshot& snapshot) {
  return snapshot.selected_pet_id == "chibi-skadi" ||
      snapshot.selected_pet_id.rfind("chibi-skadi-", 0) == 0;
}

bool isFeibiTheme(const Snapshot& snapshot) {
  return snapshot.selected_pet_id == "feibi" ||
      snapshot.selected_pet_id.rfind("feibi-", 0) == 0;
}

std::uint16_t stateColor(
    const PresentationState state,
    const bool skadi = false,
    const bool feibi = false) {
  if (feibi) {
    switch (state) {
      case PresentationState::Completed: return kFeibiGold;
      case PresentationState::NeedsInput:
      case PresentationState::Reviewing: return kFeibiViolet;
      case PresentationState::Blocked: return kFeibiRose;
      case PresentationState::Running: return kFeibiGold;
      case PresentationState::Ready: return kFeibiMuted;
    }
  }
  if (skadi) {
    switch (state) {
      case PresentationState::Completed: return kSkadiIce;
      case PresentationState::NeedsInput:
      case PresentationState::Reviewing: return kSkadiLavender;
      case PresentationState::Blocked: return kSkadiCoral;
      case PresentationState::Running: return kSkadiIce;
      case PresentationState::Ready: return kSkadiMuted;
    }
  }
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

void hashBytes(
    std::uint64_t& hash,
    const void* data,
    const std::size_t length) {
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  for (std::size_t index = 0; index < length; ++index) {
    hash ^= bytes[index];
    hash *= 1099511628211ULL;
  }
}

template <typename T>
void hashValue(std::uint64_t& hash, const T& value) {
  hashBytes(hash, &value, sizeof(value));
}

void hashString(std::uint64_t& hash, const std::string& value) {
  hashBytes(hash, value.data(), value.size());
  constexpr std::uint8_t separator = 0xff;
  hashValue(hash, separator);
}

void hashString(std::uint64_t& hash, const String& value) {
  hashBytes(hash, value.c_str(), value.length());
  constexpr std::uint8_t separator = 0xfe;
  hashValue(hash, separator);
}

std::uint64_t renderFingerprint(
    const Snapshot& snapshot,
    const String& connection_detail,
    const std::uint8_t transfer_progress,
    const bool voice_recording,
    const String& voice_mode,
    const bool camera_busy,
    const std::uint64_t minute_bucket) {
  std::uint64_t hash = 1469598103934665603ULL;
  hashValue(hash, snapshot.bridge_connected);
  hashValue(hash, snapshot.state);
  hashString(hash, snapshot.task_id);
  hashString(hash, snapshot.task_title);
  hashString(hash, snapshot.selected_pet_id);
  hashValue(hash, snapshot.tokens.total);
  hashValue(hash, snapshot.tokens.level);
  hashValue(hash, snapshot.tokens.current);
  hashValue(hash, snapshot.tokens.target);
  hashValue(hash, snapshot.account_tokens.lifetime);
  hashValue(hash, snapshot.account_tokens.today);
  hashValue(hash, snapshot.account_tokens.today_available);
  hashValue(hash, snapshot.quota.available);
  hashValue(hash, snapshot.quota.used_percent);
  hashValue(hash, snapshot.quota.resets_at);
  hashValue(hash, snapshot.quota.window_minutes);
  hashString(hash, snapshot.quota.name);
  hashValue(hash, snapshot.approval.present);
  hashValue(hash, snapshot.approval.safe_to_approve);
  hashString(hash, snapshot.approval.request_id);
  hashString(hash, snapshot.approval.title);
  hashString(hash, snapshot.approval.detail);
  hashString(hash, snapshot.approval.reason);
  hashString(hash, snapshot.companion.status);
  hashString(hash, snapshot.companion.mode);
  hashString(hash, snapshot.companion.request_id);
  hashString(hash, snapshot.companion.prompt);
  hashString(hash, snapshot.companion.reply);
  hashString(hash, snapshot.companion.error);
  hashValue(hash, snapshot.telemetry.battery_percent);
  hashValue(hash, snapshot.telemetry.charging);
  hashValue(hash, snapshot.telemetry.wifi_rssi);
  hashValue(hash, snapshot.telemetry.transport);
  hashValue(hash, snapshot.task_counts.total);
  hashValue(hash, snapshot.task_counts.active);
  hashValue(hash, snapshot.task_counts.visible);
  for (const auto& task : snapshot.tasks) {
    hashString(hash, task.id);
    hashString(hash, task.title);
    hashValue(hash, task.kind);
    hashString(hash, task.workspace);
    hashValue(hash, task.state);
    hashValue(hash, task.updated_at);
    hashValue(hash, task.tokens);
    hashValue(hash, task.progress.known);
    hashValue(hash, task.progress.completed);
    hashValue(hash, task.progress.total);
    hashValue(hash, task.progress.percent);
  }
  for (const auto& pet : snapshot.pets) {
    hashString(hash, pet.id);
    hashString(hash, pet.display_name);
    hashValue(hash, pet.sprite_version);
    hashValue(hash, pet.builtin);
  }
  hashString(hash, connection_detail);
  hashValue(hash, transfer_progress);
  hashValue(hash, voice_recording);
  hashString(hash, voice_mode);
  hashValue(hash, camera_busy);
  hashValue(hash, minute_bucket);
  return hash;
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
  animation_row_pixels_ = static_cast<std::uint16_t*>(heap_caps_malloc(
      static_cast<std::size_t>(kPetFrameBytes) * kPetAnimationRowFrames,
      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  const auto region_bytes =
      static_cast<std::size_t>(kRegionBufferWidth) *
      kRegionChunkRows *
      sizeof(std::uint16_t);
  region_pixels_ = static_cast<std::uint16_t*>(heap_caps_malloc(
      region_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (region_pixels_ == nullptr) {
    region_pixels_ = static_cast<std::uint16_t*>(malloc(region_bytes));
  }
  M5.Display.setBrightness(128);
  M5.Speaker.setVolume(48);
  bundled_pet_ready_ = SPIFFS.begin(false);
  return frame_pixels_ != nullptr &&
      animation_row_pixels_ != nullptr &&
      region_pixels_ != nullptr;
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
  } else {
    const auto minute_bucket = currentUnixSeconds(snapshot, now_ms) / 60;
    const auto fingerprint = renderFingerprint(
        snapshot,
        connection_detail,
        transfer_progress,
        voice_recording_,
        voice_mode_,
        camera_busy_,
        minute_bucket);
    if (normal_screen_rendered_ && fingerprint == rendered_fingerprint_) {
      if (!snapshot.approval.present &&
          !snapshot.companion.awaitingConfirmation() &&
          !touch_active_) {
        const auto frame_index = frameIndex(snapshot, now_ms);
        if (frame_index != rendered_pet_frame_index_) {
          const auto pet_background = isFeibiTheme(snapshot)
              ? kFeibiPanel
              : isSkadiTheme(snapshot) ? kSkadiPanel : kPanel;
          canvas_.fillRect(
              kPetSpriteArea.x,
              kPetSpriteArea.y,
              kPetSpriteArea.width,
              kPetSpriteArea.height,
              pet_background);
          drawPetFrame(snapshot, frame_index);
          pushCanvasRegion(kPetSpriteArea);
          rendered_pet_frame_index_ = frame_index;
        }
      }
      if (
          !snapshot.approval.present &&
          !snapshot.companion.awaitingConfirmation() &&
          !thread_detail_.visible &&
          task_scroll_pixels_ != rendered_task_scroll_pixels_ &&
          (
              !task_touch_active_ ||
              now_ms - last_task_scroll_render_at_ms_ >=
                  kTaskScrollFrameIntervalMs)) {
        drawTaskList(snapshot, now_ms);
        pushScrolledCanvasRegion(
            kTaskListArea,
            rendered_task_scroll_pixels_,
            task_scroll_pixels_,
            {1232, 288, 12, 390});
        rendered_task_scroll_pixels_ = task_scroll_pixels_;
        last_task_scroll_render_at_ms_ = now_ms;
      }
      if (
          !snapshot.approval.present &&
          !snapshot.companion.awaitingConfirmation() &&
          thread_detail_.visible &&
          detail_scroll_pixels_ != rendered_detail_scroll_pixels_ &&
          (
              !task_touch_active_ ||
              now_ms - last_task_scroll_render_at_ms_ >=
                  kTaskScrollFrameIntervalMs)) {
        drawThreadMessages(snapshot);
        pushScrolledCanvasRegion(
            kThreadDetailArea,
            rendered_detail_scroll_pixels_,
            detail_scroll_pixels_,
            {1232, 170, 12, 500});
        rendered_detail_scroll_pixels_ = detail_scroll_pixels_;
        last_task_scroll_render_at_ms_ = now_ms;
      }
      return;
    }
    rendered_fingerprint_ = fingerprint;
  }
  canvas_.fillScreen(
      paired && isFeibiTheme(snapshot)
          ? kFeibiBackground
          : paired && isSkadiTheme(snapshot)
              ? kSkadiBackground
              : kBackground);
  if (paired) {
    pairing_screen_rendered_ = false;
    drawNormal(snapshot, now_ms, connection_detail, transfer_progress);
    normal_screen_rendered_ = true;
    rendered_task_scroll_pixels_ = task_scroll_pixels_;
    rendered_detail_scroll_pixels_ = detail_scroll_pixels_;
    last_task_scroll_render_at_ms_ = now_ms;
  } else {
    normal_screen_rendered_ = false;
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

void Tab5Ui::setVoiceRecording(
    const bool recording,
    const String& mode) {
  const auto next_mode = recording ? mode : String();
  if (voice_recording_ == recording && voice_mode_ == next_mode) return;
  voice_recording_ = recording;
  voice_mode_ = next_mode;
  normal_screen_rendered_ = false;
}

void Tab5Ui::setCameraBusy(const bool busy) {
  if (camera_busy_ == busy) return;
  camera_busy_ = busy;
  normal_screen_rendered_ = false;
}

void Tab5Ui::setThreadLoading(const TaskSummary& task) {
  thread_detail_ = {};
  thread_detail_.visible = true;
  thread_detail_.loading = true;
  thread_detail_.thread_id = task.id;
  thread_detail_.title = task.title;
  thread_detail_.kind = task.kind;
  thread_detail_.workspace = task.workspace;
  detail_scroll_pixels_ = 0;
  rendered_detail_scroll_pixels_ = -1;
  normal_screen_rendered_ = false;
}

void Tab5Ui::setThreadDetail(const ThreadDetail& detail) {
  if (
      thread_detail_.visible &&
      !thread_detail_.thread_id.empty() &&
      thread_detail_.thread_id != detail.thread_id) {
    return;
  }
  thread_detail_ = detail;
  thread_detail_.visible = true;
  thread_detail_.loading = false;
  detail_scroll_pixels_ = 0;
  rendered_detail_scroll_pixels_ = -1;
  normal_screen_rendered_ = false;
}

void Tab5Ui::setThreadError(
    const String& thread_id,
    const String& error) {
  if (
      !thread_id.isEmpty() &&
      thread_detail_.visible &&
      !thread_detail_.thread_id.empty() &&
      thread_detail_.thread_id != thread_id.c_str()) {
    return;
  }
  thread_detail_.visible = true;
  thread_detail_.loading = false;
  if (!thread_id.isEmpty()) thread_detail_.thread_id = thread_id.c_str();
  thread_detail_.error = error.c_str();
  detail_scroll_pixels_ = 0;
  rendered_detail_scroll_pixels_ = -1;
  normal_screen_rendered_ = false;
}

void Tab5Ui::closeThread() {
  thread_detail_ = {};
  detail_scroll_pixels_ = 0;
  rendered_detail_scroll_pixels_ = -1;
  task_touch_active_ = false;
  task_touch_moved_ = false;
  normal_screen_rendered_ = false;
}

void Tab5Ui::invalidatePetCache() {
  cached_pet_id_ = "";
  cached_animation_row_ = UINT8_MAX;
  animation_row_ready_ = false;
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
    const auto clicked = detail.wasClicked();
    const auto hardware_moved =
        detail.wasFlickStart() ||
        detail.isFlicking() ||
        detail.wasFlicked() ||
        detail.wasDragStart() ||
        detail.isDragging() ||
        detail.wasDragged();
    const auto pressed =
        !released && (detail.wasPressed() || !touch_active_);
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
    const auto confirmation_visible =
        snapshot.approval.present ||
        snapshot.companion.awaitingConfirmation();
    if (pet_button_release_blocked_) {
      const auto blocked_button =
          pet_button_blocked_action_ == UiActionType::PreviousPet
              ? kPreviousPetButton.contains(point)
              : kNextPetButton.contains(point);
      if (blocked_button) {
        pet_button_quiet_since_ms_ = 0;
        input_.cancel();
        return {};
      }
      pet_button_release_blocked_ = false;
      pet_button_blocked_action_ = UiActionType::None;
      pet_button_quiet_since_ms_ = 0;
    }
    if (!confirmation_visible) {
      if (
          pressed &&
          (kPreviousPetButton.contains(point) ||
           kNextPetButton.contains(point))) {
        input_.cancel();
        pet_button_touch_active_ = true;
        pet_button_touch_action_ =
            kPreviousPetButton.contains(point)
                ? UiActionType::PreviousPet
                : UiActionType::NextPet;
        return {pet_button_touch_action_, {}};
      }
      if (pet_button_touch_active_) {
        if (!released) return {};
        const auto action = pet_button_touch_action_;
        pet_button_touch_active_ = false;
        pet_button_touch_action_ = UiActionType::None;
        pet_button_release_blocked_ = true;
        pet_button_blocked_action_ = action;
        pet_button_quiet_since_ms_ = 0;
        input_.cancel();
        return {};
      }
      if (pressed && kCameraButton.contains(point)) {
        input_.cancel();
        camera_touch_active_ = true;
        return {UiActionType::CameraCapture, {}};
      }
      if (camera_touch_active_) {
        if (released) {
          camera_touch_active_ = false;
        }
        return {};
      }
      if (pressed &&
          (kVoiceChatButton.contains(point) ||
           kVoiceCommandButton.contains(point))) {
        input_.cancel();
        voice_touch_active_ = true;
        const String pressed_mode =
            kVoiceCommandButton.contains(point) ? "command" : "chat";
        if (voice_recording_) {
          return pressed_mode == voice_mode_
              ? UiAction{UiActionType::VoiceStop, {}}
              : UiAction{};
        }
        return {UiActionType::VoiceStart, pressed_mode};
      }
      if (voice_touch_active_) {
        if (released) {
          voice_touch_active_ = false;
        }
        return {};
      }
      if (thread_detail_.visible) {
        if (pressed && kThreadBackTouchArea.contains(point)) {
          input_.cancel();
          task_touch_active_ = false;
          task_touch_moved_ = false;
          return {UiActionType::CloseThread, {}};
        }
        const auto maximum_scroll = std::max<std::int32_t>(
            0,
            static_cast<std::int32_t>(thread_detail_.messages.size()) *
                    kDetailMessageRowHeight -
                kThreadDetailArea.height);
        if (pressed && kThreadDetailArea.contains(point)) {
          input_.cancel();
          task_touch_active_ = true;
          task_touch_moved_ = false;
          task_touch_start_ = point;
          task_scroll_start_pixels_ = static_cast<std::int16_t>(
              std::min<std::int32_t>(
                  detail_scroll_pixels_, maximum_scroll));
          return {};
        }
        if (task_touch_active_) {
          const auto delta = task_touch_start_.y - point.y;
          if (hardware_moved) {
            task_touch_moved_ = true;
          }
          if (touchMovedBeyondSlop(
                  task_touch_start_, point, kTouchMoveThreshold)) {
            task_touch_moved_ = true;
          }
          if (task_touch_moved_) {
            detail_scroll_pixels_ = static_cast<std::int16_t>(
                std::clamp<int>(
                    static_cast<int>(task_scroll_start_pixels_) + delta,
                    0,
                    static_cast<int>(maximum_scroll)));
          }
          if (released) {
            task_touch_active_ = false;
            task_touch_moved_ = false;
          }
          return {};
        }
        return {};
      }
      const auto maximum_scroll = std::max<std::int32_t>(
          0,
          static_cast<std::int32_t>(snapshot.tasks.size()) * kTaskRowHeight -
              kTaskListArea.height);
      if (pressed && kTaskListArea.contains(point)) {
        input_.cancel();
        task_touch_active_ = true;
        task_touch_moved_ = false;
        task_touch_start_ = point;
        task_scroll_start_pixels_ = static_cast<std::int16_t>(
            std::min<std::int32_t>(task_scroll_pixels_, maximum_scroll));
        return {};
      }
      if (task_touch_active_) {
        const auto delta = task_touch_start_.y - point.y;
        if (hardware_moved) {
          task_touch_moved_ = true;
        }
        if (touchMovedBeyondSlop(
                task_touch_start_, point, kTouchMoveThreshold)) {
          task_touch_moved_ = true;
        }
        if (task_touch_moved_) {
          task_scroll_pixels_ = static_cast<std::int16_t>(std::clamp<int>(
              static_cast<int>(task_scroll_start_pixels_) + delta,
              0,
              static_cast<int>(maximum_scroll)));
        }
        if (released) {
          const auto was_moved = task_touch_moved_;
          task_touch_active_ = false;
          task_touch_moved_ = false;
          if (clicked && !was_moved && kTaskListArea.contains(point)) {
            const auto content_y =
                task_scroll_start_pixels_ +
                task_touch_start_.y -
                kTaskListArea.y;
            const auto index = static_cast<std::size_t>(
                std::max<std::int32_t>(content_y, 0) / kTaskRowHeight);
            if (index < snapshot.tasks.size()) {
              return {
                  UiActionType::OpenThread,
                  String(snapshot.tasks[index].id.c_str())};
            }
          }
        }
        return {};
      }
    }
    const auto safe = snapshot.companion.awaitingConfirmation() ||
        approvalCanAccept(snapshot.approval);
    return mapInputAction(input_.onTouch(
        phase, point, now_ms, confirmation_visible, safe));
  }
  if (pet_button_touch_active_) {
    const auto action = pet_button_touch_action_;
    pet_button_touch_active_ = false;
    pet_button_touch_action_ = UiActionType::None;
    pet_button_release_blocked_ = true;
    pet_button_blocked_action_ = action;
    pet_button_quiet_since_ms_ = 0;
    touch_active_ = false;
    input_.cancel();
    return {};
  }
  if (pet_button_release_blocked_) {
    if (pet_button_quiet_since_ms_ == 0) {
      pet_button_quiet_since_ms_ = now_ms;
    } else if (
        now_ms >= pet_button_quiet_since_ms_ &&
        now_ms - pet_button_quiet_since_ms_ >=
            kPetButtonReleaseGuardMs) {
      pet_button_release_blocked_ = false;
      pet_button_blocked_action_ = UiActionType::None;
      pet_button_quiet_since_ms_ = 0;
    }
    return {};
  }
  if (!touch_active_) return {};
  touch_active_ = false;
  if (!paired) {
    pairing_released_at_ = now_ms;
    return {};
  }
  if (task_touch_active_) {
    task_touch_active_ = false;
    task_touch_moved_ = false;
    return {};
  }
  if (voice_touch_active_) {
    voice_touch_active_ = false;
    return {};
  }
  if (camera_touch_active_) {
    camera_touch_active_ = false;
    return {};
  }
  const auto confirmation_visible =
      snapshot.approval.present ||
      snapshot.companion.awaitingConfirmation();
  const auto safe = snapshot.companion.awaitingConfirmation() ||
      approvalCanAccept(snapshot.approval);
  return mapInputAction(input_.onTouch(
      TouchPhase::Released,
      last_touch_,
      now_ms,
      confirmation_visible,
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
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  if (skadi) drawSkadiBackdrop();
  if (feibi) drawFeibiBackdrop();
  drawStatus(snapshot, now_ms, connection_detail);
  if (snapshot.approval.present) {
    drawApproval(snapshot);
    return;
  }
  if (snapshot.companion.awaitingConfirmation()) {
    drawCompanionCommand(snapshot);
    return;
  }

  const auto panel = feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto panel_light =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  canvas_.fillRoundRect(
      kPetArea.x,
      kPetArea.y,
      kPetArea.width,
      kPetArea.height,
      20,
      panel);
  if (skadi) {
    canvas_.drawRoundRect(
        kPetArea.x,
        kPetArea.y,
        kPetArea.width,
        kPetArea.height,
        20,
        kSkadiIce);
    canvas_.fillTriangle(24, 88, 66, 88, 24, 130, kSkadiCoral);
    canvas_.setTextDatum(top_right);
    canvas_.setTextColor(kSkadiMuted, panel);
    canvas_.drawString("CHIBI SKADI // TIDAL LINK", 404, 98);
    canvas_.setTextDatum(top_left);
  } else if (feibi) {
    canvas_.drawRoundRect(
        kPetArea.x,
        kPetArea.y,
        kPetArea.width,
        kPetArea.height,
        24,
        kFeibiGold);
    canvas_.fillCircle(42, 106, 10, kFeibiRose);
    canvas_.fillTriangle(32, 88, 52, 88, 42, 102, kFeibiGold);
    canvas_.setTextDatum(top_right);
    canvas_.setTextColor(kFeibiMuted, panel);
    canvas_.drawString("FEIBI // STARLIGHT DESK", 404, 98);
    canvas_.setTextDatum(top_left);
  }
  drawPet(snapshot, now_ms);
  if (thread_detail_.visible) {
    drawThreadDetail(snapshot);
  } else {
    drawQuota(snapshot);
    drawTokenSummary(snapshot);
    drawTaskList(snapshot, now_ms);
  }
  const auto voice_chat_recording =
      voice_recording_ && voice_mode_ == "chat";
  const auto voice_command_recording =
      voice_recording_ && voice_mode_ == "command";

  canvas_.fillRoundRect(
      kPreviousPetButton.x, kPreviousPetButton.y,
      kPreviousPetButton.width, kPreviousPetButton.height, 14, panel_light);
  canvas_.fillRoundRect(
      kNextPetButton.x, kNextPetButton.y,
      kNextPetButton.width, kNextPetButton.height, 14, panel_light);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextColor(text, panel_light);
  drawChevron(kPreviousPetButton, false, text);
  drawChevron(kNextPetButton, true, text);
  canvas_.fillRoundRect(
      kVoiceChatButton.x, kVoiceChatButton.y,
      kVoiceChatButton.width, kVoiceChatButton.height, 14,
      voice_chat_recording
          ? (feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed)
          : panel_light);
  canvas_.fillRoundRect(
      kVoiceCommandButton.x, kVoiceCommandButton.y,
      kVoiceCommandButton.width, kVoiceCommandButton.height, 14,
      voice_command_recording
          ? (feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed)
          : panel_light);
  canvas_.fillRoundRect(
      kCameraButton.x, kCameraButton.y,
      kCameraButton.width, kCameraButton.height, 14,
      camera_busy_
          ? (feibi ? kFeibiViolet : skadi ? kSkadiLavender : kOrange)
          : panel_light);
  canvas_.setTextSize(1);
  canvas_.setTextColor(
      text,
      voice_chat_recording
          ? (feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed)
          : panel_light);
  canvas_.drawString(
      voice_chat_recording ? "结束" : "对话",
      kVoiceChatButton.x + kVoiceChatButton.width / 2,
      kVoiceChatButton.y + kVoiceChatButton.height / 2);
  canvas_.setTextColor(
      text,
      voice_command_recording
          ? (feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed)
          : panel_light);
  canvas_.drawString(
      voice_command_recording ? "结束" : "命令",
      kVoiceCommandButton.x + kVoiceCommandButton.width / 2,
      kVoiceCommandButton.y + kVoiceCommandButton.height / 2);
  canvas_.setTextColor(
      text,
      camera_busy_
          ? (feibi ? kFeibiViolet : skadi ? kSkadiLavender : kOrange)
          : panel_light);
  canvas_.drawString(
      camera_busy_ ? "发送中" : "拍照",
      kCameraButton.x + kCameraButton.width / 2,
      kCameraButton.y + kCameraButton.height / 2);
  if (transfer_progress > 0 && transfer_progress < 100) {
    canvas_.setTextColor(
        feibi ? kFeibiGold : skadi ? kSkadiLavender : kOrange,
        panel);
    canvas_.drawString(
        "同步 " + String(transfer_progress) + "%",
        228,
        606);
  }
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawSkadiBackdrop() {
  static constexpr Point stars[] = {
      {18, 154}, {438, 82}, {849, 72}, {1260, 166}, {431, 528},
      {36, 704}, {1002, 704}, {1248, 574}, {844, 232}, {1128, 222},
  };
  for (std::size_t index = 0; index < std::size(stars); ++index) {
    const auto radius = static_cast<std::int16_t>(index % 3 + 1);
    canvas_.fillCircle(
        stars[index].x,
        stars[index].y,
        radius,
        index % 4 == 0 ? kSkadiCoral : kSkadiIce);
  }
  canvas_.drawArc(890, 710, 380, 348, 205, 335, kSkadiBlue);
  canvas_.drawArc(890, 710, 330, 305, 205, 335, kSkadiPanelLight);
  canvas_.drawLine(438, 82, 1260, 82, kSkadiPanelLight);
}

void Tab5Ui::drawFeibiBackdrop() {
  static constexpr Point stars[] = {
      {18, 132}, {438, 84}, {688, 74}, {982, 78}, {1258, 150},
      {32, 702}, {452, 692}, {832, 704}, {1114, 690}, {1250, 520},
  };
  for (std::size_t index = 0; index < std::size(stars); ++index) {
    const auto radius = static_cast<std::int16_t>(index % 3 + 2);
    const auto color = index % 3 == 0
        ? kFeibiRose
        : index % 3 == 1 ? kFeibiGold : kFeibiCream;
    canvas_.drawLine(
        stars[index].x - radius,
        stars[index].y,
        stars[index].x + radius,
        stars[index].y,
        color);
    canvas_.drawLine(
        stars[index].x,
        stars[index].y - radius,
        stars[index].x,
        stars[index].y + radius,
        color);
  }
  canvas_.drawArc(1010, 712, 340, 315, 198, 332, kFeibiViolet);
  canvas_.drawArc(1010, 712, 294, 274, 198, 332, kFeibiBorder);
  canvas_.drawLine(438, 82, 1260, 82, kFeibiBorder);
  canvas_.fillTriangle(1138, 82, 1174, 82, 1156, 100, kFeibiGold);
  canvas_.fillTriangle(1174, 82, 1210, 82, 1192, 100, kFeibiRose);
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
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto panel = feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto index = frameIndex(snapshot, now_ms);
  drawPetFrame(snapshot, index);
  rendered_pet_frame_index_ = index;
  String pet_name(snapshot.selected_pet_id.c_str());
  const auto selected = std::find_if(
      snapshot.pets.begin(), snapshot.pets.end(),
      [&snapshot](const PetSummary& pet) { return pet.id == snapshot.selected_pet_id; });
  if (selected != snapshot.pets.end() && !selected->display_name.empty()) {
    pet_name = String(selected->display_name.c_str());
  }
  canvas_.setTextColor(text, panel);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
  drawTruncated(pet_name, 62, 550, 332);
  canvas_.setTextColor(stateColor(snapshot.state, skadi, feibi), panel);
  canvas_.setTextDatum(middle_center);
  canvas_.drawString(stateLabel(snapshot.state), 228, 590);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawPetFrame(
    const Snapshot& snapshot,
    const std::uint8_t index) {
  auto drawn = drawCachedPetFrame(snapshot, index);
  if (!drawn &&
      snapshot.selected_pet_id == "chibi-skadi" &&
      drawBundledPet(index)) {
    drawn = true;
  }
  if (!drawn) {
    drawFallbackPet(snapshot.animation, index % 8);
  }
}

bool Tab5Ui::drawCachedPetFrame(
    const Snapshot& snapshot,
    const std::uint8_t frame_index) {
  if (snapshot.selected_pet_id == "codex-core" || pet_store_ == nullptr) {
    return false;
  }
  const auto row = static_cast<std::uint8_t>(
      frame_index / kPetAnimationRowFrames);
  if (cached_pet_id_ != snapshot.selected_pet_id.c_str() ||
      cached_animation_row_ != row) {
    String error;
    cached_pet_id_ = snapshot.selected_pet_id.c_str();
    cached_animation_row_ = row;
    animation_row_ready_ = pet_store_->loadFrames(
        snapshot.selected_pet_id.c_str(),
        static_cast<std::uint8_t>(row * kPetAnimationRowFrames),
        kPetAnimationRowFrames,
        animation_row_pixels_,
        static_cast<std::size_t>(kPetFrameWidth) *
            kPetFrameHeight *
            kPetAnimationRowFrames,
        error);
  }
  if (!animation_row_ready_) return false;
  const auto frame_pixels =
      static_cast<std::size_t>(kPetFrameWidth) * kPetFrameHeight;
  const auto* pixels =
      animation_row_pixels_ +
      static_cast<std::size_t>(frame_index % kPetAnimationRowFrames) *
          frame_pixels;
  canvas_.setSwapBytes(true);
  canvas_.pushImage(
      kPetSpriteArea.x,
      kPetSpriteArea.y,
      kPetFrameWidth,
      kPetFrameHeight,
      pixels,
      kPetTransparentColor);
  canvas_.setSwapBytes(false);
  return true;
}

bool Tab5Ui::drawBundledPet(const std::uint8_t frame_index) {
  if (!bundled_pet_ready_) return false;
  const auto row = std::min<std::uint8_t>(frame_index / 8, 8);
  const auto variant = frame_index % 8 >= 4 ? 1 : 0;
  char path[40]{};
  snprintf(path, sizeof(path), "/bundled-pet/r%uf%u.rle", row, variant);
  if (bundled_pet_cached_path_ != path) {
    auto file = SPIFFS.open(path, FILE_READ);
    if (!file || file.size() < 16 || file.size() > 160 * 1024) return false;
    bundled_pet_compressed_buffer_.resize(file.size());
    const auto read = file.read(
        bundled_pet_compressed_buffer_.data(),
        bundled_pet_compressed_buffer_.size());
    file.close();
    if (read != bundled_pet_compressed_buffer_.size()) {
      bundled_pet_buffer_.clear();
      bundled_pet_compressed_buffer_.clear();
      bundled_pet_cached_path_ = "";
      return false;
    }
    const auto* packed = bundled_pet_compressed_buffer_.data();
    const auto unpacked_size =
        static_cast<std::uint32_t>(packed[4]) |
        (static_cast<std::uint32_t>(packed[5]) << 8U) |
        (static_cast<std::uint32_t>(packed[6]) << 16U) |
        (static_cast<std::uint32_t>(packed[7]) << 24U);
    if (
        memcmp(packed, "CPZ1", 4) != 0 ||
        unpacked_size < 12 ||
        unpacked_size > 160U * 1'024U) {
      bundled_pet_buffer_.clear();
      bundled_pet_compressed_buffer_.clear();
      bundled_pet_cached_path_ = "";
      return false;
    }
    bundled_pet_buffer_.resize(unpacked_size);
    const auto decompressed = lgfx_tinfl_decompress_mem_to_mem(
        bundled_pet_buffer_.data(),
        bundled_pet_buffer_.size(),
        packed + 8,
        bundled_pet_compressed_buffer_.size() - 8,
        TINFL_FLAG_PARSE_ZLIB_HEADER);
    bundled_pet_compressed_buffer_.clear();
    if (decompressed != bundled_pet_buffer_.size()) {
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
  canvas_.setSwapBytes(true);
  canvas_.pushImage(
      36,
      108,
      kPetFrameWidth,
      kPetFrameHeight,
      frame_pixels_,
      kPetTransparentColor);
  canvas_.setSwapBytes(false);
  return true;
}

void Tab5Ui::drawFallbackPet(const Animation animation, const std::uint8_t frame) {
  const auto bob = static_cast<std::int16_t>(
      (animation == Animation::Jumping ? -42 : 0) + (frame % 2 == 0 ? 0 : -8));
  const auto cx = 228;
  const auto cy = 320 + bob;
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

void Tab5Ui::drawApproval(const Snapshot& snapshot) {
  const auto& approval = snapshot.approval;
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto panel = feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto raised =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto accent = feibi ? kFeibiRose : skadi ? kSkadiCoral : kOrange;
  const auto accept = feibi ? kFeibiGold : skadi ? kSkadiIce : kGreen;
  canvas_.fillRoundRect(48, 100, 1184, 584, feibi ? 28 : 22, panel);
  canvas_.drawRoundRect(48, 100, 1184, 584, feibi ? 28 : 22, accent);
  canvas_.setTextColor(accent, panel);
  canvas_.setTextSize(2);
  canvas_.drawString(String(approval.title.c_str()), 88, 140);
  canvas_.setTextSize(1);
  canvas_.setTextColor(text, panel);
  drawWrapped(String(approval.detail.c_str()), 88, 210, 1080, 2, 38);
  canvas_.setTextColor(muted, panel);
  drawWrapped(String(approval.reason.c_str()), 88, 304, 1080, 2, 34);
  canvas_.fillRoundRect(
      kDeclineButton.x, kDeclineButton.y,
      kDeclineButton.width, kDeclineButton.height, 14, raised);
  const auto safe = approvalCanAccept(approval);
  canvas_.fillRoundRect(
      kAcceptButton.x, kAcceptButton.y,
      kAcceptButton.width, kAcceptButton.height, 14, safe ? accept : raised);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextSize(2);
  canvas_.setTextColor(text, raised);
  canvas_.drawString("拒绝", kDeclineButton.x + kDeclineButton.width / 2,
                     kDeclineButton.y + kDeclineButton.height / 2);
  canvas_.setTextColor(
      safe ? (feibi ? kFeibiBackground : skadi ? kSkadiBackground : kBackground)
           : muted,
      safe ? accept : raised);
  canvas_.drawString(safe ? "仅允许本次" : "请在电脑确认",
                     kAcceptButton.x + kAcceptButton.width / 2,
                     kAcceptButton.y + kAcceptButton.height / 2);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawCompanionCommand(const Snapshot& snapshot) {
  const auto& companion = snapshot.companion;
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto panel = feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto raised =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto accent = feibi ? kFeibiRose : skadi ? kSkadiCoral : kOrange;
  const auto accept = feibi ? kFeibiGold : skadi ? kSkadiIce : kGreen;
  canvas_.fillRoundRect(48, 100, 1184, 584, feibi ? 28 : 22, panel);
  canvas_.drawRoundRect(48, 100, 1184, 584, feibi ? 28 : 22, accent);
  canvas_.setTextColor(accent, panel);
  canvas_.setTextSize(2);
  canvas_.drawString("执行这条语音命令？", 88, 140);
  canvas_.setTextSize(1);
  canvas_.setTextColor(text, panel);
  drawWrapped(
      String(companion.prompt.c_str()),
      88,
      210,
      1080,
      4,
      42);
  canvas_.setTextColor(muted, panel);
  canvas_.drawString("确认后才会创建 Codex 任务；敏感操作仍需再次审批", 88, 410);
  canvas_.fillRoundRect(
      kDeclineButton.x, kDeclineButton.y,
      kDeclineButton.width, kDeclineButton.height, 14, raised);
  canvas_.fillRoundRect(
      kAcceptButton.x, kAcceptButton.y,
      kAcceptButton.width, kAcceptButton.height, 14, accept);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextSize(2);
  canvas_.setTextColor(text, raised);
  canvas_.drawString(
      "取消",
      kDeclineButton.x + kDeclineButton.width / 2,
      kDeclineButton.y + kDeclineButton.height / 2);
  canvas_.setTextColor(
      feibi ? kFeibiBackground : skadi ? kSkadiBackground : kBackground,
      accept);
  canvas_.drawString(
      "确认执行",
      kAcceptButton.x + kAcceptButton.width / 2,
      kAcceptButton.y + kAcceptButton.height / 2);
  canvas_.setTextSize(1);
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::drawStatus(
    const Snapshot& snapshot,
    const std::uint64_t now_ms,
    const String& connection_detail) {
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto panel = feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto accent = feibi ? kFeibiGold : skadi ? kSkadiIce : kBlue;
  const auto connected_color =
      feibi ? kFeibiGold : skadi ? kSkadiIce : kGreen;
  const auto error_color =
      feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed;
  canvas_.fillRect(0, 0, kScreenWidth, 72, panel);
  if (skadi) {
    canvas_.fillTriangle(
        20, 36, 32, 23, 44, 36,
        snapshot.bridge_connected ? connected_color : error_color);
    canvas_.fillTriangle(
        20, 36, 32, 49, 44, 36,
        snapshot.bridge_connected ? connected_color : error_color);
    canvas_.drawLine(52, 14, 52, 58, kSkadiPanelLight);
    canvas_.setTextColor(kSkadiCoral, panel);
    canvas_.setTextSize(1);
    canvas_.drawString("SKADI // LINK", 62, 8);
  } else if (feibi) {
    const auto mark = snapshot.bridge_connected
        ? connected_color
        : error_color;
    canvas_.drawLine(20, 36, 44, 36, mark);
    canvas_.drawLine(32, 24, 32, 48, mark);
    canvas_.fillCircle(32, 36, 5, mark);
    canvas_.drawLine(52, 14, 52, 58, kFeibiBorder);
    canvas_.setTextColor(kFeibiRose, panel);
    canvas_.setTextSize(1);
    canvas_.drawString("FEIBI // LINK", 62, 8);
  } else {
    canvas_.fillCircle(
        32,
        36,
        12,
        snapshot.bridge_connected ? connected_color : error_color);
  }
  canvas_.setTextColor(stateColor(snapshot.state, skadi, feibi), panel);
  canvas_.setTextSize(2);
  canvas_.setTextDatum(middle_left);
  const String status_text = stateLabel(snapshot.state);
  canvas_.drawString(status_text, 62, skadi || feibi ? 42 : 36);
  const auto status_width = canvas_.textWidth(status_text);
  canvas_.setTextColor(muted, panel);
  canvas_.setTextSize(1);
  const auto detail_x = static_cast<std::int16_t>(
      62 + status_width + 24);
  const String detail = thread_detail_.visible && !thread_detail_.title.empty()
      ? String(thread_detail_.title.c_str())
      : snapshot.task_title.empty()
          ? connection_detail
          : String(snapshot.task_title.c_str());
  drawTruncated(detail, detail_x, 28, 872 - detail_x);

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
  canvas_.setTextColor(snapshot.bridge_connected ? accent : muted, panel);
  if (snapshot.telemetry.transport == TransportKind::Wifi) {
    canvas_.drawArc(transport_x, 37, 20, 17, 210, 330, accent);
    canvas_.drawArc(transport_x, 37, 12, 9, 215, 325, accent);
    canvas_.fillCircle(transport_x, 43, 3, accent);
  } else if (snapshot.telemetry.transport == TransportKind::Ble) {
    canvas_.drawLine(transport_x, 17, transport_x, 55, accent);
    canvas_.drawLine(transport_x, 17, transport_x + 14, 31, accent);
    canvas_.drawLine(transport_x + 14, 31, transport_x - 12, 49, accent);
    canvas_.drawLine(transport_x, 55, transport_x + 14, 41, accent);
    canvas_.drawLine(transport_x + 14, 41, transport_x - 12, 23, accent);
  } else {
    canvas_.drawLine(transport_x - 18, 38, transport_x + 10, 38, accent);
    canvas_.drawLine(transport_x + 10, 38, transport_x + 18, 30, accent);
    canvas_.drawLine(transport_x + 10, 38, transport_x + 18, 46, accent);
    canvas_.drawLine(transport_x + 18, 30, transport_x + 18, 24, accent);
    canvas_.fillCircle(transport_x + 18, 47, 3, accent);
  }
  canvas_.setTextDatum(middle_left);
  canvas_.setTextColor(muted, panel);
  canvas_.drawString(time_text, 940, 36);

  const auto battery = std::min<std::uint8_t>(snapshot.telemetry.battery_percent, 100);
  if (skadi) {
    canvas_.drawRoundRect(1150, 23, 72, 26, 10, kSkadiMuted);
    canvas_.fillTriangle(1222, 31, 1230, 36, 1222, 42, kSkadiMuted);
    const auto lit = static_cast<std::uint8_t>((battery + 19) / 20);
    for (std::uint8_t index = 0; index < 5; ++index) {
      canvas_.fillRoundRect(
          1155 + index * 13,
          29,
          9,
          14,
          3,
          index < lit
              ? (snapshot.telemetry.charging ? kSkadiCoral : kSkadiIce)
              : kSkadiPanelLight);
    }
    if (snapshot.telemetry.charging) {
      canvas_.fillTriangle(1140, 25, 1131, 38, 1140, 38, kSkadiPearl);
      canvas_.fillTriangle(1131, 38, 1141, 38, 1132, 51, kSkadiPearl);
    }
  } else if (feibi) {
    canvas_.drawRoundRect(1148, 22, 76, 28, 10, kFeibiCream);
    canvas_.fillCircle(1226, 36, 5, kFeibiCream);
    const auto lit = static_cast<std::uint8_t>((battery + 19) / 20);
    for (std::uint8_t index = 0; index < 5; ++index) {
      canvas_.fillRoundRect(
          1154 + index * 13,
          28,
          9,
          16,
          index % 2 == 0 ? 5 : 2,
          index < lit
              ? (snapshot.telemetry.charging ? kFeibiRose : kFeibiGold)
              : kFeibiPanelLight);
    }
    if (snapshot.telemetry.charging) {
      canvas_.fillTriangle(1138, 24, 1129, 38, 1139, 38, kFeibiCream);
      canvas_.fillTriangle(1129, 38, 1139, 38, 1131, 52, kFeibiCream);
    }
  } else {
    canvas_.drawRoundRect(1178, 25, 42, 22, 4, muted);
    canvas_.fillRect(1220, 31, 4, 10, muted);
    canvas_.fillRoundRect(
        1181,
        28,
        36 * battery / 100,
        16,
        2,
        snapshot.telemetry.charging ? connected_color : accent);
  }
  canvas_.setTextDatum(middle_right);
  canvas_.drawString(String(battery) + "%", 1264, 36);
  canvas_.setTextDatum(top_left);
  canvas_.setTextSize(1);
}

void Tab5Ui::drawQuota(const Snapshot& snapshot) {
  constexpr Rect panel{448, 88, 390, 130};
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto background =
      feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto raised =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto accent = feibi ? kFeibiGold : skadi ? kSkadiIce : kBlue;
  canvas_.fillRoundRect(
      panel.x, panel.y, panel.width, panel.height, 16, background);
  if (skadi) {
    canvas_.drawRoundRect(
        panel.x, panel.y, panel.width, panel.height, 16, kSkadiBlue);
    canvas_.fillTriangle(448, 88, 482, 88, 448, 122, kSkadiCoral);
  } else if (feibi) {
    canvas_.drawRoundRect(
        panel.x, panel.y, panel.width, panel.height, 20, kFeibiBorder);
    canvas_.fillCircle(470, 108, 8, kFeibiRose);
    canvas_.drawLine(458, 108, 482, 108, kFeibiGold);
    canvas_.drawLine(470, 96, 470, 120, kFeibiGold);
  }
  canvas_.setTextDatum(top_left);
  canvas_.setTextColor(muted, background);
  canvas_.setTextSize(1);
  canvas_.drawString(
      feibi ? "星愿额度 · WEEK" : skadi ? "潮汐额度 · WEEK" : "本周额度",
      feibi ? 490 : 470,
      106);
  const auto used = snapshot.quota.available ? snapshot.quota.used_percent : 0;
  const auto remaining = snapshot.quota.available ? 100 - used : 0;
  canvas_.setTextColor(
      snapshot.quota.available ? text : muted,
      background);
  canvas_.setTextSize(2);
  canvas_.drawString(
      snapshot.quota.available
          ? String(remaining) + "%"
          : "--",
      470,
      136);
  canvas_.setTextSize(1);
  canvas_.setTextColor(muted, background);
  if (snapshot.quota.available) {
    canvas_.drawString(
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
  canvas_.drawString(reset_text, 470, 178);
  canvas_.drawRoundRect(470, 198, 344, 10, 5, raised);
  canvas_.fillRoundRect(
      472,
      200,
      340 * used / 100,
      6,
      3,
      used >= 90
          ? (feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed)
          : accent);
  if (skadi) {
    for (std::int16_t x = 482; x < 808; x += 42) {
      canvas_.fillCircle(x, 203, 2, kSkadiPearl);
    }
  } else if (feibi) {
    for (std::int16_t x = 482; x < 808; x += 42) {
      canvas_.fillCircle(x, 203, 2, kFeibiCream);
    }
  }
}

void Tab5Ui::drawTokenSummary(const Snapshot& snapshot) {
  constexpr Rect panel{854, 88, 402, 130};
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto background =
      feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  canvas_.fillRoundRect(
      panel.x, panel.y, panel.width, panel.height, 16, background);
  if (skadi) {
    canvas_.drawRoundRect(
        panel.x, panel.y, panel.width, panel.height, 16, kSkadiBlue);
    canvas_.fillTriangle(1256, 88, 1222, 88, 1256, 122, kSkadiLavender);
    canvas_.drawCircle(1222, 182, 14, kSkadiIce);
    canvas_.drawLine(1213, 182, 1231, 182, kSkadiIce);
    canvas_.drawLine(1222, 173, 1222, 191, kSkadiIce);
  } else if (feibi) {
    canvas_.drawRoundRect(
        panel.x, panel.y, panel.width, panel.height, 20, kFeibiBorder);
    canvas_.fillTriangle(1256, 88, 1222, 88, 1256, 122, kFeibiRose);
    canvas_.drawLine(1208, 182, 1236, 182, kFeibiGold);
    canvas_.drawLine(1222, 168, 1222, 196, kFeibiGold);
    canvas_.fillCircle(1222, 182, 5, kFeibiCream);
  }
  canvas_.setTextDatum(top_left);
  canvas_.setTextColor(muted, background);
  canvas_.setTextSize(1);
  canvas_.drawString(
      feibi ? "RIBBON TOKEN · MEMORY"
            : skadi ? "PRT TOKEN · MEMORY" : "TOKEN",
      876,
      106);
  const auto task_tokens = snapshot.tokens.total;
  canvas_.setTextColor(text, background);
  canvas_.setTextSize(2);
  canvas_.drawString(compactNumber(task_tokens), 876, 136);
  canvas_.setTextSize(1);
  canvas_.setTextColor(muted, background);
  canvas_.drawString("当前任务", 1000, 146);
  canvas_.drawString(
      snapshot.account_tokens.today_available
          ? "今日 " + compactNumber(snapshot.account_tokens.today)
          : "今日 --",
      876,
      184);
  canvas_.drawString(
      "累计 " + compactNumber(snapshot.account_tokens.lifetime),
      1060,
      184);
}

void Tab5Ui::drawTaskList(
    const Snapshot& snapshot,
    const std::uint64_t now_ms) {
  constexpr Rect panel{448, 234, 808, 462};
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto background =
      feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto raised =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto project_accent =
      feibi ? kFeibiGold : skadi ? kSkadiIce : kBlue;
  const auto conversation_accent =
      feibi ? kFeibiRose : skadi ? kSkadiCoral : kGreen;
  canvas_.fillRoundRect(
      panel.x, panel.y, panel.width, panel.height, 16, background);
  if (skadi) {
    canvas_.drawRoundRect(
        panel.x, panel.y, panel.width, panel.height, 16, kSkadiBlue);
    canvas_.drawLine(468, 276, 1228, 276, kSkadiPanelLight);
  } else if (feibi) {
    canvas_.drawRoundRect(
        panel.x, panel.y, panel.width, panel.height, 20, kFeibiBorder);
    canvas_.drawLine(468, 276, 1228, 276, kFeibiPanelLight);
    canvas_.fillTriangle(448, 234, 486, 234, 448, 272, kFeibiRose);
  }
  canvas_.setTextDatum(top_left);
  canvas_.setTextColor(text, background);
  canvas_.setTextSize(1);
  canvas_.drawString(
      feibi ? "菲比手账" : skadi ? "任务海域" : "任务",
      470,
      252);
  canvas_.setTextColor(project_accent, background);
  canvas_.drawString(
      String(snapshot.task_counts.active) + " 个进行中",
      skadi || feibi ? 560 : 536,
      252);
  canvas_.setTextDatum(top_right);
  canvas_.setTextColor(muted, background);
  canvas_.drawString(
      (feibi ? "星光记录 " : skadi ? "潮汐记录 " : "显示 ") +
          String(snapshot.task_counts.visible) + "/" +
          String(snapshot.task_counts.total),
      1218,
      252);
  canvas_.setTextDatum(top_left);

  const auto maximum_scroll = std::max<std::int32_t>(
      0,
      static_cast<std::int32_t>(snapshot.tasks.size()) * kTaskRowHeight -
          kTaskListArea.height);
  task_scroll_pixels_ = static_cast<std::int16_t>(
      std::min<std::int32_t>(task_scroll_pixels_, maximum_scroll));
  if (snapshot.tasks.empty()) {
    canvas_.setTextColor(muted, background);
    canvas_.setTextDatum(middle_center);
    canvas_.drawString(
        feibi
            ? "手账空白 · 暂无项目与对话"
            : skadi
                ? "海面安静 · 暂无任务与对话"
                : "暂无任务 · Bridge 已连接",
        840,
        476);
    canvas_.setTextDatum(top_left);
    return;
  }

  const auto now_seconds = currentUnixSeconds(snapshot, now_ms);
  const auto first_index = static_cast<std::size_t>(
      task_scroll_pixels_ / kTaskRowHeight);
  const auto pixel_offset = task_scroll_pixels_ % kTaskRowHeight;
  const auto end = std::min<std::size_t>(
      snapshot.tasks.size(),
      first_index + kVisibleTaskRows + 1);
  canvas_.setClipRect(
      kTaskListArea.x,
      kTaskListArea.y,
      kTaskListArea.width,
      kTaskListArea.height);
  for (std::size_t index = first_index; index < end; ++index) {
    const auto& task = snapshot.tasks[index];
    const auto row = static_cast<std::int16_t>(index - first_index);
    const auto y = kTaskListArea.y + row * kTaskRowHeight - pixel_offset;
    const auto project = task.kind == ThreadKind::Project;
    const auto card = feibi
        ? (project ? kFeibiCard : kFeibiPanelLight)
        : skadi
            ? (project ? kSkadiCard : kSkadiPanelLight)
            : (index % 2 == 0 ? kPanelLight : kPanel);
    const auto card_accent = project ? project_accent : conversation_accent;
    canvas_.fillRoundRect(
        464,
        y,
        758,
        64,
        project ? (feibi ? 10 : 8) : (feibi ? 24 : 18),
        card);
    if (project) {
      canvas_.fillRect(464, y + 8, 7, 48, card_accent);
      canvas_.drawRect(478, y + 13, 22, 18, card_accent);
      canvas_.drawLine(481, y + 13, 486, y + 8, card_accent);
      canvas_.drawLine(486, y + 8, 494, y + 8, card_accent);
      canvas_.drawLine(494, y + 8, 498, y + 13, card_accent);
      if (feibi) {
        canvas_.fillTriangle(
            1176, y, 1222, y, 1222, y + 28, kFeibiGold);
      }
    } else {
      canvas_.fillRoundRect(476, y + 9, 24, 18, 7, card_accent);
      canvas_.fillTriangle(
          480, y + 25, 488, y + 25, 480, y + 32, card_accent);
    }
    canvas_.fillRoundRect(
        508, y + 8, project ? 48 : 56, 20, 7,
        feibi ? kFeibiPanel : skadi ? kSkadiPanel : card);
    canvas_.setTextDatum(middle_center);
    canvas_.setTextColor(
        card_accent,
        feibi ? kFeibiPanel : skadi ? kSkadiPanel : card);
    canvas_.drawString(project ? "项目" : "对话", project ? 532 : 536, y + 18);
    canvas_.setTextDatum(top_left);
    canvas_.setTextColor(text, card);
    canvas_.setTextSize(1);
    drawTruncated(String(task.title.c_str()), 574, y + 8, 410);
    canvas_.setTextDatum(top_right);
    canvas_.setTextColor(stateColor(task.state, skadi, feibi), card);
    canvas_.drawString(shortStateLabel(task.state), 1202, y + 10);
    canvas_.setTextColor(muted, card);
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
    canvas_.drawString(recency, 1202, y + 36);
    canvas_.setTextDatum(top_left);
    const String workspace(task.workspace.c_str());
    const String metadata =
        (project && !workspace.isEmpty() ? workspace + " · " : "") +
        compactNumber(task.tokens) + " tok";
    drawTruncated(metadata, 508, y + 36, 250);
    if (task.progress.known) {
      canvas_.drawRoundRect(784, y + 43, 170, 8, 4, muted);
      canvas_.fillRoundRect(
          786,
          y + 45,
          166 * task.progress.percent / 100,
          4,
          2,
          card_accent);
      canvas_.drawString(String(task.progress.percent) + "%", 964, y + 36);
    } else if (task.state == PresentationState::Running) {
      const auto phase = static_cast<std::int16_t>((now_ms / 40) % 120);
      canvas_.drawRoundRect(784, y + 43, 170, 8, 4, muted);
      canvas_.fillRoundRect(786 + phase, y + 45, 40, 4, 2, card_accent);
    }
  }
  canvas_.clearClipRect();

  if (maximum_scroll > 0) {
    constexpr std::int16_t track_y = 290;
    constexpr std::int16_t track_height = 360;
    const auto thumb_height = std::max<std::int16_t>(
        48,
        track_height * kTaskListArea.height /
            (snapshot.tasks.size() * kTaskRowHeight));
    const auto travel = track_height - thumb_height;
    const auto thumb_y = track_y +
        travel * task_scroll_pixels_ / std::max<std::int32_t>(maximum_scroll, 1);
    canvas_.fillRoundRect(1236, track_y, 6, track_height, 3, raised);
    canvas_.fillRoundRect(
        1236,
        thumb_y,
        6,
        thumb_height,
        3,
        feibi ? kFeibiGold : skadi ? kSkadiIce : kBlue);
  }
}

void Tab5Ui::drawThreadDetail(const Snapshot& snapshot) {
  constexpr Rect panel{448, 88, 808, 608};
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto background =
      feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto raised =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto project = thread_detail_.kind == ThreadKind::Project;
  const auto accent = feibi
      ? (project ? kFeibiGold : kFeibiRose)
      : skadi
          ? (project ? kSkadiIce : kSkadiCoral)
          : (project ? kBlue : kGreen);
  canvas_.fillRoundRect(
      panel.x, panel.y, panel.width, panel.height, 16, background);
  canvas_.drawRoundRect(
      panel.x,
      panel.y,
      panel.width,
      panel.height,
      feibi ? 20 : 16,
      feibi ? kFeibiBorder : skadi ? kSkadiBlue : raised);

  canvas_.fillRoundRect(
      kThreadBackButton.x,
      kThreadBackButton.y,
      kThreadBackButton.width,
      kThreadBackButton.height,
      14,
      raised);
  canvas_.drawLine(500, 127, 486, 127, text);
  canvas_.drawLine(486, 127, 496, 117, text);
  canvas_.drawLine(486, 127, 496, 137, text);
  canvas_.setTextDatum(middle_left);
  canvas_.setTextColor(text, raised);
  canvas_.drawString("返回", 510, 127);

  canvas_.fillRoundRect(578, 106, project ? 58 : 66, 22, 8, accent);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextColor(
      feibi ? kFeibiBackground : skadi ? kSkadiBackground : kBackground,
      accent);
  canvas_.drawString(project ? "项目" : "对话", project ? 607 : 611, 117);
  canvas_.setTextDatum(top_left);
  canvas_.setTextColor(text, background);
  drawTruncated(
      String(thread_detail_.title.c_str()),
      654,
      104,
      550);
  canvas_.setTextColor(muted, background);
  const String workspace(thread_detail_.workspace.c_str());
  const String count_text =
      "最近 " + String(thread_detail_.messages.size()) + "/" +
      String(thread_detail_.total_messages) +
      (thread_detail_.truncated ? " · 已精简" : "");
  drawTruncated(
      workspace.isEmpty() ? count_text : workspace + " · " + count_text,
      654,
      132,
      550);
  canvas_.drawLine(468, 158, 1234, 158, raised);
  if (feibi && project) {
    canvas_.fillTriangle(1192, 88, 1256, 88, 1256, 122, kFeibiGold);
  } else if (feibi) {
    canvas_.fillCircle(1222, 106, 12, kFeibiRose);
    canvas_.fillTriangle(1213, 114, 1222, 114, 1213, 124, kFeibiRose);
  }
  drawThreadMessages(snapshot);
}

void Tab5Ui::drawThreadMessages(const Snapshot& snapshot) {
  const auto skadi = isSkadiTheme(snapshot);
  const auto feibi = isFeibiTheme(snapshot);
  const auto background =
      feibi ? kFeibiPanel : skadi ? kSkadiPanel : kPanel;
  const auto raised =
      feibi ? kFeibiPanelLight : skadi ? kSkadiPanelLight : kPanelLight;
  const auto text = feibi ? kFeibiText : skadi ? kSkadiText : kText;
  const auto muted = feibi ? kFeibiMuted : skadi ? kSkadiMuted : kMuted;
  const auto project = thread_detail_.kind == ThreadKind::Project;
  const auto accent = feibi
      ? (project ? kFeibiGold : kFeibiRose)
      : skadi
          ? (project ? kSkadiIce : kSkadiCoral)
          : (project ? kBlue : kGreen);
  canvas_.fillRect(464, 170, 780, 500, background);
  if (thread_detail_.loading) {
    canvas_.setTextDatum(middle_center);
    canvas_.setTextColor(accent, background);
    canvas_.drawCircle(840, 370, 28, accent);
    canvas_.drawArc(840, 370, 28, 24, 310, 80, text);
    canvas_.drawString(
        feibi
            ? "正在翻开菲比手账…"
            : skadi ? "正在潜入会话海域…" : "正在读取会话…",
        840,
        426);
    canvas_.setTextDatum(top_left);
    return;
  }
  if (!thread_detail_.error.empty()) {
    canvas_.setTextDatum(middle_center);
    canvas_.setTextColor(
        feibi ? kFeibiRose : skadi ? kSkadiCoral : kRed,
        background);
    canvas_.drawString("会话读取失败", 840, 344);
    canvas_.setTextColor(muted, background);
    drawWrapped(
        String(thread_detail_.error.c_str()),
        610,
        382,
        460,
        3,
        24);
    canvas_.setTextDatum(top_left);
    return;
  }
  if (thread_detail_.messages.empty()) {
    canvas_.setTextDatum(middle_center);
    canvas_.setTextColor(muted, background);
    canvas_.drawString("这个会话还没有可显示的消息", 840, 398);
    canvas_.setTextDatum(top_left);
    return;
  }

  const auto maximum_scroll = std::max<std::int32_t>(
      0,
      static_cast<std::int32_t>(thread_detail_.messages.size()) *
              kDetailMessageRowHeight -
          kThreadDetailArea.height);
  detail_scroll_pixels_ = static_cast<std::int16_t>(
      std::min<std::int32_t>(detail_scroll_pixels_, maximum_scroll));
  canvas_.setClipRect(
      kThreadDetailArea.x,
      kThreadDetailArea.y,
      kThreadDetailArea.width,
      kThreadDetailArea.height);
  for (std::size_t index = 0;
       index < thread_detail_.messages.size();
       ++index) {
    const auto y = static_cast<std::int16_t>(
        kThreadDetailArea.y +
        index * kDetailMessageRowHeight -
        detail_scroll_pixels_);
    if (
        y + kDetailMessageRowHeight <= kThreadDetailArea.y ||
        y >= kThreadDetailArea.y + kThreadDetailArea.height) {
      continue;
    }
    const auto& message = thread_detail_.messages[index];
    const auto user = message.role == ConversationRole::User;
    const auto bubble_x = static_cast<std::int16_t>(user ? 626 : 476);
    const auto bubble_width = static_cast<std::int16_t>(user ? 590 : 650);
    const auto bubble = feibi
        ? (user ? kFeibiCard : kFeibiPanelLight)
        : skadi
            ? (user ? kSkadiCard : kSkadiPanelLight)
            : (user ? kPanelLight : kPanel);
    const auto bubble_accent = feibi
        ? (user ? kFeibiGold : kFeibiRose)
        : skadi
            ? (user ? kSkadiIce : kSkadiLavender)
            : (user ? kBlue : kGreen);
    canvas_.fillRoundRect(
        bubble_x,
        y + 5,
        bubble_width,
        112,
        feibi ? (user ? 22 : 14) : user ? 18 : 10,
        bubble);
    canvas_.drawRoundRect(
        bubble_x,
        y + 5,
        bubble_width,
        112,
        feibi ? (user ? 22 : 14) : user ? 18 : 10,
        bubble_accent);
    if (user) {
      canvas_.fillTriangle(
          bubble_x + bubble_width - 24,
          y + 111,
          bubble_x + bubble_width - 7,
          y + 111,
          bubble_x + bubble_width - 7,
          y + 122,
          bubble_accent);
    } else {
      canvas_.fillTriangle(
          bubble_x + 7,
          y + 111,
          bubble_x + 24,
          y + 111,
          bubble_x + 7,
          y + 122,
          bubble_accent);
    }
    canvas_.setTextColor(bubble_accent, bubble);
    canvas_.drawString(
        user
            ? (skadi ? "YOU // 博士" : "YOU // 指挥官")
            : feibi
                ? "FEIBI // CODEX"
                : skadi ? "SKADI // CODEX" : "CODEX // 助手",
        bubble_x + 16,
        y + 14);
    canvas_.setTextColor(text, bubble);
    drawWrapped(
        String(message.text.c_str()),
        bubble_x + 16,
        y + 39,
        bubble_width - 32,
        4,
        20);
  }
  canvas_.clearClipRect();

  if (maximum_scroll > 0) {
    constexpr std::int16_t track_y = 180;
    constexpr std::int16_t track_height = 470;
    const auto thumb_height = std::max<std::int16_t>(
        48,
        track_height * kThreadDetailArea.height /
            (thread_detail_.messages.size() * kDetailMessageRowHeight));
    const auto thumb_y = static_cast<std::int16_t>(
        track_y +
        (track_height - thumb_height) * detail_scroll_pixels_ /
            std::max<std::int32_t>(maximum_scroll, 1));
    canvas_.fillRoundRect(1236, track_y, 6, track_height, 3, raised);
    canvas_.fillRoundRect(1236, thumb_y, 6, thumb_height, 3, accent);
  }
  canvas_.setTextDatum(top_left);
}

void Tab5Ui::pushCanvasRegion(const Rect& bounds) {
  if (region_pixels_ == nullptr || bounds.width > kRegionBufferWidth) return;
  M5.Display.startWrite();
  for (std::int16_t offset = 0; offset < bounds.height; offset += kRegionChunkRows) {
    const auto rows = static_cast<std::int16_t>(
        std::min<std::int32_t>(kRegionChunkRows, bounds.height - offset));
    canvas_.readRect(
        bounds.x,
        bounds.y + offset,
        bounds.width,
        rows,
        region_pixels_);
    M5.Display.pushImage(
        bounds.x,
        bounds.y + offset,
        bounds.width,
        rows,
        region_pixels_);
  }
  M5.Display.endWrite();
}

void Tab5Ui::pushScrolledCanvasRegion(
    const Rect& bounds,
    const std::int16_t previous_scroll,
    const std::int16_t current_scroll,
    const Rect& scrollbar) {
  const auto delta = static_cast<std::int32_t>(current_scroll) -
      static_cast<std::int32_t>(previous_scroll);
  const auto distance = std::abs(delta);
  if (
      previous_scroll < 0 ||
      distance == 0 ||
      distance >= bounds.height / 2) {
    pushCanvasRegion(bounds);
    pushCanvasRegion(scrollbar);
    return;
  }

  Rect exposed = bounds;
  if (delta > 0) {
    M5.Display.copyRect(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height - distance,
        bounds.x,
        bounds.y + distance);
    exposed.y = static_cast<std::int16_t>(
        bounds.y + bounds.height - distance);
    exposed.height = static_cast<std::int16_t>(distance);
  } else {
    M5.Display.copyRect(
        bounds.x,
        bounds.y + distance,
        bounds.width,
        bounds.height - distance,
        bounds.x,
        bounds.y);
    exposed.height = static_cast<std::int16_t>(distance);
  }
  pushCanvasRegion(exposed);
  pushCanvasRegion(scrollbar);
}

void Tab5Ui::drawChevron(
    const Rect& bounds,
    const bool points_right,
    const std::uint16_t color) {
  const auto cx = bounds.x + bounds.width / 2;
  const auto cy = bounds.y + bounds.height / 2;
  const auto direction = points_right ? 1 : -1;
  canvas_.drawLine(
      cx - 8 * direction,
      cy - 11,
      cx + 6 * direction,
      cy,
      color);
  canvas_.drawLine(
      cx + 6 * direction,
      cy,
      cx - 8 * direction,
      cy + 11,
      color);
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
  if (width <= 0) return;
  if (canvas_.textWidth(text) <= width) {
    canvas_.drawString(text, x, y);
    return;
  }
  constexpr const char* suffix = "...";
  const auto available = std::max<std::int16_t>(
      0,
      width - canvas_.textWidth(suffix));
  String fitted;
  for (std::size_t index = 0; index < text.length();) {
    const auto bytes = std::min(
        utf8CharacterLength(text[index]),
        text.length() - index);
    const auto next = fitted + text.substring(index, index + bytes);
    if (canvas_.textWidth(next) > available) break;
    fitted = next;
    index += bytes;
  }
  canvas_.drawString(fitted + suffix, x, y);
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
