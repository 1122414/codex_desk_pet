#pragma once

#include "transports/text_transport.hpp"

namespace codex::firmware {

class UsbTransport final : public TextTransport {
 public:
  void begin();
  const char* kind() const override;
  bool connected() const override;
  void poll(const MessageHandler& handler) override;
  bool sendText(const String& message) override;
  void close() override;

 private:
  static constexpr std::size_t kMaximumLineBytes = 8U * 1024U;
  String receive_buffer_;
};

}  // namespace codex::firmware
