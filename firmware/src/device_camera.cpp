#include "device_camera.hpp"

#include <M5Unified.h>
#include <driver/i2c_master.h>
#include <driver/jpeg_encode.h>
#include <driver/ledc.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cstdlib>

namespace codex::firmware {
namespace {

constexpr gpio_num_t kCameraClockPin = GPIO_NUM_36;
constexpr std::uint32_t kCameraClockHz = 24'000'000;
constexpr std::uint8_t kCameraSccbAddress = 0x36;
constexpr std::size_t kCameraProbeAttempts = 10;
constexpr std::uint16_t kCameraSensorId = 0xeb52;
constexpr std::uint16_t kCameraSensorIdHighRegister = 0x3107;
constexpr std::uint16_t kCameraSensorIdLowRegister = 0x3108;
constexpr i2c_port_num_t kCameraI2cPort = I2C_NUM_0;
constexpr std::int8_t kCameraSclPin = 32;
constexpr std::int8_t kCameraSdaPin = 31;
constexpr std::uint32_t kCameraVideoFlags =
    ESP_VIDEO_INIT_FLAGS_MIPI_CSI | ESP_VIDEO_INIT_FLAGS_ISP;

bool initializeCameraClock(String& error) {
  static bool initialized = false;
  if (initialized) return true;

  ledc_timer_config_t timer_config{};
  timer_config.speed_mode = LEDC_LOW_SPEED_MODE;
  timer_config.duty_resolution = LEDC_TIMER_1_BIT;
  timer_config.timer_num = LEDC_TIMER_2;
  timer_config.freq_hz = kCameraClockHz;
  timer_config.clk_cfg = LEDC_USE_PLL_DIV_CLK;
  const auto timer_result = ledc_timer_config(&timer_config);
  if (timer_result != ESP_OK) {
    error = "摄像头时钟定时器初始化失败: ";
    error += esp_err_to_name(timer_result);
    return false;
  }

  ledc_channel_config_t channel_config{};
  channel_config.gpio_num = kCameraClockPin;
  channel_config.speed_mode = LEDC_LOW_SPEED_MODE;
  channel_config.channel = LEDC_CHANNEL_6;
  channel_config.intr_type = LEDC_INTR_DISABLE;
  channel_config.timer_sel = LEDC_TIMER_2;
  channel_config.duty = 1;
  channel_config.hpoint = 0;
  const auto channel_result = ledc_channel_config(&channel_config);
  if (channel_result != ESP_OK) {
    error = "摄像头时钟通道初始化失败: ";
    error += esp_err_to_name(channel_result);
    return false;
  }
  const auto actual_frequency = ledc_get_freq(
      LEDC_LOW_SPEED_MODE,
      LEDC_TIMER_2);
  const auto frequency_delta = actual_frequency > kCameraClockHz
      ? actual_frequency - kCameraClockHz
      : kCameraClockHz - actual_frequency;
  if (frequency_delta > kCameraClockHz / 100U) {
    char detail[64]{};
    snprintf(
        detail,
        sizeof(detail),
        "摄像头主时钟频率异常: %luHz",
        static_cast<unsigned long>(actual_frequency));
    error = detail;
    return false;
  }

  initialized = true;
  return true;
}

bool readCameraRegister(
    const i2c_master_dev_handle_t sensor,
    const std::uint16_t address,
    std::uint8_t& value,
    String& error) {
  const std::array<std::uint8_t, 2> register_address{
      static_cast<std::uint8_t>(address >> 8U),
      static_cast<std::uint8_t>(address & 0xffU),
  };
  const auto result = i2c_master_transmit_receive(
      sensor,
      register_address.data(),
      register_address.size(),
      &value,
      1,
      50);
  if (result == ESP_OK) return true;
  error = "摄像头传感器寄存器读取失败: ";
  error += esp_err_to_name(result);
  return false;
}

bool verifyCameraSensor(
    const i2c_master_bus_handle_t bus,
    String& error) {
  i2c_device_config_t config{};
  config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
  config.device_address = kCameraSccbAddress;
  config.scl_speed_hz = 400'000;
  i2c_master_dev_handle_t sensor = nullptr;
  const auto add_result = i2c_master_bus_add_device(bus, &config, &sensor);
  if (add_result != ESP_OK || sensor == nullptr) {
    error = "摄像头传感器控制句柄创建失败: ";
    error += esp_err_to_name(add_result);
    return false;
  }

  std::uint8_t id_high = 0;
  std::uint8_t id_low = 0;
  const auto read_ok =
      readCameraRegister(sensor, kCameraSensorIdHighRegister, id_high, error) &&
      readCameraRegister(sensor, kCameraSensorIdLowRegister, id_low, error);
  const auto delete_result = i2c_master_bus_rm_device(sensor);
  if (!read_ok) return false;
  if (delete_result != ESP_OK) {
    error = "摄像头传感器控制句柄释放失败: ";
    error += esp_err_to_name(delete_result);
    return false;
  }

  const auto sensor_id = static_cast<std::uint16_t>(
      (static_cast<std::uint16_t>(id_high) << 8U) | id_low);
  if (sensor_id == kCameraSensorId) return true;
  char detail[64]{};
  snprintf(
      detail,
      sizeof(detail),
      "摄像头传感器型号异常: 0x%04x",
      static_cast<unsigned int>(sensor_id));
  error = detail;
  return false;
}

bool writeHexDigest(
    const std::uint8_t* data,
    const std::size_t bytes,
    String& result) {
  std::array<std::uint8_t, 32> digest{};
  if (mbedtls_sha256(data, bytes, digest.data(), 0) != 0) return false;
  static constexpr char kHex[] = "0123456789abcdef";
  if (!result.reserve(digest.size() * 2U)) return false;
  result = "";
  for (const auto value : digest) {
    result += kHex[value >> 4U];
    result += kHex[value & 0x0fU];
  }
  return result.length() == digest.size() * 2U;
}

bool makeCaptureId(String& result) {
  std::array<std::uint8_t, 8> source{};
  esp_fill_random(source.data(), source.size());
  static constexpr char kHex[] = "0123456789abcdef";
  if (!result.reserve(source.size() * 2U)) return false;
  result = "";
  for (const auto value : source) {
    result += kHex[value >> 4U];
    result += kHex[value & 0x0fU];
  }
  return result.length() == source.size() * 2U;
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
  if (!capture_id_.reserve(16) || !sha256_.reserve(64)) {
    error = "照片元数据内存不足";
    error_ = error;
    clearUpload();
    return false;
  }
  if (!makeCaptureId(capture_id_)) {
    error = "照片标识生成失败";
    error_ = error;
    clearUpload();
    return false;
  }
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
  width_ = static_cast<std::uint16_t>(frame_width);
  height_ = static_cast<std::uint16_t>(frame_height);
  if (!writeHexDigest(jpeg_, jpeg_bytes_, sha256_)) {
    error = "照片摘要生成失败";
    error_ = error;
    clearUpload();
    return false;
  }
  if (!client_->sendVisionBegin(
          capture_id_, jpeg_bytes_, width_, height_, sha256_)) {
    error = "照片传输启动失败";
    if (!client_->lastSendError().isEmpty()) {
      error += ": ";
      error += client_->lastSendError();
    }
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
  if (!initializeCameraClock(error)) return false;

  auto& camera_power = M5.getIOExpander(0);
  camera_power.setDirection(6, true);
  camera_power.setHighImpedance(6, false);
  camera_power.digitalWrite(6, false);
  delay(10);
  camera_power.digitalWrite(6, true);
  delay(100);
  if (!camera_power.getWriteValue(6)) {
    error = "摄像头复位脚未能拉高";
    return false;
  }

  i2c_master_bus_handle_t i2c_handle = nullptr;
  const auto i2c_result = i2c_master_get_bus_handle(
      static_cast<i2c_port_num_t>(M5.In_I2C.getPort()),
      &i2c_handle);
  if (i2c_result != ESP_OK || i2c_handle == nullptr) {
    error = "摄像头 I2C 总线不可用";
    return false;
  }
  esp_err_t probe_result = ESP_FAIL;
  for (std::size_t attempt = 0; attempt < kCameraProbeAttempts; ++attempt) {
    probe_result = i2c_master_probe(
        i2c_handle,
        kCameraSccbAddress,
        50);
    if (probe_result == ESP_OK) break;
    delay(20);
  }
  if (probe_result != ESP_OK) {
    error = "摄像头传感器 0x36 无响应: ";
    error += esp_err_to_name(probe_result);
    return false;
  }
  if (!verifyCameraSensor(i2c_handle, error)) return false;
  if (!M5.In_I2C.release()) {
    error = "摄像头无法接管 I2C 总线";
    return false;
  }
  camera_owns_i2c_ = true;
  esp_video_deinit_with_flags(kCameraVideoFlags);
  ESPVideoCamConfigClass camera_config;
  if (!camera_config.begin(
          kCameraI2cPort,
          kCameraSclPin,
          kCameraSdaPin,
          400'000,
          -1,
          -1)) {
    error = "摄像头控制总线初始化失败";
    return false;
  }
  ESPVideoCSIConfigClass csi_config;
  if (!csi_config.begin(camera_config, true) || !video_.begin(csi_config)) {
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
  if (video_.isActive()) {
    video_.end();
  } else {
    esp_video_deinit_with_flags(kCameraVideoFlags);
  }
  if (camera_owns_i2c_) {
    camera_owns_i2c_ = false;
    if (!M5.In_I2C.begin()) {
      error_ = "设备 I2C 总线恢复失败";
    }
  }
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
