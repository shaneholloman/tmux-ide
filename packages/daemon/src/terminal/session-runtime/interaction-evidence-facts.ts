import {
  InteractionEvidenceSchemaZ,
  type InteractionEvidence,
  type InteractionPaneEndpoint,
  type SessionRuntimeSemanticIntent,
} from "@tmux-ide/contracts";
import type {
  SessionRuntimeIntentResult,
  SessionRuntimeInteractionContext,
} from "./semantic-mutation-executor.ts";

export interface CapturedInteractionContext {
  readonly destination: InteractionPaneEndpoint;
  readonly source: SessionRuntimeInteractionContext["source"];
}

/** Describe only the evidence actually supplied by the executing primitive. */
export function authoredInteractionEvidence(
  operationId: string,
  intent: SessionRuntimeSemanticIntent,
  phase: "accepted" | "observed" | "rejected" | "timed-out",
  context: CapturedInteractionContext,
  receivedAt: string,
  result?: SessionRuntimeIntentResult,
): InteractionEvidence {
  const snapshot =
    phase === "observed" &&
    intent.verb === "workspace.pane.read" &&
    result?.verb === "workspace.pane.read" &&
    result.availability === "available";
  return InteractionEvidenceSchemaZ.parse({
    schemaVersion: 1,
    interactionId: operationId,
    revision: phase === "accepted" ? 0 : 1,
    endpoints: { destination: context.destination, source: context.source?.endpoint ?? null },
    actor: context.source
      ? { kind: "cooperative", bindingId: context.source.bindingId, agentRunId: null }
      : { kind: "unknown", reason: "unbound-source" },
    observation:
      phase === "observed"
        ? {
            kind: "cooperative-completion",
            operationId,
            verification: snapshot ? "daemon-snapshot" : "semantic-readback",
          }
        : { kind: "admission", operationId },
    effect: snapshot ? { kind: "snapshot-produced" } : { kind: "unknown" },
    // Stock completion timing is not the time of native input delivery.
    occurredAt: null,
    timeBasis: "unknown",
    receivedAt,
  });
}
