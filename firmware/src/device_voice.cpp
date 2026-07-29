#include "device_voice.hpp"

namespace codex::firmware {

bool DeviceVoice::start(DeviceProtocolClient& client, const String& mode) {
  if (recording_ || (mode != "chat" && mode != "command")) return false;
  last_error_ = "";
  if (strcmp(client.transportKind(), "usb") != 0 &&
      strcmp(client.transportKind(), "wifi") != 0) {
    last_error_ = "当前连接不支持语音";
    return false;
  }
  if (!client.sendVoiceStart(mode)) {
    last_error_ = "语音开始请求发送失败";
    return false;
  }

  M5.Speaker.stop();
  M5.Speaker.end();
  if (!M5.Mic.begin()) {
    client.sendVoiceStop();
    M5.Speaker.begin();
    last_error_ = "麦克风初始化失败";
    return false;
  }
  client_ = &client;
  recording_ = true;
  chunk_pending_ = false;
  consecutive_send_failures_ = 0;
  consecutive_capture_failures_ = 0;
  if (!beginChunk()) {
    finish("麦克风采集启动失败");
    return false;
  }
  return true;
}

void DeviceVoice::poll() {
  if (!recording_) return;
  if (chunk_pending_ && M5.Mic.isRecording() != 0) return;
  if (chunk_pending_) {
    if (sendCompletedChunk()) {
      consecutive_send_failures_ = 0;
    } else if (
        ++consecutive_send_failures_ >=
        kMaximumConsecutiveSendFailures) {
      finish("语音音频连续发送失败");
      return;
    }
  }
  if (beginChunk()) {
    consecutive_capture_failures_ = 0;
  } else if (
      ++consecutive_capture_failures_ >=
      kMaximumConsecutiveCaptureFailures) {
    finish("麦克风连续采集失败");
  }
}

bool DeviceVoice::stop() {
  return finish("");
}

bool DeviceVoice::finish(const String& error) {
  if (!recording_) return false;
  if (chunk_pending_ && M5.Mic.isRecording() == 0) sendCompletedChunk();
  M5.Mic.end();
  M5.Speaker.begin();
  const auto sent = client_ != nullptr && client_->sendVoiceStop();
  client_ = nullptr;
  recording_ = false;
  chunk_pending_ = false;
  consecutive_send_failures_ = 0;
  consecutive_capture_failures_ = 0;
  last_error_ = error;
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
