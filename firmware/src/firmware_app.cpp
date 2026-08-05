#include "firmware_app.hpp"

#include <M5Unified.h>
#include <esp32-hal-ledc.h>
#include <esp_log.h>
#include <mbedtls/base64.h>

#include <algorithm>
#include <array>
#include <cstdarg>
#include <cstring>
#include <ctime>

namespace codex::firmware {
namespace {

constexpr std::uint64_t kTelemetryIntervalMs = 30'000;
constexpr std::uint64_t kResourceRetryMs = 30'000;
constexpr std::uint64_t kPetRequestSettlingMs = 500;
constexpr std::uint64_t kWifiProvisioningRestartDelayMs = 750;
constexpr DeviceCapabilities kTab5Capabilities{
    true, true, true, true, true, false, true, true, true};

int discardEspLog(const char*, va_list) {
  return 0;
}

void restartWirelessCoprocessor() {
#if defined(CONFIG_IDF_TARGET_ESP32P4)
  if (M5.getBoard() != m5::board_t::board_M5Tab5) return;

  auto& antenna = M5.getIOExpander(0);
  antenna.setDirection(0, true);
  antenna.setHighImpedance(0, false);
  antenna.digitalWrite(0, false);

  auto& power = M5.getIOExpander(1);
  power.setDirection(0, true);
  power.setHighImpedance(0, false);
  power.digitalWrite(0, false);
  delay(250);
  power.digitalWrite(0, true);
  delay(1'000);
#endif
}

bool decodeRemoteSpeechChunk(
    const JsonObjectConst payload,
    std::uint32_t& audio_id,
    std::array<std::int16_t, DeviceAudio::kRemoteChunkSamples>& samples,
    std::size_t& sample_count) {
  if (
      !payload["audioId"].is<std::uint32_t>() ||
      payload["sampleRate"] != DeviceAudio::kRemoteSampleRate ||
      !payload["samplesPerChannel"].is<int>() ||
      !payload["data"].is<const char*>()) {
    return false;
  }
  const auto requested_samples = payload["samplesPerChannel"].as<int>();
  if (
      requested_samples < 1 ||
      requested_samples > static_cast<int>(DeviceAudio::kRemoteChunkSamples)) {
    return false;
  }
  const String encoded = payload["data"].as<const char*>();
  const auto maximum_encoded_length =
      4U * ((DeviceAudio::kRemoteChunkSamples * sizeof(std::int16_t) + 2U) / 3U);
  if (encoded.isEmpty() || encoded.length() > maximum_encoded_length) return false;
  std::size_t decoded_bytes = 0;
  if (
      mbedtls_base64_decode(
          reinterpret_cast<std::uint8_t*>(samples.data()),
          samples.size() * sizeof(samples[0]),
          &decoded_bytes,
          reinterpret_cast<const std::uint8_t*>(encoded.c_str()),
          encoded.length()) != 0 ||
      decoded_bytes != static_cast<std::size_t>(requested_samples) * sizeof(samples[0])) {
    return false;
  }
  audio_id = payload["audioId"].as<std::uint32_t>();
  sample_count = static_cast<std::size_t>(requested_samples);
  return audio_id != 0;
}

}  // namespace

void FirmwareApp::setup() {
  ledcSetClockSource(LEDC_USE_PLL_DIV_CLK);
  esp_log_set_vprintf(discardEspLog);
  esp_log_level_set("*", ESP_LOG_NONE);
  UsbTransport::prepareSerialBuffers();
  auto config = M5.config();
  config.serial_baudrate = 115200;
  config.internal_spk = true;
  config.internal_mic = true;
  config.internal_rtc = true;
  M5.begin(config);
  restartWirelessCoprocessor();
  M5.Display.setRotation(1);
  setenv("TZ", "CST-8", 1);
  tzset();
  if (M5.Rtc.isEnabled()) M5.Rtc.setSystemTimeFromRtc();
  Serial.begin(115200);

  if (!config_store_.begin()) connection_detail_ = "配置存储初始化失败";
  pairing_secret_ = config_store_.config().pairing_secret;
  pet_store_.begin();
  if (!audio_.begin()) {
    log_e("设备中文语音不可用，将使用非阻塞提示音");
  }
  if (!ui_.begin(
          pet_store_,
          config_store_.config().device_id,
          config_store_.config().setup_code)) {
    M5.Display.fillScreen(TFT_RED);
    M5.Display.drawString("UI memory failure", 10, 10);
  }

  usb_transport_.begin();
  const auto& stored = config_store_.config();
  const auto ble_ready = ble_transport_.begin(stored.device_id);
  if (!stored.wifi_ssid.isEmpty() && !stored.bridge_host.isEmpty()) {
    wifi_transport_.begin(
        stored.wifi_ssid, stored.wifi_password, stored.bridge_host, stored.bridge_port);
  }
  usb_client_.begin(usb_transport_, stored.device_id, pairing_secret_);
  wifi_client_.begin(wifi_transport_, stored.device_id, pairing_secret_);
  ble_client_.begin(ble_transport_, stored.device_id, pairing_secret_);
  const auto voice_ready = audio_.voiceAvailable();
  const auto storage_ready = pet_store_.available();
  auto capabilities = kTab5Capabilities;
  capabilities.ble = ble_ready;
  usb_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-tab5-k145",
      capabilities,
      voice_ready,
      storage_ready);
  wifi_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-tab5-k145",
      capabilities,
      voice_ready,
      storage_ready);
  ble_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-tab5-k145",
      capabilities,
      voice_ready,
      storage_ready);
  configureProtocol(usb_client_);
  configureProtocol(wifi_client_);
  configureProtocol(ble_client_);
  connection_detail_ = paired() ? "斯卡蒂在这里" : "请通过 USB 连接电脑并输入配对码";
}

