import type { InteractionObservationStatus, NativePaneIdentity } from "@tmux-ide/contracts";
import type { InteractionJournalEntry, InteractionPaneEndpoint } from "@tmux-ide/contracts";
import {
  interactionActivityAt,
  interactionActivityOperationKind,
  interactionPaneEndpointKey,
  interactionNativePaneEndpointKey,
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
  | "displayDestinationEndpoint"
  | "effect"
  | "at"
> & { direction?: "incoming" | "outgoing" };
export function interactionTargetsPane(
  receipt: InteractionJournalEntry,
  endpoint: PaneInteractionEndpoint | null | undefined,
  nativeIdentity?: NativePaneIdentity | null,
): boolean {
  if (!endpoint) return false;
  return [receipt.evidence?.endpoints.destination, receipt.evidence?.endpoints.source].some(
    (candidate) => {
      if (candidate?.kind === "pane")
        return interactionPaneEndpointKey(candidate) === interactionPaneEndpointKey(endpoint);
      if (candidate?.kind === "native-pane" && nativeIdentity)
        return (
          interactionNativePaneEndpointKey(candidate) ===
          interactionNativePaneEndpointKey({
            kind: "native-pane",
            environmentId: endpoint.environmentId,
            serverScope: endpoint.serverScope,
            ...nativeIdentity,
          })
        );
      return false;
    },
  );
}
export function paneInteractionDisplayDestination(
  event: PaneInteractionEvent,
): PaneInteractionEndpoint | null {
  return (
    event.displayDestinationEndpoint ??
    (event.destinationEndpoint.kind === "pane" ? event.destinationEndpoint : null)
  );
}
export function receiptPaneInteraction(
  receipt: InteractionJournalEntry,
  viewingEndpoint?: PaneInteractionEndpoint | null,
  nativeIdentity?: NativePaneIdentity | null,
): PaneInteractionEvent | null {
  const evidence = receipt.evidence;
  const operationKind = interactionActivityOperationKind(receipt);
  const destination = evidence?.endpoints.destination;
  if (
    !evidence ||
    (destination?.kind !== "pane" && destination?.kind !== "native-pane") ||
    (operationKind !== "workspace.pane.read" && operationKind !== "workspace.pane.send")
  )
    return null;
  if (
    destination.kind === "native-pane" &&
    !interactionTargetsPane(receipt, viewingEndpoint, nativeIdentity)
  )
    return null;
  const destinationMatchesCurrent =
    destination.kind === "native-pane" &&
    viewingEndpoint &&
    nativeIdentity &&
    interactionNativePaneEndpointKey(destination) ===
      interactionNativePaneEndpointKey({
        kind: "native-pane",
        environmentId: viewingEndpoint.environmentId,
        serverScope: viewingEndpoint.serverScope,
        ...nativeIdentity,
      });
  const displayDestinationEndpoint =
    destination.kind === "pane"
      ? destination
      : destinationMatchesCurrent
        ? viewingEndpoint
        : undefined;
  const source = evidence.endpoints.source?.kind === "pane" ? evidence.endpoints.source : null;
  return {
    direction:
      viewingEndpoint &&
      source &&
      interactionPaneEndpointKey(source) === interactionPaneEndpointKey(viewingEndpoint) &&
      (!displayDestinationEndpoint ||
        interactionPaneEndpointKey(source) !==
          interactionPaneEndpointKey(displayDestinationEndpoint))
        ? "outgoing"
        : "incoming",
    operationId:
      receipt.type === "interaction.evidence" ? evidence.interactionId : receipt.operationId,
    operationKind,
    phase: receipt.type === "interaction.evidence" ? "observed" : receipt.phase,
    origin: receipt.type === "interaction.evidence" ? "external" : receipt.origin,
    sourcePaneId: source?.semanticPaneId ?? null,
    destinationPaneId: displayDestinationEndpoint?.semanticPaneId ?? "",
    displayDestinationEndpoint,
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
  const displayDestination = paneInteractionDisplayDestination(event);
  const target = displayDestination ? (name(displayDestination) ?? "Pane") : "Native pane";
  const pending = event.phase === "accepted";
  const failed = event.phase === "rejected" || event.phase === "timed-out";
  // Stock after-command hooks do not prove application input or that a
  // caller consumed captured output. Keep that limit visible on every surface.
  if (event.effect.kind === "unknown" && event.phase === "observed") {
    return {
      label: source
        ? `${read ? "Read" : "Send"} command from ${source}`
        : read
          ? "Read command · reader unknown"
          : "Send command · sender unknown",
      compactLabel: read ? "Read command" : "Send command",
      source: source ?? "Unknown",
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

export interface CurrentPaneInteractionMap<T> extends ReadonlyMap<string, T> {
  readonly forPane?: (
    endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }>,
    nativeIdentity?: NativePaneIdentity | null,
  ) => T | undefined;
}
/** Current metadata is authority; even one matching semantic ID is insufficient. */
export function interactionForCurrentPane<T>(
  interactions: CurrentPaneInteractionMap<T> | undefined,
  endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null | undefined,
  nativeIdentity?: NativePaneIdentity | null,
): T | undefined {
  if (!endpoint) return undefined;
  return interactions?.forPane
    ? interactions.forPane(endpoint, nativeIdentity)
    : interactions?.get(interactionPaneEndpointKey(endpoint));
}

export function nameForCurrentEndpoint(
  rows: readonly {
    name: string;
    interactionEndpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null;
  }[],
  endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }>,
): string | undefined {
  const key = interactionPaneEndpointKey(endpoint);
  const matches = rows.filter(
    (row) => row.interactionEndpoint && interactionPaneEndpointKey(row.interactionEndpoint) === key,
  );
  return matches.length === 1 ? matches[0]!.name : undefined;
}

/** Chrome is reserved for completed, attributed interactions between distinct panes.
 * Unknown commands remain in Activity; hiding them is not sender attribution. */
export function paneInteractionIsHeaderWorthy(event: PaneInteractionEvent): boolean {
  const source = event.sourceEndpoint;
  const target = paneInteractionDisplayDestination(event);
  return (
    event.phase === "observed" &&
    event.effect.kind !== "no-input" &&
    (event.effect.kind !== "unknown" || event.origin !== "external") &&
    event.origin !== "tui" &&
    source !== null &&
    (!target || interactionPaneEndpointKey(source) !== interactionPaneEndpointKey(target))
  );
}
export function receiptIsHeaderWorthy(receipt: InteractionJournalEntry): boolean {
  const source = receipt.evidence?.endpoints.source;
  const target = receipt.evidence?.endpoints.destination;
  return (
    (receipt.type === "interaction.evidence" ||
      (receipt.phase === "observed" && receipt.origin !== "tui")) &&
    (receipt.evidence?.effect.kind !== "unknown" ||
      (receipt.type === "interaction.receipt" && receipt.origin !== "external")) &&
    receipt.evidence?.effect.kind !== "no-input" &&
    source?.kind === "pane" &&
    (target?.kind !== "pane" ||
      interactionPaneEndpointKey(source) !== interactionPaneEndpointKey(target))
  );
}
