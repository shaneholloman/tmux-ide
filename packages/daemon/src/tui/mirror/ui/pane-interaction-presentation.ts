import type { InteractionReceipt, InteractionPaneEndpoint } from "@tmux-ide/contracts";
import { interactionPaneEndpointKey, type PaneInteractionProjection } from "@tmux-ide/core";

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
  receipt: InteractionReceipt,
  viewingEndpoint?: PaneInteractionEndpoint | null,
): PaneInteractionEvent | null {
  const evidence = receipt.evidence;
  const destination = evidence?.endpoints.destination;
  if (
    !evidence ||
    destination?.kind !== "pane" ||
    !["workspace.pane.read", "workspace.pane.send"].includes(receipt.operationKind)
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
    operationId: receipt.operationId,
    operationKind: receipt.operationKind,
    phase: receipt.phase,
    origin: receipt.origin,
    sourcePaneId: source?.semanticPaneId ?? null,
    destinationPaneId: destination.semanticPaneId,
    sourceEndpoint: source,
    destinationEndpoint: destination,
    effect: evidence.effect,
    at: receipt.at,
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
