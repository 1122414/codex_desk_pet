#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace codex {

enum class PresentationState : std::uint8_t {
  Ready,
  Running,
  NeedsInput,
  Reviewing,
  Completed,
  Blocked,
};

enum class Animation : std::uint8_t {
  Idle,
  RunningRight,
  RunningLeft,
  Waving,
  Jumping,
  Failed,
  Waiting,
  Running,
  Review,
};

enum class TransportKind : std::uint8_t {
  Offline,
  Usb,
  Wifi,
  Ble,
};

struct Approval {
  bool present = false;
  bool safe_to_approve = false;
  std::string request_id;
  std::string title;
  std::string detail;
  std::string reason;
};

struct Telemetry {
  std::uint8_t battery_percent = 100;
  bool charging = false;
  std::int16_t wifi_rssi = 0;
  TransportKind transport = TransportKind::Offline;
};

struct TokenLevel {
  std::uint64_t total = 0;
  std::uint32_t level = 1;
  std::uint32_t current = 0;
  std::uint32_t target = 50'000;
};

struct PetSummary {
  std::string id;
  std::string display_name;
  std::uint8_t sprite_version = 2;
  bool builtin = false;
};

struct TaskProgress {
  bool known = false;
  std::uint32_t completed = 0;
  std::uint32_t total = 0;
  std::uint8_t percent = 0;
};

struct TaskSummary {
  std::string id;
  std::string title;
  PresentationState state = PresentationState::Ready;
  std::uint64_t updated_at = 0;
  std::uint64_t tokens = 0;
  TaskProgress progress;
};

struct TaskCounts {
  std::uint16_t total = 0;
  std::uint16_t active = 0;
  std::uint16_t visible = 0;
};

struct Quota {
  bool available = false;
  std::uint8_t used_percent = 0;
  std::uint64_t resets_at = 0;
  std::uint32_t window_minutes = 0;
  std::string name = "Codex";
};

struct AccountTokens {
  std::uint64_t lifetime = 0;
  std::uint64_t today = 0;
  bool today_available = false;
};

struct Clock {
  std::uint64_t unix_ms = 0;
  std::int16_t utc_offset_minutes = 0;
};

struct Snapshot {
  std::uint64_t revision = 0;
  bool bridge_connected = false;
  PresentationState state = PresentationState::Ready;
  Animation animation = Animation::Idle;
  std::string task_id;
  std::string task_title;
  std::vector<TaskSummary> tasks;
  TaskCounts task_counts;
  std::string selected_pet_id = "codex-core";
  std::vector<PetSummary> pets{{"codex-core", "Codex Core", 2, true}};
  TokenLevel tokens;
  AccountTokens account_tokens;
  Quota quota;
  Clock clock;
  Approval approval;
  Telemetry telemetry;
};

const char* animationName(Animation animation);
const char* stateName(PresentationState state);
bool parseAnimation(const std::string& value, Animation& animation);
bool parsePresentationState(const std::string& value, PresentationState& state);

}  // namespace codex
