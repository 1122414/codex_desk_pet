#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace codex {

constexpr std::uint32_t kMaximumResourceBytes = 16U * 1024U * 1024U;
constexpr std::uint16_t kPetFrameWidth = 144;
constexpr std::uint16_t kPetFrameHeight = 156;
constexpr std::uint16_t kPetTransparentColor = 0x0001;
constexpr std::uint32_t kPetFrameBytes =
    static_cast<std::uint32_t>(kPetFrameWidth) * kPetFrameHeight * 2U;

struct ByteRange {
  std::uint32_t offset = 0;
  std::uint32_t length = 0;
};

struct DevicePetManifest {
  std::string pet_id;
  std::uint8_t sprite_version = 2;
  std::uint16_t frame_count = 88;
  std::uint32_t payload_bytes = 0;
  std::array<std::uint8_t, 32> sha256{};
};

bool validateDevicePetManifest(const DevicePetManifest& manifest);

class ResourceTransferTracker {
 public:
  bool begin(const std::string& pet_id, std::uint32_t bytes);
  bool restore(
      const std::string& pet_id,
      std::uint32_t bytes,
      const std::vector<ByteRange>& received);
  bool accept(std::uint32_t offset, std::uint32_t length);
  std::vector<ByteRange> missingRanges() const;
  bool complete() const;
  const std::string& petId() const;
  std::uint32_t bytes() const;
  void reset();

 private:
  std::string pet_id_;
  std::uint32_t bytes_ = 0;
  std::vector<ByteRange> received_;
};

}  // namespace codex
