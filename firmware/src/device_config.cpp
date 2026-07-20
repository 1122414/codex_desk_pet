#include "device_config.hpp"

#include <ESP.h>
#include <esp_system.h>

namespace codex::firmware {

bool DeviceConfigStore::begin() {
  open_ = preferences_.begin("codex-desk", false);
  if (!open_) {
    return false;
  }
  config_.device_id = preferences_.getString("device_id");
  if (config_.device_id.isEmpty()) {
    config_.device_id = makeDeviceId();
    if (!writeString("device_id", config_.device_id)) {
      return false;
    }
  }
  config_.setup_code = preferences_.getString("setup_code");
  if (config_.setup_code.length() != 6) {
    config_.setup_code = makeSetupCode();
    if (!writeString("setup_code", config_.setup_code)) {
      return false;
    }
  }
  config_.wifi_ssid = preferences_.getString("wifi_ssid");
  config_.wifi_password = preferences_.getString("wifi_pass");
  config_.bridge_host = preferences_.getString("bridge_host");
  config_.bridge_port = preferences_.getUShort("bridge_port", 4318);
  config_.pairing_secret = preferences_.getString("pair_secret");
  return true;
}

const DeviceConfig& DeviceConfigStore::config() const {
  return config_;
}

bool DeviceConfigStore::saveNetwork(
    const String& ssid,
    const String& password,
    const String& bridge_host,
    const std::uint16_t bridge_port) {
  if (!open_ || ssid.isEmpty() || ssid.length() > 32 ||
      password.length() > 64 || bridge_host.isEmpty() ||
      bridge_host.length() > 253 || bridge_port == 0) {
    return false;
  }
  if (!writeString("wifi_ssid", ssid) ||
      !writeString("wifi_pass", password) ||
      !writeString("bridge_host", bridge_host) ||
      preferences_.putUShort("bridge_port", bridge_port) != sizeof(bridge_port)) {
    return false;
  }
  config_.wifi_ssid = ssid;
  config_.wifi_password = password;
  config_.bridge_host = bridge_host;
  config_.bridge_port = bridge_port;
  return true;
}

bool DeviceConfigStore::savePairingSecret(const String& secret) {
  if (!open_ || secret.length() != 64) {
    return false;
  }
  for (std::size_t index = 0; index < secret.length(); ++index) {
    const auto character = secret[index];
    if (!isHexadecimalDigit(character) ||
        (character >= 'A' && character <= 'F')) {
      return false;
    }
  }
  if (!writeString("pair_secret", secret)) {
    return false;
  }
  config_.pairing_secret = secret;
  return true;
}

bool DeviceConfigStore::clearNetwork() {
  if (!open_) {
    return false;
  }
  preferences_.remove("wifi_ssid");
  preferences_.remove("wifi_pass");
  preferences_.remove("bridge_host");
  preferences_.remove("bridge_port");
  config_.wifi_ssid = "";
  config_.wifi_password = "";
  config_.bridge_host = "";
  config_.bridge_port = 4318;
  return true;
}

bool DeviceConfigStore::clearPairing() {
  if (!open_) return false;
  preferences_.remove("pair_secret");
  config_.pairing_secret = "";
  return true;
}

String DeviceConfigStore::makeDeviceId() const {
  const auto mac = ESP.getEfuseMac();
  char value[24]{};
  snprintf(
      value,
      sizeof(value),
      "core-s3-%08lx",
      static_cast<unsigned long>(mac & 0xffffffffULL));
  return String(value);
}

String DeviceConfigStore::makeSetupCode() const {
  char value[7]{};
  snprintf(
      value,
      sizeof(value),
      "%06lu",
      static_cast<unsigned long>(esp_random() % 1'000'000U));
  return String(value);
}

bool DeviceConfigStore::writeString(const char* key, const String& value) {
  return preferences_.putString(key, value) == value.length();
}

}  // namespace codex::firmware
