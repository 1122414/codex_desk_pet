#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#include <functional>
#include <vector>

#include "codex_core/sequence.hpp"
#include "codex_core/resource.hpp"
#include "codex_core/types.hpp"
#include "transports/text_transport.hpp"

namespace codex::firmware {

class DeviceProtocolClient {
 public:
  using SnapshotHandler = std::function<void(const Snapshot&)>;
  using SecretHandler = std::function<void(const String&)>;
  using EventHandler = std::function<void(const String&, JsonObjectConst)>;
  using StateHandler = std::function<void(bool, const String&)>;

  void begin(
      TextTransport& transport,
      const String& device_id,
      const String& pairing_secret);
  void poll(std::uint64_t now_ms);
  void setPairingCode(const String& pairing_code);
  void setPairingSecret(const String& pairing_secret);
  void setSnapshotHandler(SnapshotHandler handler);
  void setSecretHandler(SecretHandler handler);
  void setEventHandler(EventHandler handler);
  void setStateHandler(StateHandler handler);

  bool ready() const;
  const char* transportKind() const;
  const String& sessionId() const;
  bool sendPetSelection(const String& pet_id);
  bool sendApprovalDecision(const String& request_id, bool accept);
  bool sendTelemetry(
      std::uint8_t battery_percent,
      bool charging,
      std::int16_t wifi_rssi);
  bool requestResource(
      const String& pet_id,
      const String& installed_sha256 = "",
      const String& resume_sha256 = "",
      const std::vector<ByteRange>& missing_ranges = {});

 private:
  struct Pending {
    String id;
    std::uint64_t sequence = 0;
    String serialized;
    std::uint8_t attempts = 1;
    std::uint64_t next_retry_at = 0;
  };

  enum class State : std::uint8_t {
    Disconnected,
    WaitingForPairingCode,
    Handshaking,
    Ready,
    Rejected,
  };

  static constexpr std::uint64_t kHeartbeatIntervalMs = 5'000;
  static constexpr std::uint64_t kConnectionTimeoutMs = 15'000;
  static constexpr std::uint64_t kHandshakeTimeoutMs = 10'000;
  static constexpr std::size_t kMaximumPending = 32;

  void onTransportMessage(const String& message);
  void startHandshake(std::uint64_t now_ms, bool reset_sequences);
  void handleHandshake(const String& type, JsonObjectConst payload);
  void handleReadyMessage(const String& type, JsonObjectConst payload);
  void handleSnapshot(JsonObjectConst payload);
  void sendAck(const String& id, std::uint64_t sequence);
  void sendError(const String& code);
  bool sendEnvelope(
      const String& type,
      const std::function<void(JsonObject)>& payload_writer,
      bool reliable = true);
  bool sendCommand(
      const String& command,
      const std::function<void(JsonObject)>& args_writer);
  bool isReliableType(const String& type) const;
  bool isHandshakeType(const String& type) const;
  bool encryptPayload(
      JsonObject output,
      const String& id,
      std::uint64_t sequence,
      const String& type,
      std::uint64_t sent_at,
      const String& session_id,
      const String& plaintext) const;
  bool decryptPayload(
      JsonObjectConst input,
      const String& id,
      std::uint64_t sequence,
      const String& type,
      std::uint64_t sent_at,
      const String& session_id,
      JsonDocument& plaintext) const;
  String encryptionMaterial(bool outgoing) const;
  String envelopeAdditionalData(
      const String& id,
      std::uint64_t sequence,
      const String& type,
      std::uint64_t sent_at,
      const String& session_id) const;
  void acknowledge(const String& id, std::uint64_t sequence);
  void retryPending(std::uint64_t now_ms);
  void clearSession(bool reset_sequences);
  String randomId(std::size_t bytes = 16) const;
  String randomNonce() const;
  String handshakeProof(const String& role) const;
  bool verifyProof(const String& proof, const String& role) const;
  String derivedSessionId() const;
  void notifyState(bool connected, const String& detail);

  TextTransport* transport_ = nullptr;
  String device_id_;
  String secret_;
  String pairing_code_;
  String device_nonce_;
  String bridge_nonce_;
  String session_id_;
  State state_ = State::Disconnected;
  SequenceWindow receive_window_;
  std::uint64_t next_sequence_ = 1;
  std::uint64_t connected_at_ = 0;
  std::uint64_t last_received_at_ = 0;
  std::uint64_t last_sent_at_ = 0;
  bool transport_was_connected_ = false;
  std::vector<Pending> pending_;
  SnapshotHandler snapshot_handler_;
  SecretHandler secret_handler_;
  EventHandler event_handler_;
  StateHandler state_handler_;
};

}  // namespace codex::firmware
