import { describe, expect, it } from "bun:test";
import type { InteractionReceipt, InteractionEvidence } from "@tmux-ide/contracts";
import { defaultGenerationBoundClock } from "./generation-bound-store.ts";
import { createWorkspaceClientOperationLedger } from "./workspace-client-operations.ts";

describe("shared operation observation", () => {
  it("publishes external receipts without inventing local pending operations and fences replay/generation", () => {
    let changes = 0;
    const ledger = createWorkspaceClientOperationLedger({
      clock: defaultGenerationBoundClock,
      initialGeneration: 1,
      onChange: () => changes++,
    });
    const evidence: InteractionEvidence = {
      schemaVersion: 1,
      interactionId: "10000000-0000-4000-8000-000000000001",
      revision: 0,
      endpoints: {
        destination: {
          kind: "pane",
          environmentId: "10000000-0000-4000-8000-000000000002",
          serverScope: {
            serverId: `tmux-server.${"a".repeat(32)}`,
            generation: "10000000-0000-4000-8000-000000000003",
          },
          paneLifetimeId: "10000000-0000-4000-8000-000000000004",
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
      receivedAt: new Date().toISOString(),
    };
    const receipt: InteractionReceipt = {
      evidence,
      type: "interaction.receipt",
      sequence: 20,
      operationId: "10000000-0000-4000-8000-000000000001",
      origin: "external",
      workspaceName: "alpha",
      sourceSemanticPaneId: null,
      target: { kind: "pane", semanticPaneId: "pane.alpha" },
      operationKind: "workspace.pane.send",
      phase: "observed",
      summary: { operationKind: "workspace.pane.send", observedOnly: true },
      proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.alpha" },
      at: new Date().toISOString(),
      resourceRevision: null,
    };
    ledger.observeReceipt(receipt, 1);
    expect(ledger.receipt(receipt, 1)).toBe(false);
    expect(ledger.getSnapshot()).toMatchObject({
      lastObservedReceipt: receipt,
      lastReceipt: null,
      pending: [],
      terminalOperationIds: [],
    });
    ledger.observeReceipt(receipt, 1);
    ledger.observeReceipt({ ...receipt, sequence: 19 }, 1);
    expect(changes).toBe(1);
    ledger.replaceGeneration(2);
    ledger.observeReceipt({ ...receipt, sequence: 21 }, 1);
    expect(ledger.getSnapshot().lastObservedReceipt).toBeNull();
    ledger.observeReceipt({ ...receipt, sequence: 1 }, 2);
    expect(ledger.getSnapshot().lastObservedReceipt?.sequence).toBe(1);
    ledger.begin({
      operationId: receipt.operationId,
      generation: 2,
      kind: "semantic-intent",
      timeoutMs: 5000,
    });
    expect(ledger.receipt({ ...receipt, origin: "sdk" }, 2)).toBe(false);
    expect(ledger.getSnapshot().pending).toHaveLength(1);
    const completed: InteractionReceipt = {
      ...receipt,
      origin: "sdk",
      evidence: {
        ...evidence,
        observation: {
          kind: "cooperative-completion",
          operationId: receipt.operationId,
          verification: "daemon-input-enqueue",
        },
        effect: { kind: "input-enqueued" },
      },
    };
    expect(ledger.receipt(completed, 2)).toBe(true);
    expect(ledger.getSnapshot().pending).toHaveLength(0);
    ledger.dispose();
  });
});
