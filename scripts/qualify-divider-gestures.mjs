#!/usr/bin/env node
// Source-only/offline mode. Generate three independent owned gestures first:
// TMUX_IDE_PRODUCT_RIG_DIR=<private-absolute-dir> \
// TMUX_IDE_PRODUCT_DIAGNOSTIC_DIR=<private-absolute-dir> \
// pnpm product:testdrive diagnose --journey keyboard-pointer-resize --repeat 3 --json
// Then: node scripts/qualify-divider-gestures.mjs <run1/report.json> <run2/report.json> <run3/report.json>
// Prerequisites: clean frozen source/build manifest, built TUI/native artifacts,
// installed workspace deps and Chromium (existing journey verifies Web correlation).
// Retain ProductRig sealed bundles/cleanup receipts and exact executable hashes.
// Web correlation is not browser pointer timing. This command launches no runtime.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assessProductKeyboardPointerResize,
  exactFinalResizeOperation,
  exactResizeFence,
} from "./lib/product-keyboard-pointer-resize.mjs";

function requireProof(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertDividerGeometry(before, after, target, cells) {
  requireProof(
    Array.isArray(before) && Array.isArray(after) && before.length === 2 && after.length === 2,
    "divider requires exactly two panes",
  );
  const [left, right] = [...before].sort((a, b) => a.left - b.left);
  const [nextLeft, nextRight] = [...after].sort((a, b) => a.left - b.left);
  for (const pane of [...before, ...after]) {
    requireProof(
      [pane.left, pane.top, pane.cols, pane.rows].every(Number.isSafeInteger) &&
        pane.left >= 0 &&
        pane.top >= 0 &&
        pane.cols > 0 &&
        pane.rows > 0,
      "invalid pane geometry",
    );
  }
  requireProof(
    left.semanticPaneId === target &&
      left.semanticPaneId !== right.semanticPaneId &&
      left.paneId !== right.paneId,
    "target must be the exact left divider pane",
  );
  const delta = cells - left.cols;
  requireProof(
    Number.isSafeInteger(delta) &&
      delta !== 0 &&
      nextLeft.cols === cells &&
      nextLeft.left === left.left &&
      nextRight.left === right.left + delta &&
      nextRight.cols === right.cols - delta &&
      right.left === left.left + left.cols + 1 &&
      nextRight.left === nextLeft.left + nextLeft.cols + 1,
    "sibling reallocation/adjacency is not exact",
  );
  for (const [prior, next] of [
    [left, nextLeft],
    [right, nextRight],
  ]) {
    requireProof(
      ["semanticPaneId", "paneId", "top", "rows", "active"].every(
        (key) => prior[key] === next[key],
      ),
      "pane identity or outer geometry changed",
    );
  }
  requireProof(
    left.top === right.top && left.rows === right.rows,
    "panes do not share divider span",
  );
}

function assertHosted(delivery, action, anchor) {
  requireProof(
    delivery?.version === 1 &&
      delivery.kind === "application-mouse" &&
      delivery.delivery === "exact-bytes-to-immutable-host-pane-pty" &&
      delivery.requestedAction === action &&
      delivery.paneId === anchor.paneId &&
      delivery.sessionId === anchor.sessionId &&
      delivery.target === anchor.paneId &&
      delivery.geometry?.cols === 160 &&
      delivery.geometry?.rows === 44 &&
      Number.isSafeInteger(delivery.bytesInjected) &&
      delivery.bytesInjected > 0,
    "mouse delivery or fixed host geometry changed",
  );
}

export function qualifyDividerGesture(evidence) {
  const samples = evidence.pointerPreviews;
  requireProof(
    Array.isArray(samples) && samples.length >= 30 && samples.length <= 512,
    "missing bounded pointer samples",
  );
  const release = evidence.pointerRelease;
  const raw = release?.dividerEvidence;
  const down = raw?.downDelivery;
  requireProof(
    down && raw.releaseRecord && Array.isArray(raw.records),
    "missing press/release evidence",
  );
  assertHosted(down, "down", down);
  assertHosted(release.delivery, "up", down);
  const gestureId = samples[0]?.pointerIngress?.gestureId;
  requireProof(typeof gestureId === "string" && gestureId.length > 0, "missing gesture identity");
  const traces = new Set();
  let previous = evidence.keyboard.tmux;
  const durations = [];
  for (const sample of samples) {
    requireProof(
      sample.pointerIngress?.gestureId === gestureId && !traces.has(sample.traceId),
      "mixed gesture or duplicate trace",
    );
    traces.add(sample.traceId);
    assertHosted(sample.delivery, "drag", down);
    const proof = sample.dividerEvidence;
    requireProof(
      proof && JSON.stringify(proof.before) === JSON.stringify(previous),
      "geometry chain is incomplete",
    );
    assertDividerGeometry(proof.before, proof.after, sample.semanticPaneId, sample.cells);
    requireProof(
      proof.host?.paneId === down.paneId &&
        proof.host?.sessionId === down.sessionId &&
        proof.host?.cols === 160 &&
        proof.host?.rows === 44,
      "captured host changed",
    );
    const joined = exactResizeFence(proof.records, proof.operationId, sample.semanticPaneId);
    const frame = joined.settled;
    const ingress = frame.pointerIngress;
    requireProof(
      proof.records.every(
        (record) =>
          record.processId === sample.processId && record.clockId === "opentui-performance-now",
      ) &&
        ingress?.action === "drag" &&
        ingress.gestureId === gestureId &&
        ingress.traceId === sample.traceId &&
        ingress.atMicros === sample.pointerIngress.atMicros &&
        Number.isSafeInteger(frame.monotonicMicros) &&
        Number.isSafeInteger(ingress.atMicros) &&
        ingress.atMicros >= 0 &&
        frame.monotonicMicros >= ingress.atMicros,
      "pointer/frame clock or identity is invalid",
    );
    requireProof(
      frame.canonicalAfter?.cols === sample.cells &&
        frame.canonicalAfter?.rows === proof.after[0].rows &&
        frame.requestedCells === sample.cells &&
        joined.receipt.receiptCells === sample.cells,
      "canonical/receipt/native geometry disagrees",
    );
    const durationMs = (frame.monotonicMicros - ingress.atMicros) / 1_000;
    requireProof(
      durationMs === sample.durationMs,
      "reported duration differs from same-clock endpoints",
    );
    durations.push(durationMs);
    previous = proof.after;
  }
  const firstLeft = [...evidence.keyboard.tmux].sort((a, b) => a.left - b.left)[0];
  requireProof(
    down.requestedPoint?.x === 28 + firstLeft.left + firstLeft.cols &&
      down.requestedPoint?.y === samples[0].pointerIngress.y,
    "press did not start on fixture divider",
  );
  const final = exactFinalResizeOperation(raw.records, samples.at(-1), raw.releaseRecord);
  requireProof(
    final.operationId === release.operationId &&
      JSON.stringify(previous) === JSON.stringify(release.tmux),
    "release/final geometry disagrees",
  );
  return {
    gestureId,
    sampleCount: durations.length,
    durationMs: Math.max(...durations),
    durationsMs: durations,
  };
}

export function summarizeDividerGestures(gestures) {
  requireProof(gestures.length >= 3 && gestures.length <= 10, "require 3–10 complete gestures");
  requireProof(
    new Set(gestures.map((entry) => entry.gestureId)).size === gestures.length,
    "independent gestures required",
  );
  requireProof(
    gestures.every((entry) => Number.isFinite(entry.durationMs) && entry.durationMs >= 0),
    "invalid gesture duration",
  );
  const sorted = gestures.map((entry) => entry.durationMs).sort((a, b) => a - b);
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const maximumMs = sorted.at(-1);
  return {
    qualified: p95Ms <= 100 && maximumMs <= 250,
    gestureCount: gestures.length,
    p95Ms,
    maximumMs,
    p95BudgetMs: 100,
    maximumBudgetMs: 250,
    aggregation: "nearest-rank p95 of worst consumed-frame move per independent gesture",
  };
}

export function qualifyDividerReports(reports) {
  requireProof(
    reports.length >= 3 && reports.length <= 10,
    "require 3–10 reports; failures cannot be omitted",
  );
  requireProof(
    new Set(reports.map((report) => report.runId)).size === reports.length,
    "duplicate run identity",
  );
  requireProof(
    reports.every((report) => report.repeat === reports.length) &&
      new Set(reports.map((report) => report.repetition)).size === reports.length &&
      reports.every(
        (report) =>
          Number.isSafeInteger(report.repetition) &&
          report.repetition >= 1 &&
          report.repetition <= reports.length,
      ),
    "incomplete repetition set; failures cannot be omitted",
  );
  const provenance = reports[0]?.sourceProvenance;
  requireProof(
    /^[0-9a-f]{40}$/u.test(provenance?.commit ?? "") &&
      /^[0-9a-f]{40}$/u.test(provenance?.tree ?? "") &&
      /^[0-9a-f]{64}$/u.test(provenance?.manifestDigest ?? ""),
    "missing frozen source provenance",
  );
  const gestures = reports.map((report) => {
    requireProof(
      report.journey === "keyboard-pointer-resize" &&
        report.status === "passed" &&
        report.sourceProvenance?.commit === provenance.commit &&
        report.sourceProvenance?.tree === provenance.tree &&
        report.sourceProvenance?.manifestDigest === provenance.manifestDigest,
      "failed or mixed-source report",
    );
    const evidence = report.keyboardPointerResize;
    const assessment = assessProductKeyboardPointerResize({
      evidence,
      expected: evidence?.expected,
    });
    requireProof(
      assessment.qualified,
      `existing resize proof failed: ${assessment.firstFailedPredicate}`,
    );
    return { runId: report.runId, ...qualifyDividerGesture(evidence) };
  });
  return {
    version: 1,
    status: "partial",
    sourceProvenance: provenance,
    tui: {
      ...summarizeDividerGestures(gestures),
      gestures,
      boundary: "opentui-pointer-ingress-to-consumed-canonical-frame",
      excludes: "device input, compositor/display scanout, optical response",
    },
    browser: {
      qualified: false,
      status: "unmeasured",
      boundary: "pointer input and preview phase share one browser performance-now clock",
      reason: "Existing journey opens Web after TUI resize; no browser pointer-to-preview samples.",
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const paths = process.argv.slice(2);
    const result = qualifyDividerReports(
      paths.map((path) => JSON.parse(readFileSync(path, "utf8"))),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.tui.qualified) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "failed", reason: error.message })}\n`);
    process.exitCode = 1;
  }
}
