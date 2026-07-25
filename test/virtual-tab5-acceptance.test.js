import test from "node:test";
import assert from "node:assert/strict";
import { verifyVirtualTab5 } from "../scripts/verify-virtual-tab5.mjs";

test("virtual Tab5 completes pairing, encrypted dual-link operation, and approval", async () => {
  const report = await verifyVirtualTab5();
  assert.deepEqual(report, {
    pairing: "single-use-usb",
    authenticated: true,
    encryptedSession: true,
    transportsBeforeUsbDisconnect: ["usb", "wifi"],
    primaryTransportAfterUsbDisconnect: "wifi",
    telemetry: {
      batteryPercent: 73,
      charging: true,
    },
    petSelection: "codex-core",
    previewAnimation: "review",
    approvalDecision: "decline",
    credentialsIsolated: true,
  });
});
