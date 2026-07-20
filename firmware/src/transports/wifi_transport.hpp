#pragma once

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>

#include "transports/text_transport.hpp"

namespace codex::firmware {

class WifiTransport final : public TextTransport {
 public:
  void begin(
      const String& ssid,
      const String& password,
      const String& host,
      std::uint16_t port);
  const char* kind() const override;
  bool connected() const override;
  void poll(const MessageHandler& handler) override;
  bool sendText(const String& message) override;
  void close() override;
  std::int16_t rssi() const;

 private:
  void startWebSocket();
  void onWebSocketEvent(WStype_t type, std::uint8_t* payload, std::size_t length);

  WebSocketsClient web_socket_;
  MessageHandler handler_;
  String ssid_;
  String password_;
  String host_;
  std::uint16_t port_ = 4318;
  bool websocket_started_ = false;
  bool websocket_connected_ = false;
  std::uint64_t wifi_started_at_ = 0;
};

}  // namespace codex::firmware