bool FirmwareApp::captureWithReleasedStorage(
    DeviceProtocolClient& client,
    String& error) {
  ui_.suspendBundledStorageForCamera();
  if (!pet_store_.suspendForCamera(error)) {
    ui_.resumeBundledStorageAfterCamera();
    return false;
  }
  delay(25);

  const auto captured = camera_.captureAndQueue(client, error);
  String storage_error;
  const auto pet_store_restored =
      pet_store_.resumeAfterCamera(storage_error);
  const auto bundled_storage_restored =
      ui_.resumeBundledStorageAfterCamera();
  if (!pet_store_restored || !bundled_storage_restored) {
    if (!storage_error.isEmpty()) {
      if (!error.isEmpty()) error += "；";
      error += storage_error;
    }
    if (!bundled_storage_restored) {
      if (!error.isEmpty()) error += "；";
      error += "内置主题存储恢复失败";
    }
    log_e("%s", error.c_str());
  }
  return captured;
}

void FirmwareApp::loop() {
  const auto now_ms = static_cast<std::uint64_t>(millis());
  M5.update();
  usb_client_.poll(now_ms);
  wifi_client_.poll(now_ms);
  ble_client_.poll(now_ms);
  const auto voice_was_recording = voice_.recording();
  const auto voice_was_care = voice_.mode() == "care";
  const auto voice_was_phone = voice_.mode() == "phone";
  voice_.poll();
  if (voice_was_recording && !voice_.recording()) {
    audio_.setPaused(false);
    ui_.setVoiceRecording(false);
    switch (voice_.lastStopReason()) {
      case VoiceStopReason::SpeechComplete:
      case VoiceStopReason::Manual:
        connection_detail_ = voice_was_phone ? "……" : "正在识别";
        break;
      case VoiceStopReason::NoSpeechTimeout:
        connection_detail_ = voice_was_phone ? "没有听清，再说一次。" : "已结束聆听";
        break;
      case VoiceStopReason::LinkError:
        connection_detail_ = "语音链路中断";
        break;
      case VoiceStopReason::None:
        break;
    }
    if (voice_was_care) {
      care_animation_override_ = true;
      care_animation_ = Animation::Review;
    }
  }
  startPendingCareListening();
  startPendingPhoneListening();
  ui_.setSpeechPlaybackActive(
      phone_call_active_ && !voice_.recording() && audio_.busy());
  if (
      care_animation_override_ &&
      care_animation_ == Animation::Waving &&
      !audio_.busy()) {
    if (pending_care_listen_) {
      care_animation_ = Animation::Waiting;
    } else {
      care_animation_override_ = false;
    }
  }
  const auto camera_was_uploading = camera_.uploading();
  camera_.poll();
  if (camera_was_uploading && !camera_.uploading()) {
    ui_.setCameraBusy(false);
    connection_detail_ = camera_.lastError().isEmpty()
        ? "照片已发送，正在观察"
        : camera_.lastError();
  }
  updateConnectionState();
  syncClock(now_ms);
  updateTelemetry(now_ms);
  requestSelectedPet(now_ms);
  handleUiAction(ui_.poll(model_.snapshot(), now_ms, paired()));

  const auto& selected_pet_id = model_.snapshot().selected_pet_id;
  const auto transfer_progress =
      selected_pet_id == "chibi-skadi" ? 0 : pet_store_.transferProgress();
  auto display_snapshot = model_.snapshot();
  if (care_animation_override_) {
    display_snapshot.animation = care_animation_;
  }
  ui_.render(
      display_snapshot, now_ms, paired(), connection_detail_, transfer_progress);
  if (wifi_reboot_at_ != 0 && now_ms >= wifi_reboot_at_) {
    ESP.restart();
  }
  delay(2);
}

