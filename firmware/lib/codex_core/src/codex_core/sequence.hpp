#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <string>
#include <unordered_set>

namespace codex {

enum class SequenceStatus : std::uint8_t {
  Accepted,
  Duplicate,
  Gap,
};

struct SequenceObservation {
  SequenceStatus status = SequenceStatus::Accepted;
  std::uint64_t expected = 1;
};

class SequenceWindow {
 public:
  SequenceObservation observe(std::uint64_t sequence, bool snapshot);
  std::uint64_t lastAccepted() const;
  void reset();

 private:
  std::uint64_t last_accepted_ = 0;
};

class CommandDeduplicator {
 public:
  explicit CommandDeduplicator(std::size_t limit = 256);
  bool accept(const std::string& command_id);
  void clear();

 private:
  std::size_t limit_;
  std::deque<std::string> order_;
  std::unordered_set<std::string> ids_;
};

}  // namespace codex
