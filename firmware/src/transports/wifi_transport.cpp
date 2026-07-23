#include "transports/wifi_transport.hpp"

namespace codex::firmware {

void WifiTransport::begin(
    const String& ssid,
    const String& password,
    const String& host,
    const std::uint16_t port) {
  ssid_ = ssid;
  password_ = password;
  host_ = host;
  port_ = port;
  if (ssid_.isEmpty() || host_.isEmpty() || port_ == 0) {
    return;
  }
#if defined(CONFIG_IDF_TARGET_ESP32P4)
  // Tab5 的 Wi-Fi 由 ESP32-C6 通过 ESP-Hosted/SDIO 提供；必须在启动前固定连线。
  WiFi.setPins(12, 13, 11, 10, 9, 8, 15);
#endif
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.setSleep(false);
  WiFi.begin(ssid_.c_str(), password_.c_str());
  wifi_started_at_ = millis();
}

const char* WifiTransport::kind() const {
  return "wifi";
}

bool WifiTransport::connected() const {
  return websocket_connected_;
}

void WifiTransport::poll(const MessageHandler& handler) {
  handler_ = handler;
  if (ssid_.isEmpty() || host_.isEmpty()) {
    return;
  }
  if (WiFi.status() == WL_CONNECTED && !websocket_started_) {
    startWebSocket();
  } else if (
      WiFi.status() != WL_CONNECTED &&
      millis() - wifi_started_at_ >= 30'000U) {
    wifi_started_at_ = millis();
    WiFi.disconnect();
    WiFi.begin(ssid_.c_str(), password_.c_str());
  }
  if (websocket_started_) {
    web_socket_.loop();
  }
}

bool WifiTransport::sendText(const String& message) {
  if (!connected() || message.length() > 15U * 1024U) {
    return false;
  }
  auto copy = message;
  return web_socket_.sendTXT(copy);
}

void WifiTransport::close() {
  websocket_connected_ = false;
  websocket_started_ = false;
  web_socket_.disconnect();
}

std::int16_t WifiTransport::rssi() const {
  return WiFi.status() == WL_CONNECTED
             ? static_cast<std::int16_t>(WiFi.RSSI())
             : 0;
}

void WifiTransport::startWebSocket() {
  websocket_started_ = true;
  web_socket_.begin(host_, port_, "/device/ws");
  web_socket_.setReconnectInterval(1'000);
  web_socket_.enableHeartbeat(5'000, 15'000, 2);
  web_socket_.onEvent(
      [this](const WStype_t type, std::uint8_t* payload, const std::size_t length) {
        onWebSocketEvent(type, payload, length);
      });
}

void WifiTransport::onWebSocketEvent(
    const WStype_t type,
    std::uint8_t* payload,
    const std::size_t length) {
  if (type == WStype_CONNECTED) {
    websocket_connected_ = true;
    return;
  }
  if (type == WStype_DISCONNECTED || type == WStype_ERROR) {
    websocket_connected_ = false;
    return;
  }
  if (type != WStype_TEXT || !handler_ || length > 15U * 1024U) {
    return;
  }
  String message;
  if (!message.reserve(length)) {
    return;
  }
  for (std::size_t index = 0; index < length; ++index) {
    message += static_cast<char>(payload[index]);
  }
  handler_(message);
}

}  // namespace codex::firmware
