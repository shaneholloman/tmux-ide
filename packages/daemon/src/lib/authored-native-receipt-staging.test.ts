import { afterEach, expect, it, vi } from "vitest";
import { InteractionReceiptSchemaZ } from "@tmux-ide/contracts";
import { testStockInteractionEvidence } from "../../test-support/interaction-evidence.ts";
import { nativeInteractionReference } from "./native-interaction-projector.ts";
import type { OwnedNativeInteractionDecision } from "./owned-native-interaction-bindings.ts";
import { InteractionReceiptJournal } from "./interaction-receipt-journal.ts";
import { AuthoredNativeReceiptEnricher } from "./authored-native-receipt-staging.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const evidence = testStockInteractionEvidence(id(5), "workspace", "pane.target");
  evidence.observation = {
    kind: "cooperative-completion",
    operationId: id(5),
    verification: "semantic-readback",
  };
  const receipt = InteractionReceiptSchemaZ.parse({
    type: "interaction.receipt",
    sequence: 1,
    operationId: id(5),
    origin: "cli",
    workspaceName: "workspace",
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId: "pane.target" },
    operationKind: "workspace.pane.send",
    phase: "observed",
    summary: {
      operationKind: "workspace.pane.send",
      characterCount: 3,
      byteCount: 3,
      submitted: true,
    },
    proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.target" },
    at: evidence.receivedAt,
    resourceRevision: null,
    evidence,
  });
  const destination = evidence.endpoints.destination;
  if (destination.kind !== "pane") throw Error();
  const target = {
    kind: "native-pane" as const,
    environmentId: destination.environmentId,
    serverScope: destination.serverScope,
    serverEpoch: id(7),
    paneBirthId: "1",
  };
  const ref = (kind: string, value: string) =>
    nativeInteractionReference([
      target.environmentId,
      target.serverScope.serverId,
      target.serverScope.generation,
      target.serverEpoch,
      kind,
      value,
    ]);
  const decision: OwnedNativeInteractionDecision = {
    disposition: "authored",
    reason: "matched",
    proof: {
      authoredReceiptAdmissionSequence: 1,
      acknowledgement: {
        schemaVersion: 2,
        type: "operation-identity",
        serverEpoch: id(7),
        connectionId: "7",
        wrapperCommandId: "8",
        operationId: id(5),
      },
      target,
      authoredDestination: destination,
      source: null,
    },
    evidence: {
      ...evidence,
      interactionId: id(9),
      revision: 1,
      endpoints: { destination: target, source: null },
      actor: {
        kind: "native",
        issuerId: ref("issuer", "7"),
        identity: "connection",
        sourceBindingId: null,
        classification: { kind: "unknown" },
      },
      observation: {
        kind: "native-journal",
        serverEpoch: id(7),
        command: "paste-buffer",
        cursor: { epoch: id(8), sequence: "1" },
        commandId: ref("command", "9"),
        parentCommandId: ref("command", "8"),
        correlatedOperationId: null,
      },
      effect: { kind: "input-enqueued" },
    },
  };
  return { receipt, decision };
}
function rig(maxPending = 256) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { receipt, decision } = fixture(),
    journal = new InteractionReceiptJournal();
  const accepted = structuredClone(receipt);
  accepted.phase = "accepted";
  accepted.proof = null;
  accepted.evidence!.observation = { kind: "admission", operationId: receipt.operationId };
  journal.publish(accepted);
  const publishRaw = vi.fn(),
    noteGap = vi.fn(),
    onFailure = vi.fn();
  const enricher = new AuthoredNativeReceiptEnricher({
    journal,
    publishRaw,
    noteGap,
    onFailure,
    maxPending,
    retentionMs: 100,
  });
  return { receipt, decision, journal, enricher, publishRaw, noteGap, onFailure };
}
afterEach(() => vi.useRealTimers());
it("stages accepted proof and enriches after the real terminal receipt without inventing a phase", async () => {
  const r = rig();
  expect(r.enricher.consume(r.decision)).toBe(true);
  expect(r.journal.read(0).cursor).toBe(1);
  expect(r.enricher.pendingCount).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  await Promise.resolve();
  expect(r.journal.latestOperationReceipt(r.receipt.operationId)!.phase).toBe("accepted");
  r.journal.publish(r.receipt);
  await Promise.resolve();
  expect(r.journal.read(0).cursor).toBe(3);
  expect(r.journal.latestOperationReceipt(r.receipt.operationId)!.evidence!.effect.kind).toBe(
    "input-enqueued",
  );
  expect(r.enricher.pendingCount).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(r.publishRaw).not.toHaveBeenCalled();
  r.enricher.dispose();
});
it("duplicate callbacks before journal wake do not create duplicate receipts or raw events", async () => {
  const r = rig();
  r.enricher.consume(r.decision);
  r.journal.publish(r.receipt);
  expect(r.enricher.consume(r.decision)).toBe(true);
  await Promise.resolve();
  expect(r.journal.read(0).cursor).toBe(3);
  expect(r.publishRaw).not.toHaveBeenCalled();
  r.enricher.dispose();
});
it("expiry flushes native evidence once and keeps accepted operation unchanged", async () => {
  const r = rig();
  r.enricher.consume(r.decision);
  await vi.advanceTimersByTimeAsync(100);
  expect(r.publishRaw).toHaveBeenCalledExactlyOnceWith(r.decision.evidence);
  expect(r.noteGap).toHaveBeenCalledTimes(1);
  expect(r.enricher.pendingCount).toBe(0);
  expect(r.journal.latestOperationReceipt(r.receipt.operationId)!.phase).toBe("accepted");
  await vi.advanceTimersByTimeAsync(100);
  expect(r.publishRaw).toHaveBeenCalledTimes(1);
  r.enricher.dispose();
});
it("bounds pending proof without swallowing overflow or unmatched input", () => {
  const r = rig(1);
  expect(r.enricher.consume(r.decision)).toBe(true);
  const other = structuredClone(r.decision);
  other.evidence.interactionId = id(99);
  expect(r.enricher.consume(other)).toBe(false);
  expect(r.enricher.pendingCount).toBe(1);
  expect(r.noteGap).toHaveBeenCalledTimes(1);
  other.proof!.acknowledgement.operationId = id(98);
  expect(r.enricher.consume(other)).toBe(false);
  r.enricher.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejected lifecycle stays rejected even when a native partial effect is proven", async () => {
  const r = rig();
  r.enricher.consume(r.decision);
  r.receipt.phase = "rejected";
  r.receipt.proof = null;
  r.journal.publish(r.receipt);
  await Promise.resolve();
  expect(r.journal.latestOperationReceipt(r.receipt.operationId)).toMatchObject({
    phase: "rejected",
    proof: null,
    evidence: { effect: { kind: "input-enqueued" } },
  });
  r.enricher.dispose();
});
it("retirement cancels staging without publishing into a retired owner", async () => {
  const r = rig();
  r.enricher.consume(r.decision);
  r.enricher.dispose();
  r.journal.dispose();
  await vi.advanceTimersByTimeAsync(200);
  expect(r.publishRaw).not.toHaveBeenCalled();
  expect(r.onFailure).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("publisher failure retires staging and explicitly reports coverage failure", async () => {
  const r = rig();
  r.publishRaw.mockImplementation(() => {
    throw Error("journal unavailable");
  });
  r.enricher.consume(r.decision);
  await vi.advanceTimersByTimeAsync(100);
  expect(r.onFailure).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(r.enricher.pendingCount).toBe(0);
});
it("changed terminal lifetime falls back to raw evidence without rewriting receipt", async () => {
  const r = rig();
  r.enricher.consume(r.decision);
  const destination = r.receipt.evidence!.endpoints.destination;
  if (destination.kind !== "pane") throw Error("expected semantic endpoint");
  destination.paneLifetimeId = id(90);
  r.journal.publish(r.receipt);
  await Promise.resolve();
  expect(r.publishRaw).toHaveBeenCalledExactlyOnceWith(r.decision.evidence);
  expect(r.journal.read(0).cursor).toBe(2);
  expect(r.enricher.pendingCount).toBe(0);
  r.enricher.dispose();
});
it("never attaches staged proof to a later admission with the same UUID and context", async () => {
  const r = rig();
  expect(r.enricher.consume(r.decision)).toBe(true);
  r.journal.publish({
    ...r.receipt,
    phase: "accepted",
    proof: null,
    evidence: {
      ...r.receipt.evidence!,
      observation: { kind: "admission", operationId: r.receipt.operationId },
    },
  });
  r.journal.publish(r.receipt);
  await Promise.resolve();
  expect(r.enricher.pendingCount).toBe(0);
  expect(r.publishRaw).toHaveBeenCalledExactlyOnceWith(r.decision.evidence);
  expect(r.journal.read(0).cursor).toBe(3);
  expect(r.enricher.consume(r.decision)).toBe(false);
  r.enricher.dispose();
});
it("flushes staged proof as raw when its admission is evicted", async () => {
  const r = rig();
  r.enricher.consume(r.decision);
  for (let i = 0; i < 256; i++) r.journal.appendEvidence(r.decision.evidence);
  r.journal.publish(r.receipt);
  await Promise.resolve();
  expect(r.publishRaw).toHaveBeenCalledExactlyOnceWith(r.decision.evidence);
  expect(r.enricher.pendingCount).toBe(0);
  r.enricher.dispose();
});
