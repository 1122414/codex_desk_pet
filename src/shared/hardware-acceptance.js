const TARGET_BOARD_ID = "m5stack-tab5-k145";
const TARGET_FIRMWARE_VERSION = "0.3.0";
const TARGET_PROTOCOL_VERSION = 5;
const BUSY_CARE_STATES = new Set([
  "observing",
  "thinking",
  "speaking",
  "listening",
  "acting",
]);
const REQUIRED_ACTION_GROUPS = Object.freeze([
  Object.freeze(["set_tab5_brightness"]),
  Object.freeze(["set_tab5_volume"]),
  Object.freeze(["set_macos_volume"]),
  Object.freeze(["open_app", "open_media_preset"]),
  Object.freeze(["capture_now"]),
  Object.freeze(["schedule_follow_up"]),
]);

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function boundedText(value, maximum = 500) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeStatus(value) {
  return {
    status: boundedText(value?.status, 64) || null,
    error: boundedText(value?.error, 500) || null,
  };
}

function selectedDevice(devices, deviceId) {
  if (!Array.isArray(devices)) return null;
  return devices.find((device) => device?.deviceId === deviceId) ??
    devices.find((device) =>
      device?.connected && device?.deviceInfo?.boardId === TARGET_BOARD_ID) ??
    devices.find((device) => device?.deviceInfo?.boardId === TARGET_BOARD_ID) ??
    null;
}

export function createHardwareAcceptanceRecord({
  startedAt = Date.now(),
  durationHours = 24,
  sampleIntervalSeconds = 30,
  deviceId = null,
  requireWifiReconnect = true,
} = {}) {
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new RangeError("验收开始时间无效");
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 168) {
    throw new RangeError("验收时长必须大于 0 且不超过 168 小时");
  }
  if (
    !Number.isInteger(sampleIntervalSeconds) ||
    sampleIntervalSeconds < 1 ||
    sampleIntervalSeconds > 3_600
  ) {
    throw new RangeError("采样间隔必须是 1～3600 秒");
  }
  if (
    deviceId !== null &&
    (typeof deviceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(deviceId))
  ) {
    throw new TypeError("验收设备 ID 无效");
  }
  return {
    schemaVersion: 1,
    startedAt: Math.floor(startedAt),
    targetDurationMs: Math.round(durationHours * 60 * 60 * 1_000),
    sampleIntervalMs: sampleIntervalSeconds * 1_000,
    deviceId,
    criteria: {
      requireWifiReconnect: Boolean(requireWifiReconnect),
      maximumBusyStateMs: 10 * 60 * 1_000,
      maximumRssGrowthBytes: 32 * 1024 * 1024,
    },
    samples: [],
    events: [],
    trigger: null,
    report: null,
  };
}

export function normalizeHardwareAcceptanceSample({
  occurredAt = Date.now(),
  snapshot,
  diagnostics,
  devices,
  deviceId = null,
  error = null,
} = {}) {
  const device = selectedDevice(devices, deviceId);
  const telemetry = snapshot?.telemetry ?? {};
  const runtimeMemory = diagnostics?.runtime?.memory ?? {};
  return {
    occurredAt: Math.floor(occurredAt),
    error: boundedText(error?.message ?? error, 500) || null,
    bridge: {
      version: boundedText(diagnostics?.bridgeVersion, 32) || null,
      codexConnected: diagnostics?.codex?.connected === true,
      uptimeSeconds: finite(diagnostics?.runtime?.uptimeSeconds),
      rssBytes: finite(runtimeMemory.rssBytes),
      heapUsedBytes: finite(runtimeMemory.heapUsedBytes),
    },
    target: {
      boardId: boundedText(diagnostics?.target?.boardId, 64) || null,
      protocolVersion: finite(diagnostics?.target?.protocolVersion),
      minimumFirmwareVersion:
        boundedText(diagnostics?.target?.minimumFirmwareVersion, 32) || null,
    },
    device: device ? {
      deviceId: boundedText(device.deviceId, 64) || null,
      connected: device.connected === true,
      transports: Array.isArray(device.transports)
        ? device.transports.filter((value) => typeof value === "string").slice(0, 4)
        : [],
      primaryTransport: boundedText(device.primaryTransport, 16) || null,
      protocolVersion: finite(device.protocolVersion),
      boardId: boundedText(device.deviceInfo?.boardId, 64) || null,
      firmwareVersion: boundedText(device.deviceInfo?.firmwareVersion, 32) || null,
      compatible: device.compatibility?.compatible === true,
    } : null,
    care: {
      ...normalizeStatus(snapshot?.care),
      conversationId: boundedText(snapshot?.care?.conversationId, 128) || null,
      lastObservationAt: finite(snapshot?.care?.lastObservationAt),
      nextObservationAt: finite(snapshot?.care?.nextObservationAt),
    },
    voice: normalizeStatus(snapshot?.voice),
    vision: normalizeStatus(snapshot?.vision),
    telemetry: {
      deviceId: boundedText(telemetry.deviceId, 64) || null,
      batteryPercent: finite(telemetry.batteryPercent),
      charging: telemetry.charging === true,
      wifiRssi: finite(telemetry.wifiRssi),
      temperatureC: finite(telemetry.temperatureC),
      transport: boundedText(telemetry.transport, 16) || null,
      lastSeenAt: finite(telemetry.lastSeenAt),
    },
  };
}

