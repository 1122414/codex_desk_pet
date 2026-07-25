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
  });
  assert.match(report.customPetResource.sha256, /^[a-f0-9]{64}$/);
});
