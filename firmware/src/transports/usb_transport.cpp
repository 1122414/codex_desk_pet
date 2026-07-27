#include "transports/usb_transport.hpp"

#include <algorithm>
#include <cstdint>

namespace codex::firmware {

void UsbTransport::begin() {
  Serial.setRxBufferSize(kMaximumLineBytes);
  Serial.setTxBufferSize(kMaximumLineBytes);
  Serial.setTxTimeoutMs(1'000);
  receive_buffer_.reserve(1'024);
}

const char* UsbTransport::kind() const {
  return "usb";
}

bool UsbTransport::connected() const {
  return host_activity_ || Serial.isConnected();
}

void UsbTransport::poll(const MessageHandler& handler) {
  while (Serial.available() > 0) {
    const auto value = Serial.read();
    if (value < 0) {
      break;
    }
    host_activity_ = true;
    const auto character = static_cast<char>(value);
    if (character == '\n') {
      receive_buffer_.trim();
      if (receive_buffer_.isEmpty()) {
        wake_requested_ = true;
      } else {
        handler(receive_buffer_);
      }
      receive_buffer_ = "";
      continue;
    }
    if (character != '\r') {
      receive_buffer_ += character;
    }
    if (receive_buffer_.length() > kMaximumLineBytes) {
      receive_buffer_ = "";
    }
  }
}

bool UsbTransport::consumeWakeRequest() {
  const auto requested = wake_requested_;
  wake_requested_ = false;
  return requested;
}

bool UsbTransport::sendText(const String& message) {
  if (!connected() || message.length() > kMaximumLineBytes) {
    return false;
  }
  constexpr std::size_t kChunkBytes = 128;
  constexpr std::uint64_t kWriteTimeoutMs = 3'000;
  const auto started_at = static_cast<std::uint64_t>(millis());
  std::size_t offset = 0;
  while (offset < message.length()) {
    const auto chunk = std::min<std::size_t>(
        kChunkBytes,
        message.length() - offset);
    const auto written = Serial.write(
        reinterpret_cast<const std::uint8_t*>(message.c_str() + offset),
        chunk);
    offset += written;
    if (
        written == 0 &&
        static_cast<std::uint64_t>(millis()) - started_at >= kWriteTimeoutMs) {
      return false;
    }
    delay(1);
  }
  if (Serial.write('\n') != 1) return false;
  Serial.flush();
  return true;
}

void UsbTransport::close() {
  receive_buffer_ = "";
  wake_requested_ = false;
  host_activity_ = false;
}

}  // namespace codex::firmware