void FirmwareApp::configureProtocol(DeviceProtocolClient& client) {
  client.setSnapshotHandler([this](const Snapshot& snapshot) { handleSnapshot(snapshot); });
  client.setSecretHandler(
      [this, &client](const String& secret) {
        applyPairingSecret(secret, &client);
      });
  client.setEventHandler(
      [this, &client](const String& type, const JsonObjectConst payload) {
        handleProtocolEvent(client, type, payload);
      });
  client.setStateHandler(
      [this](const bool connected, const String&) {
        if (connected || primaryClient() == nullptr) {
          connection_detail_ = connected ? "斯卡蒂在这里" : "正在尝试连接。";
        }
      });
  client.setCommandHandler(
      [this, &client](
          const String& command,
          const JsonObjectConst payload,
          JsonObject result,
          String& error) {
        return handleDeviceCommand(client, command, payload, result, error);
      });
}

bool FirmwareApp::handleDeviceCommand(
    DeviceProtocolClient& client,
    const String& command,
    const JsonObjectConst payload,
    JsonObject result,
    String& error) {
  if (
      command == "device.brightness.set" ||
      command == "device.volume.set") {
    if (!payload["value"].is<int>()) {
      error = "INVALID_DEVICE_VALUE";
      return false;
    }
    const auto value = payload["value"].as<int>();
    if (value < 0 || value > 100) {
      error = "INVALID_DEVICE_VALUE";
      return false;
    }
    const auto to_percent = [](const std::uint8_t raw) {
      return static_cast<int>(
          (static_cast<std::uint16_t>(raw) * 100U + 127U) / 255U);
    };
    const auto to_raw = [](const int percent) {
      return static_cast<std::uint8_t>(
          (static_cast<std::uint16_t>(percent) * 255U + 50U) / 100U);
    };
    if (command == "device.brightness.set") {
      result["previousValue"] = to_percent(M5.Display.getBrightness());
      M5.Display.setBrightness(to_raw(value));
      connection_detail_ = "屏幕亮度已调整";
    } else {
      result["previousValue"] = to_percent(M5.Speaker.getVolume());
      M5.Speaker.setVolume(to_raw(value));
      connection_detail_ = "设备音量已调整";
    }
    result["value"] = value;
    return true;
  }
  if (command == "camera.capture") {
    const String reason = payload["reason"] | "";
    if (
        reason != "scheduled" &&
        reason != "follow-up" &&
        reason != "manual") {
      error = "INVALID_CAPTURE_REASON";
      return false;
    }
    if (
        strcmp(client.transportKind(), "usb") != 0 &&
        strcmp(client.transportKind(), "wifi") != 0) {
      error = "HIGH_BANDWIDTH_TRANSPORT_REQUIRED";
      return false;
    }
    if (voice_.recording()) {
      error = "VOICE_BUSY";
      return false;
    }
    if (camera_.uploading()) {
      error = "CAMERA_BUSY";
      return false;
    }
    if (pet_store_.transferActive()) {
      error = "RESOURCE_TRANSFER_BUSY";
      return false;
    }
    connection_detail_ = "正在主动观察";
    if (!captureWithReleasedStorage(client, error)) {
      ui_.setCameraBusy(false);
      return false;
    }
    care_animation_override_ = true;
    care_animation_ = Animation::Review;
    ui_.setCameraBusy(true);
    connection_detail_ = "照片正在加密发送";
    result["captureId"] = camera_.captureId();
    return true;
  }
  if (command != "wifi.provision") {
    error = "UNSUPPORTED_COMMAND";
    return false;
  }
  if (strcmp(client.transportKind(), "usb") != 0) {
    error = "USB_REQUIRED";
    return false;
  }
  if (
      !payload["ssid"].is<const char*>() ||
      !payload["password"].is<const char*>() ||
      !payload["bridgeHost"].is<const char*>() ||
      !payload["bridgePort"].is<std::uint16_t>()) {
    error = "INVALID_WIFI_CONFIGURATION";
    return false;
  }
  const String ssid = payload["ssid"].as<const char*>();
  const String password = payload["password"].as<const char*>();
  const String bridge_host = payload["bridgeHost"].as<const char*>();
  const auto bridge_port = payload["bridgePort"].as<std::uint16_t>();
  const auto has_control_character = [](const String& value) {
    for (std::size_t index = 0; index < value.length(); ++index) {
      const auto character = static_cast<std::uint8_t>(value[index]);
      if (character < 0x20U || character == 0x7fU) return true;
    }
    return false;
  };
  if (
      ssid.isEmpty() || ssid.length() > 32 || password.length() > 64 ||
      bridge_host.isEmpty() || bridge_host.length() > 253 || bridge_port == 0 ||
      has_control_character(ssid) || has_control_character(password) ||
      bridge_host[0] == '.' || bridge_host[0] == '-' ||
      bridge_host[bridge_host.length() - 1] == '.' ||
      bridge_host[bridge_host.length() - 1] == '-') {
    error = "INVALID_WIFI_CONFIGURATION";
    return false;
  }
  for (std::size_t index = 0; index < bridge_host.length(); ++index) {
    const auto character = bridge_host[index];
    if (!(
            isAlphaNumeric(character) || character == '.' ||
            character == '-')) {
      error = "INVALID_WIFI_CONFIGURATION";
      return false;
    }
  }
  if (!config_store_.saveNetwork(ssid, password, bridge_host, bridge_port)) {
    error = "CONFIGURATION_SAVE_FAILED";
    return false;
  }
  connection_detail_ = "Wi-Fi配置已保存，正在重启";
  wifi_reboot_at_ = static_cast<std::uint64_t>(millis()) +
      kWifiProvisioningRestartDelayMs;
  return true;
}

