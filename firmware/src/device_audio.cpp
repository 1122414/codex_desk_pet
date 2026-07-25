#include "device_audio.hpp"

#include <esp_partition.h>
#include <mbedtls/sha256.h>

#include <array>
#include <cstdint>
#include <vector>

namespace codex::firmware {
namespace {

constexpr std::size_t kVoiceDataSize = 2'913'777;
constexpr std::array<std::uint8_t, 32> kVoiceDataSha256{{
    0xcc, 0x9a, 0x81, 0xfd, 0x71, 0x6b, 0x3c, 0x07,
    0xfa, 0xe3, 0xca, 0x2f, 0x80, 0x2d, 0xc0, 0x26,
    0x08, 0x18, 0x96, 0xf2, 0xe3, 0x4d, 0xb9, 0xb9,
    0xdb, 0x11, 0x75, 0xde, 0x5a, 0x85, 0xc0, 0x01,
}};

}  // namespace

bool DeviceAudio::begin() {
  if (queue_ != nullptr) return voice_ready_;
  queue_ = xQueueCreate(1, sizeof(AudioCue));
  if (queue_ == nullptr) return false;

  voice_ready_ = initializeVoice();
  const auto created = xTaskCreate(
      taskEntry,
      "codex-audio",
      8'192,
      this,
      2,
      &task_);
  if (created != pdPASS) {
    vQueueDelete(queue_);
    queue_ = nullptr;
    task_ = nullptr;
    voice_ready_ = false;
    return false;
  }
  return voice_ready_;
}

bool DeviceAudio::enqueue(const AudioCue cue) {
  if (queue_ == nullptr) return false;
  return xQueueOverwrite(queue_, &cue) == pdPASS;
}

void DeviceAudio::taskEntry(void* context) {
  static_cast<DeviceAudio*>(context)->run();
}

void DeviceAudio::run() {
  AudioCue cue = AudioCue::Ready;
  while (xQueueReceive(queue_, &cue, portMAX_DELAY) == pdTRUE) {
    const auto& plan = audioPlan(cue);
    if (!voice_ready_ || plan.chinese_phrase == nullptr ||
        !speak(plan.chinese_phrase)) {
      playFallback(plan);
    }
  }
}

bool DeviceAudio::initializeVoice() {
  const auto* partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA,
      ESP_PARTITION_SUBTYPE_ANY,
      "voice_data");
  if (partition == nullptr) {
    Serial.println("语音初始化失败：voice_data 分区不存在");
    return false;
  }
  if (partition->size < kVoiceDataSize) {
    Serial.printf("语音初始化失败：voice_data 分区过小 (%u)\n", partition->size);
    return false;
  }

  const void* voice_data = nullptr;
  const auto map_result = esp_partition_mmap(
      partition,
      0,
      kVoiceDataSize,
      ESP_PARTITION_MMAP_DATA,
      &voice_data,
      &voice_map_handle_);
  if (map_result != ESP_OK || voice_data == nullptr) {
    Serial.printf("语音初始化失败：分区映射错误 %d\n", static_cast<int>(map_result));
    return false;
  }

  std::array<std::uint8_t, 32> digest{};
  const auto hash_result = mbedtls_sha256(
      static_cast<const std::uint8_t*>(voice_data),
      kVoiceDataSize,
      digest.data(),
      0);
  if (hash_result != 0 || digest != kVoiceDataSha256) {
    Serial.printf("语音初始化失败：语音数据校验错误 %d\n", hash_result);
    esp_partition_munmap(voice_map_handle_);
    voice_map_handle_ = 0;
    return false;
  }

  // The flashed data file is xiaoxin_small. Its pronunciation tables must be
  // paired with the matching xiaoxin voice set rather than the empty template.
  voice_ = esp_tts_voice_set_init(
      &esp_tts_voice_xiaoxin,
      const_cast<void*>(voice_data));
  if (voice_ == nullptr) {
    Serial.println("语音初始化失败：xiaoxin 声音集创建失败");
    esp_partition_munmap(voice_map_handle_);
    voice_map_handle_ = 0;
    return false;
  }
  tts_ = esp_tts_create(voice_);
  if (tts_ != nullptr) return true;
  Serial.println("语音初始化失败：TTS 引擎创建失败");
  esp_tts_voice_set_free(voice_);
  voice_ = nullptr;
  esp_partition_munmap(voice_map_handle_);
  voice_map_handle_ = 0;
  return false;
}

bool DeviceAudio::speak(const char* phrase) {
  if (tts_ == nullptr || phrase == nullptr) return false;
  M5.Speaker.stop(kSpeakerChannel);
  esp_tts_stream_reset(tts_);
  if (esp_tts_parse_chinese(tts_, phrase) == 0) return false;

  std::array<std::vector<std::int16_t>, 3> buffers;
  std::size_t next_buffer = 0;
  bool first_chunk = true;
  while (!interrupted()) {
    int sample_count = 0;
    const auto* samples = esp_tts_stream_play(tts_, &sample_count, 3);
    if (samples == nullptr || sample_count <= 0) break;

    while (M5.Speaker.isPlaying(kSpeakerChannel) > 1 && !interrupted()) {
      vTaskDelay(pdMS_TO_TICKS(2));
    }
    if (interrupted()) break;

    auto& buffer = buffers[next_buffer];
    buffer.assign(samples, samples + sample_count);
    if (!M5.Speaker.playRaw(
            buffer.data(),
            buffer.size(),
            16'000,
            false,
            1,
            kSpeakerChannel,
            first_chunk)) {
      M5.Speaker.stop(kSpeakerChannel);
      esp_tts_stream_reset(tts_);
      return false;
    }
    first_chunk = false;
    next_buffer = (next_buffer + 1) % buffers.size();
  }

  while (M5.Speaker.isPlaying(kSpeakerChannel) && !interrupted()) {
    vTaskDelay(pdMS_TO_TICKS(2));
  }
  if (interrupted()) {
    M5.Speaker.stop(kSpeakerChannel);
    esp_tts_stream_reset(tts_);
  }
  return true;
}

void DeviceAudio::playFallback(const AudioPlan& plan) {
  M5.Speaker.stop(kSpeakerChannel);
  for (std::size_t index = 0; index < plan.tone_count && !interrupted(); ++index) {
    const auto& tone = plan.fallback_tones[index];
    M5.Speaker.tone(
        tone.frequency_hz,
        tone.duration_ms,
        kSpeakerChannel,
        true);
    const auto wait_ms = static_cast<TickType_t>(tone.duration_ms + tone.pause_ms);
    vTaskDelay(pdMS_TO_TICKS(wait_ms));
  }
}

bool DeviceAudio::interrupted() const {
  return queue_ != nullptr && uxQueueMessagesWaiting(queue_) > 0;
}

}  // namespace codex::firmware
