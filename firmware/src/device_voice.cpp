#include "device_voice.hpp"

namespace codex::firmware {

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
  activity_.begin(
      millis(),
      static_cast<std::uint32_t>(maximum_duration_seconds) * 1'000U);
  if (!beginChunk()) {
    stop(VoiceStopReason::LinkError);
    return false;
  }
  return true;
}

void DeviceVoice::poll() {
  if (!recording_ || !chunk_pending_ || M5.Mic.isRecording() != 0) return;
  const auto activity_result = automatic_stop_
      ? activity_.observe(samples_.data(), samples_.size(), millis())
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
