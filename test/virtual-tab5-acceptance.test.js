import test from "node:test";
import assert from "node:assert/strict";
import { verifyVirtualTab5 } from "../scripts/verify-virtual-tab5.mjs";

test("virtual Tab5 completes pairing, encrypted dual-link operation, full V2 Pet install, and approval", async () => {
  const report = await verifyVirtualTab5();
  assert.deepEqual({
    ...report,
    customPetResource: {
      ...report.customPetResource,
      sha256: "<sha256>",
    },
  }, {
    pairing: "single-use-usb",
    authenticated: true,
    encryptedSession: true,
    transportsBeforeUsbDisconnect: ["usb", "wifi"],
    primaryTransportAfterUsbDisconnect: "wifi",
    telemetry: {
      batteryPercent: 73,
      charging: true,
    },
    petSelection: "virtual-pet",
    customPetResource: {
      bytes: 28_114_944,
      sha256: "<sha256>",
      installedOver: "wifi",
    },
    previewAnimation: "review",
    approvalDecision: "decline",
    credentialsIsolated: true,
    care: {
      scheduledObservation: true,
      openingText: "你看起来还在忙，要不要和我说说？",
      automaticTtsCompletions: 3,
      voiceRounds: 3,
      sharedCareThread: true,
      actions: {
        openedAppOnce: true,
        brightnessSetOnce: true,
        followUpMinutes: 7,
      },
      transportSwitch: "usb-to-wifi",
      duplicateCaptureSuppressed: true,
      duplicateActionSuppressed: true,
      invalidJsonRecovered: true,
      codexReconnectRecovered: true,
      interruptedImageRecovered: true,
      eventCount: report.care.eventCount,
    },
  });
  assert.match(report.customPetResource.sha256, /^[a-f0-9]{64}$/);
  assert.ok(report.care.eventCount >= 10);
});
