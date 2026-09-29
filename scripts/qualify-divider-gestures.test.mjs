import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDividerGeometry,
  qualifyDividerGesture,
  qualifyDividerReports,
  summarizeDividerGestures,
} from "./qualify-divider-gestures.mjs";

const panes = (width = 66) => [
  { semanticPaneId: "left", paneId: "%1", left: 0, top: 1, cols: width, rows: 40, active: true },
  {
    semanticPaneId: "right",
    paneId: "%2",
    left: width + 1,
    top: 1,
    cols: 131 - width,
    rows: 40,
    active: false,
  },
];
const delivery = (action, x) => ({
  version: 1,
  kind: "application-mouse",
  requestedAction: action,
  delivery: "exact-bytes-to-immutable-host-pane-pty",
  paneId: "%9",
  sessionId: "$9",
  target: "%9",
  geometry: { cols: 160, rows: 44 },
  bytesInjected: 12,
  requestedPoint: { x, y: 20 },
});
function fixture() {
  const identity = {
    processId: "opentui:123",
    daemonGeneration: "daemon",
    clientGeneration: 1,
    workspaceName: "fixture",
    rendererEpoch: 1,
    sourceEpoch: 1,
    generation: "generation",
    incarnation: "incarnation",
  };
  const records = [];
  let before = panes();
  const samples = Array.from({ length: 30 }, (_, ordinal) => {
    const cells = 67 + (ordinal % 2);
    const pointerIngress = {
      gestureId: "gesture",
      traceId: `trace-${ordinal}`,
      action: "drag",
      x: 28 + cells,
      y: 20,
      atMicros: 1000 * (ordinal + 1),
    };
    const common = {
      ...identity,
      source: "pointer",
      semanticPaneId: "left",
      axis: "cols",
      beforeCells: before[0].cols,
      requestedCells: cells,
      operationId: `operation-${ordinal}`,
      clockId: "opentui-performance-now",
      monotonicMicros: pointerIngress.atMicros + 500,
      pointerIngress,
      canonicalAfter: { cols: cells, rows: 40 },
      verb: "workspace.pane.resize",
      receiptOutcome: "applied",
      receiptCells: cells,
      layoutCells: cells,
      presentationChanged: true,
      presentationDigest: "a".repeat(64),
      identityLineageExact: true,
      writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
    };
    const phases = ["dispatch", "receipt", "layout", "settled", "fence"].map((phase) => ({
      ...common,
      phase: `pane-resize-${phase}`,
    }));
    records.push(...phases);
    const after = panes(cells);
    const sample = {
      ...identity,
      ordinal,
      semanticPaneId: "left",
      axis: "cols",
      cells,
      traceId: pointerIngress.traceId,
      pointerIngress,
      durationMs: 0.5,
      delivery: delivery("drag", pointerIngress.x),
      dividerEvidence: {
        before,
        after,
        operationId: common.operationId,
        records: phases,
        host: { paneId: "%9", sessionId: "$9", cols: 160, rows: 44 },
      },
    };
    before = after;
    return sample;
  });
  const last = samples.at(-1);
  const releaseRecord = {
    ...records.at(-1),
    phase: "pane-resize-release",
    transactionPhase: "idle",
    pointerIngress: { ...last.pointerIngress, action: "up", traceId: "up" },
  };
  records.push(releaseRecord);
  return {
    keyboard: { tmux: panes() },
    pointerPreviews: samples,
    pointerRelease: {
      operationId: "operation-29",
      tmux: before,
      delivery: delivery("up", last.pointerIngress.x),
      dividerEvidence: { downDelivery: delivery("down", 94), releaseRecord, records },
    },
  };
}

test("parses the complete same-clock gesture and exact two-pane chain", () => {
  const gesture = qualifyDividerGesture(JSON.parse(JSON.stringify(fixture())));
  assert.equal(gesture.sampleCount, 30);
  assert.equal(gesture.durationMs, 0.5);
  assert.equal(gesture.gestureId, "gesture");
});

