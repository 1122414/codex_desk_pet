#include "codex_core/resource.hpp"

#include <algorithm>
#include <utility>

namespace codex {

int newestPointerSlot(
    const PointerSlotState& first,
    const PointerSlotState& second) {
  if (!first.valid && !second.valid) return -1;
  if (!second.valid) return 0;
  if (!first.valid) return 1;
  return second.generation > first.generation ? 1 : 0;
}

int nextPointerWriteSlot(
    const PointerSlotState& first,
    const PointerSlotState& second) {
  if (!first.valid) return 0;
  if (!second.valid) return 1;
  return first.generation <= second.generation ? 0 : 1;
}

bool validateDevicePetManifest(const DevicePetManifest& manifest) {
  if (manifest.pet_id.empty() || manifest.pet_id.size() > 64) {
    return false;
  }
  if (manifest.sprite_version != 1 && manifest.sprite_version != 2) {
    return false;
  }
  const auto expected_frames =
      manifest.sprite_version == 1 ? std::uint16_t{72} : std::uint16_t{88};
  if (manifest.frame_count != expected_frames) {
    return false;
  }
  const auto expected_bytes =
      static_cast<std::uint32_t>(expected_frames) * kPetFrameBytes;
  return manifest.payload_bytes == expected_bytes &&
         manifest.payload_bytes <= kMaximumResourceBytes;
}

bool ResourceTransferTracker::begin(
    const std::string& pet_id,
    const std::uint32_t bytes) {
  if (pet_id.empty() || pet_id.size() > 64 || bytes == 0 ||
      bytes > kMaximumResourceBytes) {
    return false;
  }
  pet_id_ = pet_id;
  bytes_ = bytes;
  received_.clear();
  return true;
}

bool ResourceTransferTracker::restore(
    const std::string& pet_id,
    const std::uint32_t bytes,
    const std::vector<ByteRange>& received) {
  ResourceTransferTracker restored;
  if (!restored.begin(pet_id, bytes)) {
    return false;
  }
  for (const auto& range : received) {
    if (!restored.accept(range.offset, range.length)) {
      return false;
    }
  }
  *this = std::move(restored);
  return true;
}

bool ResourceTransferTracker::accept(
    const std::uint32_t offset,
    const std::uint32_t length) {
  if (bytes_ == 0 || length == 0 || offset >= bytes_ ||
      length > bytes_ - offset) {
    return false;
  }
  const ByteRange incoming{offset, length};
  for (const auto& range : received_) {
    const auto same =
        range.offset == incoming.offset && range.length == incoming.length;
    const auto overlaps =
        incoming.offset < range.offset + range.length &&
        range.offset < incoming.offset + incoming.length;
    if (same) {
      return true;
    }
    if (overlaps) {
      return false;
    }
  }
  received_.push_back(incoming);
  std::sort(
      received_.begin(),
      received_.end(),
      [](const ByteRange& left, const ByteRange& right) {
        return left.offset < right.offset;
      });
  return true;
}

bool ResourceTransferTracker::contains(
    const std::uint32_t offset,
    const std::uint32_t length) const {
  return std::any_of(
      received_.begin(),
      received_.end(),
      [offset, length](const ByteRange& range) {
        return range.offset == offset && range.length == length;
      });
}

std::vector<ByteRange> ResourceTransferTracker::missingRanges() const {
  std::vector<ByteRange> missing;
  if (bytes_ == 0) {
    return missing;
  }
  std::uint32_t cursor = 0;
  for (const auto& range : received_) {
    if (range.offset > cursor) {
      missing.push_back({cursor, range.offset - cursor});
    }
    cursor = std::max(cursor, range.offset + range.length);
  }
  if (cursor < bytes_) {
    missing.push_back({cursor, bytes_ - cursor});
  }
  return missing;
}

bool ResourceTransferTracker::complete() const {
  return bytes_ > 0 && missingRanges().empty();
}

const std::string& ResourceTransferTracker::petId() const {
  return pet_id_;
}

std::uint32_t ResourceTransferTracker::bytes() const {
  return bytes_;
}

void ResourceTransferTracker::reset() {
  pet_id_.clear();
  bytes_ = 0;
  received_.clear();
}

}  // namespace codex