void FirmwareApp::handleSnapshot(const Snapshot& snapshot) {
  auto display_snapshot = snapshot;
  if (have_local_telemetry_) {
    display_snapshot.telemetry = local_telemetry_;
  }
  if (!model_.applySnapshot(display_snapshot)) return;
  requested_pet_ = "";
  pet_request_not_before_ = millis() + kPetRequestSettlingMs;
}

void FirmwareApp::handleProtocolEvent(
    DeviceProtocolClient& client,
    const String& type,
    const JsonObjectConst payload) {
  if (type.startsWith("resource.")) {
    if (type == "resource.current") {
      requested_pet_ = "";
      return;
    }
    if (type == "resource.requires-high-bandwidth") {
      connection_detail_ = "Pet同步需要USB或Wi-Fi";
      return;
    }
    String error;
    if (!pet_store_.handleMessage(type, payload, error)) {
      connection_detail_ = "Pet同步失败: " + error;
      return;
    }
    if (type == "resource.commit") {
      requested_pet_ = "";
      connection_detail_ = "Pet已安装";
      audio_.enqueue(AudioCue::PetInstalled);
    }
    return;
  }
  const String event = payload["event"] | "";
  if (event == "resource.error") {
    connection_detail_ = String("Pet同步失败: ") + (payload["error"] | "unknown");
  } else if (event == "voice.reply") {
    const String reply = payload["text"] | "没有听清，请再说一次";
    const auto ok = payload["ok"] | false;
    const auto continue_listening = payload["continueListening"] | false;
    const auto requested_seconds = payload["autoListenSeconds"] | 20;
    connection_detail_ = reply;
    const auto remote_audio = payload["remoteAudio"] | false;
    const auto audio_id = payload["audioId"] | 0;
    const auto speaking = ok && remote_audio && audio_id > 0
        ? audio_.beginRemoteSpeech(static_cast<std::uint32_t>(audio_id))
        : ok && !reply.isEmpty() && audio_.enqueuePhrase(reply);
    if (ok && remote_audio && !speaking && !reply.isEmpty()) {
      audio_.enqueuePhrase(reply);
    }
    if (phone_call_active_ && continue_listening && ok) {
      pending_phone_listen_ = true;
      pending_phone_client_ = &client;
      pending_phone_listen_seconds_ = static_cast<std::uint8_t>(
          std::clamp(requested_seconds, 5, 60));
    } else if (phone_call_active_ && (!ok || !continue_listening)) {
      pending_phone_listen_ = false;
      pending_phone_client_ = nullptr;
      phone_call_active_ = false;
      ui_.setPhoneCallActive(false);
    }
  } else if (event == "voice.audio.chunk") {
    std::uint32_t audio_id = 0;
    std::size_t sample_count = 0;
    if (
        !decodeRemoteSpeechChunk(
            payload,
            audio_id,
            remote_speech_samples_,
            sample_count) ||
        !audio_.enqueueRemoteSpeech(
            audio_id,
            remote_speech_samples_.data(),
            sample_count)) {
      connection_detail_ = "语音数据暂时不完整。";
    }
  } else if (event == "voice.audio.end") {
    if (!payload["audioId"].is<std::uint32_t>() ||
        !audio_.finishRemoteSpeech(payload["audioId"].as<std::uint32_t>())) {
      connection_detail_ = "语音播放已结束。";
    }
  } else if (event == "voice.command.queued") {
    connection_detail_ = "收到一条需要确认的请求。";
  } else if (event == "care.reply") {
    pending_care_listen_ = false;
    pending_care_client_ = nullptr;
    const String reply = payload["text"] | "";
    const String source = payload["source"] | "voice";
    if (!(payload["ok"] | false)) {
      connection_detail_ = reply.isEmpty() ? "关怀对话失败" : reply;
      care_animation_override_ = false;
      return;
    }
    const auto speaking = !reply.isEmpty() && audio_.enqueuePhrase(reply);
    const auto continue_listening = payload["continueListening"] | false;
    const auto requested_seconds = payload["autoListenSeconds"] | 20;
    if (continue_listening) {
      pending_care_listen_ = true;
      pending_care_client_ = &client;
      pending_care_listen_seconds_ = static_cast<std::uint8_t>(
          std::clamp(requested_seconds, 5, 60));
    }
    if (speaking) {
      connection_detail_ = reply;
      care_animation_override_ = true;
      care_animation_ = Animation::Waving;
    } else if (continue_listening) {
      connection_detail_ = "准备聆听";
      care_animation_override_ = true;
      care_animation_ = Animation::Waiting;
    } else {
      connection_detail_ =
          source == "observation" ? "观察完成" : "对话结束";
      care_animation_override_ = false;
    }
  } else if (event == "care.stop") {
    pending_care_listen_ = false;
    pending_care_client_ = nullptr;
    audio_.cancel();
    if (voice_.recording() && voice_.mode() == "care") voice_.stop();
    audio_.setPaused(false);
    ui_.setVoiceRecording(false);
    care_animation_override_ = false;
    connection_detail_ = "关怀对话已停止";
  } else if (event == "vision.reply") {
    const String reply = payload["text"] | "照片分析失败";
    const auto silent = payload["silent"] | false;
    connection_detail_ = silent ? "观察完成" : reply;
    if ((payload["ok"] | false) && !silent && !reply.isEmpty()) {
      audio_.enqueuePhrase(reply);
    }
  }
}

