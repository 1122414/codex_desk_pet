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

}  // namespace

void FirmwareApp::setup() {
  auto config = M5.config();
  config.serial_baudrate = 115200;
  config.internal_spk = true;
  config.internal_mic = false;
  config.internal_rtc = true;
  M5.begin(config);
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
  if (!stored.wifi_ssid.isEmpty() && !stored.bridge_host.isEmpty()) {
    wifi_transport_.begin(
        stored.wifi_ssid, stored.wifi_password, stored.bridge_host, stored.bridge_port);
  }
  usb_client_.begin(usb_transport_, stored.device_id, pairing_secret_);
  wifi_client_.begin(wifi_transport_, stored.device_id, pairing_secret_);
  const auto voice_ready = audio_.voiceAvailable();
  const auto storage_ready = pet_store_.available();
  usb_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-tab5-k145",
      kTab5Capabilities,
      voice_ready,
      storage_ready);
  wifi_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-tab5-k145",
      kTab5Capabilities,
      voice_ready,
      storage_ready);
  configureProtocol(usb_client_);
  configureProtocol(wifi_client_);
  connection_detail_ = paired() ? "等待电脑 Bridge" : "请通过USB连接电脑并输入配对码";
}

void FirmwareApp::loop() {
  const auto now_ms = static_cast<std::uint64_t>(millis());
  M5.update();
  usb_client_.poll(now_ms);
  wifi_client_.poll(now_ms);
  updateConnectionState();
  syncClock(now_ms);
  updateTelemetry(now_ms);
  requestSelectedPet(now_ms);
  handleUiAction(ui_.poll(model_.snapshot(), now_ms, paired()));

  ui_.render(
      model_.snapshot(), now_ms, paired(), connection_detail_, pet_store_.transferProgress());
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
  auto display_snapshot = snapshot;
  if (have_local_telemetry_) {
    display_snapshot.telemetry = local_telemetry_;
  }
  if (!model_.applySnapshot(display_snapshot)) return;
  requested_pet_ = "";
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
          model_.snapshot().approval.present &&
          model_.snapshot().approval.safe_to_approve) {
        client->sendApprovalDecision(model_.snapshot().approval.request_id.c_str(), true);
      }
      break;
    case UiActionType::DeclineApproval:
      if (client != nullptr && model_.snapshot().approval.present) {
        client->sendApprovalDecision(model_.snapshot().approval.request_id.c_str(), false);
      }
      break;
    case UiActionType::SubmitPairingCode:
      usb_client_.setPairingCode(action.value);
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
  if (pet_id.isEmpty() || pet_id == "codex-core" || !pet_store_.available()) return;
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
  connection_detail_ = "配对成功";
  audio_.enqueue(AudioCue::PairingSucceeded);
}

void FirmwareApp::updateConnectionState() {
  if (primaryClient() == nullptr) model_.markOffline();
}

DeviceProtocolClient* FirmwareApp::primaryClient() {
  if (usb_client_.ready()) return &usb_client_;
  if (wifi_client_.ready()) return &wifi_client_;
  return nullptr;
}

TransportKind FirmwareApp::primaryTransport() const {
  if (usb_client_.ready()) return TransportKind::Usb;
  if (wifi_client_.ready()) return TransportKind::Wifi;
  return TransportKind::Offline;
}

bool FirmwareApp::paired() const {
  return pairing_secret_.length() == 64;
}

}  // namespace codex::firmware
