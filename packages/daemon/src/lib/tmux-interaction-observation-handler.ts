import type { ExternalTmuxInteraction } from "./tmux-external-interaction-observer.ts";
import { randomUUID } from "node:crypto";
import type { InteractionReceiptDraft } from "./interaction-receipt-journal.ts";

export function externalTmuxInteractionDraft(
  observation: ExternalTmuxInteraction,
): InteractionReceiptDraft {
  const { workspaceName, semanticPaneId, operationKind } = observation;
  return {
    operationId: randomUUID(),
    origin: "external",
    workspaceName,
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId },
    operationKind,
    phase: "observed",
    summary:
      operationKind === "workspace.pane.read"
        ? { operationKind, observedOnly: true }
        : { operationKind, observedOnly: true },
    proof: { operationKind, observed: true, semanticPaneId },
    at: new Date().toISOString(),
    resourceRevision: null,
  };
}

export interface TmuxInteractionObservationPolicy {
  /** The owner must validate the operation in its own generation and scope. */
  readonly consumeAuthored: (observation: ExternalTmuxInteraction) => boolean;
  /** Publication is injected: this policy never selects a global/default feed. */
  readonly publishExternal: (observation: ExternalTmuxInteraction) => void;
  readonly invalidateInventory: () => void;
  readonly reportPublicationFailure: (error: unknown) => void;
}

/** Shared stock-hook policy. A marker alone is never proof of authorship. */
export function createTmuxInteractionObservationHandler(policy: TmuxInteractionObservationPolicy) {
  return (observation: ExternalTmuxInteraction): boolean => {
    if (observation.operationKind !== "workspace.pane.read") policy.invalidateInventory();
    if (observation.operationId !== null && policy.consumeAuthored(observation)) return true;
    try {
      // Do not forward an unmatched claimed operation ID into a passive event.
      policy.publishExternal({ ...observation, operationId: null });
    } catch (error) {
      policy.reportPublicationFailure(error);
    }
    return false;
  };
}
