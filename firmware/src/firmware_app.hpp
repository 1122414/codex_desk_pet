#pragma once

#include <Arduino.h>

#include "codex_core/model.hpp"
#include "tab5_ui.hpp"
#include "device_audio.hpp"
#include "device_config.hpp"
#include "device_protocol.hpp"
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
  bool handleDeviceCommand(
      DeviceProtocolClient& client,
      const String& command,
      JsonObjectConst payload,
      String& error);
  void handleSnapshot(const Snapshot& snapshot);
  void handleProtocolEvent(const String& type, JsonObjectConst payload);
  void handleUiAction(const UiAction& action);
  void updateTelemetry(std::uint64_t now_ms);
  void syncClock(std::uint64_t now_ms);
  void requestSelectedPet(std::uint64_t now_ms);
  void selectPetOffset(int offset);
  void applyPairingSecret(const String& secret);
  void updateConnectionState();
  DeviceProtocolClient* primaryClient();
  TransportKind primaryTransport() const;
  bool paired() const;

  DeviceConfigStore config_store_;
  PetStore pet_store_;
  DeviceAudio audio_;
  Tab5Ui ui_;
  UsbTransport usb_transport_;
  WifiTransport wifi_transport_;
  BleTransport ble_transport_;
  DeviceProtocolClient usb_client_;
  DeviceProtocolClient wifi_client_;
  DeviceProtocolClient ble_client_;
  DeskModel model_;
  Telemetry local_telemetry_;
  String pairing_secret_;
  String connection_detail_ = "正在启动";
  String requested_pet_;
  std::uint64_t requested_at_ = 0;
  std::uint64_t last_telemetry_at_ = 0;
  std::uint64_t last_clock_check_at_ = 0;
  PresentationState last_cued_state_ = PresentationState::Ready;
  bool have_cued_state_ = false;
  bool ntp_started_ = false;
  bool rtc_synced_ = false;
  bool have_local_telemetry_ = false;
  std::uint64_t wifi_reboot_at_ = 0;
};

}  // namespace codex::firmware
