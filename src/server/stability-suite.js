import { DeviceSession } from "./device-session.js";
import { createMemoryTransportPair } from "./transports/memory-transport.js";
import {
  AtomicPetResourceCache,
  createPetResourceManifest,
  createResourceChunks,
} from "../shared/device-protocol.js";

const SECRET = "7".repeat(64);

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Stability invariant failed: ${message}`);
}

async function waitFor(predicate, description, attempts = 1_000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out during stability run: ${description}`);
}

function closeSessions(bridge, device) {
  bridge.close();
  device.close();
}

async function runTransportCycles(connectionCycles, seed) {
  const random = createRandom(seed ^ 0xa5a5a5a5);
  const report = {
    authenticatedConnections: 0,
    transportTransitions: 0,
    usbConnections: 0,
    wifiConnections: 0,
    duplicateDeliveries: 0,
    droppedSnapshotsRecovered: 0,
    reorderedMessagesRecovered: 0,
    droppedAcksRecovered: 0,
    commandsExecuted: 0,
  };
  let previousTransport = null;

  for (let cycle = 0; cycle < connectionCycles; cycle += 1) {
    const transportKind = cycle % 2 === 0 ? "usb" : "wifi";
    const transports = createMemoryTransportPair({ kind: transportKind });
    const clock = { value: 10_000 + (cycle * 100) };
    const snapshots = [];
    let commandExecutions = 0;
    const suffix = String(cycle).padStart(6, "0");
    const bridge = new DeviceSession({
      role: "bridge",
      transport: transports.left,
      secretResolver: (deviceId) => deviceId === "stability-core-s3" ? SECRET : null,
      snapshotProvider: () => ({
        revision: cycle + 1,
        presentation: { state: "running" },
      }),
      commandHandler: async () => {
        commandExecutions += 1;
        report.commandsExecuted += 1;
        return { accepted: true };
      },
      now: () => clock.value,
      nonceFactory: () => `bridge_nonce_${suffix}`,
      retry: { baseRetryMs: 10, maxRetryMs: 40, maxAttempts: 5 },
    });
    const device = new DeviceSession({
      role: "device",
      transport: transports.right,
      deviceId: "stability-core-s3",
      secret: SECRET,
      now: () => clock.value,
      nonceFactory: () => `device_nonce_${suffix}`,
      retry: { baseRetryMs: 10, maxRetryMs: 40, maxAttempts: 5 },
    });
    device.on("snapshot", (snapshot) => snapshots.push(snapshot));

    try {
      bridge.start({ autoTick: false });
      device.start({ autoTick: false });
      await waitFor(
        () => bridge.ready && device.ready && snapshots.length >= 1 &&
          bridge.pendingAcknowledgements === 0 && device.pendingAcknowledgements === 0,
        `initial ${transportKind} authentication ${cycle}`,
      );
      requireCondition(bridge.sessionId === device.sessionId, "session ids diverged");
      report.authenticatedConnections += 1;
      report[transportKind === "usb" ? "usbConnections" : "wifiConnections"] += 1;
      if (previousTransport !== null && previousTransport !== transportKind) {
        report.transportTransitions += 1;
      }
      previousTransport = transportKind;

      const commandId = `stability-command-${suffix}`;
      const sampledFault = cycle < 4
        ? [0, 1, 3, 2][cycle]
        : Math.floor(random() * 4);
      // USB intentionally permits one reliable message in flight, so it cannot
      // reorder reliable frames. Exercise that fault only on the wider Wi-Fi
      // window and use the dropped-ACK case for USB instead.
      const fault =
          sampledFault === 2 && transportKind === "usb" ? 3 : sampledFault;
      switch (fault) {
        case 0: {
          transports.right.duplicateNext();
          device.sendCommand("telemetry.update", {
            batteryPercent: cycle % 101,
            charging: cycle % 2 === 0,
            wifiRssi: -60,
          }, commandId);
          await waitFor(
            () => commandExecutions === 1 &&
              bridge.pendingAcknowledgements === 0 &&
              device.pendingAcknowledgements === 0,
            `duplicate recovery ${cycle}`,
          );
          requireCondition(commandExecutions === 1, "duplicate command executed twice");
          report.duplicateDeliveries += 1;
          break;
        }
        case 1: {
          const revision = 100_000 + cycle;
          transports.left.dropNext();
          bridge.sendSnapshot({ revision, presentation: { state: "reviewing" } });
          clock.value += 20;
          bridge.tick(clock.value);
          await waitFor(
            () => snapshots.some((snapshot) => snapshot.revision === revision) &&
              bridge.pendingAcknowledgements === 0,
            `dropped snapshot recovery ${cycle}`,
          );
          report.droppedSnapshotsRecovered += 1;
          break;
        }
        case 2: {
          const revision = 200_000 + cycle;
          transports.left.holdNext();
          bridge.sendEvent({ event: "stale-before-snapshot", cycle });
          bridge.sendSnapshot({ revision, presentation: { state: "ready" } });
          await waitFor(
            () => snapshots.some((snapshot) => snapshot.revision === revision),
            `out-of-order snapshot recovery ${cycle}`,
          );
          transports.left.flushHeld();
          await waitFor(
            () => bridge.pendingAcknowledgements === 0 &&
              device.pendingAcknowledgements === 0,
            `held message acknowledgement ${cycle}`,
          );
          report.reorderedMessagesRecovered += 1;
          break;
        }
        default: {
          transports.left.dropNext();
          device.sendCommand("telemetry.update", {
            batteryPercent: cycle % 101,
            charging: false,
            wifiRssi: -72,
          }, commandId);
          await waitFor(() => commandExecutions === 1, `command before ACK retry ${cycle}`);
          clock.value += 20;
          device.tick(clock.value);
          bridge.tick(clock.value);
          await waitFor(
            () => device.pendingAcknowledgements === 0 &&
              bridge.pendingAcknowledgements === 0,
            `dropped ACK recovery ${cycle}`,
          );
          requireCondition(commandExecutions === 1, "ACK retry repeated a command");
          report.droppedAcksRecovered += 1;
          break;
        }
      }
    } finally {
      closeSessions(bridge, device);
    }
  }
  return report;
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [result[index], result[replacement]] = [result[replacement], result[index]];
  }
  return result;
}

