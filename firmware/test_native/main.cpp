#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "codex_core/animation.hpp"
#include "codex_core/audio.hpp"
#include "codex_core/input.hpp"
#include "codex_core/model.hpp"
#include "codex_core/reconnect.hpp"
#include "codex_core/resource.hpp"
#include "codex_core/sequence.hpp"
#include "codex_core/types.hpp"
#include "codex_core/voice_activity.hpp"

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

void testAudioPlans() {
  const std::vector<codex::PresentationState> states{
      codex::PresentationState::Ready,
      codex::PresentationState::Running,
      codex::PresentationState::NeedsInput,
      codex::PresentationState::Reviewing,
      codex::PresentationState::Completed,
      codex::PresentationState::Blocked,
  };
  for (const auto state : states) {
    const auto& plan = codex::audioPlan(codex::audioCueForState(state));
    expect(
        plan.chinese_phrase != nullptr && std::strlen(plan.chinese_phrase) > 0,
        "every Codex state has an offline Chinese phrase");
    expect(
        plan.tone_count > 0 && plan.tone_count <= plan.fallback_tones.size(),
        "every Codex state has a bounded fallback tone plan");
  }
  expect(
      codex::audioPlan(codex::AudioCue::NeedsInput).tone_count == 2,
      "approval prompt keeps its distinctive double tone");
  expect(
      codex::audioPlan(codex::AudioCue::PetInstalled).chinese_phrase != nullptr,
      "Pet installation has an offline Chinese phrase");
}

void testVoiceActivity() {
  std::vector<std::int16_t> silence(640, 0);
  std::vector<std::int16_t> speech(640, 2'000);
  codex::VoiceActivityDetector detector;
  detector.begin(1'000, 20'000);
  expect(
      detector.observe(silence.data(), silence.size(), 20'999) ==
          codex::VoiceActivityResult::Listening,
      "automatic listening stays quiet before its maximum duration");
  expect(
      detector.observe(silence.data(), silence.size(), 21'000) ==
          codex::VoiceActivityResult::NoSpeechTimeout,
      "automatic listening exits quietly after twenty seconds without speech");

  detector.begin(30'000, 20'000);
  expect(
      detector.observe(speech.data(), speech.size(), 31'000) ==
          codex::VoiceActivityResult::Listening &&
          detector.heardSpeech(),
      "voice activity marks the first spoken chunk");
  expect(
      detector.observe(silence.data(), silence.size(), 33'499) ==
          codex::VoiceActivityResult::Listening,
      "voice activity waits for the full silence tail");
  expect(
      detector.observe(silence.data(), silence.size(), 33'500) ==
          codex::VoiceActivityResult::SpeechEnded,
      "voice activity ends after two and a half seconds of silence");
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

  codex::InputController tab5_input({
      {48, 104, 448, 496},
      {540, 554, 292, 104},
      {864, 554, 356, 104},
      {272, 352},
      96,
  });
  tab5_input.onTouch(codex::TouchPhase::Pressed, {1'000, 600}, 4'000, true, true);
  action = tab5_input.onTouch(
      codex::TouchPhase::Released, {1'000, 600}, 4'120, true, true);
  expect(
      action.type == codex::ActionType::AcceptApproval,
      "Tab5 approval layout keeps confirmation inside its large visible button");
  tab5_input.onTouch(codex::TouchPhase::Pressed, {420, 350}, 5'000, false, false);
  action = tab5_input.onTouch(
      codex::TouchPhase::Released, {180, 350}, 5'300, false, false);
  expect(
      action.type == codex::ActionType::NextPet,
      "Tab5 pet area preserves the wide swipe interaction");
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

  codex::ResourceTransferTracker v2_transfer;
  constexpr auto v2_bytes = 88U * codex::kPetFrameBytes;
  expect(v2_transfer.begin("v2-pet", v2_bytes), "V2 resource transfer starts");
  bool v2_chunks_accepted = true;
  for (std::uint32_t offset = 0; offset < v2_bytes; offset += 3U * 1024U) {
    const auto length = std::min<std::uint32_t>(3U * 1024U, v2_bytes - offset);
    v2_chunks_accepted = v2_chunks_accepted && v2_transfer.accept(offset, length);
  }
  expect(
      v2_chunks_accepted && v2_transfer.complete(),
      "V2 resource transfer accepts sequential USB chunks without re-sorting every range");
}

std::uint32_t nextRandom(std::uint32_t& state) {
  state = (state * 1'664'525U) + 1'013'904'223U;
  return state;
}

void testStressCycles() {
  std::uint32_t random_state = 0x5eedc0deU;
  codex::PointerSlotState slots[2]{{true, 1}, {false, 0}};
  std::uint32_t generation = 1;
  bool pointer_invariant = true;
  for (std::size_t cycle = 0; cycle < 50'000; ++cycle) {
    const auto previous = codex::newestPointerSlot(slots[0], slots[1]);
    const auto target = codex::nextPointerWriteSlot(slots[0], slots[1]);
    pointer_invariant =
        pointer_invariant && previous >= 0 && target >= 0 && previous != target;
    const auto next_generation = generation + 1;
    if ((nextRandom(random_state) % 5U) == 0U) {
      slots[target] = {false, next_generation};
      pointer_invariant =
          pointer_invariant &&
          codex::newestPointerSlot(slots[0], slots[1]) == previous;
    } else {
      generation = next_generation;
      slots[target] = {true, generation};
      pointer_invariant =
          pointer_invariant &&
          codex::newestPointerSlot(slots[0], slots[1]) == target;
    }
  }
  expect(
      pointer_invariant,
      "50,000 simulated pointer writes preserve one valid active slot");

  bool transfer_invariant = true;
  for (std::size_t cycle = 0; cycle < 10'000; ++cycle) {
    codex::ResourceTransferTracker tracker;
    transfer_invariant =
        transfer_invariant && tracker.begin("stress-pet", 4'096);
    const auto first = (nextRandom(random_state) % 4U) * 1'024U;
    for (std::size_t offset_index = 0; offset_index < 4; ++offset_index) {
      const auto offset =
          ((first / 1'024U + offset_index) % 4U) * 1'024U;
      transfer_invariant =
          transfer_invariant && tracker.accept(offset, 1'024);
    }
    transfer_invariant =
        transfer_invariant && tracker.complete() &&
        !tracker.accept(512, 1'024);
  }
  expect(
      transfer_invariant,
      "10,000 out-of-order resource transfers complete without overlap");

  codex::SequenceWindow window;
  bool sequence_invariant = true;
  std::uint64_t sequence = 0;
  for (std::size_t cycle = 0; cycle < 50'000; ++cycle) {
    ++sequence;
    sequence_invariant =
        sequence_invariant &&
        window.observe(sequence, false).status ==
            codex::SequenceStatus::Accepted &&
        window.observe(sequence, false).status ==
            codex::SequenceStatus::Duplicate;
    if ((cycle % 97U) == 0U) {
      sequence += 2;
      sequence_invariant =
          sequence_invariant &&
          window.observe(sequence, true).status ==
              codex::SequenceStatus::Accepted;
    }
  }
  expect(
      sequence_invariant,
      "50,000 sequence cycles preserve duplicate and snapshot-resync rules");
}

}  // namespace

int main() {
  testAnimations();
  testAudioPlans();
  testVoiceActivity();
  testModel();
  testInput();
  testReconnectAndSequence();
  testResources();
  testStressCycles();
  if (failures != 0) {
    std::cerr << failures << " firmware core assertion(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "Firmware core checks passed\n";
  return EXIT_SUCCESS;
}
