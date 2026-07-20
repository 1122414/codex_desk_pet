#include "codex_core/sequence.hpp"

#include <stdexcept>

namespace codex {

SequenceObservation SequenceWindow::observe(
    const std::uint64_t sequence,
    const bool snapshot) {
  if (sequence == 0) {
    return {SequenceStatus::Gap, last_accepted_ + 1};
  }
  if (sequence <= last_accepted_) {
    return {SequenceStatus::Duplicate, last_accepted_ + 1};
  }
  if (!snapshot && sequence != last_accepted_ + 1) {
    return {SequenceStatus::Gap, last_accepted_ + 1};
  }
  last_accepted_ = sequence;
  return {SequenceStatus::Accepted, last_accepted_ + 1};
}

std::uint64_t SequenceWindow::lastAccepted() const {
  return last_accepted_;
}

void SequenceWindow::reset() {
  last_accepted_ = 0;
}

CommandDeduplicator::CommandDeduplicator(const std::size_t limit)
    : limit_(limit) {
  if (limit_ == 0) {
    throw std::invalid_argument("Deduplication limit must be positive");
  }
}

bool CommandDeduplicator::accept(const std::string& command_id) {
  if (command_id.empty()) {
    return false;
  }
  if (ids_.find(command_id) != ids_.end()) {
    return false;
  }
  ids_.insert(command_id);
  order_.push_back(command_id);
  while (order_.size() > limit_) {
    ids_.erase(order_.front());
    order_.pop_front();
  }
  return true;
}

void CommandDeduplicator::clear() {
  order_.clear();
  ids_.clear();
}

}  // namespace codex