void FirmwareApp::startPendingCareListening() {
  if (
      !pending_care_listen_ ||
      phone_call_active_ ||
      audio_.busy() ||
      voice_.recording() ||
      camera_.uploading() ||
      pet_store_.transferActive()) {
    return;
  }
  auto* client = pending_care_client_;
  pending_care_listen_ = false;
  pending_care_client_ = nullptr;
  if (
      client == nullptr ||
      !client->ready() ||
      (strcmp(client->transportKind(), "usb") != 0 &&
       strcmp(client->transportKind(), "wifi") != 0)) {
    connection_detail_ = "自动聆听需要 USB 或 Wi-Fi";
    return;
  }
  audio_.setPaused(true);
  if (voice_.start(
          *client,
          "care",
          true,
          pending_care_listen_seconds_)) {
    ui_.setVoiceRecording(true, "care");
    care_animation_override_ = true;
    care_animation_ = Animation::Waiting;
    connection_detail_ = "正在听";
    return;
  }
  audio_.setPaused(false);
  connection_detail_ = "麦克风启动失败";
}

void FirmwareApp::startPendingPhoneListening() {
  if (
      !phone_call_active_ ||
      !pending_phone_listen_ ||
      audio_.busy() ||
      voice_.recording() ||
      camera_.uploading() ||
      pet_store_.transferActive()) {
    return;
  }
  auto* client = pending_phone_client_;
  pending_phone_listen_ = false;
  pending_phone_client_ = nullptr;
  if (
      client == nullptr ||
      !client->ready() ||
      (strcmp(client->transportKind(), "usb") != 0 &&
       strcmp(client->transportKind(), "wifi") != 0)) {
    phone_call_active_ = false;
    ui_.setPhoneCallActive(false);
    connection_detail_ = "通话连接已断开。";
    return;
  }
  audio_.setPaused(true);
  if (voice_.start(
          *client,
          "phone",
          true,
          pending_phone_listen_seconds_)) {
    ui_.setVoiceRecording(true, "phone");
    connection_detail_ = "我在听，你慢慢说。";
    return;
  }
  audio_.setPaused(false);
  phone_call_active_ = false;
  ui_.setPhoneCallActive(false);
  connection_detail_ = "麦克风启动失败。";
}

