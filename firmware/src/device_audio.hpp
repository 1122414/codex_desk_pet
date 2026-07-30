#pragma once

#include <M5Unified.h>
#include <esp_partition.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <array>
#include <atomic>

#include "codex_core/audio.hpp"
#include "esp_tts_compat.hpp"

namespace codex::firmware {

class DeviceAudio {
 public:
  bool begin();
  bool enqueue(AudioCue cue);
  bool enqueuePhrase(const String& phrase);
  void setPaused(bool paused) { paused_ = paused; }
  bool voiceAvailable() const { return voice_ready_; }
  bool busy() const {
    return last_completed_request_.load() != last_enqueued_request_.load();
  }

 private:
  static void taskEntry(void* context);
  void run();
  bool initializeVoice();
  bool speak(const char* phrase);
  void playFallback(const AudioPlan& plan);
  bool interrupted() const;

  static constexpr std::uint8_t kSpeakerChannel = 0;
  static constexpr std::size_t kMaximumPhraseBytes = 240;

  struct AudioRequest {
    std::uint32_t id = 0;
    AudioCue cue = AudioCue::Ready;
    bool custom_phrase = false;
    std::array<char, kMaximumPhraseBytes + 1> phrase{};
  };

  QueueHandle_t queue_ = nullptr;
  TaskHandle_t task_ = nullptr;
  esp_tts_voice_t* voice_ = nullptr;
  esp_tts_handle_t tts_ = nullptr;
  void* voice_data_ = nullptr;
  bool voice_ready_ = false;
  volatile bool paused_ = false;
  std::atomic<std::uint32_t> next_request_id_{1};
  std::atomic<std::uint32_t> last_enqueued_request_{0};
  std::atomic<std::uint32_t> last_completed_request_{0};
};

}  // namespace codex::firmware
