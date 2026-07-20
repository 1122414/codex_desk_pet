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

class CoreS3Ui {
 public:
  bool begin(PetStore& pet_store, const String& device_id, const String& setup_code);
  UiAction poll(const Snapshot& snapshot, std::uint64_t now_ms, bool paired);
  void render(
      const Snapshot& snapshot,
      std::uint64_t now_ms,
      bool paired,
      const String& connection_detail,
      std::uint8_t transfer_progress);
  void playStateCue(PresentationState state);
  bool approvalCanAccept(const Approval& approval) const;

 private:
  struct DebouncedButton {
    std::uint8_t pin = 0;
    bool stable = true;
    bool observed = true;
    std::uint64_t changed_at = 0;
  };

  UiAction pollTouch(const Snapshot& snapshot, std::uint64_t now_ms, bool paired);
  UiAction pollButtons(const Snapshot& snapshot, std::uint64_t now_ms, bool paired);
  UiAction mapInputAction(const InputAction& action);
  bool buttonPressed(DebouncedButton& button, std::uint64_t now_ms);
  UiAction pairingTouch(Point point, TouchPhase phase);
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
  std::uint8_t frameIndex(const Snapshot& snapshot, std::uint64_t now_ms);

  static constexpr std::uint8_t kLeftButtonPin = 9;
  static constexpr std::uint8_t kRightButtonPin = 8;
  static constexpr std::uint64_t kDebounceMs = 35;

  PetStore* pet_store_ = nullptr;
  M5Canvas canvas_{&M5.Display};
  std::uint16_t* frame_pixels_ = nullptr;
  AnimationPlayer animation_player_;
  InputController input_;
  DebouncedButton left_button_{kLeftButtonPin};
  DebouncedButton right_button_{kRightButtonPin};
  Point last_touch_{};
  bool touch_active_ = false;
  String pairing_code_;
  String device_id_;
  String setup_code_;
  float look_degrees_ = 0.0F;
  std::uint64_t look_until_ = 0;
  std::uint64_t last_rendered_at_ = 0;
};

}  // namespace codex::firmware
