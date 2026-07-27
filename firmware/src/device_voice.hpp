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

 private:
  static constexpr std::uint32_t kSampleRate = 16'000;
  static constexpr std::size_t kSamplesPerChunk = 640;

  bool beginChunk();
  bool sendCompletedChunk();

  DeviceProtocolClient* client_ = nullptr;
  std::array<std::int16_t, kSamplesPerChunk> samples_{};
  bool recording_ = false;
  bool chunk_pending_ = false;
};

}  // namespace codex::firmware
