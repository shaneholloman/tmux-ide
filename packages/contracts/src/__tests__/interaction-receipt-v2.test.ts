import { describe, expect, it } from "vitest";
import {
  InteractionReceiptV1SchemaZ,
  InteractionReceiptV2SchemaZ,
} from "../interaction-receipts.ts";
const id = "00000000-0000-4000-8000-000000000001";
const time = "2026-09-28T10:00:00.000Z";
const receipt = {
  type: "interaction.receipt",
  sequence: 1,
  operationId: id,
  origin: "external",
  workspaceName: "alpha",
  sourceSemanticPaneId: null,
  target: { kind: "pane", semanticPaneId: "pane.alpha" },
  operationKind: "workspace.pane.send",
  phase: "observed",
  summary: { operationKind: "workspace.pane.send", observedOnly: true },
  proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.alpha" },
  at: time,
  resourceRevision: null,
};
const evidence = {
  schemaVersion: 1,
  interactionId: id,
  revision: 0,
  endpoints: {
    destination: {
      kind: "pane",
      environmentId: id,
      serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
      paneLifetimeId: id,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
    },
    source: null,
  },
  actor: { kind: "unknown", reason: "stock-hook" },
  observation: { kind: "stock-hook", command: "send-keys" },
  effect: { kind: "unknown" },
  occurredAt: null,
  timeBasis: "unknown",
  receivedAt: time,
};
describe("versioned receipt scoped evidence", () => {
  it("requires pane evidence while preserving an explicit strict legacy contract", () => {
    expect(InteractionReceiptV1SchemaZ.safeParse(receipt).success).toBe(true);
    expect(InteractionReceiptV1SchemaZ.safeParse({ ...receipt, evidence }).success).toBe(false);
    expect(InteractionReceiptV2SchemaZ.safeParse(receipt).success).toBe(false);
    expect(InteractionReceiptV2SchemaZ.safeParse({ ...receipt, evidence: null }).success).toBe(
      false,
    );
    expect(InteractionReceiptV2SchemaZ.safeParse({ ...receipt, evidence }).success).toBe(true);
  });
  it("rejects mismatched target, operation correlation and command; stock cannot assert effects", () => {
    for (const changed of [
      { ...evidence, interactionId: "00000000-0000-4000-8000-000000000002" },
      {
        ...evidence,
        endpoints: {
          ...evidence.endpoints,
          destination: { ...evidence.endpoints.destination, workspaceName: "other" },
        },
      },
      { ...evidence, observation: { kind: "stock-hook", command: "capture-pane" } },
      { ...evidence, effect: { kind: "input-enqueued" } },
    ])
      expect(InteractionReceiptV2SchemaZ.safeParse({ ...receipt, evidence: changed }).success).toBe(
        false,
      );
  });
});
