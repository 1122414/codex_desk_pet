#pragma once

#include <Arduino.h>

#include <functional>

namespace codex::firmware {

using MessageHandler = std::function<void(const String&)>;

class TextTransport {
 public:
  virtual ~TextTransport() = default;
  virtual const char* kind() const = 0;
  virtual bool connected() const = 0;
  virtual void poll(const MessageHandler& handler) = 0;
  virtual bool consumeWakeRequest() { return false; }
  virtual bool sendText(const String& message) = 0;
  virtual void close() = 0;
};

}  // namespace codex::firmware
