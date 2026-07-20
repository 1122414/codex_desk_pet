#include "device_protocol.hpp"

#include <esp_system.h>
#include <mbedtls/base64.h>
#include <mbedtls/gcm.h>
#include <mbedtls/md.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <string>
#include <utility>

namespace codex::firmware {
namespace {

constexpr std::uint8_t kProtocolVersion = 2;
constexpr std::size_t kAeadKeyBytes = 32;
constexpr std::size_t kAeadNonceBytes = 12;
constexpr std::size_t kAeadTagBytes = 16;
constexpr const char* kAeadAlgorithm = "A256GCM";

std::string boundedString(const char* value, const std::size_t maximum) {
  if (value == nullptr) {
    return {};
  }
  std::string result(value);
  if (result.size() > maximum) {
    result.resize(maximum);
  }
  return result;
}

bool decodeHexSecret(
    const String& secret,
    std::array<std::uint8_t, 32>& result) {
  if (secret.length() != result.size() * 2U) {
    return false;
  }
  for (std::size_t index = 0; index < result.size(); ++index) {
    const auto high = secret[index * 2];
    const auto low = secret[index * 2 + 1];
    const auto decode = [](const char value) -> int {
      if (value >= '0' && value <= '9') {
        return value - '0';
      }
      if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
      }
      return -1;
    };
    const auto high_value = decode(high);
    const auto low_value = decode(low);
    if (high_value < 0 || low_value < 0) {
      return false;
    }
    result[index] = static_cast<std::uint8_t>(
        (high_value << 4) | low_value);
  }
  return true;
}

bool hmacSha256Raw(
    const std::uint8_t* key,
    const std::size_t key_length,
    const std::uint8_t* material,
    const std::size_t material_length,
    std::uint8_t* digest) {
  if (key == nullptr || material == nullptr || digest == nullptr) {
    return false;
  }
  const auto* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return info != nullptr &&
      mbedtls_md_hmac(
          info,
          key,
          key_length,
          material,
          material_length,
          digest) == 0;
}

bool hmacSha256Bytes(
    const String& secret,
    const String& material,
    std::array<std::uint8_t, kAeadKeyBytes>& digest) {
  std::array<std::uint8_t, 32> key{};
  if (!decodeHexSecret(secret, key)) {
    return false;
  }
  return hmacSha256Raw(
          key.data(),
          key.size(),
          reinterpret_cast<const std::uint8_t*>(material.c_str()),
          material.length(),
          digest.data());
}

String hmacSha256(const String& secret, const String& material) {
  std::array<std::uint8_t, kAeadKeyBytes> digest{};
  if (!hmacSha256Bytes(secret, material, digest)) {
    return {};
  }
  static constexpr char kHex[] = "0123456789abcdef";
  String result;
  if (!result.reserve(digest.size() * 2U)) {
    return {};
  }
  for (const auto value : digest) {
    result += kHex[value >> 4U];
    result += kHex[value & 0x0fU];
  }
  return result;
}

String encodeBase64(
    const std::uint8_t* data,
    const std::size_t length,
    const bool url_safe) {
  if (data == nullptr || length == 0) return {};
  const auto capacity = 4U * ((length + 2U) / 3U) + 1U;
  std::vector<std::uint8_t> encoded(capacity);
  std::size_t output_length = 0;
  if (mbedtls_base64_encode(
          encoded.data(),
          encoded.size(),
          &output_length,
          data,
          length) != 0) {
    return {};
  }
  String result;
  if (!result.reserve(output_length)) return {};
  for (std::size_t index = 0; index < output_length; ++index) {
    auto value = static_cast<char>(encoded[index]);
    if (url_safe && value == '=') break;
    if (url_safe && value == '+') value = '-';
    if (url_safe && value == '/') value = '_';
    result += value;
  }
  return result;
}

bool decodeBase64(
    const String& encoded,
    const bool url_safe,
    std::vector<std::uint8_t>& decoded) {
  if (encoded.isEmpty()) return false;
  String normalized = encoded;
  if (url_safe) {
    normalized.replace("-", "+");
    normalized.replace("_", "/");
    while (normalized.length() % 4U != 0) normalized += '=';
  }
  decoded.assign((normalized.length() * 3U) / 4U + 3U, 0);
  std::size_t output_length = 0;
  if (mbedtls_base64_decode(
          decoded.data(),
          decoded.size(),
          &output_length,
          reinterpret_cast<const std::uint8_t*>(normalized.c_str()),
          normalized.length()) != 0 ||
      output_length == 0) {
    decoded.clear();
    return false;
  }
  decoded.resize(output_length);
  return true;
}

bool constantTimeEquals(
    const std::uint8_t* left,
    const std::uint8_t* right,
    const std::size_t length) {
  if (left == nullptr || right == nullptr) return false;
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < length; ++index) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

bool deriveNonce(
    const std::array<std::uint8_t, kAeadKeyBytes>& key,
    const std::uint64_t sequence,
    std::array<std::uint8_t, kAeadNonceBytes>& nonce) {
  static constexpr char kNonceMaterial[] = "codex-desk-nonce-prefix-v1";
  std::array<std::uint8_t, kAeadKeyBytes> prefix{};
  if (!hmacSha256Raw(
          key.data(),
          key.size(),
          reinterpret_cast<const std::uint8_t*>(kNonceMaterial),
          sizeof(kNonceMaterial) - 1U,
          prefix.data())) {
    return false;
  }
  std::copy_n(prefix.begin(), 4, nonce.begin());
  for (std::size_t index = 0; index < 8; ++index) {
    nonce[4U + index] =
        static_cast<std::uint8_t>(sequence >> ((7U - index) * 8U));
  }
  return true;
}

TransportKind parseTransport(const char* value) {
  if (value != nullptr && strcmp(value, "usb") == 0) {
    return TransportKind::Usb;
  }
  if (value != nullptr && strcmp(value, "wifi") == 0) {
    return TransportKind::Wifi;
  }
  if (value != nullptr && strcmp(value, "ble") == 0) {
    return TransportKind::Ble;
  }
  return TransportKind::Offline;
}

}  // namespace

