#include "transports/ble_transport.hpp"

#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLESecurity.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <cstring>
#include <string>

namespace codex::firmware {
namespace {

constexpr std::uint8_t kProtocolVersion = 3;

std::uint16_t readU16(const std::uint8_t* value) {
  return static_cast<std::uint16_t>(
      (static_cast<std::uint16_t>(value[0]) << 8U) | value[1]);
}

std::uint32_t readU32(const std::uint8_t* value) {
  return
      (static_cast<std::uint32_t>(value[0]) << 24U) |
      (static_cast<std::uint32_t>(value[1]) << 16U) |
      (static_cast<std::uint32_t>(value[2]) << 8U) |
      static_cast<std::uint32_t>(value[3]);
}

void writeU16(std::uint8_t* value, const std::uint16_t data) {
  value[0] = static_cast<std::uint8_t>(data >> 8U);
  value[1] = static_cast<std::uint8_t>(data & 0xffU);
}

void writeU32(std::uint8_t* value, const std::uint32_t data) {
  value[0] = static_cast<std::uint8_t>(data >> 24U);
  value[1] = static_cast<std::uint8_t>((data >> 16U) & 0xffU);
  value[2] = static_cast<std::uint8_t>((data >> 8U) & 0xffU);
  value[3] = static_cast<std::uint8_t>(data & 0xffU);
}

std::array<std::uint8_t, 8> tokenFor(
    const std::uint8_t* data,
    const std::size_t length) {
  std::array<std::uint8_t, 32> digest{};
  mbedtls_sha256_ret(data, length, digest.data(), 0);
  std::array<std::uint8_t, 8> token{};
  std::copy_n(digest.begin(), token.size(), token.begin());
  return token;
}

class ServerCallbacks final : public BLEServerCallbacks {
 public:
  explicit ServerCallbacks(BleTransport* owner) : owner_(owner) {}

  void onConnect(BLEServer*) override {
    owner_->setConnected(true);
  }

  void onDisconnect(BLEServer* server) override {
    owner_->setConnected(false);
    server->startAdvertising();
  }

 private:
  BleTransport* owner_;
};

class RxCallbacks final : public BLECharacteristicCallbacks {
 public:
  explicit RxCallbacks(BleTransport* owner) : owner_(owner) {}

  void onWrite(BLECharacteristic* characteristic) override {
    const auto value = characteristic->getValue();
    if (!value.empty()) {
      owner_->acceptFragment(
          reinterpret_cast<const std::uint8_t*>(value.data()),
          value.size());
    }
  }

 private:
  BleTransport* owner_;
};

class ProvisionCallbacks final : public BLECharacteristicCallbacks {
 public:
  explicit ProvisionCallbacks(BleTransport* owner) : owner_(owner) {}

  void onWrite(BLECharacteristic* characteristic) override {
    const auto value = characteristic->getValue();
    if (!value.empty() && value.size() <= 512) {
      owner_->acceptProvisioning(String(value.c_str()));
    }
  }

