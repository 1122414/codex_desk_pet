#pragma once

#include <Arduino.h>
#include <Preferences.h>

#include <cstdint>

namespace codex::firmware {

struct DeviceConfig {
  String device_id;
  String setup_code;
  String wifi_ssid;
  String wifi_password;
  String bridge_host;
  std::uint16_t bridge_port = 4318;
  String pairing_secret;
};

class DeviceConfigStore {
 public:
  bool begin();
  const DeviceConfig& config() const;
  bool saveNetwork(
      const String& ssid,
      const String& password,
      const String& bridge_host,
      std::uint16_t bridge_port);
  bool savePairingSecret(const String& secret);
  bool clearNetwork();
  bool clearPairing();
  bool rotateSetupCode();

 private:
  String makeDeviceId() const;
  String makeSetupCode() const;
  bool writeString(const char* key, const String& value);

  Preferences preferences_;
  DeviceConfig config_;
  bool open_ = false;
};

}  // namespace codex::firmware
