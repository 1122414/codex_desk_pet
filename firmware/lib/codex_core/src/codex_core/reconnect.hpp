#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace codex {

class ReconnectSchedule {
 public:
  std::uint32_t nextDelayMs();
  void reset();
  std::size_t attempt() const;

 private:
  static constexpr std::array<std::uint32_t, 6> kDelays{
      1'000, 2'000, 4'000, 8'000, 16'000, 30'000};
  std::size_t attempt_ = 0;
};

}  // namespace codex
