#include "device_camera.hpp"

#include <M5Unified.h>
#include <driver/i2c_master.h>
#include <driver/jpeg_encode.h>
#include <esp32-hal-i2c.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cstdlib>

namespace codex::firmware {
namespace {

String hexDigest(const std::uint8_t* data, const std::size_t bytes) {
  std::array<std::uint8_t, 32> digest{};
  if (mbedtls_sha256(data, bytes, digest.data(), 0) != 0) return {};
  static constexpr char kHex[] = "0123456789abcdef";
  String result;
  if (!result.reserve(digest.size() * 2U)) return {};
  for (const auto value : digest) {
    result += kHex[value >> 4U];
    result += kHex[value & 0x0fU];
  }
  return result;
}

String captureId() {
  char result[17]{};
  snprintf(
      result,
      sizeof(result),
      "%08lx%08lx",
      static_cast<unsigned long>(esp_random()),
      static_cast<unsigned long>(esp_random()));
  return result;
}

}  // namespace

bool DeviceCamera::captureAndQueue(
    DeviceProtocolClient& client,
    String& error) {
  if (uploading_) {
    error = "上一张照片仍在发送";
    return false;
  }
  if (
      strcmp(client.transportKind(), "usb") != 0 &&
      strcmp(client.transportKind(), "wifi") != 0) {
    error = "拍照需要 USB 或 Wi-Fi";
    return false;
  }
  clearUpload();
  error_ = "";
  if (!initializeCamera(error)) {
    stopCamera();
    error_ = error;
    return false;
  }

  auto frame = capture_.captureBuffer();
  if (!frame.valid() || frame.data() == nullptr || frame.size() == 0) {
    error = "摄像头没有返回画面";
    stopCamera();
    error_ = error;
    return false;
  }
  const auto frame_width = frame.getWidth();
  const auto frame_height = frame.getHeight();
  if (
      frame_width < 160 || frame_width > 2'048 ||
      frame_height < 90 || frame_height > 2'048) {
    error = "摄像头画面尺寸无效";
    frame.end();
    stopCamera();
    error_ = error;
    return false;
  }
  const auto encoded = encodeFrame(
      frame.data(),
      frame.size(),
      static_cast<std::uint16_t>(frame_width),
      static_cast<std::uint16_t>(frame_height),
      error);
  frame.end();
  stopCamera();
  if (!encoded) {
    error_ = error;
    clearUpload();
    return false;
  }

  client_ = &client;
  capture_id_ = captureId();
  sha256_ = hexDigest(jpeg_, jpeg_bytes_);
  width_ = static_cast<std::uint16_t>(frame_width);
  height_ = static_cast<std::uint16_t>(frame_height);
  if (
      capture_id_.length() != 16 || sha256_.length() != 64 ||
      !client_->sendVisionBegin(
          capture_id_, jpeg_bytes_, width_, height_, sha256_)) {
    error = "照片传输启动失败";
    error_ = error;
    clearUpload();
    return false;
  }
  offset_ = 0;
  uploading_ = true;
  return true;
}

void DeviceCamera::poll() {
  if (!uploading_ || client_ == nullptr || jpeg_ == nullptr) return;
  if (!client_->ready()) {
    error_ = "照片传输链路已断开";
    uploading_ = false;
    clearUpload();
    return;
  }
  if (offset_ < jpeg_bytes_) {
    const auto bytes = std::min(kChunkBytes, jpeg_bytes_ - offset_);
    if (client_->sendVisionChunk(
            capture_id_,
            offset_,
            jpeg_ + offset_,
            bytes)) {
      offset_ += bytes;
    }
    return;
  }
  if (!client_->sendVisionEnd(capture_id_)) return;
  uploading_ = false;
  clearUpload();
}

bool DeviceCamera::initializeCamera(String& error) {
  const auto raw_i2c = i2cBusHandle(M5.In_I2C.getPort());
  if (raw_i2c == nullptr) {
    error = "摄像头 I2C 总线不可用";
    return false;
  }
  ESPVideoCamConfigClass camera_config;
  if (!camera_config.begin(
          reinterpret_cast<i2c_master_bus_handle_t>(raw_i2c),
          400'000,
          -1,
          -1)) {
    error = "摄像头控制总线初始化失败";
    return false;
  }
  ESPVideoCSIConfigClass csi_config;
  if (!csi_config.begin(camera_config) || !video_.begin(csi_config)) {
    error = "MIPI 摄像头初始化失败";
    return false;
  }
  if (
      !capture_.begin(ESP_VIDEO_MIPI_CSI_DEVICE_NAME, 2) ||
      !capture_.setFormat(ESP_VIDEO_FORMAT_RGB565) ||
      !capture_.startCapture()) {
    error = "摄像头采集启动失败";
    return false;
  }
  return true;
}

bool DeviceCamera::encodeFrame(
    const std::uint8_t* data,
    const std::size_t bytes,
    const std::uint16_t width,
    const std::uint16_t height,
    String& error) {
  jpeg_encode_memory_alloc_cfg_t memory_config{
      .buffer_direction = JPEG_ENC_ALLOC_OUTPUT_BUFFER,
  };
  jpeg_ = static_cast<std::uint8_t*>(jpeg_alloc_encoder_mem(
      kMaximumJpegBytes,
      &memory_config,
      &jpeg_capacity_));
  if (jpeg_ == nullptr || jpeg_capacity_ < kMaximumJpegBytes) {
    error = "JPEG 编码内存不足";
    return false;
  }
  jpeg_encode_engine_cfg_t engine_config{
      .intr_priority = 0,
      .timeout_ms = 1'000,
  };
  jpeg_encoder_handle_t encoder = nullptr;
  if (jpeg_new_encoder_engine(&engine_config, &encoder) != ESP_OK) {
    error = "JPEG 编码器初始化失败";
    return false;
  }
  const jpeg_encode_cfg_t encode_config{
      .height = height,
      .width = width,
      .src_type = JPEG_ENCODE_IN_FORMAT_RGB565,
      .sub_sample = JPEG_DOWN_SAMPLING_YUV422,
      .image_quality = 60,
      .pixel_reverse = false,
  };
  std::uint32_t encoded_bytes = 0;
  const auto result = jpeg_encoder_process(
      encoder,
      &encode_config,
      data,
      bytes,
      jpeg_,
      jpeg_capacity_,
      &encoded_bytes);
  jpeg_del_encoder_engine(encoder);
  if (
      result != ESP_OK || encoded_bytes == 0 ||
      encoded_bytes > kMaximumJpegBytes) {
    error = "JPEG 编码失败";
    return false;
  }
  jpeg_bytes_ = encoded_bytes;
  return true;
}

void DeviceCamera::stopCamera() {
  if (capture_.isCaptureStarted()) capture_.stopCapture();
  if (capture_.isOpened()) capture_.end();
  if (video_.isActive()) video_.end();
}

void DeviceCamera::clearUpload() {
  client_ = nullptr;
  if (jpeg_ != nullptr) {
    std::free(jpeg_);
    jpeg_ = nullptr;
  }
  jpeg_capacity_ = 0;
  jpeg_bytes_ = 0;
  offset_ = 0;
  width_ = 0;
  height_ = 0;
  capture_id_ = "";
  sha256_ = "";
}

}  // namespace codex::firmware