void DeviceProtocolClient::begin(
    TextTransport& transport,
    const String& device_id,
    const String& pairing_secret) {
  transport_ = &transport;
  device_id_ = device_id;
  secret_ = pairing_secret;
  clearSession(true);
}

void DeviceProtocolClient::poll(const std::uint64_t now_ms) {
  if (transport_ == nullptr) {
    return;
  }
  transport_->poll(
      [this](const String& message) { onTransportMessage(message); });
  const auto connected = transport_->connected();
  if (connected && !transport_was_connected_) {
    startHandshake(now_ms, true);
  } else if (!connected && transport_was_connected_) {
    clearSession(true);
    notifyState(false, String(transport_->kind()) + " disconnected");
  }
  transport_was_connected_ = connected;
  if (!connected) {
    return;
  }

  retryPending(now_ms);
  if (
      state_ == State::Handshaking &&
      now_ms - connected_at_ >= kHandshakeTimeoutMs) {
    notifyState(false, "handshake timeout");
    startHandshake(now_ms, false);
    return;
  }
  if (
      state_ == State::Ready &&
      now_ms - last_received_at_ >= kConnectionTimeoutMs) {
    notifyState(false, "connection timeout");
    startHandshake(now_ms, false);
    return;
  }
  if (
      state_ == State::Ready &&
      now_ms - last_sent_at_ >= kHeartbeatIntervalMs) {
    sendEnvelope(
        "heartbeat",
        [this](JsonObject payload) {
          payload["lastReceivedSequence"] = receive_window_.lastAccepted();
        },
        false);
  }
}

void DeviceProtocolClient::setPairingCode(const String& pairing_code) {
  if (pairing_code.length() != 6) {
    return;
  }
  for (std::size_t index = 0; index < pairing_code.length(); ++index) {
    if (!isDigit(pairing_code[index])) {
      return;
    }
  }
  pairing_code_ = pairing_code;
  if (transport_ != nullptr && transport_->connected() && secret_.isEmpty()) {
    startHandshake(millis(), false);
  }
}

void DeviceProtocolClient::setPairingSecret(const String& pairing_secret) {
  if (pairing_secret.length() != 64) return;
  secret_ = pairing_secret;
  pairing_code_ = "";
  if (transport_ != nullptr && transport_->connected()) {
    startHandshake(millis(), false);
  }
}

void DeviceProtocolClient::setSnapshotHandler(SnapshotHandler handler) {
  snapshot_handler_ = std::move(handler);
}

void DeviceProtocolClient::setSecretHandler(SecretHandler handler) {
  secret_handler_ = std::move(handler);
}

void DeviceProtocolClient::setEventHandler(EventHandler handler) {
  event_handler_ = std::move(handler);
}

void DeviceProtocolClient::setStateHandler(StateHandler handler) {
  state_handler_ = std::move(handler);
}

bool DeviceProtocolClient::ready() const {
  return state_ == State::Ready;
}

