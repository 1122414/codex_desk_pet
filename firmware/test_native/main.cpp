#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "codex_core/animation.hpp"
#include "codex_core/input.hpp"
#include "codex_core/model.hpp"
#include "codex_core/reconnect.hpp"
#include "codex_core/resource.hpp"
#include "codex_core/sequence.hpp"
#include "codex_core/types.hpp"

namespace {

int failures = 0;

void expect(const bool condition, const std::string& message) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

void testAnimations() {
  const std::vector<codex::Animation> animations{
      codex::Animation::Idle,
      codex::Animation::RunningRight,
      codex::Animation::RunningLeft,
      codex::Animation::Waving,
      codex::Animation::Jumping,
      codex::Animation::Failed,
      codex::Animation::Waiting,
      codex::Animation::Running,
      codex::Animation::Review,
  };
  for (std::size_t index = 0; index < animations.size(); ++index) {
    const auto& spec = codex::animationSpec(animations[index]);
    expect(spec.row == index, "animation row matches the PC Pet contract");
    expect(spec.frame_count >= 4 && spec.frame_count <= 8, "frame count is bounded");
  }
  expect(codex::lookDirectionIndex(359.0F) == 0, "359 degrees wraps to zero");
  expect(codex::lookDirectionIndex(22.6F) == 1, "look angle snaps to 22.5 degrees");

  codex::AnimationPlayer player;
  player.set(codex::Animation::Waving, 100);
  expect(player.frame(239) == 0, "animation keeps the first frame for its duration");
  expect(player.frame(240) == 1, "animation advances at the exact frame boundary");
}

void testModel() {
  codex::DeskModel model;
  codex::Snapshot first;
  first.revision = 2;
  first.bridge_connected = true;
  first.task_title = "最近运行任务";
  expect(model.applySnapshot(first), "first snapshot is accepted");
  expect(!model.applySnapshot(first), "duplicate revision is rejected");
  codex::Snapshot stale = first;
  stale.revision = 1;
  expect(!model.applySnapshot(stale), "stale snapshot is rejected");
  model.markOffline();
  expect(!model.snapshot().bridge_connected, "offline state is explicit");
  model.selectPetLocally("desk-fox");
  expect(model.snapshot().selected_pet_id == "desk-fox", "local Pet selection is immediate");
  codex::Telemetry telemetry;
  telemetry.battery_percent = 42;
  telemetry.transport = codex::TransportKind::Wifi;
  model.updateTelemetryLocally(telemetry);
  expect(
      model.snapshot().telemetry.battery_percent == 42 &&
          model.snapshot().telemetry.transport == codex::TransportKind::Wifi,
      "local hardware telemetry updates before the Bridge echoes a snapshot");
}

void testInput() {
  codex::InputController input;
  auto action = input.onTouch(
      codex::TouchPhase::Pressed, {240, 180}, 100, true, true);
  expect(action.type == codex::ActionType::None, "approval executes on release only");
  action = input.onTouch(
      codex::TouchPhase::Released, {240, 180}, 150, true, true);
  expect(action.type == codex::ActionType::None, "too-fast approval tap is rejected");

  input.onTouch(codex::TouchPhase::Pressed, {240, 180}, 1'000, true, true);
  action = input.onTouch(
      codex::TouchPhase::Released, {240, 180}, 1'120, true, true);
  expect(action.type == codex::ActionType::AcceptApproval, "safe press-release accepts once");
  input.onTouch(codex::TouchPhase::Pressed, {240, 180}, 1'200, true, true);
  action = input.onTouch(
      codex::TouchPhase::Released, {240, 180}, 1'320, true, true);
  expect(action.type == codex::ActionType::None, "approval cooldown prevents duplicates");

  input.onTouch(codex::TouchPhase::Pressed, {250, 100}, 3'000, false, false);
  action = input.onTouch(
      codex::TouchPhase::Released, {100, 100}, 3'300, false, false);
  expect(action.type == codex::ActionType::NextPet, "left swipe selects the next Pet");
  action = input.onButton(codex::ButtonId::Left, true, false);
  expect(action.type == codex::ActionType::DeclineApproval, "left button declines");
  action = input.onButton(codex::ButtonId::Right, true, false);
  expect(action.type == codex::ActionType::None, "unsafe approval cannot be accepted");
}

void testReconnectAndSequence() {
  codex::ReconnectSchedule reconnect;
  const std::vector<std::uint32_t> expected{
      1'000, 2'000, 4'000, 8'000, 16'000, 30'000, 30'000};
  for (const auto delay : expected) {
    expect(reconnect.nextDelayMs() == delay, "reconnect delay follows the bounded schedule");
  }
  reconnect.reset();
  expect(reconnect.nextDelayMs() == 1'000, "reconnect schedule resets after success");

  codex::SequenceWindow window;
  expect(
      window.observe(1, false).status == codex::SequenceStatus::Accepted,
      "first sequence is accepted");
  expect(
      window.observe(1, false).status == codex::SequenceStatus::Duplicate,
      "duplicate sequence is detected");
  expect(
      window.observe(3, false).status == codex::SequenceStatus::Gap,
      "incremental gap is rejected");
  expect(
      window.observe(3, true).status == codex::SequenceStatus::Accepted,
      "snapshot crosses a gap");

  codex::CommandDeduplicator dedupe(2);
  expect(dedupe.accept("one"), "first command executes");
  expect(!dedupe.accept("one"), "duplicate command does not execute");
  expect(dedupe.accept("two") && dedupe.accept("three"), "bounded history accepts new commands");
  expect(dedupe.accept("one"), "evicted command can be accepted in a later session window");
}

void testResources() {
  codex::PointerSlotState first_pointer{true, 1};
  codex::PointerSlotState second_pointer;
  expect(
      codex::newestPointerSlot(first_pointer, second_pointer) == 0 &&
          codex::nextPointerWriteSlot(first_pointer, second_pointer) == 1,
      "second pointer slot is updated while the first remains recoverable");
  second_pointer = {true, 2};
  expect(
      codex::newestPointerSlot(first_pointer, second_pointer) == 1 &&
          codex::nextPointerWriteSlot(first_pointer, second_pointer) == 0,
      "newest generation wins and the older slot becomes the next target");
  first_pointer = {false, 0};
  expect(
      codex::newestPointerSlot(first_pointer, second_pointer) == 1,
      "power loss while replacing one slot preserves the other active pointer");

  codex::DevicePetManifest v2;
  v2.pet_id = "desk-fox";
  v2.sprite_version = 2;
  v2.frame_count = 88;
  v2.payload_bytes = 88U * codex::kPetFrameBytes;
  expect(codex::validateDevicePetManifest(v2), "v2 RGB565 frame package is valid");
  v2.frame_count = 87;
  expect(!codex::validateDevicePetManifest(v2), "wrong frame count is rejected");

  codex::ResourceTransferTracker tracker;
  expect(tracker.begin("desk-fox", 1'000), "resource transfer starts");
  expect(tracker.accept(400, 200), "out-of-order chunk is accepted");
  expect(tracker.contains(400, 200), "exact duplicate range is detectable before writing");
  expect(!tracker.contains(400, 199), "different range is not treated as an exact duplicate");
  expect(tracker.accept(0, 400), "leading chunk is accepted");
  expect(!tracker.accept(300, 200), "overlapping chunk is rejected");
  auto missing = tracker.missingRanges();
  expect(
      missing.size() == 1 && missing[0].offset == 600 && missing[0].length == 400,
      "missing range supports resume");
  expect(tracker.accept(600, 400) && tracker.complete(), "resource completes exactly once");

  codex::ResourceTransferTracker restored;
  expect(
      restored.restore("desk-fox", 1'000, {{0, 400}, {600, 400}}),
      "persisted resource ranges restore after reboot");
  const auto restored_missing = restored.missingRanges();
  expect(
      restored_missing.size() == 1 && restored_missing[0].offset == 400 &&
          restored_missing[0].length == 200,
      "restored resource reports the exact resume gap");
  expect(
      !restored.restore("desk-fox", 1'000, {{0, 500}, {400, 100}}),
      "overlapping persisted ranges are rejected");
}

}  // namespace

int main() {
  testAnimations();
  testModel();
  testInput();
  testReconnectAndSequence();
  testResources();
  if (failures != 0) {
    std::cerr << failures << " firmware core assertion(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "Firmware core checks passed\n";
  return EXIT_SUCCESS;
}
