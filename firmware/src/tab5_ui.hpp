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
  void drawFallbackPet(Animation animation, std::uint8_t frame);
  void drawApproval(const Approval& approval);
  void drawStatus(const Snapshot& snapshot, const String& connection_detail);
  void drawTruncated(const String& text, std::int16_t x, std::int16_t y, std::int16_t width);
  void drawWrapped(
      const String& text,
      std::int16_t x,
      std::int16_t y,
      std::int16_t width,
      std::uint8_t maximum_lines,
      std::int16_t line_height);
  std::uint8_t frameIndex(const Snapshot& snapshot, std::uint64_t now_ms);

  static constexpr std::int16_t kScreenWidth = 1280;
  static constexpr std::int16_t kScreenHeight = 720;
  static constexpr Rect kPetArea{48, 104, 448, 496};
  static constexpr Rect kPreviousPetButton{48, 616, 208, 72};
  static constexpr Rect kNextPetButton{288, 616, 208, 72};
  static constexpr Rect kDeclineButton{540, 554, 292, 104};
  static constexpr Rect kAcceptButton{864, 554, 356, 104};
  static constexpr InputLayout kInputLayout{
      kPetArea,
      kDeclineButton,
      kAcceptButton,
      {272, 352},
      96,
  };

  PetStore* pet_store_ = nullptr;
  M5Canvas canvas_{&M5.Display};
  std::uint16_t* frame_pixels_ = nullptr;
  AnimationPlayer animation_player_;
  InputController input_{kInputLayout};
  Point last_touch_{};
  bool touch_active_ = false;
  bool pairing_touch_latched_ = false;
  std::uint64_t pairing_released_at_ = 0;
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