test("rejects missing, duplicate, superseded, foreign-clock and false geometry evidence", () => {
  for (const mutate of [
    (f) => f.pointerPreviews[0].dividerEvidence.records.pop(),
    (f) =>
      f.pointerPreviews[0].dividerEvidence.records.push(
        f.pointerPreviews[0].dividerEvidence.records[0],
      ),
    (f) =>
      f.pointerPreviews[0].dividerEvidence.records.push({
        ...f.pointerPreviews[0].dividerEvidence.records[0],
        phase: "pane-resize-frame-superseded",
      }),
    (f) => {
      f.pointerPreviews[0].dividerEvidence.records[0].clockId = "browser";
    },
    (f) => {
      f.pointerPreviews[0].dividerEvidence.records[0].processId = "foreign";
    },
    (f) => {
      f.pointerPreviews[0].durationMs = -1;
    },
    (f) => {
      f.pointerPreviews[0].dividerEvidence.after[1].cols++;
    },
    (f) => {
      f.pointerPreviews[0].dividerEvidence.after[1].left++;
    },
    (f) => {
      f.pointerPreviews[0].dividerEvidence.records[3].canonicalAfter.cols++;
    },
    (f) => {
      f.pointerPreviews[0].dividerEvidence.host.cols++;
    },
    (f) => {
      f.pointerPreviews[0].delivery.geometry.rows++;
    },
    (f) => {
      f.pointerPreviews[1].traceId = f.pointerPreviews[0].traceId;
    },
    (f) => {
      f.pointerRelease.dividerEvidence.downDelivery.requestedPoint.x++;
    },
    (f) => {
      f.pointerRelease.dividerEvidence.releaseRecord.pointerIngress.gestureId = "other";
    },
    (f) => {
      f.pointerRelease.dividerEvidence.records.pop();
    },
  ]) {
    const value = JSON.parse(JSON.stringify(fixture()));
    mutate(value);
    assert.throws(() => qualifyDividerGesture(value));
  }
});

test("rejects host resize and no-op as divider reallocation", () => {
  assert.throws(() => assertDividerGeometry(panes(), panes(), "left", 66));
  const after = panes(67);
  after[1].cols++;
  assert.throws(() => assertDividerGeometry(panes(), after, "left", 67));
});

test("requires three independent gestures and uses nearest-rank worst-move p95", () => {
  const gestures = [1, 2, 3].map((gestureId) => ({ gestureId, durationMs: 100 }));
  assert.equal(summarizeDividerGestures(gestures).qualified, true);
  assert.throws(() => summarizeDividerGestures(gestures.slice(1)));
  assert.throws(() => summarizeDividerGestures([gestures[0], gestures[0], gestures[0]]));
  assert.throws(() =>
    summarizeDividerGestures([{ gestureId: 1, durationMs: NaN }, ...gestures.slice(1)]),
  );
  assert.equal(
    summarizeDividerGestures([{ gestureId: 1, durationMs: 100.001 }, ...gestures.slice(1)])
      .qualified,
    false,
  );
  const slow = summarizeDividerGestures([
    { gestureId: 1, durationMs: 250.001 },
    ...gestures.slice(1),
  ]);
  assert.equal(slow.qualified, false);
  assert.equal(slow.maximumMs, 250.001);
});

test("rejects missing provenance, repeated report IDs and failed reports", () => {
  assert.throws(() => qualifyDividerReports([]));
  assert.throws(() => qualifyDividerReports([{}, {}, {}]));
  const reports = [1, 2, 3].map((runId) => ({
    runId,
    repetition: runId,
    repeat: 3,
    status: "failed",
    journey: "keyboard-pointer-resize",
    sourceProvenance: {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      manifestDigest: "c".repeat(64),
    },
  }));
  assert.throws(() => qualifyDividerReports(reports), /failed or mixed-source/u);
});

test("does not aggregate a selected subset of a larger repetition set", () => {
  const reports = [1, 2, 3].map((repetition) => ({
    runId: `run-${repetition}`,
    repetition,
    repeat: 4,
  }));
  assert.throws(() => qualifyDividerReports(reports), /incomplete repetition set/u);
});
