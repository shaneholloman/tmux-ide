import type { InteractionObservationStatus } from "@tmux-ide/contracts";
import type { InteractionJournalEntry, InteractionPaneEndpoint } from "@tmux-ide/contracts";
import {
  interactionActivityAt,
  interactionActivityOperationKind,
  interactionPaneEndpointKey,
  type PaneInteractionProjection,
} from "@tmux-ide/core";

export type PaneInteractionEndpoint = Extract<InteractionPaneEndpoint, { kind: "pane" }>;
export type PaneInteractionEvent = Pick<
  PaneInteractionProjection,
  | "operationId"
  | "operationKind"
  | "phase"
  | "origin"
  | "sourcePaneId"
  | "destinationPaneId"
  | "sourceEndpoint"
  | "destinationEndpoint"
  | "effect"
  | "at"
> & { direction?: "incoming" | "outgoing" };
export function receiptPaneInteraction(
  receipt: InteractionJournalEntry,
  viewingEndpoint?: PaneInteractionEndpoint | null,
): PaneInteractionEvent | null {
  const evidence = receipt.evidence;
  const operationKind = interactionActivityOperationKind(receipt);
  const destination = evidence?.endpoints.destination;
  if (
    !evidence ||
    destination?.kind !== "pane" ||
    (operationKind !== "workspace.pane.read" && operationKind !== "workspace.pane.send")
  )
    return null;
  const source = evidence.endpoints.source?.kind === "pane" ? evidence.endpoints.source : null;
  return {
    direction:
      viewingEndpoint &&
      source &&
      interactionPaneEndpointKey(source) === interactionPaneEndpointKey(viewingEndpoint) &&
      interactionPaneEndpointKey(source) !== interactionPaneEndpointKey(destination)
        ? "outgoing"
        : "incoming",
    operationId:
      receipt.type === "interaction.evidence" ? evidence.interactionId : receipt.operationId,
    operationKind,
    phase: receipt.type === "interaction.evidence" ? "observed" : receipt.phase,
    origin: receipt.type === "interaction.evidence" ? "external" : receipt.origin,
    sourcePaneId: source?.semanticPaneId ?? null,
    destinationPaneId: destination.semanticPaneId,
    sourceEndpoint: source,
    destinationEndpoint: destination,
    effect: evidence.effect,
    at: interactionActivityAt(receipt),
  };
}
export function paneInteractionPresentation(
  event: PaneInteractionEvent,
  name: (endpoint: PaneInteractionEndpoint) => string | undefined = () => undefined,
) {
  const read = event.operationKind === "workspace.pane.read";
  // An accepted request is not an authenticated actor or proof of delivery.
  const source =
    event.phase === "observed" && event.sourceEndpoint ? name(event.sourceEndpoint) : undefined;
  const target = name(event.destinationEndpoint) ?? "Pane";
  const pending = event.phase === "accepted";
  const failed = event.phase === "rejected" || event.phase === "timed-out";
  // Stock after-command hooks do not prove application input or that a
  // caller consumed captured output. Keep that limit visible on every surface.
  if (event.effect.kind === "unknown" && event.phase === "observed") {
    return {
      label: read ? "Read command · reader unknown" : "Send command · sender unknown",
      compactLabel: read ? "Read command" : "Send command",
      source: "Unknown",
      target,
      pending,
      failed,
      commandOnly: true,
      explanation: read
        ? "tmux ran a pane capture command. This does not prove that an agent received or read the output."
        : "tmux ran a send-keys command. It may affect copy mode or send no input; application delivery is not confirmed.",
      phase: "Command observed",
    };
  }
  const label = failed
    ? `${read ? "Read" : "Send"} ${event.phase === "timed-out" ? "timed out" : "failed"}`
    : pending
      ? read
        ? "Read requested"
        : "Input pending"
      : event.direction === "outgoing"
        ? read
          ? `Read ${target}`
          : `Input sent to ${target}`
        : read
          ? source
            ? `Read by ${source}`
            : "Pane read · reader unknown"
          : source
            ? `Input from ${source}`
            : "Input observed · sender unknown";
  return {
    label,
    compactLabel:
      !pending && !failed && !source && event.direction !== "outgoing"
        ? read
          ? "Pane read"
          : "Input observed"
        : label,
    source: source ?? (pending ? "Not yet verified" : "Unknown"),
    target,
    pending,
    failed,
    commandOnly: false,
    explanation: failed
      ? "The operation did not complete successfully."
      : pending
        ? "Request accepted. Completion and source attribution are not yet confirmed."
        : read
          ? "Pane output was read. This does not prove comprehension or change your focus."
          : "Input delivery was observed. This does not mean the application processed it.",
    phase: pending
      ? "Requested"
      : failed
        ? event.phase === "timed-out"
          ? "Timed out"
          : "Failed"
        : read
          ? "Read completed"
          : "Input delivered",
  };
}

/** Latest owner coverage is distinct from the evidence of this particular event. */
export function interactionCoveragePresentation(
  status: InteractionObservationStatus | null | undefined,
): { label: string; detail: string; gap: string | null } {
  const gap = status?.lastGap
    ? `Some activity may be missing${status.droppedCount === null ? "" : ` · ${status.droppedCount} known dropped`}.`
    : null;
  if (!status || status.method === "unavailable")
    return {
      label: "Observation unavailable",
      detail:
        "Live observation is not available for this server. Earlier activity may still be shown.",
      gap,
    };
  if (status.method === "stock-hooks")
    return {
      label: "Partial · tmux hooks",
      detail:
        "Observes send and capture commands. Delivery and the caller’s identity are not confirmed.",
      gap,
    };
  return {
    label: "Native tmux observation",
    detail: status.effects.length
      ? "Observes declared commands and effects. An observed effect does not identify its caller or prove the application processed input."
      : "Observes declared commands. Caller identity and application processing need separate evidence.",
    gap,
  };
}
