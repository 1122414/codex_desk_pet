#pragma once

#include <Arduino.h>
#include <M5Unified.h>

#include <cstdint>

#include "codex_core/animation.hpp"
#include "codex_core/input.hpp"
#include "codex_core/types.hpp"
#include "pet_store.hpp"

namespace codex::firmware {

enum class UiActionType : std::uint8_t {
  None,
  PreviousPet,
  NextPet,
  AcceptApproval,
  DeclineApproval,
  SubmitPairingCode,
};

struct UiAction {
  UiActionType type = UiActionType::None;
  String value;
};

class Tab5Ui {
 public:
  bool begin(PetStore& pet_store, const String& device_id, const String& setup_code);
  UiAction poll(const Snapshot& snapshot, std::uint64_t now_ms, bool paired);
  void render(
      const Snapshot& snapshot,
      std::uint64_t now_ms,
      bool paired,
      const String& connection_detail,
      std::uint8_t transfer_progress);
  bool approvalCanAccept(const Approval& approval) const;

 private:
  UiAction pollTouch(const Snapshot& snapshot, std::uint64_t now_ms, bool paired);
  UiAction mapInputAction(const InputAction& action);
  UiAction pairingTouch(Point point, TouchPhase phase);
  void drawPairingCode();
  void drawNormal(
      const Snapshot& snapshot,
      std::uint64_t now_ms,
      const String& connection_detail,
      std::uint8_t transfer_progress);
  void drawPairing(const String& connection_detail);
  void drawPet(const Snapshot& snapshot, std::uint64_t now_ms);
  bool drawBundledPet(std::uint8_t frame_index);
  void drawFallbackPet(Animation animation, std::uint8_t frame);
  void drawApproval(const Approval& approval);
  void drawStatus(
      const Snapshot& snapshot,
      std::uint64_t now_ms,
      const String& connection_detail);
  void drawQuota(const Snapshot& snapshot);
  void drawTokenSummary(const Snapshot& snapshot);
  void drawTaskList(const Snapshot& snapshot, std::uint64_t now_ms);
  void drawChevron(const Rect& bounds, bool points_right);
  void drawTruncated(const String& text, std::int16_t x, std::int16_t y, std::int16_t width);
  void drawWrapped(
      const String& text,
      std::int16_t x,
      std::int16_t y,
      std::int16_t width,
      std::uint8_t maximum_lines,
      std::int16_t line_height);
  std::uint8_t frameIndex(const Snapshot& snapshot, std::uint64_t now_ms);
  std::uint64_t currentUnixSeconds(
      const Snapshot& snapshot,
      std::uint64_t now_ms);

  static constexpr std::int16_t kScreenWidth = 1280;
  static constexpr std::int16_t kScreenHeight = 720;
  static constexpr Rect kPetArea{24, 88, 408, 608};
  static constexpr Rect kPreviousPetButton{44, 636, 64, 44};
  static constexpr Rect kNextPetButton{348, 636, 64, 44};
  static constexpr Rect kTaskListArea{464, 288, 758, 390};
  static constexpr Rect kDeclineButton{540, 554, 292, 104};
  static constexpr Rect kAcceptButton{864, 554, 356, 104};
  static constexpr InputLayout kInputLayout{
      kPetArea,
      kDeclineButton,
      kAcceptButton,
      {228, 320},
      96,
  };

  PetStore* pet_store_ = nullptr;
  std::uint16_t* frame_pixels_ = nullptr;
  std::vector<std::uint8_t> bundled_pet_buffer_;
  String bundled_pet_cached_path_;
  bool bundled_pet_ready_ = false;
  AnimationPlayer animation_player_;
  InputController input_{kInputLayout};
  Point last_touch_{};
  bool touch_active_ = false;
  bool task_touch_active_ = false;
  std::int16_t task_touch_start_y_ = 0;
  std::uint8_t task_scroll_start_ = 0;
  std::uint8_t task_scroll_offset_ = 0;
  bool pairing_touch_latched_ = false;
  std::uint64_t pairing_released_at_ = 0;
  std::uint64_t clock_received_at_ms_ = 0;
  std::uint64_t last_clock_unix_ms_ = 0;
  String pairing_code_;
  String device_id_;
  String setup_code_;
  float look_degrees_ = 0.0F;
  std::uint64_t look_until_ = 0;
  std::uint64_t last_rendered_at_ = 0;
  bool pairing_screen_rendered_ = false;
  String rendered_pairing_code_;
  String rendered_connection_detail_;
};

}  // namespace codex::firmware
