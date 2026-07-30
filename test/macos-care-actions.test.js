import test from "node:test";
import assert from "node:assert/strict";
import { MacosCareActions } from "../src/server/macos-care-actions.js";

function fixture() {
  const calls = [];
  const settings = {
    load: async () => ({
      care: {
        appPresets: [{
          id: "netease-music",
          label: "网易云音乐",
          bundleId: "com.netease.163music",
        }],
        mediaPresets: [{
          id: "focus-music",
          label: "专注音乐",
          url: "https://music.example/focus",
        }],
      },
    }),
  };
  const actions = new MacosCareActions({
    settings,
    platform: "darwin",
    runProcess: async (executable, args) => {
      calls.push({ executable, args });
      return executable === "/usr/bin/osascript" &&
          args[1] === "output volume of (get volume settings)"
        ? { stdout: "37\n" }
        : { stdout: "" };
    },
  });
  return { actions, calls };
}

test("macOS actions open only configured bundle ids and media URLs", async () => {
  const { actions, calls } = fixture();
  assert.equal((await actions.openApp("netease-music")).presetId, "netease-music");
  assert.equal((await actions.openMediaPreset("focus-music")).presetId, "focus-music");
  assert.deepEqual(calls, [
    {
      executable: "/usr/bin/open",
      args: ["-b", "com.netease.163music"],
    },
    {
      executable: "/usr/bin/open",
      args: ["https://music.example/focus"],
    },
  ]);

  await assert.rejects(() => actions.openApp("unlisted-app"), /不存在|未获允许/);
  await assert.rejects(
    () => actions.openMediaPreset("https://untrusted.example"),
    /预设编号/,
  );
  assert.equal(calls.length, 2);
});

test("macOS volume uses a fixed AppleScript template with a bounded integer", async () => {
  const { actions, calls } = fixture();
  assert.deepEqual(await actions.setVolume(25), {
    message: "Mac 音量已调整",
    value: 25,
    previousValue: 37,
  });
  assert.deepEqual(calls, [
    {
      executable: "/usr/bin/osascript",
      args: ["-e", "output volume of (get volume settings)"],
    },
    {
      executable: "/usr/bin/osascript",
      args: ["-e", "set volume output volume 25"],
    },
  ]);
  await assert.rejects(() => actions.setVolume(101), /0～100/);
  assert.equal(calls.length, 2);
});
