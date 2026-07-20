#include "firmware_app.hpp"

#include <ArduinoJson.h>
#include <M5Unified.h>
#include <esp_system.h>
#include <esp_task_wdt.h>

#include <algorithm>
#include <ctime>

namespace codex::firmware {
namespace {

constexpr std::uint64_t kTelemetryIntervalMs = 30'000;
constexpr std::uint64_t kResourceRetryMs = 30'000;
constexpr std::uint64_t kFactoryResetHoldMs = 8'000;

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
  esp_task_wdt_init(10, true);
  esp_task_wdt_add(nullptr);

  if (!config_store_.begin()) connection_detail_ = "配置存储初始化失败";
  pairing_secret_ = config_store_.config().pairing_secret;
  pet_store_.begin();
  if (!audio_.begin()) {
    Serial.println("设备中文语音不可用，将使用非阻塞提示音");
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
  const auto suffix_at = std::max<int>(0, static_cast<int>(stored.device_id.length()) - 8);
  ble_transport_.begin(
      "CodexDesk-" + stored.device_id.substring(suffix_at),
      stored.setup_code);
  if (!stored.wifi_ssid.isEmpty() && !stored.bridge_host.isEmpty()) {
    wifi_transport_.begin(
        stored.wifi_ssid, stored.wifi_password, stored.bridge_host, stored.bridge_port);
  }
  usb_client_.begin(usb_transport_, stored.device_id, pairing_secret_);
  wifi_client_.begin(wifi_transport_, stored.device_id, pairing_secret_);
  ble_client_.begin(ble_transport_, stored.device_id, pairing_secret_);
  const auto voice_ready = audio_.voiceAvailable();
  const auto storage_ready = pet_store_.available();
  usb_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-cores3-k128",
      voice_ready,
      storage_ready);
  wifi_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-cores3-k128",
      voice_ready,
      storage_ready);
  ble_client_.setDeviceInfo(
      CODEX_DESK_FIRMWARE_VERSION,
      "m5stack-cores3-k128",
      voice_ready,
      storage_ready);
  configureProtocol(usb_client_);
  configureProtocol(wifi_client_);
  configureProtocol(ble_client_);
  connection_detail_ = paired() ? "等待电脑 Bridge" : "请先配网并输入配对码";
}

void FirmwareApp::loop() {
  const auto now_ms = static_cast<std::uint64_t>(millis());
  M5.update();
  handleProvisioning();
  usb_client_.poll(now_ms);
  wifi_client_.poll(now_ms);
  ble_client_.poll(now_ms);
  updateConnectionState();
  syncClock(now_ms);
  updateTelemetry(now_ms);
  requestSelectedPet(now_ms);
  handleUiAction(ui_.poll(model_.snapshot(), now_ms, paired()));

  const auto both_buttons = digitalRead(9) == LOW && digitalRead(8) == LOW;
  if (both_buttons && reset_pressed_at_ == 0) reset_pressed_at_ = now_ms;
  if (!both_buttons) reset_pressed_at_ = 0;
  if (reset_pressed_at_ != 0 && now_ms - reset_pressed_at_ >= kFactoryResetHoldMs) {
    pet_store_.checkpoint();
    config_store_.clearNetwork();
    config_store_.clearPairing();
    config_store_.rotateSetupCode();
    delay(100);
    ESP.restart();
  }

  ui_.render(
      model_.snapshot(), now_ms, paired(), connection_detail_, pet_store_.transferProgress());
  esp_task_wdt_reset();
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
}

void FirmwareApp::handleSnapshot(const Snapshot& snapshot) {
  if (!model_.applySnapshot(snapshot)) return;
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
      ble_client_.setPairingCode(action.value);
      connection_detail_ = "正在验证配对码";
      break;
    case UiActionType::None:
      break;
  }
}

void FirmwareApp::handleProvisioning() {
  String message;
  if (!ble_transport_.takeProvisioningMessage(message)) return;
  JsonDocument document;
  if (deserializeJson(document, message) || !document.is<JsonObject>()) {
    connection_detail_ = "蓝牙配网数据无效";
    return;
  }
  const String setup_code = document["setupCode"] | "";
  const String ssid = document["ssid"] | "";
  const String password = document["password"] | "";
  const String host = document["bridgeHost"] | "";
  const std::uint16_t port = document["bridgePort"] | 4318;
  if (setup_code != config_store_.config().setup_code ||
      !config_store_.saveNetwork(ssid, password, host, port)) {
    connection_detail_ = "蓝牙配网验证失败";
    return;
  }
  if (!config_store_.rotateSetupCode()) {
    connection_detail_ = "配网码轮换失败";
    return;
  }
  connection_detail_ = "Wi-Fi配置已保存，正在重启";
  pet_store_.checkpoint();
  delay(100);
  ESP.restart();
}

void FirmwareApp::updateTelemetry(const std::uint64_t now_ms) {
  if (last_telemetry_at_ != 0 && now_ms - last_telemetry_at_ < kTelemetryIntervalMs) return;
  last_telemetry_at_ = now_ms;
  const auto raw_level = M5.Power.getBatteryLevel();
  Telemetry telemetry;
  telemetry.battery_percent = static_cast<std::uint8_t>(std::clamp(raw_level, 0, 100));
  telemetry.charging = M5.Power.isCharging();
  telemetry.wifi_rssi = wifi_transport_.rssi();
  telemetry.transport = primaryTransport();
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
  if (client == nullptr || strcmp(client->transportKind(), "ble") == 0) return;
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
