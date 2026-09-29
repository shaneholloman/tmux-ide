import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCoherenceTrace } from "./coherence-trace.mjs";

const event = (id, overrides = {}) => ({
  type: "performance.stage",
  operation: "terminal-delivery-settled",
  terminalDelivery: {
    maxQueueDepth: 2,
    queueDepth: 0,
    rawJournalBytes: 42,
    representationCacheBytes: 100,
    inFlight: 0,
    canonicalStateHash: "final",
    deliveryClientId: id,
    ...overrides,
  },
});
const trace = (...events) => events.map((value) => JSON.stringify(value) + "\n").join("");
const options = { clients: 2, finalHash: "final", complete: true };

test("requires distinct final settlements, not repeated ACKs from one viewer", () => {
  assert.equal(
    inspectCoherenceTrace(trace(event("a"), event("b")), options).finalSettledClients,
    2,
  );
  assert.throws(() => inspectCoherenceTrace(trace(event("a"), event("a")), options));
  assert.throws(() =>
    inspectCoherenceTrace(trace(event("a"), event("b", { canonicalStateHash: "old" })), options),
  );
});
test("rejects exceeded bounds, missing metrics, faults and unfinished final writes", () => {
  for (const overrides of [
    { maxQueueDepth: 3 },
    { representationCacheBytes: 16777217 },
    { rawJournalBytes: -1 },
    { inFlight: 3 },
    { queueDepth: undefined },
  ])
    assert.throws(() => inspectCoherenceTrace(trace(event("a"), event("b", overrides)), options));
  assert.throws(() =>
    inspectCoherenceTrace(
      trace(event("a"), event("b"), {
        type: "performance.stage",
        operation: "terminal-delivery-fault",
      }),
      options,
    ),
  );
  assert.throws(() => inspectCoherenceTrace(trace(event("a"), event("b")).trimEnd(), options));
});
test("intermediate checkpoint ignores only an unfinished final line", () => {
  assert.equal(inspectCoherenceTrace(trace(event("a")) + '{"type":', { clients: 2 }).samples, 1);
  assert.throws(() => inspectCoherenceTrace("invalid\n", { clients: 2 }));
  assert.throws(() => inspectCoherenceTrace("", { clients: 2 }));
});
