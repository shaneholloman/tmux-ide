import type { InteractionReceipt } from "@tmux-ide/contracts";
import type { PaneInteractionProjection } from "@tmux-ide/core";

export type PaneInteractionEvent = Pick<
  PaneInteractionProjection,
  "operationId" | "operationKind" | "phase" | "origin" | "sourcePaneId" | "destinationPaneId" | "at"
> & { direction?: "incoming" | "outgoing" };
export function receiptPaneInteraction(
  receipt: InteractionReceipt,
  viewingPaneId?: string | null,
): PaneInteractionEvent | null {
  if (
    receipt.target.kind !== "pane" ||
    !["workspace.pane.read", "workspace.pane.send"].includes(receipt.operationKind)
  )
    return null;
  return {
    direction:
      viewingPaneId &&
      receipt.sourceSemanticPaneId === viewingPaneId &&
      receipt.target.semanticPaneId !== viewingPaneId
        ? "outgoing"
        : "incoming",
    operationId: receipt.operationId,
    operationKind: receipt.operationKind,
    phase: receipt.phase,
    origin: receipt.origin,
    sourcePaneId: receipt.sourceSemanticPaneId,
    destinationPaneId: receipt.target.semanticPaneId,
    at: receipt.at,
  };
}
export function paneInteractionPresentation(
  event: PaneInteractionEvent,
  name: (id: string) => string | undefined = () => undefined,
) {
  const read = event.operationKind === "workspace.pane.read";
  // An accepted request is not an authenticated actor or proof of delivery.
  const source =
    event.phase === "observed" && event.sourcePaneId ? name(event.sourcePaneId) : undefined;
  const target = name(event.destinationPaneId) ?? "Pane";
  const pending = event.phase === "accepted";
  const failed = event.phase === "rejected" || event.phase === "timed-out";
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
