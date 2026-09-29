import { describe, expect, it } from "vitest";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  createSessionRuntimeObservability,
  type SessionRuntimeReseedDiagnostic,
} from "./runtime-observability.ts";

describe("session runtime observability", () => {
  it("is allocation- and clock-free when the production seam is disabled", () => {
    expect(DISABLED_SESSION_RUNTIME_OBSERVABILITY.enabled).toBe(false);
    expect(DISABLED_SESSION_RUNTIME_OBSERVABILITY.snapshot()).toEqual({
      spans: [],
      droppedSpans: 0,
    });
    expect(DISABLED_SESSION_RUNTIME_OBSERVABILITY.snapshot()).toBe(
      DISABLED_SESSION_RUNTIME_OBSERVABILITY.snapshot(),
    );
    expect(
      DISABLED_SESSION_RUNTIME_OBSERVABILITY.beginTrace("terminal-output", {
        generation: "11111111-1111-4111-8111-111111111111",
        incarnation: "pane:1",
      }),
    ).toBeNull();
  });

  it("retains only the newest deterministic local-clock spans", () => {
    let now = 0;
    const observer = createSessionRuntimeObservability({
      capacity: 2,
      nowMicros: () => (now += 10),
      processId: "daemon:test",
      clockId: "test-monotonic",
      createTraceId: () => "11111111-1111-4111-8111-111111111111",
    });
    const trace = observer.beginTrace("terminal-output", {
      generation: "22222222-2222-4222-8222-222222222222",
      incarnation: "pane:1",
    });
    for (const operation of ["first", "second", "third"]) {
      const start = observer.nowMicros();
      observer.recordSpan("parse", operation, start, observer.nowMicros(), trace);
    }
    expect(observer.snapshot()).toEqual({
      spans: [
        {
          traceId: "11111111-1111-4111-8111-111111111111",
          scenario: "terminal-output",
          authority: {
            generation: "22222222-2222-4222-8222-222222222222",
            incarnation: "pane:1",
          },
          stage: "parse",
          processId: "daemon:test",
          clockId: "test-monotonic",
          clockKind: "performance-now",
          operation: "second",
          startedAtMicros: 30,
          endedAtMicros: 40,
        },
        {
          traceId: "11111111-1111-4111-8111-111111111111",
          scenario: "terminal-output",
          authority: {
            generation: "22222222-2222-4222-8222-222222222222",
            incarnation: "pane:1",
          },
          stage: "parse",
          processId: "daemon:test",
          clockId: "test-monotonic",
          clockKind: "performance-now",
          operation: "third",
          startedAtMicros: 50,
          endedAtMicros: 60,
        },
      ],
      droppedSpans: 1,
    });
    expect(() =>
      observer.beginTrace(
        "terminal-input-to-paint",
        {
          generation: "22222222-2222-4222-8222-222222222222",
          incarnation: null,
        },
        "not-a-uuid",
      ),
    ).toThrow();
  });

  it("retains bounded terminal-delivery resource metrics only when explicitly supplied", () => {
    const observer = createSessionRuntimeObservability({ processId: "daemon:test" });
    observer.recordSpan("transport", "terminal-delivery-encode-enqueue", 10, 20, null, undefined, {
      representationCacheBytes: 1_024,
      rawJournalBytes: 2_048,
      queueDepth: 1,
      maxQueueDepth: 2,
      inFlight: 1,
      inFlightBytes: 512,
      semanticPaneId: "pane:alpha",
      mirrorFlowPhase: "nonconverged",
      mirrorFlowRecoveryOrdinal: 7,
      mirrorPaneIncarnation: 3,
      mirrorOutputOrdinal: 41,
      mirrorRecoveryElapsedMicros: 4_999_000,
      mirrorRecoveryFingerprintExact: false,
      mirrorRecoveryConfirmationOrdinal: 2,
      mirrorFlowFailureReason: "absolute-deadline",
    });
    expect(observer.snapshot().spans).toEqual([
      expect.objectContaining({
        terminalDelivery: {
          representationCacheBytes: 1_024,
          rawJournalBytes: 2_048,
          queueDepth: 1,
          maxQueueDepth: 2,
          inFlight: 1,
          inFlightBytes: 512,
          semanticPaneId: "pane:alpha",
          mirrorFlowPhase: "nonconverged",
          mirrorFlowRecoveryOrdinal: 7,
          mirrorPaneIncarnation: 3,
          mirrorOutputOrdinal: 41,
          mirrorRecoveryElapsedMicros: 4_999_000,
          mirrorRecoveryFingerprintExact: false,
          mirrorRecoveryConfirmationOrdinal: 2,
          mirrorFlowFailureReason: "absolute-deadline",
        },
      }),
    ]);
  });
});

describe("reseed trace diagnostics", () => {
  it("retains a frozen metadata snapshot through the daemon JSONL envelope and ring eviction", () => {
    const lines: string[] = [];
    const observer = createSessionRuntimeObservability({
      capacity: 1,
      processId: "daemon:test",
      onSpan: (span) =>
        lines.push(`${JSON.stringify({ version: 1, type: "performance.stage", ...span })}\n`),
    });
    const diagnostic: {
      -readonly [K in keyof SessionRuntimeReseedDiagnostic]: SessionRuntimeReseedDiagnostic[K];
    } = {
      reason: "lease-crossed",
      stage: "before-commit",
      captureCols: 80,
      captureRows: 24,
      nativeCols: 80,
      nativeRows: 24,
      layoutCols: 80,
      layoutRows: 24,
      currentLayoutCols: 80,
      currentLayoutRows: 24,
      captureLeaseEpoch: 1,
      currentLeaseEpoch: 2,
      captureSubscriptionEpoch: 1,
      currentSubscriptionEpoch: 1,
    };
    const expected = { ...diagnostic };
    observer.recordSpan(
      "reduce",
      "terminal-replica-reseed-retry",
      10,
      10,
      null,
      undefined,
      undefined,
      diagnostic,
    );
    diagnostic.currentLeaseEpoch = 99;
    expect(observer.snapshot().spans[0]?.terminalReseed).toEqual(expected);
    expect(Object.isFrozen(observer.snapshot().spans[0]?.terminalReseed)).toBe(true);
    observer.recordSpan("reduce", "ordinary-operation", 20, 20);
    expect(observer.snapshot().droppedSpans).toBe(1);
    expect(observer.snapshot().spans[0]).not.toHaveProperty("terminalReseed");
    const records = lines
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      version: 1,
      type: "performance.stage",
      terminalReseed: expected,
    });
    expect(Object.keys(records[0].terminalReseed).sort()).toEqual(Object.keys(expected).sort());
    expect(records[1]).not.toHaveProperty("terminalReseed");
  });
});