 private:
  BleTransport* owner_;
};

}  // namespace

void BleTransport::begin(
    const String& device_name,
    const String& setup_code) {
  BLEDevice::init(device_name.c_str());
  BLEDevice::setMTU(kMtuBytes + 3);
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT_MITM);
  auto* security = new BLESecurity();
  security->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  security->setKeySize(16);
  security->setInitEncryptionKey(
      ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  security->setRespEncryptionKey(
      ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  security->setStaticPIN(
      static_cast<std::uint32_t>(setup_code.toInt()));
  server_ = BLEDevice::createServer();
  server_->setCallbacks(new ServerCallbacks(this));
  auto* service = server_->createService(kServiceUuid);
  auto* rx = service->createCharacteristic(
      kRxUuid,
      BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_WRITE_NR);
  tx_ = service->createCharacteristic(
      kTxUuid,
      BLECharacteristic::PROPERTY_NOTIFY);
  auto* provision = service->createCharacteristic(
      kProvisionUuid,
      BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_WRITE_NR);
  const auto write_permissions = static_cast<esp_gatt_perm_t>(
      ESP_GATT_PERM_WRITE_ENCRYPTED |
      ESP_GATT_PERM_WRITE_ENC_MITM);
  const auto read_permissions = static_cast<esp_gatt_perm_t>(
      ESP_GATT_PERM_READ_ENCRYPTED |
      ESP_GATT_PERM_READ_ENC_MITM);
  rx->setAccessPermissions(write_permissions);
  provision->setAccessPermissions(write_permissions);
  tx_->setAccessPermissions(read_permissions);
  rx->setCallbacks(new RxCallbacks(this));
  provision->setCallbacks(new ProvisionCallbacks(this));
  auto* notifications = new BLE2902();
  notifications->setAccessPermissions(static_cast<esp_gatt_perm_t>(
      ESP_GATT_PERM_READ_ENCRYPTED |
      ESP_GATT_PERM_WRITE_ENCRYPTED |
      ESP_GATT_PERM_READ_ENC_MITM |
      ESP_GATT_PERM_WRITE_ENC_MITM));
  tx_->addDescriptor(notifications);
  service->start();
  auto* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setScanResponse(true);
  advertising->start();
}

const char* BleTransport::kind() const {
  return "ble";
}

bool BleTransport::connected() const {
  return connected_;
}

void BleTransport::poll(const MessageHandler& handler) {
  handler_ = handler;
  if (assembly_.active && millis() - assembly_.updated_at >= 10'000U) {
    resetAssembly();
  }
}

bool BleTransport::sendText(const String& message) {
  if (!connected_ || tx_ == nullptr || message.isEmpty() ||
      message.length() > kMaximumEnvelopeBytes) {
    return false;
  }
  notifyFragments(message);
  return true;
}

void BleTransport::close() {
  connected_ = false;
  resetAssembly();
  if (server_ != nullptr) {
    server_->getAdvertising()->stop();
  }
}

bool BleTransport::takeProvisioningMessage(String& message) {
  if (!provisioning_pending_) {
    return false;
  }
  message = provisioning_message_;
  provisioning_message_ = "";
  provisioning_pending_ = false;
  return true;
}

void BleTransport::acceptFragment(
    const std::uint8_t* data,
    const std::size_t length) {
  if (data == nullptr || length <= kHeaderBytes ||
      data[0] != kProtocolVersion) {
    return;
  }
  std::array<std::uint8_t, 8> token{};
  std::copy_n(data + 1, token.size(), token.begin());
  const auto index = readU16(data + 9);
  const auto total = readU16(data + 11);
  const auto total_bytes = readU32(data + 13);
  if (total == 0 || index >= total || total > 128 ||
      total_bytes == 0 || total_bytes > kMaximumEnvelopeBytes) {
    resetAssembly();
    return;
  }
  if (!assembly_.active || assembly_.token != token) {
    resetAssembly();
    assembly_.active = true;
    assembly_.token = token;
    assembly_.total = total;
    assembly_.total_bytes = total_bytes;
    assembly_.parts.resize(total);
    assembly_.received.assign(total, false);
  }
  if (assembly_.total != total || assembly_.total_bytes != total_bytes) {
    resetAssembly();
    return;
  }
  const auto payload_length = length - kHeaderBytes;
  auto& part = assembly_.parts[index];
  if (assembly_.received[index] &&
      (part.size() != payload_length ||
       !std::equal(part.begin(), part.end(), data + kHeaderBytes))) {
    resetAssembly();
    return;
  }
  part.assign(data + kHeaderBytes, data + length);
  assembly_.received[index] = true;
  assembly_.updated_at = millis();
  if (std::all_of(
          assembly_.received.begin(),
          assembly_.received.end(),
          [](const bool received) { return received; })) {
    verifyAndDispatch();
  }
}

void BleTransport::acceptProvisioning(const String& value) {
  if (value.length() > 512) {
    return;
  }
  provisioning_message_ = value;
  provisioning_pending_ = true;
}

void BleTransport::setConnected(const bool connected) {
  connected_ = connected;
  if (!connected_) {
    resetAssembly();
  }
}

void BleTransport::resetAssembly() {
  assembly_ = {};
}

void BleTransport::notifyFragments(const String& message) {
  const auto* data =
      reinterpret_cast<const std::uint8_t*>(message.c_str());
  const auto bytes = message.length();
  const auto payload_bytes = kMtuBytes - kHeaderBytes;
  const auto total = static_cast<std::uint16_t>(
      (bytes + payload_bytes - 1) / payload_bytes);
  const auto token = tokenFor(data, bytes);
  for (std::uint16_t index = 0; index < total; ++index) {
    const auto offset = static_cast<std::size_t>(index) * payload_bytes;
    const auto part_bytes = std::min(payload_bytes, bytes - offset);
    std::vector<std::uint8_t> fragment(kHeaderBytes + part_bytes);
    fragment[0] = kProtocolVersion;
    std::copy(token.begin(), token.end(), fragment.begin() + 1);
    writeU16(fragment.data() + 9, index);
    writeU16(fragment.data() + 11, total);
    writeU32(
        fragment.data() + 13,
        static_cast<std::uint32_t>(bytes));
    std::copy_n(data + offset, part_bytes, fragment.begin() + kHeaderBytes);
    tx_->setValue(fragment.data(), fragment.size());
    tx_->notify();
    delay(2);
  }
}

bool BleTransport::verifyAndDispatch() {
  std::vector<std::uint8_t> message;
  message.reserve(assembly_.total_bytes);
  for (const auto& part : assembly_.parts) {
    message.insert(message.end(), part.begin(), part.end());
  }
  const auto valid =
      message.size() == assembly_.total_bytes &&
      tokenFor(message.data(), message.size()) == assembly_.token;
  if (valid && handler_) {
    String text;
    if (text.reserve(message.size())) {
      for (const auto value : message) {
        text += static_cast<char>(value);
      }
      handler_(text);
    }
  }
  resetAssembly();
  return valid;
}

}  // namespace codex::firmware
