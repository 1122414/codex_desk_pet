#pragma once

#include <Arduino.h>
#include <ESP_Video.h>

#include <cstddef>
#include <cstdint>

#include "device_protocol.hpp"

namespace codex::firmware {

class DeviceCamera {
 public:
  bool captureAndQueue(DeviceProtocolClient& client, String& error);
  void poll();
  bool uploading() const { return uploading_; }
  const String& captureId() const { return capture_id_; }
  const String& lastError() const { return error_; }

 private:
  static constexpr std::size_t kMaximumJpegBytes = 512U * 1'024U;
  static constexpr std::size_t kChunkBytes = 2'048;

  bool initializeCamera(String& error);
  bool encodeFrame(
      const std::uint8_t* data,
      std::size_t bytes,
      std::uint16_t width,
      std::uint16_t height,
      String& error);
  void stopCamera();
  void clearUpload();

  ESPVideoClass video_;
  ESPVideoCaptureDevClass capture_;
  DeviceProtocolClient* client_ = nullptr;
  std::uint8_t* jpeg_ = nullptr;
  std::size_t jpeg_capacity_ = 0;
  std::size_t jpeg_bytes_ = 0;
  std::size_t offset_ = 0;
  std::uint16_t width_ = 0;
  std::uint16_t height_ = 0;
  String capture_id_;
  String sha256_;
  String error_;
  bool uploading_ = false;
};

}  // namespace codex::firmware
