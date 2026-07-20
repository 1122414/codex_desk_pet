#include "codex_core/model.hpp"

namespace codex {

bool DeskModel::applySnapshot(const Snapshot& snapshot) {
  if (has_snapshot_ && snapshot.revision <= snapshot_.revision) {
    return false;
  }
  snapshot_ = snapshot;
  has_snapshot_ = true;
  return true;
}

void DeskModel::markOffline() {
  snapshot_.bridge_connected = false;
  snapshot_.telemetry.transport = TransportKind::Offline;
}

void DeskModel::selectPetLocally(const std::string& pet_id) {
  if (!pet_id.empty()) {
    snapshot_.selected_pet_id = pet_id;
  }
}

void DeskModel::updateTelemetryLocally(const Telemetry& telemetry) {
  snapshot_.telemetry = telemetry;
}

const Snapshot& DeskModel::snapshot() const {
  return snapshot_;
}

bool DeskModel::hasSnapshot() const {
  return has_snapshot_;
}

}  // namespace codex