function runResourceCycles(resourceCycles, seed) {
  const random = createRandom(seed);
  const cache = new AtomicPetResourceCache();
  const pet = {
    id: "stability-pet",
    displayName: "Stability Pet",
    description: "Deterministic fault-injection fixture",
    spriteVersionNumber: 2,
  };
  let installedData = Buffer.from("stable-baseline");
  const baseline = createPetResourceManifest(pet, installedData);
  cache.begin(baseline);
  for (const chunk of createResourceChunks(baseline, installedData, 4)) {
    cache.acceptChunk(chunk);
  }
  cache.commit(pet.id, baseline.sha256);

  const report = {
    interruptedTransfersRecovered: 0,
    corruptChunksRejected: 0,
    incompleteCommitsPreserved: 0,
    duplicateChunksAcceptedOnce: 0,
  };

  for (let cycle = 0; cycle < resourceCycles; cycle += 1) {
    const bytes = 2_048 + Math.floor(random() * 2_048);
    const replacement = Buffer.allocUnsafe(bytes);
    for (let index = 0; index < replacement.length; index += 1) {
      replacement[index] = Math.floor(random() * 256);
    }
    const manifest = createPetResourceManifest(pet, replacement);
    const chunks = shuffled(createResourceChunks(manifest, replacement, 257), random);
    cache.begin(manifest);

    const corruptBytes = Buffer.from(chunks[0].data, "base64");
    corruptBytes[0] ^= 0xff;
    let corruptRejected = false;
    try {
      cache.acceptChunk({ ...chunks[0], data: corruptBytes.toString("base64") });
    } catch (error) {
      corruptRejected = error?.code === "CHUNK_CHECKSUM_FAILED";
    }
    requireCondition(corruptRejected, "corrupt resource chunk was accepted");
    report.corruptChunksRejected += 1;

    for (let index = 0; index < chunks.length - 1; index += 1) {
      if (random() < 0.48) {
        const accepted = cache.acceptChunk(chunks[index]);
        if (accepted.accepted && random() < 0.2) {
          const duplicate = cache.acceptChunk(chunks[index]);
          requireCondition(duplicate.duplicate, "exact duplicate chunk was not idempotent");
          report.duplicateChunksAcceptedOnce += 1;
        }
      }
    }

    let incompleteRejected = false;
    try {
      cache.commit(pet.id, manifest.sha256);
    } catch (error) {
      incompleteRejected = error?.code === "TRANSFER_INCOMPLETE";
    }
    requireCondition(incompleteRejected, "incomplete resource committed");
    requireCondition(
      cache.get(pet.id).data.equals(installedData),
      "interrupted resource replaced the installed Pet",
    );
    report.incompleteCommitsPreserved += 1;

    const resume = cache.begin(manifest);
    requireCondition(
      resume.sha256 === manifest.sha256 && resume.missingRanges.length > 0,
      "resource resume state was lost",
    );
    const missing = shuffled(
      createResourceChunks(manifest, replacement, 257, resume.missingRanges),
      random,
    );
    for (const chunk of missing) cache.acceptChunk(chunk);
    cache.commit(pet.id, manifest.sha256);
    requireCondition(
      cache.get(pet.id).data.equals(replacement),
      "resumed resource bytes differ from the source",
    );
    installedData = replacement;
    report.interruptedTransfersRecovered += 1;
  }
  return report;
}

export async function runStabilitySuite({
  connectionCycles = 501,
  resourceCycles = 250,
  seed = 0x5eedc0de,
} = {}) {
  if (!Number.isInteger(connectionCycles) || connectionCycles < 2) {
    throw new RangeError("connectionCycles must be at least 2");
  }
  if (!Number.isInteger(resourceCycles) || resourceCycles < 1) {
    throw new RangeError("resourceCycles must be positive");
  }
  const startedAt = Date.now();
  const transport = await runTransportCycles(connectionCycles, seed);
  const resources = runResourceCycles(resourceCycles, seed);
  return {
    seed,
    durationMs: Date.now() - startedAt,
    transport,
    resources,
  };
}
