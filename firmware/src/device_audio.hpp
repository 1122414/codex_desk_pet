#pragma once

#include <M5Unified.h>
#include <esp_partition.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include "codex_core/audio.hpp"
#include "esp_tts_compat.hpp"

namespace codex::firmware {

class DeviceAudio {
 public:
  bool begin();
  bool enqueue(AudioCue cue);
  bool voiceAvailable() const { return voice_ready_; }

 private:
  static void taskEntry(void* context);
  void run();
  bool initializeVoice();
  bool speak(const char* phrase);
  void playFallback(const AudioPlan& plan);
  bool interrupted() const;

  static constexpr std::uint8_t kSpeakerChannel = 0;

  QueueHandle_t queue_ = nullptr;
  TaskHandle_t task_ = nullptr;
  esp_tts_voice_t* voice_ = nullptr;
  esp_tts_handle_t tts_ = nullptr;
  esp_partition_mmap_handle_t voice_map_handle_ = 0;
  bool voice_ready_ = false;
};

}  // namespace codex::firmware
