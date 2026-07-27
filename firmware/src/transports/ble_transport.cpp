#include "transports/ble_transport.hpp"

#include <BLEAdvertising.h>
#include <BLEDevice.h>
#include <BLEService.h>
#include <WiFi.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cstring>

namespace codex::firmware {
namespace {

constexpr std::uint8_t kProtocolVersion = 3;
constexpr char kServiceUuid[] = "7c4b1000-8f3a-4d6b-9c2e-4f5a6b7c8d90";
constexpr char kReceiveUuid[] = "7c4b1001-8f3a-4d6b-9c2e-4f5a6b7c8d90";
constexpr char kTransmitUuid[] = "7c4b1002-8f3a-4d6b-9c2e-4f5a6b7c8d90";

std::uint16_t readUint16(const std::uint8_t* value) {
  return static_cast<std::uint16_t>(
      (static_cast<std::uint16_t>(value[0]) << 8U) |
      static_cast<std::uint16_t>(value[1]));
}

std::uint32_t readUint32(const std::uint8_t* value) {
  return
      (static_cast<std::uint32_t>(value[0]) << 24U) |
      (static_cast<std::uint32_t>(value[1]) << 16U) |
      (static_cast<std::uint32_t>(value[2]) << 8U) |
      static_cast<std::uint32_t>(value[3]);
}

void writeUint16(std::uint8_t* target, const std::uint16_t value) {
  target[0] = static_cast<std::uint8_t>(value >> 8U);
  target[1] = static_cast<std::uint8_t>(value);
}

void writeUint32(std::uint8_t* target, const std::uint32_t value) {
  target[0] = static_cast<std::uint8_t>(value >> 24U);
  target[1] = static_cast<std::uint8_t>(value >> 16U);
  target[2] = static_cast<std::uint8_t>(value >> 8U);
  target[3] = static_cast<std::uint8_t>(value);
}

bool sha256(
    const std::uint8_t* data,
    const std::size_t length,
    std::array<std::uint8_t, 32>& digest) {
  return data != nullptr &&
      mbedtls_sha256(data, length, digest.data(), 0) == 0;
}

String advertisedName(const String& device_id) {
  constexpr std::size_t kSuffixBytes = 8;
  const auto suffix_start =
      device_id.length() > kSuffixBytes ? device_id.length() - kSuffixBytes : 0;
  String name = "CodexPet-";
  name += device_id.substring(suffix_start);
  return name;
}

}  // namespace

class BleTransport::ServerCallbacks final : public BLEServerCallbacks {
 public:
  explicit ServerCallbacks(BleTransport& transport) : transport_(transport) {}

  void onConnect(BLEServer*) override {
    transport_.setLinkConnected(true);
  }

  void onDisconnect(BLEServer*) override {
    transport_.setLinkConnected(false);
  }

 private:
  BleTransport& transport_;
};

class BleTransport::ReceiveCallbacks final : public BLECharacteristicCallbacks {
 public:
  explicit ReceiveCallbacks(BleTransport& transport) : transport_(transport) {}

  void onWrite(BLECharacteristic* characteristic) override {
    transport_.enqueueReceived(characteristic);
  }

 private:
  BleTransport& transport_;
};

class BleTransport::TransmitCallbacks final : public BLECharacteristicCallbacks {
 public:
  explicit TransmitCallbacks(BleTransport& transport) : transport_(transport) {}

#if defined(CONFIG_NIMBLE_ENABLED)
  void onSubscribe(
      BLECharacteristic*,
      ble_gap_conn_desc*,
      const std::uint16_t subscription) override {
    transport_.setSubscribed((subscription & 0x0001U) != 0);
  }
#endif

