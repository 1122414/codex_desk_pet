#pragma once

#include <BLECharacteristic.h>
#include <BLEServer.h>

#include <array>
#include <vector>

#include "transports/text_transport.hpp"

namespace codex::firmware {

class BleTransport final : public TextTransport {
 public:
  static constexpr const char* kServiceUuid =
      "7a5c0001-1f4b-4e29-a9a0-4e0f0c0d0001";
  static constexpr const char* kRxUuid =
      "7a5c0002-1f4b-4e29-a9a0-4e0f0c0d0001";
  static constexpr const char* kTxUuid =
      "7a5c0003-1f4b-4e29-a9a0-4e0f0c0d0001";
  static constexpr const char* kProvisionUuid =
      "7a5c0004-1f4b-4e29-a9a0-4e0f0c0d0001";

  void begin(const String& device_name);
  const char* kind() const override;
  bool connected() const override;
  void poll(const MessageHandler& handler) override;
  bool sendText(const String& message) override;
  void close() override;
  bool takeProvisioningMessage(String& message);
  void acceptFragment(const std::uint8_t* data, std::size_t length);
  void acceptProvisioning(const String& value);
  void setConnected(bool connected);

 private:
  struct Assembly {
    bool active = false;
    std::array<std::uint8_t, 8> token{};
    std::uint16_t total = 0;
    std::uint32_t total_bytes = 0;
    std::uint64_t updated_at = 0;
    std::vector<std::vector<std::uint8_t>> parts;
    std::vector<bool> received;
  };

  static constexpr std::size_t kHeaderBytes = 17;
  static constexpr std::size_t kMtuBytes = 180;
  static constexpr std::size_t kMaximumEnvelopeBytes = 8U * 1024U;

  void resetAssembly();
  void notifyFragments(const String& message);
  bool verifyAndDispatch();

  BLEServer* server_ = nullptr;
  BLECharacteristic* tx_ = nullptr;
  MessageHandler handler_;
  Assembly assembly_;
  String provisioning_message_;
  bool provisioning_pending_ = false;
  bool connected_ = false;
};

}  // namespace codex::firmware