void FirmwareApp::endPhoneCall() {
  pending_phone_listen_ = false;
  pending_phone_client_ = nullptr;
  if (voice_.recording() && voice_.mode() == "phone") {
    voice_.cancel();
  } else {
    auto* client = primaryClient();
    if (client != nullptr) client->sendVoiceStop(true);
  }
  audio_.cancel();
  audio_.setPaused(false);
  ui_.setSpeechPlaybackActive(false);
  ui_.setVoiceRecording(false);
  phone_call_active_ = false;
  ui_.setPhoneCallActive(false);
  care_animation_override_ = false;
  connection_detail_ = "通话已结束。";
}

void FirmwareApp::handleUiAction(const UiAction& action) {
  auto* client = primaryClient();
  switch (action.type) {
    case UiActionType::PreviousPet:
      selectPetOffset(-1);
      break;
    case UiActionType::NextPet:
      selectPetOffset(1);
      break;
    case UiActionType::AcceptApproval:
      if (client != nullptr &&
          model_.snapshot().companion.awaitingConfirmation()) {
        client->sendCompanionDecision(
            model_.snapshot().companion.request_id.c_str(),
            true);
      } else if (client != nullptr &&
          model_.snapshot().approval.present &&
          model_.snapshot().approval.safe_to_approve) {
        client->sendApprovalDecision(model_.snapshot().approval.request_id.c_str(), true);
      }
      break;
    case UiActionType::DeclineApproval:
      if (client != nullptr &&
          model_.snapshot().companion.awaitingConfirmation()) {
        client->sendCompanionDecision(
            model_.snapshot().companion.request_id.c_str(),
            false);
      } else if (client != nullptr && model_.snapshot().approval.present) {
        client->sendApprovalDecision(model_.snapshot().approval.request_id.c_str(), false);
      }
      break;
    case UiActionType::VoiceStart:
      pending_care_listen_ = false;
      pending_care_client_ = nullptr;
      pending_phone_listen_ = false;
      pending_phone_client_ = nullptr;
      if (client == nullptr) {
        connection_detail_ = "语音需要连接电脑";
      } else if (camera_.uploading()) {
        connection_detail_ = "请等待照片发送完成";
      } else if (
          primaryTransport() == TransportKind::Ble) {
        connection_detail_ = "语音需要 USB 或 Wi-Fi";
      } else {
        audio_.setPaused(true);
        const auto phone_mode = action.value == "phone";
        if (voice_.start(
                *client,
                action.value,
                phone_mode,
                phone_mode ? 20 : 60)) {
          ui_.setVoiceRecording(true, action.value);
          phone_call_active_ = phone_mode;
          ui_.setPhoneCallActive(phone_call_active_);
          connection_detail_ = phone_mode ? "我在听，你慢慢说。" : "正在听";
        } else {
          audio_.setPaused(false);
          phone_call_active_ = false;
          ui_.setPhoneCallActive(false);
          connection_detail_ = "麦克风启动失败";
        }
      }
      break;
    case UiActionType::VoiceStop:
      if (voice_.mode() == "phone") {
        endPhoneCall();
        break;
      }
      if (voice_.stop()) {
        connection_detail_ = "正在识别";
      }
      audio_.setPaused(false);
      ui_.setVoiceRecording(false);
      break;
    case UiActionType::VoiceEndCall:
      endPhoneCall();
      break;
    case UiActionType::CameraCapture:
      if (client == nullptr) {
        connection_detail_ = "拍照需要连接电脑";
      } else if (voice_.recording() || phone_call_active_) {
        connection_detail_ = "请先挂断通话。";
      } else if (camera_.uploading()) {
        connection_detail_ = "照片仍在发送";
      } else {
        String error;
        connection_detail_ = "正在拍照";
        if (captureWithReleasedStorage(*client, error)) {
          ui_.setCameraBusy(true);
          connection_detail_ = "照片正在加密发送";
        } else {
          ui_.setCameraBusy(false);
          connection_detail_ = error;
        }
      }
      break;
    case UiActionType::SubmitPairingCode:
      usb_client_.setPairingCode(action.value);
      wifi_client_.setPairingCode(action.value);
      ble_client_.setPairingCode(action.value);
      connection_detail_ = "正在验证配对码";
      break;
    case UiActionType::None:
      break;
  }
}

