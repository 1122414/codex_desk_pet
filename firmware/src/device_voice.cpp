#include "device_voice.hpp"

#include <algorithm>

namespace codex::firmware {
namespace {

bool elapsed(
    const std::uint32_t now_ms,
    const std::uint32_t since_ms,
    const std::uint32_t duration_ms) {
  return static_cast<std::uint32_t>(now_ms - since_ms) >= duration_ms;
}

}  // namespace

bool DeviceVoice::start(
    DeviceProtocolClient& client,
    const String& mode,
    const bool automatic_stop,
    const std::uint8_t maximum_duration_seconds) {
  if (
      recording_ ||
      (mode != "chat" && mode != "command" && mode != "care")) {
    return false;
  }
  if (strcmp(client.transportKind(), "usb") != 0 &&
      strcmp(client.transportKind(), "wifi") != 0) {
    return false;
  }
  if (!client.sendVoiceStart(mode)) return false;

  M5.Speaker.stop();
  M5.Speaker.end();
  if (!M5.Mic.begin()) {
    client.sendVoiceStop();
    M5.Speaker.begin();
    return false;
  }
  client_ = &client;
  mode_ = mode;
  recording_ = true;
  chunk_pending_ = false;
  automatic_stop_ = automatic_stop;
  last_stop_reason_ = VoiceStopReason::None;
  recording_started_at_ms_ = static_cast<std::uint32_t>(millis());
  maximum_duration_ms_ = std::clamp<std::uint32_t>(
      static_cast<std::uint32_t>(maximum_duration_seconds) * 1'000U,
      5'000,
      60'000);
  activity_.begin(
      recording_started_at_ms_,
      maximum_duration_ms_);
  if (!beginChunk()) {
    stop(VoiceStopReason::LinkError);
    return false;
  }
  return true;
}

void DeviceVoice::poll() {
  if (!recording_) return;
  const auto now_ms = static_cast<std::uint32_t>(millis());
  if (elapsed(now_ms, recording_started_at_ms_, maximum_duration_ms_)) {
    stop(automatic_stop_ && activity_.heardSpeech()
        ? VoiceStopReason::SpeechComplete
        : VoiceStopReason::NoSpeechTimeout);
    return;
  }
  if (!chunk_pending_) return;
  if (M5.Mic.isRecording() != 0) {
    return;
  }
  const auto activity_result = automatic_stop_
      ? activity_.observe(samples_.data(), samples_.size(), now_ms)
      : VoiceActivityResult::Listening;
  if (!sendCompletedChunk()) {
    stop(VoiceStopReason::LinkError);
    return;
  }
  if (activity_result != VoiceActivityResult::Listening) {
    stop(activity_result == VoiceActivityResult::NoSpeechTimeout
        ? VoiceStopReason::NoSpeechTimeout
        : VoiceStopReason::SpeechComplete);
    return;
  }
  if (!beginChunk()) stop(VoiceStopReason::LinkError);
}

bool DeviceVoice::stop(const VoiceStopReason reason) {
  if (!recording_) return false;
  if (chunk_pending_ && M5.Mic.isRecording() == 0) sendCompletedChunk();
  M5.Mic.end();
  M5.Speaker.begin();
  const auto sent = client_ != nullptr && client_->sendVoiceStop();
  client_ = nullptr;
  recording_ = false;
  chunk_pending_ = false;
  automatic_stop_ = false;
  recording_started_at_ms_ = 0;
  last_stop_reason_ = reason;
  return sent;
}

bool DeviceVoice::beginChunk() {
  chunk_pending_ = M5.Mic.record(
      samples_.data(),
      samples_.size(),
      kSampleRate,
      false);
  return chunk_pending_;
}

bool DeviceVoice::sendCompletedChunk() {
  chunk_pending_ = false;
  return client_ != nullptr && client_->sendVoiceAudio(
      reinterpret_cast<const std::uint8_t*>(samples_.data()),
      samples_.size() * sizeof(samples_[0]),
      samples_.size());
}

}  // namespace codex::firmware
