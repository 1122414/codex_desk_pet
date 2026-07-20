#include "codex_core/reconnect.hpp"

#include <algorithm>

namespace codex {

std::uint32_t ReconnectSchedule::nextDelayMs() {
  const auto index = std::min(attempt_, kDelays.size() - 1);
  ++attempt_;
  return kDelays[index];
}

void ReconnectSchedule::reset() {
  attempt_ = 0;
}

std::size_t ReconnectSchedule::attempt() const {
  return attempt_;
}

}  // namespace codex
