import assert from "node:assert/strict";

/** Existing opt-in daemon trace; never interprets diagnostic timestamps as latency. */
export function inspectCoherenceTrace(text, { clients, finalHash = null, complete = false }) {
  assert(Number.isSafeInteger(clients) && clients > 0);
  assert(Buffer.byteLength(text) <= 64 * 1024 * 1024, "Qualification trace exceeds bound");
  const end = text.lastIndexOf("\n");
  if (complete) assert.equal(end, text.length - 1, "Truncated final trace");
  const lines = end < 0 ? [] : text.slice(0, end).split("\n").filter(Boolean);
  const maxima = {
    maxQueueDepth: 0,
    queueDepth: 0,
    rawJournalBytes: 0,
    representationCacheBytes: 0,
    inFlight: 0,
  };
  const limits = {
    maxQueueDepth: 2,
    queueDepth: clients * 2,
    rawJournalBytes: 4 * 1024 * 1024,
    representationCacheBytes: 16 * 1024 * 1024,
    inFlight: clients,
  };
  const settled = new Set();
  let samples = 0;
  let settledWithoutFlights = false;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "performance.stage") continue;
    assert.notEqual(event.operation, "terminal-delivery-fault", "Daemon reported a delivery fault");
    if (
      !["terminal-delivery-encode-enqueue", "terminal-delivery-settled"].includes(event.operation)
    )
      continue;
    const metrics = event.terminalDelivery;
    assert(metrics && typeof metrics === "object", "Missing delivery metrics");
    for (const key of Object.keys(limits)) {
      assert(Number.isSafeInteger(metrics[key]) && metrics[key] >= 0, `Invalid ${key}`);
      assert(metrics[key] <= limits[key], `${key} exceeds qualification bound`);
      maxima[key] = Math.max(maxima[key], metrics[key]);
    }
    samples++;
    if (
      event.operation === "terminal-delivery-settled" &&
      finalHash !== null &&
      metrics.canonicalStateHash === finalHash
    ) {
      assert(typeof metrics.deliveryClientId === "string" && metrics.deliveryClientId.length > 0);
      settled.add(metrics.deliveryClientId);
      if (metrics.inFlight === 0 && metrics.queueDepth === 0) settledWithoutFlights = true;
    }
  }
  assert(samples > 0, "No delivery metric samples");
  if (complete) {
    assert(finalHash, "Final hash required for complete proof");
    assert.equal(settled.size, clients, "Not all clients have a verified final settlement trace");
    assert(settledWithoutFlights, "No quiescent final settlement trace");
  }
  return { samples, maxima, finalSettledClients: settled.size, settledWithoutFlights };
}