const char* DeviceProtocolClient::transportKind() const {
  return transport_ == nullptr ? "offline" : transport_->kind();
}

const String& DeviceProtocolClient::sessionId() const {
  return session_id_;
}

bool DeviceProtocolClient::sendPetSelection(const String& pet_id) {
  if (pet_id.isEmpty() || pet_id.length() > 64) {
    return false;
  }
  return sendCommand(
      "pet.select",
      [&pet_id](JsonObject payload) { payload["petId"] = pet_id; });
}

bool DeviceProtocolClient::sendApprovalDecision(
    const String& request_id,
    const bool accept) {
  if (request_id.isEmpty() || request_id.length() > 128) {
    return false;
  }
  return sendCommand(
      "approval.decide",
      [&request_id, accept](JsonObject payload) {
        payload["requestId"] = request_id;
        payload["decision"] = accept ? "accept" : "decline";
      });
}

bool DeviceProtocolClient::sendTelemetry(
    const std::uint8_t battery_percent,
    const bool charging,
    const std::int16_t wifi_rssi) {
  return sendCommand(
      "telemetry.update",
      [battery_percent, charging, wifi_rssi](JsonObject payload) {
        payload["batteryPercent"] = std::min<std::uint8_t>(battery_percent, 100);
        payload["charging"] = charging;
        if (wifi_rssi < 0 && wifi_rssi >= -127) {
          payload["wifiRssi"] = wifi_rssi;
        } else {
          payload["wifiRssi"] = nullptr;
        }
      });
}

