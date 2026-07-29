#include "firmware_app.hpp"

#include <M5Unified.h>

#include <algorithm>
#include <cstring>
#include <ctime>

namespace codex::firmware {
namespace {

constexpr std::uint64_t kTelemetryIntervalMs = 30'000;
constexpr std::uint64_t kResourceRetryMs = 30'000;
constexpr std::uint64_t kWifiProvisioningRestartDelayMs = 750;
constexpr DeviceCapabilities kTab5Capabilities{
    true, true, true, true, true, false, true, true, true};

std::string boundedEventString(const char* value, const std::size_t maximum) {
  if (value == nullptr) return {};
  std::string result(value);
  if (result.size() > maximum) result.resize(maximum);
  return result;
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

}  // namespace

void FirmwareApp::setup() {
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
  connection_detail_ = paired()
      ? "等待电脑 Bridge（USB、Wi-Fi 或蓝牙）"
      : "请通过USB连接电脑并输入配对码";
}

void FirmwareApp::loop() {
  const auto now_ms = static_cast<std::uint64_t>(millis());
  M5.update();
  usb_client_.poll(now_ms);
  wifi_client_.poll(now_ms);
  ble_client_.poll(now_ms);
  capturePendingPhoto();
  const auto voice_was_recording = voice_.recording();
  voice_.poll();
  if (voice_was_recording && !voice_.recording()) {
    audio_.setPaused(false);
    ui_.setVoiceRecording(false);
    connection_detail_ = voice_.lastError().isEmpty()
        ? "语音链路中断"
        : voice_.lastError();
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
  ui_.render(
      model_.snapshot(), now_ms, paired(), connection_detail_, transfer_progress);
  if (wifi_reboot_at_ != 0 && now_ms >= wifi_reboot_at_) {
    ESP.restart();
  }
  delay(2);
}

void FirmwareApp::configureProtocol(DeviceProtocolClient& client) {
  client.setSnapshotHandler([this](const Snapshot& snapshot) { handleSnapshot(snapshot); });
  client.setSecretHandler([this](const String& secret) { applyPairingSecret(secret); });
  client.setEventHandler(
      [this](const String& type, const JsonObjectConst payload) {
        handleProtocolEvent(type, payload);
      });
  client.setStateHandler(
      [this](const bool connected, const String& detail) {
        if (connected || primaryClient() == nullptr) connection_detail_ = detail;
      });
  client.setCommandHandler(
      [this, &client](
          const String& command,
          const JsonObjectConst payload,
          String& error) {
        return handleDeviceCommand(client, command, payload, error);
      });
}

bool FirmwareApp::handleDeviceCommand(
    DeviceProtocolClient& client,
    const String& command,
    const JsonObjectConst payload,
    String& error) {
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
  const String previous_pet_id(model_.snapshot().selected_pet_id.c_str());
  auto display_snapshot = snapshot;
  if (have_local_telemetry_) {
    display_snapshot.telemetry = local_telemetry_;
  }
  if (!model_.applySnapshot(display_snapshot)) return;
  if (previous_pet_id != snapshot.selected_pet_id.c_str()) {
    requested_pet_ = "";
  }
  if (!have_cued_state_ || snapshot.state != last_cued_state_) {
    last_cued_state_ = snapshot.state;
    have_cued_state_ = true;
    audio_.enqueue(audioCueForState(snapshot.state));
  }
}

void FirmwareApp::handleProtocolEvent(
    const String& type,
    const JsonObjectConst payload) {
  if (type.startsWith("resource.")) {
    if (type == "resource.current") {
      requested_pet_ = payload["petId"] | "";
      requested_at_ = static_cast<std::uint64_t>(millis());
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
      ui_.invalidatePetCache();
      requested_pet_ = payload["petId"] | "";
      requested_at_ = static_cast<std::uint64_t>(millis());
      connection_detail_ = "Pet已安装";
      audio_.enqueue(AudioCue::PetInstalled);
    }
    return;
  }
  const String event = payload["event"] | "";
  if (event == "resource.error") {
    connection_detail_ = String("Pet同步失败: ") + (payload["error"] | "unknown");
  } else if (event == "voice.reply") {
    voice_.stop();
    audio_.setPaused(false);
    ui_.setVoiceRecording(false);
    const String reply = payload["text"] | "没有听清，请再说一次";
    connection_detail_ = reply;
    if (payload["ok"] | false) audio_.enqueuePhrase(reply);
  } else if (event == "voice.command.queued") {
    connection_detail_ = "语音命令等待确认";
  } else if (event == "vision.reply") {
    const String reply = payload["text"] | "照片分析失败";
    connection_detail_ = reply;
    if (payload["ok"] | false) audio_.enqueuePhrase(reply);
  } else if (event == "thread.detail") {
    ThreadDetail detail;
    detail.visible = true;
    detail.thread_id = boundedEventString(payload["threadId"] | "", 128);
    detail.title = boundedEventString(payload["title"] | "未命名会话", 160);
    detail.kind = strcmp(payload["kind"] | "", "project") == 0
        ? ThreadKind::Project
        : ThreadKind::Conversation;
    detail.workspace = boundedEventString(payload["workspace"] | "", 80);
    detail.total_messages = static_cast<std::uint16_t>(
        std::clamp<int>(payload["totalMessages"] | 0, 0, 65'535));
    detail.truncated = payload["truncated"] | false;
    if (payload["messages"].is<JsonArrayConst>()) {
      const auto messages = payload["messages"].as<JsonArrayConst>();
      const auto count = std::min<std::size_t>(messages.size(), 12);
      detail.messages.reserve(count);
      for (std::size_t index = 0; index < count; ++index) {
        const auto value = messages[index].as<JsonObjectConst>();
        const char* role = value["role"] | "";
        if (strcmp(role, "user") != 0 && strcmp(role, "assistant") != 0) {
          continue;
        }
        ConversationMessage message;
        message.id = boundedEventString(value["id"] | "", 96);
        message.role = strcmp(role, "user") == 0
            ? ConversationRole::User
            : ConversationRole::Assistant;
        message.text = boundedEventString(value["text"] | "", 420);
        if (!message.text.empty()) detail.messages.push_back(std::move(message));
      }
    }
    if (detail.thread_id.empty()) {
      ui_.setThreadError("", "会话详情格式无效");
      connection_detail_ = "会话详情格式无效";
    } else {
      ui_.setThreadDetail(detail);
      connection_detail_ = "已打开 " + String(detail.title.c_str());
    }
  }
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
      if (client == nullptr) {
        connection_detail_ = "语音需要连接电脑";
      } else if (camera_.uploading()) {
        connection_detail_ = "请等待照片发送完成";
      } else if (
          primaryTransport() == TransportKind::Ble) {
        connection_detail_ = "语音需要 USB 或 Wi-Fi";
      } else {
        audio_.setPaused(true);
        if (voice_.start(*client, action.value)) {
          ui_.setVoiceRecording(true, action.value);
          connection_detail_ =
              action.value == "command"
                  ? "正在听取命令，再点一次结束"
                  : "正在听，再点一次结束";
        } else {
          audio_.setPaused(false);
          connection_detail_ = voice_.lastError().isEmpty()
              ? "麦克风启动失败"
              : voice_.lastError();
        }
      }
      break;
    case UiActionType::VoiceStop:
      if (voice_.stop()) {
        connection_detail_ = "正在识别";
      }
      audio_.setPaused(false);
      ui_.setVoiceRecording(false);
      break;
    case UiActionType::CameraCapture:
      if (client == nullptr) {
        connection_detail_ = "拍照需要连接电脑";
      } else if (voice_.recording()) {
        connection_detail_ = "请先结束语音";
      } else if (camera_capture_pending_ || camera_.uploading()) {
        connection_detail_ = "照片仍在发送";
      } else if (primaryTransport() == TransportKind::Ble) {
        connection_detail_ = "拍照需要 USB 或 Wi-Fi";
      } else {
        camera_capture_pending_ = true;
        ui_.setCameraBusy(true);
        connection_detail_ = "正在拍照，请稍候";
      }
      break;
    case UiActionType::OpenThread: {
      const auto task = std::find_if(
          model_.snapshot().tasks.begin(),
          model_.snapshot().tasks.end(),
          [&action](const TaskSummary& value) {
            return value.id == action.value.c_str();
          });
      if (task == model_.snapshot().tasks.end()) {
        connection_detail_ = "会话已经不在最近列表";
        break;
      }
      ui_.setThreadLoading(*task);
      if (client == nullptr) {
        ui_.setThreadError(
            action.value,
            "需要电脑 Bridge 在线；USB、Wi-Fi 或蓝牙均可");
        connection_detail_ = "等待电脑 Bridge；无需 USB 线";
      } else if (!client->sendThreadOpen(action.value)) {
        ui_.setThreadError(action.value, "发送详情请求失败");
        connection_detail_ = "会话详情请求失败";
      } else {
        connection_detail_ = "正在读取会话";
      }
      break;
    }
    case UiActionType::CloseThread:
      ui_.closeThread();
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

void FirmwareApp::capturePendingPhoto() {
  if (!camera_capture_pending_) return;
  camera_capture_pending_ = false;
  auto* client = primaryClient();
  if (
      client == nullptr ||
      primaryTransport() == TransportKind::Ble) {
    ui_.setCameraBusy(false);
    connection_detail_ = "拍照需要 USB 或 Wi-Fi";
    return;
  }
  String error;
  if (camera_.captureAndQueue(*client, error)) {
    connection_detail_ = "照片正在加密发送";
    return;
  }
  ui_.setCameraBusy(false);
  connection_detail_ = error;
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
        telemetry.battery_percent, telemetry.charging, telemetry.wifi_rssi);
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
  if (!pet_selection_guard_.accept(
          snapshot.selected_pet_id,
          next.id,
          offset,
          static_cast<std::uint64_t>(millis()))) {
    connection_detail_ = "已忽略重复触摸";
    return;
  }
  model_.selectPetLocally(next.id);
  requested_pet_ = "";
  if (auto* client = primaryClient(); client != nullptr) {
    client->sendPetSelection(next.id.c_str());
  }
  audio_.enqueue(AudioCue::PetSwitched);
}

void FirmwareApp::applyPairingSecret(const String& secret) {
  if (pairing_secret_ == secret) return;
  if (!config_store_.savePairingSecret(secret)) {
    connection_detail_ = "配对凭据保存失败";
    return;
  }
  pairing_secret_ = secret;
  usb_client_.setPairingSecret(secret);
  wifi_client_.setPairingSecret(secret);
  ble_client_.setPairingSecret(secret);
  connection_detail_ = "配对成功";
  audio_.enqueue(AudioCue::PairingSucceeded);
}

void FirmwareApp::updateConnectionState() {
  if (primaryClient() == nullptr) model_.markOffline();
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
