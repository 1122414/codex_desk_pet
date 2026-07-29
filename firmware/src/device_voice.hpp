#pragma once

#include <M5Unified.h>

#include <array>
#include <cstdint>

#include "device_protocol.hpp"

namespace codex::firmware {

class DeviceVoice {
 public:
  bool start(DeviceProtocolClient& client, const String& mode);
  void poll();
  bool stop();
  bool recording() const { return recording_; }
  const String& lastError() const { return last_error_; }

 private:
  static constexpr std::uint32_t kSampleRate = 16'000;
  static constexpr std::size_t kSamplesPerChunk = 640;
  static constexpr std::uint8_t kMaximumConsecutiveSendFailures = 25;
  static constexpr std::uint8_t kMaximumConsecutiveCaptureFailures = 5;

  bool beginChunk();
  bool sendCompletedChunk();
  bool finish(const String& error);

  DeviceProtocolClient* client_ = nullptr;
  std::array<std::int16_t, kSamplesPerChunk> samples_{};
  bool recording_ = false;
  bool chunk_pending_ = false;
  std::uint8_t consecutive_send_failures_ = 0;
  std::uint8_t consecutive_capture_failures_ = 0;
  String last_error_;
};

}  // namespace codex::firmware