bool DeviceProtocolClient::requestResource(
    const String& pet_id,
    const String& installed_sha256,
    const String& resume_sha256,
    const std::vector<ByteRange>& missing_ranges) {
  if (state_ != State::Ready || pet_id.isEmpty() || pet_id.length() > 64) {
    return false;
  }
  return sendEnvelope(
      "resource.request",
      [&pet_id, &installed_sha256, &resume_sha256, &missing_ranges](JsonObject payload) {
        payload["petId"] = pet_id;
        if (installed_sha256.length() == 64) {
          payload["sha256"] = installed_sha256;
        } else {
          payload["sha256"] = nullptr;
        }
        if (resume_sha256.length() == 64 && !missing_ranges.empty()) {
          payload["resumeSha256"] = resume_sha256;
          auto ranges = payload["missingRanges"].to<JsonArray>();
          const auto count = std::min<std::size_t>(missing_ranges.size(), 1'024);
          for (std::size_t index = 0; index < count; ++index) {
            auto range = ranges.add<JsonObject>();
            range["offset"] = missing_ranges[index].offset;
            range["length"] = missing_ranges[index].length;
          }
        }
      });
}

void DeviceProtocolClient::onTransportMessage(const String& message) {
  JsonDocument document;
  const auto error = deserializeJson(document, message);
  if (error || !document.is<JsonObject>()) {
    return;
  }
  const auto root = document.as<JsonObjectConst>();
  if (
      (root["version"] | 0) != kProtocolVersion ||
      !root["id"].is<const char*>() ||
      !root["sequence"].is<std::uint64_t>() ||
      !root["type"].is<const char*>() ||
      !root["sentAt"].is<std::uint64_t>() ||
      !root["payload"].is<JsonObjectConst>()) {
    return;
  }
  const String id = root["id"].as<const char*>();
  const auto sequence = root["sequence"].as<std::uint64_t>();
  const String type = root["type"].as<const char*>();
  const auto sent_at = root["sentAt"].as<std::uint64_t>();
  const String message_session =
      root["sessionId"].is<const char*>()
          ? String(root["sessionId"].as<const char*>())
          : String();
  auto payload = root["payload"].as<JsonObjectConst>();
  const auto encrypted = payload["encrypted"] | false;
  const auto handshake = isHandshakeType(type);
  last_received_at_ = millis();

  if (state_ == State::Ready && !handshake && message_session != session_id_) {
    sendError("INVALID_SESSION");
    return;
  }
  JsonDocument plaintext_document;
  if (state_ == State::Ready && !handshake) {
    if (!encrypted) {
      sendError("ENCRYPTION_REQUIRED");
      notifyState(false, "plaintext message rejected");
      startHandshake(millis(), false);
      return;
    }
    if (!decryptPayload(
            payload,
            id,
            sequence,
            type,
            sent_at,
            message_session,
            plaintext_document)) {
      sendError("DECRYPTION_FAILED");
      notifyState(false, "encrypted message rejected");
      startHandshake(millis(), false);
      return;
    }
    payload = plaintext_document.as<JsonObjectConst>();
  } else if (encrypted) {
    return;
  } else if (
      state_ != State::Ready && !handshake && type != "ack") {
    sendError("AUTHENTICATION_REQUIRED");
    return;
  }
  const auto observation =
      receive_window_.observe(sequence, type == "snapshot");
  if (observation.status == SequenceStatus::Duplicate) {
    if (isReliableType(type)) {
      sendAck(id, sequence);
    }
    return;
  }
  if (observation.status == SequenceStatus::Gap) {
    sendError("RESYNC_REQUIRED");
    return;
  }
  if (type == "ack") {
    if (
        payload["acknowledgedId"].is<const char*>() &&
        payload["acknowledgedSequence"].is<std::uint64_t>()) {
      acknowledge(
          payload["acknowledgedId"].as<const char*>(),
          payload["acknowledgedSequence"].as<std::uint64_t>());
    }
    return;
  }
  if (handshake) {
    if (type != "ready" && isReliableType(type)) {
      sendAck(id, sequence);
    }
    handleHandshake(type, payload);
    if (type == "ready" && isReliableType(type)) {
      sendAck(id, sequence);
    }
    return;
  }
  if (isReliableType(type)) {
    sendAck(id, sequence);
  }
  handleReadyMessage(type, payload);
}

void DeviceProtocolClient::startHandshake(
    const std::uint64_t now_ms,
    const bool reset_sequences) {
  clearSession(reset_sequences);
  connected_at_ = now_ms;
  last_received_at_ = now_ms;
  last_sent_at_ = now_ms;
  device_nonce_ = randomNonce();
  if (secret_.length() == 64) {
    state_ = State::Handshaking;
    sendEnvelope(
        "hello",
        [this](JsonObject payload) {
          payload["deviceId"] = device_id_;
          payload["deviceNonce"] = device_nonce_;
          payload["transport"] = transport_->kind();
        });
    notifyState(false, "authenticating");
    return;
  }
  if (
      pairing_code_.length() == 6 &&
      (strcmp(transport_->kind(), "usb") == 0 ||
       strcmp(transport_->kind(), "ble") == 0)) {
    state_ = State::Handshaking;
    sendEnvelope(
        "pair.request",
        [this](JsonObject payload) {
          payload["deviceId"] = device_id_;
          payload["deviceNonce"] = device_nonce_;
          payload["pairingCode"] = pairing_code_;
        });
    notifyState(false, "pairing");
    return;
  }
  state_ = State::WaitingForPairingCode;
  notifyState(false, "pairing code required");
}

void DeviceProtocolClient::handleHandshake(
    const String& type,
    const JsonObjectConst payload) {
  if (type == "pair.accepted" && secret_.isEmpty()) {
    const auto paired_device = payload["deviceId"] | "";
    const auto secret = payload["secret"] | "";
    if (device_id_ != paired_device || strlen(secret) != 64) {
      state_ = State::Rejected;
      notifyState(false, "pairing response rejected");
      return;
    }
    secret_ = secret;
    pairing_code_ = "";
    if (secret_handler_) {
      secret_handler_(secret_);
    }
    startHandshake(millis(), false);
    return;
  }
  if (type == "pair.rejected") {
    state_ = State::Rejected;
    notifyState(false, payload["reason"] | "pairing rejected");
    return;
  }
  if (type == "challenge" && state_ == State::Handshaking) {
    const String challenge_device = payload["deviceId"] | "";
    const String challenge_nonce = payload["deviceNonce"] | "";
    bridge_nonce_ = payload["bridgeNonce"] | "";
    const String proof = payload["proof"] | "";
    if (
        challenge_device != device_id_ ||
        challenge_nonce != device_nonce_ ||
        bridge_nonce_.length() < 16 ||
        !verifyProof(proof, "bridge")) {
      state_ = State::Rejected;
      notifyState(false, "bridge authentication failed");
      return;
    }
    sendEnvelope(
        "authenticate",
        [this](JsonObject response) {
          response["deviceId"] = device_id_;
          response["deviceNonce"] = device_nonce_;
          response["bridgeNonce"] = bridge_nonce_;
          response["proof"] = handshakeProof("device");
        });
    return;
  }
  if (type == "ready" && state_ == State::Handshaking) {
    const String expected = derivedSessionId();
    const String ready_session = payload["sessionId"] | "";
    if (expected.isEmpty() || ready_session != expected) {
      state_ = State::Rejected;
      notifyState(false, "session authentication failed");
      return;
    }
    session_id_ = expected;
    state_ = State::Ready;
    notifyState(true, String(transport_->kind()) + " ready");
  }
}

void DeviceProtocolClient::handleReadyMessage(
    const String& type,
    const JsonObjectConst payload) {
  if (type == "snapshot") {
    handleSnapshot(payload);
    return;
  }
  if (type == "event" && event_handler_) {
    event_handler_(payload["event"] | "", payload);
    return;
  }
  if (type.startsWith("resource.") && event_handler_) {
    event_handler_(type, payload);
    return;
  }
  if (type == "error") {
    const String code = payload["code"] | "";
    if (code == "RESYNC_REQUIRED" || code == "INVALID_SESSION") {
      startHandshake(millis(), false);
    }
  }
}

void DeviceProtocolClient::handleSnapshot(const JsonObjectConst payload) {
  Snapshot snapshot;
  snapshot.revision = payload["revision"] | 0;
  const char* connection_status = payload["connection"]["status"] | "";
  snapshot.bridge_connected = strcmp(connection_status, "connected") == 0;
  parsePresentationState(
      boundedString(payload["presentation"]["state"] | "ready", 32),
      snapshot.state);
  parseAnimation(
      boundedString(payload["presentation"]["animation"] | "idle", 32),
      snapshot.animation);
  if (payload["task"].is<JsonObjectConst>()) {
    snapshot.task_id =
        boundedString(payload["task"]["id"] | "", 128);
    snapshot.task_title =
        boundedString(payload["task"]["title"] | "", 120);
  }
  snapshot.selected_pet_id =
      boundedString(payload["pet"]["selectedId"] | "codex-core", 64);
  snapshot.pets.clear();
  if (payload["pet"]["available"].is<JsonArrayConst>()) {
    const auto available = payload["pet"]["available"].as<JsonArrayConst>();
    const auto count = std::min<std::size_t>(available.size(), 64);
    for (std::size_t index = 0; index < count; ++index) {
      const auto value = available[index].as<JsonObjectConst>();
      PetSummary pet;
      pet.id = boundedString(value["id"] | "", 64);
      pet.display_name = boundedString(value["displayName"] | "", 80);
      pet.sprite_version = value["spriteVersionNumber"] | 1;
      pet.builtin = strcmp(value["kind"] | "", "builtin") == 0;
      if (!pet.id.empty() && (pet.sprite_version == 1 || pet.sprite_version == 2)) {
        snapshot.pets.push_back(std::move(pet));
      }
    }
  }
  if (snapshot.pets.empty()) {
    snapshot.pets.push_back({"codex-core", "Codex Core", 2, true});
  }
  snapshot.tokens.total = payload["tokens"]["total"] | 0;
  snapshot.tokens.level = payload["tokens"]["level"]["level"] | 1;
  snapshot.tokens.current = payload["tokens"]["level"]["current"] | 0;
  snapshot.tokens.target = payload["tokens"]["level"]["target"] | 50'000;
  if (payload["approval"].is<JsonObjectConst>()) {
    const auto approval = payload["approval"].as<JsonObjectConst>();
    snapshot.approval.present = true;
    snapshot.approval.request_id =
        boundedString(approval["id"] | "", 128);
    snapshot.approval.title =
        boundedString(approval["title"] | "需要确认", 80);
    const char* detail = approval["detail"] | "";
    if (strlen(detail) == 0) {
      detail = approval["command"] | "";
    }
    if (strlen(detail) == 0) {
      detail = approval["grantRoot"] | "";
    }
    if (
        strlen(detail) == 0 &&
        approval["filePaths"].is<JsonArrayConst>() &&
        !approval["filePaths"].as<JsonArrayConst>().isNull()) {
      const auto files = approval["filePaths"].as<JsonArrayConst>();
      if (files.size() > 0) {
        detail = files[0] | "";
      }
    }
    snapshot.approval.detail = boundedString(detail, 240);
    snapshot.approval.reason =
        boundedString(approval["reason"] | "", 160);
    auto accept_offered = false;
    if (approval["availableDecisions"].is<JsonArrayConst>()) {
      for (const auto decision :
           approval["availableDecisions"].as<JsonArrayConst>()) {
        const auto* decision_text = decision.as<const char*>();
        if (decision_text != nullptr &&
            strcmp(decision_text, "accept") == 0) {
          accept_offered = true;
          break;
        }
      }
    }
    snapshot.approval.safe_to_approve =
        (approval["safeToApprove"] | false) &&
        accept_offered &&
        !snapshot.approval.request_id.empty() &&
        !snapshot.approval.detail.empty() &&
        snapshot.approval.detail.size() <= 96 &&
        std::count(
            snapshot.approval.detail.begin(),
            snapshot.approval.detail.end(),
            '\n') <= 2;
  }
  snapshot.telemetry.battery_percent =
      std::min<int>(payload["telemetry"]["batteryPercent"] | 100, 100);
  snapshot.telemetry.charging =
      payload["telemetry"]["charging"] | false;
  snapshot.telemetry.wifi_rssi =
      payload["telemetry"]["wifiRssi"] | 0;
  snapshot.telemetry.transport =
      parseTransport(payload["telemetry"]["transport"] | "");
  if (snapshot_handler_) {
    snapshot_handler_(snapshot);
  }
}

void DeviceProtocolClient::sendAck(
    const String& id,
    const std::uint64_t sequence) {
  sendEnvelope(
      "ack",
      [&id, sequence](JsonObject payload) {
        payload["acknowledgedId"] = id;
        payload["acknowledgedSequence"] = sequence;
      },
      false);
}

void DeviceProtocolClient::sendError(const String& code) {
  sendEnvelope(
      "error",
      [&code](JsonObject payload) { payload["code"] = code; },
      false);
}

bool DeviceProtocolClient::sendEnvelope(
    const String& type,
    const std::function<void(JsonObject)>& payload_writer,
    const bool reliable) {
  if (transport_ == nullptr || !transport_->connected()) {
    return false;
  }
  if (reliable && pending_.size() >= kMaximumPending) {
    return false;
  }
  JsonDocument plaintext_document;
  auto plaintext_payload = plaintext_document.to<JsonObject>();
  payload_writer(plaintext_payload);
  String plaintext;
  if (serializeJson(plaintext_document, plaintext) == 0) {
    return false;
  }

  const auto id = randomId();
  const auto sequence = next_sequence_++;
  const auto sent_at = std::max<std::uint64_t>(millis(), 1);
  JsonDocument document;
  document["version"] = kProtocolVersion;
  document["id"] = id;
  document["sequence"] = sequence;
  document["type"] = type;
  document["sentAt"] = sent_at;
  if (!session_id_.isEmpty()) {
    document["sessionId"] = session_id_;
  }
  auto payload = document["payload"].to<JsonObject>();
  if (state_ == State::Ready && !isHandshakeType(type)) {
    if (!encryptPayload(
            payload,
            id,
            sequence,
            type,
            sent_at,
            session_id_,
            plaintext)) {
      return false;
    }
  } else {
    payload.set(plaintext_document.as<JsonObjectConst>());
  }
  String serialized;
  if (
      serializeJson(document, serialized) == 0 ||
      !transport_->sendText(serialized)) {
    return false;
  }
  last_sent_at_ = millis();
  if (reliable) {
    pending_.push_back({
        id,
        sequence,
        serialized,
        1,
        last_sent_at_ + 250,
    });
  }
  return true;
}

bool DeviceProtocolClient::sendCommand(
    const String& command,
    const std::function<void(JsonObject)>& args_writer) {
  if (state_ != State::Ready) {
    return false;
  }
  return sendEnvelope(
      "command",
      [&command, &args_writer, this](JsonObject payload) {
        payload["command"] = command;
        payload["commandId"] = randomId();
        args_writer(payload);
      });
}

bool DeviceProtocolClient::isReliableType(const String& type) const {
  return type != "ack" && type != "heartbeat" && type != "error";
}

bool DeviceProtocolClient::isHandshakeType(const String& type) const {
  return
      type == "hello" ||
      type == "pair.request" ||
      type == "pair.accepted" ||
      type == "pair.rejected" ||
      type == "challenge" ||
      type == "authenticate" ||
      type == "ready";
}

bool DeviceProtocolClient::encryptPayload(
    const JsonObject output,
    const String& id,
    const std::uint64_t sequence,
    const String& type,
    const std::uint64_t sent_at,
    const String& session_id,
    const String& plaintext) const {
  std::array<std::uint8_t, kAeadKeyBytes> key{};
  if (!hmacSha256Bytes(secret_, encryptionMaterial(true), key)) {
    return false;
  }
  std::array<std::uint8_t, kAeadNonceBytes> nonce{};
  if (!deriveNonce(key, sequence, nonce)) return false;
  const auto aad = envelopeAdditionalData(
      id, sequence, type, sent_at, session_id);
  std::vector<std::uint8_t> ciphertext(plaintext.length());
  std::array<std::uint8_t, kAeadTagBytes> tag{};
  mbedtls_gcm_context context;
  mbedtls_gcm_init(&context);
  const auto key_result = mbedtls_gcm_setkey(
      &context, MBEDTLS_CIPHER_ID_AES, key.data(), key.size() * 8U);
  const auto encrypt_result = key_result == 0
      ? mbedtls_gcm_crypt_and_tag(
            &context,
            MBEDTLS_GCM_ENCRYPT,
            plaintext.length(),
            nonce.data(),
            nonce.size(),
            reinterpret_cast<const std::uint8_t*>(aad.c_str()),
            aad.length(),
            reinterpret_cast<const std::uint8_t*>(plaintext.c_str()),
            ciphertext.data(),
            tag.size(),
            tag.data())
      : key_result;
  mbedtls_gcm_free(&context);
  if (encrypt_result != 0) return false;
  const auto nonce_text = encodeBase64(nonce.data(), nonce.size(), true);
  const auto data_text =
      encodeBase64(ciphertext.data(), ciphertext.size(), false);
  const auto tag_text = encodeBase64(tag.data(), tag.size(), true);
  if (nonce_text.length() != 16 || data_text.isEmpty() ||
      tag_text.length() != 22) {
    return false;
  }
  output["encrypted"] = true;
  output["algorithm"] = kAeadAlgorithm;
  output["nonce"] = nonce_text;
  output["data"] = data_text;
  output["tag"] = tag_text;
  return true;
}

bool DeviceProtocolClient::decryptPayload(
    const JsonObjectConst input,
    const String& id,
    const std::uint64_t sequence,
    const String& type,
    const std::uint64_t sent_at,
    const String& session_id,
    JsonDocument& plaintext) const {
  const String algorithm = input["algorithm"] | "";
  const String nonce_text = input["nonce"] | "";
  const String data_text = input["data"] | "";
  const String tag_text = input["tag"] | "";
  if (!(input["encrypted"] | false) || algorithm != kAeadAlgorithm ||
      nonce_text.length() != 16 || data_text.isEmpty() ||
      tag_text.length() != 22) {
    return false;
  }
  std::vector<std::uint8_t> nonce_bytes;
  std::vector<std::uint8_t> ciphertext;
  std::vector<std::uint8_t> tag;
  if (!decodeBase64(nonce_text, true, nonce_bytes) ||
      !decodeBase64(data_text, false, ciphertext) ||
      !decodeBase64(tag_text, true, tag) ||
      nonce_bytes.size() != kAeadNonceBytes ||
      tag.size() != kAeadTagBytes) {
    return false;
  }
  std::array<std::uint8_t, kAeadKeyBytes> key{};
  if (!hmacSha256Bytes(secret_, encryptionMaterial(false), key)) {
    return false;
  }
  std::array<std::uint8_t, kAeadNonceBytes> expected_nonce{};
  if (!deriveNonce(key, sequence, expected_nonce) ||
      !constantTimeEquals(
          nonce_bytes.data(), expected_nonce.data(), expected_nonce.size())) {
    return false;
  }
  const auto aad = envelopeAdditionalData(
      id, sequence, type, sent_at, session_id);
  std::vector<std::uint8_t> decrypted(ciphertext.size() + 1U, 0);
  mbedtls_gcm_context context;
  mbedtls_gcm_init(&context);
  const auto key_result = mbedtls_gcm_setkey(
      &context, MBEDTLS_CIPHER_ID_AES, key.data(), key.size() * 8U);
  const auto decrypt_result = key_result == 0
      ? mbedtls_gcm_auth_decrypt(
            &context,
            ciphertext.size(),
            nonce_bytes.data(),
            nonce_bytes.size(),
            reinterpret_cast<const std::uint8_t*>(aad.c_str()),
            aad.length(),
            tag.data(),
            tag.size(),
            ciphertext.data(),
            decrypted.data())
      : key_result;
  mbedtls_gcm_free(&context);
  if (decrypt_result != 0 ||
      deserializeJson(plaintext, decrypted.data(), ciphertext.size()) ||
      !plaintext.is<JsonObject>()) {
    return false;
  }
  return true;
}

String DeviceProtocolClient::encryptionMaterial(const bool outgoing) const {
  String material;
  const auto direction =
      outgoing ? "device-to-bridge" : "bridge-to-device";
  material.reserve(
      device_id_.length() + device_nonce_.length() +
      bridge_nonce_.length() + strlen(direction) + 48U);
  material = "[\"codex-desk-aead-v1\",2,\"";
  material += device_id_;
  material += "\",\"";
  material += device_nonce_;
  material += "\",\"";
  material += bridge_nonce_;
  material += "\",\"";
  material += direction;
  material += "\"]";
  return material;
}

String DeviceProtocolClient::envelopeAdditionalData(
    const String& id,
    const std::uint64_t sequence,
    const String& type,
    const std::uint64_t sent_at,
    const String& session_id) const {
  String aad;
  aad.reserve(
      id.length() + type.length() + session_id.length() + 64U);
  aad = "[2,\"";
  aad += id;
  aad += "\",";
  aad += String(static_cast<unsigned long long>(sequence));
  aad += ",\"";
  aad += type;
  aad += "\",";
  aad += String(static_cast<unsigned long long>(sent_at));
  if (session_id.isEmpty()) {
    aad += ",null]";
  } else {
    aad += ",\"";
    aad += session_id;
    aad += "\"]";
  }
  return aad;
}

void DeviceProtocolClient::acknowledge(
    const String& id,
    const std::uint64_t sequence) {
  pending_.erase(
      std::remove_if(
          pending_.begin(),
          pending_.end(),
          [&id, sequence](const Pending& pending) {
            return pending.id == id && pending.sequence == sequence;
          }),
      pending_.end());
}

void DeviceProtocolClient::retryPending(const std::uint64_t now_ms) {
  for (auto& pending : pending_) {
    if (now_ms < pending.next_retry_at) {
      continue;
    }
    if (pending.attempts >= 6) {
      notifyState(false, "reliable delivery failed");
      startHandshake(now_ms, false);
      return;
    }
    if (transport_->sendText(pending.serialized)) {
      ++pending.attempts;
      const auto delay = std::min<std::uint32_t>(
          4'000,
          250U << std::min<std::uint8_t>(pending.attempts - 1, 4));
      pending.next_retry_at = now_ms + delay;
      last_sent_at_ = now_ms;
    }
  }
}

void DeviceProtocolClient::clearSession(const bool reset_sequences) {
  state_ = State::Disconnected;
  session_id_ = "";
  device_nonce_ = "";
  bridge_nonce_ = "";
  pending_.clear();
  if (reset_sequences) {
    next_sequence_ = 1;
    receive_window_.reset();
  }
}

String DeviceProtocolClient::randomId(const std::size_t bytes) const {
  static constexpr char kHex[] = "0123456789abcdef";
  String result;
  if (!result.reserve(bytes * 2U)) {
    return {};
  }
  for (std::size_t index = 0; index < bytes; ++index) {
    const auto value = static_cast<std::uint8_t>(esp_random() & 0xffU);
    result += kHex[value >> 4U];
    result += kHex[value & 0x0fU];
  }
  return result;
}

String DeviceProtocolClient::randomNonce() const {
  std::array<std::uint8_t, 24> source{};
  esp_fill_random(source.data(), source.size());
  std::array<std::uint8_t, 48> encoded{};
  std::size_t output_length = 0;
  if (mbedtls_base64_encode(
          encoded.data(),
          encoded.size(),
          &output_length,
          source.data(),
          source.size()) != 0) {
    return {};
  }
  String result;
  result.reserve(output_length);
  for (std::size_t index = 0; index < output_length; ++index) {
    const auto value = static_cast<char>(encoded[index]);
    if (value == '=') {
      break;
    }
    result += value == '+' ? '-' : value == '/' ? '_' : value;
  }
  return result;
}

String DeviceProtocolClient::handshakeProof(const String& role) const {
  String material;
  material.reserve(
      device_id_.length() + device_nonce_.length() +
      bridge_nonce_.length() + role.length() + 20);
  material = "[2,\"";
  material += device_id_;
  material += "\",\"";
  material += device_nonce_;
  material += "\",\"";
  material += bridge_nonce_;
  material += "\",\"";
  material += role;
  material += "\"]";
  return hmacSha256(secret_, material);
}

bool DeviceProtocolClient::verifyProof(
    const String& proof,
    const String& role) const {
  const auto expected = handshakeProof(role);
  if (expected.length() != 64 || proof.length() != expected.length()) {
    return false;
  }
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < expected.length(); ++index) {
    difference |= static_cast<std::uint8_t>(expected[index] ^ proof[index]);
  }
  return difference == 0;
}

String DeviceProtocolClient::derivedSessionId() const {
  return handshakeProof("session").substring(0, 32);
}

void DeviceProtocolClient::notifyState(
    const bool connected,
    const String& detail) {
  if (state_handler_) {
    state_handler_(connected, detail);
  }
}

}  // namespace codex::firmware
