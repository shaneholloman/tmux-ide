import { expect, it } from "vitest";
import { InteractionReceiptSchemaZ } from "@tmux-ide/contracts";
import { testStockInteractionEvidence } from "../../test-support/interaction-evidence.ts";
import { nativeInteractionReference } from "./native-interaction-projector.ts";
import type { OwnedNativeInteractionDecision } from "./owned-native-interaction-bindings.ts";
import {
  enrichAuthoredNativeReceipt,
  consumeAuthoredNativeEvidence,
} from "./authored-native-receipt-enrichment.ts";
import { InteractionReceiptJournal } from "./interaction-receipt-journal.ts";
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
it("enriches only evidence while preserving all operation lifecycle fields", () => {
  const { receipt, decision } = fixture();
  const draft = enrichAuthoredNativeReceipt(receipt, decision)!;
  expect(draft).not.toBeNull();
  const { type, sequence, evidence, ...rest } = receipt;
  expect(draft).toEqual({ ...rest, evidence: draft.evidence });
  expect(draft.evidence).toMatchObject({
    interactionId: receipt.operationId,
    revision: 1,
    effect: { kind: "input-enqueued" },
    observation: { correlatedOperationId: receipt.operationId, command: "paste-buffer" },
    endpoints: { destination: receipt.evidence!.endpoints.destination },
  });
  expect(decision.evidence.interactionId).toBe(id(9));
  expect(type).toBe("interaction.receipt");
  expect(sequence).toBe(1);
  expect(evidence!.effect.kind).toBe("unknown");
});
it.each(["rejected", "timed-out"] as const)(
  "partial input cannot change %s into observed",
  (phase) => {
    const { receipt, decision } = fixture();
    receipt.phase = phase;
    receipt.proof = null;
    expect(enrichAuthoredNativeReceipt(receipt, decision)).toMatchObject({
      phase,
      proof: null,
      evidence: { effect: { kind: "input-enqueued" } },
    });
  },
);
it("leaves accepted-only native evidence unconsumed pending a real lifecycle receipt", () => {
  const { receipt, decision } = fixture();
  receipt.phase = "accepted";
  receipt.proof = null;
  receipt.evidence!.observation = { kind: "admission", operationId: receipt.operationId };
  expect(enrichAuthoredNativeReceipt(receipt, decision)).toBeNull();
});
it.each(["owner", "lifetime", "source", "issuer", "parent", "operation", "unknown"])(
  "rejects mismatching proof %s",
  (field) => {
    const { receipt, decision } = fixture();
    if (field === "owner") decision.proof!.target.serverScope.generation = id(30);
    if (field === "lifetime")
      receipt.evidence!.endpoints.destination = {
        ...decision.proof!.authoredDestination!,
        paneLifetimeId: id(30),
      };
    if (field === "source")
      receipt.evidence!.endpoints.source = decision.proof!.authoredDestination!;
    if (field === "issuer" && decision.evidence.actor.kind === "native")
      decision.evidence.actor.issuerId = id(30);
    if (field === "parent" && decision.evidence.observation.kind === "native-journal")
      decision.evidence.observation.parentCommandId = id(30);
    if (field === "operation") decision.proof!.acknowledgement.operationId = id(30);
    const changed =
      field === "unknown" ? { ...decision, disposition: "unknown" as const } : decision;
    expect(enrichAuthoredNativeReceipt(receipt, changed)).toBeNull();
  },
);
it("same journal enrichment is bounded and repeated evidence adds no receipt", () => {
  const { receipt, decision } = fixture();
  const journal = new InteractionReceiptJournal(3);
  journal.publish({
    ...receipt,
    phase: "accepted",
    proof: null,
    evidence: {
      ...receipt.evidence!,
      observation: { kind: "admission", operationId: receipt.operationId },
    },
  });
  journal.publish(receipt);
  expect(consumeAuthoredNativeEvidence(journal, decision)).toBe(true);
  expect(consumeAuthoredNativeEvidence(journal, decision)).toBe(false);
  expect(journal.read(0).cursor).toBe(3);
  const latest = journal.latestOperationReceipt(receipt.operationId)!;
  latest.phase = "rejected";
  expect(journal.latestOperationReceipt(receipt.operationId)!.phase).toBe("observed");
  journal.appendEvidence(decision.evidence);
  journal.appendEvidence(decision.evidence);
  journal.appendEvidence(decision.evidence);
  expect(journal.latestOperationReceipt(receipt.operationId)).toBeNull();
  expect(consumeAuthoredNativeEvidence(journal, decision)).toBe(false);
});
it("preserves validated cooperative source and refuses a different binding", () => {
  const { receipt, decision } = fixture();
  const source = {
    endpoint: decision.proof!.authoredDestination!,
    bindingId: id(31),
    agentRunId: id(32),
  };
  receipt.evidence!.endpoints.source = source.endpoint;
  receipt.evidence!.actor = {
    kind: "cooperative",
    bindingId: source.bindingId,
    agentRunId: source.agentRunId,
  };
  const authored = {
    ...decision,
    proof: { ...decision.proof!, source },
    evidence: {
      ...decision.evidence,
      endpoints: { ...decision.evidence.endpoints, source: source.endpoint },
      actor: {
        ...decision.evidence.actor,
        kind: "native" as const,
        identity: "connection" as const,
        issuerId:
          decision.evidence.actor.kind === "native" ? decision.evidence.actor.issuerId : id(99),
        sourceBindingId: source.bindingId,
        classification: {
          kind: "agent" as const,
          bindingId: source.bindingId,
          agentRunId: source.agentRunId,
        },
      },
    },
  };
  expect(enrichAuthoredNativeReceipt(receipt, authored)).not.toBeNull();
  receipt.evidence!.actor = {
    kind: "cooperative",
    bindingId: id(33),
    agentRunId: source.agentRunId,
  };
  expect(enrichAuthoredNativeReceipt(receipt, authored)).toBeNull();
});
it("requires a retained exact admission and rejects newer UUID reuse", () => {
  const { receipt, decision } = fixture();
  const journal = new InteractionReceiptJournal(4);
  const accepted = journal.publish({
    ...receipt,
    phase: "accepted",
    proof: null,
    evidence: {
      ...receipt.evidence!,
      observation: { kind: "admission", operationId: receipt.operationId },
    },
  });
  journal.publish(receipt);
  expect(
    journal.latestOperationReceiptForAttempt(receipt.operationId, accepted.sequence)?.phase,
  ).toBe("observed");
  expect(journal.latestOperationReceiptForAttempt(receipt.operationId, null)).toBeNull();
  const newer = journal.publish({
    ...receipt,
    phase: "accepted",
    proof: null,
    evidence: {
      ...receipt.evidence!,
      observation: { kind: "admission", operationId: receipt.operationId },
    },
  });
  journal.publish(receipt);
  expect(consumeAuthoredNativeEvidence(journal, decision)).toBe(false);
  const fresh = {
    ...decision,
    proof: { ...decision.proof!, authoredReceiptAdmissionSequence: newer.sequence },
  };
  expect(consumeAuthoredNativeEvidence(journal, fresh)).toBe(true);
  journal.appendEvidence(decision.evidence);
  journal.appendEvidence(decision.evidence);
  expect(journal.latestOperationReceiptForAttempt(receipt.operationId, newer.sequence)).toBeNull();
  expect(consumeAuthoredNativeEvidence(journal, fresh)).toBe(false);
});