 private:
  BleTransport& transport_;
};

bool BleTransport::begin(const String& device_id) {
  if (available_) return true;
  receive_queue_ = xQueueCreate(64, sizeof(FragmentPacket));
  if (receive_queue_ == nullptr) return false;

#if defined(CONFIG_IDF_TARGET_ESP32P4)
  if (
      !WiFi.setPins(12, 13, 11, 10, 9, 8, 15) ||
      !WiFi.mode(WIFI_STA)) {
    vQueueDelete(receive_queue_);
    receive_queue_ = nullptr;
    return false;
  }
#endif
  if (!BLEDevice::init(advertisedName(device_id))) {
    vQueueDelete(receive_queue_);
    receive_queue_ = nullptr;
    return false;
  }
  BLEDevice::setMTU(185);
  server_ = BLEDevice::createServer();
  if (server_ == nullptr) {
    close();
    return false;
  }
  server_callbacks_ = new ServerCallbacks(*this);
  receive_callbacks_ = new ReceiveCallbacks(*this);
  transmit_callbacks_ = new TransmitCallbacks(*this);
  if (
      server_callbacks_ == nullptr ||
      receive_callbacks_ == nullptr ||
      transmit_callbacks_ == nullptr) {
    close();
    return false;
  }
  server_->setCallbacks(server_callbacks_);
  server_->advertiseOnDisconnect(true);
  auto* service = server_->createService(kServiceUuid);
  if (service == nullptr) {
    close();
    return false;
  }
  auto* receive = service->createCharacteristic(
      kReceiveUuid,
      BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_WRITE_NR);
  transmit_characteristic_ = service->createCharacteristic(
      kTransmitUuid,
      BLECharacteristic::PROPERTY_NOTIFY);
  if (receive == nullptr || transmit_characteristic_ == nullptr) {
    close();
    return false;
  }
  receive->setCallbacks(receive_callbacks_);
  transmit_characteristic_->setCallbacks(transmit_callbacks_);
  service->start();
  auto* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  available_ = true;
  return true;
}

const char* BleTransport::kind() const {
  return "ble";
}

bool BleTransport::connected() const {
  return available_ &&
      link_connected_.load(std::memory_order_acquire) &&
      subscribed_.load(std::memory_order_acquire);
}

bool BleTransport::available() const {
  return available_;
}

void BleTransport::poll(const MessageHandler& handler) {
  if (receive_queue_ == nullptr) return;
  if (receive_overflow_.exchange(false, std::memory_order_acq_rel)) {
    resetReassembly();
  }
  if (
      reassembly_.active &&
      static_cast<std::uint64_t>(millis()) - reassembly_.received_at >=
          kReassemblyTimeoutMs) {
    resetReassembly();
  }
  FragmentPacket packet;
  std::size_t processed = 0;
  while (
      processed < 16 &&
      xQueueReceive(receive_queue_, &packet, 0) == pdTRUE) {
    acceptFragment(packet, handler);
    ++processed;
  }
}

bool BleTransport::sendText(const String& message) {
  if (
      !connected() ||
      transmit_characteristic_ == nullptr ||
      message.isEmpty() ||
      message.length() > kMaximumMessageBytes) {
    return false;
  }
  std::array<std::uint8_t, 32> digest{};
  if (!sha256(
          reinterpret_cast<const std::uint8_t*>(message.c_str()),
          message.length(),
          digest)) {
    return false;
  }
  const auto total = static_cast<std::uint16_t>(
      (message.length() + kPayloadBytes - 1U) / kPayloadBytes);
  std::array<std::uint8_t, kFragmentBytes> fragment{};
  for (std::uint16_t index = 0; index < total; ++index) {
    const auto offset = static_cast<std::size_t>(index) * kPayloadBytes;
    const auto payload_bytes = std::min<std::size_t>(
        kPayloadBytes,
        message.length() - offset);
    fragment[0] = kProtocolVersion;
    std::copy_n(digest.begin(), 8, fragment.begin() + 1);
    writeUint16(fragment.data() + 9, index);
    writeUint16(fragment.data() + 11, total);
    writeUint32(
        fragment.data() + 13,
        static_cast<std::uint32_t>(message.length()));
    std::memcpy(
        fragment.data() + kHeaderBytes,
        message.c_str() + offset,
        payload_bytes);
    transmit_characteristic_->setValue(
        fragment.data(),
        kHeaderBytes + payload_bytes);
    transmit_characteristic_->notify();
    delay(3);
    if (!connected()) return false;
  }
  return true;
}

void BleTransport::close() {
  available_ = false;
  link_connected_.store(false, std::memory_order_release);
  subscribed_.store(false, std::memory_order_release);
  resetReassembly();
  if (receive_queue_ != nullptr) {
    vQueueDelete(receive_queue_);
    receive_queue_ = nullptr;
  }
  delete transmit_callbacks_;
  delete receive_callbacks_;
  delete server_callbacks_;
  transmit_callbacks_ = nullptr;
  receive_callbacks_ = nullptr;
  server_callbacks_ = nullptr;
  transmit_characteristic_ = nullptr;
  server_ = nullptr;
  BLEDevice::deinit(true);
}

void BleTransport::setLinkConnected(const bool connected) {
  link_connected_.store(connected, std::memory_order_release);
  if (!connected) {
    subscribed_.store(false, std::memory_order_release);
    receive_overflow_.store(true, std::memory_order_release);
  }
}

void BleTransport::setSubscribed(const bool subscribed) {
  subscribed_.store(subscribed, std::memory_order_release);
}

void BleTransport::enqueueReceived(BLECharacteristic* characteristic) {
  if (receive_queue_ == nullptr || characteristic == nullptr) return;
  const auto value = characteristic->getValue();
  if (value.length() <= kHeaderBytes || value.length() > kFragmentBytes) {
    return;
  }
  FragmentPacket packet;
  packet.length = static_cast<std::uint16_t>(value.length());
  std::memcpy(packet.data.data(), value.c_str(), value.length());
  if (xQueueSend(receive_queue_, &packet, 0) != pdTRUE) {
    receive_overflow_.store(true, std::memory_order_release);
  }
}

void BleTransport::acceptFragment(
    const FragmentPacket& packet,
    const MessageHandler& handler) {
  if (
      packet.length <= kHeaderBytes ||
      packet.length > kFragmentBytes ||
      packet.data[0] != kProtocolVersion) {
    resetReassembly();
    return;
  }
  const auto index = readUint16(packet.data.data() + 9);
  const auto total = readUint16(packet.data.data() + 11);
  const auto total_bytes = readUint32(packet.data.data() + 13);
  const auto payload_bytes = packet.length - kHeaderBytes;
  if (
      total == 0 ||
      index >= total ||
      total_bytes == 0 ||
      total_bytes > kMaximumMessageBytes ||
      payload_bytes == 0 ||
      total > (kMaximumMessageBytes + kPayloadBytes - 1U) / kPayloadBytes) {
    resetReassembly();
    return;
  }
  if (index == 0) {
    resetReassembly();
    reassembly_.active = true;
    std::copy_n(
        packet.data.begin() + 1,
        reassembly_.token.size(),
        reassembly_.token.begin());
    reassembly_.total = total;
    reassembly_.total_bytes = total_bytes;
    reassembly_.next_index = 0;
    if (!reassembly_.message.reserve(total_bytes)) {
      resetReassembly();
      return;
    }
  }
  if (
      !reassembly_.active ||
      reassembly_.total != total ||
      reassembly_.total_bytes != total_bytes ||
      index != reassembly_.next_index ||
      !std::equal(
          reassembly_.token.begin(),
          reassembly_.token.end(),
          packet.data.begin() + 1)) {
    resetReassembly();
    return;
  }
  reassembly_.message.concat(
      reinterpret_cast<const char*>(packet.data.data() + kHeaderBytes),
      payload_bytes);
  reassembly_.next_index += 1;
  reassembly_.received_at = millis();
  if (reassembly_.next_index != reassembly_.total) return;

  std::array<std::uint8_t, 32> digest{};
  const auto valid =
      reassembly_.message.length() == reassembly_.total_bytes &&
      sha256(
          reinterpret_cast<const std::uint8_t*>(
              reassembly_.message.c_str()),
          reassembly_.message.length(),
          digest) &&
      std::equal(
          reassembly_.token.begin(),
          reassembly_.token.end(),
          digest.begin());
  if (valid) {
    const auto complete = reassembly_.message;
    resetReassembly();
    handler(complete);
  } else {
    resetReassembly();
  }
}

void BleTransport::resetReassembly() {
  reassembly_.active = false;
  reassembly_.total = 0;
  reassembly_.next_index = 0;
  reassembly_.total_bytes = 0;
  reassembly_.received_at = 0;
  reassembly_.message = "";
}

}  // namespace codex::firmware
