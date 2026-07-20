#pragma once

#include <cstdint>

#include "codex_core/types.hpp"

namespace codex {

class DeskModel {
 public:
  bool applySnapshot(const Snapshot& snapshot);
  void markOffline();
  void selectPetLocally(const std::string& pet_id);
  void updateTelemetryLocally(const Telemetry& telemetry);
  const Snapshot& snapshot() const;
  bool hasSnapshot() const;

 private:
  Snapshot snapshot_{};
  bool has_snapshot_ = false;
};

}  // namespace codex
