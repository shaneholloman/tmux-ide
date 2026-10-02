import { InteractionEvidenceSchemaZ } from "@tmux-ide/contracts";
import type { SessionRuntimeSemanticIntent, InteractionPaneEndpoint } from "@tmux-ide/contracts";
export const TEST_INTERACTION_SCOPE = {
  environmentId: "00000000-0000-4000-8000-000000000001",
  serverScope: {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "00000000-0000-4000-8000-000000000002",
  },
} as const;
/** Explicit test-owned inventory binding; tests override when exercising lifetime changes. */
export function testInteractionContext(intent: SessionRuntimeSemanticIntent) {
  return {
    destination: {
      kind: "pane" as const,
      ...TEST_INTERACTION_SCOPE,
      paneLifetimeId: "00000000-0000-4000-8000-000000000003",
      workspaceName: intent.workspaceName,
      semanticPaneId: "semanticPaneId" in intent ? intent.semanticPaneId : "pane.fixture",
    } satisfies InteractionPaneEndpoint,
    source: null,
  };
}

export function testStockInteractionEvidence(
  operationId: string,
  workspaceName: string,
  semanticPaneId: string,
) {
  return InteractionEvidenceSchemaZ.parse({
    schemaVersion: 1,
    interactionId: operationId,
    revision: 0,
    endpoints: {
      destination: testInteractionContext({
        verb: "workspace.pane.read",
        workspaceName,
        semanticPaneId,
        origin: "sdk",
      }).destination,
      source: null,
    },
    actor: { kind: "unknown", reason: "stock-hook" },
    observation: { kind: "stock-hook", command: "send-keys" },
    effect: { kind: "unknown" },
    occurredAt: null,
    timeBasis: "unknown",
    receivedAt: "2026-09-28T00:00:00.000Z",
  });
}
