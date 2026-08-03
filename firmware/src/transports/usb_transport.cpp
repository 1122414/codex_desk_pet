#include "transports/usb_transport.hpp"

#include <cstdint>

namespace codex::firmware {

void UsbTransport::prepareSerialBuffers() {
  Serial.setRxBufferSize(kMaximumLineBytes);
  Serial.setTxBufferSize(kMaximumLineBytes + 1U);
}

void UsbTransport::begin() {
  Serial.setTxTimeoutMs(500);
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
  String frame;
  if (!frame.reserve(message.length() + 1U)) return false;
  frame = message;
  frame += '\n';
  const auto written = Serial.write(
      reinterpret_cast<const std::uint8_t*>(frame.c_str()), frame.length());
  return written == frame.length();
}

void UsbTransport::close() {
  receive_buffer_ = "";
  wake_requested_ = false;
  host_activity_ = false;
}

}  // namespace codex::firmware
