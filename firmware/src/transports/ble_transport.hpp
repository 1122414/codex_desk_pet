#pragma once

#include <BLECharacteristic.h>
#include <BLEServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include <array>
#include <atomic>
#include <cstdint>

#include "transports/text_transport.hpp"

namespace codex::firmware {

class BleTransport final : public TextTransport {
 public:
  bool begin(const String& device_id);
  const char* kind() const override;
  bool connected() const override;
  void poll(const MessageHandler& handler) override;
  bool sendText(const String& message) override;
  void close() override;
  bool available() const;

 private:
  class ServerCallbacks;
  class ReceiveCallbacks;
  class TransmitCallbacks;

  struct FragmentPacket {
    std::uint16_t length = 0;
    std::array<std::uint8_t, 180> data{};
  };

  struct Reassembly {
    bool active = false;
    std::array<std::uint8_t, 8> token{};
    std::uint16_t total = 0;
    std::uint16_t next_index = 0;
    std::uint32_t total_bytes = 0;
    std::uint64_t received_at = 0;
    String message;
  };

  void setLinkConnected(bool connected);
  void setSubscribed(bool subscribed);
  void enqueueReceived(BLECharacteristic* characteristic);
  void acceptFragment(const FragmentPacket& packet, const MessageHandler& handler);
  void resetReassembly();

  static constexpr std::size_t kHeaderBytes = 17;
  static constexpr std::size_t kFragmentBytes = 180;
  static constexpr std::size_t kPayloadBytes = kFragmentBytes - kHeaderBytes;
  static constexpr std::size_t kMaximumMessageBytes = 8U * 1024U;
  static constexpr std::uint64_t kReassemblyTimeoutMs = 10'000;

  BLEServer* server_ = nullptr;
  BLECharacteristic* transmit_characteristic_ = nullptr;
  QueueHandle_t receive_queue_ = nullptr;
  ServerCallbacks* server_callbacks_ = nullptr;
  ReceiveCallbacks* receive_callbacks_ = nullptr;
  TransmitCallbacks* transmit_callbacks_ = nullptr;
  Reassembly reassembly_;
  std::atomic<bool> link_connected_{false};
  std::atomic<bool> subscribed_{false};
  std::atomic<bool> receive_overflow_{false};
  bool available_ = false;
};

}  // namespace codex::firmware
