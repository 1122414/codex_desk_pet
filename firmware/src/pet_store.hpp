#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FS.h>

#include <vector>

#include "codex_core/resource.hpp"

namespace codex::firmware {

struct ResourceResume {
  String sha256;
  std::vector<ByteRange> missing_ranges;
};

class PetStore {
 public:
  bool begin();
  bool available() const;
  bool handleMessage(
      const String& type,
      JsonObjectConst payload,
      String& error);
  String installedSha(const String& pet_id);
  ResourceResume resumeFor(const String& pet_id);
  bool loadFrame(
      const String& pet_id,
      std::uint8_t frame_index,
      std::uint16_t* pixels,
      std::size_t pixel_count,
      String& error);
  void checkpoint();
  std::uint8_t transferProgress() const;
  bool transferActive() const {
    return tracker_.bytes() != 0 && !tracker_.complete();
  }

 private:
  struct ActiveManifest {
    String pet_id;
    String display_name;
    String sha256;
    std::uint8_t sprite_version = 2;
    std::uint16_t frame_count = 88;
    std::uint32_t bytes = 0;
  };

  struct ActivePointer {
    String sha256;
    std::uint64_t generation = 0;
  };

  static constexpr std::uint8_t kSdD0 = 39;
  static constexpr std::uint8_t kSdD1 = 40;
  static constexpr std::uint8_t kSdD2 = 41;
  static constexpr std::uint8_t kSdD3 = 42;
  static constexpr std::uint8_t kSdClock = 43;
  static constexpr std::uint8_t kSdCommand = 44;
  static constexpr std::uint32_t kSdFrequency = 25'000'000;
  static constexpr const char* kRoot = "/codex-desk";
  static constexpr const char* kPetRoot = "/codex-desk/pets";

  bool beginTransfer(JsonObjectConst payload, String& error);
  bool acceptChunk(JsonObjectConst payload, String& error);
  bool commitTransfer(JsonObjectConst payload, String& error);
  bool validateManifest(JsonObjectConst payload, ActiveManifest& manifest, String& error) const;
  bool loadActiveManifest(const String& pet_id, ActiveManifest& manifest);
  bool loadManifestBySha(
      const String& pet_id,
      const String& sha256,
      ActiveManifest& manifest);
  bool readActivePointer(
      const String& pet_id,
      char slot,
      ActivePointer& pointer);
  bool publishActivePointer(
      const String& pet_id,
      const String& sha256,
      String& error);
  bool verifyExistingChunk(
      const String& pet_id,
      std::uint32_t offset,
      const std::uint8_t* data,
      std::size_t length);
  bool loadResume(const String& pet_id, const String& expected_sha = "");
  bool saveResume();
  bool writeManifest(const ActiveManifest& manifest, const String& path);
  bool verifyFile(const String& path, std::uint32_t bytes, const String& sha256);
  bool safePetId(const String& pet_id) const;
  String partPath(const String& pet_id) const;
  String resumePath(const String& pet_id) const;
  String legacyActivePath(const String& pet_id) const;
  String activeSlotPath(const String& pet_id, char slot) const;
  String assetPath(const String& pet_id, const String& sha256) const;
  String manifestPath(const String& pet_id, const String& sha256) const;

  bool mounted_ = false;
  ActiveManifest transfer_;
  ResourceTransferTracker tracker_;
  std::uint16_t uncheckpointed_chunks_ = 0;
  std::vector<String> verified_assets_;
};

}  // namespace codex::firmware