function eventKey(event) {
  return typeof event?.id === "string" && event.id
    ? event.id
    : `${event?.type}:${event?.occurredAt}:${event?.conversationId}:${event?.summary}`;
}

export function mergeHardwareAcceptanceEvents(record, events) {
  const known = new Set(record.events.map(eventKey));
  for (const event of Array.isArray(events) ? events : []) {
    if (
      !event ||
      typeof event !== "object" ||
      !Number.isFinite(event.occurredAt) ||
      typeof event.type !== "string"
    ) {
      continue;
    }
    const key = eventKey(event);
    if (known.has(key)) continue;
    known.add(key);
    record.events.push(structuredClone(event));
  }
  record.events.sort((left, right) => left.occurredAt - right.occurredAt);
  return record;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function memoryTrend(samples) {
  const values = samples
    .filter((sample) => Number.isFinite(sample.bridge?.rssBytes))
    .map((sample) => sample.bridge.rssBytes);
  if (!values.length) return {
    samples: 0,
    minimumBytes: null,
    maximumBytes: null,
    growthBytes: null,
  };
  const window = Math.max(1, Math.ceil(values.length * 0.1));
  return {
    samples: values.length,
    minimumBytes: Math.min(...values),
    maximumBytes: Math.max(...values),
    growthBytes: Math.round(
      average(values.slice(-window)) - average(values.slice(0, window)),
    ),
  };
}

function statusRuns(samples) {
  const runs = [];
  let current = null;
  for (const sample of samples) {
    const status = sample.care?.status;
    if (!BUSY_CARE_STATES.has(status)) {
      current = null;
      continue;
    }
    if (current?.status === status) {
      current.endedAt = sample.occurredAt;
      continue;
    }
    current = {
      status,
      startedAt: sample.occurredAt,
      endedAt: sample.occurredAt,
    };
    runs.push(current);
  }
  return runs.map((run) => ({
    ...run,
    durationMs: Math.max(0, run.endedAt - run.startedAt),
  }));
}

function duplicateActions(events) {
  const recent = new Map();
  const duplicates = [];
  for (const event of events.filter((candidate) => candidate.type === "action.requested")) {
    const key = JSON.stringify([
      event.conversationId ?? null,
      event.summary ?? null,
      event.data ?? null,
    ]);
    const previous = recent.get(key);
    if (Number.isFinite(previous) && event.occurredAt - previous <= 5_000) {
      duplicates.push({
        action: event.summary ?? null,
        previousAt: previous,
        occurredAt: event.occurredAt,
      });
    }
    recent.set(key, event.occurredAt);
  }
  return duplicates;
}

function conversationEvidence(events) {
  const conversations = new Map();
  for (const event of events) {
    if (typeof event.conversationId !== "string" || !event.conversationId) continue;
    const evidence = conversations.get(event.conversationId) ?? {
      conversationId: event.conversationId,
      observations: 0,
      userReplies: 0,
      assistantReplies: 0,
    };
    if (event.type === "observation.completed") evidence.observations += 1;
    if (event.type === "conversation.user_reply") evidence.userReplies += 1;
    if (event.type === "conversation.assistant_reply") evidence.assistantReplies += 1;
    conversations.set(event.conversationId, evidence);
  }
  return [...conversations.values()]
    .sort((left, right) => right.userReplies - left.userReplies);
}

function connectionEvidence(samples, events) {
  let sampledReconnects = 0;
  let sampledWifiReconnects = 0;
  let previouslyConnected = null;
  let previousWifi = null;
  for (const sample of samples) {
    const connected = sample.device?.connected === true;
    const wifi = connected && sample.device?.transports?.includes("wifi");
    if (previouslyConnected === false && connected) sampledReconnects += 1;
    if (previousWifi === false && wifi) sampledWifiReconnects += 1;
    previouslyConnected = connected;
    previousWifi = wifi;
  }
  const deviceEvents = events.filter((event) =>
    event.type === "device.connected" || event.type === "device.disconnected");
  let eventReconnects = 0;
  let eventWifiReconnects = 0;
  const disconnected = new Set();
  for (const event of deviceEvents) {
    const transport = event.data?.transport ?? "unknown";
    const key = `${event.deviceId ?? "unknown"}:${transport}`;
    if (event.type === "device.disconnected") {
      disconnected.add(key);
      continue;
    }
    if (disconnected.delete(key)) {
      eventReconnects += 1;
      if (transport === "wifi") eventWifiReconnects += 1;
    }
  }
  return deviceEvents.length
    ? { reconnects: eventReconnects, wifiReconnects: eventWifiReconnects }
    : { reconnects: sampledReconnects, wifiReconnects: sampledWifiReconnects };
}

function check(ok, evidence) {
  return { ok: Boolean(ok), evidence };
}

export function analyzeHardwareAcceptance(record, {
  requiredDurationMs = record?.targetDurationMs,
} = {}) {
  if (!record || record.schemaVersion !== 1) {
    throw new Error("真机验收记录格式不受支持");
  }
  const samples = [...record.samples]
    .filter((sample) => Number.isFinite(sample?.occurredAt))
    .sort((left, right) => left.occurredAt - right.occurredAt);
  const events = record.events.filter((event) =>
    event.occurredAt >= record.startedAt &&
    (!samples.length || event.occurredAt <= samples.at(-1).occurredAt));
  const successful = samples.filter((sample) => !sample.error);
  const deviceSamples = successful.filter((sample) => sample.device);
  const connectedSamples = deviceSamples.filter((sample) => sample.device.connected);
  const firstAt = samples[0]?.occurredAt ?? record.startedAt;
  const lastAt = samples.at(-1)?.occurredAt ?? record.startedAt;
  const durationMs = Math.max(0, lastAt - firstAt);
  const expectedSamples = Math.max(
    1,
    Math.floor(durationMs / record.sampleIntervalMs) + 1,
  );
  const samplingCoverage = Math.min(1, samples.length / expectedSamples);
  const conversations = conversationEvidence(events);
  const bestConversation = conversations[0] ?? null;
  const actions = events
    .filter((event) => event.type === "action.completed")
    .map((event) => ({
      name: event.data?.action ?? event.summary ?? null,
      ok: event.data?.ok === true,
      occurredAt: event.occurredAt,
    }));
  const completedActionNames = new Set(
    actions.filter((action) => action.ok).map((action) => action.name),
  );
  const missingActionGroups = REQUIRED_ACTION_GROUPS
    .filter((group) => !group.some((name) => completedActionNames.has(name)));
  const duplicates = duplicateActions(events);
  const memory = memoryTrend(successful);
  const runs = statusRuns(successful);
  const stuckRuns = runs.filter((run) =>
    run.durationMs > record.criteria.maximumBusyStateMs);
  const connections = connectionEvidence(samples, events);
  const lastSuccessful = successful.at(-1) ?? null;
  const temperatures = connectedSamples
    .map((sample) => sample.telemetry?.temperatureC)
    .filter(Number.isFinite);
  const batteries = connectedSamples
    .map((sample) => sample.telemetry?.batteryPercent)
    .filter(Number.isFinite);
  const scheduledObservations = events.filter((event) =>
    event.type === "observation.requested" &&
    event.data?.reason === "scheduled").length;
  const observationFailures = events.filter((event) =>
    event.type === "observation.failed").length;
  const lastObservationFailureAt = events
    .filter((event) => event.type === "observation.failed")
    .at(-1)?.occurredAt ?? null;
  const observationRecovered = lastObservationFailureAt === null ||
    events.some((event) =>
      event.type === "observation.completed" &&
      event.occurredAt > lastObservationFailureAt);
  const terminalErrors = ["care", "voice", "vision"]
    .filter((name) => lastSuccessful?.[name]?.status === "failed")
    .map((name) => ({
      subsystem: name,
      error: lastSuccessful[name].error,
    }));
  const reachableRatio = samples.length ? successful.length / samples.length : 0;
  const compatible = connectedSamples.some((sample) =>
    sample.device.boardId === TARGET_BOARD_ID &&
    sample.device.firmwareVersion === TARGET_FIRMWARE_VERSION &&
    sample.device.protocolVersion === TARGET_PROTOCOL_VERSION &&
    sample.device.compatible);
  const memoryStable = (
    memory.samples >= 2 &&
    memory.growthBytes <= record.criteria.maximumRssGrowthBytes
  );
  const checks = {
    duration: check(
      durationMs >= requiredDurationMs - record.sampleIntervalMs,
      { durationMs, requiredDurationMs },
    ),
    bridgeReachability: check(
      reachableRatio >= 0.95 && samplingCoverage >= 0.95,
      {
        successfulSamples: successful.length,
        totalSamples: samples.length,
        expectedSamples,
        reachableRatio,
        samplingCoverage,
      },
    ),
    compatibleDevice: check(compatible, {
      expectedBoardId: TARGET_BOARD_ID,
      expectedFirmwareVersion: TARGET_FIRMWARE_VERSION,
      expectedProtocolVersion: TARGET_PROTOCOL_VERSION,
    }),
    finalDeviceConnected: check(
      samples.at(-1) === lastSuccessful &&
      lastSuccessful?.device?.connected === true,
      samples.at(-1)?.device ?? null,
    ),
    codexConnected: check(
      successful.length > 0 &&
      successful.filter((sample) => sample.bridge.codexConnected).length /
        successful.length >= 0.95,
      {
        connectedSamples: successful.filter((sample) =>
          sample.bridge.codexConnected).length,
        totalSamples: successful.length,
      },
    ),
    scheduledObservation: check(
      scheduledObservations >= 1,
      { scheduledObservations },
    ),
    fiveRoundConversation: check(
      bestConversation?.userReplies >= 5 &&
      bestConversation?.assistantReplies >= 5,
      bestConversation,
    ),
    requiredActions: check(
      missingActionGroups.length === 0,
      {
        completed: [...completedActionNames].sort(),
        missingGroups: missingActionGroups,
      },
    ),
    noFailedActions: check(
      actions.every((action) => action.ok),
      { failed: actions.filter((action) => !action.ok) },
    ),
    noDuplicateActions: check(duplicates.length === 0, { duplicates }),
    noBusyLoop: check(stuckRuns.length === 0, { stuckRuns }),
    recoveredFinalState: check(
      terminalErrors.length === 0 && observationRecovered,
      { observationFailures, observationRecovered, terminalErrors },
    ),
    memoryStable: check(memoryStable, {
      ...memory,
      maximumGrowthBytes: record.criteria.maximumRssGrowthBytes,
    }),
    temperatureRecorded: check(temperatures.length > 0, {
      samples: temperatures.length,
      minimumC: temperatures.length ? Math.min(...temperatures) : null,
      maximumC: temperatures.length ? Math.max(...temperatures) : null,
    }),
    batteryRecorded: check(batteries.length > 0, {
      samples: batteries.length,
      minimumPercent: batteries.length ? Math.min(...batteries) : null,
      maximumPercent: batteries.length ? Math.max(...batteries) : null,
    }),
    wifiReconnect: check(
      !record.criteria.requireWifiReconnect || connections.wifiReconnects >= 1,
      {
        required: record.criteria.requireWifiReconnect,
        ...connections,
      },
    ),
  };
  return {
    generatedAt: Date.now(),
    passed: Object.values(checks).every((result) => result.ok),
    checks,
    summary: {
      durationMs,
      samples: samples.length,
      careEvents: events.length,
      conversations,
      actions,
      scheduledObservations,
      observationFailures,
      ...connections,
    },
  };
}
