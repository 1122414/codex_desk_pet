import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CARE_ACTION_NAMES,
  DEFAULT_CARE_SETTINGS,
  SettingsRepository,
  validateCareSettingsPatch,
} from "../src/server/settings-repository.js";

test("care settings are bounded and partial saves preserve existing values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-settings-"));
  const filePath = path.join(root, "private", "settings.json");
  const repository = new SettingsRepository(filePath);

  const defaults = await repository.load();
  assert.equal(defaults.selectedPetId, "codex-core");
  assert.equal(defaults.care.enabled, true);
  assert.deepEqual(defaults.care.allowedActions, CARE_ACTION_NAMES);

  const saved = await repository.save({
    care: {
      enabled: false,
      observationMinimumMinutes: -10,
      observationMaximumMinutes: 999,
      autoListenSeconds: 2,
      duplicateGuardSeconds: 5_000,
      persona: "  温柔但直接  ",
      allowedActions: ["open_app", "unknown", "open_app"],
      appPresets: [
        { id: "music", label: "网易云", bundleId: "com.netease.163music" },
        { id: "bad id", label: "无效", bundleId: "invalid" },
      ],
      mediaPresets: [
        { id: "focus", label: "专注音乐", url: "https://example.com/focus" },
        { id: "script", label: "无效", url: "javascript:alert(1)" },
      ],
    },
  });
  assert.equal(saved.care.observationMinimumMinutes, 1);
  assert.equal(saved.care.observationMaximumMinutes, 120);
  assert.equal(saved.care.autoListenSeconds, 5);
  assert.equal(saved.care.duplicateGuardSeconds, 600);
  assert.equal(saved.care.persona, "温柔但直接");
  assert.deepEqual(saved.care.allowedActions, ["open_app"]);
  assert.equal(saved.care.appPresets.length, 1);
  assert.equal(saved.care.mediaPresets.length, 1);

  await repository.save({ selectedPetId: "chibi-skadi" });
  const reloaded = await repository.load();
  assert.equal(reloaded.selectedPetId, "chibi-skadi");
  assert.equal(reloaded.care.enabled, false);
  assert.equal(reloaded.care.persona, "温柔但直接");
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), reloaded);
});

test("invalid care setting types fall back to safe defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-desk-settings-defaults-"));
  const repository = new SettingsRepository(path.join(root, "settings.json"));
  const saved = await repository.save({
    care: {
      observationMinimumMinutes: "not-a-number",
      observationMaximumMinutes: null,
      persona: [],
      appPresets: "not-an-array",
      mediaPresets: {},
    },
  });
  assert.equal(
    saved.care.observationMinimumMinutes,
    DEFAULT_CARE_SETTINGS.observationMinimumMinutes,
  );
  assert.equal(
    saved.care.observationMaximumMinutes,
    DEFAULT_CARE_SETTINGS.observationMaximumMinutes,
  );
  assert.equal(saved.care.persona, DEFAULT_CARE_SETTINGS.persona);
  assert.deepEqual(saved.care.appPresets, []);
  assert.deepEqual(saved.care.mediaPresets, []);
});

test("care settings API validation rejects malformed values instead of silently normalizing them", () => {
  const valid = validateCareSettingsPatch({
    observationMinimumMinutes: 3,
    observationMaximumMinutes: 12,
    autoListenSeconds: 18,
    persona: "  简短、自然地陪伴我  ",
    allowedActions: ["open_app", "schedule_follow_up"],
    appPresets: [{
      id: "music",
      label: "音乐",
      bundleId: "com.example.music",
    }],
    mediaPresets: [{
      id: "focus",
      label: "专注",
      url: "https://example.com/focus",
    }],
  });
  assert.equal(valid.persona, "简短、自然地陪伴我");
  assert.equal(valid.autoListenSeconds, 18);
  assert.deepEqual(valid.allowedActions, ["open_app", "schedule_follow_up"]);

  assert.throws(
    () => validateCareSettingsPatch({ observationMinimumMinutes: 30 }, {
      ...DEFAULT_CARE_SETTINGS,
      observationMaximumMinutes: 20,
    }),
    /最短观察间隔/,
  );
  assert.throws(
    () => validateCareSettingsPatch({ autoListenSeconds: "20" }),
    /自动聆听/,
  );
  assert.throws(
    () => validateCareSettingsPatch({ unknown: true }),
    /未知/,
  );
  assert.throws(
    () => validateCareSettingsPatch({
      appPresets: [{
        id: "music",
        label: "音乐",
        bundleId: "com.example.music",
        command: "open anything",
      }],
    }),
    /应用预设/,
  );
  assert.throws(
    () => validateCareSettingsPatch({
      mediaPresets: [{
        id: "script",
        label: "脚本",
        url: "javascript:alert(1)",
      }],
    }),
    /HTTP/,
  );
});
