#pragma once

#include <M5Unified.h>
#include <esp_partition.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <array>
#include <atomic>
#include <cstdint>

#include "codex_core/audio.hpp"
#include "esp_tts_compat.hpp"

namespace codex::firmware {

class DeviceAudio {
 public:
  bool begin();
  bool enqueue(AudioCue cue);
  bool enqueuePhrase(const String& phrase);
  bool beginRemoteSpeech(std::uint32_t audio_id);
  bool enqueueRemoteSpeech(
      std::uint32_t audio_id,
      const std::int16_t* samples,
      std::size_t sample_count);
  bool finishRemoteSpeech(std::uint32_t audio_id);
  void cancel();
  void setPaused(bool paused) { paused_ = paused; }
  bool voiceAvailable() const { return voice_ready_; }
  bool busy() const {
    return last_completed_request_.load() != last_enqueued_request_.load();
  }

  static constexpr std::uint32_t kRemoteSampleRate = 16'000;
  static constexpr std::size_t kRemoteChunkSamples = 1'024;

 private:
  static void taskEntry(void* context);
  void run();
  bool initializeVoice();
  bool speak(const char* phrase);
  bool playRemoteSpeech(std::uint32_t audio_id, std::uint32_t generation);
  void playFallback(const AudioPlan& plan);
  bool interrupted() const;

  static constexpr std::uint8_t kSpeakerChannel = 0;
  static constexpr std::size_t kMaximumPhraseBytes = 240;

  struct AudioRequest {
    std::uint32_t id = 0;
    AudioCue cue = AudioCue::Ready;
    bool custom_phrase = false;
    bool remote_speech = false;
    std::uint32_t remote_audio_id = 0;
    std::uint32_t remote_generation = 0;
    std::array<char, kMaximumPhraseBytes + 1> phrase{};
  };

  struct RemoteAudioChunk {
    std::uint16_t sample_count = 0;
    std::array<std::int16_t, kRemoteChunkSamples> samples{};
  };

  QueueHandle_t queue_ = nullptr;
  QueueHandle_t remote_queue_ = nullptr;
  TaskHandle_t task_ = nullptr;
  esp_tts_voice_t* voice_ = nullptr;
  esp_tts_handle_t tts_ = nullptr;
  void* voice_data_ = nullptr;
  bool voice_ready_ = false;
  volatile bool paused_ = false;
  std::atomic<std::uint32_t> next_request_id_{1};
  std::atomic<std::uint32_t> last_enqueued_request_{0};
  std::atomic<std::uint32_t> last_completed_request_{0};
  std::atomic<bool> cancel_requested_{false};
  std::atomic<std::uint32_t> remote_audio_id_{0};
  std::atomic<std::uint32_t> remote_generation_{0};
  std::atomic<bool> remote_input_open_{false};
  // Keep streamed PCM outside the audio FreeRTOS task stack. Three playback
  // buffers plus one queue receiver are about 8 KiB during a reply.
  std::array<RemoteAudioChunk, 3> remote_playback_buffers_{};
  RemoteAudioChunk remote_playback_incoming_{};
};

}  // namespace codex::firmware
