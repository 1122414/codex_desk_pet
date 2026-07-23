#include "pet_store.hpp"

#include <SD_MMC.h>
#include <mbedtls/base64.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cstring>

namespace codex::firmware {
namespace {

constexpr const char* kFormat = "rgb565-key-v1";

String digestHex(const std::uint8_t* data, const std::size_t length) {
  std::array<std::uint8_t, 32> digest{};
  if (mbedtls_sha256(data, length, digest.data(), 0) != 0) {
    return {};
  }
  static constexpr char kHex[] = "0123456789abcdef";
  String value;
  if (!value.reserve(64)) return {};
  for (const auto byte : digest) {
    value += kHex[byte >> 4U];
    value += kHex[byte & 0x0fU];
  }
  return value;
}

String bytesHex(const std::uint8_t* data, const std::size_t length) {
  static constexpr char kHex[] = "0123456789abcdef";
  String value;
  if (!value.reserve(length * 2U)) return {};
  for (std::size_t index = 0; index < length; ++index) {
    value += kHex[data[index] >> 4U];
    value += kHex[data[index] & 0x0fU];
  }
  return value;
}

bool readText(fs::FS& filesystem, const String& path, String& value, const std::size_t maximum) {
  auto file = filesystem.open(path, FILE_READ);
  if (!file || file.isDirectory() || file.size() == 0 || file.size() > maximum) {
    file.close();
    return false;
  }
  value = file.readString();
  file.close();
  return !value.isEmpty();
}

}  // namespace

bool PetStore::begin() {
  if (!SD_MMC.setPins(kSdClock, kSdCommand, kSdD0, kSdD1, kSdD2, kSdD3)) return false;
  mounted_ = SD_MMC.begin("/sdcard", false, false, kSdFrequency, 5);
  if (!mounted_) return false;
  if (!SD_MMC.exists(kRoot) && !SD_MMC.mkdir(kRoot)) return false;
  if (!SD_MMC.exists(kPetRoot) && !SD_MMC.mkdir(kPetRoot)) return false;
  return true;
}

bool PetStore::available() const {
  return mounted_;
}

bool PetStore::handleMessage(
    const String& type,
    const JsonObjectConst payload,
    String& error) {
  if (!mounted_) {
    error = "microSD unavailable";
    return false;
  }
  if (type == "resource.manifest") return beginTransfer(payload, error);
  if (type == "resource.chunk") return acceptChunk(payload, error);
  if (type == "resource.commit") return commitTransfer(payload, error);
  error = "unsupported resource message";
  return false;
}

String PetStore::installedSha(const String& pet_id) {
  ActiveManifest manifest;
  return loadActiveManifest(pet_id, manifest) ? manifest.sha256 : String();
}

ResourceResume PetStore::resumeFor(const String& pet_id) {
  ResourceResume resume;
  if (!mounted_ || !safePetId(pet_id) || !loadResume(pet_id)) return resume;
  resume.sha256 = transfer_.sha256;
  resume.missing_ranges = tracker_.missingRanges();
  return resume;
}

bool PetStore::loadFrame(
    const String& pet_id,
    const std::uint8_t frame_index,
    std::uint16_t* pixels,
    const std::size_t pixel_count,
    String& error) {
  if (!mounted_ || pixels == nullptr || pixel_count !=
      static_cast<std::size_t>(kPetFrameWidth) * kPetFrameHeight) {
    error = "invalid frame destination";
    return false;
  }
  ActiveManifest manifest;
  if (!loadActiveManifest(pet_id, manifest)) {
    error = "Pet is not installed";
    return false;
  }
  if (frame_index >= manifest.frame_count) {
    error = "frame index out of range";
    return false;
  }
  auto file = SD_MMC.open(assetPath(pet_id, manifest.sha256), FILE_READ);
  const auto offset = static_cast<std::uint32_t>(frame_index) * kPetFrameBytes;
  if (!file || file.isDirectory() || file.size() != manifest.bytes ||
      !file.seek(offset)) {
    file.close();
    error = "Pet frame file is unavailable";
    return false;
  }
  const auto expected = static_cast<std::size_t>(kPetFrameBytes);
  const auto read = file.read(reinterpret_cast<std::uint8_t*>(pixels), expected);
  file.close();
  if (read != expected) {
    error = "Pet frame read was incomplete";
    return false;
  }
  return true;
}

void PetStore::checkpoint() {
  if (tracker_.bytes() != 0 && uncheckpointed_chunks_ != 0) saveResume();
}

std::uint8_t PetStore::transferProgress() const {
  if (tracker_.bytes() == 0) return 0;
  std::uint64_t missing = 0;
  for (const auto& range : tracker_.missingRanges()) missing += range.length;
  const auto received = tracker_.bytes() - std::min<std::uint64_t>(missing, tracker_.bytes());
  return static_cast<std::uint8_t>((received * 100U) / tracker_.bytes());
}

bool PetStore::beginTransfer(const JsonObjectConst payload, String& error) {
  ActiveManifest manifest;
  if (!validateManifest(payload, manifest, error)) return false;
  if (installedSha(manifest.pet_id) == manifest.sha256) return true;
  if (loadResume(manifest.pet_id, manifest.sha256)) {
    transfer_ = manifest;
    return true;
  }

  SD_MMC.remove(partPath(manifest.pet_id));
  SD_MMC.remove(resumePath(manifest.pet_id));
  auto part = SD_MMC.open(partPath(manifest.pet_id), FILE_WRITE);
  if (!part) {
    error = "cannot create Pet staging file";
    return false;
  }
  part.close();
  transfer_ = manifest;
  if (!tracker_.begin(manifest.pet_id.c_str(), manifest.bytes) || !saveResume()) {
    error = "cannot initialize Pet transfer";
    return false;
  }
  return true;
}

bool PetStore::acceptChunk(const JsonObjectConst payload, String& error) {
  const String pet_id = payload["petId"] | "";
  const String sha256 = payload["sha256"] | "";
  const String chunk_sha256 = payload["chunkSha256"] | "";
  const String encoded = payload["data"] | "";
  const std::uint32_t offset = payload["offset"] | UINT32_MAX;
  if (pet_id != transfer_.pet_id || sha256 != transfer_.sha256 ||
      chunk_sha256.length() != 64 || encoded.isEmpty() || encoded.length() > 16'384) {
    error = "resource chunk does not match manifest";
    return false;
  }
  std::vector<std::uint8_t> decoded((encoded.length() * 3U) / 4U + 3U);
  std::size_t decoded_bytes = 0;
  if (mbedtls_base64_decode(
          decoded.data(), decoded.size(), &decoded_bytes,
          reinterpret_cast<const std::uint8_t*>(encoded.c_str()),
          encoded.length()) != 0 ||
      decoded_bytes == 0 || digestHex(decoded.data(), decoded_bytes) != chunk_sha256) {
    error = "resource chunk checksum failed";
    return false;
  }
  if (tracker_.contains(offset, decoded_bytes)) {
    if (!verifyExistingChunk(
            pet_id, offset, decoded.data(), decoded_bytes)) {
      error = "duplicate resource chunk conflicts with stored bytes";
      return false;
    }
    return true;
  }
  if (!tracker_.accept(offset, decoded_bytes)) {
    error = "resource chunk range overlaps or exceeds manifest";
    return false;
  }
  auto part = SD_MMC.open(partPath(pet_id), "r+");
  if (!part || !part.seek(offset) || part.write(decoded.data(), decoded_bytes) != decoded_bytes) {
    part.close();
    error = "resource chunk write failed";
    return false;
  }
  part.flush();
  part.close();
  uncheckpointed_chunks_ += 1;
  if (uncheckpointed_chunks_ >= 16 && !saveResume()) {
    error = "resource resume checkpoint failed";
    return false;
  }
  return true;
}

bool PetStore::commitTransfer(const JsonObjectConst payload, String& error) {
  const String pet_id = payload["petId"] | "";
  const String sha256 = payload["sha256"] | "";
  if (pet_id != transfer_.pet_id || sha256 != transfer_.sha256 || !tracker_.complete()) {
    error = "resource transfer is incomplete";
    return false;
  }
  const auto part = partPath(pet_id);
  if (!verifyFile(part, transfer_.bytes, transfer_.sha256)) {
    error = "resource file checksum failed";
    return false;
  }
  const auto asset = assetPath(pet_id, sha256);
  if (SD_MMC.exists(asset)) SD_MMC.remove(asset);
  if (!SD_MMC.rename(part, asset)) {
    error = "cannot publish verified Pet asset";
    return false;
  }
  const auto manifest = manifestPath(pet_id, sha256);
  const auto manifest_temp = manifest + ".tmp";
  SD_MMC.remove(manifest_temp);
  if (!writeManifest(transfer_, manifest_temp)) {
    error = "cannot write Pet manifest";
    return false;
  }
  SD_MMC.remove(manifest);
  if (!SD_MMC.rename(manifest_temp, manifest)) {
    error = "cannot publish Pet manifest";
    return false;
  }
  if (!publishActivePointer(pet_id, sha256, error)) return false;
  const auto verified_key = pet_id + ":" + sha256;
  if (std::find(
          verified_assets_.begin(),
          verified_assets_.end(),
          verified_key) == verified_assets_.end()) {
    if (verified_assets_.size() >= 64) verified_assets_.erase(verified_assets_.begin());
    verified_assets_.push_back(verified_key);
  }
  SD_MMC.remove(resumePath(pet_id));
  tracker_.reset();
  transfer_ = {};
  uncheckpointed_chunks_ = 0;
  return true;
}

bool PetStore::validateManifest(
    const JsonObjectConst payload,
    ActiveManifest& manifest,
    String& error) const {
  manifest.pet_id = payload["petId"] | "";
  manifest.display_name = payload["displayName"] | "";
  manifest.sha256 = payload["sha256"] | "";
  manifest.sprite_version = payload["spriteVersionNumber"] | 0;
  manifest.frame_count = payload["frameCount"] | 0;
  manifest.bytes = payload["bytes"] | 0;
  const auto expected_frames = manifest.sprite_version == 1 ? 72U : 88U;
  const auto expected_bytes = expected_frames * kPetFrameBytes;
  if (!safePetId(manifest.pet_id) || manifest.display_name.isEmpty() ||
      manifest.display_name.length() > 80 || manifest.sha256.length() != 64 ||
      (manifest.sprite_version != 1 && manifest.sprite_version != 2) ||
      manifest.frame_count != expected_frames || manifest.bytes != expected_bytes ||
      strcmp(payload["format"] | "", kFormat) != 0 ||
      (payload["frameWidth"] | 0) != kPetFrameWidth ||
      (payload["frameHeight"] | 0) != kPetFrameHeight ||
      (payload["transparentColor"] | 0) != kPetTransparentColor) {
    error = "invalid Tab5 Pet manifest";
    return false;
  }
  for (std::size_t index = 0; index < manifest.sha256.length(); ++index) {
    const auto value = manifest.sha256[index];
    if (!isHexadecimalDigit(value) || (value >= 'A' && value <= 'F')) {
      error = "invalid Pet SHA-256";
      return false;
    }
  }
  return true;
}

bool PetStore::loadActiveManifest(const String& pet_id, ActiveManifest& manifest) {
  if (!mounted_ || !safePetId(pet_id)) return false;
  ActivePointer first;
  ActivePointer second;
  const auto have_first = readActivePointer(pet_id, 'a', first);
  const auto have_second = readActivePointer(pet_id, 'b', second);
  const auto newest = newestPointerSlot(
      {have_first, first.generation},
      {have_second, second.generation});
  if (newest == 0) {
    if (loadManifestBySha(pet_id, first.sha256, manifest)) return true;
    if (have_second &&
        loadManifestBySha(pet_id, second.sha256, manifest)) return true;
  } else if (newest == 1) {
    if (loadManifestBySha(pet_id, second.sha256, manifest)) return true;
    if (have_first &&
        loadManifestBySha(pet_id, first.sha256, manifest)) return true;
  }

  String legacy_sha;
  if (!readText(SD_MMC, legacyActivePath(pet_id), legacy_sha, 64)) return false;
  legacy_sha.trim();
  return loadManifestBySha(pet_id, legacy_sha, manifest);
}

bool PetStore::loadManifestBySha(
    const String& pet_id,
    const String& sha256,
    ActiveManifest& manifest) {
  if (sha256.length() != 64) return false;
  String text;
  if (!readText(SD_MMC, manifestPath(pet_id, sha256), text, 2'048)) return false;
  JsonDocument document;
  if (deserializeJson(document, text)) return false;
  String error;
  if (!validateManifest(document.as<JsonObjectConst>(), manifest, error) ||
      manifest.pet_id != pet_id || manifest.sha256 != sha256) return false;
  const auto verified_key = pet_id + ":" + sha256;
  if (std::find(
          verified_assets_.begin(),
          verified_assets_.end(),
          verified_key) != verified_assets_.end()) {
    return true;
  }
  if (!verifyFile(
          assetPath(pet_id, sha256),
          manifest.bytes,
          manifest.sha256)) {
    return false;
  }
  if (verified_assets_.size() >= 64) verified_assets_.erase(verified_assets_.begin());
  verified_assets_.push_back(verified_key);
  return true;
}

bool PetStore::readActivePointer(
    const String& pet_id,
    const char slot,
    ActivePointer& pointer) {
  String text;
  if (!readText(SD_MMC, activeSlotPath(pet_id, slot), text, 512)) return false;
  JsonDocument document;
  if (deserializeJson(document, text) ||
      (document["version"] | 0) != 1 ||
      String(document["petId"] | "") != pet_id ||
      !document["sha256"].is<const char*>() ||
      !document["generation"].is<std::uint64_t>()) {
    return false;
  }
  pointer.sha256 = String(document["sha256"].as<const char*>());
  pointer.generation = document["generation"].as<std::uint64_t>();
  if (pointer.sha256.length() != 64 || pointer.generation == 0) return false;
  for (std::size_t index = 0; index < pointer.sha256.length(); ++index) {
    const auto value = pointer.sha256[index];
    if (!isHexadecimalDigit(value) || (value >= 'A' && value <= 'F')) {
      return false;
    }
  }
  return true;
}

bool PetStore::publishActivePointer(
    const String& pet_id,
    const String& sha256,
    String& error) {
  ActivePointer first;
  ActivePointer second;
  const auto have_first = readActivePointer(pet_id, 'a', first);
  const auto have_second = readActivePointer(pet_id, 'b', second);
  const auto highest_generation = std::max(
      have_first ? first.generation : 0U,
      have_second ? second.generation : 0U);
  const auto target_slot = nextPointerWriteSlot(
      {have_first, first.generation},
      {have_second, second.generation}) == 0 ? 'a' : 'b';
  const auto path = activeSlotPath(pet_id, target_slot);
  const auto temporary = path + ".tmp";
  JsonDocument document;
  document["version"] = 1;
  document["petId"] = pet_id;
  document["sha256"] = sha256;
  document["generation"] = highest_generation + 1U;
  SD_MMC.remove(temporary);
  auto pointer = SD_MMC.open(temporary, FILE_WRITE);
  if (!pointer || serializeJson(document, pointer) == 0) {
    pointer.close();
    error = "cannot write active Pet pointer";
    return false;
  }
  pointer.flush();
  pointer.close();
  SD_MMC.remove(path);
  if (!SD_MMC.rename(temporary, path)) {
    error = "cannot publish active Pet pointer";
    return false;
  }
  ActivePointer published;
  if (!readActivePointer(pet_id, target_slot, published) ||
      published.sha256 != sha256 ||
      published.generation != highest_generation + 1U) {
    error = "active Pet pointer verification failed";
    return false;
  }
  return true;
}

bool PetStore::verifyExistingChunk(
    const String& pet_id,
    const std::uint32_t offset,
    const std::uint8_t* data,
    const std::size_t length) {
  if (data == nullptr || length == 0) return false;
  auto part = SD_MMC.open(partPath(pet_id), FILE_READ);
  if (!part || part.isDirectory() || !part.seek(offset)) {
    part.close();
    return false;
  }
  std::array<std::uint8_t, 512> buffer{};
  std::size_t compared = 0;
  std::uint8_t difference = 0;
  while (compared < length) {
    const auto expected =
        std::min<std::size_t>(buffer.size(), length - compared);
    const auto count = part.read(buffer.data(), expected);
    if (count != expected) {
      part.close();
      return false;
    }
    for (std::size_t index = 0; index < count; ++index) {
      difference |= buffer[index] ^ data[compared + index];
    }
    compared += count;
  }
  part.close();
  return difference == 0;
}

bool PetStore::loadResume(const String& pet_id, const String& expected_sha) {
  if (!mounted_ || !safePetId(pet_id)) return false;
  String text;
  if (!readText(SD_MMC, resumePath(pet_id), text, 64U * 1024U)) return false;
  JsonDocument document;
  if (deserializeJson(document, text) || !document["manifest"].is<JsonObjectConst>()) return false;
  ActiveManifest manifest;
  String error;
  if (!validateManifest(document["manifest"].as<JsonObjectConst>(), manifest, error) ||
      manifest.pet_id != pet_id || (!expected_sha.isEmpty() && manifest.sha256 != expected_sha)) {
    return false;
  }
  std::vector<ByteRange> ranges;
  std::uint32_t highest_received_end = 0;
  for (const auto range : document["received"].as<JsonArrayConst>()) {
    const auto offset = range["offset"] | UINT32_MAX;
    const auto length =
        static_cast<std::uint32_t>(range["length"] | 0U);
    ranges.push_back({offset, length});
    if (offset != UINT32_MAX && length <= UINT32_MAX - offset) {
      highest_received_end =
          std::max(highest_received_end, offset + length);
    }
  }
  auto part = SD_MMC.open(partPath(pet_id), FILE_READ);
  const auto valid_file =
      part && !part.isDirectory() &&
      part.size() <= manifest.bytes &&
      highest_received_end <= part.size();
  part.close();
  if (!valid_file || !tracker_.restore(pet_id.c_str(), manifest.bytes, ranges)) return false;
  transfer_ = manifest;
  uncheckpointed_chunks_ = 0;
  return true;
}

bool PetStore::saveResume() {
  if (transfer_.pet_id.isEmpty()) return false;
  JsonDocument document;
  auto manifest = document["manifest"].to<JsonObject>();
  manifest["petId"] = transfer_.pet_id;
  manifest["displayName"] = transfer_.display_name;
  manifest["sha256"] = transfer_.sha256;
  manifest["bytes"] = transfer_.bytes;
  manifest["spriteVersionNumber"] = transfer_.sprite_version;
  manifest["format"] = kFormat;
  manifest["frameWidth"] = kPetFrameWidth;
  manifest["frameHeight"] = kPetFrameHeight;
  manifest["frameCount"] = transfer_.frame_count;
  manifest["transparentColor"] = kPetTransparentColor;
  auto received = document["received"].to<JsonArray>();
  std::uint32_t cursor = 0;
  for (const auto& missing : tracker_.missingRanges()) {
    if (missing.offset > cursor) {
      auto range = received.add<JsonObject>();
      range["offset"] = cursor;
      range["length"] = missing.offset - cursor;
    }
    cursor = missing.offset + missing.length;
  }
  if (cursor < tracker_.bytes()) {
    auto range = received.add<JsonObject>();
    range["offset"] = cursor;
    range["length"] = tracker_.bytes() - cursor;
  }
  const auto path = resumePath(transfer_.pet_id);
  const auto temporary = path + ".tmp";
  SD_MMC.remove(temporary);
  auto file = SD_MMC.open(temporary, FILE_WRITE);
  if (!file || serializeJson(document, file) == 0) {
    file.close();
    return false;
  }
  file.flush();
  file.close();
  SD_MMC.remove(path);
  if (!SD_MMC.rename(temporary, path)) return false;
  uncheckpointed_chunks_ = 0;
  return true;
}

bool PetStore::writeManifest(const ActiveManifest& value, const String& path) {
  JsonDocument document;
  document["petId"] = value.pet_id;
  document["displayName"] = value.display_name;
  document["sha256"] = value.sha256;
  document["bytes"] = value.bytes;
  document["spriteVersionNumber"] = value.sprite_version;
  document["format"] = kFormat;
  document["frameWidth"] = kPetFrameWidth;
  document["frameHeight"] = kPetFrameHeight;
  document["frameCount"] = value.frame_count;
  document["transparentColor"] = kPetTransparentColor;
  auto file = SD_MMC.open(path, FILE_WRITE);
  if (!file || serializeJson(document, file) == 0) {
    file.close();
    return false;
  }
  file.flush();
  file.close();
  return true;
}

bool PetStore::verifyFile(
    const String& path,
    const std::uint32_t bytes,
    const String& sha256) {
  auto file = SD_MMC.open(path, FILE_READ);
  if (!file || file.isDirectory() || file.size() != bytes) {
    file.close();
    return false;
  }
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  if (mbedtls_sha256_starts(&context, 0) != 0) {
    file.close();
    mbedtls_sha256_free(&context);
    return false;
  }
  std::array<std::uint8_t, 4'096> buffer{};
  while (file.available()) {
    const auto read = file.read(buffer.data(), buffer.size());
    if (read == 0 || mbedtls_sha256_update(&context, buffer.data(), read) != 0) {
      file.close();
      mbedtls_sha256_free(&context);
      return false;
    }
  }
  file.close();
  std::array<std::uint8_t, 32> digest{};
  const auto valid = mbedtls_sha256_finish(&context, digest.data()) == 0;
  mbedtls_sha256_free(&context);
  return valid && bytesHex(digest.data(), digest.size()) == sha256;
}

bool PetStore::safePetId(const String& pet_id) const {
  if (pet_id.isEmpty() || pet_id.length() > 64) return false;
  for (std::size_t index = 0; index < pet_id.length(); ++index) {
    const auto value = pet_id[index];
    if (!(value >= 'a' && value <= 'z') && !(value >= '0' && value <= '9') && value != '-') {
      return false;
    }
  }
  return true;
}

String PetStore::partPath(const String& pet_id) const {
  return String(kPetRoot) + "/" + pet_id + ".part";
}

String PetStore::resumePath(const String& pet_id) const {
  return String(kPetRoot) + "/" + pet_id + ".resume.json";
}

String PetStore::legacyActivePath(const String& pet_id) const {
  return String(kPetRoot) + "/" + pet_id + ".active";
}

String PetStore::activeSlotPath(
    const String& pet_id,
    const char slot) const {
  return String(kPetRoot) + "/" + pet_id + ".active." + slot;
}

String PetStore::assetPath(const String& pet_id, const String& sha256) const {
  return String(kPetRoot) + "/" + pet_id + "-" + sha256 + ".rgb565";
}

String PetStore::manifestPath(const String& pet_id, const String& sha256) const {
  return String(kPetRoot) + "/" + pet_id + "-" + sha256 + ".json";
}

}  // namespace codex::firmware