void FirmwareApp::updateTelemetry(const std::uint64_t now_ms) {
  if (last_telemetry_at_ != 0 && now_ms - last_telemetry_at_ < kTelemetryIntervalMs) return;
  last_telemetry_at_ = now_ms;
  const auto raw_level = M5.Power.getBatteryLevel();
  Telemetry telemetry;
  telemetry.battery_percent = static_cast<std::uint8_t>(std::clamp(raw_level, 0L, 100L));
  telemetry.charging = M5.Power.isCharging();
  telemetry.wifi_rssi = wifi_transport_.rssi();
  telemetry.transport = primaryTransport();
  local_telemetry_ = telemetry;
  have_local_telemetry_ = true;
  model_.updateTelemetryLocally(telemetry);
  if (auto* client = primaryClient(); client != nullptr) {
    client->sendTelemetry(
        telemetry.battery_percent,
        telemetry.charging,
        telemetry.wifi_rssi,
        temperatureRead());
  }
}

void FirmwareApp::syncClock(const std::uint64_t now_ms) {
  if (WiFi.status() != WL_CONNECTED || rtc_synced_) return;
  if (!ntp_started_) {
    configTzTime("CST-8", "ntp.aliyun.com", "pool.ntp.org", "time.cloudflare.com");
    ntp_started_ = true;
  }
  if (last_clock_check_at_ != 0 && now_ms - last_clock_check_at_ < 5'000) return;
  last_clock_check_at_ = now_ms;
  const auto now = std::time(nullptr);
  if (now < 1'700'000'000) return;
  if (M5.Rtc.isEnabled()) M5.Rtc.setDateTime(gmtime(&now));
  rtc_synced_ = true;
}

void FirmwareApp::requestSelectedPet(const std::uint64_t now_ms) {
  const String pet_id(model_.snapshot().selected_pet_id.c_str());
  if (
      pet_id.isEmpty() ||
      pet_id == "codex-core" ||
      pet_id == "chibi-skadi" ||
      !pet_store_.available()) {
    return;
  }
  auto* client = primaryClient();
  if (client == nullptr) return;
  if (now_ms < pet_request_not_before_) return;
  if (requested_pet_ == pet_id && now_ms - requested_at_ < kResourceRetryMs) return;
  const auto installed = pet_store_.installedSha(pet_id);
  const auto resume = pet_store_.resumeFor(pet_id);
  if (client->requestResource(pet_id, installed, resume.sha256, resume.missing_ranges)) {
    requested_pet_ = pet_id;
    requested_at_ = now_ms;
    connection_detail_ = "正在同步Pet";
  }
}

void FirmwareApp::selectPetOffset(const int offset) {
  const auto& snapshot = model_.snapshot();
  if (snapshot.pets.size() < 2) return;
  const auto iterator = std::find_if(
      snapshot.pets.begin(), snapshot.pets.end(),
      [&snapshot](const PetSummary& pet) { return pet.id == snapshot.selected_pet_id; });
  auto index = iterator == snapshot.pets.end()
      ? 0
      : static_cast<int>(std::distance(snapshot.pets.begin(), iterator));
  index = (index + offset + static_cast<int>(snapshot.pets.size())) %
      static_cast<int>(snapshot.pets.size());
  const auto& next = snapshot.pets[index];
  model_.selectPetLocally(next.id);
  requested_pet_ = "";
  if (auto* client = primaryClient(); client != nullptr) {
    client->sendPetSelection(next.id.c_str());
  }
  audio_.enqueue(AudioCue::PetSwitched);
}

void FirmwareApp::applyPairingSecret(
    const String& secret,
    DeviceProtocolClient* source_client) {
  if (pairing_secret_ == secret) return;
  if (!config_store_.savePairingSecret(secret)) {
    connection_detail_ = "配对凭据保存失败";
    return;
  }
  pairing_secret_ = secret;
  if (source_client != &usb_client_) usb_client_.setPairingSecret(secret);
  if (source_client != &wifi_client_) wifi_client_.setPairingSecret(secret);
  if (source_client != &ble_client_) ble_client_.setPairingSecret(secret);
  connection_detail_ = "配对成功";
}

void FirmwareApp::updateConnectionState() {
  if (primaryClient() == nullptr) {
    model_.markOffline();
    if (phone_call_active_) endPhoneCall();
  }
}

DeviceProtocolClient* FirmwareApp::primaryClient() {
  if (usb_client_.ready()) return &usb_client_;
  if (wifi_client_.ready()) return &wifi_client_;
  if (ble_client_.ready()) return &ble_client_;
  return nullptr;
}

TransportKind FirmwareApp::primaryTransport() const {
  if (usb_client_.ready()) return TransportKind::Usb;
  if (wifi_client_.ready()) return TransportKind::Wifi;
  if (ble_client_.ready()) return TransportKind::Ble;
  return TransportKind::Offline;
}

bool FirmwareApp::paired() const {
  return pairing_secret_.length() == 64;
}

}  // namespace codex::firmware
