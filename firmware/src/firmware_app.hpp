#pragma once

#include <Arduino.h>

#include <array>

#include "codex_core/model.hpp"
#include "tab5_ui.hpp"
#include "device_audio.hpp"
#include "device_camera.hpp"
#include "device_config.hpp"
#include "device_protocol.hpp"
#include "device_voice.hpp"
#include "pet_store.hpp"
#include "transports/ble_transport.hpp"
#include "transports/usb_transport.hpp"
#include "transports/wifi_transport.hpp"

namespace codex::firmware {

class FirmwareApp {
 public:
  void setup();
  void loop();

 private:
  void configureProtocol(DeviceProtocolClient& client);
  bool captureWithReleasedStorage(
      DeviceProtocolClient& client,
      String& error);
  bool handleDeviceCommand(
      DeviceProtocolClient& client,
      const String& command,
      JsonObjectConst payload,
      JsonObject result,
      String& error);
  void handleSnapshot(const Snapshot& snapshot);
  void handleProtocolEvent(
      DeviceProtocolClient& client,
      const String& type,
      JsonObjectConst payload);
  void startPendingCareListening();
  void startPendingPhoneListening();
  void endPhoneCall();
  void handleUiAction(const UiAction& action);
  void updateTelemetry(std::uint64_t now_ms);
  void syncClock(std::uint64_t now_ms);
  void requestSelectedPet(std::uint64_t now_ms);
  void selectPetOffset(int offset);
  void applyPairingSecret(
      const String& secret,
      DeviceProtocolClient* source_client);
  void updateConnectionState();
  DeviceProtocolClient* primaryClient();
  TransportKind primaryTransport() const;
  bool paired() const;

  DeviceConfigStore config_store_;
  PetStore pet_store_;
  DeviceAudio audio_;
  DeviceCamera camera_;
  DeviceVoice voice_;
  Tab5Ui ui_;
  UsbTransport usb_transport_;
  WifiTransport wifi_transport_;
  BleTransport ble_transport_;
  DeviceProtocolClient usb_client_;
  DeviceProtocolClient wifi_client_;
  DeviceProtocolClient ble_client_;
  DeskModel model_;
  Telemetry local_telemetry_;
  std::array<std::int16_t, DeviceAudio::kRemoteChunkSamples> remote_speech_samples_{};
  String pairing_secret_;
  String connection_detail_ = "正在启动";
  String requested_pet_;
  std::uint64_t requested_at_ = 0;
  std::uint64_t pet_request_not_before_ = 0;
  std::uint64_t last_telemetry_at_ = 0;
  std::uint64_t last_clock_check_at_ = 0;
  bool ntp_started_ = false;
  bool rtc_synced_ = false;
  bool have_local_telemetry_ = false;
  bool pending_care_listen_ = false;
  std::uint8_t pending_care_listen_seconds_ = 20;
  DeviceProtocolClient* pending_care_client_ = nullptr;
  bool pending_phone_listen_ = false;
  std::uint8_t pending_phone_listen_seconds_ = 20;
  DeviceProtocolClient* pending_phone_client_ = nullptr;
  bool phone_call_active_ = false;
  bool care_animation_override_ = false;
  Animation care_animation_ = Animation::Idle;
  std::uint64_t wifi_reboot_at_ = 0;
};

}  // namespace codex::firmware
