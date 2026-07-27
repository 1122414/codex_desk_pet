#include "transports/usb_transport.hpp"

namespace codex::firmware {

void UsbTransport::begin() {
  Serial.setRxBufferSize(kMaximumLineBytes);
  receive_buffer_.reserve(1'024);
}

const char* UsbTransport::kind() const {
  return "usb";
}

bool UsbTransport::connected() const {
  return static_cast<bool>(Serial);
}

void UsbTransport::poll(const MessageHandler& handler) {
  while (Serial.available() > 0) {
    const auto value = Serial.read();
    if (value < 0) {
      break;
    }
    const auto character = static_cast<char>(value);
    if (character == '\n') {
      receive_buffer_.trim();
      if (!receive_buffer_.isEmpty()) {
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

bool UsbTransport::sendText(const String& message) {
  if (!connected() || message.length() > kMaximumLineBytes) {
    return false;
  }
  return Serial.println(message) > 0;
}

void UsbTransport::close() {
  receive_buffer_ = "";
}

}  // namespace codex::firmware
