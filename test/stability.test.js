import test from "node:test";
import assert from "node:assert/strict";
import { runStabilitySuite } from "../src/server/stability-suite.js";

test("500 USB/Wi-Fi transitions survive deterministic protocol and resource faults", async () => {
  const report = await runStabilitySuite();
  assert.equal(report.transport.authenticatedConnections, 501);
  assert.equal(report.transport.transportTransitions, 500);
  assert.equal(report.transport.usbConnections, 251);
  assert.equal(report.transport.wifiConnections, 250);
  assert.equal(
    report.transport.duplicateDeliveries +
      report.transport.droppedSnapshotsRecovered +
      report.transport.reorderedMessagesRecovered +
      report.transport.droppedAcksRecovered,
    501,
  );
  assert.equal(report.resources.interruptedTransfersRecovered, 250);
  assert.equal(report.resources.corruptChunksRejected, 250);
  assert.equal(report.resources.incompleteCommitsPreserved, 250);
});
